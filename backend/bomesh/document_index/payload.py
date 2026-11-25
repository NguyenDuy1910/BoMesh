"""Flat retrieval projection of connector-produced chunks."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any
from urllib.parse import parse_qs, urlsplit
from uuid import NAMESPACE_URL, uuid5

from pydantic import BaseModel, ConfigDict, Field, field_validator

from bomesh.connector.protocol import (
    Chunk,
    DocumentItem,
    EffectiveAccess,
    Hierarchy,
    SourceIdentity,
    SourceProvider,
)
from bomesh.document_index import (
    INDEX_SCHEMA_VERSION,
    ChunkContext,
    ChunkContextGenerator,
    ClassificationCache,
    ClassificationRequest,
    ContextualChunk,
    DocumentClassification,
    IndexingContext,
    IndexProgress,
    build_contextual_chunks,
)
from bomesh.document_structure import Fingerprint


class _IndexedChunk(BaseModel):
    """Bounded retrieval projection of a :class:`ContextualChunk`.

    The Structured Document, complete access policies, storage objects, and
    arbitrary item metadata remain in their canonical stores and are never
    copied here: a chunk carries only block refs into the Structured Document
    with the quote, location and page read from those blocks.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: int = INDEX_SCHEMA_VERSION
    tenant_id: str = Field(min_length=1)
    is_deleted: bool = False
    published: bool = True

    collection_item_id: str = Field(min_length=1)
    item_id: str = Field(min_length=1)
    chunk_id: str = Field(min_length=1)
    chunk_index: int = Field(ge=0)
    title: str | None = None
    content_type: str = Field(min_length=1)

    chunk_text: str = Field(min_length=1)
    contextual_text: str = Field(min_length=1)
    section_path: list[str] = Field(default_factory=list)
    #: Reuse of derived work when the same content is processed again: the
    #: model-written context and the key of what it was written from, and the
    #: embedding model that produced this point's dense vector.
    semantic_context: str | None = None
    context_key: str | None = None
    embedding_model: str | None = None

    parent_item_id: str | None = None
    ancestor_ids: list[str] = Field(default_factory=list)

    connector_key: str = Field(min_length=1)
    external_id: str = Field(min_length=1)
    source_url: str | None = None

    revision_number: int = Field(ge=1)
    structure_version: Fingerprint
    refs: list[str] = Field(min_length=1)
    quote: str = ""
    location: str = ""
    page: int | None = Field(default=None, ge=1)

    @field_validator("ancestor_ids", "section_path")
    @classmethod
    def _normalise_paths(cls, value: list[str]) -> list[str]:
        return [item.strip() for item in value if item.strip()]

    @classmethod
    def from_contextual_chunk(
        cls,
        chunk: ContextualChunk,
        context: IndexingContext,
        *,
        embedding_model: str | None = None,
    ) -> _IndexedChunk:
        return cls(
            tenant_id=context.tenant_id,
            published=context.published,
            collection_item_id=context.collection_item_id,
            item_id=chunk.item_id,
            chunk_id=chunk.id,
            chunk_index=chunk.chunk_index,
            title=chunk.title,
            content_type=chunk.content_type,
            chunk_text=chunk.chunk_text,
            contextual_text=chunk.contextual_text,
            section_path=_section_path(chunk),
            semantic_context=chunk.context.semantic,
            context_key=chunk.context.semantic_key,
            embedding_model=embedding_model,
            parent_item_id=context.parent_item_id,
            ancestor_ids=chunk.hierarchy.ancestor_ids,
            connector_key=context.connector_key,
            external_id=chunk.source.external_id,
            source_url=_persisted_source_url(chunk.source.url),
            revision_number=chunk.revision_number,
            structure_version=chunk.structure_version,
            refs=list(chunk.refs),
            quote=chunk.quote,
            location=chunk.location,
            page=chunk.page,
        )

    def to_payload(self) -> dict[str, Any]:
        return self.model_dump(mode="json", exclude_none=True)


class _IndexedChunkRecord(BaseModel):
    """Private deterministic point identifier and payload."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    point_id: str = Field(min_length=1)
    payload: _IndexedChunk

    @classmethod
    def from_contextual_chunk(
        cls,
        chunk: ContextualChunk,
        context: IndexingContext,
        *,
        embedding_model: str | None = None,
    ) -> _IndexedChunkRecord:
        return cls(
            point_id=str(
                uuid5(
                    NAMESPACE_URL,
                    f"{context.tenant_id}:{chunk.item_id}:{chunk.chunk_index}",
                )
            ),
            payload=_IndexedChunk.from_contextual_chunk(
                chunk, context, embedding_model=embedding_model
            ),
        )


async def build_index_records(
    chunks: Sequence[Chunk],
    item: DocumentItem,
    context: IndexingContext,
    *,
    semantic_contextualizer: ChunkContextGenerator | None = None,
    classification: ClassificationRequest | None = None,
    progress: IndexProgress | None = None,
    known_contexts: Mapping[str, str] | None = None,
    classification_cache: ClassificationCache | None = None,
    embedding_model: str | None = None,
) -> tuple[list[_IndexedChunkRecord], DocumentClassification | None]:
    """Contextualize canonical chunks and build deterministic index records.

    The classification is returned to the caller, never written to a payload.
    ``known_contexts`` (reuse key → context) come from the Document's previous
    points; ``embedding_model`` is recorded on each point for vector reuse;
    ``classification_cache`` holds the Document's earlier classification answers.
    """

    contextual_chunks, classified = await build_contextual_chunks(
        chunks,
        item,
        revision_number=context.revision_number,
        structure_version=context.structure_version,
        semantic_contextualizer=semantic_contextualizer,
        classification=classification,
        progress=progress,
        known_contexts=known_contexts,
        classification_cache=classification_cache,
    )
    return [
        _IndexedChunkRecord.from_contextual_chunk(
            chunk, context, embedding_model=embedding_model
        )
        for chunk in contextual_chunks
    ], classified


def _contextual_chunk_from_point(point: object) -> ContextualChunk | None:
    """Rebuild one canonical retrieval chunk from an indexed point payload."""

    raw_payload = getattr(point, "payload", None)
    if not isinstance(raw_payload, Mapping):
        return None
    payload = {str(key): value for key, value in raw_payload.items()}
    item_id = _payload_text(payload, "item_id")
    chunk_id = _payload_text(payload, "chunk_id")
    chunk_text = _payload_content(payload, "chunk_text")
    contextual_text = _payload_content(payload, "contextual_text")
    connector_key = _payload_text(payload, "connector_key")
    external_id = _payload_text(payload, "external_id")
    refs = tuple(_payload_strings(payload, "refs"))
    revision_number = _payload_int(payload, "revision_number")
    structure_version = _payload_text(payload, "structure_version")
    if not (
        item_id
        and chunk_id
        and chunk_text
        and contextual_text
        and connector_key
        and external_id
        and refs
        and revision_number
        and structure_version
    ):
        return None
    try:
        provider = SourceProvider(connector_key)
    except ValueError:
        return None

    raw_score = getattr(point, "score", None)
    relevance_score = (
        float(raw_score)
        if isinstance(raw_score, (int, float)) and not isinstance(raw_score, bool)
        else None
    )
    section_path = _payload_strings(payload, "section_path")
    try:
        return ContextualChunk(
            id=chunk_id,
            item_id=item_id,
            chunk_index=_payload_int(payload, "chunk_index", default=0) or 0,
            content_type=_payload_text(payload, "content_type") or "text",
            chunk_text=chunk_text,
            contextual_text=contextual_text,
            context=ChunkContext(section_path=section_path),
            title=_payload_text(payload, "title"),
            collection_item_id=_payload_text(payload, "collection_item_id"),
            source=SourceIdentity(
                connector_id=connector_key,
                provider=provider,
                external_id=external_id,
                url=_payload_text(payload, "source_url"),
            ),
            hierarchy=Hierarchy(
                parent_id=_payload_text(payload, "parent_item_id"),
                ancestor_ids=_payload_strings(payload, "ancestor_ids"),
            ),
            access=EffectiveAccess(),
            refs=refs,
            quote=_payload_content(payload, "quote") or "",
            location=_payload_text(payload, "location") or "",
            page=_payload_int(payload, "page"),
            revision_number=revision_number,
            structure_version=structure_version,
            relevance_score=relevance_score,
        )
    except ValueError:
        # A point another schema wrote (or a damaged one) is not evidence.
        return None


def _section_path(chunk: ContextualChunk) -> list[str]:
    """The chunk's heading path (``Chunk.section_path``, carried by its context)."""

    return list(chunk.context.section_path)


def _persisted_source_url(value: str | None) -> str | None:
    """Keep provider links, but never index a short-lived storage URL."""

    if not value:
        return None
    query_keys = {key.casefold() for key in parse_qs(urlsplit(value).query)}
    provider_signature = query_keys.intersection(
        {
            "x-amz-algorithm",
            "x-amz-credential",
            "x-amz-expires",
            "x-amz-signature",
            "x-amz-date",
            "x-goog-algorithm",
            "x-goog-credential",
            "x-goog-expires",
            "x-goog-signature",
        }
    )
    generic_signature = {"expires", "signature"}.issubset(query_keys)
    azure_signature = {"se", "sig"}.issubset(query_keys)
    if provider_signature or generic_signature or azure_signature:
        return None
    return value


def _payload_text(payload: Mapping[str, object], key: str) -> str | None:
    value = payload.get(key)
    return value.strip() if isinstance(value, str) and value.strip() else None


def _payload_content(payload: Mapping[str, object], key: str) -> str | None:
    """Validate evidence text without changing its bytes-as-text projection."""

    value = payload.get(key)
    return value if isinstance(value, str) and value.strip() else None


def _payload_strings(payload: Mapping[str, object], key: str) -> list[str]:
    value = payload.get(key)
    if not isinstance(value, (list, tuple)):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


def _payload_int(
    payload: Mapping[str, object],
    key: str,
    *,
    default: int | None = None,
) -> int | None:
    value = payload.get(key)
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value)
    return default


__all__ = [
    "build_index_records",
]
