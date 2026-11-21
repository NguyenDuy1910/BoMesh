"""Who may do what: effective permissions and the AIP-211 check.

A permission reaches a caller only through a role assignment
(``role_assignments``) at one scope:

- platform: user grants with no scope column, confer ``Scope.PLATFORM``
  permissions on platform resources and on workspaces (cross-workspace
  metadata), never on items or spaces;
- workspace: user or group grants on the tenant, held only while the
  membership is ACTIVE; they reach every collection and space of the workspace;
- collection: user, group or ``all_members`` grants on the governing chain of
  an item, up to and including the first collection with
  ``inherit_access = false`` (``item_model.md`` §6.2);
- space: user grants on the space.

A grant at scope S confers only the role permissions valid at S
(``catalog.conferred_permissions``). Lookups are memoized for the life of one
:class:`Authorizer`, which is created per request: a grant, revoke, move or
delete is effective at the next request. The workspace row itself
(:meth:`Authorizer.workspace`) is memoized the same way.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, Row, and_, literal, or_, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
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
from bomesh.errors import NotFound, PermissionDenied
from bomesh.iam.catalog import PERMISSIONS_BY_NAME, Scope, permissions_at_scope

_COLLECTION_SCOPED = permissions_at_scope(Scope.COLLECTION)
_SPACE_SCOPED = permissions_at_scope(Scope.SPACE)


@dataclass(frozen=True, slots=True)
class Principal:
    """The authenticated user of a request.

    ``session_id`` names the access session the bearer token resolved to; it is
    ``None`` only for work done on a user's behalf outside a request (agent
    tools, workflows, scripts).
    """

    user_id: UUID
    session_id: UUID | None = None


@dataclass(frozen=True, slots=True)
class WorkspaceRef:
    """``workspaces/{workspace}``."""

    workspace_id: UUID

    @property
    def name(self) -> str:
        return f"workspaces/{self.workspace_id}"


@dataclass(frozen=True, slots=True)
class ItemRef:
    """``workspaces/{workspace}/items/{item}``: permissions come from collection grants."""

    workspace_id: UUID
    item_id: UUID

    @property
    def name(self) -> str:
        return f"workspaces/{self.workspace_id}/items/{self.item_id}"


@dataclass(frozen=True, slots=True)
class SpaceRef:
    """``workspaces/{workspace}/spaces/{space}``."""

    workspace_id: UUID
    space_id: UUID

    @property
    def name(self) -> str:
        return f"workspaces/{self.workspace_id}/spaces/{self.space_id}"


@dataclass(frozen=True, slots=True)
class PlatformRef:
    """A platform resource (``users/{user}``, ``connectors/{connector}``, ``workspaces``).

    ``name`` is only used in error messages; existence is the caller's check.
    """

    name: str = ""


Resource = WorkspaceRef | ItemRef | SpaceRef | PlatformRef


@dataclass(frozen=True, slots=True)
class ItemNode:
    """One item of an ancestry path, nearest first (depth 0 is the item itself)."""

    item_id: UUID
    tenant_id: UUID
    item_kind: str
    item_type: str
    parent_item_id: UUID | None
    #: Collections only; ``None`` on a document (never an access boundary).
    inherit_access: bool | None
    deleted_at: datetime | None
    is_published: bool | None


def permission_denied(permission: str, resource: Resource) -> PermissionDenied:
    """The AIP-211 answer: the same whether or not ``resource`` exists."""
    return PermissionDenied(
        f"Permission '{permission}' denied on resource '{resource.name}' "
        "(or it might not exist)",
        metadata={"permission": permission, "resource": resource.name},
    )


def not_found(resource: Resource) -> NotFound:
    return NotFound(f"Resource '{resource.name}' was not found.")


class Authorizer:
    """Request-scoped permission resolver with memoized lookups.

    Every lookup is a read of its own, outside the caller's transactions: it
    sees what was committed before it ran and never the caller's uncommitted
    writes, so an Authorizer can be used before, between and after the
    caller's write transactions. Inside :meth:`keep_connection` (the API holds
    it for the endpoint) the lookups share one pooled connection; elsewhere
    each runs in its own short read transaction.
    """

    def __init__(self, sessions: SessionFactory) -> None:
        self._sessions = sessions
        self._keep = False
        self._kept: AsyncSession | None = None
        self._kept_lock = asyncio.Lock()
        self._reader: asyncio.Task[Any] | None = None
        self._platform: dict[UUID, frozenset[str]] = {}
        self._member: dict[tuple[UUID, UUID], bool] = {}
        self._memberships: dict[UUID, frozenset[UUID]] = {}
        self._groups: dict[tuple[UUID, UUID], frozenset[UUID]] = {}
        self._workspace: dict[tuple[UUID, UUID], frozenset[str]] = {}
        self._ancestry: dict[UUID, tuple[ItemNode, ...]] = {}
        self._collection: dict[tuple[UUID, UUID, bool], frozenset[str]] = {}
        self._space: dict[tuple[UUID, UUID], frozenset[str]] = {}
        self._allowed: dict[tuple[UUID, UUID, str, bool], frozenset[UUID]] = {}
        self._collections: dict[tuple[UUID, bool], frozenset[UUID]] = {}
        self._workspaces: dict[UUID, Tenant | None] = {}
        self._space_workspaces: dict[UUID, UUID | None] = {}

    # -- Connection ---------------------------------------------------------

    @asynccontextmanager
    async def keep_connection(self) -> AsyncIterator[None]:
        """Let the lookups made inside the block share one pooled connection.

        The first uncached lookup opens it; leaving the block returns it to
        the pool, after which lookups open their own again. It runs in
        autocommit: each lookup is one statement with its own snapshot, and
        no transaction, snapshot or lock is held between lookups.
        """
        self._keep = True
        try:
            yield
        finally:
            self._keep = False
            async with self._kept_lock:
                await self._release()

    @asynccontextmanager
    async def _reading(self) -> AsyncIterator[AsyncSession]:
        """The session one lookup reads with (see :meth:`keep_connection`).

        The kept session serves one lookup at a time; a lookup nested in
        another of the same task reuses it.
        """
        if not self._keep:
            async with transaction_scope(self._sessions) as session:
                yield session
            return
        task = asyncio.current_task()
        if self._kept is not None and self._reader is task:
            yield self._kept
            return
        async with self._kept_lock:
            self._reader = task
            try:
                if self._kept is None:
                    self._kept = self._sessions()
                    await self._kept.connection(
                        execution_options={"isolation_level": "AUTOCOMMIT"}
                    )
                yield self._kept
            except BaseException:
                # A failed or cancelled read must not leave a doubtful connection kept.
                await self._release()
                raise
            finally:
                self._reader = None

    async def _release(self) -> None:
        kept, self._kept = self._kept, None
        if kept is not None:
            await kept.close()

    # -- Scopes -------------------------------------------------------------

    async def platform_permissions(self, principal: Principal) -> frozenset[str]:
        """Permissions of the caller's platform roles (``platformRole``)."""
        cached = self._platform.get(principal.user_id)
        if cached is None:
            async with self._reading() as session:
                rows = await session.execute(
                    _grants()
                    .where(
                        RoleAssignment.user_id == principal.user_id,
                        RoleAssignment.tenant_id.is_(None),
                        RoleAssignment.item_id.is_(None),
                        RoleAssignment.space_id.is_(None),
                        Role.scope_type == Scope.PLATFORM.value,
                    )
                )
                cached = _conferred(rows, Scope.PLATFORM)
            self._platform[principal.user_id] = cached
        return cached

    async def is_active_member(self, principal: Principal, workspace_id: UUID) -> bool:
        """Whether the caller holds an ACTIVE membership of the workspace."""
        key = (principal.user_id, workspace_id)
        cached = self._member.get(key)
        if cached is None:
            async with self._reading() as session:
                cached = await _is_active_member(session, principal.user_id, workspace_id)
            self._member[key] = cached
        return cached

    async def active_members(
        self, user_ids: Iterable[UUID], workspace_id: UUID
    ) -> frozenset[UUID]:
        """The users holding an ACTIVE membership of the workspace, in one query."""
        users = frozenset(user_ids)
        missing = {user_id for user_id in users if (user_id, workspace_id) not in self._member}
        if missing:
            async with self._reading() as session:
                active = set(
                    await session.scalars(
                        select(TenantMembership.user_id).where(
                            TenantMembership.tenant_id == workspace_id,
                            TenantMembership.user_id.in_(missing),
                            TenantMembership.status == "active",
                            TenantMembership.deleted_at.is_(None),
                        )
                    )
                )
            for user_id in missing:
                self._member[(user_id, workspace_id)] = user_id in active
        return frozenset(user_id for user_id in users if self._member[(user_id, workspace_id)])

    async def group_ids(self, principal: Principal, workspace_id: UUID) -> frozenset[UUID]:
        """The live groups of the workspace the caller actively belongs to."""
        key = (principal.user_id, workspace_id)
        cached = self._groups.get(key)
        if cached is None:
            async with self._reading() as session:
                cached = frozenset(
                    await session.scalars(
                        select(Group.id)
                        .join(GroupMembership, GroupMembership.group_id == Group.id)
                        .where(
                            Group.tenant_id == workspace_id,
                            Group.deleted_at.is_(None),
                            GroupMembership.user_id == principal.user_id,
                            GroupMembership.deleted_at.is_(None),
                        )
                    )
                )
            self._groups[key] = cached
        return cached

    async def workspace_permissions(
        self, principal: Principal, workspace_id: UUID
    ) -> frozenset[str]:
        """Tenant-scope grants of the caller or their groups; empty unless an ACTIVE member."""
        key = (principal.user_id, workspace_id)
        cached = self._workspace.get(key)
        if cached is None:
            cached = frozenset()
            if await self.is_active_member(principal, workspace_id):
                groups = await self.group_ids(principal, workspace_id)
                async with self._reading() as session:
                    rows = await session.execute(
                        _grants().where(
                            RoleAssignment.tenant_id == workspace_id,
                            _held_by(principal, groups, all_members=False),
                        )
                    )
                    cached = _conferred(rows, Scope.WORKSPACE)
            self._workspace[key] = cached
        return cached

    async def member_workspaces(self, principal: Principal) -> frozenset[UUID]:
        """Workspaces where the caller holds an ACTIVE membership."""
        cached = self._memberships.get(principal.user_id)
        if cached is None:
            async with self._reading() as session:
                cached = frozenset(
                    await session.scalars(
                        select(TenantMembership.tenant_id).where(
                            TenantMembership.user_id == principal.user_id,
                            TenantMembership.status == "active",
                            TenantMembership.deleted_at.is_(None),
                        )
                    )
                )
            self._memberships[principal.user_id] = cached
        return cached

    async def workspace(self, workspace_id: UUID) -> Tenant | None:
        """The workspace row whatever its state; ``None`` if it does not exist.

        Detached and memoized like every lookup: a service that changes the
        workspace reads it again in its own transaction.
        """
        if workspace_id not in self._workspaces:
            async with self._reading() as session:
                workspace = await session.get(Tenant, workspace_id)
                if workspace is not None:
                    session.expunge(workspace)
            self._workspaces[workspace_id] = workspace
        return self._workspaces[workspace_id]

    async def ancestry(self, item_id: UUID) -> tuple[ItemNode, ...]:
        """The item and every ancestor, nearest first; empty if the item does not exist."""
        return (await self.ancestries((item_id,)))[item_id]

    async def ancestries(self, item_ids: Iterable[UUID]) -> dict[UUID, tuple[ItemNode, ...]]:
        """:meth:`ancestry` of each item; the uncached ones in one recursive query.

        Every ancestor's own path (a suffix of a fetched path) is memoized too.
        """
        ids = list(dict.fromkeys(item_ids))
        missing = [item_id for item_id in ids if item_id not in self._ancestry]
        if missing:
            async with self._reading() as session:
                paths = await item_ancestries(session, missing)
            for item_id in missing:
                path = paths.get(item_id, ())
                self._ancestry[item_id] = path
                for depth in range(1, len(path)):
                    self._ancestry.setdefault(path[depth].item_id, path[depth:])
        return {item_id: self._ancestry[item_id] for item_id in ids}

    async def governing_collection(self, item_id: UUID) -> UUID | None:
        """The nearest COLLECTION of the item's canonical path, the item itself included."""
        for node in await self.ancestry(item_id):
            if node.item_kind == "collection":
                return node.item_id
        return None

    async def collection_permissions(
        self, principal: Principal, item_id: UUID, *, include_deleted: bool = False
    ) -> frozenset[str]:
        """Effective permissions on an item (``item_model.md`` §6.2).

        Tenant grants ∪ grants on the governing chain up to the first
        collection with ``inherit_access = false`` (``all_members`` included).
        Empty when the item does not exist, the caller is not an ACTIVE member
        of its workspace, or (unless ``include_deleted``) the item or any
        ancestor is DELETED. With ``include_deleted`` grants resolve through
        the deleted cohort.
        """
        key = (item_id, include_deleted)
        return (await self.collection_permissions_many(principal, (key,)))[key]

    async def collection_permissions_many(
        self, principal: Principal, keys: Iterable[tuple[UUID, bool]]
    ) -> dict[tuple[UUID, bool], frozenset[str]]:
        """:meth:`collection_permissions` of each ``(item_id, include_deleted)``.

        The uncached ones cost one ancestry query and one grants query per workspace.
        """
        wanted = list(dict.fromkeys(keys))
        missing = [
            key for key in wanted if (principal.user_id, *key) not in self._collection
        ]
        if missing:
            paths = await self.ancestries(item_id for item_id, _ in missing)
            chains: dict[UUID, dict[tuple[UUID, bool], tuple[UUID, ...]]] = {}
            for item_id, include_deleted in missing:
                path = paths[item_id]
                if path and (include_deleted or all(node.deleted_at is None for node in path)):
                    chains.setdefault(path[0].tenant_id, {})[(item_id, include_deleted)] = (
                        governing_chain(path)
                    )
                else:
                    self._collection[(principal.user_id, item_id, include_deleted)] = frozenset()
            for workspace_id, by_key in chains.items():
                tenant = await self.workspace_permissions(principal, workspace_id)
                member = await self.is_active_member(principal, workspace_id)
                granted: dict[UUID, list[tuple[str, str]]] = {}
                collections = {collection for chain in by_key.values() for collection in chain}
                if member and collections:
                    groups = await self.group_ids(principal, workspace_id)
                    async with self._reading() as session:
                        rows = await session.execute(
                            _grants()
                            .add_columns(RoleAssignment.item_id)
                            .where(
                                RoleAssignment.item_id.in_(collections),
                                _held_by(principal, groups, all_members=True),
                            )
                        )
                        for scope_type, code, collection in rows:
                            granted.setdefault(collection, []).append((scope_type, code))
                for (item_id, include_deleted), chain in by_key.items():
                    result: frozenset[str] = frozenset()
                    if member:
                        result = (tenant & _COLLECTION_SCOPED) | _conferred(
                            (row for collection in chain for row in granted.get(collection, ())),
                            Scope.COLLECTION,
                        )
                    self._collection[(principal.user_id, item_id, include_deleted)] = result
        return {key: self._collection[(principal.user_id, *key)] for key in wanted}

    async def space_permissions(self, principal: Principal, space_id: UUID) -> frozenset[str]:
        """Workspace grants valid on spaces ∪ the caller's grants on the space."""
        key = (principal.user_id, space_id)
        cached = self._space.get(key)
        if cached is not None:
            return cached
        result: frozenset[str] = frozenset()
        workspace_id = await self._space_workspace(space_id)
        if workspace_id is not None:
            tenant = await self.workspace_permissions(principal, workspace_id)
            if await self.is_active_member(principal, workspace_id):
                async with self._reading() as session:
                    rows = await session.execute(
                        _grants().where(
                            RoleAssignment.space_id == space_id,
                            RoleAssignment.user_id == principal.user_id,
                        )
                    )
                    result = (tenant & _SPACE_SCOPED) | _conferred(rows, Scope.SPACE)
        self._space[key] = result
        return result

    async def permissions(
        self, principal: Principal, resource: Resource, *, include_deleted: bool = False
    ) -> frozenset[str]:
        """Every permission the caller holds on ``resource``.

        Platform grants count on platform resources and workspaces only. An
        item or space outside ``resource.workspace_id`` yields nothing.
        """
        match resource:
            case PlatformRef():
                return await self.platform_permissions(principal)
            case WorkspaceRef(workspace_id=workspace_id):
                return await self.workspace_permissions(
                    principal, workspace_id
                ) | await self.platform_permissions(principal)
            case ItemRef(workspace_id=workspace_id, item_id=item_id):
                path = await self.ancestry(item_id)
                if not path or path[0].tenant_id != workspace_id:
                    return frozenset()
                return await self.collection_permissions(
                    principal, item_id, include_deleted=include_deleted
                )
            case SpaceRef(workspace_id=workspace_id, space_id=space_id):
                if await self._space_workspace(space_id) != workspace_id:
                    return frozenset()
                return await self.space_permissions(principal, space_id)

    async def test_permissions(
        self, principal: Principal, resource: Resource, permissions: Iterable[str]
    ) -> frozenset[str]:
        """The subset of ``permissions`` the caller holds on ``resource`` (TestIamPermissions)."""
        held = await self.permissions(principal, resource)
        return frozenset(permissions) & held

    async def require(
        self,
        principal: Principal,
        permission: str,
        resource: Resource,
        *,
        include_deleted: bool = False,
    ) -> None:
        """Enforce ``permission`` on ``resource`` (``api_design.md`` §1, AIP-211).

        Without the permission → PERMISSION_DENIED, whether or not the
        resource exists. NOT_FOUND only when the caller holds the permission
        at the parent scope (the workspace, or the platform for a workspace)
        and the resource is missing.
        """
        if permission not in PERMISSIONS_BY_NAME:
            raise ValueError(f"unknown permission {permission!r}")
        if permission in await self.permissions(
            principal, resource, include_deleted=include_deleted
        ):
            if isinstance(resource, WorkspaceRef) and await self.workspace(
                resource.workspace_id
            ) is None:
                raise not_found(resource)
            return
        if await self._held_on_parent(principal, permission, resource) and not (
            await self._exists(resource, include_deleted=include_deleted)
        ):
            raise not_found(resource)
        raise permission_denied(permission, resource)

    async def allowed_collections(
        self,
        principal: Principal,
        workspace_id: UUID,
        permission: str,
        *,
        include_deleted: bool = False,
    ) -> frozenset[UUID]:
        """Collections of the workspace on which the caller holds ``permission``.

        By default only live collections whose every ancestor is live count:
        the PostgreSQL side of lists and search (and the Qdrant pre-filter).
        With ``include_deleted`` grants also resolve through deleted cohorts
        and deleted collections are included (``showDeleted`` lists).
        """
        key = (principal.user_id, workspace_id, permission, include_deleted)
        cached = self._allowed.get(key)
        if cached is not None:
            return cached
        result: frozenset[UUID] = frozenset()
        if permission in _COLLECTION_SCOPED and await self.is_active_member(
            principal, workspace_id
        ):
            if permission in await self.workspace_permissions(principal, workspace_id):
                result = await self._every_collection(workspace_id, include_deleted)
            else:
                groups = await self.group_ids(principal, workspace_id)
                async with self._reading() as session:
                    result = await _reachable_collections(
                        session,
                        workspace_id,
                        seeds=_granted_collections(principal, groups, permission),
                        include_deleted=include_deleted,
                    )
        self._allowed[key] = result
        return result

    async def _every_collection(self, workspace_id: UUID, include_deleted: bool) -> frozenset[UUID]:
        """Every collection a tenant-wide grant reaches, whatever the permission (memoized)."""
        key = (workspace_id, include_deleted)
        cached = self._collections.get(key)
        if cached is None:
            async with self._reading() as session:
                cached = await _reachable_collections(
                    session, workspace_id, seeds=None, include_deleted=include_deleted
                )
            self._collections[key] = cached
        return cached

    async def allowed_spaces(
        self, principal: Principal, workspace_id: UUID, permission: str
    ) -> frozenset[UUID]:
        """Spaces of the workspace on which the caller holds ``permission``.

        The set form of :meth:`space_permissions`: every space of the workspace
        for a tenant-wide holder, else the spaces whose user grants confer it.
        """
        if permission not in _SPACE_SCOPED or not await self.is_active_member(
            principal, workspace_id
        ):
            return frozenset()
        statement = select(Space.id).where(Space.tenant_id == workspace_id)
        if permission not in await self.workspace_permissions(principal, workspace_id):
            statement = (
                statement.join(RoleAssignment, RoleAssignment.space_id == Space.id)
                .join(Role, and_(Role.id == RoleAssignment.role_id, Role.deleted_at.is_(None)))
                .join(RolePermission, RolePermission.granted_by(Role.id))
                .where(
                    RoleAssignment.deleted_at.is_(None),
                    RoleAssignment.user_id == principal.user_id,
                    RolePermission.permission_code == permission,
                )
            )
        async with self._reading() as session:
            return frozenset(await session.scalars(statement.distinct()))

    async def holders_permissions(
        self, user_ids: Iterable[UUID], resources: Iterable[Resource]
    ) -> dict[Resource, dict[UUID, frozenset[str]]]:
        """:meth:`permissions` of every user on every resource (fan-out, audiences).

        ``result[resource][user]`` equals ``permissions(Principal(user), resource)``.
        The cost is constant in users and resources: one ancestry query, then
        platform grants, per workspace its ACTIVE members, their groups and
        tenant grants, and the grants on every item chain and space at once.
        """
        users = frozenset(user_ids)
        wanted = list(dict.fromkeys(resources))
        result: dict[Resource, dict[UUID, frozenset[str]]] = {
            resource: dict.fromkeys(users, frozenset()) for resource in wanted
        }
        if not users or not wanted:
            return result
        items = [resource for resource in wanted if isinstance(resource, ItemRef)]
        spaces = [resource for resource in wanted if isinstance(resource, SpaceRef)]
        paths = await self.ancestries(ref.item_id for ref in items)
        chains = {
            ref: governing_chain(path)
            for ref in items
            if (path := paths[ref.item_id])
            and path[0].tenant_id == ref.workspace_id
            and all(node.deleted_at is None for node in path)
        }
        async with self._reading() as session:
            space_workspaces: dict[UUID, UUID] = {}
            if spaces:
                rows = await session.execute(
                    select(Space.id, Space.tenant_id).where(
                        Space.id.in_({ref.space_id for ref in spaces})
                    )
                )
                space_workspaces = dict(rows.tuples().all())
            spaces = [ref for ref in spaces if space_workspaces.get(ref.space_id) == ref.workspace_id]
            platform: dict[UUID, frozenset[str]] = {}
            if any(isinstance(resource, PlatformRef | WorkspaceRef) for resource in wanted):
                platform = await _platform_holders(session, users)
            audiences = {
                workspace_id: await _audience(
                    session, workspace_id, await self.active_members(users, workspace_id)
                )
                for workspace_id in {
                    *(r.workspace_id for r in wanted if isinstance(r, WorkspaceRef)),
                    *(ref.workspace_id for ref in chains),
                    *(ref.workspace_id for ref in spaces),
                }
            }
            members = frozenset().union(*(a.members for a in audiences.values()))
            groups = frozenset().union(*(g for a in audiences.values() for g in a.groups.values()))
            collections = {collection for chain in chains.values() for collection in chain}
            item_grants = await _scoped_grants(
                session,
                RoleAssignment.item_id,
                collections,
                or_(
                    RoleAssignment.user_id.in_(members),
                    RoleAssignment.group_id.in_(groups),
                    RoleAssignment.all_members.is_(True),
                ),
            )
            space_grants = await _scoped_grants(
                session,
                RoleAssignment.space_id,
                {ref.space_id for ref in spaces},
                RoleAssignment.user_id.in_(members),
            )
        for resource in wanted:
            held = result[resource]
            match resource:
                case PlatformRef():
                    held.update(platform)
                case WorkspaceRef(workspace_id=workspace_id):
                    audience = audiences[workspace_id]
                    for user_id in users:
                        held[user_id] = audience.tenant.get(user_id, frozenset()) | platform.get(
                            user_id, frozenset()
                        )
                case ItemRef() if resource in chains:
                    audience = audiences[resource.workspace_id]
                    for user_id in audience.members:
                        mine = audience.groups[user_id]
                        held[user_id] = (audience.tenant[user_id] & _COLLECTION_SCOPED) | _conferred(
                            (
                                (grant.scope_type, grant.permission_code)
                                for collection in chains[resource]
                                for grant in item_grants.get(collection, ())
                                if grant.all_members
                                or grant.user_id == user_id
                                or grant.group_id in mine
                            ),
                            Scope.COLLECTION,
                        )
                case SpaceRef() if resource in spaces:
                    audience = audiences[resource.workspace_id]
                    for user_id in audience.members:
                        held[user_id] = (audience.tenant[user_id] & _SPACE_SCOPED) | _conferred(
                            (
                                (grant.scope_type, grant.permission_code)
                                for grant in space_grants.get(resource.space_id, ())
                                if grant.user_id == user_id
                            ),
                            Scope.SPACE,
                        )
        return result

    # -- Internals ----------------------------------------------------------

    async def _held_on_parent(
        self, principal: Principal, permission: str, resource: Resource
    ) -> bool:
        match resource:
            case WorkspaceRef():
                return permission in await self.platform_permissions(principal)
            case ItemRef(workspace_id=workspace_id) | SpaceRef(workspace_id=workspace_id):
                return permission in await self.workspace_permissions(
                    principal, workspace_id
                )
            case PlatformRef():
                return False

    async def _exists(self, resource: Resource, *, include_deleted: bool) -> bool:
        match resource:
            case WorkspaceRef(workspace_id=workspace_id):
                return await self.workspace(workspace_id) is not None
            case ItemRef(workspace_id=workspace_id, item_id=item_id):
                path = await self.ancestry(item_id)
                return (
                    bool(path)
                    and path[0].tenant_id == workspace_id
                    and (include_deleted or all(n.deleted_at is None for n in path))
                )
            case SpaceRef(workspace_id=workspace_id, space_id=space_id):
                return await self._space_workspace(space_id) == workspace_id
            case PlatformRef():
                return True

    async def _space_workspace(self, space_id: UUID) -> UUID | None:
        if space_id not in self._space_workspaces:
            async with self._reading() as session:
                self._space_workspaces[space_id] = await session.scalar(
                    select(Space.tenant_id).where(Space.id == space_id)
                )
        return self._space_workspaces[space_id]


@dataclass(frozen=True, slots=True)
class WorkspaceAccess:
    """A principal acting in one workspace: what engines receive for authorization."""

    principal: Principal
    workspace_id: UUID
    authorizer: Authorizer

    @property
    def user_id(self) -> UUID:
        return self.principal.user_id

    @property
    def session_id(self) -> UUID | None:
        return self.principal.session_id

    async def has(self, permission: str) -> bool:
        """Whether ``permission`` is held at workspace scope."""
        return permission in await self.authorizer.workspace_permissions(
            self.principal, self.workspace_id
        )

    async def require(self, permission: str) -> None:
        """Enforce ``permission`` on the workspace itself."""
        await self.authorizer.require(
            self.principal, permission, WorkspaceRef(self.workspace_id)
        )

    async def allowed_collections(self, permission: str) -> frozenset[UUID]:
        return await self.authorizer.allowed_collections(
            self.principal, self.workspace_id, permission
        )


# -- Shared queries ----------------------------------------------------------


async def item_ancestry(session: AsyncSession, item_id: UUID) -> tuple[ItemNode, ...]:
    """The item and every ancestor in one recursive query, nearest first."""
    return (await item_ancestries(session, (item_id,))).get(item_id, ())


async def item_ancestries(
    session: AsyncSession, item_ids: Iterable[UUID]
) -> dict[UUID, tuple[ItemNode, ...]]:
    """:func:`item_ancestry` of each existing item, all in one recursive query."""
    ids = list(dict.fromkeys(item_ids))
    if not ids:
        return {}
    path = (
        select(
            Item.id.label("origin_id"),
            Item.id,
            Item.tenant_id,
            Item.item_kind,
            Item.item_type,
            Item.parent_item_id,
            Item.inherit_access,
            Item.deleted_at,
            Item.is_published,
            literal(0).label("depth"),
        )
        .where(Item.id.in_(ids))
        .cte("item_path", recursive=True)
    )
    parent = Item.__table__.alias("parent_item")
    path = path.union_all(
        select(
            path.c.origin_id,
            parent.c.id,
            parent.c.tenant_id,
            parent.c.item_kind,
            parent.c.item_type,
            parent.c.parent_item_id,
            parent.c.inherit_access,
            parent.c.deleted_at,
            parent.c.is_published,
            path.c.depth + 1,
        ).where(parent.c.id == path.c.parent_item_id)
    )
    paths: dict[UUID, list[ItemNode]] = {}
    for row in await session.execute(select(path).order_by(path.c.origin_id, path.c.depth)):
        paths.setdefault(row.origin_id, []).append(
            ItemNode(
                item_id=row.id,
                tenant_id=row.tenant_id,
                item_kind=row.item_kind,
                item_type=row.item_type,
                parent_item_id=row.parent_item_id,
                inherit_access=row.inherit_access,
                deleted_at=row.deleted_at,
                is_published=row.is_published,
            )
        )
    return {item_id: tuple(nodes) for item_id, nodes in paths.items()}


def governing_chain(path: tuple[ItemNode, ...]) -> tuple[UUID, ...]:
    """Collections whose grants reach the first node of ``path``.

    Climbs while a node inherits; the first node with ``inherit_access =
    false`` (always a collection) is the access boundary and the last link.
    """
    chain: list[UUID] = []
    for node in path:
        if node.item_kind != "collection":
            continue
        chain.append(node.item_id)
        if not node.inherit_access:
            break
    return tuple(chain)


async def _is_active_member(session: AsyncSession, user_id: UUID, workspace_id: UUID) -> bool:
    status = await session.scalar(
        select(TenantMembership.status).where(
            TenantMembership.user_id == user_id,
            TenantMembership.tenant_id == workspace_id,
            TenantMembership.deleted_at.is_(None),
        )
    )
    return status == "active"


def _grants():
    """``(role scope, permission)`` of live assignments of live roles; add a WHERE."""
    return (
        select(Role.scope_type, RolePermission.permission_code)
        .select_from(RoleAssignment)
        .join(Role, and_(Role.id == RoleAssignment.role_id, Role.deleted_at.is_(None)))
        .join(RolePermission, RolePermission.granted_by(Role.id))
        .where(RoleAssignment.deleted_at.is_(None))
    )


def _held_by(principal: Principal, groups: frozenset[UUID], *, all_members: bool):
    """Assignments held by the user, one of their groups, or (collections) everyone."""
    clauses = [RoleAssignment.user_id == principal.user_id]
    if groups:
        clauses.append(RoleAssignment.group_id.in_(groups))
    if all_members:
        clauses.append(RoleAssignment.all_members.is_(True))
    return or_(*clauses)


def _conferred(rows: Iterable[tuple[str, str]], scope: Scope) -> frozenset[str]:
    """Permissions a grant at ``scope`` confers; unknown codes never grant."""
    result: set[str] = set()
    for _, code in rows:
        permission = PERMISSIONS_BY_NAME.get(code)
        if permission is not None and scope in permission.scopes:
            result.add(code)
    return frozenset(result)


def _granted_collections(principal: Principal, groups: frozenset[UUID], permission: str):
    """Collections carrying a grant of the caller that confers ``permission`` there."""
    return (
        select(RoleAssignment.item_id)
        .join(Role, and_(Role.id == RoleAssignment.role_id, Role.deleted_at.is_(None)))
        .join(RolePermission, RolePermission.granted_by(Role.id))
        .where(
            RoleAssignment.deleted_at.is_(None),
            RoleAssignment.item_id.is_not(None),
            RolePermission.permission_code == permission,
            _held_by(principal, groups, all_members=True),
        )
    )


@dataclass(frozen=True, slots=True)
class _Audience:
    """ACTIVE members among some users of one workspace, their groups and tenant grants."""

    members: frozenset[UUID]
    groups: dict[UUID, frozenset[UUID]]
    tenant: dict[UUID, frozenset[str]]


def _grant_rows():
    """:func:`_grants` with the holder columns, for many principals at once."""
    return _grants().add_columns(
        RoleAssignment.user_id, RoleAssignment.group_id, RoleAssignment.all_members
    )


async def _platform_holders(
    session: AsyncSession, users: frozenset[UUID]
) -> dict[UUID, frozenset[str]]:
    """:meth:`Authorizer.platform_permissions` of each user in one query."""
    rows = await session.execute(
        _grant_rows().where(
            RoleAssignment.user_id.in_(users),
            RoleAssignment.tenant_id.is_(None),
            RoleAssignment.item_id.is_(None),
            RoleAssignment.space_id.is_(None),
            Role.scope_type == Scope.PLATFORM.value,
        )
    )
    by_user: dict[UUID, list[tuple[str, str]]] = {}
    for scope_type, code, user_id, _, _ in rows:
        by_user.setdefault(user_id, []).append((scope_type, code))
    return {user_id: _conferred(by_user.get(user_id, ()), Scope.PLATFORM) for user_id in users}


async def _audience(
    session: AsyncSession, workspace_id: UUID, members: frozenset[UUID]
) -> _Audience:
    """The groups and tenant grants of ``members`` (ACTIVE members of the workspace)."""
    if not members:
        return _Audience(members, {}, {})
    groups: dict[UUID, set[UUID]] = {user_id: set() for user_id in members}
    for user_id, group_id in await session.execute(
        select(GroupMembership.user_id, Group.id)
        .join(Group, GroupMembership.group_id == Group.id)
        .where(
            Group.tenant_id == workspace_id,
            Group.deleted_at.is_(None),
            GroupMembership.user_id.in_(members),
            GroupMembership.deleted_at.is_(None),
        )
    ):
        groups[user_id].add(group_id)
    held = {user_id: frozenset(ids) for user_id, ids in groups.items()}
    rows = (
        await session.execute(
            _grant_rows().where(
                RoleAssignment.tenant_id == workspace_id,
                or_(
                    RoleAssignment.user_id.in_(members),
                    RoleAssignment.group_id.in_(set().union(*held.values())),
                ),
            )
        )
    ).all()
    tenant = {
        user_id: _conferred(
            (
                (scope_type, code)
                for scope_type, code, holder, group_id, _ in rows
                if holder == user_id or group_id in held[user_id]
            ),
            Scope.WORKSPACE,
        )
        for user_id in members
    }
    return _Audience(members, held, tenant)


async def _scoped_grants(
    session: AsyncSession, scope: Any, targets: set[UUID], held_by: ColumnElement[bool]
) -> dict[UUID, list[Row[Any]]]:
    """:func:`_grant_rows` on ``targets`` (``scope`` is the assignment column) matching ``held_by``."""
    grants: dict[UUID, list[Row[Any]]] = {}
    if not targets:
        return grants
    for row in await session.execute(
        _grant_rows().add_columns(scope.label("target")).where(scope.in_(targets), held_by)
    ):
        grants.setdefault(row.target, []).append(row)
    return grants


async def _reachable_collections(
    session: AsyncSession, workspace_id: UUID, *, seeds, include_deleted: bool
) -> frozenset[UUID]:
    """Collections a grant reaches; ``seeds=None`` means all of them.

    Walks down from the roots: a collection is reached when it carries a seed
    grant, or inherits from a reached parent. Without ``include_deleted`` the
    walk never enters a deleted collection, so only live-rooted ones remain.
    """

    def live(column):
        return true() if include_deleted else column.is_(None)

    seeded = literal(True) if seeds is None else Item.id.in_(seeds)
    tree = (
        select(Item.id.label("item_id"), seeded.label("reached"))
        .where(
            Item.tenant_id == workspace_id,
            Item.item_kind == "collection",
            Item.parent_item_id.is_(None),
            live(Item.deleted_at),
        )
        .cte("collection_tree", recursive=True)
    )
    child = Item.__table__.alias("child_collection")
    child_seeded = literal(True) if seeds is None else child.c.id.in_(seeds)
    tree = tree.union_all(
        select(
            child.c.id,
            or_(child_seeded, and_(child.c.inherit_access, tree.c.reached)),
        ).where(
            child.c.parent_item_id == tree.c.item_id,
            child.c.tenant_id == workspace_id,
            child.c.item_kind == "collection",
            live(child.c.deleted_at),
        )
    )
    return frozenset(
        await session.scalars(select(tree.c.item_id).where(tree.c.reached.is_(True)))
    )


__all__ = [
    "Authorizer",
    "ItemNode",
    "ItemRef",
    "PlatformRef",
    "Principal",
    "Resource",
    "SpaceRef",
    "WorkspaceAccess",
    "WorkspaceRef",
    "governing_chain",
    "item_ancestry",
    "item_ancestries",
    "not_found",
    "permission_denied",
]
