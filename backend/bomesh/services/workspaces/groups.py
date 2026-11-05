"""Groups (``workspaces/{w}/groups/{code}``) and their memberships (``…/memberships/{user}``).

A group is IAM principal ``group:{code}``. Deleting a group ends its
memberships and bindings; the code stays reserved by the tombstone.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid4

from sqlalchemy import ColumnElement, Select, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh import etag
from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Group, GroupMembership, RoleAssignment, TenantMembership
from bomesh.errors import AlreadyExists, FailedPrecondition, InvalidArgument, NotFound
from bomesh.iam.authorizer import WorkspaceRef
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.workspaces import WorkspaceResolver
from bomesh.services.workspaces.records import (
    GroupRecord,
    MembershipRecord,
    group_name,
    parse_member_name,
)
from bomesh.services.workspaces.support import lock_workspace, require_an_admin

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

GROUP_ID = re.compile(r"^[a-z][a-z0-9-]{0,62}$")


class GroupService:
    def __init__(self, sessions: SessionFactory, request_hash_secret: bytes) -> None:
        self._sessions = sessions
        self._secret = request_hash_secret
        self._resolver = WorkspaceResolver(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> GroupService:
        return cls(runtime.sessions(), runtime.request_hash_secret())

    # -- Groups ---------------------------------------------------------------

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        *,
        group_id: str | None,
        display_name: str,
        description: str | None,
        request_id: UUID | None,
    ) -> GroupRecord:
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "groups.create", write=True)
        code = _group_id(group_id) if group_id is not None else f"group-{uuid4().hex[:12]}"
        title = _display_name(display_name)
        async with transaction_scope(self._sessions) as session:
            idempotency = Idempotency(session, self._secret)
            key = None
            if request_id is not None:
                key = idempotency.key(
                    ctx.principal,
                    request_id,
                    method="CreateGroup",
                    parent=f"workspaces/{workspace_id}",
                    request={"groupId": group_id, "displayName": title, "description": description},
                )
                if (replayed := await idempotency.replay(key)) is not None:
                    return await _record(session, workspace_id, replayed.rsplit("/", 1)[-1])
            await lock_workspace(session, workspace_id)
            taken = await session.scalar(
                select(Group.id).where(Group.tenant_id == workspace_id, Group.code == code)
            )
            if taken is not None:
                raise AlreadyExists(f"The group ID '{code}' is already taken.")
            session.add(
                Group(
                    tenant_id=workspace_id,
                    code=code,
                    display_name=title,
                    description=description or None,
                )
            )
            await session.flush()
            await self._audit(session, ctx, workspace_id, "CreateGroup", group_name(workspace_id, code))
            if key is not None:
                await idempotency.remember(key, group_name(workspace_id, code))
            return await _record(session, workspace_id, code)

    async def get(self, ctx: RequestContext, workspace_id: UUID, code: str) -> GroupRecord:
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "groups.get", write=False)
        async with transaction_scope(self._sessions) as session:
            return await _record(session, workspace_id, code)

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, query: ListQuery
    ) -> list[GroupRecord]:
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "groups.list", write=False)
        async with transaction_scope(self._sessions) as session:
            rows = await session.execute(query.apply(_groups(workspace_id)))
            return [GroupRecord(group, count) for group, count in rows]

    async def update(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        changes: Mapping[str, Any],
        *,
        expected_etag: str | None,
    ) -> GroupRecord:
        """``changes`` keyed by mask path: ``displayName``, ``description``."""
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "groups.update", write=True)
        async with transaction_scope(self._sessions) as session:
            current = await _record(session, workspace_id, code, for_update=True)
            etag.check(expected_etag, current.etag)
            group = current.group
            if "displayName" in changes:
                group.display_name = _display_name(changes["displayName"])
            if "description" in changes:
                group.description = changes["description"] or None
            await session.flush()
            await self._audit(session, ctx, workspace_id, "UpdateGroup", current.name)
            return await _record(session, workspace_id, code)

    async def delete(
        self, ctx: RequestContext, workspace_id: UUID, code: str, *, expected_etag: str | None
    ) -> None:
        """Tombstone the group, its memberships and every binding naming it."""
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "groups.delete", write=True)
        async with transaction_scope(self._sessions) as session:
            await lock_workspace(session, workspace_id)
            current = await _record(session, workspace_id, code, for_update=True)
            etag.check(expected_etag, current.etag)
            now = datetime.now(UTC)
            current.group.deleted_at = now
            await session.execute(
                update(GroupMembership)
                .where(
                    GroupMembership.group_id == current.group.id,
                    GroupMembership.deleted_at.is_(None),
                )
                .values(deleted_at=now)
            )
            await session.execute(
                update(RoleAssignment)
                .where(
                    RoleAssignment.group_id == current.group.id,
                    RoleAssignment.deleted_at.is_(None),
                )
                .values(deleted_at=now)
            )
            await session.flush()
            await require_an_admin(session, workspace_id)
            await self._audit(session, ctx, workspace_id, "DeleteGroup", current.name)

    # -- Memberships ----------------------------------------------------------

    async def add_member(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        member: str,
        *,
        request_id: UUID | None,
    ) -> MembershipRecord:
        """Add the workspace member named ``member`` (``workspaces/{w}/members/{user}``)."""
        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "memberships.create", write=True
        )
        user_id = parse_member_name(member, workspace_id, field="member")
        async with transaction_scope(self._sessions) as session:
            idempotency = Idempotency(session, self._secret)
            key = None
            if request_id is not None:
                key = idempotency.key(
                    ctx.principal,
                    request_id,
                    method="CreateMembership",
                    parent=group_name(workspace_id, code),
                    request={"member": member},
                )
                if await idempotency.replay(key) is not None:
                    return await _membership(session, workspace_id, code, user_id)
            group = (await _record(session, workspace_id, code, for_update=True)).group
            if not await _is_member(session, workspace_id, user_id):
                raise FailedPrecondition(
                    f"'{member}' is not a member of this workspace.",
                    reason="NOT_WORKSPACE_MEMBER",
                )
            row = await session.get(GroupMembership, {"group_id": group.id, "user_id": user_id})
            if row is not None and row.deleted_at is None:
                raise AlreadyExists(f"'{member}' is already in the group.")
            now = datetime.now(UTC)
            if row is None:
                session.add(GroupMembership(group_id=group.id, user_id=user_id, joined_at=now))
            else:
                row.deleted_at = None
                row.status = "active"
                row.joined_at = now
            group.updated_at = now
            await session.flush()
            name = f"{group_name(workspace_id, code)}/memberships/{user_id}"
            await self._audit(session, ctx, workspace_id, "CreateMembership", name)
            if key is not None:
                await idempotency.remember(key, name)
            return await _membership(session, workspace_id, code, user_id)

    async def get_membership(
        self, ctx: RequestContext, workspace_id: UUID, code: str, user_id: UUID
    ) -> MembershipRecord:
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "memberships.get", write=False)
        async with transaction_scope(self._sessions) as session:
            return await _membership(session, workspace_id, code, user_id)

    async def list_memberships(
        self, ctx: RequestContext, workspace_id: UUID, code: str, query: ListQuery
    ) -> list[MembershipRecord]:
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "memberships.list", write=False)
        async with transaction_scope(self._sessions) as session:
            group = (await _record(session, workspace_id, code)).group
            rows = await session.scalars(
                query.apply(
                    select(GroupMembership).where(
                        GroupMembership.group_id == group.id,
                        GroupMembership.deleted_at.is_(None),
                    )
                )
            )
            return [_membership_record(workspace_id, code, row) for row in rows]

    async def remove_member(
        self, ctx: RequestContext, workspace_id: UUID, code: str, user_id: UUID
    ) -> None:
        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "memberships.delete", write=True
        )
        async with transaction_scope(self._sessions) as session:
            await lock_workspace(session, workspace_id)
            group = (await _record(session, workspace_id, code, for_update=True)).group
            row = await _live_membership(session, workspace_id, code, group.id, user_id)
            now = datetime.now(UTC)
            row.deleted_at = now
            group.updated_at = now
            await session.flush()
            await require_an_admin(session, workspace_id)
            await self._audit(
                session,
                ctx,
                workspace_id,
                "DeleteMembership",
                f"{group_name(workspace_id, code)}/memberships/{user_id}",
            )

    @staticmethod
    async def _audit(
        session: AsyncSession, ctx: RequestContext, workspace_id: UUID, action: str, target: str
    ) -> None:
        await Audit(session).record(
            ctx, workspace_id=workspace_id, category="people", action=action, target=target
        )


# -- Queries --------------------------------------------------------------------


def member_count() -> ColumnElement[int]:
    """Correlated live membership count of ``Group`` (``Group.memberCount``)."""
    return (
        select(func.count())
        .where(
            GroupMembership.group_id == Group.id,
            GroupMembership.status == "active",
            GroupMembership.deleted_at.is_(None),
        )
        .scalar_subquery()
    )


def _groups(workspace_id: UUID) -> Select[tuple[Group, int]]:
    return select(Group, member_count()).where(
        Group.tenant_id == workspace_id, Group.deleted_at.is_(None)
    )


async def _record(
    session: AsyncSession, workspace_id: UUID, code: str, *, for_update: bool = False
) -> GroupRecord:
    statement = _groups(workspace_id).where(Group.code == code)
    row = (await session.execute(statement)).first()
    if row is None:
        raise NotFound(f"Resource '{group_name(workspace_id, code)}' was not found.")
    group = row[0]
    if for_update:
        await session.execute(select(Group.id).where(Group.id == group.id).with_for_update())
    await session.refresh(group)
    return GroupRecord(group, row[1])


async def _is_member(session: AsyncSession, workspace_id: UUID, user_id: UUID) -> bool:
    return (
        await session.scalar(
            select(TenantMembership.user_id).where(
                TenantMembership.tenant_id == workspace_id,
                TenantMembership.user_id == user_id,
                TenantMembership.deleted_at.is_(None),
            )
        )
        is not None
    )


async def _live_membership(
    session: AsyncSession, workspace_id: UUID, code: str, group_id: UUID, user_id: UUID
) -> GroupMembership:
    row = await session.get(GroupMembership, {"group_id": group_id, "user_id": user_id})
    if row is None or row.deleted_at is not None:
        raise NotFound(
            f"Resource '{group_name(workspace_id, code)}/memberships/{user_id}' was not found."
        )
    return row


async def _membership(
    session: AsyncSession, workspace_id: UUID, code: str, user_id: UUID
) -> MembershipRecord:
    group = (await _record(session, workspace_id, code)).group
    row = await _live_membership(session, workspace_id, code, group.id, user_id)
    await session.refresh(row)
    return _membership_record(workspace_id, code, row)


def _membership_record(workspace_id: UUID, code: str, row: GroupMembership) -> MembershipRecord:
    return MembershipRecord(
        workspace_id=workspace_id,
        group_code=code,
        user_id=row.user_id,
        created_at=row.joined_at or row.created_at,
    )


def _group_id(value: str) -> str:
    if not GROUP_ID.match(value):
        raise InvalidArgument.for_field("groupId", "groupId must match ^[a-z][a-z0-9-]{0,62}$.")
    return value


def _display_name(value: object) -> str:
    text = value.strip() if isinstance(value, str) else ""
    if not text or len(text) > 255:
        raise InvalidArgument.for_field("displayName", "displayName must be 1-255 characters.")
    return text


__all__ = ["GROUP_ID", "GroupService", "member_count"]
