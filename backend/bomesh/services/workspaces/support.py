"""Queries and rules several Workspaces services share."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import ColumnElement, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import Operation, Role, Tenant, TenantMembership
from bomesh.errors import FailedPrecondition, InvalidArgument, NotFound
from bomesh.iam.authorizer import WorkspaceRef, not_found
from bomesh.iam.catalog import Scope
from bomesh.iam.policy import workspace_admins

#: ``window`` values of the usage, audit and overview reads, in days.
WINDOWS: dict[str, int] = {"P1D": 1, "P7D": 7, "P30D": 30}
DEFAULT_WINDOW = "P7D"


def window_days(window: str | None) -> int:
    """Days of a reporting ``window``; INVALID_ARGUMENT for anything but P1D/P7D/P30D."""
    days = WINDOWS.get(window or DEFAULT_WINDOW)
    if days is None:
        raise InvalidArgument.for_field("window", "window must be P1D, P7D or P30D.")
    return days


def window_start(window: str | None, *, now: datetime | None = None) -> datetime:
    return (now or datetime.now(UTC)) - timedelta(days=window_days(window))


def time_zone(name: str | None) -> str:
    """An IANA time zone name (default ``UTC``); INVALID_ARGUMENT when unknown."""
    zone = name or "UTC"
    try:
        ZoneInfo(zone)
    except (ZoneInfoNotFoundError, ValueError):
        raise InvalidArgument.for_field("timeZone", f"Unknown time zone '{zone}'.") from None
    return zone


def member_count_of(workspace_id: ColumnElement[UUID]) -> ColumnElement[int]:
    """Correlated count of ACTIVE members (``Workspace.memberCount``)."""
    return (
        select(func.count())
        .where(
            TenantMembership.tenant_id == workspace_id,
            TenantMembership.status == "active",
            TenantMembership.deleted_at.is_(None),
        )
        .scalar_subquery()
    )


async def lock_workspace(session: AsyncSession, workspace_id: UUID) -> Tenant:
    """The workspace row under ``FOR UPDATE``: serializes admin-count and state changes."""
    workspace = await session.scalar(
        select(Tenant).where(Tenant.id == workspace_id).with_for_update()
    )
    if workspace is None:
        raise not_found(WorkspaceRef(workspace_id))
    return workspace


async def require_an_admin(session: AsyncSession, workspace_id: UUID) -> None:
    """LAST_ADMIN when the pending change left the workspace without an active admin.

    Call after flushing the change, under :func:`lock_workspace`; the failed
    transaction rolls the change back.
    """
    if not await workspace_admins(session, workspace_id):
        raise FailedPrecondition(
            "The last workspace admin cannot be removed.", reason="LAST_ADMIN"
        )


def require_not_self(actor_id: UUID, target_id: UUID, message: str) -> None:
    if actor_id == target_id:
        raise FailedPrecondition(message, reason="SELF_MODIFICATION")


async def workspace_role(
    session: AsyncSession, workspace_id: UUID, name: str, *, field: str
) -> Role:
    """A role grantable on the workspace: ``roles/{r}`` of workspace scope or a live
    custom role ``workspaces/{workspace}/roles/{r}``; INVALID_ARGUMENT otherwise."""
    parts = name.split("/")
    role: Role | None = None
    if len(parts) == 2 and parts[0] == "roles":
        role = await session.scalar(
            select(Role).where(
                Role.tenant_id.is_(None),
                Role.code == parts[1],
                Role.scope_type == Scope.WORKSPACE.value,
            )
        )
    elif len(parts) == 4 and parts[:3] == ["workspaces", str(workspace_id), "roles"]:
        role = await session.scalar(
            select(Role).where(
                Role.tenant_id == workspace_id,
                Role.code == parts[3],
                Role.deleted_at.is_(None),
            )
        )
    if role is None:
        raise InvalidArgument.for_field(field, f"'{name}' is not a workspace role.")
    return role


async def own_operation(session: AsyncSession, user_id: UUID, name: str) -> Operation:
    """The caller's operation ``operations/{id}`` (an idempotent replay re-reads it)."""
    operation = await session.get(Operation, UUID(name.removeprefix("operations/")))
    if operation is None or operation.user_id != user_id:
        raise NotFound(f"Resource '{name}' was not found.")
    return operation


__all__ = [
    "DEFAULT_WINDOW",
    "WINDOWS",
    "lock_workspace",
    "member_count_of",
    "own_operation",
    "require_an_admin",
    "require_not_self",
    "time_zone",
    "window_days",
    "window_start",
    "workspace_role",
]
