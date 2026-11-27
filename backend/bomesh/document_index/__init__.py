"""Contextualization, embedding, payload projection, and Item indexing."""

from __future__ import annotations

from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol, TypeAlias, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field, field_validator

from bomesh.connector.protocol import (
    Chunk,
    EffectiveAccess,
    Hierarchy,
    SourceIdentity,
)
from bomesh.document_structure import Fingerprint, Highlight

INDEX_SCHEMA_VERSION = 13
DENSE_VECTOR_NAME = "content"
SPARSE_VECTOR_NAME = "content_bm25"
BM25_MODEL = "qdrant/bm25"
BM25_OPTIONS: dict[str, Any] = {
    "tokenizer": "multilingual",
    "stemmer": {"type": "none"},
    "stopwords": {"custom": []},
    "lowercase": True,
    "ascii_folding": False,
}
DEFAULT_HYBRID_CANDIDATE_LIMIT = 20


class IndexingContext(BaseModel):
    """Index-scoped values that are not part of a connector chunk."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    tenant_id: str = Field(min_length=1)
    collection_item_id: str = Field(min_length=1)
    parent_item_id: str | None = None
    connector_key: str = Field(min_length=1)
    #: ``items.is_published``; readers without
    #: ``items.update`` on the collection never get unpublished points.
    published: bool = True
    #: The indexed revision and its Structured Document (``StructureManifest.fingerprint``):
    #: every chunk's block refs point into that document.
    revision_number: int = Field(ge=1)
    structure_version: Fingerprint

    @field_validator(
        "tenant_id",
        "collection_item_id",
        "connector_key",
    )
    @classmethod
    def _strip_required_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("indexing context values must not be blank")
        return value

    @field_validator("parent_item_id")
    @classmethod
    def _strip_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None


#: ``(phase, done, total)`` while one Item is indexed: ``classifying`` (``0/1``
#: then ``1/1``, only when the classification asks the model and a
#: contextualizer is configured), ``contextualizing`` and ``embedding`` count
#: chunks, ``storing`` reports the whole write. It is an observer only; it must
#: not raise or block.
IndexProgress: TypeAlias = Callable[[str, int, int], None]


@dataclass(frozen=True, slots=True)
class PromptConcept:
    """One assignable concept as the shared prompt prefix lists it."""

    #: Short label unique in the request: the scheme's letter and a number (``D12``).
    label: str
    concept_id: str
    #: The preferred label (Vietnamese, else the first).
    name: str
    #: The ancestors' names, ``IT › AI``; ``""`` for a top concept.
    path: str
    definition: str | None = None
    scope_note: str | None = None
    #: Alternative labels in every language; hidden labels are never shown.
    alt_labels: tuple[str, ...] = ()
    examples: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class PromptScheme:
    """One published classification scheme the model may be asked about."""

    code: str
    name: str
    #: Label prefix, unique in the request (``D``, ``F``, ``T``, ``A``).
    letter: str
    version: int
    min_labels: int
    max_labels: int | None
    has_primary: bool
    #: Every assignable concept, in display order.
    concepts: tuple[PromptConcept, ...]


@dataclass(frozen=True, slots=True)
class PromptCandidate:
    """One shortlisted concept of a scheme in the document part, with its signals."""

    label: str
    #: ``(kind, score)`` with kind ``lexical``, ``card``, ``knn`` or ``prior``, score 0..1, nonzero only.
    scores: tuple[tuple[str, float], ...]
    #: The combined score, 0..1.
    score: float


@dataclass(frozen=True, slots=True)
class SchemeTask:
    """One Document's state for one scheme in scope."""

    scheme: str
    #: Labels the rules settled: context for the model, never asked.
    settled: tuple[str, ...] = ()
    #: Whether the model must answer this scheme.
    ask: bool = False
    #: The only labels the model may pick; empty with ``ask``: any label of the scheme.
    shortlist: tuple[PromptCandidate, ...] = ()


@dataclass(frozen=True, slots=True)
class SectionExcerpt:
    """A level-1 section offered for section-level labels."""

    #: ``S1``.. in the prompt.
    label: str
    #: The Structured Document ref stored as ``item_concepts.section_ref``.
    ref: str
    heading: str
    #: The section's first 600 characters.
    text: str


#: Issuance fields the model may be asked for when the rules did not find them.
METADATA_FIELDS = ("number", "issue_date", "effective_date", "issuer", "applies_to")


@dataclass(frozen=True, slots=True)
class ClassificationRequest:
    """CLASSIFYING input for one Document: the shared prefix (every published
    scheme and the run's note, identical for every document of a run) and this
    Document's tasks, sections and metadata asks."""

    schemes: tuple[PromptScheme, ...]
    note: str | None = None
    #: Scheme versions, active rules and classifier version; part of the reuse key.
    fingerprint: str = ""
    tasks: tuple[SchemeTask, ...] = ()
    #: Non-empty only when section-level labels are asked.
    sections: tuple[SectionExcerpt, ...] = ()
    #: The scheme code the section labels belong to.
    section_scheme: str | None = None
    #: The :data:`METADATA_FIELDS` the rules did not find.
    metadata_asks: tuple[str, ...] = ()

    @property
    def needs_model(self) -> bool:
        return any(task.ask for task in self.tasks)


@dataclass(frozen=True, slots=True)
class SchemeAnswer:
    """The model's answer for one asked scheme."""

    #: Allowed labels only, primary first, at most the scheme's ``max_labels``.
    labels: tuple[str, ...] = ()
    #: The model said nothing fits.
    none: bool = False
    #: ``high``, ``medium`` or ``low``.
    certainty: str | None = None
    #: A short quote from the document.
    evidence: str | None = None


@dataclass(frozen=True, slots=True)
class DocumentClassification:
    """What the CLASSIFYING model call answered for one Document."""

    #: By scheme code; every asked scheme, nothing else.
    schemes: Mapping[str, SchemeAnswer] = field(default_factory=dict)
    #: Section ref -> labels of the request's ``section_scheme``.
    sections: Mapping[str, tuple[str, ...]] = field(default_factory=dict)
    #: Answered ``metadata_asks`` as raw strings (dates ``YYYY-MM-DD``).
    metadata: Mapping[str, str] = field(default_factory=dict)
    summary: str | None = None
    title: str | None = None
    #: Labels the model named outside what it was allowed (dropped and logged).
    dropped: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ModelUsage:
    """Tokens one or more model calls used, as the provider reported them."""

    calls: int = 0
    input_tokens: int = 0
    #: Input tokens served from the provider's prompt cache (billed lower).
    cached_tokens: int = 0
    output_tokens: int = 0

    def __add__(self, other: ModelUsage) -> ModelUsage:
        return ModelUsage(
            calls=self.calls + other.calls,
            input_tokens=self.input_tokens + other.input_tokens,
            cached_tokens=self.cached_tokens + other.cached_tokens,
            output_tokens=self.output_tokens + other.output_tokens,
        )


@dataclass(frozen=True, slots=True)
class WindowContexts:
    """The semantic contexts written for one window's requested chunks.

    ``contexts`` maps a requested ``chunk_index`` to its context; a chunk the
    model did not answer for usably is absent (it keeps its structural context).
    """

    contexts: dict[int, str]
    usage: ModelUsage


class ClassificationCache(Protocol):
    """Classification answers already paid for, by reuse key; best effort.

    A key names everything an answer depends on (model, prompt, schemes,
    rules, note, the document's part), so a stored answer is the one the model
    would be asked for again.
    """

    async def get(self, key: str) -> str | None: ...

    async def put(self, key: str, answer: str) -> None: ...


@runtime_checkable
class ChunkContextGenerator(Protocol):
    """Optional semantic context generation used before chunk embedding."""

    @property
    def model_name(self) -> str | None: ...

    async def describe_window(
        self,
        *,
        title: str | None,
        overview: str,
        window: Sequence[Chunk],
        targets: Sequence[int],
    ) -> WindowContexts:
        """Contexts for the ``targets`` (``chunk_index`` values) of one window.

        Every call for the same ``title``, ``overview`` and ``window`` shares
        one prompt prefix, so the provider serves it from its prompt cache;
        only the requested indexes differ.
        """
        ...

    async def classify(
        self,
        *,
        document_context: str,
        request: ClassificationRequest,
        title: str | None = None,
        cache: ClassificationCache | None = None,
    ) -> DocumentClassification:
        """The model's answer for the asked schemes, sections and metadata of
        ``request``; raises when the answer stays unreadable after one retry."""
        ...


class ChunkContext(BaseModel):
    """Structural and optional semantic context attached to an Item chunk."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    section_path: list[str] = Field(default_factory=list)
    summary: str | None = None
    #: The model-written context of this chunk, and the key of everything it was
    #: written from (model, prompt, window, chunk): an unchanged key reuses it.
    semantic: str | None = None
    semantic_key: str | None = None


class ContextualChunk(BaseModel):
    """Storage-neutral indexed Item chunk returned to knowledge retrieval."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(min_length=1)
    item_id: str = Field(min_length=1)
    chunk_index: int = Field(ge=0)
    content_type: str = Field(min_length=1)
    chunk_text: str = Field(min_length=1)
    contextual_text: str = Field(min_length=1)
    context: ChunkContext = Field(default_factory=ChunkContext)
    title: str | None = None
    collection_item_id: str | None = None
    source: SourceIdentity
    hierarchy: Hierarchy
    access: EffectiveAccess
    #: Blocks of the Structured Document ``structure_version`` of revision
    #: ``revision_number`` the chunk was cut from, with what they say.
    refs: tuple[str, ...] = Field(min_length=1)
    quote: str = ""
    location: str = ""
    highlights: tuple[Highlight, ...] = ()
    revision_number: int = Field(ge=1)
    structure_version: Fingerprint
    relevance_score: float | None = None
    rerank_score: float | None = None


from .contextualization import (
    ContextualChunkBuilder,
    build_contextual_chunks,
    classification_context,
    sample_document_context,
)
from .semantic_contextualizer import (
    ClassificationPrompt,
    SemanticContextualizer,
    classification_prompt,
)

class EmbeddingRejectedError(RuntimeError):
    """The embedding provider refused the request itself, not the moment.

    A rejected key, exhausted credit, a forbidden or unknown model, or an
    invalid request fails the same way on every retry; only a configuration
    change by an operator can fix it. Transient failures (timeouts, 408, 429,
    5xx) are not this error.
    """

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(f"embedding provider rejected the request (HTTP {status_code}): {detail}")
        self.status_code = status_code


@runtime_checkable
class EmbeddingService(Protocol):
    """Provider-neutral embedding operations used by document indexing.

    Implementations raise :class:`EmbeddingRejectedError` when the provider
    refuses a request in a way retrying cannot change.
    """

    embedding_model: str

    async def embed_documents(self, documents: list[str]) -> list[list[float]]: ...

    async def embed_query(self, query: str) -> list[float]: ...


@dataclass(frozen=True, slots=True)
class ItemPayloadState:
    """The access fields of one Document's points, re-applied after a move,
    (un)publish or (un)delete (``item_model.md`` §4.10)."""

    collection_item_id: str
    published: bool
    is_deleted: bool

    def to_payload(self) -> dict[str, Any]:
        return {
            "collection_item_id": self.collection_item_id,
            "published": self.published,
            "is_deleted": self.is_deleted,
        }


class ItemContentIndex(Protocol):
    """Read-only, storage-neutral search boundary consumed by knowledge."""

    async def search_item_content(
        self,
        queries: Sequence[str],
        *,
        limit: int,
        tenant_id: str,
        collection_item_ids: tuple[str, ...],
        editable_collection_ids: tuple[str, ...],
        document_item_ids: tuple[str, ...] = (),
        within_item_ids: tuple[str, ...] | None = None,
    ) -> list[ContextualChunk]:
        """Every query's fused candidates: points of ``collection_item_ids``
        that are published, or lie in ``editable_collection_ids``, and every
        point of ``document_item_ids``; ``within_item_ids`` (when not ``None``)
        narrows that scope to those items (``document_item_ids`` widens it). A
        pre-filter only; callers re-check every hit in PostgreSQL."""

    async def get_item_chunks(
        self, *, tenant_id: str, chunks: Mapping[str, Collection[int]]
    ) -> list[ContextualChunk]:
        """The live chunks at the given ``chunk_index`` values of each Item (the
        caller already authorized those Items), per Item in source order."""


from .index import ItemIndex

__all__ = [
    "BM25_MODEL",
    "BM25_OPTIONS",
    "DEFAULT_HYBRID_CANDIDATE_LIMIT",
    "DENSE_VECTOR_NAME",
    "INDEX_SCHEMA_VERSION",
    "METADATA_FIELDS",
    "SPARSE_VECTOR_NAME",
    "ChunkContext",
    "ChunkContextGenerator",
    "ClassificationCache",
    "ClassificationPrompt",
    "ClassificationRequest",
    "ContextualChunk",
    "ContextualChunkBuilder",
    "DocumentClassification",
    "EmbeddingRejectedError",
    "EmbeddingService",
    "IndexProgress",
    "IndexingContext",
    "ItemContentIndex",
    "ItemPayloadState",
    "ItemIndex",
    "ModelUsage",
    "PromptCandidate",
    "PromptConcept",
    "PromptScheme",
    "SchemeAnswer",
    "SchemeTask",
    "SectionExcerpt",
    "SemanticContextualizer",
    "WindowContexts",
    "build_contextual_chunks",
    "classification_context",
    "classification_prompt",
    "sample_document_context",
]
