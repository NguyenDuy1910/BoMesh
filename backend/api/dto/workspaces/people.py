"""Member, Group, Membership, Role (custom and predefined) and Permission messages."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from sqlalchemy import case, func

from api.aip import filtering
from api.aip.fieldmask import MutableFields
from api.aip.filtering import FilterSchema
from api.aip.messages import ProtoMessage, Timestamp
from api.aip.ordering import OrderSchema
from bomesh.db.models import Group, GroupMembership, Role, TenantMembership, User
from bomesh.db.models import Permission as PermissionRow
from bomesh.iam.catalog import Permission, PredefinedRole
from bomesh.services.workspaces.members import holds_role, in_group
from bomesh.services.workspaces.records import (
    GroupRecord,
    MemberRecord,
    MembershipRecord,
    RoleRecord,
)

# -- Members --------------------------------------------------------------------


class MemberMessage(ProtoMessage):
    name: str | None = None
    user: str | None = None
    display_name: str | None = None
    email: str | None = None
    state: Literal["ACTIVE", "SUSPENDED"] | None = None
    roles: list[str] | None = None
    groups: list[str] | None = None
    personal_collection: str | None = None
    join_time: Timestamp | None = None
    last_active_time: Timestamp | None = None


class ListMembersResponse(ProtoMessage):
    members: list[MemberMessage]
    next_page_token: str | None = None


class MemberStateRequest(ProtoMessage):
    """Empty body of ``:suspend`` and ``:activate``."""


def member_message(record: MemberRecord) -> MemberMessage:
    return MemberMessage(
        name=record.name,
        user=record.user,
        display_name=record.display_name,
        email=record.email,
        state=record.state.upper(),  # type: ignore[arg-type]
        roles=list(record.roles),
        groups=list(record.groups),
        personal_collection=record.personal_collection,
        join_time=record.joined_at,
        last_active_time=record.last_active_at,
    )


def _role_reference(name: str) -> tuple[UUID | None, str]:
    parts = name.split("/")
    if len(parts) == 2 and parts[0] == "roles" and parts[1]:
        return None, parts[1]
    if len(parts) == 4 and parts[0] == "workspaces" and parts[2] == "roles" and parts[3]:
        return UUID(parts[1]), parts[3]
    raise ValueError(f"expected a role name, got {name!r}")


def _group_reference(name: str) -> tuple[UUID, str]:
    parts = name.split("/")
    if len(parts) == 4 and parts[0] == "workspaces" and parts[2] == "groups" and parts[3]:
        return UUID(parts[1]), parts[3]
    raise ValueError(f"expected a group name, got {name!r}")


MEMBER_FILTERS = FilterSchema(
    {
        "state": filtering.enum(func.upper(TenantMembership.status), ("ACTIVE", "SUSPENDED")),
        "roles": filtering.repeated(
            filtering.resource_name(TenantMembership.user_id, _role_reference),
            has=lambda reference: holds_role(*reference),
        ),
        "groups": filtering.repeated(
            filtering.resource_name(TenantMembership.user_id, _group_reference),
            has=lambda reference: in_group(*reference),
        ),
    }
)
MEMBER_ORDER = OrderSchema(
    {
        "displayName": func.coalesce(User.display_name, User.email),
        "joinTime": TenantMembership.joined_at,
        "lastActiveTime": TenantMembership.last_active_at,
    },
    tie_breaker=[TenantMembership.user_id],
    default="displayName",
)

# -- Groups and memberships -----------------------------------------------------


class GroupMessage(ProtoMessage):
    name: str | None = None
    display_name: str | None = None
    description: str | None = None
    member_count: int | None = None
    etag: str | None = None
    create_time: Timestamp | None = None
    update_time: Timestamp | None = None


class ListGroupsResponse(ProtoMessage):
    groups: list[GroupMessage]
    next_page_token: str | None = None


def group_message(record: GroupRecord) -> GroupMessage:
    group = record.group
    return GroupMessage(
        name=record.name,
        display_name=group.display_name,
        description=group.description,
        member_count=record.member_count,
        etag=record.etag,
        create_time=group.created_at,
        update_time=group.updated_at,
    )


GROUP_FIELDS = MutableFields(("displayName", "description"))
GROUP_FILTERS = FilterSchema({"displayName": filtering.string(Group.display_name)})
GROUP_ORDER = OrderSchema(
    {"displayName": Group.display_name, "createTime": Group.created_at},
    tie_breaker=[Group.id],
    default="displayName",
)


class MembershipMessage(ProtoMessage):
    name: str | None = None
    member: str
    create_time: Timestamp | None = None


class ListMembershipsResponse(ProtoMessage):
    memberships: list[MembershipMessage]
    next_page_token: str | None = None


def membership_message(record: MembershipRecord) -> MembershipMessage:
    return MembershipMessage(name=record.name, member=record.member, create_time=record.created_at)


MEMBERSHIP_FILTERS = FilterSchema({})
MEMBERSHIP_ORDER = OrderSchema(
    {"createTime": GroupMembership.joined_at},
    tie_breaker=[GroupMembership.user_id],
    default="createTime",
)

# -- Roles ----------------------------------------------------------------------


class RoleMessage(ProtoMessage):
    name: str | None = None
    display_name: str | None = None
    description: str | None = None
    included_permissions: list[str] | None = None
    state: Literal["ACTIVE", "DELETED"] | None = None
    etag: str | None = None
    create_time: Timestamp | None = None
    update_time: Timestamp | None = None
    delete_time: Timestamp | None = None
    purge_time: Timestamp | None = None


class ListRolesResponse(ProtoMessage):
    roles: list[RoleMessage]
    next_page_token: str | None = None


class UndeleteRoleRequest(ProtoMessage):
    etag: str | None = None


def role_message(record: RoleRecord) -> RoleMessage:
    role = record.role
    return RoleMessage(
        name=record.name,
        display_name=role.display_name,
        description=role.description,
        included_permissions=list(record.permissions),
        state="DELETED" if role.deleted_at is not None else "ACTIVE",
        etag=record.etag,
        create_time=role.created_at,
        update_time=role.updated_at,
        delete_time=role.deleted_at,
        purge_time=record.purge_time,
    )


def predefined_role_message(role: PredefinedRole) -> RoleMessage:
    return RoleMessage(
        name=role.name,
        display_name=role.title,
        description=role.description,
        included_permissions=sorted(role.permissions),
    )


ROLE_FIELDS = MutableFields(("displayName", "description", "includedPermissions"))
ROLE_FILTERS = FilterSchema(
    {
        "displayName": filtering.string(Role.display_name),
        "state": filtering.enum(
            case((Role.deleted_at.is_(None), "ACTIVE"), else_="DELETED"), ("ACTIVE", "DELETED")
        ),
    }
)
ROLE_ORDER = OrderSchema(
    {"displayName": Role.display_name, "createTime": Role.created_at},
    tie_breaker=[Role.id],
    default="displayName",
)


def _predefined_code(name: str) -> str:
    collection, _, code = name.partition("/")
    if collection != "roles" or not code:
        raise ValueError(f"expected 'roles/{{role}}', got {name!r}")
    return code


PREDEFINED_ROLE_FILTERS = FilterSchema(
    {
        "name": filtering.resource_name(Role.code, _predefined_code),
        "displayName": filtering.string(Role.display_name),
    }
)
PREDEFINED_ROLE_ORDER = OrderSchema({"name": Role.code}, tie_breaker=[Role.code])

# -- Permissions ----------------------------------------------------------------


class PermissionMessage(ProtoMessage):
    name: str
    title: str
    description: str
    custom_roles_supported: bool


class ListPermissionsResponse(ProtoMessage):
    permissions: list[PermissionMessage]
    next_page_token: str | None = None


def permission_message(permission: Permission) -> PermissionMessage:
    return PermissionMessage(
        name=permission.resource_name,
        title=permission.title,
        description=permission.description,
        custom_roles_supported=permission.custom_roles_supported,
    )


def _permission_code(name: str) -> str:
    collection, _, code = name.partition("/")
    if collection != "permissions" or not code:
        raise ValueError(f"expected 'permissions/{{permission}}', got {name!r}")
    return code


PERMISSION_FILTERS = FilterSchema(
    {
        "name": filtering.resource_name(PermissionRow.code, _permission_code),
        "title": filtering.string(PermissionRow.title),
        "customRolesSupported": filtering.boolean(PermissionRow.custom_roles_supported),
    }
)
PERMISSION_ORDER = OrderSchema({"name": PermissionRow.code}, tie_breaker=[PermissionRow.code])
