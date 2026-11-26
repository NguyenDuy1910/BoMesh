"""The services layer: one package per domain, plus the contracts several domains share.

Domain packages (``identity``, ``workspaces``, ``knowledge_items``,
``knowledge_curation``, ``library``, ``ingestion``, ``conversations``,
``artifacts``, ``collaboration``, ``operations``) build on ``kernel``;
``workflow`` and ``agent_runtime`` are shared. Import names from the module
that defines them. This module holds the shared errors, status and version
constants and sandbox state.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal
from uuid import UUID


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
#: transcribed, spreadsheet banner rows lifted out of tables; r3: the parse is
#: stored as the Structured Document, pictures externalized; r4: PDF headings
#: told by font size and nested by it; r5: spreadsheets shaped as a reader
#: sees them: letterheads and notes as text, header bands, row headers, numbers
#: as formatted; r6: .xls read as a workbook, a sparse sheet's cells read once,
#: letterheads touching a table lifted, formula errors and dates; r7: a typed
#: PDF's ruled tables read as tables, cell by cell, with their cells' boxes).
PARSER_VERSION = "docling-2.121-r7"
#: Bumped when chunking changes (v2: chunks never span sheets; a mixed chunk
#: quotes its tables; v3: a table is one line per row, values named by column;
#: v4: a chunk names at most as many blocks as a citation can; v5: a row too
#: long for a chunk is cut between values, each part led by the row's identity;
#: v6: chunks carry the highlights of their blocks in the Original preview; v7: a
#: glyph drawn after its line (a fallback font's) is read in its place there).
CHUNKER_VERSION = "docling-hybrid-line-v7"


def processing_version(
    *,
    parser_version: str,
    chunker_version: str,
    representation_version: int | str,
    embedding_model: str,
    index_schema_version: int | str,
    contextualization_enabled: bool,
    contextualization_model: str | None,
) -> str:
    """Name the processing configuration a Document's index was built with.

    A ready Document whose ``item_index_states.processed_version`` differs from the current
    one is outdated. ``representation_version`` is the preview representation
    the chunks' highlights index. Any data-preserving upgrade script that writes
    ``processed_version`` must use this same format.
    """

    context = (
        contextualization_model
        if contextualization_enabled and contextualization_model
        else "off"
    )
    return (
        f"parser={parser_version};chunker={chunker_version};"
        f"representation={representation_version};"
        f"embedding={embedding_model};schema={index_schema_version};context={context}"
    )


def current_processing_version(signature: Mapping[str, Any]) -> str:
    """The version processing produces now, from ``ItemIndex.current_processing_signature``."""

    from bomesh.services.previews.manifest import REPRESENTATION_VERSION

    return processing_version(
        parser_version=PARSER_VERSION,
        chunker_version=CHUNKER_VERSION,
        representation_version=REPRESENTATION_VERSION,
        embedding_model=str(signature["embedding_model"]),
        index_schema_version=signature["index_schema_version"],
        contextualization_enabled=bool(signature["contextualization_enabled"]),
        contextualization_model=signature.get("contextualization_model"),
    )


ARTIFACT_COLLECTION_TYPE = "conversation_artifacts"
ARTIFACT_COLLECTION_NAME = "My documents"
ARTIFACT_MIME_TYPE = "text/markdown"


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


def timestamp(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


__all__ = [
    "ACTIVE_STATUS",
    "ARTIFACT_COLLECTION_NAME",
    "ARTIFACT_COLLECTION_TYPE",
    "ARTIFACT_MIME_TYPE",
    "ArtifactValidationError",
    "CHUNKER_VERSION",
    "CONNECTION_ACTIVE",
    "CONNECTION_AUTHORIZING",
    "CONNECTION_FAILED",
    "CONNECTION_NEEDS_AUTHORIZATION",
    "CONNECTION_REAUTHORIZATION_REQUIRED",
    "ConnectionAuthorizationRequiredError",
    "DEFAULT_MAX_UPLOAD_BYTES",
    "DEFAULT_PROCESSING_MAX_BYTES",
    "DEFAULT_UPLOAD_URL_SECONDS",
    "DocumentNotFoundError",
    "DocumentProcessingError",
    "DocumentServiceError",
    "DocumentUnavailableError",
    "IdentityConflictError",
    "IdentityNotFoundError",
    "IdentityServiceError",
    "InvalidDocumentStateError",
    "MESSAGE_ITEM_RELATIONS",
    "PARSER_VERSION",
    "current_processing_version",
    "processing_version",
    "SUSPENDED_STATUS",
    "SandboxManifestResource",
    "SandboxMaterializedFile",
    "SandboxSessionState",
    "VerifiedGoogleIdentity",
    "timestamp",
]
