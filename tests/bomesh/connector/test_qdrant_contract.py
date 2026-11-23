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
    ModelUsage,
    SemanticContextualizer,
    TopicCandidate,
    WindowContexts,
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

    def __init__(self) -> None:
        self.embedded: list[str] = []

    async def embed_documents(self, documents: list[str]) -> list[list[float]]:
        self.embedded.extend(documents)
        return [[float(len(document))] for document in documents]


class _Backend:
    def __init__(self) -> None:
        self.records: list[object] = []
        self.vectors: list[list[float]] = []

    async def previous_item_points(self, **kwargs: object) -> list[tuple[dict[str, Any], list[float] | None]]:
        # What the Item has indexed now: the points of the last replace.
        return [
            (record.payload.to_payload(), vector)  # type: ignore[attr-defined]
            for record, vector in zip(self.records, self.vectors, strict=True)
        ]

    async def replace_item_points(self, **kwargs: object) -> None:
        self.records = list(kwargs["records"])  # type: ignore[arg-type]
        self.vectors = list(kwargs["vectors"])  # type: ignore[arg-type]


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
    assert payload.embedding_model == "test-embedding"
    serialized_payload = payload.to_payload()
    assert {
        "integration_connection_id",
        "ingestion_source_id",
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
    model_name = "configured-contextualization-model"

    def __init__(self, *, fail: bool = False, answer_only: int | None = None) -> None:
        self.fail = fail
        self.answer_only = answer_only
        self.calls: list[dict[str, Any]] = []

    async def describe_window(self, **kwargs: Any) -> WindowContexts:
        self.calls.append(kwargs)
        if self.fail:
            raise RuntimeError("semantic provider failed")
        targets = list(kwargs["targets"])[: self.answer_only]
        return WindowContexts(
            contexts={index: f"Chunk {index} describes the BANK-42 approved lending policy." for index in targets},
            usage=ModelUsage(calls=1, input_tokens=100, output_tokens=10),
        )


def _many(count: int, *, content_type: str = "text") -> list[Chunk]:
    return [
        _chunk().model_copy(
            update={
                "id": f"jira::BANK-42:{n}",
                "chunk_index": n,
                "chunk_text": f"evidence {n}",
                "content_type": content_type,
            }
        )
        for n in range(count)
    ]


@pytest.mark.asyncio
async def test_semantic_contextualization_enriches_retrieval_not_evidence() -> None:
    contextualizer = _SemanticContextualizer()
    sources = _many(3)

    contextual, _ = await build_contextual_chunks(
        sources,
        _document(),
        semantic_contextualizer=contextualizer,  # type: ignore[arg-type]
    )

    [call] = contextualizer.calls
    assert call["title"] == "Story: Lending policy"
    assert call["targets"] == [0, 1, 2]
    assert "RAW-CONTENT-MUST-NOT-BE-INDEXED" not in str(call["overview"])
    assert [chunk.chunk_text for chunk in contextual] == ["evidence 0", "evidence 1", "evidence 2"]
    assert "Chunk 1 describes the BANK-42 approved lending policy." in contextual[1].contextual_text
    assert contextual[1].contextual_text.endswith("evidence 1")
    assert contextual[1].context.semantic_key


@pytest.mark.asyncio
async def test_semantic_contextualization_failure_uses_structural_fallback() -> None:
    contextualizer = _SemanticContextualizer(fail=True)

    contextual, _ = await build_contextual_chunks(
        _many(3),
        _document(),
        semantic_contextualizer=contextualizer,  # type: ignore[arg-type]
    )

    assert len(contextualizer.calls) == 1
    assert contextual[0].chunk_text == "evidence 0"
    assert "Explains the approved lending policy." in contextual[0].contextual_text
    assert contextual[0].context.semantic is None and contextual[0].context.semantic_key is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("chunks", "asked"),
    [
        # Two chunks: the title, section and summary already situate them.
        (_many(2), []),
        # A mostly tabular document: its table chunks are not sent, its prose is.
        (
            [*_many(9, content_type="table"), _chunk().model_copy(update={"id": "p", "chunk_index": 9})],
            [9],
        ),
        # Tables inside a prose document are sent like the rest.
        (
            [*_many(3), _chunk().model_copy(update={"id": "t", "chunk_index": 3, "content_type": "table"})],
            [0, 1, 2, 3],
        ),
    ],
)
async def test_tiny_and_tabular_content_is_not_sent_to_the_model(
    chunks: list[Chunk], asked: list[int]
) -> None:
    contextualizer = _SemanticContextualizer()

    await build_contextual_chunks(chunks, _document(), semantic_contextualizer=contextualizer)  # type: ignore[arg-type]

    assert [index for call in contextualizer.calls for index in call["targets"]] == asked


@pytest.mark.asyncio
async def test_long_documents_are_windowed_and_each_window_situated_by_the_opening() -> None:
    contextualizer = _SemanticContextualizer()

    await build_contextual_chunks(_many(60), _document(), semantic_contextualizer=contextualizer)  # type: ignore[arg-type]

    windows = sorted(contextualizer.calls, key=lambda call: call["window"][0].chunk_index)
    assert [call["window"][0].chunk_index for call in windows] == [0, 24, 48]
    assert all(len(call["window"]) <= 24 for call in windows)
    assert sorted(index for call in windows for index in call["targets"]) == list(range(60))
    # A later window is told how the document opens; the first one shows it itself.
    assert "Document opening:" not in windows[0]["overview"]
    assert "evidence 0" in windows[1]["overview"]


@pytest.mark.asyncio
async def test_known_contexts_are_reused_without_a_model_call() -> None:
    first = _SemanticContextualizer()
    contextual, _ = await build_contextual_chunks(_many(4), _document(), semantic_contextualizer=first)  # type: ignore[arg-type]
    known = {chunk.context.semantic_key: chunk.context.semantic for chunk in contextual}

    again = _SemanticContextualizer()
    changed = [*_many(3), _chunk().model_copy(update={"id": "x", "chunk_index": 3, "chunk_text": "new evidence"})]
    reused, _ = await build_contextual_chunks(
        changed, _document(), semantic_contextualizer=again, known_contexts=known  # type: ignore[arg-type]
    )

    # A changed chunk changes its window, so the whole window is written again.
    assert [call["targets"] for call in again.calls] == [[0, 1, 2, 3]]
    unchanged, _ = await build_contextual_chunks(
        _many(4), _document(), semantic_contextualizer=again, known_contexts=known  # type: ignore[arg-type]
    )
    assert len(again.calls) == 1
    assert [chunk.contextual_text for chunk in unchanged] == [chunk.contextual_text for chunk in contextual]
    # The changed chunk's context was written by the new call, not reused.
    assert reused[3].contextual_text.endswith("new evidence") and reused[3].context.semantic_key not in known


@pytest.mark.asyncio
async def test_processing_the_same_content_again_reuses_contexts_and_vectors() -> None:
    backend = _Backend()
    embedder = _Embedder()
    contextualizer = _SemanticContextualizer()
    index = ItemIndex(backend=backend, embedder=embedder, semantic_contextualizer=contextualizer)  # type: ignore[arg-type]

    await index.index_item_content(_document(), _many(5), context=_context())
    first_payloads = [record.payload.to_payload() for record in backend.records]  # type: ignore[attr-defined]
    calls, embedded = len(contextualizer.calls), len(embedder.embedded)
    await index.index_item_content(_document(), _many(5), context=_context())

    assert (calls, embedded) == (1, 5)
    assert len(contextualizer.calls) == calls and len(embedder.embedded) == embedded
    assert [record.payload.to_payload() for record in backend.records] == first_payloads  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_vectors_of_another_embedding_model_are_not_reused() -> None:
    backend = _Backend()
    index = ItemIndex(backend=backend, embedder=_Embedder())  # type: ignore[arg-type]
    await index.index_item_content(_document(), _many(3), context=_context())

    other = _Embedder()
    other.embedding_model = "another-embedding"  # type: ignore[misc]
    await ItemIndex(backend=backend, embedder=other).index_item_content(  # type: ignore[arg-type]
        _document(), _many(3), context=_context()
    )

    assert len(other.embedded) == 3


class _ProfileTransport:
    model = "configured-contextualization-model"

    def __init__(self, *profiles: str | Exception, contexts: str | None = None) -> None:
        self.profiles = list(profiles)
        self.contexts = contexts
        self.profile_requests: list[dict[str, Any]] = []
        self.context_requests: list[dict[str, Any]] = []

    @property
    def context_prompts(self) -> list[str]:
        return [request["input"] for request in self.context_requests]

    async def responses(self, *, input: Any, model: str | None = None, **params: Any) -> Any:
        blocks = input[0]["content"]
        request = {"blocks": blocks, "input": "\n\n".join(b["text"] for b in blocks), "model": model, **params}
        if blocks[0]["text"].startswith("<contextual_retrieval_instructions>"):
            self.context_requests.append(request)
            ids = json.loads(blocks[1]["text"].split(">", 1)[1].split("<", 1)[0])
            answer = self.contexts or json.dumps(
                {"contexts": [{"id": i, "context": f"Chunk {i} covers lending approvals."} for i in ids]}
            )
            return SimpleNamespace(
                output_text=answer,
                usage=SimpleNamespace(
                    input_tokens=1000, output_tokens=20, input_tokens_details=SimpleNamespace(cached_tokens=900)
                ),
            )
        self.profile_requests.append(request)
        # The last answer repeats for any further call.
        profile = self.profiles.pop(0) if len(self.profiles) > 1 else self.profiles[0]
        if isinstance(profile, Exception):
            raise profile
        return SimpleNamespace(output_text=profile)


@pytest.mark.asyncio
async def test_a_window_is_one_cached_prefix_asked_in_batches() -> None:
    transport = _ProfileTransport(_ANSWER)
    contextualizer = SemanticContextualizer(transport, model_name=transport.model)  # type: ignore[arg-type]
    window = _many(20)

    answer = await contextualizer.describe_window(
        title="Story", overview="Document kind: issue", window=window, targets=list(range(20))
    )

    requests = transport.context_requests
    assert [json.loads(r["blocks"][1]["text"].split(">", 1)[1].split("<", 1)[0]) for r in requests] == [
        list(range(8)), list(range(8, 16)), list(range(16, 20))
    ]
    # One byte-identical prefix (no cache marker: the provider caches it implicitly)
    # under one sticky key; the first call writes it before the others read it.
    assert len({r["blocks"][0]["text"] for r in requests}) == 1
    assert "cache_control" not in requests[0]["blocks"][0]
    assert len({r["prompt_cache_key"] for r in requests}) == 1
    assert "[19] evidence 19" in requests[0]["blocks"][0]["text"]
    assert sorted(answer.contexts) == list(range(20))
    assert answer.usage == ModelUsage(calls=3, input_tokens=3000, cached_tokens=2700, output_tokens=60)


@pytest.mark.asyncio
async def test_unusable_or_missing_contexts_are_asked_once_more_then_left_structural() -> None:
    answer = json.dumps(
        {
            "contexts": [
                {"id": 0, "context": "Context: a prefixed answer"},
                {"id": 1, "context": "Situates chunk one."},
                {"id": 7, "context": "An id nobody asked for."},
            ]
        }
    )
    transport = _ProfileTransport(_ANSWER, contexts=answer)
    contextualizer = SemanticContextualizer(transport)  # type: ignore[arg-type]

    result = await contextualizer.describe_window(title=None, overview="", window=_many(3), targets=[0, 1, 2])

    assert result.contexts == {1: "Situates chunk one."}
    asked = [json.loads(r["blocks"][1]["text"].split(">", 1)[1].split("<", 1)[0]) for r in transport.context_requests]
    assert asked == [[0, 1, 2], [0, 2]]


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
    return _many(3)


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
    assert phases[:3] == [("classifying", 0, 1), ("classifying", 1, 1), ("contextualizing", 0, 3)]
    # The model's summary changes from run to run; windows are not built from it,
    # so their contexts stay reusable. It still situates every chunk's structure.
    assert transport.context_prompts and all("The retail lending policy." not in p for p in transport.context_prompts)
    assert all(chunk.context.summary == "The retail lending policy." for chunk in contextual)


@pytest.mark.asyncio
async def test_every_document_of_a_request_shares_one_cached_prefix() -> None:
    transport = _ProfileTransport(_ANSWER)
    contextualizer = SemanticContextualizer(transport)  # type: ignore[arg-type]

    for title, text in (("Loan policy", "Loans need two approvals."), ("Payroll calendar", "Payroll runs monthly.")):
        await contextualizer.classify(document_context=text, request=_REQUEST, title=title)

    first, second = transport.profile_requests
    # The taxonomy prefix is byte-identical and keyed for sticky routing, so the
    # provider serves it from its cache; only the document's block differs.
    assert first["blocks"][0] == second["blocks"][0]
    assert "cache_control" not in first["blocks"][0]
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
    # Contextualizing goes on: the window's three chunks in one call.
    assert len(transport.context_prompts) == 1
    assert [chunk.context.summary for chunk in contextual] == [None, None, None]


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
