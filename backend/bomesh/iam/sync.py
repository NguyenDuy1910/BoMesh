"""Write the IAM catalog into PostgreSQL: permissions, predefined roles, role_permissions.

Permissions and predefined roles are product definitions declared in
:mod:`bomesh.iam.catalog`; the database mirrors them so grants can join
through ``role_permissions``. Running :func:`sync_catalog` again is safe and is
how a new permission reaches deployed roles.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import Permission, Role, RolePermission
from bomesh.iam.catalog import PERMISSIONS, PREDEFINED_ROLES


async def sync_catalog(session: AsyncSession) -> None:
    """Upsert every catalog permission and predefined role with its exact permissions."""
    for permission in PERMISSIONS:
        values = {
            "title": permission.title,
            "description": permission.description,
            "scope_types": sorted(scope.value for scope in permission.scopes),
            "custom_roles_supported": permission.custom_roles_supported,
        }
        await session.execute(
            insert(Permission)
            .values(code=permission.name, **values)
            .on_conflict_do_update(index_elements=[Permission.code], set_=values)
        )
    for role in PREDEFINED_ROLES:
        values = {
            "display_name": role.title,
            "description": role.description,
            "scope_type": role.scope.value,
            "updated_at": datetime.now(UTC),
        }
        role_id = await session.scalar(
            insert(Role)
            .values(tenant_id=None, code=role.role_id, is_system=True, **values)
            .on_conflict_do_update(index_elements=[Role.tenant_id, Role.code], set_=values)
            .returning(Role.id)
        )
        assert role_id is not None
        await replace_role_permissions(session, role_id, role.permissions)
    await session.flush()


async def replace_role_permissions(
    session: AsyncSession, role_id: UUID, permissions: Iterable[str]
) -> None:
    """Make the role carry exactly ``permissions``: tombstone the rest, revive re-added ones."""
    wanted = set(permissions)
    held = list(
        await session.scalars(select(RolePermission).where(RolePermission.role_id == role_id))
    )
    now = datetime.now(UTC)
    for grant in held:
        if grant.permission_code in wanted:
            grant.deleted_at = None
        elif grant.deleted_at is None:
            grant.deleted_at = now
    for code in wanted - {grant.permission_code for grant in held}:
        session.add(RolePermission(role_id=role_id, permission_code=code))
    await session.flush()


__all__ = ["replace_role_permissions", "sync_catalog"]
