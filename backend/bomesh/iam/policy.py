"""IAM policies on workspaces, collections and spaces (google.iam.v1.Policy).

A policy is the set of live ``role_assignments`` set directly on one scope;
inherited bindings are never included. Principals are ``user:{userId}``,
``group:{groupId}`` (the Group resource ID, ``groups.code``) and ``workspaceMembers`` (collections only, with
``roles/collectionViewer``); space policies hold ``user:`` principals only.
The policy etag is a hash of the live bindings (``design.dbml``).

Rules enforced on write (``api_design.md`` §1):

- granting a role whose permissions (at that scope) the caller lacks there →
  PERMISSION_DENIED ``ROLE_ESCALATION``;
- changing the caller's own workspace bindings → ``SELF_MODIFICATION``;
- removing the last workspace admin / space lead → ``LAST_ADMIN`` /
  ``LAST_SPACE_LEAD``, checked under a lock on the scope row;
- a DOCUMENT has no policy → ``POLICY_ON_DOCUMENT``; a PERSONAL collection is
  not shareable → ``PERSONAL_COLLECTION``; a stale etag → ABORTED ``ETAG_MISMATCH``.
"""

from __future__ import annotations

import base64
import hashlib
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import ColumnElement, case, literal, or_, select
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import (
    Group,
    GroupMembership,
    Item,
    Role,
    RoleAssignment,
    RolePermission,
    Space,
    Tenant,
    TenantMembership,
)
from bomesh.errors import Aborted, FailedPrecondition, InvalidArgument, PermissionDenied
from bomesh.iam.authorizer import (
    Authorizer,
    ItemRef,
    Principal,
    SpaceRef,
    WorkspaceRef,
    not_found,
)
from bomesh.iam.catalog import Scope, conferred_permissions, PERMISSIONS_BY_NAME

PolicyResource = WorkspaceRef | ItemRef | SpaceRef

WORKSPACE_MEMBERS = "workspaceMembers"
WORKSPACE_ADMIN = "roles/workspaceAdmin"
COLLECTION_VIEWER = "roles/collectionViewer"
SPACE_LEAD = "roles/spaceLead"
PERSONAL_KIND = "personal_uploads"
_BINDINGS_FIELD = "policy.bindings"
#: A Group resource ID (CreateGroup ``groupId``), stored as ``groups.code``.
_GROUP_ID = re.compile(r"^[a-z][a-z0-9-]{0,62}$")


@dataclass(frozen=True, slots=True)
class Binding:
    """One role and the principals holding it on the policy's resource."""

    role: str
    members: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class Policy:
    bindings: tuple[Binding, ...]
    etag: str
    version: int = 1


@dataclass(frozen=True, slots=True)
class _Grant:
    """One (role, principal) pair; exactly one of ``user_id``/``group_id``/``all_members``."""

    role_id: UUID
    user_id: UUID | None = None
    group_id: UUID | None = None
    all_members: bool = False


@dataclass(frozen=True, slots=True)
class _Scope:
    resource: PolicyResource
    scope: Scope
    workspace_id: UUID

    @property
    def column(self):
        match self.resource:
            case WorkspaceRef(workspace_id=workspace_id):
                return RoleAssignment.tenant_id == workspace_id
            case ItemRef(item_id=item_id):
                return RoleAssignment.item_id == item_id
            case SpaceRef(space_id=space_id):
                return RoleAssignment.space_id == space_id

    def assignment(self, grant: _Grant, created_by: UUID | None) -> RoleAssignment:
        row = RoleAssignment(
            role_id=grant.role_id,
            user_id=grant.user_id,
            group_id=grant.group_id,
            all_members=grant.all_members,
            created_by_user_id=created_by,
        )
        match self.resource:
            case WorkspaceRef(workspace_id=workspace_id):
                row.tenant_id = workspace_id
            case ItemRef(item_id=item_id):
                row.item_id = item_id
            case SpaceRef(space_id=space_id):
                row.space_id = space_id
        return row


class PolicyStore:
    """Read and replace IAM policies inside the caller's transaction."""

    def __init__(self, session: AsyncSession, authorizer: Authorizer) -> None:
        self._session = session
        self._authorizer = authorizer

    async def get_policy(self, resource: PolicyResource) -> Policy:
        """The bindings set directly on ``resource`` and their etag."""
        scope = await self._scope(resource, for_update=False)
        current = await self._current(scope)
        return await self._policy(current)

    async def set_policy(
        self,
        principal: Principal,
        resource: PolicyResource,
        bindings: Sequence[Binding],
        *,
        etag: str | None = None,
    ) -> Policy:
        """Replace the policy of ``resource`` with ``bindings``; returns the new policy.

        The caller's ``*.setIamPolicy`` permission is the calling service's
        check; this enforces the policy rules listed in the module docstring.
        """
        scope = await self._scope(resource, for_update=True)
        if isinstance(resource, ItemRef) and await self._is_personal(resource.item_id):
            raise FailedPrecondition(
                "A PERSONAL collection cannot be shared.", reason="PERSONAL_COLLECTION"
            )
        current = await self._current(scope)
        if etag and etag != _etag(await self._names(current)):
            raise Aborted("The policy changed since it was read.", reason="ETAG_MISMATCH")
        desired = await self._parse(scope, bindings)
        added = set(desired) - set(current)
        removed = set(current) - set(desired)
        if not added and not removed:
            return await self._policy(current)
        await self._check_added(principal, scope, added)
        if isinstance(resource, WorkspaceRef):
            if _roles_of(principal.user_id, added | removed):
                raise FailedPrecondition(
                    "You cannot change your own workspace roles.",
                    reason="SELF_MODIFICATION",
                )
            await self._check_last(scope, removed, desired, WORKSPACE_ADMIN, "LAST_ADMIN")
        if isinstance(resource, SpaceRef):
            await self._check_last(scope, removed, desired, SPACE_LEAD, "LAST_SPACE_LEAD")
        now = datetime.now(UTC)
        for grant in removed:
            current[grant].deleted_at = now
        for grant in added:
            self._session.add(scope.assignment(grant, principal.user_id))
        await self._session.flush()
        return await self._policy(await self._current(scope))

    async def add_binding(
        self,
        resource: PolicyResource,
        role: str,
        member: str,
        *,
        created_by: UUID | None = None,
    ) -> bool:
        """Grant ``role`` to ``member`` on ``resource`` if not held; True when added.

        No escalation or last-holder rule: flows that grant a role
        (CreateMember, JoinSpace, ApproveRequest) check :meth:`require_grantable`.
        """
        scope = await self._scope(resource, for_update=False)
        grant = (await self._parse(scope, [Binding(role, (member,))])).pop()
        if grant in await self._current(scope):
            return False
        self._session.add(scope.assignment(grant, created_by))
        await self._session.flush()
        return True

    async def remove_member(self, resource: PolicyResource, member: str) -> int:
        """Drop every binding of ``member`` on ``resource``; returns how many ended."""
        scope = await self._scope(resource, for_update=False)
        target = await self._member(scope, member)
        now = datetime.now(UTC)
        ended = 0
        for grant, row in (await self._current(scope)).items():
            if (grant.user_id, grant.group_id, grant.all_members) == target:
                row.deleted_at = now
                ended += 1
        await self._session.flush()
        return ended

    async def require_grantable(
        self, principal: Principal, resource: PolicyResource, role: str
    ) -> None:
        """ROLE_ESCALATION unless the caller holds every permission ``role`` confers there."""
        scope = await self._scope(resource, for_update=False)
        role_row = await self._role(scope, role)
        await self._check_added(principal, scope, {_Grant(role_row.id, user_id=principal.user_id)})

    # -- Internals ----------------------------------------------------------

    async def _scope(self, resource: PolicyResource, *, for_update: bool) -> _Scope:
        match resource:
            case WorkspaceRef(workspace_id=workspace_id):
                statement = select(Tenant.id).where(Tenant.id == workspace_id)
                if await self._session.scalar(
                    statement.with_for_update() if for_update else statement
                ) is None:
                    raise not_found(resource)
                return _Scope(resource, Scope.WORKSPACE, workspace_id)
            case ItemRef(workspace_id=workspace_id, item_id=item_id):
                statement = select(Item.item_type).where(
                    Item.id == item_id,
                    Item.tenant_id == workspace_id,
                    Item.deleted_at.is_(None),
                )
                item_type = await self._session.scalar(
                    statement.with_for_update() if for_update else statement
                )
                if item_type is None:
                    raise not_found(resource)
                if item_type != "collection":
                    raise FailedPrecondition(
                        "Only a COLLECTION has an IAM policy.", reason="POLICY_ON_DOCUMENT"
                    )
                return _Scope(resource, Scope.COLLECTION, workspace_id)
            case SpaceRef(workspace_id=workspace_id, space_id=space_id):
                statement = select(Space.deleted_at).where(
                    Space.id == space_id, Space.tenant_id == workspace_id
                )
                row = (
                    await self._session.execute(
                        statement.with_for_update() if for_update else statement
                    )
                ).first()
                if row is None:
                    raise not_found(resource)
                if for_update and row.deleted_at is not None:
                    raise FailedPrecondition("The space is deleted.")
                return _Scope(resource, Scope.SPACE, workspace_id)

    async def _is_personal(self, item_id: UUID) -> bool:
        kind = await self._session.scalar(
            select(Item.metadata_["system_kind"].astext).where(Item.id == item_id)
        )
        return kind == PERSONAL_KIND

    async def _current(self, scope: _Scope) -> dict[_Grant, RoleAssignment]:
        rows = await self._session.scalars(
            select(RoleAssignment).where(RoleAssignment.deleted_at.is_(None), scope.column)
        )
        return {
            _Grant(row.role_id, row.user_id, row.group_id, row.all_members): row
            for row in rows
        }

    async def _names(self, grants: Iterable[_Grant]) -> dict[str, set[str]]:
        grants = list(grants)
        roles = {
            role.id: role
            for role in await self._session.scalars(
                select(Role).where(Role.id.in_({grant.role_id for grant in grants}))
            )
        }
        group_ids = {grant.group_id for grant in grants if grant.group_id is not None}
        group_codes: dict[UUID, str] = {}
        if group_ids:
            rows = await self._session.execute(
                select(Group.id, Group.code).where(Group.id.in_(group_ids))
            )
            group_codes = {group_id: code for group_id, code in rows}
        bindings: dict[str, set[str]] = {}
        for grant in grants:
            bindings.setdefault(role_name(roles[grant.role_id]), set()).add(
                _member_name(grant, group_codes)
            )
        return bindings

    async def _policy(self, current: dict[_Grant, RoleAssignment]) -> Policy:
        names = await self._names(current)
        return Policy(
            bindings=tuple(
                Binding(role, tuple(sorted(members))) for role, members in sorted(names.items())
            ),
            etag=_etag(names),
        )

    async def _role(self, scope: _Scope, name: str) -> Role:
        """Resolve a role name valid on ``scope``, else INVALID_ARGUMENT."""
        parts = name.split("/")
        if len(parts) == 2 and parts[0] == "roles":
            role = await self._session.scalar(
                select(Role).where(Role.tenant_id.is_(None), Role.code == parts[1])
            )
            if role is not None and role.scope_type == scope.scope.value:
                return role
        elif (
            len(parts) == 4
            and parts[0] == "workspaces"
            and parts[1] == str(scope.workspace_id)
            and parts[2] == "roles"
        ):
            role = await self._session.scalar(
                select(Role).where(
                    Role.tenant_id == scope.workspace_id,
                    Role.code == parts[3],
                    Role.deleted_at.is_(None),
                )
            )
            if role is not None:
                return role
        raise InvalidArgument.for_field(
            _BINDINGS_FIELD, f"Role '{name}' cannot be granted on this resource."
        )

    async def _parse(self, scope: _Scope, bindings: Sequence[Binding]) -> set[_Grant]:
        grants: set[_Grant] = set()
        for binding in bindings:
            role = await self._role(scope, binding.role)
            for member in binding.members:
                user_id, group_id, all_members = await self._member(scope, member)
                if all_members and binding.role != COLLECTION_VIEWER:
                    raise InvalidArgument.for_field(
                        _BINDINGS_FIELD,
                        f"'{WORKSPACE_MEMBERS}' may only hold '{COLLECTION_VIEWER}'.",
                    )
                grants.add(_Grant(role.id, user_id, group_id, all_members))
        return grants

    async def _check_added(
        self, principal: Principal, scope: _Scope, added: set[_Grant]
    ) -> None:
        if not added:
            return
        held = await self._held(principal, scope.resource)
        for grant in added:
            conferred = conferred_permissions(await self._permissions(grant.role_id), scope.scope)
            if not conferred <= held:
                raise PermissionDenied(
                    "You cannot grant a role with permissions you do not hold here.",
                    reason="ROLE_ESCALATION",
                )
        for user_id in {grant.user_id for grant in added if grant.user_id is not None}:
            if not await self._is_active_member(user_id, scope.workspace_id):
                raise FailedPrecondition(
                    f"user:{user_id} is not an active workspace member.",
                    reason="NOT_WORKSPACE_MEMBER",
                )

    async def _member(
        self, scope: _Scope, member: str
    ) -> tuple[UUID | None, UUID | None, bool]:
        """``(user_id, group_id, all_members)`` of one principal string.

        ``user:{userId}``, ``group:{groupId}`` (the group's resource ID, a live
        group of the scope's workspace) or ``workspaceMembers``.
        """
        if member == WORKSPACE_MEMBERS:
            if scope.scope is not Scope.COLLECTION:
                raise _invalid(f"'{WORKSPACE_MEMBERS}' is allowed on collections only.")
            return None, None, True
        kind, _, value = member.partition(":")
        if kind == "user":
            try:
                return UUID(value), None, False
            except ValueError:
                pass
        elif kind == "group" and _GROUP_ID.match(value):
            if scope.scope is Scope.SPACE:
                raise _invalid("Space policies hold 'user:' principals only.")
            group_id = await self._session.scalar(
                select(Group.id).where(
                    Group.tenant_id == scope.workspace_id,
                    Group.code == value,
                    Group.deleted_at.is_(None),
                )
            )
            if group_id is None:
                raise _invalid(f"'{member}' is not a group of this workspace.")
            return None, group_id, False
        raise _invalid(f"Invalid principal '{member}'.")

    async def _held(self, principal: Principal, resource: PolicyResource) -> frozenset[str]:
        match resource:
            case WorkspaceRef(workspace_id=workspace_id):
                return await self._authorizer.workspace_permissions(principal, workspace_id)
            case ItemRef(item_id=item_id):
                return await self._authorizer.collection_permissions(principal, item_id)
            case SpaceRef(space_id=space_id):
                return await self._authorizer.space_permissions(principal, space_id)

    async def _permissions(self, role_id: UUID) -> frozenset[str]:
        codes = await self._session.scalars(
            select(RolePermission.permission_code).where(RolePermission.granted_by(role_id))
        )
        return frozenset(code for code in codes if code in PERMISSIONS_BY_NAME)

    async def _check_last(
        self,
        scope: _Scope,
        removed: set[_Grant],
        desired: set[_Grant],
        role: str,
        reason: str,
    ) -> None:
        role_row = await self._role(scope, role)
        if not any(grant.role_id == role_row.id for grant in removed):
            return
        holders = {grant for grant in desired if grant.role_id == role_row.id}
        users = {grant.user_id for grant in holders if grant.user_id is not None}
        groups = {grant.group_id for grant in holders if grant.group_id is not None}
        if not await _active_members(self._session, scope.workspace_id, users, groups):
            label = "workspace admin" if reason == "LAST_ADMIN" else "space lead"
            raise FailedPrecondition(f"The last {label} cannot be removed.", reason=reason)

    async def _is_active_member(self, user_id: UUID, workspace_id: UUID) -> bool:
        status = await self._session.scalar(
            select(TenantMembership.status).where(
                TenantMembership.user_id == user_id,
                TenantMembership.tenant_id == workspace_id,
                TenantMembership.deleted_at.is_(None),
            )
        )
        return status == "active"


async def workspace_admins(session: AsyncSession, workspace_id: UUID) -> frozenset[UUID]:
    """Active members holding ``roles/workspaceAdmin``, directly or through a group.

    For LAST_ADMIN checks of DeleteMember and SuspendMember.
    """
    rows = await session.execute(
        select(RoleAssignment.user_id, RoleAssignment.group_id)
        .join(Role, Role.id == RoleAssignment.role_id)
        .where(
            RoleAssignment.deleted_at.is_(None),
            RoleAssignment.tenant_id == workspace_id,
            Role.tenant_id.is_(None),
            Role.code == WORKSPACE_ADMIN.removeprefix("roles/"),
        )
    )
    users: set[UUID] = set()
    groups: set[UUID] = set()
    for user_id, group_id in rows:
        if user_id is not None:
            users.add(user_id)
        if group_id is not None:
            groups.add(group_id)
    return await _active_members(session, workspace_id, users, groups)


async def space_leads(session: AsyncSession, space_id: UUID) -> frozenset[UUID]:
    """Users holding ``roles/spaceLead`` on the space (LAST_SPACE_LEAD checks)."""
    return frozenset(
        await session.scalars(
            select(RoleAssignment.user_id)
            .join(Role, Role.id == RoleAssignment.role_id)
            .where(
                RoleAssignment.deleted_at.is_(None),
                RoleAssignment.space_id == space_id,
                Role.tenant_id.is_(None),
                Role.code == SPACE_LEAD.removeprefix("roles/"),
            )
        )
    )


PLATFORM_ROLES = ("roles/platformAdmin", "roles/platformOperator")


def platform_role_column(user_id: ColumnElement[UUID]) -> ColumnElement[str | None]:
    """Correlated scalar ``User.platformRole``: ``roles/platformAdmin`` before
    ``roles/platformOperator``, NULL without a platform role.

    Usable in a select list (``select(User, platform_role_column(User.id))``)
    and as a filter or order expression, so lists need no per-row query.
    """
    codes = [name.removeprefix("roles/") for name in PLATFORM_ROLES]
    precedence = case(
        *((Role.code == code, rank) for rank, code in enumerate(codes)),
        else_=len(codes),
    )
    return (
        select(literal("roles/") + Role.code)
        .join(RoleAssignment, RoleAssignment.role_id == Role.id)
        .where(
            RoleAssignment.user_id == user_id,
            RoleAssignment.deleted_at.is_(None),
            RoleAssignment.tenant_id.is_(None),
            RoleAssignment.item_id.is_(None),
            RoleAssignment.space_id.is_(None),
            Role.tenant_id.is_(None),
            Role.scope_type == Scope.PLATFORM.value,
            Role.code.in_(codes),
        )
        .order_by(precedence)
        .limit(1)
        .scalar_subquery()
    )


async def platform_role(session: AsyncSession, user_id: UUID) -> str | None:
    """The user's platform role (``User.platformRole``): a ``PLATFORM_ROLES`` name or None."""
    user = literal(user_id, PG_UUID(as_uuid=True))
    return await session.scalar(select(platform_role_column(user)))


async def set_platform_role(
    session: AsyncSession, user_id: UUID, role: str | None, *, created_by: UUID | None = None
) -> bool:
    """Make ``role`` (or none) the user's only platform role; True when anything changed."""
    if role is not None and role not in PLATFORM_ROLES:
        raise InvalidArgument.for_field("platformRole", f"Unknown platform role '{role}'.")
    if await platform_role(session, user_id) == role:
        return False
    now = datetime.now(UTC)
    for row in await session.scalars(
        select(RoleAssignment)
        .join(Role, Role.id == RoleAssignment.role_id)
        .where(
            RoleAssignment.user_id == user_id,
            RoleAssignment.deleted_at.is_(None),
            Role.tenant_id.is_(None),
            Role.scope_type == Scope.PLATFORM.value,
        )
    ):
        row.deleted_at = now
    if role is not None:
        role_id = await session.scalar(
            select(Role.id).where(Role.tenant_id.is_(None), Role.code == role.removeprefix("roles/"))
        )
        if role_id is None:
            raise RuntimeError("predefined roles are missing; run bomesh.iam.sync")
        session.add(RoleAssignment(user_id=user_id, role_id=role_id, created_by_user_id=created_by))
    await session.flush()
    return True



def role_name(role: Role) -> str:
    """``roles/{role}`` for a predefined role, ``workspaces/{w}/roles/{role}`` for a custom one."""
    if role.tenant_id is None:
        return f"roles/{role.code}"
    return f"workspaces/{role.tenant_id}/roles/{role.code}"


async def _active_members(
    session: AsyncSession, workspace_id: UUID, users: set[UUID], groups: set[UUID]
) -> frozenset[UUID]:
    """Active members among ``users`` and the active members of ``groups``."""
    if not users and not groups:
        return frozenset()
    via_group = select(GroupMembership.user_id).join(
        Group, Group.id == GroupMembership.group_id
    ).where(
        GroupMembership.group_id.in_(groups),
        GroupMembership.status == "active",
        GroupMembership.deleted_at.is_(None),
        Group.deleted_at.is_(None),
    )
    return frozenset(
        await session.scalars(
            select(TenantMembership.user_id).where(
                TenantMembership.tenant_id == workspace_id,
                TenantMembership.status == "active",
                TenantMembership.deleted_at.is_(None),
                or_(TenantMembership.user_id.in_(users), TenantMembership.user_id.in_(via_group)),
            )
        )
    )


def _invalid(description: str) -> InvalidArgument:
    return InvalidArgument.for_field(_BINDINGS_FIELD, description)


def _member_name(grant: _Grant, group_codes: dict[UUID, str]) -> str:
    if grant.all_members:
        return WORKSPACE_MEMBERS
    if grant.group_id is not None:
        return f"group:{group_codes[grant.group_id]}"
    return f"user:{grant.user_id}"


def _roles_of(user_id: UUID, grants: Iterable[_Grant]) -> bool:
    return any(grant.user_id == user_id for grant in grants)


def _etag(bindings: dict[str, set[str]]) -> str:
    canonical = "\n".join(
        f"{role}={','.join(sorted(members))}" for role, members in sorted(bindings.items())
    )
    return base64.b64encode(hashlib.sha256(canonical.encode()).digest()[:12]).decode()


__all__ = [
    "COLLECTION_VIEWER",
    "PLATFORM_ROLES",
    "SPACE_LEAD",
    "WORKSPACE_ADMIN",
    "WORKSPACE_MEMBERS",
    "Binding",
    "Policy",
    "PolicyResource",
    "PolicyStore",
    "platform_role",
    "platform_role_column",
    "role_name",
    "set_platform_role",
    "space_leads",
    "workspace_admins",
]
