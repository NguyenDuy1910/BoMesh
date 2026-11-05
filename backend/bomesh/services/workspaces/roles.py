"""Custom roles (``workspaces/{w}/roles/{role}``), predefined roles and the permission catalog.

Predefined roles and permissions are read from :mod:`bomesh.iam.catalog`;
lists filter and page over the synced ``roles``/``permissions`` tables, which
hold the same catalog. A custom role may only include permissions custom
roles support and the caller holds on the workspace (ROLE_ESCALATION).
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh import etag
from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Permission as PermissionRow
from bomesh.db.models import Role, RolePermission
from bomesh.errors import (
    AlreadyExists,
    FailedPrecondition,
    InvalidArgument,
    NotFound,
    PermissionDenied,
)
from bomesh.iam.authorizer import WorkspaceRef
from bomesh.iam.catalog import (
    PERMISSIONS_BY_NAME,
    PREDEFINED_ROLES_BY_NAME,
    Permission,
    PredefinedRole,
    Scope,
)
from bomesh.iam.sync import replace_role_permissions
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.retention import RETENTION, purge_time, require_restorable
from bomesh.services.kernel.workspaces import WorkspaceResolver
from bomesh.services.workspaces.records import RoleRecord

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

ROLE_ID = re.compile(r"^[a-z][a-zA-Z0-9]{0,62}$")


class CatalogService:
    """Permissions and predefined roles: readable by every authenticated caller."""

    def __init__(self, sessions: SessionFactory) -> None:
        self._sessions = sessions

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> CatalogService:
        return cls(runtime.sessions())

    async def list_permissions(self, query: ListQuery) -> list[Permission]:
        async with transaction_scope(self._sessions) as session:
            codes = await session.scalars(query.apply(select(PermissionRow.code)))
            return [PERMISSIONS_BY_NAME[code] for code in codes if code in PERMISSIONS_BY_NAME]

    def get_permission(self, permission: str) -> Permission:
        found = PERMISSIONS_BY_NAME.get(permission)
        if found is None:
            raise NotFound(f"Resource 'permissions/{permission}' was not found.")
        return found

    async def list_predefined_roles(self, query: ListQuery) -> list[PredefinedRole]:
        async with transaction_scope(self._sessions) as session:
            codes = await session.scalars(
                query.apply(select(Role.code).where(Role.tenant_id.is_(None)))
            )
            return [
                PREDEFINED_ROLES_BY_NAME[f"roles/{code}"]
                for code in codes
                if f"roles/{code}" in PREDEFINED_ROLES_BY_NAME
            ]

    def get_predefined_role(self, role: str) -> PredefinedRole:
        found = PREDEFINED_ROLES_BY_NAME.get(f"roles/{role}")
        if found is None:
            raise NotFound(f"Resource 'roles/{role}' was not found.")
        return found


class RoleService:
    """Custom roles with soft delete and ``:undelete``."""

    def __init__(self, sessions: SessionFactory, request_hash_secret: bytes) -> None:
        self._sessions = sessions
        self._secret = request_hash_secret
        self._resolver = WorkspaceResolver(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> RoleService:
        return cls(runtime.sessions(), runtime.request_hash_secret())

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        *,
        role_id: str | None,
        display_name: str,
        description: str | None,
        permissions: Sequence[str],
        validate_only: bool,
        request_id: UUID | None,
    ) -> RoleRecord:
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "roles.create", write=True)
        code = _role_id(role_id) if role_id is not None else f"role{uuid4().hex[:12]}"
        title = _display_name(display_name)
        included = _known(permissions)
        await self._require_held(ctx, workspace_id, included)
        async with transaction_scope(self._sessions) as session:
            idempotency = Idempotency(session, self._secret)
            key = None
            if request_id is not None and not validate_only:
                key = idempotency.key(
                    ctx.principal,
                    request_id,
                    method="CreateRole",
                    parent=f"workspaces/{workspace_id}",
                    request={
                        "roleId": role_id,
                        "displayName": title,
                        "description": description,
                        "includedPermissions": sorted(included),
                    },
                )
                if (replayed := await idempotency.replay(key)) is not None:
                    return await _record(session, workspace_id, replayed.rsplit("/", 1)[-1])
            if f"roles/{code}" in PREDEFINED_ROLES_BY_NAME or await session.scalar(
                select(Role.id).where(Role.tenant_id == workspace_id, Role.code == code)
            ):
                raise AlreadyExists(f"The role ID '{code}' is already taken.")
            role = Role(
                tenant_id=workspace_id,
                code=code,
                display_name=title,
                description=description or None,
                scope_type=Scope.WORKSPACE.value,
                is_system=False,
            )
            if validate_only:
                now = datetime.now(UTC)
                role.created_at = role.updated_at = now
                return RoleRecord(role, tuple(sorted(included)))
            session.add(role)
            await session.flush()
            await replace_role_permissions(session, role.id, included)
            name = f"workspaces/{workspace_id}/roles/{code}"
            await _audit(session, ctx, workspace_id, "CreateRole", name)
            if key is not None:
                await idempotency.remember(key, name)
            return await _record(session, workspace_id, code)

    async def get(self, ctx: RequestContext, workspace_id: UUID, code: str) -> RoleRecord:
        """Deleted roles too."""
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "roles.get", write=False)
        async with transaction_scope(self._sessions) as session:
            return await _record(session, workspace_id, code)

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, query: ListQuery
    ) -> list[RoleRecord]:
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "roles.list", write=False)
        statement = select(Role).where(Role.tenant_id == workspace_id)
        if query.show_deleted:
            statement = statement.where(
                Role.deleted_at.is_(None) | (Role.deleted_at > datetime.now(UTC) - RETENTION)
            )
        else:
            statement = statement.where(Role.deleted_at.is_(None))
        async with transaction_scope(self._sessions) as session:
            roles = list(await session.scalars(query.apply(statement)))
            permissions = await _permissions(session, [role.id for role in roles])
            return [_with(role, permissions.get(role.id, ())) for role in roles]

    async def update(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        changes: Mapping[str, Any],
        *,
        expected_etag: str | None,
    ) -> RoleRecord:
        """``changes`` keyed by mask path: ``displayName``, ``description``, ``includedPermissions``."""
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "roles.update", write=True)
        async with transaction_scope(self._sessions) as session:
            current = await _record(session, workspace_id, code, for_update=True)
            etag.check(expected_etag, current.etag)
            if current.role.deleted_at is not None:
                raise FailedPrecondition("A deleted role cannot be updated.", reason="ROLE_DELETED")
            role = current.role
            if "displayName" in changes:
                role.display_name = _display_name(changes["displayName"])
            if "description" in changes:
                role.description = changes["description"] or None
            if "includedPermissions" in changes:
                included = _known(changes["includedPermissions"] or ())
                await self._require_held(ctx, workspace_id, included - set(current.permissions))
                await replace_role_permissions(session, role.id, included)
            role.updated_at = datetime.now(UTC)
            await session.flush()
            await _audit(session, ctx, workspace_id, "UpdateRole", current.name)
            return await _record(session, workspace_id, code)

    async def delete(
        self, ctx: RequestContext, workspace_id: UUID, code: str, *, expected_etag: str | None
    ) -> RoleRecord:
        """ACTIVE → DELETED; bindings of the role stop granting it but are kept."""
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "roles.delete", write=True)
        async with transaction_scope(self._sessions) as session:
            current = await _record(session, workspace_id, code, for_update=True)
            etag.check(expected_etag, current.etag)
            if current.role.deleted_at is not None:
                raise FailedPrecondition("The role is already deleted.", reason="ROLE_DELETED")
            current.role.deleted_at = datetime.now(UTC)
            await session.flush()
            await _audit(session, ctx, workspace_id, "DeleteRole", current.name)
            return await _record(session, workspace_id, code)

    async def undelete(
        self, ctx: RequestContext, workspace_id: UUID, code: str, *, expected_etag: str | None
    ) -> RoleRecord:
        """DELETED → ACTIVE; its kept bindings grant again."""
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "roles.undelete", write=True)
        async with transaction_scope(self._sessions) as session:
            current = await _record(session, workspace_id, code, for_update=True)
            etag.check(expected_etag, current.etag)
            if current.role.deleted_at is None:
                raise AlreadyExists("The role is not deleted.")
            current.role.deleted_at = None
            await session.flush()
            await _audit(session, ctx, workspace_id, "UndeleteRole", current.name)
            return await _record(session, workspace_id, code)

    async def _require_held(
        self, ctx: RequestContext, workspace_id: UUID, permissions: Iterable[str]
    ) -> None:
        held = await ctx.authorizer.workspace_permissions(ctx.principal, workspace_id)
        if not set(permissions) <= held:
            raise PermissionDenied(
                "A role cannot include permissions you do not hold in this workspace.",
                reason="ROLE_ESCALATION",
            )


# -- Queries --------------------------------------------------------------------


async def _record(
    session: AsyncSession, workspace_id: UUID, code: str, *, for_update: bool = False
) -> RoleRecord:
    statement = select(Role).where(Role.tenant_id == workspace_id, Role.code == code)
    role = await session.scalar(statement.with_for_update() if for_update else statement)
    name = f"workspaces/{workspace_id}/roles/{code}"
    if role is None:
        raise NotFound(f"Resource '{name}' was not found.")
    require_restorable(role.deleted_at, name)
    await session.refresh(role)
    permissions = await _permissions(session, [role.id])
    return _with(role, permissions.get(role.id, ()))


async def _permissions(
    session: AsyncSession, role_ids: Sequence[UUID]
) -> dict[UUID, tuple[str, ...]]:
    if not role_ids:
        return {}
    rows = await session.execute(
        select(RolePermission.role_id, RolePermission.permission_code)
        .where(RolePermission.role_id.in_(role_ids), RolePermission.deleted_at.is_(None))
        .order_by(RolePermission.permission_code)
    )
    result: dict[UUID, list[str]] = {}
    for role_id, code in rows:
        result.setdefault(role_id, []).append(code)
    return {role_id: tuple(codes) for role_id, codes in result.items()}


def _with(role: Role, permissions: tuple[str, ...]) -> RoleRecord:
    return RoleRecord(role, permissions, purge_time=purge_time(role.deleted_at))


async def _audit(
    session: AsyncSession, ctx: RequestContext, workspace_id: UUID, action: str, target: str
) -> None:
    await Audit(session).record(
        ctx, workspace_id=workspace_id, category="people", action=action, target=target
    )


def _known(permissions: Iterable[str]) -> set[str]:
    included = set(permissions)
    if not included:
        raise InvalidArgument.for_field(
            "includedPermissions", "includedPermissions must name at least one permission."
        )
    for name in sorted(included):
        permission = PERMISSIONS_BY_NAME.get(name)
        if permission is None:
            raise InvalidArgument.for_field(
                "includedPermissions", f"Unknown permission '{name}'."
            )
        if not permission.custom_roles_supported:
            raise InvalidArgument.for_field(
                "includedPermissions", f"Custom roles cannot include '{name}'."
            )
    return included


def _role_id(value: str) -> str:
    if not ROLE_ID.match(value):
        raise InvalidArgument.for_field("roleId", "roleId must match ^[a-z][a-zA-Z0-9]{0,62}$.")
    return value


def _display_name(value: object) -> str:
    text = value.strip() if isinstance(value, str) else ""
    if not text or len(text) > 255:
        raise InvalidArgument.for_field("displayName", "displayName must be 1-255 characters.")
    return text


__all__ = ["ROLE_ID", "CatalogService", "RoleService"]
