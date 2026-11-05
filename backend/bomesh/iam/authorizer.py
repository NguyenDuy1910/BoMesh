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
delete is effective at the next request.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import and_, literal, or_, select, true
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
    item_type: str
    parent_item_id: UUID | None
    inherit_access: bool
    deleted_at: datetime | None
    system_kind: str | None
    publication_state: str | None


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

    Every uncached lookup runs in its own short read transaction, so an
    Authorizer can be used before, between and after the caller's write
    transactions.
    """

    def __init__(self, sessions: SessionFactory) -> None:
        self._sessions = sessions
        self._platform: dict[UUID, frozenset[str]] = {}
        self._member: dict[tuple[UUID, UUID], bool] = {}
        self._memberships: dict[UUID, frozenset[UUID]] = {}
        self._groups: dict[tuple[UUID, UUID], frozenset[UUID]] = {}
        self._workspace: dict[tuple[UUID, UUID], frozenset[str]] = {}
        self._ancestry: dict[UUID, tuple[ItemNode, ...]] = {}
        self._collection: dict[tuple[UUID, UUID, bool], frozenset[str]] = {}
        self._space: dict[tuple[UUID, UUID], frozenset[str]] = {}
        self._allowed: dict[tuple[UUID, UUID, str, bool], frozenset[UUID]] = {}

    # -- Scopes -------------------------------------------------------------

    async def platform_permissions(self, principal: Principal) -> frozenset[str]:
        """Permissions of the caller's platform roles (``platformRole``)."""
        cached = self._platform.get(principal.user_id)
        if cached is None:
            async with transaction_scope(self._sessions) as session:
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
            async with transaction_scope(self._sessions) as session:
                cached = await _is_active_member(session, principal.user_id, workspace_id)
            self._member[key] = cached
        return cached

    async def group_ids(self, principal: Principal, workspace_id: UUID) -> frozenset[UUID]:
        """The live groups of the workspace the caller actively belongs to."""
        key = (principal.user_id, workspace_id)
        cached = self._groups.get(key)
        if cached is None:
            async with transaction_scope(self._sessions) as session:
                cached = frozenset(
                    await session.scalars(
                        select(Group.id)
                        .join(GroupMembership, GroupMembership.group_id == Group.id)
                        .where(
                            Group.tenant_id == workspace_id,
                            Group.status == "active",
                            Group.deleted_at.is_(None),
                            GroupMembership.user_id == principal.user_id,
                            GroupMembership.status == "active",
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
                async with transaction_scope(self._sessions) as session:
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
            async with transaction_scope(self._sessions) as session:
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

    async def ancestry(self, item_id: UUID) -> tuple[ItemNode, ...]:
        """The item and every ancestor, nearest first; empty if the item does not exist."""
        cached = self._ancestry.get(item_id)
        if cached is None:
            async with transaction_scope(self._sessions) as session:
                cached = await item_ancestry(session, item_id)
            self._ancestry[item_id] = cached
        return cached

    async def governing_collection(self, item_id: UUID) -> UUID | None:
        """The nearest COLLECTION of the item's canonical path, the item itself included."""
        for node in await self.ancestry(item_id):
            if node.item_type == "collection":
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
        key = (principal.user_id, item_id, include_deleted)
        cached = self._collection.get(key)
        if cached is not None:
            return cached
        result: frozenset[str] = frozenset()
        path = await self.ancestry(item_id)
        if path and (include_deleted or all(node.deleted_at is None for node in path)):
            workspace_id = path[0].tenant_id
            tenant = await self.workspace_permissions(principal, workspace_id)
            if await self.is_active_member(principal, workspace_id):
                chain = governing_chain(path)
                groups = await self.group_ids(principal, workspace_id)
                async with transaction_scope(self._sessions) as session:
                    rows = await session.execute(
                        _grants().where(
                            RoleAssignment.item_id.in_(chain),
                            _held_by(principal, groups, all_members=True),
                        )
                    )
                    granted = _conferred(rows, Scope.COLLECTION)
                result = (tenant & _COLLECTION_SCOPED) | granted
        self._collection[key] = result
        return result

    async def space_permissions(self, principal: Principal, space_id: UUID) -> frozenset[str]:
        """Workspace grants valid on spaces ∪ the caller's grants on the space."""
        key = (principal.user_id, space_id)
        cached = self._space.get(key)
        if cached is not None:
            return cached
        result: frozenset[str] = frozenset()
        async with transaction_scope(self._sessions) as session:
            workspace_id = await session.scalar(
                select(Space.tenant_id).where(Space.id == space_id)
            )
        if workspace_id is not None:
            tenant = await self.workspace_permissions(principal, workspace_id)
            if await self.is_active_member(principal, workspace_id):
                async with transaction_scope(self._sessions) as session:
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
            if isinstance(resource, WorkspaceRef) and not await self._workspace_exists(
                resource.workspace_id
            ):
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
            tenant_wide = permission in await self.workspace_permissions(
                principal, workspace_id
            )
            groups = await self.group_ids(principal, workspace_id)
            async with transaction_scope(self._sessions) as session:
                result = await _reachable_collections(
                    session,
                    workspace_id,
                    seeds=None
                    if tenant_wide
                    else _granted_collections(principal, groups, permission),
                    include_deleted=include_deleted,
                )
        self._allowed[key] = result
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
                return await self._workspace_exists(workspace_id)
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

    async def _workspace_exists(self, workspace_id: UUID) -> bool:
        async with transaction_scope(self._sessions) as session:
            return await session.get(Tenant, workspace_id) is not None

    async def _space_workspace(self, space_id: UUID) -> UUID | None:
        async with transaction_scope(self._sessions) as session:
            return await session.scalar(select(Space.tenant_id).where(Space.id == space_id))


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
    path = (
        select(
            Item.id,
            Item.tenant_id,
            Item.item_type,
            Item.parent_item_id,
            Item.inherit_access,
            Item.deleted_at,
            Item.metadata_["system_kind"].astext.label("system_kind"),
            Item.publication_state,
            literal(0).label("depth"),
        )
        .where(Item.id == item_id)
        .cte("item_path", recursive=True)
    )
    parent = Item.__table__.alias("parent_item")
    path = path.union_all(
        select(
            parent.c.id,
            parent.c.tenant_id,
            parent.c.item_type,
            parent.c.parent_item_id,
            parent.c.inherit_access,
            parent.c.deleted_at,
            parent.c.metadata["system_kind"].astext,
            parent.c.publication_state,
            path.c.depth + 1,
        ).where(parent.c.id == path.c.parent_item_id)
    )
    rows = await session.execute(select(path).order_by(path.c.depth))
    return tuple(
        ItemNode(
            item_id=row.id,
            tenant_id=row.tenant_id,
            item_type=row.item_type,
            parent_item_id=row.parent_item_id,
            inherit_access=row.inherit_access,
            deleted_at=row.deleted_at,
            system_kind=row.system_kind,
            publication_state=row.publication_state,
        )
        for row in rows
    )


def governing_chain(path: tuple[ItemNode, ...]) -> tuple[UUID, ...]:
    """Collections whose grants reach the first node of ``path``.

    Climbs while a node inherits; the first node with ``inherit_access =
    false`` (always a collection) is the access boundary and the last link.
    """
    chain: list[UUID] = []
    for node in path:
        if node.item_type == "collection":
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
            Item.item_type == "collection",
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
            child.c.item_type == "collection",
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
    "not_found",
    "permission_denied",
]
