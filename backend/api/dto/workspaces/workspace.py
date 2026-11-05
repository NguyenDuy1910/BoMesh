"""Workspace, WorkspaceSettings, WorkspaceAssistant, WorkspaceOverview and usage messages."""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any, Literal

from pydantic import Field
from sqlalchemy import func

from api.aip import filtering
from api.aip.fieldmask import MutableFields
from api.aip.filtering import FilterSchema
from api.aip.messages import Int64, ProtoMessage, Timestamp
from api.aip.ordering import OrderSchema
from api.dto.operations import register_response_message
from bomesh.db.models import Tenant
from bomesh.db.models.workspaces import TENANT_STATUSES, TENANT_TEMPLATES
from bomesh.errors import InvalidArgument
from bomesh.services.workspaces.records import (
    AssistantSettings,
    DocumentType,
    SpaceType,
    StarterPrompt,
    Workflow,
    WorkspaceOverview,
    WorkspaceRecord,
    WorkspaceSettings,
    WorkspaceUsage,
)

UsageWindow = Literal["P1D", "P7D", "P30D"]

# -- Workspace ------------------------------------------------------------------


class WorkspaceMessage(ProtoMessage):
    name: str | None = None
    uid: str | None = None
    display_name: str | None = None
    code: str | None = None
    template: Literal["ENTERPRISE", "CAMPUS"] | None = None
    demo: bool | None = None
    state: Literal["CREATING", "ACTIVE", "SUSPENDED", "ARCHIVED"] | None = None
    ingestion_state: Literal["ACTIVE", "PAUSED"] | None = None
    member_count: int | None = None
    etag: str | None = None
    create_time: Timestamp | None = None
    update_time: Timestamp | None = None
    initial_admin_email: str | None = Field(default=None, json_schema_extra={"writeOnly": True})


class ListWorkspacesResponse(ProtoMessage):
    workspaces: list[WorkspaceMessage]
    next_page_token: str | None = None


class ArchiveWorkspaceRequest(ProtoMessage):
    confirmation_code: str
    etag: str | None = None


class WorkspaceStateRequest(ProtoMessage):
    """Body of ``:suspend``, ``:activate``, ``:pauseIngestion`` and ``:resumeIngestion``."""

    etag: str | None = None


def workspace_message(record: WorkspaceRecord) -> WorkspaceMessage:
    workspace = record.workspace
    return WorkspaceMessage(
        name=record.name,
        uid=str(workspace.id),
        display_name=workspace.name,
        code=workspace.code,
        template=workspace.template.upper(),  # type: ignore[arg-type]
        demo=workspace.demo,
        state=workspace.status.upper(),  # type: ignore[arg-type]
        ingestion_state="PAUSED" if record.ingestion_paused else "ACTIVE",
        member_count=record.member_count,
        etag=record.etag,
        create_time=workspace.created_at,
        update_time=workspace.updated_at,
    )


register_response_message("Workspace", workspace_message)

WORKSPACE_FIELDS = MutableFields(("displayName", "code"))

WORKSPACE_FILTERS = FilterSchema(
    {
        "state": filtering.enum(
            func.upper(Tenant.status), (status.upper() for status in TENANT_STATUSES)
        ),
        "template": filtering.enum(
            func.upper(Tenant.template), (template.upper() for template in TENANT_TEMPLATES)
        ),
        "code": filtering.string(Tenant.code),
    }
)
WORKSPACE_ORDER = OrderSchema(
    {"displayName": Tenant.name, "code": Tenant.code, "createTime": Tenant.created_at},
    tie_breaker=[Tenant.id],
    default="displayName",
)

# -- Settings -------------------------------------------------------------------


class ModulesMessage(ProtoMessage):
    spaces: bool | None = None
    work: bool | None = None
    requests: bool | None = None


class BrandingMessage(ProtoMessage):
    accent_color: Literal["INDIGO", "TEAL", "OCEAN", "PLUM", "GRAPHITE"] | None = None


class SpaceTypeMessage(ProtoMessage):
    key: str = ""
    display_name: str = ""
    icon: str | None = None
    enabled: bool = True


class WorkflowMessage(ProtoMessage):
    key: Literal["EVIDENCE_REVIEW", "DRAFT", "STUDY_GUIDE", "QUIZ"]
    enabled: bool = True


class DocumentTypeMessage(ProtoMessage):
    key: str = ""
    display_name: str = ""


class WorkspaceSettingsMessage(ProtoMessage):
    name: str | None = None
    modules: ModulesMessage | None = None
    branding: BrandingMessage | None = None
    space_types: list[SpaceTypeMessage] | None = None
    workflows: list[WorkflowMessage] | None = None
    document_types: list[DocumentTypeMessage] | None = None
    default_publishing_policy: Literal["AUTO_PUBLISH", "REVIEW_FIRST"] | None = None
    reverification_duration: str | None = Field(default=None, pattern=r"^[0-9]+(\.[0-9]+)?s$")
    etag: str | None = None


SETTINGS_FIELDS = MutableFields(
    (
        "modules.spaces",
        "modules.work",
        "modules.requests",
        "branding.accentColor",
        "spaceTypes",
        "workflows",
        "documentTypes",
        "defaultPublishingPolicy",
        "reverificationDuration",
    )
)


def settings_changes(changes: Mapping[str, Any]) -> dict[str, Any]:
    """Masked message values → the plain values ``SettingsService.update_settings`` takes."""
    result: dict[str, Any] = {}
    for path, value in changes.items():
        match path:
            case "branding.accentColor" | "defaultPublishingPolicy":
                result[path] = value.lower() if value is not None else None
            case "spaceTypes":
                result[path] = (
                    None
                    if value is None
                    else [SpaceType(v.key, v.display_name, v.icon, v.enabled) for v in value]
                )
            case "workflows":
                result[path] = (
                    None if value is None else [Workflow(v.key.lower(), v.enabled) for v in value]
                )
            case "documentTypes":
                result[path] = (
                    None if value is None else [DocumentType(v.key, v.display_name) for v in value]
                )
            case "reverificationDuration":
                result[path] = None if value is None else _seconds(value)
            case _:
                result[path] = value
    return result


def settings_message(settings: WorkspaceSettings) -> WorkspaceSettingsMessage:
    return WorkspaceSettingsMessage(
        name=settings.name,
        modules=ModulesMessage(**settings.modules),
        branding=BrandingMessage(
            accent_color=settings.accent_color.upper() if settings.accent_color else None  # type: ignore[arg-type]
        ),
        space_types=[
            SpaceTypeMessage(
                key=entry.key, display_name=entry.display_name, icon=entry.icon, enabled=entry.enabled
            )
            for entry in settings.space_types
        ],
        workflows=[
            WorkflowMessage(key=entry.key.upper(), enabled=entry.enabled)  # type: ignore[arg-type]
            for entry in settings.workflows
        ],
        document_types=[
            DocumentTypeMessage(key=entry.key, display_name=entry.display_name)
            for entry in settings.document_types
        ],
        default_publishing_policy=settings.default_publishing_policy.upper(),  # type: ignore[arg-type]
        reverification_duration=(
            f"{settings.reverification_seconds}s"
            if settings.reverification_seconds is not None
            else None
        ),
        etag=settings.etag,
    )


def _seconds(duration: str) -> int:
    seconds = math.ceil(float(duration.removesuffix("s")))
    if seconds <= 0:
        raise InvalidArgument.for_field(
            "reverificationDuration", "reverificationDuration must be positive."
        )
    return seconds


# -- Assistant ------------------------------------------------------------------


class CapabilitiesMessage(ProtoMessage):
    web_search: bool | None = None
    file_work: bool | None = None
    charts: bool | None = None


class StarterPromptMessage(ProtoMessage):
    title: str = ""
    prompt: str = ""
    roles: list[str] = Field(default_factory=list)


class WorkspaceAssistantMessage(ProtoMessage):
    name: str | None = None
    instructions: str | None = None
    answer_length: Literal["CONCISE", "BALANCED", "DETAILED"] | None = None
    capabilities: CapabilitiesMessage | None = None
    welcome_message: str | None = None
    starter_prompts: list[StarterPromptMessage] | None = None
    etag: str | None = None


ASSISTANT_FIELDS = MutableFields(
    (
        "instructions",
        "answerLength",
        "capabilities.webSearch",
        "capabilities.fileWork",
        "capabilities.charts",
        "welcomeMessage",
        "starterPrompts",
    )
)


def assistant_changes(changes: Mapping[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for path, value in changes.items():
        if path == "answerLength":
            result[path] = value.lower() if value is not None else None
        elif path == "starterPrompts":
            result[path] = [
                StarterPrompt(prompt.title, prompt.prompt, tuple(prompt.roles))
                for prompt in value or ()
            ]
        else:
            result[path] = value
    return result


def assistant_message(assistant: AssistantSettings) -> WorkspaceAssistantMessage:
    return WorkspaceAssistantMessage(
        name=assistant.name,
        instructions=assistant.instructions,
        answer_length=assistant.answer_length.upper(),  # type: ignore[arg-type]
        capabilities=CapabilitiesMessage(
            web_search=assistant.web_search,
            file_work=assistant.file_work,
            charts=assistant.charts,
        ),
        welcome_message=assistant.welcome_message,
        starter_prompts=[
            StarterPromptMessage(title=p.title, prompt=p.prompt, roles=list(p.roles))
            for p in assistant.starter_prompts
        ],
        etag=assistant.etag,
    )


# -- Overview and usage ---------------------------------------------------------


class AttentionItemMessage(ProtoMessage):
    kind: str
    item_count: int
    target: str


class KpiMessage(ProtoMessage):
    key: str
    value: float
    previous_value: float | None = None


class DailyUsageMessage(ProtoMessage):
    date: str
    question_count: Int64
    active_member_count: Int64


class WorkspaceOverviewMessage(ProtoMessage):
    name: str
    window: str
    time_zone: str
    attention_items: list[AttentionItemMessage]
    kpis: list[KpiMessage]
    daily_usage: list[DailyUsageMessage]


def overview_message(overview: WorkspaceOverview) -> WorkspaceOverviewMessage:
    return WorkspaceOverviewMessage(
        name=overview.name,
        window=overview.window,
        time_zone=overview.time_zone,
        attention_items=[
            AttentionItemMessage(kind=item.kind, item_count=item.count, target=item.target)
            for item in overview.attention_items
        ],
        kpis=[
            KpiMessage(key=kpi.key, value=kpi.value, previous_value=kpi.previous_value)
            for kpi in overview.kpis
        ],
        daily_usage=[
            DailyUsageMessage(
                date=day.date,
                question_count=day.question_count,
                active_member_count=day.active_member_count,
            )
            for day in overview.daily_usage
        ],
    )


class WorkspaceUsageMessage(ProtoMessage):
    workspace: str
    question_count: Int64
    active_member_count: Int64
    processed_document_count: Int64


class SummarizeWorkspaceUsageResponse(ProtoMessage):
    window: str
    workspace_usages: list[WorkspaceUsageMessage]


class ExportWorkspaceUsageRequest(ProtoMessage):
    window: UsageWindow | None = None


def usage_message(usage: WorkspaceUsage) -> WorkspaceUsageMessage:
    return WorkspaceUsageMessage(
        workspace=usage.workspace,
        question_count=usage.question_count,
        active_member_count=usage.active_member_count,
        processed_document_count=usage.processed_document_count,
    )
