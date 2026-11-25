from __future__ import annotations

import asyncio
import sys
import time
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from bomesh.agent.citation_stream import CitationProjection
from bomesh.agent.models import AgentContext, CitationReferences
from bomesh.agent.protocol import (
    ResponseOutputTextAnnotationAddedEvent,
    ResponseOutputTextDeltaEvent,
    ResponseOutputTextDoneEvent,
)
from bomesh.agent.protocol import FunctionTool
from bomesh.agent.tools import ToolInvocation, ToolPayload, ToolRegistry
from bomesh.agent.tools.knowledge_search import KnowledgeSearch
from bomesh.connector.protocol import (
    EffectiveAccess,
    Hierarchy,
    SourceIdentity,
    SourceProvider,
)
from bomesh.document_index import ChunkContext, ContextualChunk, ItemIndex
from bomesh.document_structure import CitationTarget
from bomesh.knowledge import (
    CitationResolver,
    DocumentFacts,
    Evidence,
    EvidenceContextBuilder,
    ItemKnowledgeRetriever,
    KnowledgeRetriever,
    ReadScope,
    SemanticReranker,
)

DOC_1 = "8c1f2d3e-0000-4000-8000-000000000001"
DOC_2 = "8c1f2d3e-0000-4000-8000-000000000002"
DOC_VISIBLE = "8c1f2d3e-0000-4000-8000-0000000000a1"
DOC_UNPUBLISHED = "8c1f2d3e-0000-4000-8000-0000000000a2"
VERSION = "0123456789abcdef"
TEXT = "Employees receive 20 days of annual leave."

CONTEXT = AgentContext(
    user_id="user-1",
    tenant_id="tenant-1",
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
    item_id: str = DOC_1,
    refs: tuple[str, ...] = ("texts/3",),
) -> ContextualChunk:
    return ContextualChunk(
        id=chunk_id,
        item_id=item_id,
        chunk_index=0,
        content_type="text",
        chunk_text=TEXT,
        contextual_text=(
            "Document: Leave policy\nSection: Annual leave\n\n"
            "Employees receive 20 days of annual leave."
        ),
        context=ChunkContext(section_path=["Annual leave"]),
        title="Leave policy",
        collection_item_id=collection_item_id,
        source=SourceIdentity(
            connector_id=integration_connection_id,
            provider=SourceProvider.CONFLUENCE,
            external_id=DOC_1,
            url="https://knowledge.example/leave-policy",
        ),
        hierarchy=Hierarchy(),
        access=EffectiveAccess(),
        refs=refs,
        quote=TEXT,
        location="Annual leave",
        page=None,
        revision_number=2,
        structure_version=VERSION,
        relevance_score=score,
    )


DOCUMENT = _chunk()


def _target(chunk: ContextualChunk) -> CitationTarget:
    return CitationTarget(
        item_id=UUID(chunk.item_id),
        revision_number=chunk.revision_number,
        structure_version=chunk.structure_version,
        refs=chunk.refs,
        quote=chunk.quote,
        location=chunk.location,
        page=chunk.page,
    )


def _evidence(chunk: ContextualChunk) -> Evidence:
    return Evidence(
        id=chunk.id,
        item_id=chunk.item_id,
        chunk_id=chunk.id,
        collection_item_id=chunk.collection_item_id,
        title=chunk.title or chunk.item_id,
        content=chunk.chunk_text,
        target=_target(chunk),
        source=chunk.source,
        section_path=tuple(chunk.context.section_path),
        contextual_text=chunk.contextual_text,
        relevance_score=chunk.relevance_score,
        rerank_score=chunk.rerank_score,
        document=DocumentFacts(),
    )


EVIDENCE = _evidence(DOCUMENT)


def test_citation_resolver_links_the_original_document() -> None:
    assert CitationResolver.original_url(DOCUMENT.source) == (
        "https://knowledge.example/leave-policy"
    )


def test_evidence_contract_preserves_original_chunk_text_and_target() -> None:
    evidence = _evidence(DOCUMENT)

    assert evidence.content == DOCUMENT.chunk_text
    assert evidence.content != DOCUMENT.contextual_text
    assert evidence.target.refs == DOCUMENT.refs
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


class StubAccess:
    """The PostgreSQL side of retrieval: readable/editable collections and the hit re-check.

    ``visible_items`` is what the re-check admits (``None``: every hit).
    """

    def __init__(
        self, *, visible_items: set[str] | None = None, editable: tuple[str, ...] = ()
    ) -> None:
        self.visible_items = visible_items
        self.editable = editable
        self.rechecked: list[list[str]] = []

    async def scope(self, ctx: AgentContext) -> ReadScope:
        async def recheck(item_ids: Sequence[str]) -> dict[str, DocumentFacts]:
            self.rechecked.append(list(item_ids))
            return {
                item_id: DocumentFacts()
                for item_id in item_ids
                if self.visible_items is None or item_id in self.visible_items
            }

        return ReadScope(
            readable=ctx.collection_item_ids,
            editable=self.editable,
            recheck=recheck,
            documents=ctx.document_item_ids,
        )


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
        editable_collection_ids: tuple[str, ...],
        document_item_ids: tuple[str, ...] = (),
    ) -> list[ContextualChunk]:
        if self.events is not None:
            self.events.append("index")
        self.calls.append(
            {
                "queries": list(queries),
                "limit": limit,
                "tenant_id": tenant_id,
                "collection_item_ids": collection_item_ids,
                "editable_collection_ids": editable_collection_ids,
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
    embedding_model = "stub-embedding"

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
        editable_collection_ids: tuple[str, ...],
        document_item_ids: tuple[str, ...],
        limit: int,
        candidate_limit: int,
    ) -> list[object]:
        self.calls.append(
            (
                list(queries),
                (tenant_id, collection_item_ids, editable_collection_ids),
                limit,
                candidate_limit,
            )
        )
        return [
            SimpleNamespace(
                id="chunk-1",
                score=0.91,
                payload={
                    "item_id": DOC_1,
                    "chunk_id": "chunk-1",
                    "chunk_index": 0,
                    "title": "Leave policy",
                    "collection_item_id": "collection-1",
                    "content_type": "text",
                    "chunk_text": " Employees receive 20 days of annual leave.\n",
                    "contextual_text": (
                        "Document: Leave policy\nSection: Annual leave\n\n "
                        "Employees receive 20 days of annual leave.\n"
                    ),
                    "connector_key": "confluence",
                    "external_id": DOC_1,
                    "source_url": "https://knowledge.example/leave-policy",
                    "section_path": ["Annual leave"],
                    "refs": ["texts/3", "texts/4"],
                    "quote": "Employees receive 20 days of annual leave.",
                    "location": "Annual leave",
                    "page": 2,
                    "revision_number": 2,
                    "structure_version": VERSION,
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
        editable_collection_ids=("collection-1",),
    )

    assert embedder.queries == ["annual leave", "carry over"]
    # Every query reaches the index in one search, each with its own vector.
    assert backend.calls == [
        (
            [("annual leave", [0.1, 0.2]), ("carry over", [0.1, 0.2])],
            ("tenant-1", ("collection-1",), ("collection-1",)),
            3,
            20,
        )
    ]
    assert len(results) == 1
    document = results[0]
    assert document.id == "chunk-1"
    assert document.item_id == DOC_1
    assert document.title == "Leave policy"
    assert document.source.provider.value == "confluence"
    assert document.source.url == "https://knowledge.example/leave-policy"
    assert document.relevance_score == 0.91
    assert document.context.section_path == ["Annual leave"]
    assert document.refs == ("texts/3", "texts/4")
    assert document.quote == "Employees receive 20 days of annual leave."
    assert (document.location, document.page) == ("Annual leave", 2)
    assert (document.revision_number, document.structure_version) == (2, VERSION)
    assert document.chunk_text == " Employees receive 20 days of annual leave.\n"
    assert document.contextual_text.endswith(" annual leave.\n")


@pytest.mark.asyncio
async def test_hits_are_rechecked_before_reranking() -> None:
    """The index only pre-filters: a hit the re-check rejects never reaches the agent."""

    events: list[str] = []
    visible = _chunk(chunk_id="visible", item_id=DOC_VISIBLE, score=0.5)
    stale = _chunk(chunk_id="stale", item_id=DOC_UNPUBLISHED, score=0.99)
    index = StubDocumentIndex([stale, visible], events=events)
    access = StubAccess(visible_items={DOC_VISIBLE}, editable=("collection-7",))
    reranker = RecordingReranker(events)
    retriever = ItemKnowledgeRetriever(
        index, access=access, reranker=reranker, reranking_enabled=True
    )
    context = AgentContext(
        user_id="person@example.test",
        tenant_id="tenant-1",
        collection_item_ids=("collection-7",),
    )

    results = await retriever.search([" annual leave "], limit=3, ctx=context)

    assert index.calls == [
        {
            "queries": ["annual leave"],
            "limit": 20,
            "tenant_id": "tenant-1",
            "collection_item_ids": ("collection-7",),
            "editable_collection_ids": ("collection-7",),
        }
    ]
    assert access.rechecked == [[DOC_UNPUBLISHED, DOC_VISIBLE]]
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
    retriever = ItemKnowledgeRetriever(
        index, access=StubAccess(), reranker=reranker, reranking_enabled=True
    )

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
        access=StubAccess(),
        reranker=NothingRelevantReranker(),  # type: ignore[arg-type]
        reranking_enabled=True,
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
    retriever = ItemKnowledgeRetriever(
        index, access=StubAccess(), reranker=RecordingReranker(events), reranking_enabled=True
    )
    context = AgentContext(
        user_id="user-1",
        tenant_id="tenant-1",
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
    retriever = ItemKnowledgeRetriever(index, access=StubAccess())
    context = AgentContext(
        user_id="user-1",
        tenant_id="   ",
        collection_item_ids=("collection-1",),
    )

    with pytest.raises(ValueError, match="tenant_id must not be empty"):
        await retriever.search(["annual leave"], limit=3, ctx=context)

    assert index.calls == []


@pytest.mark.asyncio
async def test_collection_retrieval_remains_tenant_scoped() -> None:
    index = StubDocumentIndex([DOCUMENT])
    retriever = ItemKnowledgeRetriever(index, access=StubAccess())
    context = AgentContext(
        user_id="admin-1",
        tenant_id="tenant-1",
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
            editable_collection_ids=(),
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
    assert f"Document ID: {DOC_1}" in result.content
    assert "chunk-1" not in result.content
    assert len(result.evidence) == 1
    evidence = result.evidence[0]
    assert evidence.id == "ref_1"
    assert evidence.source is not None
    assert evidence.source.provider.value == "confluence"
    assert evidence.source.url == "https://knowledge.example/leave-policy"
    assert evidence.target == _target(DOCUMENT)
    assert evidence.item_id == DOC_1
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
        access=StubAccess(),
        reranker=FailingReranker(),  # type: ignore[arg-type]
        candidate_count=7,
        reranking_enabled=True,
    )

    results = await retriever.search(["annual leave"], limit=1, ctx=CONTEXT)

    assert index.calls[0]["limit"] == 7
    assert [item.chunk_id for item in results] == ["second"]


class SlowReranker:
    def __init__(self) -> None:
        self.cancelled = False

    async def rerank(
        self,
        chunks: Sequence[ContextualChunk],
        *,
        queries: Sequence[str],
        limit: int,
    ) -> list[ContextualChunk]:
        del queries, limit
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        return list(chunks)


@pytest.mark.asyncio
async def test_rerank_timeout_keeps_the_fused_candidates() -> None:
    """A slow reranker must not cost the search its fused evidence."""

    first = _chunk(chunk_id="first", score=0.2)
    second = _chunk(chunk_id="second", score=0.9)
    reranker = SlowReranker()
    retriever = ItemKnowledgeRetriever(
        StubDocumentIndex([first, second]),
        access=StubAccess(),
        reranker=reranker,  # type: ignore[arg-type]
        reranking_enabled=True,
        rerank_timeout_seconds=0.01,
    )

    results = await retriever.search(["annual leave"], limit=2, ctx=CONTEXT)

    assert reranker.cancelled is True
    assert [item.chunk_id for item in results] == ["second", "first"]


@pytest.mark.asyncio
async def test_reranking_is_off_by_default_and_uses_fused_order() -> None:
    events: list[str] = []
    first = _chunk(chunk_id="first", score=0.2)
    second = _chunk(chunk_id="second", score=0.9)
    retriever = ItemKnowledgeRetriever(
        StubDocumentIndex([first, second], events=events),
        access=StubAccess(),
        reranker=RecordingReranker(events),
    )

    results = await retriever.search(["annual leave"], limit=1, ctx=CONTEXT)

    assert events == ["index"]
    assert [item.chunk_id for item in results] == ["second"]


@pytest.mark.asyncio
async def test_repeated_query_reuses_the_cached_query_embedding() -> None:
    backend = StubIndexBackend()
    embedder = StubEmbedder()
    index = ItemIndex(backend=backend, embedder=embedder)  # type: ignore[arg-type]
    scope = {
        "limit": 3,
        "tenant_id": "tenant-1",
        "collection_item_ids": ("collection-1",),
        "editable_collection_ids": (),
    }

    await index.search_item_content(["annual leave"], **scope)  # type: ignore[arg-type]
    await index.search_item_content(["  annual   leave "], **scope)  # type: ignore[arg-type]

    assert embedder.queries == ["annual leave"]
    assert [call[0] for call in backend.calls] == [
        [("annual leave", [0.1, 0.2])],
        [("annual leave", [0.1, 0.2])],
    ]


@pytest.mark.asyncio
async def test_query_embedding_cache_is_bounded_and_can_be_disabled() -> None:
    embedder = StubEmbedder()
    bounded = ItemIndex(
        backend=StubIndexBackend(), embedder=embedder, query_embedding_cache_size=1  # type: ignore[arg-type]
    )
    scope = {
        "limit": 3,
        "tenant_id": "tenant-1",
        "collection_item_ids": ("collection-1",),
        "editable_collection_ids": (),
    }
    for query in ("annual leave", "carry over", "annual leave"):
        await bounded.search_item_content([query], **scope)  # type: ignore[arg-type]
    assert embedder.queries == ["annual leave", "carry over", "annual leave"]

    uncached_embedder = StubEmbedder()
    uncached = ItemIndex(
        backend=StubIndexBackend(), embedder=uncached_embedder, query_embedding_cache_size=0  # type: ignore[arg-type]
    )
    for _ in range(2):
        await uncached.search_item_content(["annual leave"], **scope)  # type: ignore[arg-type]
    assert uncached_embedder.queries == ["annual leave", "annual leave"]


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
async def test_retrieval_cites_the_blocks_each_chunk_was_cut_from() -> None:
    """Evidence carries the chunk's target: its revision, Structured Document and blocks."""

    other = _chunk(chunk_id="chunk-2", score=0.4, refs=("tables/0", "texts/9"))
    retriever = ItemKnowledgeRetriever(
        StubDocumentIndex([DOCUMENT, other]), access=StubAccess()
    )

    found = await retriever.search(["annual leave"], limit=2, ctx=CONTEXT)

    assert [item.target for item in found] == [
        CitationTarget(
            item_id=UUID(DOC_1),
            revision_number=2,
            structure_version=VERSION,
            refs=refs,
            quote=TEXT,
            location="Annual leave",
        )
        for refs in (("texts/3",), ("tables/0", "texts/9"))
    ]
    assert [(item.item_id, item.chunk_id) for item in found] == [
        (DOC_1, "chunk-1"),
        (DOC_1, "chunk-2"),
    ]


def test_context_builder_reports_where_the_evidence_is() -> None:
    located = replace(
        EVIDENCE,
        id="ref_1",
        target=EVIDENCE.target.model_copy(update={"location": "Leave > Carry-over", "page": 7}),
    )

    built = EvidenceContextBuilder().build([located])

    assert "Location: Leave > Carry-over\nPage: 7" in built.text
    assert f"Document ID: {DOC_1}" in built.text
    assert "[[cite:ref_id]]" in built.text
    unlocated = replace(
        EVIDENCE, target=EVIDENCE.target.model_copy(update={"location": "", "page": None})
    )
    text = EvidenceContextBuilder().build([unlocated]).text
    assert "Location:" not in text and "Page:" not in text


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
        (DOC_1, "chunk-1"),
        (DOC_1, "chunk-2"),
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


def _cited(item_id: str, chunk_id: str, refs: tuple[str, ...]) -> Evidence:
    return replace(
        EVIDENCE,
        item_id=item_id,
        chunk_id=chunk_id,
        target=EVIDENCE.target.model_copy(update={"item_id": UUID(item_id), "refs": refs}),
    )


def _project(evidence: dict[str, Evidence], references: CitationReferences, delta: str) -> tuple[str, list[dict]]:
    projection = CitationProjection(evidence, workspace_id="ws-1", references=references)
    projected = projection.project(
        ResponseOutputTextDeltaEvent(item_id="msg", output_index=0, content_index=0, delta=delta)
    )
    done = projection.project(
        ResponseOutputTextDoneEvent(item_id="msg", output_index=0, content_index=0, text="")
    )
    annotations = [event.annotation for event in projected if isinstance(event, ResponseOutputTextAnnotationAddedEvent)]
    return done[-1].text, annotations


def test_adjacent_passages_of_one_document_show_one_marker() -> None:
    references = CitationReferences()
    evidence = {
        references.reference(item_id, chunk_id): _cited(item_id, chunk_id, refs)
        for item_id, chunk_id, refs in (
            (DOC_1, "chunk-1", ("texts/1",)),
            (DOC_1, "chunk-2", ("texts/2",)),
            (DOC_2, "chunk-9", ("tables/0",)),
        )
    }
    for reference in evidence:
        evidence[reference] = replace(evidence[reference], id=reference)

    text, annotations = _project(
        evidence, references, "Codes [[cite:ref_1]] [[cite:ref_2]][[cite:ref_3]] end."
    )

    assert text == "Codes [1] [2] end."
    # Both chunks of DOC_1 stay cited, and both point at the one visible [1].
    assert [
        (a["citation"]["item"], a["citation"]["refs"], text[a["start_index"]:a["end_index"]])
        for a in annotations
    ] == [
        (f"workspaces/ws-1/items/{DOC_1}", ["texts/1"], "[1]"),
        (f"workspaces/ws-1/items/{DOC_1}", ["texts/2"], "[1]"),
        (f"workspaces/ws-1/items/{DOC_2}", ["tables/0"], "[2]"),
    ]


def test_annotation_carries_the_issued_target_and_never_a_model_supplied_id() -> None:
    """The model only picks an issued reference; everything cited comes from the evidence."""

    references = CitationReferences()
    reference = references.reference(DOC_1, "chunk-1")
    evidence = {reference: replace(_cited(DOC_1, "chunk-1", ("texts/3", "tables/1")), id=reference)}

    text, annotations = _project(
        evidence,
        references,
        f"Leave [[cite:{reference}]] carries [[cite:ref_9]][[cite:{DOC_2}]][[cite:chunk-1]] over.",
    )

    # Unissued markers, item ids and chunk ids are dropped, never shown or cited.
    assert text == "Leave [1] carries  over."
    assert [annotation["citation"] for annotation in annotations] == [
        {
            "id": "ref_1",
            "reference": "ref_1",
            "number": 1,
            "item": f"workspaces/ws-1/items/{DOC_1}",
            "title": "Leave policy",
            "revision": f"workspaces/ws-1/items/{DOC_1}/revisions/2",
            "structure_version": VERSION,
            "refs": ["texts/3", "tables/1"],
            "quote": TEXT,
            "location": "Annual leave",
            "page": None,
            "original_url": "https://knowledge.example/leave-policy",
        }
    ]
