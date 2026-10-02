"""HTTP routers and the request/response models they exchange.

Every handler validates, delegates to a service, and returns. The models live
here so one import gives a router its whole transport contract; application
logic lives in ``bothesis.services``.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Any, Literal, Union
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

# --- Authentication and sessions ---
class AccountCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    username: str | None = Field(default=None, min_length=3, max_length=64)
    display_name: str | None = Field(default=None, max_length=255)


class PasswordSessionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    method: Literal["password"]
    email: EmailStr | None = None
    username: str | None = Field(default=None, min_length=3, max_length=64)
    password: str = Field(min_length=8, max_length=128)

    @model_validator(mode="after")
    def require_one_identifier(self) -> "PasswordSessionCreate":
        if (self.email is None) == (self.username is None):
            raise ValueError("provide exactly one of email or username")
        return self


class GuestSessionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    method: Literal["guest"]


class GoogleSessionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    method: Literal["google"]
    credential: str = Field(min_length=1, max_length=12_000)


CreateSessionRequest = Annotated[
    Union[PasswordSessionCreate, GuestSessionCreate, GoogleSessionCreate],
    Field(discriminator="method"),
]


class CurrentSessionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    active_workspace_id: UUID


class WorkspaceMembership(BaseModel):
    id: UUID
    code: str
    name: str
    role_codes: list[str]
    permissions: list[str]


class AuthSession(BaseModel):
    access_token: str
    token_type: Literal["bearer"]
    expires_at: datetime
    session_id: UUID
    user_id: UUID | None
    email: EmailStr | None = None
    display_name: str | None = None
    active_workspace_id: UUID
    permissions: list[str]
    platform_permissions: list[str]
    session_kind: Literal["user", "guest"]
    workspaces: list[WorkspaceMembership]


class CurrentSession(BaseModel):
    session_id: UUID
    expires_at: datetime
    user_id: UUID | None
    email: EmailStr | None = None
    display_name: str | None = None
    active_workspace_id: UUID
    permissions: list[str]
    platform_permissions: list[str]
    session_kind: Literal["user", "guest"]
    workspaces: list[WorkspaceMembership]


class RoleCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    display_name: str
    permission_codes: list[str] = Field(default_factory=list)


class RoleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: str | None = None
    status: Literal["active", "inactive"] | None = None
    permission_codes: list[str] | None = None


class Role(BaseModel):
    id: UUID
    code: str
    display_name: str
    status: Literal["active", "inactive"]
    permission_codes: list[str]


# --- Agent and chat ---


class ChatHistoryMessage(BaseModel):
    """A prior user or assistant turn retained by the browser conversation store."""

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=8_000)


class ChatRequest(BaseModel):
    """A bounded chat turn submitted by the current WebUI."""

    message: str = Field(min_length=1, max_length=4_000)
    conversation_id: UUID | None = None
    history: list[ChatHistoryMessage] = Field(default_factory=list, max_length=24)
    collection_ids: list[UUID] = Field(default_factory=list, max_length=20)
    # Stable identities for resources attached to this turn. An attachment is
    # processed directly on upload; the agent can read it before that finishes.
    attachment_ids: list[UUID] = Field(default_factory=list, max_length=10)

    @model_validator(mode="after")
    def validate_collection_selection(self) -> ChatRequest:
        if len(self.collection_ids) != len(set(self.collection_ids)):
            raise ValueError("Collection IDs must be unique")
        return self


class DocumentStatus(StrEnum):
    pending_content = "pending_content"
    available = "available"
    failed = "failed"


class IngestionStatus(StrEnum):
    pending = "pending"
    running = "running"
    completed = "completed"
    failed = "failed"
    cancelled = "cancelled"
    timed_out = "timed_out"


IngestionPhase = Literal[
    "queued", "downloading", "parsing", "contextualizing", "embedding", "storing",
    "expanding", "syncing", "completed", "failed", "cancelled",
]
IngestionStatusValue = Literal[
    "pending", "running", "completed", "failed", "cancelled", "timed_out"
]


class IngestionProgress(BaseModel):
    phase: IngestionPhase
    discovered_count: int = Field(default=0, ge=0)
    processed_count: int = Field(default=0, ge=0)
    indexed_count: int = Field(default=0, ge=0)
    deleted_count: int = Field(default=0, ge=0)
    failed_count: int = Field(default=0, ge=0)


class Ingestion(BaseModel):
    id: UUID
    kind: Literal["document", "source"]
    #: ``managed``: a Temporal ingestion (workspace knowledge, Sources);
    #: ``direct``: a user's own upload processed by the API itself.
    mode: Literal["managed", "direct"] = "managed"
    title: str | None = None
    document_id: UUID | None = None
    collection_id: UUID | None = None
    source_id: UUID | None = None
    connection_id: UUID | None = None
    connector_key: str | None = None
    status: IngestionStatusValue
    trigger_type: Literal["manual", "scheduled", "webhook", "initial", "upload", "retry"]
    retry_of_ingestion_id: UUID | None = None
    attempt: int = Field(default=1, ge=1)
    error: str | None = None
    progress: IngestionProgress | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    duration_ms: int | None = Field(default=None, ge=0)
    created_at: datetime
    updated_at: datetime


class IngestionEvent(BaseModel):
    id: str
    type: Literal[
        "queued", "started", "phase", "retrying", "completed", "failed", "cancelled", "timed_out"
    ]
    at: datetime
    attempt: int | None = None
    phase: IngestionPhase | None = None
    message: str | None = None
    duration_ms: int | None = Field(default=None, ge=0)


class IngestionEventList(BaseModel):
    items: list[IngestionEvent]


class IngestionSummaryBucket(BaseModel):
    start: datetime
    started: int = Field(ge=0)
    completed: int = Field(ge=0)
    failed: int = Field(ge=0)


class IngestionDurations(BaseModel):
    p50: int = Field(ge=0)
    p95: int = Field(ge=0)
    max: int = Field(ge=0)


class IngestionSummary(BaseModel):
    window: Literal["1h", "24h", "7d"]
    generated_at: datetime
    bucket_seconds: int = Field(ge=1)
    totals: dict[IngestionStatusValue, int]
    by_kind: dict[Literal["document", "source"], int]
    buckets: list[IngestionSummaryBucket]
    duration_ms: IngestionDurations | None = None
    active: int = Field(ge=0)


class Document(BaseModel):
    id: UUID
    collection_id: UUID
    name: str = Field(min_length=1, max_length=240)
    content_type: str
    size_bytes: int = Field(ge=0)
    purpose: Literal["knowledge", "conversation_attachment"]
    status: Literal["pending_content", "available", "failed"]
    latest_ingestion: Ingestion | None = None
    created_at: datetime
    updated_at: datetime


class DocumentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=240)
    content_type: str = Field(min_length=1, max_length=160)
    size_bytes: int = Field(ge=1)
    purpose: Literal["knowledge", "conversation_attachment"] = "knowledge"


class DocumentContentInstructions(BaseModel):
    url: str
    method: Literal["PUT"]
    headers: dict[str, str]
    expires_at: datetime


class DocumentCreateResult(BaseModel):
    document: Document
    upload: DocumentContentInstructions | None = None
    ingestion: Ingestion | None = None
    created: bool


class DocumentContentResult(BaseModel):
    document: Document
    ingestion: Ingestion | None = None


class DocumentSearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str = Field(min_length=1, max_length=512)
    top_k: int = Field(default=6, ge=1, le=20)
    collection_ids: list[UUID] = Field(default_factory=list, max_length=20)


class DocumentSearchResult(BaseModel):
    document_id: UUID
    collection_id: UUID
    name: str
    excerpt: str
    score: float
    url: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class DocumentSearchResponse(BaseModel):
    items: list[DocumentSearchResult]
    total: int = Field(ge=0)


class DocumentPage(BaseModel):
    items: list[Document]
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=100)
    total: int = Field(ge=0)


class Collection(BaseModel):
    id: UUID
    title: str
    description: str | None = None
    parent_collection_id: UUID | None = None
    status: Literal["active", "archived"]
    document_count: int = Field(ge=0)
    source_count: int = Field(ge=0)
    created_at: datetime
    updated_at: datetime


class CollectionPage(BaseModel):
    items: list[Collection]
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=100)
    total: int = Field(ge=0)




class CollectionAccess(BaseModel):
    collection_id: UUID
    principal_type: Literal["user", "group"]
    principal_id: UUID
    role: Literal["owner", "editor", "viewer"]
    created_at: datetime
    updated_at: datetime


class CollectionAccessUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["owner", "editor", "viewer"]


class CollectionAccessPage(BaseModel):
    items: list[CollectionAccess]
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=100)
    total: int = Field(ge=0)

# --- Conversation artifacts ---


class ArtifactRevisionView(BaseModel):
    revision: int = Field(ge=1)
    summary: str | None = None
    size_bytes: int = Field(ge=0)
    created_at: str | None = None
    download_url: str | None = None


class ArtifactDetail(BaseModel):
    """One conversation artifact with its current revision and history."""

    id: str
    title: str
    file_name: str
    mime_type: str
    size_bytes: int = Field(ge=0)
    revision: int = Field(ge=1)
    revision_count: int = Field(ge=1)
    conversation_id: str | None = None
    source_document_id: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    download_url: str | None = None
    revisions: list[ArtifactRevisionView]


class ArtifactContent(BaseModel):
    artifact_id: str
    revision: int = Field(ge=1)
    mime_type: str
    content: str
    truncated: bool = False


class ArtifactPublishRequest(BaseModel):
    collection_id: UUID
    title: str | None = Field(default=None, min_length=1, max_length=200)


class ArtifactPublishResponse(BaseModel):
    artifact_id: str
    revision: int = Field(ge=1)
    item_id: str
    collection_id: str
    title: str
    status: str
    created: bool


class KnowledgeHomeResponse(BaseModel):
    collections: list[Collection]
    recent_documents: list[Document]
    personal_collection_id: UUID | None = None


# --- Workspace, IAM, and governance ---


class StrictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class UserCreate(StrictRequest):
    email: EmailStr
    display_name: str | None = Field(default=None, min_length=1, max_length=255)
    role_ids: list[UUID] = Field(default_factory=list)
    group_ids: list[UUID] = Field(default_factory=list)


class UserUpdate(StrictRequest):
    display_name: str | None = Field(default=None, min_length=1, max_length=255)
    role_ids: list[UUID] | None = None
    status: bool | None = None
    group_ids: list[UUID] | None = None


class GroupCreate(StrictRequest):
    code: str = Field(min_length=1, max_length=64)
    display_name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, min_length=1, max_length=2_000)


class GroupUpdate(StrictRequest):
    display_name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, min_length=1, max_length=2_000)
    status: Literal["active", "inactive"] | None = None


class GroupMembersUpdate(StrictRequest):
    user_ids: list[UUID]


class ApprovalRequestCreate(StrictRequest):
    request_type: Literal["resource_access", "plugin_installation"]
    target_id: str = Field(min_length=1, max_length=512)
    details: dict[str, Any] = Field(default_factory=dict)
    reason: str | None = Field(default=None, min_length=1, max_length=4_000)


class ApprovalRequestUpdate(StrictRequest):
    status: Literal["approved", "denied", "cancelled"]
    decision_note: str | None = Field(default=None, min_length=1, max_length=4_000)


class CollectionCreate(StrictRequest):
    title: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=2_000)
    parent_collection_id: UUID | None = None
    inherit_access: bool = True


class CollectionUpdate(StrictRequest):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=2_000)
    status: Literal["active", "archived"] | None = None


# Contract-first integration and IAM DTOs. These names mirror OpenAPI schemas;
# service payloads are mapped at router boundaries.
class PageFields(BaseModel):
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=100)
    total: int = Field(ge=0)


class ConnectionAccount(BaseModel):
    """Whose account a connection uses; never its secret or provider id."""

    label: str | None = None
    resource_label: str | None = None


class Connection(BaseModel):
    id: UUID
    connector_key: str
    display_name: str
    owner_type: Literal["user", "workspace"]
    owner_user_id: UUID | None = None
    status: Literal["draft", "connected", "expired", "reauth_required", "revoked", "error", "disconnected"]
    source_count: int = Field(ge=0)
    config: dict[str, Any] = Field(default_factory=dict)
    account: ConnectionAccount = Field(default_factory=ConnectionAccount)
    # `GET /connections/{id}/resources` can list what this connection reaches.
    browsable: bool = False
    status_detail: str | None = None
    connected_at: datetime | None = None
    last_checked_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class ConnectionPage(PageFields):
    items: list[Connection]


class ConnectionCreate(StrictRequest):
    connector_key: str
    display_name: str
    owner_type: Literal["user", "workspace"] = "workspace"
    config: dict[str, Any] = Field(default_factory=dict)
    credentials: dict[str, Any] | None = Field(default=None, repr=False)


class ConnectionUpdate(StrictRequest):
    display_name: str | None = None
    status: Literal["disconnected"] | None = None
    config: dict[str, Any] | None = None
    credentials: dict[str, Any] | None = Field(default=None, repr=False)


class ConnectionAuthorizationCreate(StrictRequest):
    connector_key: str
    owner_type: Literal["user", "workspace"]
    connection_id: UUID | None = None


class ConnectionAuthorization(BaseModel):
    authorization_url: str
    nonce: str


class ConnectionValidation(BaseModel):
    valid: bool
    status: str


class ProviderCatalog(BaseModel):
    items: list[dict[str, Any]]


class ProviderResourcePage(BaseModel):
    items: list[dict[str, Any]]


class Source(BaseModel):
    id: UUID
    connection_id: UUID
    collection_id: UUID
    sync_mode: Literal["manual", "scheduled"]
    status: Literal["ready", "paused", "failed", "connection_required", "disabled"]
    display_name: str | None = None
    resource_type: str | None = None
    external_resource_id: str | None = None
    schedule: "Schedule | None" = None


class SourceCreate(StrictRequest):
    collection_id: UUID
    display_name: str | None = None
    resource_type: str | None = None
    external_resource_id: str | None = None
    config: dict[str, Any] = Field(default_factory=dict)
    schedule: "SchedulePut | None" = None


class SourceUpdate(StrictRequest):
    display_name: str | None = None
    status: Literal["ready", "paused", "disabled"] | None = None
    config: dict[str, Any] | None = None


class SourcePage(PageFields):
    items: list[Source]


class SourceStatus(BaseModel):
    source_id: UUID
    source_status: str
    connection_status: str
    latest_ingestion: Ingestion | None = None


class SchedulePut(StrictRequest):
    schedule_type: Literal["cron", "interval"]
    cron_expression: str
    timezone: str | None = None
    enabled: bool
    overlap_policy: Literal["skip", "queue", "replace"]


class SchedulePatch(StrictRequest):
    cron_expression: str | None = None
    timezone: str | None = None
    enabled: bool | None = None
    overlap_policy: Literal["skip", "queue", "replace"] | None = None


class Schedule(BaseModel):
    id: UUID
    schedule_type: Literal["cron", "interval"]
    cron_expression: str
    timezone: str | None = None
    enabled: bool
    overlap_policy: Literal["skip", "queue", "replace"]
    next_run_at: datetime | None = None
    last_run_at: datetime | None = None


class IngestionPage(PageFields):
    items: list[Ingestion]


class Workspace(BaseModel):
    id: UUID
    code: str
    name: str
    status: Literal["active", "inactive", "suspended"]
    visibility: str | None = None
    settings: dict[str, Any] = Field(default_factory=dict)


class WorkspacePage(PageFields):
    items: list[Workspace]


class WorkspaceUpdate(StrictRequest):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    settings: dict[str, Any] | None = None


class WorkspaceOverview(BaseModel):
    workspace: Workspace
    metrics: dict[str, int] = Field(default_factory=dict)
    attention: dict[str, int] = Field(default_factory=dict)
    recent_activity: list[dict[str, Any]] = Field(default_factory=list)
    generated_at: datetime


class User(BaseModel):
    id: UUID
    email: EmailStr
    display_name: str | None = None
    status: Literal["active", "inactive", "suspended"]
    roles: list[dict[str, Any]] = Field(default_factory=list)
    groups: list[dict[str, Any]] = Field(default_factory=list)


class UserPage(PageFields):
    items: list[User]


class RolePage(PageFields):
    items: list[Role]


class Group(BaseModel):
    id: UUID
    code: str
    display_name: str
    description: str | None = None
    status: Literal["active", "inactive"]
    member_count: int = Field(ge=0)


class GroupPage(PageFields):
    items: list[Group]


class Permission(BaseModel):
    code: str
    description: str
    scopes: list[str]


class PermissionPage(BaseModel):
    items: list[Permission]
    total: int = Field(ge=0)


class ApprovalRequest(BaseModel):
    id: UUID
    request_type: Literal["resource_access", "plugin_installation"]
    target_id: str
    status: Literal["pending", "approved", "denied", "cancelled"]
    requester: User
    details: dict[str, Any] = Field(default_factory=dict)
    reason: str | None = None
    decision_note: str | None = None
    created_at: datetime


class ApprovalRequestPage(PageFields):
    items: list[ApprovalRequest]


class AuditLog(BaseModel):
    id: UUID
    action: str
    resource_type: str
    resource_id: str | None = None
    outcome: str
    actor: dict[str, Any]
    workspace: dict[str, Any] | None = None
    details: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class AuditLogPage(PageFields):
    items: list[AuditLog]


class PlatformOverview(BaseModel):
    metrics: dict[str, int] = Field(default_factory=dict)
    workspace_health: list[dict[str, Any]] = Field(default_factory=list)


Source.model_rebuild()
SourceCreate.model_rebuild()


__all__ = [
    "StrictRequest",
    "Role",
    "RoleCreate",
    "RoleUpdate",
    "ApprovalRequestCreate",
    "ApprovalRequestUpdate",
    "ArtifactContent",
    "ArtifactDetail",
    "ArtifactPublishRequest",
    "ArtifactPublishResponse",
    "ArtifactRevisionView",
    "ChatHistoryMessage",
    "ChatRequest",
    "CollectionCreate",
    "CollectionUpdate",
    "GroupCreate",
    "GroupMembersUpdate",
    "GroupUpdate",
    "KnowledgeHomeResponse",
    "UserCreate",
    "UserUpdate",
    "Connection",
    "ConnectionPage",
    "ConnectionCreate",
    "ConnectionUpdate",
    "ConnectionAuthorizationCreate",
    "ConnectionAuthorization",
    "ConnectionValidation",
    "ProviderCatalog",
    "ProviderResourcePage",
    "Source",
    "SourceCreate",
    "SourceUpdate",
    "SourcePage",
    "SourceStatus",
    "SchedulePut",
    "SchedulePatch",
    "Schedule",
    "Ingestion",
    "IngestionEvent",
    "IngestionEventList",
    "IngestionPage",
    "IngestionProgress",
    "IngestionSummary",
    "Workspace",
    "WorkspacePage",
    "WorkspaceUpdate",
    "WorkspaceOverview",
    "User",
    "UserPage",
    "RolePage",
    "Group",
    "GroupPage",
    "Permission",
    "PermissionPage",
    "ApprovalRequest",
    "ApprovalRequestPage",
    "AuditLog",
    "AuditLogPage",
    "PlatformOverview",
]
