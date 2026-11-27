from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest
from bomesh.connector.protocol import (
    AccessPolicy,
    Chunk,
    DocumentItem,
    DocumentKind,
    Hierarchy,
    SourceIdentity,
    SourceProvider,
)
from bomesh.document_index import (
    INDEX_SCHEMA_VERSION,
    ChunkContextGenerator,
    ClassificationRequest,
    ContextualChunk,
    DocumentClassification,
    IndexingContext,
    IndexProgress,
    ItemIndex,
    ModelUsage,
    PromptCandidate,
    PromptConcept,
    PromptScheme,
    SchemeAnswer,
    SchemeTask,
    SectionExcerpt,
    SemanticContextualizer,
    WindowContexts,
    build_contextual_chunks,
    classification_prompt,
)
from bomesh.document_index.payload import _contextual_chunk_from_point
from bomesh.document_structure import Highlight

_STRUCTURE_VERSION = "0123456789abcdef"
_HIGHLIGHTS = (
    Highlight(page=2, boxes=((0.1, 0.2, 0.9, 0.3),)),
    Highlight(sheet="Data", range="A2:C4"),
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
    )


def _chunk() -> Chunk:
    return Chunk(
        id="jira::BANK-42:0",
        item_id="jira::BANK-42",
        chunk_index=0,
        chunk_text="connector evidence",
        content_type="mixed",
        section_path=["Replication"],
        refs=("texts/0", "tables/0"),
        quote="connector evidence",
        location="Replication",
        highlights=_HIGHLIGHTS,
    )


def _context() -> IndexingContext:
    return IndexingContext(
        tenant_id="tenant-1",
        collection_item_id="collection-1",
        connector_key="jira",
        revision_number=1,
        structure_version=_STRUCTURE_VERSION,
    )


async def _contextualize(
    chunks: list[Chunk],
    item: DocumentItem,
    *,
    semantic_contextualizer: ChunkContextGenerator | None = None,
    classification: ClassificationRequest | None = None,
    progress: IndexProgress | None = None,
    known_contexts: dict[str, str] | None = None,
) -> tuple[list[ContextualChunk], DocumentClassification | None]:
    return await build_contextual_chunks(
        chunks,
        item,
        revision_number=1,
        structure_version=_STRUCTURE_VERSION,
        semantic_contextualizer=semantic_contextualizer,
        classification=classification,
        progress=progress,
        known_contexts=known_contexts,
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
        revision_number=1,
        structure_version=_STRUCTURE_VERSION,
    )

    assert context.tenant_id == "tenant-1"
    assert context.collection_item_id == "collection-1"
    assert context.parent_item_id is None
    assert context.connector_key == "file"


@pytest.mark.asyncio
async def test_index_projection_is_bounded_and_collection_scoped() -> None:
    document = _document()
    source_chunk = _chunk()
    contextual, classified = await _contextualize([source_chunk], document)
    assert classified is None
    assert len(contextual) == 1
    assert isinstance(contextual[0], ContextualChunk)
    assert contextual[0].chunk_text == source_chunk.chunk_text
    assert contextual[0].refs == ("texts/0", "tables/0")
    assert (contextual[0].revision_number, contextual[0].structure_version) == (1, _STRUCTURE_VERSION)
    backend = _Backend()
    index = ItemIndex(backend=backend, embedder=_Embedder())  # type: ignore[arg-type]
    await index.index_item_content(document, [source_chunk], context=_context())
    record = backend.records[0]
    assert hasattr(record, "payload")
    payload = record.payload
    assert payload.collection_item_id == "collection-1"
    assert payload.connector_key == "jira"
    assert payload.section_path == ["Replication"]
    assert payload.refs == ["texts/0", "tables/0"]
    assert payload.quote == "connector evidence"
    assert payload.location == "Replication"
    assert payload.highlights == _HIGHLIGHTS
    assert payload.revision_number == 1
    assert payload.structure_version == _STRUCTURE_VERSION
    assert payload.schema_version == INDEX_SCHEMA_VERSION == 13
    assert payload.embedding_model == "test-embedding"
    serialized_payload = payload.to_payload()
    assert {
        "integration_connection_id",
        "ingestion_source_id",
        "root_id",
        "context_section_path",
        "context_summary",
        "citation_anchor",
        "page_start",
        "page_end",
    }.isdisjoint(serialized_payload)


@pytest.mark.asyncio
async def test_an_indexed_point_round_trips_to_its_contextual_chunk() -> None:
    backend = _Backend()
    index = ItemIndex(backend=backend, embedder=_Embedder())  # type: ignore[arg-type]
    await index.index_item_content(_document(), [_chunk()], context=_context())
    payload = backend.records[0].payload.to_payload()  # type: ignore[attr-defined]

    restored = _contextual_chunk_from_point(SimpleNamespace(payload=payload, score=0.5))

    assert restored is not None
    assert restored.id == "jira::BANK-42:0"
    assert restored.item_id == "jira::BANK-42"
    assert restored.chunk_text == "connector evidence"
    assert restored.context.section_path == ["Replication"]
    assert restored.refs == ("texts/0", "tables/0")
    assert (restored.quote, restored.location, restored.highlights) == (
        "connector evidence",
        "Replication",
        _HIGHLIGHTS,
    )
    assert (restored.revision_number, restored.structure_version) == (1, _STRUCTURE_VERSION)
    assert restored.collection_item_id == "collection-1"
    assert restored.relevance_score == 0.5


@pytest.mark.asyncio
@pytest.mark.parametrize("missing", ["refs", "revision_number", "structure_version"])
async def test_a_point_without_its_structured_document_anchor_is_not_evidence(missing: str) -> None:
    backend = _Backend()
    index = ItemIndex(backend=backend, embedder=_Embedder())  # type: ignore[arg-type]
    await index.index_item_content(_document(), [_chunk()], context=_context())
    payload = backend.records[0].payload.to_payload()  # type: ignore[attr-defined]
    del payload[missing]

    assert _contextual_chunk_from_point(SimpleNamespace(payload=payload)) is None


@pytest.mark.asyncio
async def test_a_point_with_a_malformed_structure_version_is_not_evidence() -> None:
    backend = _Backend()
    index = ItemIndex(backend=backend, embedder=_Embedder())  # type: ignore[arg-type]
    await index.index_item_content(_document(), [_chunk()], context=_context())
    payload = backend.records[0].payload.to_payload()  # type: ignore[attr-defined]

    assert _contextual_chunk_from_point(SimpleNamespace(payload={**payload, "structure_version": "v1"})) is None


@pytest.mark.asyncio
async def test_qdrant_point_ids_are_deterministic() -> None:
    backend = _Backend()
    index = ItemIndex(backend=backend, embedder=_Embedder())  # type: ignore[arg-type]
    await index.index_item_content(_document(), [_chunk()], context=_context())
    first_id = backend.records[0].point_id
    await index.index_item_content(_document(), [_chunk()], context=_context())
    assert backend.records[0].point_id == first_id


@pytest.mark.asyncio
async def test_a_document_of_many_chunks_is_written_in_requests_qdrant_accepts() -> None:
    # Qdrant refuses a request body over 32 MiB: about 950 points of 1536-float vectors.
    from bomesh.document_index._qdrant import _QdrantBackend

    sent: list[list[int]] = []

    class _Client:
        async def upsert(self, *, collection_name: str, points: list[int]) -> None:
            sent.append(points)

    backend = _QdrantBackend(client=_Client(), collection_name="bomesh")

    await backend.upsert_points(list(range(1176)))

    assert [len(batch) for batch in sent] == [256, 256, 256, 256, 152]
    assert [point for batch in sent for point in batch] == list(range(1176))


def test_public_access_is_explicit() -> None:
    assert AccessPolicy().is_public is False
    assert AccessPolicy.from_reader_ids(["public"]).is_public is True


@pytest.mark.asyncio
async def test_index_boundary_rejects_chunks_from_another_document() -> None:
    with pytest.raises(ValueError, match="belongs to item"):
        await _contextualize(
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

    contextual, _ = await _contextualize(
        sources,
        _document(),
        semantic_contextualizer=contextualizer,  # type: ignore[arg-type]
    )

    [call] = contextualizer.calls
    assert call["title"] == "Story: Lending policy"
    assert call["targets"] == [0, 1, 2]
    assert "Explains the approved lending policy." in str(call["overview"])
    assert [chunk.chunk_text for chunk in contextual] == ["evidence 0", "evidence 1", "evidence 2"]
    assert "Chunk 1 describes the BANK-42 approved lending policy." in contextual[1].contextual_text
    assert contextual[1].contextual_text.endswith("evidence 1")
    assert contextual[1].context.semantic_key


@pytest.mark.asyncio
async def test_semantic_contextualization_failure_uses_structural_fallback() -> None:
    contextualizer = _SemanticContextualizer(fail=True)

    contextual, _ = await _contextualize(
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

    await _contextualize(chunks, _document(), semantic_contextualizer=contextualizer)  # type: ignore[arg-type]

    assert [index for call in contextualizer.calls for index in call["targets"]] == asked


@pytest.mark.asyncio
async def test_long_documents_are_windowed_and_each_window_situated_by_the_opening() -> None:
    contextualizer = _SemanticContextualizer()

    await _contextualize(_many(60), _document(), semantic_contextualizer=contextualizer)  # type: ignore[arg-type]

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
    contextual, _ = await _contextualize(_many(4), _document(), semantic_contextualizer=first)  # type: ignore[arg-type]
    known = {chunk.context.semantic_key: chunk.context.semantic for chunk in contextual}

    again = _SemanticContextualizer()
    changed = [*_many(3), _chunk().model_copy(update={"id": "x", "chunk_index": 3, "chunk_text": "new evidence"})]
    reused, _ = await _contextualize(
        changed, _document(), semantic_contextualizer=again, known_contexts=known  # type: ignore[arg-type]
    )

    # A changed chunk changes its window, so the whole window is written again.
    assert [call["targets"] for call in again.calls] == [[0, 1, 2, 3]]
    unchanged, _ = await _contextualize(
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
    assert "[19 | Replication] evidence 19" in requests[0]["blocks"][0]["text"]
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


_DOMAIN = PromptScheme(
    code="domain",
    name="Domain",
    letter="D",
    version=3,
    min_labels=1,
    max_labels=2,
    has_primary=True,
    concepts=(
        PromptConcept(label="D1", concept_id="c-it", name="IT", path=""),
        PromptConcept(
            label="D2",
            concept_id="c-ai",
            name="AI",
            path="IT",
            definition="Artificial intelligence",
            alt_labels=("Trí tuệ nhân tạo",),
        ),
        PromptConcept(
            label="D3",
            concept_id="c-lending",
            name="Lending",
            path="Finance",
            definition="Credit products",
            scope_note="Not payroll",
            examples=("Retail lending policy",),
        ),
    ),
)
_AUDIENCE = PromptScheme(
    code="audience",
    name="Audience",
    letter="A",
    version=1,
    min_labels=0,
    max_labels=None,
    has_primary=False,
    concepts=(
        PromptConcept(label="A1", concept_id="c-students", name="Students", path=""),
        PromptConcept(label="A2", concept_id="c-staff", name="Staff", path=""),
    ),
)
_SHORTLIST = (
    PromptCandidate(label="D3", scores=(("lexical", 0.82), ("card", 0.71), ("knn", 0.0)), score=0.8),
    PromptCandidate(label="D2", scores=(("knn", 0.4),), score=0.3),
)
_REQUEST = ClassificationRequest(
    schemes=(_DOMAIN, _AUDIENCE),
    note="Bank policies",
    fingerprint="domain@3;audience@1;facet-1",
    tasks=(
        SchemeTask(scheme="domain", ask=True, shortlist=_SHORTLIST),
        SchemeTask(scheme="audience", ask=True),
    ),
)
_ANSWER = json.dumps(
    {
        "schemes": {
            "domain": {"primary": "D3", "secondary": [], "certainty": "high", "evidence": "loan"},
            "audience": {"none": True, "certainty": "medium"},
        },
        "summary": "The retail lending policy.",
    }
)
_CLASSIFIED = DocumentClassification(
    schemes={
        "domain": SchemeAnswer(labels=("D3",), certainty="high", evidence="loan"),
        "audience": SchemeAnswer(none=True, certainty="medium"),
    },
    summary="The retail lending policy.",
)


def _unsummarized() -> DocumentItem:
    return _document().model_copy(update={"metadata": {}})


def _chunks() -> list[Chunk]:
    return _many(3)


@pytest.mark.asyncio
async def test_classifying_runs_once_before_contextualizing_and_feeds_the_summary() -> None:
    transport = _ProfileTransport(
        '```json\n{"schemes": {"domain": {"primary": "D3", "secondary": ["D1"]},'
        ' "audience": {"none": true}}, "summary": "The retail lending policy."}\n```'
    )
    phases: list[tuple[str, int, int]] = []

    contextual, classified = await _contextualize(
        _chunks(),
        _unsummarized(),
        semantic_contextualizer=SemanticContextualizer(transport, model_name=transport.model),  # type: ignore[arg-type]
        classification=_REQUEST,
        progress=lambda phase, done, total: phases.append((phase, done, total)),
    )

    # D1 is a label of the scheme but not on this document's shortlist: dropped.
    assert classified == DocumentClassification(
        schemes={"domain": SchemeAnswer(labels=("D3",)), "audience": SchemeAnswer(none=True)},
        summary="The retail lending policy.",
        dropped=("D1",),
    )
    [request] = transport.profile_requests
    assert request["model"] == transport.model
    assert request["temperature"] == 0
    assert "Bank policies" in request["input"]
    assert "D3 | Finance › Lending | Credit products | Not payroll | - | Retail lending policy" in request["input"]
    assert "Leading canonical chunk excerpts:" in request["input"]
    assert phases[:3] == [("classifying", 0, 1), ("classifying", 1, 1), ("contextualizing", 0, 3)]
    # The model's summary changes from run to run; windows are not built from it,
    # so their contexts stay reusable. It still situates every chunk's structure.
    assert transport.context_prompts and all("The retail lending policy." not in p for p in transport.context_prompts)
    assert all(chunk.context.summary == "The retail lending policy." for chunk in contextual)


@pytest.mark.asyncio
async def test_every_document_of_a_run_shares_one_cached_prefix_and_has_its_own_part() -> None:
    transport = _ProfileTransport(_ANSWER)
    contextualizer = SemanticContextualizer(transport)  # type: ignore[arg-type]
    settled = replace(
        _REQUEST,
        tasks=(SchemeTask(scheme="domain", settled=("D1",)), SchemeTask(scheme="audience", ask=True)),
        metadata_asks=("number", "issue_date"),
    )

    await contextualizer.classify(document_context="Loans need two approvals.", request=_REQUEST, title="Loan policy")
    await contextualizer.classify(document_context="IT staff onboarding.", request=settled, title="IT handbook")

    first, second = transport.profile_requests
    # The prefix (instructions, note, every scheme) is byte-identical and keyed for
    # sticky routing, so the provider serves it from its cache.
    prefix = first["blocks"][0]["text"]
    assert first["blocks"][0] == second["blocks"][0]
    assert "cache_control" not in first["blocks"][0]
    assert first["prompt_cache_key"] == second["prompt_cache_key"]
    assert "## D — Domain (domain): choose 1..2, one primary" in prefix
    assert "## A — Audience (audience): choose 0 or more" in prefix
    assert "D2 | IT › AI | Artificial intelligence | - | Trí tuệ nhân tạo | -" in prefix
    assert "Loan policy" not in prefix and "lexical 0.82" not in prefix
    # The document part: the shortlist with nonzero scores, "any label", metadata asks.
    one = first["blocks"][1]["text"]
    assert (
        "domain (D): choose only among these candidates\n"
        "D3 Finance › Lending — lexical 0.82, card 0.71\n"
        "D2 IT › AI — knn 0.40\n"
        "audience (A): any label of scheme audience"
    ) in one
    assert '(the scheme code, never its letter): "domain", "audience"</answer_keys>' in one
    assert "<settled_facets>\n(none)\n</settled_facets>" in one
    assert "<metadata_to_find>(none)</metadata_to_find>" in one
    assert "<document_title>Loan policy</document_title>" in one
    two = second["blocks"][1]["text"]
    assert "<settled_facets>\ndomain (D): D1 IT\n</settled_facets>" in two
    assert "domain (D): choose" not in two
    assert "<metadata_to_find>number, issue_date</metadata_to_find>" in two


@pytest.mark.asyncio
async def test_sections_and_metadata_are_asked_in_the_document_part_and_read_back() -> None:
    request = replace(
        _REQUEST,
        sections=(
            SectionExcerpt(label="S1", ref="texts/0", heading="Học phí", text="Mức học phí năm 2025."),
            SectionExcerpt(label="S2", ref="texts/9", heading="Đối tượng", text="Sinh viên khóa 2025."),
        ),
        section_scheme="audience",
        metadata_asks=("number", "issuer"),
    )
    transport = _ProfileTransport(
        json.dumps(
            {
                "schemes": {"domain": {"labels": ["d3"]}, "audience": {"labels": ["A2", "a1", "A2"]}},
                "sections": [
                    {"section": "s2", "labels": ["A1", "D3"]},
                    {"section": "S7", "labels": ["A1"]},
                    {"section": "S1", "labels": []},
                ],
                "metadata": {"number": " 12/QĐ-ĐT ", "issue_date": "2025-08-01", "issuer": 5},
                "summary": "Fees.",
            }
        )
    )

    classified = await SemanticContextualizer(transport).classify(  # type: ignore[arg-type]
        document_context="Fees for students.", request=request, title="Fees"
    )

    document = transport.profile_requests[0]["blocks"][1]["text"]
    assert "Label each section with labels of scheme audience (A):\n\nS1 | Học phí\nMức học phí năm 2025." in document
    assert "<metadata_to_find>number, issuer</metadata_to_find>" in document
    assert classified.schemes == {"domain": SchemeAnswer(labels=("D3",)), "audience": SchemeAnswer(labels=("A2", "A1"))}
    # Section labels: S2 maps to its ref, a label of another scheme and an unknown section are dropped.
    assert classified.sections == {"texts/9": ("A1",)}
    assert classified.dropped == ("D3",)
    # Only asked fields, only text.
    assert classified.metadata == {"number": "12/QĐ-ĐT"}


def test_labels_outside_the_allowed_set_are_dropped_and_a_scheme_is_capped() -> None:
    wide = replace(
        _REQUEST,
        tasks=(
            SchemeTask(scheme="domain", ask=True, shortlist=(*_SHORTLIST, PromptCandidate("D1", (), 0.1))),
            SchemeTask(scheme="audience", ask=True),
        ),
    )
    answer = '{"schemes": {"domain": {"primary": "D2", "secondary": ["D3", "D1", "D9"]}, "audience": {"labels": []}}}'

    classified = classification_prompt(wide).read(wide, answer)

    # The scheme allows two labels: primary first, the rest in order, extras cut.
    assert classified.schemes["domain"] == SchemeAnswer(labels=("D2", "D3"))
    assert classified.schemes["audience"] == SchemeAnswer()
    assert classified.dropped == ("D9",)

    # Settled labels are allowed beside the shortlist.
    settled = replace(
        _REQUEST,
        tasks=(SchemeTask(scheme="domain", ask=True, settled=("D1",), shortlist=_SHORTLIST[:1]),),
    )
    answer = '{"schemes": {"domain": {"primary": "D3", "secondary": ["D1", "D2"]}}}'
    classified = classification_prompt(settled).read(settled, answer)
    assert classified.schemes["domain"].labels == ("D3", "D1")
    assert classified.dropped == ("D2",)

    # Every label dropped but a scheme said none: a usable answer, not a retry.
    answer = '{"schemes": {"domain": {"primary": "D9"}, "audience": {"none": true, "certainty": "HIGH"}}}'
    classified = classification_prompt(_REQUEST).read(_REQUEST, answer)
    assert classified.schemes == {"domain": SchemeAnswer(), "audience": SchemeAnswer(none=True, certainty="high")}
    assert classified.dropped == ("D9",)


def test_a_scheme_keyed_by_its_letter_or_name_is_read_and_an_omitted_one_is_undecided() -> None:
    # Models copy the heading's letter ("## D — Domain (domain)") or name as the key.
    answer = '{"schemes": {"D": {"primary": "D3"}, "Audience": ["A1"]}}'
    classified = classification_prompt(_REQUEST).read(_REQUEST, answer)
    assert classified.schemes == {"domain": SchemeAnswer(labels=("D3",)), "audience": SchemeAnswer(labels=("A1",))}

    # A scheme left out (often an "any label" one) is undecided, not unreadable: no retry.
    answer = '{"schemes": {"domain": {"primary": "D3", "certainty": "high"}}}'
    classified = classification_prompt(_REQUEST).read(_REQUEST, answer)
    assert classified.schemes == {
        "domain": SchemeAnswer(labels=("D3",), certainty="high"),
        "audience": SchemeAnswer(),
    }


@pytest.mark.parametrize(
    ("title", "expected"),
    [
        ('"\u201cQuy\u1ebft \u0111\u1ecbnh ban h\u00e0nh CT\u0110T K\u1ef9 thu\u1eadt d\u1eef li\u1ec7u 2026.pdf\u201d"', "Quy\u1ebft \u0111\u1ecbnh ban h\u00e0nh CT\u0110T K\u1ef9 thu\u1eadt d\u1eef li\u1ec7u 2026"),
        ('"  .NET  coding   guide. "', ".NET coding guide"),
        ('"  "', None),
        ("42", None),
        (f'"{"x" * 256}"', None),
    ],
)
def test_a_title_is_tidied_and_an_unusable_one_dropped_without_losing_the_labels(
    title: str, expected: str | None
) -> None:
    answer = (
        '{"schemes": {"domain": {"primary": "D3"}, "audience": {"none": true}},'
        f' "summary": "Policy.", "title": {title}}}'
    )

    classified = classification_prompt(_REQUEST).read(_REQUEST, answer)

    assert classified == DocumentClassification(
        schemes={"domain": SchemeAnswer(labels=("D3",)), "audience": SchemeAnswer(none=True)},
        summary="Policy.",
        title=expected,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("first_answer", "problem"),
    [
        ("no json here", "not one JSON object"),
        ('{"schemes": {"lending": {"primary": "D3"}}}', 'use their codes as keys: "domain", "audience"'),
        ('{"schemes": {"domain": {"primary": "D9"}, "audience": {"labels": ["Z1"]}}}', "D9, Z1"),
    ],
)
async def test_an_unreadable_answer_or_one_without_an_allowed_label_is_asked_again_once(
    first_answer: str, problem: str
) -> None:
    transport = _ProfileTransport(first_answer, _ANSWER)

    classified = await SemanticContextualizer(transport).classify(  # type: ignore[arg-type]
        document_context="Loans need two approvals.", request=_REQUEST, title="Loan policy"
    )

    assert classified == _CLASSIFIED
    first, retry = transport.profile_requests
    # The retry keeps the cached prefix and the document, and says what was wrong.
    assert retry["blocks"][:2] == first["blocks"][:2]
    assert problem in retry["blocks"][2]["text"]


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
    assert all(c == _CLASSIFIED for c in classified)


class _Answers:
    """An in-memory classification cache."""

    def __init__(self) -> None:
        self.answers: dict[str, str] = {}

    async def get(self, key: str) -> str | None:
        return self.answers.get(key)

    async def put(self, key: str, answer: str) -> None:
        self.answers[key] = answer


@pytest.mark.asyncio
async def test_an_unchanged_document_and_taxonomy_reuse_the_stored_classification() -> None:
    cache = _Answers()
    transport = _ProfileTransport(_ANSWER)

    async def classify(request: ClassificationRequest = _REQUEST, text: str = "Loans.") -> DocumentClassification:
        return await SemanticContextualizer(transport).classify(  # type: ignore[arg-type]
            document_context=text, request=request, title="Policy", cache=cache
        )

    first = await classify()
    # Processing the same content again: no model call, the same answer.
    assert await classify() == first == _CLASSIFIED
    assert len(transport.profile_requests) == 1
    # Another fingerprint (a scheme version, a rule), another note or another document asks again.
    await classify(replace(_REQUEST, fingerprint="domain@4;audience@1;facet-1"))
    await classify(replace(_REQUEST, note="Bank rules"))
    await classify(text="Loans and payroll.")
    assert len(transport.profile_requests) == 4
    # A stored answer that no longer reads is asked again, then replaced.
    for key in cache.answers:
        cache.answers[key] = "not json"
    assert await classify() == _CLASSIFIED
    assert len(transport.profile_requests) == 5
    assert await classify() == first
    assert len(transport.profile_requests) == 5


@pytest.mark.asyncio
async def test_the_documents_own_summary_wins_over_the_classification_summary() -> None:
    transport = _ProfileTransport(
        '{"schemes": {"domain": {"none": true}, "audience": {"none": true}}, "summary": "Model summary."}'
    )

    contextual, classified = await _contextualize(
        [_chunk()],
        _document(),
        semantic_contextualizer=SemanticContextualizer(transport),  # type: ignore[arg-type]
        classification=_REQUEST,
    )

    assert classified is not None and classified.summary == "Model summary."
    assert contextual[0].context.summary == "Explains the approved lending policy."


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("profile", "calls"),
    [('{"schemes": "domain"}', 2), ("no json here", 2), (RuntimeError("provider down"), 1)],
)
async def test_a_failed_classification_leaves_indexing_unclassified(
    profile: str | Exception, calls: int
) -> None:
    transport = _ProfileTransport(profile)

    contextual, classified = await _contextualize(
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
    ("classification", "contextualized", "expected"),
    [
        (None, True, None),
        # The rules settled every scheme: nothing to ask, an empty answer.
        (replace(_REQUEST, tasks=(SchemeTask(scheme="domain", settled=("D3",)),)), True, DocumentClassification()),
        (_REQUEST, False, None),
    ],
)
async def test_no_model_call_when_nothing_is_asked_or_no_contextualizer(
    classification: ClassificationRequest | None,
    contextualized: bool,
    expected: DocumentClassification | None,
) -> None:
    transport = _ProfileTransport(_ANSWER)
    phases: list[str] = []

    _, classified = await _contextualize(
        [_chunk()],
        _document(),
        semantic_contextualizer=(
            SemanticContextualizer(transport) if contextualized else None  # type: ignore[arg-type]
        ),
        classification=classification,
        progress=lambda phase, *_: phases.append(phase),
    )

    assert classified == expected
    assert transport.profile_requests == []
    assert "classifying" not in phases


@pytest.mark.asyncio
async def test_classify_document_is_step_zero_alone() -> None:
    backend, embedder, transport = _Backend(), _Embedder(), _ProfileTransport(_ANSWER)
    index = ItemIndex(
        backend=backend,  # type: ignore[arg-type]
        embedder=embedder,  # type: ignore[arg-type]
        semantic_contextualizer=SemanticContextualizer(transport),  # type: ignore[arg-type]
    )
    phases: list[tuple[str, int, int]] = []

    classified = await index.classify_document(
        _document(),
        _chunks(),
        classification=_REQUEST,
        progress=lambda phase, done, total: phases.append((phase, done, total)),
    )

    assert classified == _CLASSIFIED
    assert len(transport.profile_requests) == 1
    # No contextualizing, embedding or storing.
    assert transport.context_requests == [] and embedder.embedded == [] and backend.records == []
    assert phases == [("classifying", 0, 1), ("classifying", 1, 1)]


@pytest.mark.asyncio
async def test_a_sample_is_classified_like_a_document() -> None:
    transport = _ProfileTransport(_ANSWER)
    index = ItemIndex(backend=_Backend(), semantic_contextualizer=SemanticContextualizer(transport))  # type: ignore[arg-type]
    settled = replace(_REQUEST, tasks=(SchemeTask(scheme="domain", settled=("D3",)),))

    assert await index.classify_sample(title="Loans", text="Loans.", request=_REQUEST) == _CLASSIFIED
    assert await index.classify_sample(title="Loans", text="Loans.", request=settled) == DocumentClassification()
    assert len(transport.profile_requests) == 1
    unconfigured = ItemIndex(backend=_Backend())  # type: ignore[arg-type]
    assert await unconfigured.classify_sample(title="Loans", text="Loans.", request=_REQUEST) is None
