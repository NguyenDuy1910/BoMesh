"""WorkspaceSettings and WorkspaceAssistant singletons, plus their cross-slice reads.

Settings live in ``tenants.settings`` (snake_case keys, lower-case enum values,
``reverification_duration`` in seconds); the settings etag is a hash of that
document without its ``archive`` record. The assistant is one
``workspace_assistant_settings`` row, product defaults when absent; starter
prompts store role IDs and read back as role names.
"""

from __future__ import annotations

import base64
import hashlib
import json
from collections import Counter
from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh import etag
from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Role, Tenant, WorkspaceAssistantSettings
from bomesh.errors import InvalidArgument
from bomesh.iam.authorizer import WorkspaceRef, not_found
from bomesh.iam.policy import role_name
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.workspaces import WorkspaceResolver, workspace_name
from bomesh.services.workspaces.records import (
    AssistantSettings,
    DocumentType,
    SpaceType,
    StarterPrompt,
    Workflow,
    WorkspaceSettings,
)
from bomesh.services.workspaces.support import lock_workspace, workspace_role

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

MODULES = ("spaces", "work", "requests")
PUBLISHING_POLICIES = ("auto_publish", "review_first")
ACCENT_COLORS = ("indigo", "teal", "ocean", "plum", "graphite")
WORKFLOWS = ("evidence_review", "draft", "study_guide", "quiz")
ANSWER_LENGTHS = ("concise", "balanced", "detailed")

MAX_INSTRUCTIONS = 2000
MAX_WELCOME = 60
MAX_PROMPT_TITLE = 40
MAX_PROMPT_TEXT = 160
MAX_PROMPTS_PER_ROLE = 3
DEFAULT_WELCOME = "How can I help you today?"
_DEFAULT_CAPABILITIES = {"web_search": False, "file_work": True, "charts": True}
_CAPABILITY_PATHS = {
    "capabilities.webSearch": "web_search",
    "capabilities.fileWork": "file_work",
    "capabilities.charts": "charts",
}


# -- Cross-slice reads ----------------------------------------------------------


async def workspace_settings(session: AsyncSession, workspace_id: UUID) -> WorkspaceSettings:
    """The workspace's settings with defaults applied; no permission check."""
    workspace = await session.get(Tenant, workspace_id)
    if workspace is None:
        raise not_found(WorkspaceRef(workspace_id))
    return _settings(workspace)


async def assistant_settings(session: AsyncSession, workspace_id: UUID) -> AssistantSettings:
    """The workspace's assistant configuration (defaults if never saved); no permission check."""
    workspace = await session.get(Tenant, workspace_id)
    if workspace is None:
        raise not_found(WorkspaceRef(workspace_id))
    row = await session.get(WorkspaceAssistantSettings, workspace_id)
    return await _assistant(session, workspace, row)


# -- Service --------------------------------------------------------------------


class SettingsService:
    """Get/Update of ``…/settings`` and ``…/assistant``."""

    def __init__(self, sessions: SessionFactory) -> None:
        self._sessions = sessions
        self._resolver = WorkspaceResolver(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> SettingsService:
        return cls(runtime.sessions())

    async def get_settings(self, ctx: RequestContext, workspace_id: UUID) -> WorkspaceSettings:
        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "workspaces.getSettings", write=False
        )
        async with transaction_scope(self._sessions) as session:
            return await workspace_settings(session, workspace_id)

    async def update_settings(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        changes: Mapping[str, Any],
        *,
        expected_etag: str | None,
    ) -> WorkspaceSettings:
        """``changes`` keyed by mask path; ``None`` clears a field back to its default."""
        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "workspaces.updateSettings", write=True
        )
        async with transaction_scope(self._sessions) as session:
            workspace = await lock_workspace(session, workspace_id)
            etag.check(expected_etag, _settings_etag(workspace.settings))
            workspace.settings = _apply_settings(dict(workspace.settings), changes)
            await session.flush()
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="settings",
                action="UpdateWorkspaceSettings",
                target=f"{workspace_name(workspace_id)}/settings",
                details={"fields": sorted(changes)},
            )
            return _settings(workspace)

    async def get_assistant(self, ctx: RequestContext, workspace_id: UUID) -> AssistantSettings:
        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "workspaces.getAssistant", write=False
        )
        async with transaction_scope(self._sessions) as session:
            return await assistant_settings(session, workspace_id)

    async def update_assistant(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        changes: Mapping[str, Any],
        *,
        expected_etag: str | None,
    ) -> AssistantSettings:
        """``changes`` keyed by mask path; ``starterPrompts`` holds :class:`StarterPrompt`."""
        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "workspaces.updateAssistant", write=True
        )
        async with transaction_scope(self._sessions) as session:
            workspace = await lock_workspace(session, workspace_id)
            row = await session.get(WorkspaceAssistantSettings, workspace_id)
            current = await _assistant(session, workspace, row)
            etag.check(expected_etag, current.etag)
            if row is None:
                row = WorkspaceAssistantSettings(
                    tenant_id=workspace_id,
                    instructions="",
                    welcome_message=DEFAULT_WELCOME,
                    capabilities=dict(_DEFAULT_CAPABILITIES),
                    starter_prompts=[],
                )
                session.add(row)
            await _apply_assistant(session, workspace_id, row, changes)
            row.updated_by_user_id = ctx.user_id
            await session.flush()
            await session.refresh(row)
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="settings",
                action="UpdateWorkspaceAssistant",
                target=f"{workspace_name(workspace_id)}/assistant",
                details={"fields": sorted(changes)},
            )
            return await _assistant(session, workspace, row)


# -- Settings document ----------------------------------------------------------


def _settings(workspace: Tenant) -> WorkspaceSettings:
    stored = workspace.settings
    modules = stored.get("modules") or {}
    branding = stored.get("branding") or {}
    return WorkspaceSettings(
        workspace_id=workspace.id,
        modules={module: modules.get(module, True) is not False for module in MODULES},
        accent_color=branding.get("accent_color"),
        space_types=tuple(
            SpaceType(
                key=entry["key"],
                display_name=entry["display_name"],
                icon=entry.get("icon"),
                enabled=entry.get("enabled", True),
            )
            for entry in stored.get("space_types") or ()
        ),
        workflows=tuple(
            Workflow(key=entry["key"], enabled=entry.get("enabled", True))
            for entry in stored.get("workflows") or ()
        ),
        document_types=tuple(
            DocumentType(key=entry["key"], display_name=entry["display_name"])
            for entry in stored.get("document_types") or ()
        ),
        default_publishing_policy=stored.get("default_publishing_policy") or "auto_publish",
        reverification_seconds=stored.get("reverification_duration"),
        etag=_settings_etag(stored),
    )


def _settings_etag(stored: Mapping[str, Any]) -> str:
    document = {key: value for key, value in stored.items() if key != "archive"}
    canonical = json.dumps(document, sort_keys=True, separators=(",", ":"), default=str)
    return base64.urlsafe_b64encode(hashlib.sha256(canonical.encode()).digest()[:12]).decode()


def _apply_settings(stored: dict[str, Any], changes: Mapping[str, Any]) -> dict[str, Any]:
    for path, value in changes.items():
        head, _, leaf = path.partition(".")
        match head:
            case "modules":
                modules = dict(stored.get("modules") or {})
                _set(modules, leaf, _boolean(value, path))
                stored["modules"] = modules
            case "branding":
                branding = dict(stored.get("branding") or {})
                _set(branding, "accent_color", _choice(value, ACCENT_COLORS, path))
                stored["branding"] = branding
            case "spaceTypes":
                _set(stored, "space_types", _space_types(value))
            case "workflows":
                _set(stored, "workflows", _workflows(value))
            case "documentTypes":
                _set(stored, "document_types", _document_types(value))
            case "defaultPublishingPolicy":
                _set(
                    stored,
                    "default_publishing_policy",
                    _choice(value, PUBLISHING_POLICIES, path),
                )
            case "reverificationDuration":
                _set(stored, "reverification_duration", _seconds(value, path))
            case _:
                raise ValueError(f"unknown settings path {path!r}")
    return {key: value for key, value in stored.items() if value not in ({}, None)}


def _set(target: dict[str, Any], key: str, value: Any) -> None:
    if value is None:
        target.pop(key, None)
    else:
        target[key] = value


def _boolean(value: object, field: str) -> bool | None:
    if value is None or isinstance(value, bool):
        return value
    raise InvalidArgument.for_field(field, f"{field} must be a boolean.")


def _choice(value: object, allowed: Sequence[str], field: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or value not in allowed:
        raise InvalidArgument.for_field(field, f"Unsupported {field} value.")
    return value


def _seconds(value: object, field: str) -> int | None:
    if value is None:
        return None
    if not isinstance(value, int) or value <= 0:
        raise InvalidArgument.for_field(field, f"{field} must be a positive duration.")
    return value


def _unique_keys(keys: Sequence[str], field: str) -> None:
    for key in keys:
        if not key.strip() or len(key) > 64:
            raise InvalidArgument.for_field(field, f"Every {field} key must be 1-64 characters.")
    duplicates = [key for key, count in Counter(keys).items() if count > 1]
    if duplicates:
        raise InvalidArgument.for_field(field, f"Duplicate {field} key '{duplicates[0]}'.")


def _label(value: str, field: str) -> str:
    text = value.strip()
    if not text or len(text) > 255:
        raise InvalidArgument.for_field(field, f"Every {field} displayName must be 1-255 characters.")
    return text


def _space_types(value: Sequence[SpaceType] | None) -> list[dict[str, Any]] | None:
    if value is None:
        return None
    _unique_keys([entry.key for entry in value], "spaceTypes")
    return [
        {
            "key": entry.key,
            "display_name": _label(entry.display_name, "spaceTypes"),
            "icon": entry.icon,
            "enabled": entry.enabled,
        }
        for entry in value
    ]


def _workflows(value: Sequence[Workflow] | None) -> list[dict[str, Any]] | None:
    if value is None:
        return None
    _unique_keys([entry.key for entry in value], "workflows")
    for entry in value:
        _choice(entry.key, WORKFLOWS, "workflows")
    return [{"key": entry.key, "enabled": entry.enabled} for entry in value]


def _document_types(value: Sequence[DocumentType] | None) -> list[dict[str, Any]] | None:
    if value is None:
        return None
    _unique_keys([entry.key for entry in value], "documentTypes")
    return [
        {"key": entry.key, "display_name": _label(entry.display_name, "documentTypes")}
        for entry in value
    ]


# -- Assistant ------------------------------------------------------------------


async def _assistant(
    session: AsyncSession, workspace: Tenant, row: WorkspaceAssistantSettings | None
) -> AssistantSettings:
    name = f"{workspace_name(workspace.id)}/assistant"
    if row is None:
        return AssistantSettings(
            workspace_id=workspace.id,
            instructions="",
            answer_length="balanced",
            web_search=_DEFAULT_CAPABILITIES["web_search"],
            file_work=_DEFAULT_CAPABILITIES["file_work"],
            charts=_DEFAULT_CAPABILITIES["charts"],
            welcome_message=DEFAULT_WELCOME,
            starter_prompts=(),
            etag=etag.compute(name, workspace.created_at),
        )
    capabilities = {**_DEFAULT_CAPABILITIES, **row.capabilities}
    return AssistantSettings(
        workspace_id=workspace.id,
        instructions=row.instructions,
        answer_length=row.answer_length,
        web_search=bool(capabilities["web_search"]),
        file_work=bool(capabilities["file_work"]),
        charts=bool(capabilities["charts"]),
        welcome_message=row.welcome_message,
        starter_prompts=await _prompts_out(session, row.starter_prompts),
        etag=etag.compute(name, row.updated_at),
    )


async def _apply_assistant(
    session: AsyncSession,
    workspace_id: UUID,
    row: WorkspaceAssistantSettings,
    changes: Mapping[str, Any],
) -> None:
    capabilities = {**_DEFAULT_CAPABILITIES, **row.capabilities}
    for path, value in changes.items():
        if path == "instructions":
            row.instructions = _bounded(value or "", MAX_INSTRUCTIONS, path, allow_empty=True)
        elif path == "answerLength":
            row.answer_length = _choice(value, ANSWER_LENGTHS, path) or "balanced"
        elif path in _CAPABILITY_PATHS:
            key = _CAPABILITY_PATHS[path]
            flag = _boolean(value, path)
            capabilities[key] = _DEFAULT_CAPABILITIES[key] if flag is None else flag
        elif path == "welcomeMessage":
            row.welcome_message = (
                _bounded(value, MAX_WELCOME, path, allow_empty=False)
                if value
                else DEFAULT_WELCOME
            )
        elif path == "starterPrompts":
            row.starter_prompts = await _prompts_in(session, workspace_id, value or ())
        else:
            raise ValueError(f"unknown assistant path {path!r}")
    row.capabilities = capabilities


def _bounded(value: object, limit: int, field: str, *, allow_empty: bool) -> str:
    if not isinstance(value, str) or len(value) > limit or (not allow_empty and not value.strip()):
        raise InvalidArgument.for_field(field, f"{field} must be at most {limit} characters.")
    return value


async def _prompts_in(
    session: AsyncSession, workspace_id: UUID, prompts: Sequence[StarterPrompt]
) -> list[dict[str, Any]]:
    per_role: Counter[UUID | None] = Counter()
    stored: list[dict[str, Any]] = []
    for prompt in prompts:
        title = _bounded(prompt.title, MAX_PROMPT_TITLE, "starterPrompts", allow_empty=False)
        text = _bounded(prompt.prompt, MAX_PROMPT_TEXT, "starterPrompts", allow_empty=False)
        role_ids = [
            (await workspace_role(session, workspace_id, name, field="starterPrompts")).id
            for name in dict.fromkeys(prompt.roles)
        ]
        per_role.update(role_ids or [None])
        stored.append({"title": title, "prompt": text, "role_ids": [str(r) for r in role_ids]})
    if any(count > MAX_PROMPTS_PER_ROLE for count in per_role.values()):
        raise InvalidArgument.for_field(
            "starterPrompts", f"At most {MAX_PROMPTS_PER_ROLE} starter prompts per role."
        )
    return stored


async def _prompts_out(
    session: AsyncSession, stored: Sequence[Mapping[str, Any]]
) -> tuple[StarterPrompt, ...]:
    role_ids = {UUID(role_id) for prompt in stored for role_id in prompt.get("role_ids", ())}
    roles = {
        role.id: role
        for role in await session.scalars(
            select(Role).where(Role.id.in_(role_ids), Role.deleted_at.is_(None))
        )
    } if role_ids else {}
    return tuple(
        StarterPrompt(
            title=prompt["title"],
            prompt=prompt["prompt"],
            roles=tuple(
                role_name(roles[UUID(role_id)])
                for role_id in prompt.get("role_ids", ())
                if UUID(role_id) in roles
            ),
        )
        for prompt in stored
    )


__all__ = [
    "ACCENT_COLORS",
    "ANSWER_LENGTHS",
    "MODULES",
    "PUBLISHING_POLICIES",
    "WORKFLOWS",
    "SettingsService",
    "assistant_settings",
    "workspace_settings",
]
