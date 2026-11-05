"""Members: a user's membership of a workspace (``workspaces/{w}/members/{user}``).

``Member.roles`` are the workspace roles bound to the user directly or through
a group; ``Member.groups`` the live groups the user actively belongs to. Every
new member gets a PERSONAL collection. Role changes are SetWorkspaceIamPolicy.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Sequence
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import ColumnElement, Select, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import (
    Group,
    GroupMembership,
    Role,
    RoleAssignment,
    TenantMembership,
    User,
)
from bomesh.errors import AlreadyExists, FailedPrecondition, NotFound
from bomesh.iam.authorizer import WorkspaceRef
from bomesh.iam.policy import PolicyStore, role_name
from bomesh.services.identity.identity_store import IdentityStoreService
from bomesh.services.identity.records import parse_user_name
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.workspaces import WorkspaceResolver, workspace_name
from bomesh.services.knowledge_items.inventory import is_live_item
from bomesh.services.knowledge_items.item_store import (
    ensure_personal_collection,
    personal_collection_id,
)
from bomesh.services.knowledge_items.names import item_name
from bomesh.services.workspaces.records import (
    MemberRecord,
    group_name,
    member_name,
    parse_member_name,
)
from bomesh.services.workspaces.support import (
    lock_workspace,
    require_an_admin,
    require_not_self,
    workspace_role,
)

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

DEFAULT_MEMBER_ROLE = "roles/workspaceMember"


# -- Cross-slice reads ----------------------------------------------------------


def display_name_of(user: User) -> str:
    """How every surface names a person: the display name, else the email."""
    return user.display_name or user.email


async def member_records(
    session: AsyncSession, workspace_id: UUID, user_ids: Iterable[UUID]
) -> dict[UUID, MemberRecord]:
    """Live members among ``user_ids`` (no roles or groups); no permission check.

    Former members are absent, so callers can render them as unknown people.
    """
    ids = set(user_ids)
    if not ids:
        return {}
    rows = await session.execute(
        _members(workspace_id).where(TenantMembership.user_id.in_(ids))
    )
    return {
        membership.user_id: _record(membership, user) for membership, user in rows
    }


async def active_member_ids(session: AsyncSession, workspace_id: UUID) -> frozenset[UUID]:
    """User IDs of the workspace's ACTIVE (live, not suspended) members; no permission check."""
    return frozenset(
        await session.scalars(
            select(TenantMembership.user_id).where(
                TenantMembership.tenant_id == workspace_id,
                TenantMembership.status == "active",
                TenantMembership.deleted_at.is_(None),
            )
        )
    )


# -- Service --------------------------------------------------------------------


class MemberService:
    def __init__(self, sessions: SessionFactory, request_hash_secret: bytes) -> None:
        self._sessions = sessions
        self._secret = request_hash_secret
        self._resolver = WorkspaceResolver(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> MemberService:
        return cls(runtime.sessions(), runtime.request_hash_secret())

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        user: str,
        roles: Sequence[str],
        *,
        validate_only: bool,
        request_id: UUID | None,
    ) -> MemberRecord:
        """Add ``user`` (``users/{user}``) with ``roles`` (default ``roles/workspaceMember``)."""
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "members.create", write=True)
        user_id = parse_user_name(user, field="user")
        role_names = tuple(dict.fromkeys(roles or (DEFAULT_MEMBER_ROLE,)))
        async with transaction_scope(self._sessions) as session:
            idempotency = Idempotency(session, self._secret)
            key = None
            if request_id is not None and not validate_only:
                key = idempotency.key(
                    ctx.principal,
                    request_id,
                    method="CreateMember",
                    parent=workspace_name(workspace_id),
                    request={"user": user, "roles": list(role_names)},
                )
                if await idempotency.replay(key) is not None:
                    return await _full_record(session, ctx, workspace_id, user_id)
            await lock_workspace(session, workspace_id)
            account = await session.get(User, user_id)
            if account is None or account.status != "active":
                raise NotFound(f"Resource '{user}' was not found.")
            membership = await session.get(
                TenantMembership, {"user_id": user_id, "tenant_id": workspace_id}
            )
            if membership is not None and membership.deleted_at is None:
                raise AlreadyExists(f"'{user}' is already a member of this workspace.")
            policies = PolicyStore(session, ctx.authorizer)
            resource = WorkspaceRef(workspace_id)
            for name in role_names:
                await workspace_role(session, workspace_id, name, field="roles")
                await policies.require_grantable(ctx.principal, resource, name)
            if validate_only:
                return MemberRecord(
                    workspace_id=workspace_id,
                    user_id=user_id,
                    display_name=display_name_of(account),
                    email=account.email,
                    state="active",
                    joined_at=None,
                    last_active_at=None,
                    roles=tuple(sorted(role_names)),
                )
            await IdentityStoreService(session).assign_membership(user_id, workspace_id)
            for name in role_names:
                await policies.add_binding(
                    resource, name, f"user:{user_id}", created_by=ctx.user_id
                )
            await ensure_personal_collection(session, workspace_id, user_id)
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="people",
                action="CreateMember",
                target=member_name(workspace_id, user_id),
                details={"roles": list(role_names)},
            )
            if key is not None:
                await idempotency.remember(key, member_name(workspace_id, user_id))
            return await _full_record(session, ctx, workspace_id, user_id)

    async def get(self, ctx: RequestContext, workspace_id: UUID, member: str) -> MemberRecord:
        """``member`` is a user ID or ``me``."""
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "members.get", write=False)
        user_id = self._member_id(ctx, workspace_id, member)
        async with transaction_scope(self._sessions) as session:
            return await _full_record(session, ctx, workspace_id, user_id)

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, query: ListQuery
    ) -> list[MemberRecord]:
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "members.list", write=False)
        async with transaction_scope(self._sessions) as session:
            rows = (await session.execute(query.apply(_members(workspace_id)))).all()
            return await _with_access(session, ctx, workspace_id, rows)

    async def delete(self, ctx: RequestContext, workspace_id: UUID, member: str) -> None:
        """End the membership with its grants and group memberships; the account stays."""
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "members.delete", write=True)
        user_id = self._member_id(ctx, workspace_id, member)
        async with transaction_scope(self._sessions) as session:
            await lock_workspace(session, workspace_id)
            await _live_membership(session, workspace_id, user_id)
            require_not_self(ctx.user_id, user_id, "You cannot remove yourself.")
            await IdentityStoreService(session).remove_membership(user_id, workspace_id)
            await require_an_admin(session, workspace_id)
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="people",
                action="DeleteMember",
                target=member_name(workspace_id, user_id),
            )

    async def suspend(self, ctx: RequestContext, workspace_id: UUID, member: str) -> MemberRecord:
        """ACTIVE → SUSPENDED: the member keeps their grants but they stop authorizing."""
        return await self._transition(
            ctx, workspace_id, member, permission="members.suspend", target="suspended"
        )

    async def activate(self, ctx: RequestContext, workspace_id: UUID, member: str) -> MemberRecord:
        """SUSPENDED → ACTIVE."""
        return await self._transition(
            ctx, workspace_id, member, permission="members.activate", target="active"
        )

    async def _transition(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        member: str,
        *,
        permission: str,
        target: str,
    ) -> MemberRecord:
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), permission, write=True)
        user_id = self._member_id(ctx, workspace_id, member)
        async with transaction_scope(self._sessions) as session:
            await lock_workspace(session, workspace_id)
            membership = await _live_membership(session, workspace_id, user_id)
            if target == "suspended":
                require_not_self(ctx.user_id, user_id, "You cannot suspend yourself.")
            source = "active" if target == "suspended" else "suspended"
            if membership.status != source:
                raise FailedPrecondition(
                    f"Only a {source.upper()} member can become {target.upper()}.",
                    reason="MEMBER_NOT_ACTIVE" if source == "active" else "MEMBER_NOT_SUSPENDED",
                )
            membership.status = target
            await session.flush()
            if target == "suspended":
                await require_an_admin(session, workspace_id)
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="people",
                action="SuspendMember" if target == "suspended" else "ActivateMember",
                target=member_name(workspace_id, user_id),
            )
            return await _full_record(session, ctx, workspace_id, user_id)

    @staticmethod
    def _member_id(ctx: RequestContext, workspace_id: UUID, member: str) -> UUID:
        """The user ID of the ``{member}`` path segment (a user ID or ``me``)."""
        return parse_member_name(
            f"{workspace_name(workspace_id)}/members/{member}",
            workspace_id,
            field="name",
            me=ctx.user_id,
        )


# -- Queries --------------------------------------------------------------------


def _members(workspace_id: UUID) -> Select[tuple[TenantMembership, User]]:
    return (
        select(TenantMembership, User)
        .join(User, User.id == TenantMembership.user_id)
        .where(
            TenantMembership.tenant_id == workspace_id,
            TenantMembership.deleted_at.is_(None),
        )
    )


async def _live_membership(
    session: AsyncSession, workspace_id: UUID, user_id: UUID
) -> TenantMembership:
    membership = await session.scalar(
        select(TenantMembership)
        .where(
            TenantMembership.tenant_id == workspace_id,
            TenantMembership.user_id == user_id,
            TenantMembership.deleted_at.is_(None),
        )
        .with_for_update()
    )
    if membership is None:
        raise NotFound(f"Resource '{member_name(workspace_id, user_id)}' was not found.")
    return membership


async def _full_record(
    session: AsyncSession, ctx: RequestContext, workspace_id: UUID, user_id: UUID
) -> MemberRecord:
    row = (
        await session.execute(_members(workspace_id).where(TenantMembership.user_id == user_id))
    ).first()
    if row is None:
        raise NotFound(f"Resource '{member_name(workspace_id, user_id)}' was not found.")
    await session.refresh(row[0])
    return (await _with_access(session, ctx, workspace_id, [row]))[0]


async def _with_access(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    rows: Sequence[tuple[TenantMembership, User]],
) -> list[MemberRecord]:
    user_ids = [membership.user_id for membership, _ in rows]
    groups = await _groups_of(session, workspace_id, user_ids)
    roles = await _roles_of(session, workspace_id, user_ids)
    personal = await _personal_collection(session, workspace_id, ctx.user_id, user_ids)
    return [
        _record(
            membership,
            user,
            roles=roles.get(membership.user_id, ()),
            groups=tuple(group_name(workspace_id, code) for code in groups.get(membership.user_id, ())),
            personal_collection=personal if membership.user_id == ctx.user_id else None,
        )
        for membership, user in rows
    ]


def _record(
    membership: TenantMembership,
    user: User,
    *,
    roles: tuple[str, ...] = (),
    groups: tuple[str, ...] = (),
    personal_collection: str | None = None,
) -> MemberRecord:
    return MemberRecord(
        workspace_id=membership.tenant_id,
        user_id=membership.user_id,
        display_name=display_name_of(user),
        email=user.email,
        state=membership.status,
        joined_at=membership.joined_at,
        last_active_at=membership.last_active_at,
        roles=roles,
        groups=groups,
        personal_collection=personal_collection,
    )


async def _groups_of(
    session: AsyncSession, workspace_id: UUID, user_ids: Sequence[UUID]
) -> dict[UUID, list[str]]:
    rows = await session.execute(
        select(GroupMembership.user_id, Group.code)
        .join(Group, Group.id == GroupMembership.group_id)
        .where(
            Group.tenant_id == workspace_id,
            Group.deleted_at.is_(None),
            GroupMembership.user_id.in_(user_ids),
            GroupMembership.status == "active",
            GroupMembership.deleted_at.is_(None),
        )
        .order_by(Group.code)
    )
    result: dict[UUID, list[str]] = defaultdict(list)
    for user_id, code in rows:
        result[user_id].append(code)
    return result


async def _roles_of(
    session: AsyncSession, workspace_id: UUID, user_ids: Sequence[UUID]
) -> dict[UUID, tuple[str, ...]]:
    """Workspace roles bound to each user directly or through an active group membership."""
    via_group = (
        select(GroupMembership.user_id.label("user_id"), RoleAssignment.role_id.label("role_id"))
        .join(RoleAssignment, RoleAssignment.group_id == GroupMembership.group_id)
        .join(Group, Group.id == GroupMembership.group_id)
        .where(
            GroupMembership.user_id.in_(user_ids),
            GroupMembership.status == "active",
            GroupMembership.deleted_at.is_(None),
            Group.deleted_at.is_(None),
        )
    )
    direct = select(
        RoleAssignment.user_id.label("user_id"), RoleAssignment.role_id.label("role_id")
    ).where(RoleAssignment.user_id.in_(user_ids))
    grants = (
        direct.where(RoleAssignment.tenant_id == workspace_id, RoleAssignment.deleted_at.is_(None))
        .union(
            via_group.where(
                RoleAssignment.tenant_id == workspace_id, RoleAssignment.deleted_at.is_(None)
            )
        )
        .subquery()
    )
    rows = await session.execute(
        select(grants.c.user_id, Role)
        .join(Role, Role.id == grants.c.role_id)
        .where(Role.deleted_at.is_(None))
    )
    result: dict[UUID, set[str]] = defaultdict(set)
    for user_id, role in rows:
        result[user_id].add(role_name(role))
    return {user_id: tuple(sorted(names)) for user_id, names in result.items()}


async def _personal_collection(
    session: AsyncSession, workspace_id: UUID, caller_id: UUID, user_ids: Sequence[UUID]
) -> str | None:
    if caller_id not in user_ids:
        return None
    item_id = personal_collection_id(workspace_id, caller_id)
    return item_name(workspace_id, item_id) if await is_live_item(session, item_id) else None


def holds_role(role_tenant_id: UUID | None, code: str) -> ColumnElement[bool]:
    """EXISTS: the listed member holds the role directly or through a group (``roles:``).

    ``role_tenant_id`` is None for a predefined role, the workspace for a custom one.
    """
    role_match = select(Role.id).where(
        Role.code == code,
        Role.tenant_id.is_(None) if role_tenant_id is None else Role.tenant_id == role_tenant_id,
        Role.deleted_at.is_(None),
    )
    member_groups = select(GroupMembership.group_id).where(
        GroupMembership.user_id == TenantMembership.user_id,
        GroupMembership.status == "active",
        GroupMembership.deleted_at.is_(None),
    )
    return (
        select(RoleAssignment.id)
        .where(
            RoleAssignment.tenant_id == TenantMembership.tenant_id,
            RoleAssignment.deleted_at.is_(None),
            RoleAssignment.role_id.in_(role_match),
            or_(
                RoleAssignment.user_id == TenantMembership.user_id,
                RoleAssignment.group_id.in_(member_groups),
            ),
        )
        .exists()
    )


def in_group(group_workspace_id: UUID, code: str) -> ColumnElement[bool]:
    """EXISTS: the listed member actively belongs to the live group (``groups:``)."""
    return (
        select(GroupMembership.user_id)
        .join(Group, Group.id == GroupMembership.group_id)
        .where(
            Group.tenant_id == TenantMembership.tenant_id,
            Group.tenant_id == group_workspace_id,
            Group.code == code,
            Group.deleted_at.is_(None),
            GroupMembership.user_id == TenantMembership.user_id,
            GroupMembership.status == "active",
            GroupMembership.deleted_at.is_(None),
        )
        .exists()
    )


__all__ = [
    "DEFAULT_MEMBER_ROLE",
    "MemberService",
    "active_member_ids",
    "display_name_of",
    "holds_role",
    "in_group",
    "member_records",
]
