"""HTTP routers and the request/response models they exchange.

Every handler validates, delegates to a service, and returns. The models live
here so one import gives a router its whole transport contract; application
logic lives in ``bomesh.services``.
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


class GoogleSessionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    method: Literal["google"]
    credential: str = Field(min_length=1, max_length=12_000)


CreateSessionRequest = Annotated[
    Union[PasswordSessionCreate, GoogleSessionCreate],
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
    user_id: UUID
    email: EmailStr | None = None
    display_name: str | None = None
    active_workspace_id: UUID
    permissions: list[str]
    platform_permissions: list[str]
    workspaces: list[WorkspaceMembership]


class CurrentSession(BaseModel):
    session_id: UUID
    expires_at: datetime
    user_id: UUID
    email: EmailStr | None = None
    display_name: str | None = None
    active_workspace_id: UUID
    permissions: list[str]
    platform_permissions: list[str]
    workspaces: list[WorkspaceMembership]


class RoleCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: str
    permission_codes: list[str] = Field(default_factory=list)
    code: str | None = Field(
        default=None,
        min_length=1,
        max_length=64,
        description="Internal identifier; derived from display_name when omitted.",
    )


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
    tenant_id: UUID | None = None
    scope_type: Literal["platform", "tenant", "collection"]
    is_system: bool
    member_count: int = Field(ge=0)


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


# --- Ingestion runs -----------------------------------------------------------
#: A Document's processing state, as Knowledge shows it. ``outdated`` is a ready
#: Document whose index was built with a processing configuration that has
#: since changed; ``unsupported`` content is kept but never processed.
ProcessingState = Literal["pending", "processing", "ready", "failed", "outdated", "unsupported"]
#: States a run may select Documents by.
RunSelectableState = Literal["pending", "failed", "outdated", "ready"]
IngestionRunStatus = Literal["queued", "running", "completed", "failed", "cancelled"]
IngestionRunItemStatus = Literal["queued", "running", "succeeded", "failed", "skipped", "cancelled"]
IngestionRunTrigger = Literal["manual", "scheduled", "api"]


class DocumentProcessing(BaseModel):
    """Where a Document stands in processing; the detail lives on its latest run."""

    state: ProcessingState
    #: Why the latest run could not process it, written for people.
    error: str | None = None
    #: The latest Ingestion Run that included this Document.
    run_id: UUID | None = None


class IngestionRunCreate(BaseModel):
    """What to process. Selectors narrow each other; at least one is required.

    ``document_ids`` names Documents explicitly (any state, so a re-index is a
    selection). Otherwise the run takes the Documents under ``collection_id``
    (its whole subtree), or of ``source_id``, or of the workspace, whose state
    is in ``states`` (default ``pending`` and ``outdated``).
    """

    model_config = ConfigDict(extra="forbid")

    document_ids: list[UUID] | None = Field(default=None, min_length=1, max_length=1_000)
    collection_id: UUID | None = None
    source_id: UUID | None = None
    states: list[RunSelectableState] | None = Field(default=None, min_length=1)
    #: ``manual`` when a person asked from a BoMesh client; ``api`` otherwise.
    trigger: Literal["manual", "api"] = "api"

    @model_validator(mode="after")
    def _requires_a_selector(self) -> IngestionRunCreate:
        if not (self.document_ids or self.collection_id or self.source_id or self.states):
            raise ValueError("choose documents, a collection, a source, or states to process")
        return self


class IngestionRunScope(BaseModel):
    """The selection a run was created from; its Documents are the run's items."""

    selected_documents: int | None = Field(default=None, ge=0)
    collection_id: UUID | None = None
    source_id: UUID | None = None
    states: list[RunSelectableState] = Field(default_factory=list)
    retry_of_run_id: UUID | None = None


class IngestionRunCounts(BaseModel):
    total: int = Field(ge=0)
    queued: int = Field(default=0, ge=0)
    running: int = Field(default=0, ge=0)
    succeeded: int = Field(default=0, ge=0)
    failed: int = Field(default=0, ge=0)
    skipped: int = Field(default=0, ge=0)
    cancelled: int = Field(default=0, ge=0)


class IngestionRunActor(BaseModel):
    id: UUID
    email: str | None = None
    display_name: str | None = None


class IngestionRun(BaseModel):
    id: UUID
    status: IngestionRunStatus
    trigger: IngestionRunTrigger
    scope: IngestionRunScope
    counts: IngestionRunCounts
    #: Why the run as a whole stopped, written for people.
    error: str | None = None
    created_by: IngestionRunActor | None = None
    #: Processing configuration fixed at creation (models, versions, batching).
    configuration: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    updated_at: datetime


class IngestionRunPage(BaseModel):
    items: list[IngestionRun]
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=100)
    total: int = Field(ge=0)


class IngestionRunPhase(BaseModel):
    phase: Literal["parsing", "contextualizing", "embedding", "storing", "downloading", "expanding"]
    started_at: datetime | None = None
    finished_at: datetime | None = None
    done: int = Field(default=0, ge=0)
    total: int = Field(default=0, ge=0)


class IngestionRunItem(BaseModel):
    document_id: UUID
    name: str
    collection_id: UUID | None = None
    status: IngestionRunItemStatus
    #: The phase it is in, or ended in.
    phase: str | None = None
    error: str | None = None
    chunk_count: int | None = Field(default=None, ge=0)
    phases: list[IngestionRunPhase] = Field(default_factory=list)
    started_at: datetime | None = None
    finished_at: datetime | None = None


class IngestionRunItemPage(BaseModel):
    items: list[IngestionRunItem]
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=100)
    total: int = Field(ge=0)


class Document(BaseModel):
    id: UUID
    collection_id: UUID
    name: str = Field(min_length=1, max_length=240)
    content_type: str
    size_bytes: int = Field(ge=0)
    purpose: Literal["knowledge", "conversation_attachment"]
    status: Literal["pending_content", "available", "failed"]
    processing: DocumentProcessing
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
    created: bool


class DocumentContentResult(BaseModel):
    document: Document


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
    permissions: list[str] = Field(default_factory=list)


class CollectionPage(BaseModel):
    items: list[Collection]
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=100)
    total: int = Field(ge=0)




class CollectionAccess(BaseModel):
    collection_id: UUID
    principal_type: Literal["user", "group"]
    principal_id: UUID
    #: Who it is, as people recognize them: a group's name, or a member's
    #: display name (their email when they have none).
    principal_name: str | None = None
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
    # The document viewer's preview of a binary revision; see document_viewer.md.
    preview: dict[str, Any] | None = None


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


class MemberAdd(StrictRequest):
    """Add an existing account to the workspace; identities are never created here."""

    email: EmailStr
    role_ids: list[UUID] = Field(default_factory=list)
    group_ids: list[UUID] = Field(default_factory=list)


class Account(BaseModel):
    id: UUID
    email: str
    display_name: str | None = None
    status: Literal["active", "disabled"]
    #: The account's standing in the caller's workspace.
    workspace_membership: Literal["none", "active", "suspended"]


class AccountPage(BaseModel):
    items: list[Account]
    total: int


class UserUpdate(StrictRequest):
    display_name: str | None = Field(default=None, min_length=1, max_length=255)
    role_ids: list[UUID] | None = None
    #: Workspace standing. ``inactive`` is the account's own state and is not
    #: a workspace's to set.
    status: Literal["active", "suspended"] | None = None
    group_ids: list[UUID] | None = None


class GroupCreate(StrictRequest):
    display_name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, min_length=1, max_length=2_000)
    code: str | None = Field(
        default=None,
        min_length=1,
        max_length=64,
        description="Internal identifier; derived from display_name when omitted.",
    )


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


class SourceSync(BaseModel):
    """The latest sync: it registers, updates and removes Documents, never processes them."""

    status: Literal["running", "succeeded", "failed"]
    last_synced_at: datetime | None = None
    error: str | None = None
    added: int = Field(default=0, ge=0)
    updated: int = Field(default=0, ge=0)
    removed: int = Field(default=0, ge=0)
    failed: int = Field(default=0, ge=0)


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
    #: ``None`` until the first sync starts.
    sync: SourceSync | None = None
    #: The Source's Documents waiting for processing (pending or outdated).
    pending_documents: int = Field(default=0, ge=0)


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
    settings: dict[str, Any] = Field(default_factory=dict)


class WorkspacePage(PageFields):
    items: list[Workspace]


class WorkspaceUpdate(StrictRequest):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    settings: dict[str, Any] | None = None


class KnowledgeHealth(BaseModel):
    """Non-deleted Items; processing counts describe Documents only."""

    collections: int = Field(ge=0)
    documents: int = Field(ge=0)
    ready: int = Field(ge=0)
    processing: int = Field(ge=0)
    pending: int = Field(ge=0)
    failed: int = Field(ge=0)
    outdated: int = Field(ge=0)


class UsageCounts(BaseModel):
    active_users: int = Field(ge=0)
    questions: int = Field(ge=0)
    sign_ins: int = Field(ge=0)


class UsageBucket(UsageCounts):
    start: datetime


class WorkspaceUsage(BaseModel):
    timezone: str
    buckets: list[UsageBucket]
    totals: UsageCounts
    previous: UsageCounts


class WorkspaceOverview(BaseModel):
    workspace: Workspace
    metrics: dict[str, int] = Field(default_factory=dict)
    attention: dict[str, int] = Field(default_factory=dict)
    recent_activity: list[dict[str, Any]] = Field(default_factory=list)
    knowledge: KnowledgeHealth
    usage: WorkspaceUsage
    generated_at: datetime


class ActivityTotals(BaseModel):
    active_users: int = Field(ge=0)
    sign_ins: int = Field(ge=0)
    questions: int = Field(ge=0)
    conversations: int = Field(ge=0)
    changes: int = Field(ge=0)
    failed_changes: int = Field(ge=0)


class ActivityBucket(BaseModel):
    start: datetime
    active_users: int = Field(ge=0)
    sign_ins: int = Field(ge=0)
    questions: int = Field(ge=0)
    changes: int = Field(ge=0)
    failed_changes: int = Field(ge=0)


class SignInMethodCount(BaseModel):
    method: str
    count: int = Field(ge=0)


class ActivityChangeCount(BaseModel):
    action: str
    count: int = Field(ge=0)
    failed: int = Field(ge=0)


class ActivityPerson(BaseModel):
    user_id: UUID
    email: str | None = None
    display_name: str | None = None
    questions: int = Field(ge=0)
    conversations: int = Field(ge=0)
    sign_ins: int = Field(ge=0)
    changes: int = Field(ge=0)
    last_active_at: datetime | None = None


class WorkspaceActivity(BaseModel):
    window: Literal["24h", "7d", "30d"]
    timezone: str
    bucket: Literal["hour", "day"]
    start: datetime
    generated_at: datetime
    totals: ActivityTotals
    previous: ActivityTotals
    live_sessions: int = Field(ge=0)
    buckets: list[ActivityBucket]
    sign_in_methods: list[SignInMethodCount]
    top_changes: list[ActivityChangeCount]
    people: list[ActivityPerson]


class AccessSessionUser(BaseModel):
    id: UUID
    email: str | None = None
    display_name: str | None = None


class AccessSessionRecord(BaseModel):
    id: UUID
    user: AccessSessionUser
    authentication_method: str
    entry: Literal["sign_in", "workspace_switch"]
    status: Literal["active", "expired", "revoked", "superseded"]
    started_at: datetime
    last_seen_at: datetime | None = None
    ended_at: datetime | None = None
    end_reason: str | None = None
    expires_at: datetime
    current: bool


class AccessSessionPage(PageFields):
    items: list[AccessSessionRecord]


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


class GroupMember(BaseModel):
    id: UUID
    email: EmailStr
    display_name: str | None = None
    joined_at: datetime | None = None


class Group(BaseModel):
    id: UUID
    code: str
    display_name: str
    description: str | None = None
    status: Literal["active", "inactive"]
    member_count: int = Field(ge=0)
    members: list[GroupMember] = Field(default_factory=list)


class GroupPage(PageFields):
    items: list[Group]


class Permission(BaseModel):
    code: str
    description: str
    scopes: list[str]


class PermissionPage(BaseModel):
    items: list[Permission]
    total: int = Field(ge=0)


class ApprovalRequester(BaseModel):
    id: UUID
    email: EmailStr
    display_name: str | None = None


class ApprovalRequestedRole(BaseModel):
    id: UUID
    code: str
    display_name: str


class ApprovalRequest(BaseModel):
    id: UUID
    request_type: Literal["resource_access", "plugin_installation"]
    target_id: str
    status: Literal["pending", "approved", "denied", "cancelled"]
    requester: ApprovalRequester
    requested_role: ApprovalRequestedRole | None = None
    details: dict[str, Any] = Field(default_factory=dict)
    reason: str | None = None
    decision_note: str | None = None
    decided_by_user_id: UUID | None = None
    decided_at: datetime | None = None
    created_at: datetime
    updated_at: datetime | None = None


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
    "Account",
    "AccountPage",
    "MemberAdd",
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
    "SourceSync",
    "SchedulePut",
    "SchedulePatch",
    "Schedule",
    "DocumentProcessing",
    "IngestionRun",
    "IngestionRunActor",
    "IngestionRunCounts",
    "IngestionRunCreate",
    "IngestionRunItem",
    "IngestionRunItemPage",
    "IngestionRunPage",
    "IngestionRunPhase",
    "IngestionRunScope",
    "Workspace",
    "WorkspacePage",
    "WorkspaceUpdate",
    "WorkspaceOverview",
    "KnowledgeHealth",
    "UsageCounts",
    "UsageBucket",
    "WorkspaceUsage",
    "WorkspaceActivity",
    "ActivityTotals",
    "ActivityBucket",
    "SignInMethodCount",
    "ActivityChangeCount",
    "ActivityPerson",
    "AccessSessionUser",
    "AccessSessionRecord",
    "AccessSessionPage",
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
