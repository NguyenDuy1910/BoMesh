"""The services layer: one package per domain, plus the contracts several domains share.

Domain packages (``identity``, ``workspaces``, ``knowledge_items``,
``knowledge_curation``, ``library``, ``ingestion``, ``conversations``,
``artifacts``, ``collaboration``, ``operations``) build on ``kernel``;
``workflow`` and ``agent_runtime`` are shared. Import names from the module
that defines them. This module holds the shared errors, status and version
constants, preview manifests and sandbox state.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, Protocol, runtime_checkable
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from bomesh.connector.protocol import Chunk, DocumentItem
from bomesh.db.models import Item

ACTIVE_STATUS = "active"
#: Users and tenant memberships are active or suspended; never inactive.
SUSPENDED_STATUS = "suspended"

#: Connection lifecycle. These describe the *grant*, never a sync run.
CONNECTION_AUTHORIZING = "authorizing"
CONNECTION_ACTIVE = "active"
CONNECTION_REAUTHORIZATION_REQUIRED = "reauthorization_required"
CONNECTION_FAILED = "failed"
#: A connection in any of these states cannot reach the provider until someone
#: authorizes it again.
CONNECTION_NEEDS_AUTHORIZATION = (CONNECTION_REAUTHORIZATION_REQUIRED,)

MESSAGE_ITEM_RELATIONS = frozenset({"attachment", "artifact"})

DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024
DEFAULT_UPLOAD_URL_SECONDS = 600
DEFAULT_PROCESSING_MAX_BYTES = 100 * 1024 * 1024
#: Bumped when parsing output changes for the same file (r2: scanned PDF pages
#: transcribed, spreadsheet banner rows lifted out of tables).
PARSER_VERSION = "docling-2.121-r2"
CHUNKER_VERSION = "docling-hybrid-line-v1"


def processing_version(
    *,
    parser_version: str,
    chunker_version: str,
    embedding_model: str,
    index_schema_version: int | str,
    contextualization_enabled: bool,
    contextualization_model: str | None,
) -> str:
    """Name the processing configuration a Document's index was built with.

    A ready Document whose ``items.processed_version`` differs from the current
    one is outdated. Any data-preserving upgrade script that writes
    ``processed_version`` must use this same format.
    """

    context = (
        contextualization_model
        if contextualization_enabled and contextualization_model
        else "off"
    )
    return (
        f"parser={parser_version};chunker={chunker_version};"
        f"embedding={embedding_model};schema={index_schema_version};context={context}"
    )


def current_processing_version(signature: Mapping[str, Any]) -> str:
    """The version processing produces now, from ``ItemIndex.current_processing_signature``."""

    return processing_version(
        parser_version=PARSER_VERSION,
        chunker_version=CHUNKER_VERSION,
        embedding_model=str(signature["embedding_model"]),
        index_schema_version=signature["index_schema_version"],
        contextualization_enabled=bool(signature["contextualization_enabled"]),
        contextualization_model=signature.get("contextualization_model"),
    )


PREVIEW_SCHEMA_VERSION = 1
PREVIEW_RENDERER_VERSION = "webp-v1"
DEFAULT_PREVIEW_MAX_SOURCE_BYTES = 100 * 1024 * 1024
DEFAULT_PREVIEW_MAX_PAGES = 50
DEFAULT_PREVIEW_MAX_DIMENSION = 1_600
DEFAULT_PREVIEW_WEBP_QUALITY = 80
DOCUMENT_RENDITION_VERSION = "document-v1"
DOCUMENT_RENDITION_CONTENT_TYPE = "application/vnd.bomesh.document+json"

ARTIFACT_COLLECTION_KIND = "conversation_artifacts"
ARTIFACT_COLLECTION_TITLE = "My documents"
ARTIFACT_MIME_TYPE = "text/markdown"

PreviewRepresentation = Literal["original", "image", "pages"]


class IdentityServiceError(Exception):
    """Base exception for identity and authorization failures."""


class IdentityNotFoundError(IdentityServiceError):
    """Raised when a requested user, tenant, role, or connector does not exist."""


class IdentityConflictError(IdentityServiceError):
    """Raised when a unique identity or membership already exists."""


class ConnectionAuthorizationRequiredError(Exception):
    """Raised when a Connection's grant is gone and someone must reconnect.

    Distinct from a validation failure: nothing about the request is wrong, and
    no retry helps until a person completes the provider's flow again.

    It carries the state it implies, because raising this rolls back the
    transaction that discovered it — the caller has to write the state down in
    a transaction of its own, or the next request would rediscover the same
    failure and the UI would never learn to offer a reconnect.
    """

    def __init__(
        self,
        message: str,
        *,
        status: str = CONNECTION_REAUTHORIZATION_REQUIRED,
        detail: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.detail = detail or message


@dataclass(frozen=True, slots=True)
class VerifiedGoogleIdentity:
    """Identity emitted only by an OAuth verifier after email verification."""

    issuer: str
    subject: str
    email: str
    display_name: str | None


SandboxSessionStatus = Literal["active", "expired", "closed"]


@dataclass(frozen=True, slots=True)
class SandboxManifestResource:
    """A durable, provider-neutral input selected for one sandbox workspace."""

    resource_id: str
    name: str
    mime_type: str
    size_bytes: int | None = None

    def __post_init__(self) -> None:
        if not all(value.strip() for value in (self.resource_id, self.name, self.mime_type)):
            raise ValueError("sandbox manifest resource fields must not be blank")
        if self.size_bytes is not None and self.size_bytes < 0:
            raise ValueError("sandbox manifest resource size must not be negative")


@dataclass(frozen=True, slots=True)
class SandboxMaterializedFile:
    """A home-relative sandbox file copied from one durable resource."""

    path: str
    resource_id: str

    def __post_init__(self) -> None:
        if not self.path.strip() or not self.resource_id.strip():
            raise ValueError("sandbox materialized file fields must not be blank")


@dataclass(frozen=True, slots=True)
class SandboxSessionState:
    """Recovery state for one tenant-scoped conversation sandbox."""

    id: UUID
    provider: str
    status: SandboxSessionStatus
    manifest: tuple[SandboxManifestResource, ...] = ()
    # The sandbox container bound to this session; opaque to clients and model.
    container_id: str | None = None
    materialized_files: tuple[SandboxMaterializedFile, ...] = ()

    def __post_init__(self) -> None:
        if not self.provider.strip():
            raise ValueError("sandbox provider must not be blank")
        if self.status not in {"active", "expired", "closed"}:
            raise ValueError("sandbox session status is invalid")
        if self.container_id is not None and not self.container_id.strip():
            raise ValueError("sandbox container id must not be blank")


@dataclass(frozen=True, slots=True)
class CanonicalDocumentContent:
    """Canonical source item and chunks produced for one stored document."""

    item: DocumentItem
    chunks: tuple[Chunk, ...]


@runtime_checkable
class StoredFileContent(Protocol):
    """Raw-source boundary: a Document's stored original as canonical content."""

    async def canonicalize(self, document: Item) -> CanonicalDocumentContent: ...

    async def image_data_url(self, document: Item) -> str: ...


class DocumentServiceError(Exception):
    """Base exception for durable document service failures."""


class DocumentNotFoundError(DocumentServiceError):
    """Raised for missing and inaccessible documents to prevent enumeration."""


class InvalidDocumentStateError(DocumentServiceError):
    """Raised when a lifecycle or lineage transition is invalid."""


class DocumentProcessingError(RuntimeError):
    """Raised when an Item's durable source cannot be prepared for indexing."""


class DocumentUnavailableError(DocumentProcessingError):
    """Raised when an authorized Item's durable source is unavailable."""


class ArtifactValidationError(DocumentServiceError):
    """Raised when an artifact request or state transition is invalid."""


class PreviewGenerationError(RuntimeError):
    """Raised when a supported source cannot produce a valid preview."""


@dataclass(frozen=True, slots=True)
class RenderedPreviewAsset:
    """An in-memory WebP rendition awaiting durable storage."""

    data: bytes
    content_type: str
    width: int
    height: int
    page: int | None = None


@dataclass(frozen=True, slots=True)
class RenderedPreview:
    """Bounded preview assets produced from one original source."""

    representation: PreviewRepresentation
    assets: tuple[RenderedPreviewAsset, ...] = ()
    page_count: int | None = None
    truncated: bool = False


class PreviewAsset(BaseModel):
    """Durable metadata for one derived presentation object."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    key: str = Field(min_length=1)
    content_type: str = Field(min_length=1)
    size_bytes: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    page: int | None = Field(default=None, ge=1)


class PreviewRendition(BaseModel):
    """Durable metadata for the whole-document rendition of one original."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    key: str = Field(min_length=1)
    size_bytes: int = Field(ge=0)
    version: str = Field(min_length=1)
    block_count: int = Field(ge=0)
    truncated: bool = False


class PreviewManifest(BaseModel):
    """Versioned internal record of renditions derived from one original."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: int = PREVIEW_SCHEMA_VERSION
    renderer_version: str = PREVIEW_RENDERER_VERSION
    source_version: str = Field(min_length=1)
    representation: PreviewRepresentation
    assets: tuple[PreviewAsset, ...] = ()
    page_count: int | None = Field(default=None, ge=1)
    truncated: bool = False
    rendition: PreviewRendition | None = None

    @model_validator(mode="after")
    def _validate_assets(self) -> PreviewManifest:
        pages = [asset.page for asset in self.assets if asset.page is not None]
        if len(pages) != len(set(pages)):
            raise ValueError("preview asset pages must be unique")
        if self.representation == "original" and self.assets:
            raise ValueError("original previews cannot contain derived assets")
        if self.representation != "original" and not self.assets:
            raise ValueError("derived previews require at least one asset")
        if self.page_count is not None and any(
            page > self.page_count for page in pages
        ):
            raise ValueError("preview asset page exceeds the source page count")
        return self


class PreviewOriginal(BaseModel):
    """Permission-checked access to the authoritative source object."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    url: str
    file_name: str
    content_type: str
    size_bytes: int = Field(ge=0)


class ResolvedPreviewAsset(BaseModel):
    """Short-lived, client-facing access to one derived rendition."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    url: str
    content_type: str
    size_bytes: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    page: int | None = Field(default=None, ge=1)


class ResolvedRendition(BaseModel):
    """Short-lived, client-facing access to the whole-document rendition."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    url: str
    version: str
    size_bytes: int = Field(ge=0)
    block_count: int = Field(ge=0)
    truncated: bool = False


class KnowledgePreviewView(BaseModel):
    """Consistent UX representation for an authorized knowledge asset.

    Citation spans use the same one-based ``page`` values as assets and
    normalized top-left bounding boxes, allowing the UI to highlight a cited
    region without adding presentation data to chunks or the vector index.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    representation: PreviewRepresentation
    original: PreviewOriginal
    assets: tuple[ResolvedPreviewAsset, ...] = ()
    page_count: int | None = Field(default=None, ge=1)
    truncated: bool = False
    rendition: ResolvedRendition | None = None
    coordinate_space: Literal["normalized_top_left"] = "normalized_top_left"


def timestamp(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


__all__ = [
    "ACTIVE_STATUS",
    "ARTIFACT_COLLECTION_KIND",
    "ARTIFACT_COLLECTION_TITLE",
    "ARTIFACT_MIME_TYPE",
    "ArtifactValidationError",
    "CHUNKER_VERSION",
    "CONNECTION_ACTIVE",
    "CONNECTION_AUTHORIZING",
    "CONNECTION_FAILED",
    "CONNECTION_NEEDS_AUTHORIZATION",
    "CONNECTION_REAUTHORIZATION_REQUIRED",
    "CanonicalDocumentContent",
    "ConnectionAuthorizationRequiredError",
    "DEFAULT_MAX_UPLOAD_BYTES",
    "DEFAULT_PREVIEW_MAX_DIMENSION",
    "DEFAULT_PREVIEW_MAX_PAGES",
    "DEFAULT_PREVIEW_MAX_SOURCE_BYTES",
    "DEFAULT_PREVIEW_WEBP_QUALITY",
    "DEFAULT_PROCESSING_MAX_BYTES",
    "DEFAULT_UPLOAD_URL_SECONDS",
    "DOCUMENT_RENDITION_CONTENT_TYPE",
    "DOCUMENT_RENDITION_VERSION",
    "DocumentNotFoundError",
    "DocumentProcessingError",
    "DocumentServiceError",
    "DocumentUnavailableError",
    "IdentityConflictError",
    "IdentityNotFoundError",
    "IdentityServiceError",
    "InvalidDocumentStateError",
    "KnowledgePreviewView",
    "MESSAGE_ITEM_RELATIONS",
    "PARSER_VERSION",
    "current_processing_version",
    "processing_version",
    "PREVIEW_RENDERER_VERSION",
    "PREVIEW_SCHEMA_VERSION",
    "PreviewAsset",
    "PreviewGenerationError",
    "PreviewManifest",
    "PreviewRendition",
    "PreviewOriginal",
    "PreviewRepresentation",
    "RenderedPreview",
    "RenderedPreviewAsset",
    "ResolvedPreviewAsset",
    "ResolvedRendition",
    "SUSPENDED_STATUS",
    "SandboxManifestResource",
    "SandboxMaterializedFile",
    "SandboxSessionState",
    "StoredFileContent",
    "VerifiedGoogleIdentity",
    "timestamp",
]
