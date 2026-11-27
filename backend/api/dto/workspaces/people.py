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
from bomesh.services.workspaces.affiliations import ImportRow
from bomesh.services.workspaces.members import holds_role, in_group
from bomesh.services.workspaces.records import (
    Affiliation,
    GroupRecord,
    MemberRecord,
    MembershipRecord,
    RoleRecord,
)

# -- Members --------------------------------------------------------------------


class MemberAffiliationMessage(ProtoMessage):
    """``Member.affiliation``: personal data; ``source`` is output only."""

    units: list[str] | None = None
    programs: list[str] | None = None
    cohort: int | None = None
    source: Literal["DIRECTORY", "ADMIN"] | None = None


class MemberMessage(ProtoMessage):
    name: str | None = None
    user: str | None = None
    display_name: str | None = None
    email: str | None = None
    state: Literal["ACTIVE", "SUSPENDED"] | None = None
    roles: list[str] | None = None
    groups: list[str] | None = None
    personal_collection: str | None = None
    affiliation: MemberAffiliationMessage | None = None
    join_time: Timestamp | None = None
    last_active_time: Timestamp | None = None


class ListMembersResponse(ProtoMessage):
    members: list[MemberMessage]
    next_page_token: str | None = None
    total_size: int | None = None


class MemberStateRequest(ProtoMessage):
    """Empty body of ``:suspend`` and ``:activate``."""


#: UpdateMember changes only the affiliation.
MEMBER_FIELDS = MutableFields(("affiliation",))


class AffiliationRowMessage(ProtoMessage):
    """One registrar-list row: ``program``/``unit`` as a notation, a concept name or
    (program) an exact mapping code."""

    email: str
    program: str | None = None
    unit: str | None = None
    cohort: int | None = None


class ImportMemberAffiliationsRequest(ProtoMessage):
    rows: list[AffiliationRowMessage]
    validate_only: bool = False


class ImportMemberAffiliationsResponse(ProtoMessage):
    members: list[MemberMessage]
    skipped_members: list[str]


def import_rows(request: ImportMemberAffiliationsRequest) -> list[ImportRow]:
    return [
        ImportRow(email=row.email, program=row.program, unit=row.unit, cohort=row.cohort)
        for row in request.rows
    ]


def affiliation_message(value: Affiliation) -> MemberAffiliationMessage:
    return MemberAffiliationMessage(
        units=list(value.units),
        programs=list(value.programs),
        cohort=value.cohort,
        source=value.source.upper() if value.source else None,  # type: ignore[arg-type]
    )


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
        affiliation=(
            affiliation_message(record.affiliation) if record.affiliation is not None else None
        ),
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


def member_filters(workspace_id: UUID) -> FilterSchema:
    """The AIP-160 fields of ListMembers; ``name`` batch-reads members of this workspace."""

    def member_reference(name: str) -> UUID:
        parts = name.split("/")
        if len(parts) == 4 and parts[0] == "workspaces" and parts[2] == "members":
            try:
                parent, child = UUID(parts[1]), UUID(parts[3])
            except ValueError:
                pass
            else:
                if parent == workspace_id:
                    return child
        raise ValueError(f"'{name}' is not a member name of this workspace.")

    return FilterSchema(
        {
            "name": filtering.resource_name(TenantMembership.user_id, member_reference),
            "displayName": filtering.string(func.coalesce(User.user_name, User.email)),
            "email": filtering.string(User.email),
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
        "displayName": func.coalesce(User.user_name, User.email),
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
        display_name=group.group_name,
        description=group.description,
        member_count=record.member_count,
        etag=record.etag,
        create_time=group.created_at,
        update_time=group.updated_at,
    )


GROUP_FIELDS = MutableFields(("displayName", "description"))
GROUP_FILTERS = FilterSchema({"displayName": filtering.string(Group.group_name)})
GROUP_ORDER = OrderSchema(
    {"displayName": Group.group_name, "createTime": Group.created_at},
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
        display_name=role.role_name,
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
        "displayName": filtering.string(Role.role_name),
        "state": filtering.enum(
            case((Role.deleted_at.is_(None), "ACTIVE"), else_="DELETED"), ("ACTIVE", "DELETED")
        ),
    }
)
ROLE_ORDER = OrderSchema(
    {"displayName": Role.role_name, "createTime": Role.created_at},
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
        "displayName": filtering.string(Role.role_name),
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
