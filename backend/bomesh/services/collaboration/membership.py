"""Who belongs to a space: the cross-slice membership API.

A space member is a user holding a live space-scoped grant (any space role)
on a live space, while their workspace membership is ACTIVE. Space policies
hold ``user:`` principals only, so groups never make anyone a member.
"""

from __future__ import annotations

from collections.abc import Iterable
from uuid import UUID

from sqlalchemy import ScalarSelect, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import RoleAssignment, Space, TenantMembership


async def space_id_for_code(
    session: AsyncSession, workspace_id: UUID, code: str
) -> UUID | None:
    """The ID of the live space ``workspaces/{workspace}/spaces/{code}``, else None."""
    return await session.scalar(
        select(Space.id).where(
            Space.tenant_id == workspace_id,
            Space.code == code,
            Space.deleted_at.is_(None),
        )
    )


async def space_codes(
    session: AsyncSession, space_ids: Iterable[UUID]
) -> dict[UUID, str]:
    """The API ID (code) of each space, deleted ones included."""
    ids = set(space_ids)
    if not ids:
        return {}
    rows = await session.execute(select(Space.id, Space.code).where(Space.id.in_(ids)))
    return {space_id: code for space_id, code in rows}


def space_id_by_code(workspace_id: UUID, code: str) -> ScalarSelect[UUID]:
    """SQL scalar subquery: the ID of space ``code`` (for filter compilation)."""
    return (
        select(Space.id)
        .where(Space.tenant_id == workspace_id, Space.code == code)
        .scalar_subquery()
    )


async def member_space_ids(
    session: AsyncSession, workspace_id: UUID, user_id: UUID
) -> frozenset[UUID]:
    """Live spaces of the workspace ``user_id`` is a member of (see :func:`space_member_ids`)."""
    rows = await session.scalars(
        select(RoleAssignment.space_id)
        .join(Space, Space.id == RoleAssignment.space_id)
        .join(
            TenantMembership,
            (TenantMembership.user_id == RoleAssignment.user_id)
            & (TenantMembership.tenant_id == Space.tenant_id),
        )
        .where(
            Space.tenant_id == workspace_id,
            Space.deleted_at.is_(None),
            RoleAssignment.user_id == user_id,
            RoleAssignment.deleted_at.is_(None),
            TenantMembership.status == "active",
            TenantMembership.deleted_at.is_(None),
        )
    )
    return frozenset(rows)


def _members(workspace_id: UUID, space_id: UUID):  # noqa: ANN202 - a SELECT of user IDs
    return (
        select(RoleAssignment.user_id)
        .join(Space, Space.id == RoleAssignment.space_id)
        .join(
            TenantMembership,
            (TenantMembership.user_id == RoleAssignment.user_id)
            & (TenantMembership.tenant_id == Space.tenant_id),
        )
        .where(
            Space.id == space_id,
            Space.tenant_id == workspace_id,
            Space.deleted_at.is_(None),
            RoleAssignment.deleted_at.is_(None),
            TenantMembership.status == "active",
            TenantMembership.deleted_at.is_(None),
        )
        .distinct()
    )


async def space_member_ids(
    session: AsyncSession, workspace_id: UUID, space_id: UUID
) -> frozenset[UUID]:
    """ACTIVE workspace members holding a live grant on the live space; no permission check."""
    return frozenset(await session.scalars(_members(workspace_id, space_id)))


async def is_space_member(
    session: AsyncSession, workspace_id: UUID, space_id: UUID, user_id: UUID
) -> bool:
    """Whether ``user_id`` is a member of the space (see :func:`space_member_ids`)."""
    statement = _members(workspace_id, space_id).where(
        RoleAssignment.user_id == user_id
    )
    return await session.scalar(statement) is not None


__all__ = [
    "is_space_member",
    "member_space_ids",
    "space_codes",
    "space_id_by_code",
    "space_id_for_code",
    "space_member_ids",
]
