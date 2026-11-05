"""Space members (``…/spaces/{space}/members/{member}``): the users with live space grants.

The member ID is the user ID. Create adds ``roles/spaceMember``; Delete drops
every space binding of the person (LAST_SPACE_LEAD when they are the last lead).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import Select, String, case, cast, func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Role, RoleAssignment, Space, User
from bomesh.errors import AlreadyExists, FailedPrecondition
from bomesh.iam.authorizer import SpaceRef
from bomesh.iam.policy import PolicyStore, space_leads
from bomesh.services.collaboration.records import SpaceMemberRecord, space_name
from bomesh.services.collaboration.support import (
    SPACE_MEMBER,
    Gate,
    lock_space,
    missing,
    replay,
)
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.workspaces.members import member_records
from bomesh.services.workspaces.records import parse_member_name

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

_ROLE_NAME = case(
    (Role.tenant_id.is_(None), literal("roles/") + Role.code),
    else_=literal("workspaces/") + cast(Role.tenant_id, String) + "/roles/" + Role.code,
)

#: One row per (space, user) holding a live space grant; filter/order columns.
SPACE_MEMBERS = (
    select(
        RoleAssignment.space_id.label("space_id"),
        RoleAssignment.user_id.label("user_id"),
        func.array_agg(func.distinct(_ROLE_NAME)).label("roles"),
        func.min(RoleAssignment.created_at).label("join_time"),
    )
    .join(Role, Role.id == RoleAssignment.role_id)
    .where(RoleAssignment.space_id.is_not(None), RoleAssignment.deleted_at.is_(None))
    .group_by(RoleAssignment.space_id, RoleAssignment.user_id)
    .subquery("space_members")
)
MEMBER_DISPLAY_NAME = func.coalesce(User.display_name, User.email)


def _members(space_id: UUID) -> Select[Any]:
    return (
        select(
            SPACE_MEMBERS.c.user_id,
            SPACE_MEMBERS.c.roles,
            SPACE_MEMBERS.c.join_time,
            MEMBER_DISPLAY_NAME,
        )
        .join(User, User.id == SPACE_MEMBERS.c.user_id)
        .where(SPACE_MEMBERS.c.space_id == space_id)
    )


class SpaceMemberService:
    def __init__(self, sessions: SessionFactory, request_hash_secret: bytes) -> None:
        self._sessions = sessions
        self._secret = request_hash_secret
        self._gate = Gate(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> SpaceMemberService:
        return cls(runtime.sessions(), runtime.request_hash_secret())

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        member: str,
        *,
        request_id: UUID | None,
    ) -> SpaceMemberRecord:
        """Add the workspace member ``member`` as ``roles/spaceMember``."""
        space = await self._gate.space(
            ctx, workspace_id, code, "spaceMembers.create", write=True
        )
        user_id = parse_member_name(member, workspace_id, field="member")
        async with transaction_scope(self._sessions) as session:
            idempotency = Idempotency(session, self._secret)
            key, replayed = await replay(
                idempotency,
                ctx,
                request_id,
                method="CreateSpaceMember",
                parent=space_name(workspace_id, code),
                request={"member": member},
            )
            if replayed is not None:
                return await member_record(session, workspace_id, space, user_id)
            await lock_space(session, space.id)
            if user_id not in await _active_members(session, workspace_id, user_id):
                raise FailedPrecondition(
                    f"'{member}' is not an active member of this workspace.",
                    reason="NOT_WORKSPACE_MEMBER",
                )
            if await _find(session, space.id, user_id) is not None:
                raise AlreadyExists(f"'{member}' is already a member of the space.")
            ref = SpaceRef(workspace_id, space.id)
            policies = PolicyStore(session, ctx.authorizer)
            await policies.require_grantable(ctx.principal, ref, SPACE_MEMBER)
            await policies.add_binding(
                ref, SPACE_MEMBER, f"user:{user_id}", created_by=ctx.user_id
            )
            record = await member_record(session, workspace_id, space, user_id)
            await _audit(session, ctx, workspace_id, "CreateSpaceMember", record.name)
            if key is not None:
                await idempotency.remember(key, record.name)
            return record

    async def get(
        self, ctx: RequestContext, workspace_id: UUID, code: str, user_id: UUID
    ) -> SpaceMemberRecord:
        space = await self._gate.space(
            ctx, workspace_id, code, "spaceMembers.get", write=False
        )
        async with transaction_scope(self._sessions) as session:
            return await member_record(session, workspace_id, space, user_id)

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, code: str, query: ListQuery
    ) -> list[SpaceMemberRecord]:
        space = await self._gate.space(
            ctx, workspace_id, code, "spaceMembers.list", write=False
        )
        async with transaction_scope(self._sessions) as session:
            rows = await session.execute(query.apply(_members(space.id)))
            return [_of(workspace_id, space, row) for row in rows]

    async def delete(
        self, ctx: RequestContext, workspace_id: UUID, code: str, user_id: UUID
    ) -> None:
        space = await self._gate.space(
            ctx, workspace_id, code, "spaceMembers.delete", write=True
        )
        async with transaction_scope(self._sessions) as session:
            await lock_space(session, space.id)
            record = await member_record(session, workspace_id, space, user_id)
            await remove_from_space(session, ctx, workspace_id, space.id, user_id)
            await _audit(session, ctx, workspace_id, "DeleteSpaceMember", record.name)


async def remove_from_space(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    space_id: UUID,
    user_id: UUID,
) -> int:
    """End every space binding of ``user_id``; LAST_SPACE_LEAD when no lead would remain.

    The caller holds the space row lock (:func:`lock_space`).
    """
    leads_before = await space_leads(session, space_id)
    ended = await PolicyStore(session, ctx.authorizer).remove_member(
        SpaceRef(workspace_id, space_id), f"user:{user_id}"
    )
    if user_id in leads_before and not await space_leads(session, space_id):
        raise FailedPrecondition(
            "The last space lead cannot be removed.", reason="LAST_SPACE_LEAD"
        )
    return ended


async def _active_members(
    session: AsyncSession, workspace_id: UUID, user_id: UUID
) -> set[UUID]:
    records = await member_records(session, workspace_id, [user_id])
    return {uid for uid, record in records.items() if record.state == "active"}


async def _find(session: AsyncSession, space_id: UUID, user_id: UUID) -> Any:
    return (
        await session.execute(
            _members(space_id).where(SPACE_MEMBERS.c.user_id == user_id)
        )
    ).one_or_none()


async def member_record(
    session: AsyncSession, workspace_id: UUID, space: Space, user_id: UUID
) -> SpaceMemberRecord:
    row = await _find(session, space.id, user_id)
    if row is None:
        raise missing(f"{space_name(workspace_id, space.code)}/members/{user_id}")
    return _of(workspace_id, space, row)


def _of(workspace_id: UUID, space: Space, row: Any) -> SpaceMemberRecord:
    user_id, roles, join_time, display_name = row
    return SpaceMemberRecord(
        workspace_id, space.code, user_id, display_name, tuple(sorted(roles)), join_time
    )


async def _audit(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    action: str,
    target: str,
) -> None:
    await Audit(session).record(
        ctx, workspace_id=workspace_id, category="spaces", action=action, target=target
    )


__all__ = [
    "MEMBER_DISPLAY_NAME",
    "SPACE_MEMBERS",
    "SpaceMemberService",
    "member_record",
    "remove_from_space",
]
