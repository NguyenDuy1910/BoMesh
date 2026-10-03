from __future__ import annotations

import asyncio
import sys
import time
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from bothesis.agent.citation_stream import CitationProjection
from bothesis.agent.models import AgentContext, CitationReferences
from bothesis.agent.protocol import (
    ResponseOutputTextAnnotationAddedEvent,
    ResponseOutputTextDeltaEvent,
    ResponseOutputTextDoneEvent,
)
from bothesis.agent.protocol import FunctionTool
from bothesis.agent.tools import ToolInvocation, ToolPayload, ToolRegistry
from bothesis.agent.tools.knowledge_search import KnowledgeSearch
from bothesis.connector.protocol import (
    CitationInfo,
    CitationSpan,
    EffectiveAccess,
    Hierarchy,
    SourceIdentity,
    SourceProvider,
)
from bothesis.document_index import ChunkContext, ContextualChunk, ItemIndex
from bothesis.knowledge import (
    CitationResolver,
    Evidence,
    EvidenceContextBuilder,
    ItemKnowledgeRetriever,
    KnowledgeRetriever,
    SemanticReranker,
    source_reference,
)

CONTEXT = AgentContext(
    user_id="user-1",
    tenant_id="tenant-1",
    roles=[],
    collection_item_ids=("collection-1",),
)


def invocation(
    arguments: dict[str, object],
    *,
    context: AgentContext = CONTEXT,
    references: CitationReferences | None = None,
) -> ToolInvocation:
    return ToolInvocation(
        session=SimpleNamespace(),
        turn=SimpleNamespace(
            environment=SimpleNamespace(agent_context=context),
            references=references or CitationReferences(),
        ),
        step_context=SimpleNamespace(),
        call_id="test-call",
        tool_name="knowledge_search",
        source="model",  # type: ignore[arg-type]
        payload=ToolPayload(arguments=arguments),
    )


def _chunk(
    *,
    chunk_id: str = "chunk-1",
    integration_connection_id: str = "connection-1",
    collection_item_id: str = "collection-1",
    score: float = 0.91,
) -> ContextualChunk:
    return ContextualChunk(
        id=chunk_id,
        item_id="doc-1",
        chunk_index=0,
        content_type="text",
        chunk_text="Employees receive 20 days of annual leave.",
        contextual_text=(
            "Document: Leave policy\nSection: Annual leave\n\n"
            "Employees receive 20 days of annual leave."
        ),
        context=ChunkContext(section_path=["Annual leave"]),
        title="Leave policy",
        document_type="plain_text",
        collection_item_id=collection_item_id,
        source=SourceIdentity(
            connector_id=integration_connection_id,
            provider=SourceProvider.CONFLUENCE,
            external_id="doc-1",
            url="https://knowledge.example/leave-policy",
        ),
        hierarchy=Hierarchy(),
        access=EffectiveAccess(),
        citation=CitationInfo(
            section="Annual leave",
            section_path=("Annual leave",),
            spans=(
                CitationSpan(
                    element_id="paragraph_001",
                    start_offset=0,
                    end_offset=len("Employees receive 20 days of annual leave."),
                ),
            ),
        ),
        relevance_score=score,
    )


DOCUMENT = _chunk()


def _evidence(chunk: ContextualChunk) -> Evidence:
    return Evidence(
        id=source_reference(chunk.item_id, chunk.id),
        item_id=chunk.item_id,
        chunk_id=chunk.id,
        collection_item_id=chunk.collection_item_id,
        title=chunk.title or chunk.item_id,
        content=chunk.chunk_text,
        source=chunk.source,
        citation=chunk.citation,
        section_path=tuple(chunk.context.section_path),
        contextual_text=chunk.contextual_text,
        relevance_score=chunk.relevance_score,
        rerank_score=chunk.rerank_score,
    )


EVIDENCE = _evidence(DOCUMENT)


def test_citation_resolver_builds_internal_and_native_targets() -> None:
    citation = CitationInfo(anchor="replication")
    source = DOCUMENT.source

    assert CitationResolver.internal_path("item:kafka", "item:kafka:12") == (
        "/knowledge/documents/item%3Akafka?chunk=item%3Akafka%3A12"
    )
    assert CitationResolver.original_url(source, citation) == (
        "https://knowledge.example/leave-policy#replication"
    )


def test_evidence_contract_preserves_original_chunk_text_and_citation() -> None:
    evidence = _evidence(DOCUMENT)

    assert evidence.content == DOCUMENT.chunk_text
    assert evidence.content != DOCUMENT.contextual_text
    assert evidence.citation is DOCUMENT.citation
    assert evidence.chunk_id == DOCUMENT.id


class StubRetriever(KnowledgeRetriever):
    def __init__(self, evidence: list[Evidence]) -> None:
        self.evidence = evidence
        self.calls: list[tuple[list[str], int]] = []
        self.contexts: list[AgentContext] = []

    async def search(
        self,
        queries: Sequence[str],
        *,
        limit: int,
        ctx: AgentContext,
    ) -> list[Evidence]:
        self.calls.append((list(queries), limit))
        self.contexts.append(ctx)
        return self.evidence


class FailingRetriever(KnowledgeRetriever):
    async def search(
        self,
        queries: Sequence[str],
        *,
        limit: int,
        ctx: AgentContext,
    ) -> list[Evidence]:
        raise RuntimeError("Qdrant unavailable")


class BlockingRetriever(KnowledgeRetriever):
    async def search(
        self,
        queries: Sequence[str],
        *,
        limit: int,
        ctx: AgentContext,
    ) -> list[Evidence]:
        await asyncio.Event().wait()
        return []


class StubDocumentIndex:
    def __init__(
        self,
        documents: list[ContextualChunk],
        *,
        events: list[str] | None = None,
    ) -> None:
        self.documents = documents
        self.events = events
        self.calls: list[dict[str, object]] = []

    async def search_item_content(
        self,
        queries: Sequence[str],
        *,
        limit: int,
        tenant_id: str,
        collection_item_ids: tuple[str, ...],
    ) -> list[ContextualChunk]:
        if self.events is not None:
            self.events.append("index")
        self.calls.append(
            {
                "queries": list(queries),
                "limit": limit,
                "tenant_id": tenant_id,
                "collection_item_ids": collection_item_ids,
            }
        )
        return self.documents


class RecordingReranker:
    def __init__(self, events: list[str]) -> None:
        self.events = events
        self.calls: list[list[ContextualChunk]] = []
        self.queries: list[list[str]] = []

    def rerank(
        self,
        chunks: Sequence[ContextualChunk],
        *,
        queries: Sequence[str],
        limit: int,
    ) -> list[ContextualChunk]:
        self.events.append("rerank")
        self.calls.append(list(chunks))
        self.queries.append(list(queries))
        return sorted(
            chunks,
            key=lambda chunk: chunk.relevance_score or float("-inf"),
            reverse=True,
        )[:limit]


class NothingRelevantReranker:
    async def rerank(
        self,
        chunks: Sequence[ContextualChunk],
        *,
        queries: Sequence[str],
        limit: int,
    ) -> list[ContextualChunk]:
        return []


class StubEmbedder:
    def __init__(self) -> None:
        self.queries: list[str] = []

    async def embed_query(self, query: str) -> list[float]:
        self.queries.append(query)
        return [0.1, 0.2]


class StubIndexBackend:
    def __init__(self) -> None:
        self.calls: list[tuple[list[tuple[str, list[float]]], object, int, int]] = []

    async def search_item_points(
        self,
        *,
        queries: Sequence[tuple[str, list[float]]],
        tenant_id: str,
        collection_item_ids: tuple[str, ...],
        limit: int,
        candidate_limit: int,
    ) -> list[object]:
        self.calls.append(
            (
                list(queries),
                (tenant_id, collection_item_ids),
                limit,
                candidate_limit,
            )
        )
        return [
            SimpleNamespace(
                id="chunk-1",
                score=0.91,
                payload={
                    "item_id": "doc-1",
                    "chunk_id": "chunk-1",
                    "chunk_index": 0,
                    "title": "Leave policy",
                    "document_type": "plain_text",
                    "collection_item_id": "collection-1",
                    "content_type": "text",
                    "chunk_text": " Employees receive 20 days of annual leave.\n",
                    "contextual_text": (
                        "Document: Leave policy\nSection: Annual leave\n\n "
                        "Employees receive 20 days of annual leave.\n"
                    ),
                    "connector_key": "confluence",
                    "external_id": "doc-1",
                    "source_url": "https://knowledge.example/leave-policy",
                    "section_path": ["Annual leave"],
                    "page_start": 2,
                    "page_end": 3,
                },
            )
        ]


@pytest.mark.asyncio
async def test_item_index_search_embeds_and_rebuilds_contextual_chunks() -> None:
    backend = StubIndexBackend()
    embedder = StubEmbedder()
    index = ItemIndex(backend=backend, embedder=embedder)  # type: ignore[arg-type]

    results = await index.search_item_content(
        [" annual leave ", "carry over"],
        limit=3,
        tenant_id="tenant-1",
        collection_item_ids=("collection-1",),
    )

    assert embedder.queries == ["annual leave", "carry over"]
    # Every query reaches the index in one search, each with its own vector.
    assert backend.calls == [
        (
            [("annual leave", [0.1, 0.2]), ("carry over", [0.1, 0.2])],
            ("tenant-1", ("collection-1",)),
            3,
            20,
        )
    ]
    assert len(results) == 1
    document = results[0]
    assert document.id == "chunk-1"
    assert document.item_id == "doc-1"
    assert document.title == "Leave policy"
    assert document.source.provider.value == "confluence"
    assert document.source.url == "https://knowledge.example/leave-policy"
    assert document.relevance_score == 0.91
    assert document.citation.section == "Annual leave"
    assert document.citation.section_path == ("Annual leave",)
    assert document.citation.page_start == 2
    assert document.citation.page_end == 3
    assert document.citation.spans == ()
    assert document.chunk_text == " Employees receive 20 days of annual leave.\n"
    assert document.contextual_text.endswith(" annual leave.\n")


@pytest.mark.asyncio
async def test_collection_scoped_retrieval_filters_before_reranking() -> None:
    events: list[str] = []
    visible = _chunk(chunk_id="visible", collection_item_id="collection-7", score=0.5)
    wrong_collection = _chunk(
        chunk_id="wrong-collection",
        collection_item_id="collection-8",
        score=0.99,
    )
    index = StubDocumentIndex(
        [wrong_collection, visible],
        events=events,
    )
    reranker = RecordingReranker(events)
    retriever = ItemKnowledgeRetriever(
        index,
        reranker=reranker,
    )
    context = AgentContext(
        user_id="person@example.test",
        tenant_id="tenant-1",
        roles=["analyst"],
        collection_item_ids=("collection-7",),
    )

    results = await retriever.search([" annual leave "], limit=3, ctx=context)

    assert index.calls == [
        {
            "queries": ["annual leave"],
            "limit": 20,
            "tenant_id": "tenant-1",
            "collection_item_ids": ("collection-7",),
        }
    ]
    assert events == ["index", "rerank"]
    assert reranker.calls == [[visible]]
    assert results == [_evidence(visible)]
    assert isinstance(results[0], Evidence)


@pytest.mark.asyncio
async def test_retrieval_ranks_every_query_together_in_one_rerank() -> None:
    """One tool call is one information need: one search, one ranking."""

    events: list[str] = []
    index = StubDocumentIndex([DOCUMENT], events=events)
    reranker = RecordingReranker(events)
    retriever = ItemKnowledgeRetriever(index, reranker=reranker)

    await retriever.search(
        ["annual leave", "carry over", "Annual  leave"], limit=3, ctx=CONTEXT
    )

    assert events == ["index", "rerank"]
    assert index.calls[0]["queries"] == ["annual leave", "carry over", "Annual leave"]
    assert reranker.queries == [["annual leave", "carry over", "Annual leave"]]


@pytest.mark.asyncio
async def test_retrieval_returns_nothing_when_the_reranker_finds_nothing_relevant() -> None:
    """The reranker's empty judgment must not fall back to irrelevant chunks."""

    retriever = ItemKnowledgeRetriever(
        StubDocumentIndex([DOCUMENT]),
        reranker=NothingRelevantReranker(),  # type: ignore[arg-type]
    )

    assert await retriever.search(["xin chào"], limit=3, ctx=CONTEXT) == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("queries", "limit"),
    [(["   "], 3), ([], 3), (["annual leave"], 0), ("annual leave", 3)],
)
async def test_document_index_retriever_validates_before_search_or_reranking(
    queries: object,
    limit: int,
) -> None:
    events: list[str] = []
    index = StubDocumentIndex([DOCUMENT], events=events)
    retriever = ItemKnowledgeRetriever(index, reranker=RecordingReranker(events))
    context = AgentContext(
        user_id="user-1",
        tenant_id="tenant-1",
        roles=[],
        collection_item_ids=(),
    )

    with pytest.raises((ValueError, TypeError)):
        await retriever.search(queries, limit=limit, ctx=context)  # type: ignore[arg-type]

    assert index.calls == []
    assert events == []


@pytest.mark.asyncio
async def test_document_index_retriever_requires_a_tenant_even_for_empty_scope() -> (
    None
):
    index = StubDocumentIndex([DOCUMENT])
    retriever = ItemKnowledgeRetriever(index)
    context = AgentContext(
        user_id="user-1",
        tenant_id="   ",
        roles=[],
        collection_item_ids=("collection-1",),
    )

    with pytest.raises(ValueError, match="tenant_id must not be empty"):
        await retriever.search(["annual leave"], limit=3, ctx=context)

    assert index.calls == []


@pytest.mark.asyncio
async def test_collection_retrieval_remains_tenant_scoped() -> None:
    index = StubDocumentIndex([DOCUMENT])
    retriever = ItemKnowledgeRetriever(index)
    context = AgentContext(
        user_id="admin-1",
        tenant_id="tenant-1",
        roles=["developer"],
        collection_item_ids=("collection-1",),
    )

    results = await retriever.search(["annual leave"], limit=3, ctx=context)

    assert index.calls[0]["tenant_id"] == "tenant-1"
    assert index.calls[0]["collection_item_ids"] == ("collection-1",)
    assert results == [EVIDENCE]


@pytest.mark.asyncio
async def test_item_index_rejects_a_missing_tenant_scope() -> None:
    backend = StubIndexBackend()
    embedder = StubEmbedder()
    index = ItemIndex(backend=backend, embedder=embedder)  # type: ignore[arg-type]

    with pytest.raises(ValueError, match="tenant_id must not be empty"):
        await index.search_item_content(
            ["annual leave"],
            limit=3,
            tenant_id="",
            collection_item_ids=("collection-1",),
        )

    assert backend.calls == []
    assert embedder.queries == []


@pytest.mark.asyncio
async def test_knowledge_search_returns_bounded_evidence_and_source_metadata() -> None:
    retriever = StubRetriever([EVIDENCE])
    tool = KnowledgeSearch(retriever, result_limit=3)

    result = await tool.handle(invocation({"queries": ["annual leave"]}))

    assert retriever.calls == [(["annual leave"], 3)]
    assert result.error is None
    assert result.metadata["result_count"] == 1
    # The tool assigns the compact reference before building the context.
    # The canonical Document ID is deliberately exposed (it is the source
    # provenance and lineage, but the raw chunk id stays hidden
    # since only the compact reference may ever be echoed back as a citation.
    assert "Source reference: ref_1" in result.content
    assert "Document ID: doc-1" in result.content
    assert "chunk-1" not in result.content
    assert len(result.evidence) == 1
    evidence = result.evidence[0]
    assert evidence.id == "ref_1"
    assert evidence.source is not None
    assert evidence.source.provider.value == "confluence"
    assert evidence.source.url == "https://knowledge.example/leave-policy"
    assert evidence.citation.section == "Annual leave"
    assert evidence.item_id == "doc-1"
    assert evidence.chunk_id == "chunk-1"


@pytest.mark.asyncio
async def test_knowledge_search_passes_the_authenticated_context() -> None:
    retriever = StubRetriever([EVIDENCE])

    result = await KnowledgeSearch(retriever).handle(
        invocation({"queries": ["annual leave"]})
    )

    assert result.error is None
    assert retriever.contexts == [CONTEXT]


@pytest.mark.asyncio
async def test_knowledge_search_handles_empty_results() -> None:
    result = await KnowledgeSearch(StubRetriever([])).handle(
        invocation({"queries": ["annual leave"]})
    )

    assert result.error is None
    assert result.evidence == []
    assert result.metadata["outcome"] == "empty"


@pytest.mark.asyncio
async def test_knowledge_search_handles_retrieval_failures() -> None:
    result = await KnowledgeSearch(FailingRetriever()).handle(
        invocation({"queries": ["annual leave"]})
    )

    assert (
        result.error == "Knowledge search is temporarily unavailable. Please try again."
    )
    assert result.metadata["outcome"] == "retrieval_failure"


@pytest.mark.asyncio
async def test_knowledge_search_handles_timeouts() -> None:
    result = await KnowledgeSearch(
        BlockingRetriever(),
        timeout_seconds=0.01,
    ).handle(invocation({"queries": ["annual leave"]}))

    assert result.error == "Knowledge search timed out. Please try again."
    assert result.metadata["outcome"] == "timeout"


@pytest.mark.asyncio
async def test_knowledge_search_retrieves_every_query_in_one_search() -> None:
    retriever = StubRetriever([EVIDENCE])

    result = await KnowledgeSearch(retriever, result_limit=4).handle(
        invocation({"queries": ["annual leave", "carry over", "unused days"]})
    )

    assert result.metadata["outcome"] == "success"
    assert retriever.calls == [(["annual leave", "carry over", "unused days"], 4)]


@pytest.mark.asyncio
async def test_knowledge_search_bounds_total_time_when_every_query_stalls() -> None:
    tool = KnowledgeSearch(BlockingRetriever(), timeout_seconds=0.05)

    started_at = time.perf_counter()
    result = await tool.handle(
        invocation({"queries": ["annual leave", "carry over", "unused days"]})
    )
    elapsed = time.perf_counter() - started_at

    assert result.metadata["outcome"] == "timeout"
    assert elapsed < 0.2


def test_knowledge_search_rejects_a_retriever_that_is_not_a_boundary() -> None:
    """A misconfigured runtime fails at wiring time, not on every tool call."""

    with pytest.raises(TypeError, match="KnowledgeRetriever"):
        KnowledgeSearch(SimpleNamespace())  # type: ignore[arg-type]


def test_knowledge_search_builds_its_declaration_once() -> None:
    """The runtime reads the declaration on every turn; it must not be rebuilt."""

    tool = KnowledgeSearch(StubRetriever([]))

    assert tool.spec() is tool.spec()


def test_knowledge_search_declares_itself_as_a_protocol_function_tool() -> None:
    declaration = KnowledgeSearch(StubRetriever([])).as_function_tool()

    assert isinstance(declaration, FunctionTool)
    assert declaration.name == "knowledge_search"
    assert declaration.parameters["required"] == ["queries"]
    assert "access-permitted" in declaration.description
    assert "a source reference to cite" in declaration.description
    # A closed argument schema lets a provider enforce strict tool calling.
    assert declaration.strict is True


def test_tool_registry_exposes_declarations_through_the_protocol() -> None:
    registry = ToolRegistry()
    registry.register(KnowledgeSearch(StubRetriever([])))

    assert [tool.name for tool in registry.function_tools()] == ["knowledge_search"]
    assert registry.function_tools(()) == ()
    spec = registry.specs()[0]
    assert spec.activity_label == "Search knowledge base"
    assert spec.activity_category == "retrieval"


class StubRerankTransport:
    model = "reranker-test"

    def __init__(self, output_text: str, status: str = "completed") -> None:
        self.output_text = output_text
        self.status = status
        self.calls: list[dict[str, object]] = []

    async def responses(self, **kwargs: object) -> object:
        self.calls.append(dict(kwargs))
        return SimpleNamespace(output_text=self.output_text, status=self.status)


@pytest.mark.asyncio
async def test_semantic_reranker_uses_structured_order_and_preserves_scores() -> None:
    lower = _chunk(chunk_id="lower", score=0.8)
    higher = _chunk(chunk_id="higher", score=0.7)
    transport = StubRerankTransport('{"chunk_ids":["higher","lower"]}')

    ranked = await SemanticReranker(transport).rerank(  # type: ignore[arg-type]
        [lower, higher],
        queries=["annual leave policy"],
        limit=2,
    )

    assert [chunk.id for chunk in ranked] == ["higher", "lower"]
    assert [chunk.relevance_score for chunk in ranked] == [0.7, 0.8]
    assert [chunk.rerank_score for chunk in ranked] == [1.0, 0.5]
    assert transport.calls[0]["temperature"] == 0


@pytest.mark.asyncio
async def test_semantic_reranker_reports_an_empty_reasoning_model_response() -> None:
    """A reasoning model can spend the whole budget before writing anything.

    That must surface as a named retrieval failure, not as a JSON parse error
    from feeding an empty string to the decoder.
    """

    transport = StubRerankTransport("", status="incomplete")

    with pytest.raises(ValueError, match="reranker returned no text"):
        await SemanticReranker(transport).rerank(  # type: ignore[arg-type]
            [_chunk()],
            queries=["annual leave policy"],
            limit=1,
        )

    # The budget must leave room for reasoning plus the ordering itself.
    assert int(transport.calls[0]["max_output_tokens"]) >= 1_024


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "output_text",
    [
        '{"chunk_ids":["higher","lower"]}',
        '```json\n{"chunk_ids":["higher","lower"]}\n```',
        '```\n{"chunk_ids":["higher","lower"]}\n```',
        'Here is the ranking:\n{"chunk_ids":["higher","lower"]}\nHope that helps.',
    ],
)
async def test_semantic_reranker_reads_the_order_through_model_wrapping(
    output_text: str,
) -> None:
    lower = _chunk(chunk_id="lower", score=0.8)
    higher = _chunk(chunk_id="higher", score=0.7)

    ranked = await SemanticReranker(StubRerankTransport(output_text)).rerank(  # type: ignore[arg-type]
        [lower, higher],
        queries=["annual leave policy"],
        limit=2,
    )

    assert [chunk.id for chunk in ranked] == ["higher", "lower"]


@pytest.mark.asyncio
async def test_semantic_reranker_rejects_a_response_without_a_json_object() -> None:
    with pytest.raises(ValueError, match="no JSON object"):
        await SemanticReranker(StubRerankTransport("I cannot rank these.")).rerank(  # type: ignore[arg-type]
            [_chunk()],
            queries=["annual leave policy"],
            limit=1,
        )


@pytest.mark.asyncio
async def test_semantic_reranker_returns_nothing_when_nothing_is_relevant() -> None:
    first = _chunk(chunk_id="first", score=0.8)
    second = _chunk(chunk_id="second", score=0.7)

    ranked = await SemanticReranker(StubRerankTransport('{"chunk_ids":[]}')).rerank(  # type: ignore[arg-type]
        [first, second],
        queries=["xin chào"],
        limit=1,
    )

    assert ranked == []


@pytest.mark.asyncio
async def test_semantic_reranker_drops_candidates_the_model_leaves_out() -> None:
    lower = _chunk(chunk_id="lower", score=0.8)
    higher = _chunk(chunk_id="higher", score=0.7)

    ranked = await SemanticReranker(StubRerankTransport('{"chunk_ids":["higher"]}')).rerank(  # type: ignore[arg-type]
        [lower, higher],
        queries=["annual leave policy"],
        limit=2,
    )

    assert [chunk.id for chunk in ranked] == ["higher"]


class FailingReranker:
    async def rerank(
        self,
        chunks: Sequence[ContextualChunk],
        *,
        queries: Sequence[str],
        limit: int,
    ) -> list[ContextualChunk]:
        del chunks, limit, queries
        raise RuntimeError("reranker unavailable")


@pytest.mark.asyncio
async def test_reranking_failure_falls_back_to_candidate_order() -> None:
    first = _chunk(chunk_id="first", score=0.2)
    second = _chunk(chunk_id="second", score=0.9)
    index = StubDocumentIndex([first, second])
    retriever = ItemKnowledgeRetriever(
        index,
        reranker=FailingReranker(),  # type: ignore[arg-type]
        candidate_count=7,
    )

    results = await retriever.search(["annual leave"], limit=1, ctx=CONTEXT)

    assert index.calls[0]["limit"] == 7
    assert [item.chunk_id for item in results] == ["second"]


def test_context_builder_is_bounded_deduplicated_and_canonical() -> None:
    evidence = _evidence(DOCUMENT)
    built = EvidenceContextBuilder(
        max_characters=700,
        max_evidence_characters=200,
    ).build([evidence, evidence])

    assert len(built.text) <= 700
    assert built.evidence == (evidence,)
    assert built.text.count(f"Source reference: {evidence.id}") == 1
    assert built.text.count(f"Document ID: {evidence.item_id}") == 1
    assert evidence.content in built.text
    assert "Document: Leave policy\nSection:" not in built.text


@pytest.mark.asyncio
async def test_retrieval_assigns_stable_source_references_to_evidence() -> None:
    """The reference is derived from the chunk identity it stands for.

    Two retrieval rounds — or two concurrent tool calls — must produce the same
    reference for the same chunk, and different references for different ones,
    without any run-scoped counter.
    """

    other = _chunk(chunk_id="chunk-2", score=0.4)
    retriever = ItemKnowledgeRetriever(StubDocumentIndex([DOCUMENT, other]))

    first = await retriever.search(["annual leave"], limit=2, ctx=CONTEXT)
    second = await retriever.search(["annual leave"], limit=2, ctx=CONTEXT)

    references = [item.id for item in first]
    assert references == [item.id for item in second]
    assert len(set(references)) == 2
    assert all(reference.startswith("source-") for reference in references)
    # The reference never carries the identifiers it stands for.
    assert all(
        item.chunk_id not in item.id and item.item_id not in item.id for item in first
    )
    # Canonical identity is preserved alongside the reference.
    assert [(item.item_id, item.chunk_id) for item in first] == [
        ("doc-1", "chunk-1"),
        ("doc-1", "chunk-2"),
    ]


def test_source_reference_is_distinct_per_item_and_chunk() -> None:
    assert source_reference("doc-1", "chunk-1") == source_reference("doc-1", "chunk-1")
    assert source_reference("doc-1", "chunk-1") != source_reference("doc-2", "chunk-1")
    assert source_reference("doc-1", "chunk-1") != source_reference("doc-1", "chunk-2")
    # Concatenation must not collide across an item/chunk boundary.
    assert source_reference("a", "bc") != source_reference("ab", "c")


def test_context_builder_reports_the_page_the_model_may_cite() -> None:
    paged = Evidence(
        id="source-abc12345",
        item_id="doc-1",
        chunk_id="chunk-1",
        title="Leave policy",
        content="Employees receive 20 days of annual leave.",
        citation=CitationInfo(page_start=7, page_end=9),
    )

    built = EvidenceContextBuilder().build([paged])

    assert "Page: 7-9" in built.text
    assert "Document ID: doc-1" in built.text
    assert "[[cite:ref_id]]" in built.text


@pytest.mark.asyncio
async def test_references_are_compact_stable_and_shared_across_tool_calls() -> None:
    """One run numbers each distinct chunk once, in retrieval order.

    Two calls in the same run — a second retrieval round, or two concurrent
    calls — must reuse a chunk's reference rather than renumbering it, so a
    marker the model emitted earlier still resolves.
    """

    second = _chunk(chunk_id="chunk-2", score=0.4)
    tool = KnowledgeSearch(StubRetriever([EVIDENCE, _evidence(second)]), result_limit=5)
    references = CitationReferences()
    first_result = await tool.handle(
        invocation({"queries": ["annual leave"]}, references=references)
    )
    second_result = await tool.handle(
        invocation({"queries": ["carry over"]}, references=references)
    )

    assert [item.id for item in first_result.evidence] == ["ref_1", "ref_2"]
    # The same chunks keep the same references on the next round.
    assert [item.id for item in second_result.evidence] == ["ref_1", "ref_2"]
    # Canonical identity is preserved beside the reference.
    assert [(item.item_id, item.chunk_id) for item in first_result.evidence] == [
        ("doc-1", "chunk-1"),
        ("doc-1", "chunk-2"),
    ]


def test_reader_facing_numbers_follow_first_use_and_are_shared_per_document() -> None:
    references = CitationReferences()
    references.reference("doc-1", "chunk-1")  # ref_1
    references.reference("doc-1", "chunk-2")  # ref_2
    references.reference("doc-2", "chunk-9")  # ref_3

    # The answer happens to cite the second document first.
    assert references.number("ref_3") == 1
    # Two passages of one document are one source to the reader.
    assert references.number("ref_2") == 2
    assert references.number("ref_1") == 2
    assert references.number("ref_3") == 1


def test_adjacent_passages_of_one_document_show_one_marker() -> None:
    references = CitationReferences()
    evidence = {
        references.reference(item_id, chunk_id): replace(EVIDENCE, item_id=item_id, chunk_id=chunk_id)
        for item_id, chunk_id in (("doc-1", "chunk-1"), ("doc-1", "chunk-2"), ("doc-2", "chunk-9"))
    }
    for reference in evidence:
        evidence[reference] = replace(evidence[reference], id=reference)
    projection = CitationProjection(evidence, references=references)
    delta = ResponseOutputTextDeltaEvent(
        item_id="msg", output_index=0, content_index=0,
        delta="Codes [[cite:ref_1]] [[cite:ref_2]][[cite:ref_3]] end.",
    )
    projected = projection.project(delta)
    done = projection.project(
        ResponseOutputTextDoneEvent(item_id="msg", output_index=0, content_index=0, text="")
    )

    text = done[-1].text
    assert text == "Codes [1] [2] end."
    annotations = [event.annotation for event in projected if isinstance(event, ResponseOutputTextAnnotationAddedEvent)]
    # Both passages of doc-1 stay cited, and both point at the one visible [1].
    assert [(a["citation"]["chunk_id"], text[a["start_index"]:a["end_index"]]) for a in annotations] == [
        ("chunk-1", "[1]"), ("chunk-2", "[1]"), ("chunk-9", "[2]"),
    ]
