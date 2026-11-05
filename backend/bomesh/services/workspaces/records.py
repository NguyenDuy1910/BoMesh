"""Typed records the Workspaces services return (never HTTP messages)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from uuid import UUID

from bomesh import etag
from bomesh.db.models import Group, Role, Tenant
from bomesh.errors import InvalidArgument
from bomesh.services.identity.records import user_name
from bomesh.services.kernel.workspaces import workspace_name

#: ``workspaces/{workspace}/members/me``: the caller.
ME = "me"


def member_name(workspace_id: UUID, user_id: UUID) -> str:
    """``workspaces/{workspace}/members/{member}``; the member ID is the user ID."""
    return f"workspaces/{workspace_id}/members/{user_id}"


def parse_member_name(
    name: str, workspace_id: UUID, *, field: str, me: UUID | None = None
) -> UUID:
    """The user ID of a member name of ``workspace_id``.

    ``members/me`` resolves to ``me`` when given. Anything else, including a
    member of another workspace, is INVALID_ARGUMENT on ``field``.
    """
    prefix = f"workspaces/{workspace_id}/members/"
    member = name.removeprefix(prefix) if name.startswith(prefix) else ""
    if member == ME and me is not None:
        return me
    try:
        return UUID(member)
    except ValueError:
        raise InvalidArgument.for_field(
            field, f"'{name}' is not a member of this workspace ({prefix}{{member}})."
        ) from None


def group_name(workspace_id: UUID, code: str) -> str:
    return f"workspaces/{workspace_id}/groups/{code}"


@dataclass(frozen=True, slots=True)
class WorkspaceRecord:
    workspace: Tenant
    member_count: int

    @property
    def name(self) -> str:
        return workspace_name(self.workspace.id)

    @property
    def etag(self) -> str:
        return etag.compute(self.name, self.workspace.updated_at)

    @property
    def ingestion_paused(self) -> bool:
        return self.workspace.ingestion_paused_at is not None


@dataclass(frozen=True, slots=True)
class SpaceType:
    key: str
    display_name: str
    icon: str | None = None
    enabled: bool = True


@dataclass(frozen=True, slots=True)
class Workflow:
    """``key`` is lower snake case (``evidence_review``)."""

    key: str
    enabled: bool


@dataclass(frozen=True, slots=True)
class DocumentType:
    key: str
    display_name: str


@dataclass(frozen=True, slots=True)
class WorkspaceSettings:
    """``WorkspaceSettings``: the module flags and defaults other slices read.

    Every ``*_policy`` and enum value is lower snake case, as stored.
    """

    workspace_id: UUID
    modules: dict[str, bool]
    accent_color: str | None
    space_types: tuple[SpaceType, ...]
    workflows: tuple[Workflow, ...]
    document_types: tuple[DocumentType, ...]
    default_publishing_policy: str
    reverification_seconds: int | None
    etag: str

    @property
    def name(self) -> str:
        return f"{workspace_name(self.workspace_id)}/settings"

    def module_enabled(self, module: str) -> bool:
        return self.modules.get(module, True)


@dataclass(frozen=True, slots=True)
class StarterPrompt:
    """``roles`` are role names; empty means every member."""

    title: str
    prompt: str
    roles: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class AssistantSettings:
    """``WorkspaceAssistant``; product defaults when the workspace saved none."""

    workspace_id: UUID
    instructions: str
    answer_length: str
    web_search: bool
    file_work: bool
    charts: bool
    welcome_message: str
    starter_prompts: tuple[StarterPrompt, ...]
    etag: str

    @property
    def name(self) -> str:
        return f"{workspace_name(self.workspace_id)}/assistant"


@dataclass(frozen=True, slots=True)
class MemberRecord:
    """A workspace member as every slice shows people (``Member``)."""

    workspace_id: UUID
    user_id: UUID
    display_name: str
    email: str
    state: str
    joined_at: datetime | None
    last_active_at: datetime | None
    roles: tuple[str, ...] = ()
    groups: tuple[str, ...] = ()
    personal_collection: str | None = None

    @property
    def name(self) -> str:
        return member_name(self.workspace_id, self.user_id)

    @property
    def user(self) -> str:
        return user_name(self.user_id)


@dataclass(frozen=True, slots=True)
class GroupRecord:
    group: Group
    member_count: int

    @property
    def name(self) -> str:
        return group_name(self.group.tenant_id, self.group.code)

    @property
    def etag(self) -> str:
        return etag.compute(self.name, self.group.updated_at)


@dataclass(frozen=True, slots=True)
class MembershipRecord:
    workspace_id: UUID
    group_code: str
    user_id: UUID
    created_at: datetime

    @property
    def name(self) -> str:
        return f"{group_name(self.workspace_id, self.group_code)}/memberships/{self.user_id}"

    @property
    def member(self) -> str:
        return member_name(self.workspace_id, self.user_id)


@dataclass(frozen=True, slots=True)
class RoleRecord:
    """A custom role (``role.tenant_id`` set) and its live permissions."""

    role: Role
    permissions: tuple[str, ...]
    purge_time: datetime | None = None

    @property
    def name(self) -> str:
        return f"workspaces/{self.role.tenant_id}/roles/{self.role.code}"

    @property
    def etag(self) -> str:
        return etag.compute(self.name, self.role.updated_at)


@dataclass(frozen=True, slots=True)
class AuditBucket:
    start_time: datetime
    category: str
    event_count: int


@dataclass(frozen=True, slots=True)
class IamAnalysisResult:
    resource: str
    roles: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class KnowledgeGapRecord:
    workspace_id: UUID
    gap_key: str
    question: str
    ask_count: int
    last_ask_time: datetime
    reason: str
    state: str
    suggested_collection_id: UUID | None = None

    @property
    def name(self) -> str:
        return f"{workspace_name(self.workspace_id)}/knowledgeGaps/{self.gap_key}"


@dataclass(frozen=True, slots=True)
class AttentionItem:
    kind: str
    count: int
    target: str


@dataclass(frozen=True, slots=True)
class Kpi:
    key: str
    value: float
    previous_value: float | None = None


@dataclass(frozen=True, slots=True)
class DailyUsage:
    date: str
    question_count: int
    active_member_count: int


@dataclass(frozen=True, slots=True)
class WorkspaceOverview:
    workspace_id: UUID
    window: str
    time_zone: str
    attention_items: tuple[AttentionItem, ...]
    kpis: tuple[Kpi, ...]
    daily_usage: tuple[DailyUsage, ...] = field(default_factory=tuple)

    @property
    def name(self) -> str:
        return f"{workspace_name(self.workspace_id)}/overview"


@dataclass(frozen=True, slots=True)
class WorkspaceUsage:
    workspace_id: UUID
    question_count: int
    active_member_count: int
    processed_document_count: int

    @property
    def workspace(self) -> str:
        return workspace_name(self.workspace_id)
