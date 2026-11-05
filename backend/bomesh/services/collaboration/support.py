"""Gates shared by the Collaboration services: workspace state, module and space lookup.

Every method first requires an ACTIVE workspace membership (PERMISSION_DENIED
otherwise), then the workspace state rules, then the module flag
(``spaces`` for spaces and everything under them, ``requests`` for requests
and their messages; MODULE_DISABLED when off). Space methods then check their
permission on the space: without it PERMISSION_DENIED, whether or not the
space exists; NOT_FOUND only for callers holding it workspace-wide.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, case, func, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Role, RoleAssignment, Space, Tenant
from bomesh.errors import FailedPrecondition, InvalidArgument, NotFound
from bomesh.iam.authorizer import PlatformRef, SpaceRef, permission_denied
from bomesh.services.collaboration.records import space_name
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency, IdempotencyKey
from bomesh.services.kernel.retention import RETENTION, is_purged
from bomesh.services.kernel.workspaces import (
    Module,
    WorkspaceResolver,
    require_module,
    require_usable,
)

SPACE_ROLES = ("roles/spaceLead", "roles/spaceStaff", "roles/spaceMember")
SPACE_MEMBER = "roles/spaceMember"


def named(name: str) -> PlatformRef:
    """A reference used only to name ``name`` in PERMISSION_DENIED / NOT_FOUND."""
    return PlatformRef(name)


def missing(name: str) -> NotFound:
    return NotFound(f"Resource '{name}' was not found.")


def not_purged(deleted_at: ColumnElement[datetime | None]) -> ColumnElement[bool]:
    """SQL: live, or tombstoned and still within the retention window."""
    return or_(deleted_at.is_(None), deleted_at > func.now() - RETENTION)


def now() -> datetime:
    return datetime.now(UTC)


async def replay(
    idempotency: Idempotency,
    ctx: RequestContext,
    request_id: UUID | None,
    *,
    method: str,
    parent: str,
    request: Mapping[str, Any],
) -> tuple[IdempotencyKey | None, str | None]:
    """``(key, earlier result name)`` for a ``requestId`` write; ``(None, None)`` without one."""
    if request_id is None:
        return None, None
    key = idempotency.key(
        ctx.principal, request_id, method=method, parent=parent, request=request
    )
    return key, await idempotency.replay(key)


class Gate:
    """Open a workspace or a space for one Collaboration method."""

    def __init__(self, sessions: SessionFactory) -> None:
        self._sessions = sessions
        self._resolver = WorkspaceResolver(sessions)

    async def workspace(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        module: Module,
        permission: str,
        target: str,
        *,
        write: bool,
    ) -> Tenant:
        """Membership, state and module rules; ``target`` names the resource in errors."""
        if not await ctx.authorizer.is_active_member(ctx.principal, workspace_id):
            raise permission_denied(permission, named(target))
        workspace = await self._resolver.get(workspace_id)
        require_usable(workspace, write=write)
        require_module(workspace, module)
        return workspace

    async def space(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        permission: str,
        *,
        write: bool,
        include_deleted: bool = False,
    ) -> Space:
        """The space ``code`` once the caller holds ``permission`` on it.

        A DELETED space hides its children: it is NOT_FOUND unless ``include_deleted``.
        """
        name = space_name(workspace_id, code)
        await self.workspace(ctx, workspace_id, "spaces", permission, name, write=write)
        async with transaction_scope(self._sessions) as session:
            space = await find_space(session, workspace_id, code)
        if space is None or is_purged(space.deleted_at):
            if permission in await ctx.authorizer.workspace_permissions(
                ctx.principal, workspace_id
            ):
                raise missing(name)
            raise permission_denied(permission, named(name))
        held = await ctx.authorizer.permissions(
            ctx.principal, SpaceRef(workspace_id, space.id)
        ) | await ctx.authorizer.workspace_permissions(ctx.principal, workspace_id)
        if permission not in held:
            raise permission_denied(permission, named(name))
        if space.deleted_at is not None and not include_deleted:
            raise missing(name)
        return space


async def find_space(
    session: AsyncSession, workspace_id: UUID, code: str, *, for_update: bool = False
) -> Space | None:
    statement = select(Space).where(Space.tenant_id == workspace_id, Space.code == code)
    if for_update:
        statement = statement.with_for_update()
    return await session.scalar(statement)


async def lock_space(session: AsyncSession, space_id: UUID) -> Space:
    space = await session.scalar(
        select(Space).where(Space.id == space_id).with_for_update()
    )
    if space is None:
        raise FailedPrecondition("The space no longer exists.")
    return space


def parse_space_name(name: str, workspace_id: UUID, *, field: str) -> str:
    """The space code of ``workspaces/{workspace}/spaces/{space}`` in this workspace."""
    parts = name.split("/")
    if (
        len(parts) == 4
        and parts[0] == "workspaces"
        and parts[2] == "spaces"
        and parts[3]
    ):
        if parts[1] == str(workspace_id):
            return parts[3]
    raise InvalidArgument.for_field(
        field, f"'{name}' is not a space of this workspace."
    )


def _space_grants(space_id: ColumnElement[UUID]) -> list[ColumnElement[bool]]:
    return [RoleAssignment.space_id == space_id, RoleAssignment.deleted_at.is_(None)]


def member_count_column() -> ColumnElement[int]:
    """Correlated ``Space.memberCount``: people holding a live grant on the space."""
    return (
        select(func.count(func.distinct(RoleAssignment.user_id)))
        .where(*_space_grants(Space.id))
        .correlate(Space)
        .scalar_subquery()
    )


def caller_role_column(user_id: UUID) -> ColumnElement[str]:
    """Correlated ``Space.callerRole``: the caller's highest space role, else ``""``."""
    rank = case(
        *(
            (Role.code == role.removeprefix("roles/"), index)
            for index, role in enumerate(SPACE_ROLES)
        ),
        else_=len(SPACE_ROLES),
    )
    best = (
        select(literal("roles/") + Role.code)
        .join(RoleAssignment, RoleAssignment.role_id == Role.id)
        .where(
            *_space_grants(Space.id),
            RoleAssignment.user_id == user_id,
            Role.tenant_id.is_(None),
        )
        .order_by(rank)
        .limit(1)
        .correlate(Space)
        .scalar_subquery()
    )
    return func.coalesce(best, "")


def space_state_column() -> ColumnElement[str]:
    return case((Space.deleted_at.is_(None), "ACTIVE"), else_="DELETED")


__all__ = [
    "SPACE_MEMBER",
    "SPACE_ROLES",
    "Gate",
    "caller_role_column",
    "find_space",
    "lock_space",
    "member_count_column",
    "missing",
    "named",
    "not_purged",
    "now",
    "parse_space_name",
    "replay",
    "space_state_column",
]
