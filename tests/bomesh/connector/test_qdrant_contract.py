from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import pytest
from bomesh.connector.protocol import (
    AccessPolicy,
    Chunk,
    CitationInfo,
    CitationSpan,
    DocumentItem,
    DocumentKind,
    Hierarchy,
    SourceIdentity,
    SourceProvider,
    TextPart,
)
from bomesh.document_index import (
    INDEX_SCHEMA_VERSION,
    ClassificationRequest,
    ContextualChunk,
    DocumentClassification,
    IndexingContext,
    ItemIndex,
    SemanticContextualizer,
    TopicCandidate,
    build_contextual_chunks,
)


def _document() -> DocumentItem:
    return DocumentItem(
        id="jira::BANK-42",
        title="Story: Lending policy",
        document_kind=DocumentKind.ISSUE,
        source=SourceIdentity(
            connector_id="connection-1",
            provider=SourceProvider.JIRA,
            external_id="BANK-42",
            url="https://jira.example/browse/BANK-42",
        ),
        hierarchy=Hierarchy(parent_id="jira::BANK"),
        metadata={"summary": "Explains the approved lending policy."},
        access=AccessPolicy.from_reader_ids(["public"]),
        content=[TextPart(text="RAW-CONTENT-MUST-NOT-BE-INDEXED")],
    )


def _chunk() -> Chunk:
    return Chunk(
        id="jira::BANK-42:0",
        item_id="jira::BANK-42",
        chunk_index=0,
        chunk_text="connector evidence",
        content_type="mixed",
        citation=CitationInfo(
            section="Replication",
            spans=(CitationSpan(page=2), CitationSpan(page=4)),
        ),
    )


def _context() -> IndexingContext:
    return IndexingContext(
        tenant_id="tenant-1",
        collection_item_id="collection-1",
        connector_key="jira",
    )


class _Embedder:
    embedding_model = "test-embedding"

    async def embed_documents(self, documents: list[str]) -> list[list[float]]:
        return [[float(len(document))] for document in documents]


class _Backend:
    def __init__(self) -> None:
        self.records: list[object] = []

    async def replace_item_points(self, **kwargs: object) -> None:
        self.records = list(kwargs["records"])  # type: ignore[arg-type]


def test_indexing_context_normalizes_required_identifiers() -> None:
    context = IndexingContext(
        tenant_id=" tenant-1 ",
        collection_item_id=" collection-1 ",
        parent_item_id=" ",
        connector_key=" file ",
    )

    assert context.tenant_id == "tenant-1"
    assert context.collection_item_id == "collection-1"
    assert context.parent_item_id is None
    assert context.connector_key == "file"


@pytest.mark.asyncio
async def test_index_projection_is_bounded_and_collection_scoped() -> None:
    document = _document()
    source_chunk = _chunk()
    contextual, classified = await build_contextual_chunks([source_chunk], document)
    assert classified is None
    assert len(contextual) == 1
    assert isinstance(contextual[0], ContextualChunk)
    assert contextual[0].chunk_text == source_chunk.chunk_text
    assert "RAW-CONTENT-MUST-NOT-BE-INDEXED" not in contextual[0].contextual_text
    backend = _Backend()
    index = ItemIndex(backend=backend, embedder=_Embedder())  # type: ignore[arg-type]
    await index.index_item_content(document, [source_chunk], context=_context())
    record = backend.records[0]
    assert hasattr(record, "payload")
    payload = record.payload
    assert payload.collection_item_id == "collection-1"
    assert payload.connector_key == "jira"
    assert payload.section_path == ["Replication"]
    assert payload.page_start == 2
    assert payload.page_end == 4
    assert payload.schema_version == INDEX_SCHEMA_VERSION
    serialized_payload = payload.to_payload()
    assert {
        "integration_connection_id",
        "ingestion_source_id",
        "embedding_model",
        "root_id",
        "context_section_path",
        "citation_section_path",
        "citation_section",
        "context_summary",
        "citation_spans",
    }.isdisjoint(serialized_payload)
    serialized = json.dumps(serialized_payload)
    assert "RAW-CONTENT-MUST-NOT-BE-INDEXED" not in serialized


@pytest.mark.asyncio
async def test_qdrant_point_ids_are_deterministic() -> None:
    backend = _Backend()
    index = ItemIndex(backend=backend, embedder=_Embedder())  # type: ignore[arg-type]
    await index.index_item_content(_document(), [_chunk()], context=_context())
    first_id = backend.records[0].point_id
    await index.index_item_content(_document(), [_chunk()], context=_context())
    assert backend.records[0].point_id == first_id


def test_public_access_is_explicit() -> None:
    assert AccessPolicy().is_public is False
    assert AccessPolicy.from_reader_ids(["public"]).is_public is True


@pytest.mark.asyncio
async def test_index_boundary_rejects_chunks_from_another_document() -> None:
    with pytest.raises(ValueError, match="belongs to item"):
        await build_contextual_chunks(
            [_chunk().model_copy(update={"item_id": "another-item"})],
            _document(),
        )


class _SemanticContextualizer:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.calls: list[dict[str, object]] = []

    async def describe(self, chunk: Chunk, **kwargs: object) -> str:
        self.calls.append({"chunk": chunk, **kwargs})
        if self.fail:
            raise RuntimeError("semantic provider failed")
        return "The chunk describes the BANK-42 approved lending policy."


@pytest.mark.asyncio
async def test_semantic_contextualization_enriches_retrieval_not_evidence() -> None:
    contextualizer = _SemanticContextualizer()
    source = _chunk()

    contextual, _ = await build_contextual_chunks(
        [source],
        _document(),
        semantic_contextualizer=contextualizer,  # type: ignore[arg-type]
    )

    assert len(contextualizer.calls) == 1
    call = contextualizer.calls[0]
    assert "Document: Story: Lending policy" in str(call["document_context"])
    assert "RAW-CONTENT-MUST-NOT-BE-INDEXED" not in str(call["document_context"])
    assert contextual[0].chunk_text == "connector evidence"
    assert "BANK-42 approved lending policy" in contextual[0].contextual_text
    assert contextual[0].contextual_text.endswith(source.chunk_text)


@pytest.mark.asyncio
async def test_semantic_contextualization_failure_uses_structural_fallback() -> None:
    contextualizer = _SemanticContextualizer(fail=True)

    contextual, _ = await build_contextual_chunks(
        [_chunk()],
        _document(),
        semantic_contextualizer=contextualizer,  # type: ignore[arg-type]
    )

    assert len(contextualizer.calls) == 1
    assert contextual[0].chunk_text == "connector evidence"
    assert "Explains the approved lending policy." in contextual[0].contextual_text


class _ProfileTransport:
    model = "configured-contextualization-model"

    def __init__(self, *profiles: str | Exception) -> None:
        self.profiles = list(profiles)
        self.profile_requests: list[dict[str, Any]] = []
        self.context_prompts: list[str] = []

    async def responses(self, *, input: Any, model: str | None = None, **params: Any) -> Any:
        if isinstance(input, str):
            self.context_prompts.append(input)
            return SimpleNamespace(output_text="The chunk covers lending approvals.")
        blocks = input[0]["content"]
        self.profile_requests.append(
            {"blocks": blocks, "input": "\n\n".join(b["text"] for b in blocks), "model": model, **params}
        )
        # The last answer repeats for any further call.
        profile = self.profiles.pop(0) if len(self.profiles) > 1 else self.profiles[0]
        if isinstance(profile, Exception):
            raise profile
        return SimpleNamespace(output_text=profile)


_LENDING = TopicCandidate(
    id="topic-lending", code="lending", name="Lending", description="Credit products", domain="Retail"
)
_HR = TopicCandidate(id="topic-hr", code="hr", name="HR", keywords=("payroll",))
_REQUEST = ClassificationRequest(candidates=(_LENDING, _HR), note="Bank policies")
#: Taxonomy order is by domain, then name: HR (its own domain) is T1, Retail's Lending T2.
_ANSWER = '{"topics": [{"label": "T2", "name": "Lending", "evidence": "loan"}], "summary": "The retail lending policy."}'


def _unsummarized() -> DocumentItem:
    return _document().model_copy(update={"metadata": {}})


def _chunks() -> list[Chunk]:
    return [
        _chunk(),
        _chunk().model_copy(
            update={"id": "jira::BANK-42:1", "chunk_index": 1, "chunk_text": "second"}
        ),
    ]


@pytest.mark.asyncio
async def test_classifying_runs_once_before_contextualizing_and_feeds_the_summary() -> None:
    transport = _ProfileTransport(
        '```json\n{"topics": [{"label": "T2", "name": "Lending"}, {"label": "T7", "name": "Made up"}],'
        ' "summary": "The retail lending policy."}\n```'
    )
    phases: list[tuple[str, int, int]] = []

    contextual, classified = await build_contextual_chunks(
        _chunks(),
        _unsummarized(),
        semantic_contextualizer=SemanticContextualizer(transport, model_name=transport.model),  # type: ignore[arg-type]
        classification=_REQUEST,
        progress=lambda phase, done, total: phases.append((phase, done, total)),
    )

    assert classified == DocumentClassification(
        topics=(_LENDING,), summary="The retail lending policy."
    )
    [request] = transport.profile_requests
    assert request["model"] == transport.model
    assert request["temperature"] == 0
    assert "Bank policies" in request["input"]
    assert "T2 | Lending | Credit products" in request["input"]
    assert "Leading canonical chunk excerpts:" in request["input"]
    assert phases[:3] == [("classifying", 0, 1), ("classifying", 1, 1), ("contextualizing", 0, 2)]
    assert all("Summary: The retail lending policy." in prompt for prompt in transport.context_prompts)
    assert all(chunk.context.summary == "The retail lending policy." for chunk in contextual)


@pytest.mark.asyncio
async def test_every_document_of_a_request_shares_one_cached_prefix() -> None:
    transport = _ProfileTransport(_ANSWER)
    contextualizer = SemanticContextualizer(transport)  # type: ignore[arg-type]

    for title, text in (("Loan policy", "Loans need two approvals."), ("Payroll calendar", "Payroll runs monthly.")):
        await contextualizer.classify(document_context=text, request=_REQUEST, title=title)

    first, second = transport.profile_requests
    # The taxonomy prefix is byte-identical, marked as a cache breakpoint and keyed
    # for sticky routing; only the document's block differs.
    assert first["blocks"][0] == second["blocks"][0]
    assert first["blocks"][0]["cache_control"] == {"type": "ephemeral"}
    assert "<taxonomy>" in first["blocks"][0]["text"] and "Loan policy" not in first["blocks"][0]["text"]
    assert first["prompt_cache_key"] == second["prompt_cache_key"]
    assert first["blocks"][1] != second["blocks"][1]
    # A keyword found in the document is a hint in the document's own block.
    assert "T1 HR: payroll (title)" in second["blocks"][1]["text"]


@pytest.mark.asyncio
async def test_labels_resolve_by_name_and_several_topics_across_domains_are_kept() -> None:
    transport = _ProfileTransport(
        '{"topics": ['
        '{"label": "T1", "name": "Lending"},'  # mis-copied label: the name decides
        '{"label": "T1", "name": "HR"},'
        '{"label": "T2", "name": "Treasury"}'  # neither label nor name agree: dropped
        '], "summary": "Policy."}'
    )

    classified = await SemanticContextualizer(transport).classify(  # type: ignore[arg-type]
        document_context="Loans and payroll.", request=_REQUEST, title="Policy"
    )

    assert classified.topics == (_LENDING, _HR)
    assert len(transport.profile_requests) == 1


@pytest.mark.asyncio
async def test_an_answer_without_a_valid_topic_is_asked_again_once() -> None:
    transport = _ProfileTransport('{"topics": [{"label": "T9", "name": "Treasury"}], "summary": "x"}', _ANSWER)

    classified = await SemanticContextualizer(transport).classify(  # type: ignore[arg-type]
        document_context="Loans need two approvals.", request=_REQUEST, title="Loan policy"
    )

    assert classified.topics == (_LENDING,)
    first, retry = transport.profile_requests
    # The retry keeps the cached prefix and the document, and says what was wrong.
    assert retry["blocks"][:2] == first["blocks"][:2]
    assert "Treasury" in retry["blocks"][2]["text"]


@pytest.mark.asyncio
async def test_a_cold_prefix_is_written_by_one_call_before_parallel_documents_read_it() -> None:
    release = asyncio.Event()
    in_flight: list[int] = []

    class _Slow(_ProfileTransport):
        async def responses(self, **params: Any) -> Any:
            in_flight.append(len(self.profile_requests))
            if len(self.profile_requests) == 0:
                self.profile_requests.append(params)
                await release.wait()
                return SimpleNamespace(output_text=_ANSWER)
            return await super().responses(**params)

    transport = _Slow(_ANSWER)
    contextualizer = SemanticContextualizer(transport)  # type: ignore[arg-type]
    documents = [
        asyncio.create_task(contextualizer.classify(document_context=f"Loan {n}", request=_REQUEST))
        for n in range(3)
    ]
    await asyncio.sleep(0.01)

    # While the first call writes the cache, the others wait instead of writing it too.
    assert in_flight == [0]
    release.set()
    classified = await asyncio.gather(*documents)

    assert len(transport.profile_requests) == 3
    assert all(c.topics == (_LENDING,) for c in classified)


@pytest.mark.asyncio
async def test_the_documents_own_summary_wins_over_the_classification_summary() -> None:
    transport = _ProfileTransport('{"topics": [], "summary": "Model summary."}')

    contextual, classified = await build_contextual_chunks(
        [_chunk()],
        _document(),
        semantic_contextualizer=SemanticContextualizer(transport),  # type: ignore[arg-type]
        classification=_REQUEST,
    )

    assert classified == DocumentClassification(topics=(), summary="Model summary.")
    assert contextual[0].context.summary == "Explains the approved lending policy."


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("profile", "calls"),
    [('{"topics": "lending"}', 2), ("no json here", 2), (RuntimeError("provider down"), 1)],
)
async def test_a_failed_classification_leaves_indexing_unclassified(
    profile: str | Exception, calls: int
) -> None:
    transport = _ProfileTransport(profile)

    contextual, classified = await build_contextual_chunks(
        _chunks(),
        _unsummarized(),
        semantic_contextualizer=SemanticContextualizer(transport),  # type: ignore[arg-type]
        classification=_REQUEST,
    )

    assert classified is None
    # An unreadable answer is asked again once; a provider error is not.
    assert len(transport.profile_requests) == calls
    assert len(transport.context_prompts) == 2
    assert [chunk.context.summary for chunk in contextual] == [None, None]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("classification", "contextualized"),
    [
        (None, True),
        (ClassificationRequest(candidates=()), True),
        (_REQUEST, False),
    ],
)
async def test_no_candidates_or_no_contextualizer_means_no_classifying(
    classification: ClassificationRequest | None, contextualized: bool
) -> None:
    transport = _ProfileTransport(_ANSWER)
    phases: list[str] = []

    _, classified = await build_contextual_chunks(
        [_chunk()],
        _document(),
        semantic_contextualizer=(
            SemanticContextualizer(transport) if contextualized else None  # type: ignore[arg-type]
        ),
        classification=classification,
        progress=lambda phase, *_: phases.append(phase),
    )

    assert classified is None
    assert transport.profile_requests == []
    assert "classifying" not in phases
