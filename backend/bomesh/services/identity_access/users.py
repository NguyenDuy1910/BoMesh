"""Tenant-scoped user and membership administration."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import (
    Group,
    GroupMembership,
    Role,
    RoleAssignment,
    Tenant,
    TenantMembership,
    User,
)
from bomesh.services.audit import AuditService
from bomesh.services.identity_access.identity_store import IdentityStoreService
from bomesh.services.identity_access.role_assignments import RoleAssignmentService
from bomesh.services import (
    ACTIVE_STATUS,
    INACTIVE_STATUS,
    PLATFORM_USER_READ_PERMISSION,
    TENANT_ADMIN_ROLE,
    TENANT_SCOPE,
    USER_MANAGE_PERMISSION,
    ControlPlaneConflictError,
    ControlPlaneNotFoundError,
    ControlPlaneValidationError,
    AuthContext,
    IdentityNotFoundError,
    normalize_page,
    require_platform_permission,
    require_tenant_permission,
    timestamp,
)


class UserService:
    """Manage durable users without trusting frontend tenant claims."""

    def __init__(
        self,
        session: AsyncSession,
        *,
        auth: IdentityStoreService | None = None,
        audit: AuditService | None = None,
    ) -> None:
        self._session = session
        self._auth = auth or IdentityStoreService(session)
        self._assignments = RoleAssignmentService(session)
        self._audit = audit or AuditService(session)

    async def list_users(
        self,
        actor: AuthContext,
        *,
        page: int = 1,
        page_size: int = 20,
        search: str | None = None,
        status: bool | None = None,
        role_id: UUID | None = None,
        sort: str = "name",
        direction: str = "asc",
    ) -> dict[str, Any]:
        tenant_id = require_tenant_permission(actor, USER_MANAGE_PERMISSION)
        page, page_size, offset = normalize_page(page, page_size)
        filters = [
            TenantMembership.tenant_id == tenant_id,
            TenantMembership.deleted_at.is_(None),
        ]
        if search and search.strip():
            term = f"%{search.strip()}%"
            filters.append(
                or_(User.email.ilike(term), User.display_name.ilike(term))
            )
        if status is not None:
            # Standing in this workspace, not the account itself.
            filters.append(
                TenantMembership.status == (ACTIVE_STATUS if status else INACTIVE_STATUS)
            )
        if role_id is not None:
            filters.append(
                User.id.in_(
                    select(RoleAssignment.user_id).where(
                        RoleAssignment.role_id == role_id,
                        RoleAssignment.tenant_id == tenant_id,
                        RoleAssignment.deleted_at.is_(None),
                    )
                )
            )

        base = (
            select(User, TenantMembership)
            .join(TenantMembership, TenantMembership.user_id == User.id)
            .where(*filters)
        )
        total = await self._session.scalar(
            select(func.count()).select_from(base.subquery())
        )
        sort_columns = {
            "created_at": User.created_at,
            "email": User.email,
            "last_login_at": User.last_login_at,
            "name": func.coalesce(User.display_name, User.email),
            "status": TenantMembership.status,
        }
        sort_column = sort_columns.get(sort)
        if sort_column is None:
            raise ControlPlaneValidationError("unsupported user sort field")
        if direction not in {"asc", "desc"}:
            raise ControlPlaneValidationError("sort direction must be asc or desc")
        order = sort_column.desc() if direction == "desc" else sort_column.asc()
        rows = (
            await self._session.execute(
                base.order_by(order, User.id).limit(page_size).offset(offset)
            )
        ).all()
        user_ids = [user.id for user, _ in rows]
        groups_by_user = await self._groups_for_users(tenant_id, user_ids)
        roles_by_user = await self._assignments.tenant_roles_for_users(
            tenant_id, user_ids
        )
        return {
            "items": [
                _user_payload(
                    user,
                    membership,
                    roles_by_user.get(user.id, []),
                    groups_by_user.get(user.id, []),
                )
                for user, membership in rows
            ],
            "total": int(total or 0),
            "page": page,
            "page_size": page_size,
        }

    async def get_user(self, actor: AuthContext, user_id: UUID) -> dict[str, Any]:
        tenant_id = require_tenant_permission(actor, USER_MANAGE_PERMISSION)
        user, membership = await self._membership_row(tenant_id, user_id)
        return _user_payload(
            user,
            membership,
            (await self._assignments.tenant_roles_for_users(tenant_id, [user_id])).get(
                user_id, []
            ),
            (await self._groups_for_users(tenant_id, [user_id])).get(user_id, []),
        )

    async def list_platform_users(
        self,
        actor: AuthContext,
        *,
        page: int = 1,
        page_size: int = 20,
        search: str | None = None,
        status: bool | None = None,
    ) -> dict[str, Any]:
        """Return user identities with every active workspace membership."""

        require_platform_permission(actor, PLATFORM_USER_READ_PERMISSION)
        page, page_size, offset = normalize_page(page, page_size)
        statement = select(User)
        if search and search.strip():
            term = f"%{search.strip()}%"
            statement = statement.where(
                or_(User.email.ilike(term), User.display_name.ilike(term))
            )
        if status is not None:
            statement = statement.where(User.status.is_(status))
        total = int(
            await self._session.scalar(select(func.count()).select_from(statement.subquery()))
            or 0
        )
        users = list(
            await self._session.scalars(
                statement.order_by(
                    func.coalesce(User.display_name, User.email), User.id
                )
                .limit(page_size)
                .offset(offset)
            )
        )
        user_ids = [user.id for user in users]
        memberships = await self._platform_memberships(user_ids)
        platform_roles = await self._platform_roles(user_ids)
        return {
            "items": [
                {
                    "id": str(user.id),
                    "email": user.email,
                    "display_name": user.display_name,
                    "status": user.status,
                    "platform_roles": platform_roles.get(user.id, []),
                    "memberships": memberships.get(user.id, []),
                }
                for user in users
            ],
            "total": total,
            "page": page,
            "page_size": page_size,
        }

    async def lookup_account(self, actor: AuthContext, *, email: str) -> dict[str, Any]:
        """Resolve one exact email to the account it names, for adding it.

        Only a whole address resolves, never a fragment, so a workspace
        administrator cannot browse the people of other workspaces. The answer
        says whether the account can join this workspace.
        """

        tenant_id = require_tenant_permission(actor, USER_MANAGE_PERMISSION)
        try:
            user = await self._auth.get_user_by_email(email, include_inactive=True)
        except IdentityNotFoundError:
            return {"items": [], "total": 0}
        membership = await self._session.get(
            TenantMembership, {"user_id": user.id, "tenant_id": tenant_id}
        )
        return {"items": [_account_payload(user, membership)], "total": 1}

    async def add_member(
        self,
        actor: AuthContext,
        *,
        email: str,
        role_ids: list[UUID],
        group_ids: list[UUID] | None = None,
    ) -> dict[str, Any]:
        """Give an existing account membership of this workspace.

        A workspace never creates identities: a person signs up once and is
        then added to any number of workspaces. A former member is readmitted
        with exactly the roles given now, never yesterday's.
        """

        tenant_id = require_tenant_permission(actor, USER_MANAGE_PERMISSION)
        await self._require_assignable_roles(actor, tenant_id, role_ids)
        try:
            user = await self._auth.get_user_by_email(email, include_inactive=True)
        except IdentityNotFoundError as exc:
            raise ControlPlaneNotFoundError(
                "no account uses this email; they need to sign up first"
            ) from exc
        if not user.status:
            raise ControlPlaneConflictError("this account is disabled")
        existing = await self._session.get(
            TenantMembership, {"user_id": user.id, "tenant_id": tenant_id}
        )
        if existing is not None and existing.deleted_at is None:
            raise ControlPlaneConflictError("this person is already a member of the workspace")
        membership = await self._auth.assign_membership(user.id, tenant_id)
        roles = await self._assignments.replace_tenant_roles(
            user_id=user.id,
            tenant_id=tenant_id,
            role_ids=role_ids,
            created_by_user_id=actor.user_id,
        )
        groups = await self._replace_groups(tenant_id, user.id, group_ids or [])
        await self._audit.record(
            actor,
            action="member.added",
            resource_type="user",
            resource_id=str(user.id),
            details={
                "email": user.email,
                "role_ids": [str(role.id) for role in roles],
                "readmitted": existing is not None,
            },
        )
        return _user_payload(user, membership, roles, groups)

    async def update_user(
        self,
        actor: AuthContext,
        user_id: UUID,
        *,
        display_name: str | None = None,
        role_ids: list[UUID] | None = None,
        status: bool | None = None,
        group_ids: list[UUID] | None = None,
    ) -> dict[str, Any]:
        tenant_id = require_tenant_permission(actor, USER_MANAGE_PERMISSION)
        user, membership = await self._membership_row(tenant_id, user_id)
        current_roles = (
            await self._assignments.tenant_roles_for_users(tenant_id, [user_id])
        ).get(user_id, [])
        if user_id == actor.user_id and any(
            change is not None for change in (role_ids, status, group_ids)
        ):
            raise ControlPlaneConflictError(
                "an administrator cannot change their own workspace access"
            )
        await self._ensure_tenant_retains_an_administrator(
            tenant_id=tenant_id,
            user=user,
            membership=membership,
            current_roles=current_roles,
            role_ids=role_ids,
            status=status,
        )
        changed: list[str] = []
        if display_name is not None:
            try:
                user = await self._auth.update_user(
                    user_id, display_name=display_name
                )
            except ValueError as exc:
                raise ControlPlaneValidationError(str(exc)) from exc
            changed.append("display_name")
        if status is not None:
            # Suspension is this workspace's decision about its own access; the
            # account, its sign-in and its other workspaces are not this
            # workspace's to switch off.
            membership.status = ACTIVE_STATUS if status else INACTIVE_STATUS
            if status:
                membership.deleted_at = None
            changed.append("status")
        if role_ids is not None:
            await self._require_assignable_roles(actor, tenant_id, role_ids)
            roles = await self._assignments.replace_tenant_roles(
                user_id=user_id,
                tenant_id=tenant_id,
                role_ids=role_ids,
                created_by_user_id=actor.user_id,
            )
            changed.append("roles")
        else:
            roles = current_roles
        groups = (
            await self._replace_groups(tenant_id, user_id, group_ids)
            if group_ids is not None
            else (await self._groups_for_users(tenant_id, [user_id])).get(user_id, [])
        )
        if group_ids is not None:
            changed.append("groups")
        await self._session.flush()
        details: dict[str, Any] = {"changed_fields": changed}
        if role_ids is not None:
            details["roles"] = {
                "before": sorted(role.code for role in current_roles),
                "after": sorted(role.code for role in roles),
            }
        await self._audit.record(
            actor,
            action="user.updated",
            resource_type="user",
            resource_id=str(user.id),
            details=details,
        )
        return _user_payload(user, membership, roles, groups)

    async def _membership_row(
        self, tenant_id: UUID, user_id: UUID
    ) -> tuple[User, TenantMembership]:
        row = (
            await self._session.execute(
                select(User, TenantMembership)
                .join(TenantMembership, TenantMembership.user_id == User.id)
                .where(
                    User.id == user_id,
                    TenantMembership.tenant_id == tenant_id,
                    TenantMembership.deleted_at.is_(None),
                )
            )
        ).one_or_none()
        if row is None:
            raise ControlPlaneNotFoundError(f"user not found: {user_id}")
        return row

    async def _require_assignable_roles(
        self, actor: AuthContext, tenant_id: UUID, role_ids: list[UUID]
    ) -> None:
        """Ensure an administrator cannot grant authority they do not hold."""

        desired_ids = set(role_ids)
        if not desired_ids or len(desired_ids) != len(role_ids):
            return
        roles = list(
            await self._session.scalars(
                select(Role).where(
                    Role.id.in_(desired_ids),
                    Role.scope_type == TENANT_SCOPE,
                    Role.status == ACTIVE_STATUS,
                    or_(Role.tenant_id == tenant_id, Role.tenant_id.is_(None)),
                )
            )
        )
        # RoleAssignmentService owns structural validation and returns its
        # established not-found errors for invalid role IDs.
        if {role.id for role in roles} != desired_ids:
            return
        permissions_by_role = await self._auth.permissions_for_roles(desired_ids)
        requested = {
            permission
            for role in roles
            for permission in permissions_by_role.get(role.id, ())
        }
        disallowed = sorted(requested - set(actor.permission_codes))
        if disallowed:
            raise ControlPlaneValidationError(
                "cannot grant a role with permissions beyond the acting "
                f"administrator's authority: {', '.join(disallowed)}"
            )

    async def _ensure_tenant_retains_an_administrator(
        self,
        *,
        tenant_id: UUID,
        user: User,
        membership: TenantMembership,
        current_roles: list[Role],
        role_ids: list[UUID] | None,
        status: bool | None,
    ) -> None:
        """Reject a mutation that would remove the workspace's final admin."""

        current_admin_role = next(
            (role for role in current_roles if role.code == TENANT_ADMIN_ROLE), None
        )
        removes_admin = status is False or (
            role_ids is not None
            and current_admin_role is not None
            and current_admin_role.id not in set(role_ids)
        )
        if (
            not removes_admin
            or current_admin_role is None
            or not user.status
            or membership.status != ACTIVE_STATUS
        ):
            return

        other_administrator = await self._session.scalar(
            select(RoleAssignment.id)
            .join(Role, Role.id == RoleAssignment.role_id)
            .join(
                TenantMembership,
                and_(
                    TenantMembership.user_id == RoleAssignment.user_id,
                    TenantMembership.tenant_id == RoleAssignment.tenant_id,
                ),
            )
            .join(User, User.id == RoleAssignment.user_id)
            .where(
                RoleAssignment.tenant_id == tenant_id,
                RoleAssignment.user_id != user.id,
                RoleAssignment.deleted_at.is_(None),
                Role.code == TENANT_ADMIN_ROLE,
                Role.status == ACTIVE_STATUS,
                TenantMembership.status == ACTIVE_STATUS,
                TenantMembership.deleted_at.is_(None),
                User.status.is_(True),
            )
            .with_for_update()
        )
        if other_administrator is None:
            raise ControlPlaneConflictError(
                "the last active workspace administrator cannot be suspended or "
                "have their administrator role removed"
            )

    async def _groups_for_users(
        self, tenant_id: UUID, user_ids: list[UUID]
    ) -> dict[UUID, list[Group]]:
        if not user_ids:
            return {}
        rows = (
            await self._session.execute(
                select(GroupMembership.user_id, Group)
                .join(Group, Group.id == GroupMembership.group_id)
                .where(
                    GroupMembership.user_id.in_(user_ids),
                    GroupMembership.status == ACTIVE_STATUS,
                    GroupMembership.deleted_at.is_(None),
                    Group.tenant_id == tenant_id,
                    Group.status == ACTIVE_STATUS,
                    Group.deleted_at.is_(None),
                )
                .order_by(Group.display_name, Group.id)
            )
        ).all()
        result: dict[UUID, list[Group]] = {}
        for user_id, group in rows:
            result.setdefault(user_id, []).append(group)
        return result

    async def _platform_memberships(
        self, user_ids: list[UUID]
    ) -> dict[UUID, list[dict[str, Any]]]:
        if not user_ids:
            return {}
        rows = (
            await self._session.execute(
                select(TenantMembership.user_id, Tenant, Role.display_name)
                .join(Tenant, Tenant.id == TenantMembership.tenant_id)
                .outerjoin(
                    RoleAssignment,
                    (RoleAssignment.user_id == TenantMembership.user_id)
                    & (RoleAssignment.tenant_id == TenantMembership.tenant_id)
                    & (RoleAssignment.deleted_at.is_(None)),
                )
                .outerjoin(Role, Role.id == RoleAssignment.role_id)
                .where(
                    TenantMembership.user_id.in_(user_ids),
                    TenantMembership.status == ACTIVE_STATUS,
                    TenantMembership.deleted_at.is_(None),
                )
                .order_by(Tenant.name, Tenant.id)
            )
        ).all()
        result: dict[UUID, dict[UUID, dict[str, Any]]] = {
            user_id: {} for user_id in user_ids
        }
        for user_id, tenant, role_name in rows:
            workspace = result[user_id].setdefault(
                tenant.id,
                {
                    "workspace_id": str(tenant.id),
                    "workspace_name": tenant.name,
                    "role_names": [],
                },
            )
            if role_name is not None:
                workspace["role_names"].append(role_name)
        return {
            user_id: list(workspaces.values())
            for user_id, workspaces in result.items()
        }

    async def _platform_roles(self, user_ids: list[UUID]) -> dict[UUID, list[str]]:
        """Read the platform roles held by each listed identity."""

        if not user_ids:
            return {}
        rows = (
            await self._session.execute(
                select(RoleAssignment.user_id, Role.code)
                .join(Role, Role.id == RoleAssignment.role_id)
                .where(
                    RoleAssignment.user_id.in_(user_ids),
                    RoleAssignment.tenant_id.is_(None),
                    RoleAssignment.item_id.is_(None),
                    RoleAssignment.deleted_at.is_(None),
                    Role.status == ACTIVE_STATUS,
                )
                .order_by(Role.code)
            )
        ).all()
        held: dict[UUID, list[str]] = {}
        for user_id, code in rows:
            held.setdefault(user_id, []).append(code)
        return held

    async def _replace_groups(
        self, tenant_id: UUID, user_id: UUID, group_ids: list[UUID]
    ) -> list[Group]:
        desired_ids = set(group_ids)
        if len(desired_ids) != len(group_ids):
            raise ControlPlaneValidationError("group IDs must be unique")
        groups = list(
            await self._session.scalars(
                select(Group).where(
                    Group.id.in_(desired_ids),
                    Group.tenant_id == tenant_id,
                    Group.status == ACTIVE_STATUS,
                    Group.deleted_at.is_(None),
                )
            )
        ) if desired_ids else []
        if {group.id for group in groups} != desired_ids:
            raise ControlPlaneNotFoundError("one or more groups were not found")

        existing = list(
            await self._session.scalars(
                select(GroupMembership)
                .join(Group, Group.id == GroupMembership.group_id)
                .where(
                    GroupMembership.user_id == user_id,
                    Group.tenant_id == tenant_id,
                )
                .with_for_update()
            )
        )
        now = datetime.now(UTC)
        by_group = {membership.group_id: membership for membership in existing}
        for membership in existing:
            if membership.group_id not in desired_ids:
                membership.status = INACTIVE_STATUS
                membership.deleted_at = now
        for group_id in desired_ids:
            membership = by_group.get(group_id)
            if membership is None:
                self._session.add(
                    GroupMembership(
                        group_id=group_id,
                        user_id=user_id,
                        joined_at=now,
                    )
                )
            else:
                membership.status = ACTIVE_STATUS
                membership.joined_at = membership.joined_at or now
                membership.deleted_at = None
        await self._session.flush()
        return sorted(groups, key=lambda group: (group.display_name, group.id))


def _account_payload(user: User, membership: TenantMembership | None) -> dict[str, Any]:
    if membership is None or membership.deleted_at is not None:
        workspace_membership = "none"
    elif membership.status == ACTIVE_STATUS and user.status:
        workspace_membership = "active"
    else:
        workspace_membership = "suspended"
    return {
        "id": str(user.id),
        "email": user.email,
        "display_name": user.display_name,
        "status": "active" if user.status else "disabled",
        "workspace_membership": workspace_membership,
    }


def _member_status(user: User, membership: TenantMembership) -> str:
    """A member's standing here: suspended by this workspace, or account-wide."""

    if not user.status:
        return "inactive"
    return "active" if membership.status == ACTIVE_STATUS else "suspended"


def _user_payload(
    user: User,
    membership: TenantMembership,
    roles: list[Role],
    groups: list[Group],
) -> dict[str, Any]:
    return {
        "id": str(user.id),
        "email": user.email,
        "display_name": user.display_name,
        "status": _member_status(user, membership),
        "last_login_at": timestamp(user.last_login_at),
        "created_at": timestamp(user.created_at),
        "updated_at": timestamp(user.updated_at),
        "membership": {
            "status": membership.status,
            "joined_at": timestamp(membership.joined_at),
            "roles": [
                {
                    "id": str(role.id),
                    "code": role.code,
                    "display_name": role.display_name,
                }
                for role in roles
            ],
        },
        "groups": [
            {
                "id": str(group.id),
                "code": group.code,
                "display_name": group.display_name,
            }
            for group in groups
        ],
    }


__all__ = ["UserService"]
