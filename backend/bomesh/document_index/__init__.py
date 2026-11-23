"""Contextualization, embedding, payload projection, and Item indexing."""

from __future__ import annotations

from collections.abc import Callable, Collection, Sequence
from dataclasses import dataclass
from typing import Any, Protocol, TypeAlias, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field, field_validator

from bomesh.connector.protocol import (
    Chunk,
    CitationInfo,
    EffectiveAccess,
    Hierarchy,
    SourceIdentity,
)

INDEX_SCHEMA_VERSION = 11
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
#: then ``1/1``, only when a classification is asked for and a contextualizer is
#: configured), ``contextualizing`` and ``embedding`` count chunks, ``storing``
#: reports the whole write. It is an observer only; it must not raise or block.
IndexProgress: TypeAlias = Callable[[str, int, int], None]


@dataclass(frozen=True, slots=True)
class TopicCandidate:
    """One topic a Document may be classified under (a ``topics`` row) and its signals."""

    id: str
    code: str
    name: str
    description: str | None = None
    #: Display name of the domain the topic belongs to; ``None`` for a domain.
    domain: str | None = None
    keywords: tuple[str, ...] = ()
    synonyms: tuple[str, ...] = ()
    guidance: str | None = None
    #: Titles of the topic's example documents.
    examples: tuple[str, ...] = ()
    #: Rules: Collection Item IDs whose subtree, and source codes whose
    #: documents, get this topic without asking the model.
    rule_collections: tuple[str, ...] = ()
    rule_sources: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ClassificationRequest:
    """CLASSIFYING input: the candidate topics, the run's note and, for one
    document, the candidates its rules settle (then the model is not asked)."""

    candidates: tuple[TopicCandidate, ...]
    note: str | None = None
    settled: tuple[TopicCandidate, ...] = ()

    def for_document(
        self, collection_ids: Collection[str], source: str | None
    ) -> ClassificationRequest:
        """This request for a document in ``collection_ids`` (its ancestors) from
        ``source``: every candidate with a matching rule settles it."""

        settled = tuple(
            candidate
            for candidate in self.candidates
            if any(collection in collection_ids for collection in candidate.rule_collections)
            or (source is not None and source in candidate.rule_sources)
        )
        return ClassificationRequest(self.candidates, self.note, settled)


@dataclass(frozen=True, slots=True)
class DocumentClassification:
    """What CLASSIFYING chose for one Document: the candidates that apply
    (possibly none), a one- or two-sentence summary and a clean title."""

    topics: tuple[TopicCandidate, ...] = ()
    summary: str | None = None
    title: str | None = None


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
    ) -> DocumentClassification: ...


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
    citation: CitationInfo
    relevance_score: float | None = None
    rerank_score: float | None = None


from .contextualization import (
    ContextualChunkBuilder,
    build_contextual_chunks,
    sample_document_context,
)
from .semantic_contextualizer import SemanticContextualizer, classification_prompt

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
    ) -> list[ContextualChunk]:
        """Every query's fused candidates: points of ``collection_item_ids``
        that are published, or lie in ``editable_collection_ids``, and every
        point of ``document_item_ids``. A pre-filter only; callers re-check
        every hit in PostgreSQL."""


from .index import ItemIndex

__all__ = [
    "BM25_MODEL",
    "BM25_OPTIONS",
    "DEFAULT_HYBRID_CANDIDATE_LIMIT",
    "DENSE_VECTOR_NAME",
    "INDEX_SCHEMA_VERSION",
    "SPARSE_VECTOR_NAME",
    "ChunkContext",
    "ChunkContextGenerator",
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
    "SemanticContextualizer",
    "TopicCandidate",
    "build_contextual_chunks",
    "classification_prompt",
    "sample_document_context",
]
