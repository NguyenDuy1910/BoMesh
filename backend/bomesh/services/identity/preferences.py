"""``users/{user}/preferences``: the caller's own UI and notification preferences.

Self only (another user, platform administrators included, is
PERMISSION_DENIED). Stored in ``users.preferences`` (``design.dbml``) with
snake_case keys; ``lastWorkspace`` must name a workspace the caller is an
ACTIVE member of (``auth_contract.md`` § Workspace selection).
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import select

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import User
from bomesh.errors import InvalidArgument, PermissionDenied
from bomesh.services.identity.records import Me, UserPreferencesRecord, user_name
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.workspaces import parse_workspace_name

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

#: Every mutable preference path, as UpdateUserPreferences' ``updateMask`` names it.
PREFERENCE_PATHS = (
    "languageCode",
    "showWorkSteps",
    "appearance.mode",
    "appearance.theme",
    "appearance.accentColor",
    "appearance.backgroundTint",
    "appearance.cornerRadius",
    "appearance.font",
    "emailNotifications.sourceFailures",
    "emailNotifications.accessRequests",
    "emailNotifications.contributionUpdates",
    "emailNotifications.reviewQueue",
    "emailNotifications.requestUpdates",
    "emailNotifications.citedDocumentChanges",
    "emailNotifications.weeklySummary",
    "lastWorkspace",
)

_LANGUAGE_CODE = re.compile(r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$")
_ACCENT_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")
_CAMEL_HUMP = re.compile(r"(?<!^)(?=[A-Z])")


class UserPreferencesService:
    """The one service for the ``users/{user}/preferences`` singleton."""

    def __init__(self, sessions: SessionFactory) -> None:
        self._sessions = sessions

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> UserPreferencesService:
        return cls(runtime.sessions())

    async def get(self, ctx: RequestContext, user: UUID | Me) -> UserPreferencesRecord:
        user_id = _own(ctx, user)
        async with transaction_scope(self._sessions) as session:
            stored = await session.scalar(select(User.preferences).where(User.id == user_id))
        return UserPreferencesRecord.of(user_id, stored or {})

    async def update(
        self, ctx: RequestContext, user: UUID | Me, changes: Mapping[str, Any]
    ) -> UserPreferencesRecord:
        """Set (or, for None, clear) each path of ``changes`` (keys from ``PREFERENCE_PATHS``)."""
        user_id = _own(ctx, user)
        values = {path: await self._validated(ctx, path, value) for path, value in changes.items()}
        async with transaction_scope(self._sessions) as session:
            row = await session.scalar(
                select(User).where(User.id == user_id).with_for_update()
            )
            assert row is not None  # the caller's own, authenticated account
            preferences = _apply(row.preferences or {}, values)
            row.preferences = preferences
            await Audit(session).record(
                ctx,
                workspace_id=None,
                category="settings",
                action="UpdateUserPreferences",
                target=f"{user_name(user_id)}/preferences",
                details={"updateMask": sorted(changes)},
            )
        return UserPreferencesRecord.of(user_id, preferences)

    async def _validated(self, ctx: RequestContext, path: str, value: Any) -> Any:
        if path not in PREFERENCE_PATHS:
            raise InvalidArgument.for_field("updateMask", f"'{path}' is not a preference.")
        if value is None:
            return None
        if path == "languageCode" and not _LANGUAGE_CODE.match(value):
            raise InvalidArgument.for_field(path, "languageCode must be a BCP-47 language tag.")
        if path == "appearance.accentColor" and not _ACCENT_COLOR.match(value):
            raise InvalidArgument.for_field(path, "accentColor must be a #RRGGBB colour.")
        if path == "lastWorkspace":
            workspace_id = parse_workspace_name(value, field=path)
            if not await ctx.authorizer.is_active_member(ctx.principal, workspace_id):
                raise InvalidArgument.for_field(
                    path, f"You are not a member of '{value}'."
                )
            return str(workspace_id)
        return value


def _own(ctx: RequestContext, user: UUID | Me) -> UUID:
    if user != "me" and user != ctx.user_id:
        raise PermissionDenied(
            f"Permission denied on resource '{user_name(user)}/preferences' "  # type: ignore[arg-type]
            "(or it might not exist): preferences are readable only by their own user."
        )
    return ctx.user_id


def _apply(stored: Mapping[str, Any], values: Mapping[str, Any]) -> dict[str, Any]:
    """A copy of ``stored`` with each path set, or removed when its value is None."""
    result: dict[str, Any] = {
        key: dict(value) if isinstance(value, dict) else value for key, value in stored.items()
    }
    for path, value in values.items():
        *parents, leaf = [_storage_key(part) for part in path.split(".")]
        node = result
        for parent in parents:
            child = node.get(parent)
            if not isinstance(child, dict):
                child = node[parent] = {}
            node = child
        if value is None:
            node.pop(leaf, None)
        else:
            node[leaf] = value
    return result


def _storage_key(field: str) -> str:
    """``accentColor`` → ``accent_color``; ``lastWorkspace`` is stored by ID."""
    if field == "lastWorkspace":
        return "last_workspace_id"
    return _CAMEL_HUMP.sub("_", field).lower()


__all__ = ["PREFERENCE_PATHS", "UserPreferencesService"]
