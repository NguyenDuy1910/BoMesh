"""Space, SpaceMember, Material, Announcement, SpaceEvent and RequestType messages."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import Field
from sqlalchemy import case, func

from api.aip import filtering
from api.aip.fieldmask import MutableFields
from api.aip.filtering import FilterSchema
from api.aip.messages import ProtoMessage, Timestamp
from api.aip.ordering import OrderSchema
from bomesh.db.models import (
    RequestType,
    Space,
    SpaceAnnouncement,
    SpaceEvent,
    SpaceMaterial,
)
from bomesh.services.collaboration.members import MEMBER_DISPLAY_NAME, SPACE_MEMBERS
from bomesh.services.collaboration.records import (
    RequestTypeRecord,
    SpaceChild,
    SpaceMemberRecord,
    SpaceRecord,
)
from bomesh.services.collaboration.request_types import FieldSpec, RuleSpec
from bomesh.services.collaboration.support import (
    caller_role_column,
    member_count_column,
    space_state_column,
)
from bomesh.services.kernel.retention import purge_time
from bomesh.services.knowledge_items.names import item_name
from bomesh.services.workspaces.records import member_name

# -- Space ----------------------------------------------------------------------


class SpaceMessage(ProtoMessage):
    name: str | None = None
    uid: str | None = None
    display_name: str | None = None
    space_type: str | None = None
    description: str | None = None
    join_policy: Literal["OPEN", "REQUEST", "INVITE"] | None = None
    member_count: int | None = None
    caller_role: str | None = None
    collections: list[str] | None = None
    state: Literal["ACTIVE", "DELETED"] | None = None
    create_time: Timestamp | None = None
    update_time: Timestamp | None = None
    delete_time: Timestamp | None = None
    purge_time: Timestamp | None = None
    etag: str | None = None


class ListSpacesResponse(ProtoMessage):
    spaces: list[SpaceMessage] = Field(default_factory=list)
    next_page_token: str | None = None
    total_size: int | None = None


class UndeleteSpaceRequest(ProtoMessage):
    etag: str | None = None


class JoinSpaceRequest(ProtoMessage):
    pass


class LeaveSpaceRequest(ProtoMessage):
    pass


def space_message(record: SpaceRecord) -> SpaceMessage:
    space = record.space
    return SpaceMessage(
        name=record.name,
        uid=str(space.id),
        display_name=space.display_name,
        space_type=space.space_type or None,
        description=space.description,
        join_policy=space.join_policy.upper(),  # type: ignore[arg-type]
        member_count=record.member_count,
        caller_role=record.caller_role,
        collections=[
            item_name(record.workspace_id, item) for item in record.collections
        ],
        state="DELETED" if space.deleted_at is not None else "ACTIVE",
        create_time=space.created_at,
        update_time=space.updated_at,
        delete_time=space.deleted_at,
        purge_time=purge_time(space.deleted_at),
        etag=record.etag,
    )


SPACE_FIELDS = MutableFields(("displayName", "spaceType", "description", "joinPolicy"))


def space_filters(user_id: Any) -> FilterSchema:
    """The ListSpaces filter; ``callerRole`` is relative to the caller."""
    return FilterSchema(
        {
            "joinPolicy": filtering.enum(
                func.upper(Space.join_policy), ("OPEN", "REQUEST", "INVITE")
            ),
            "spaceType": filtering.string(Space.space_type),
            "state": filtering.enum(space_state_column(), ("ACTIVE", "DELETED")),
            "callerRole": filtering.string(caller_role_column(user_id)),
        }
    )


SPACE_ORDER = OrderSchema(
    {
        "displayName": Space.display_name,
        "createTime": Space.created_at,
        "memberCount": member_count_column(),
    },
    tie_breaker=[Space.id],
    default="displayName",
)


# -- Space members --------------------------------------------------------------


class SpaceMemberMessage(ProtoMessage):
    name: str | None = None
    member: str | None = None
    display_name: str | None = None
    roles: list[str] | None = None
    join_time: Timestamp | None = None


class ListSpaceMembersResponse(ProtoMessage):
    members: list[SpaceMemberMessage] = Field(default_factory=list)
    next_page_token: str | None = None
    total_size: int | None = None


def space_member_message(record: SpaceMemberRecord) -> SpaceMemberMessage:
    return SpaceMemberMessage(
        name=record.name,
        member=member_name(record.workspace_id, record.user_id),
        display_name=record.display_name,
        roles=list(record.roles),
        join_time=record.join_time,
    )


SPACE_MEMBER_FILTERS = FilterSchema(
    {"roles": filtering.repeated(filtering.string(SPACE_MEMBERS.c.roles))}
)
SPACE_MEMBER_ORDER = OrderSchema(
    {"joinTime": SPACE_MEMBERS.c.join_time, "displayName": MEMBER_DISPLAY_NAME},
    tie_breaker=[SPACE_MEMBERS.c.user_id],
    default="joinTime",
)


# -- Materials ------------------------------------------------------------------


class MaterialMessage(ProtoMessage):
    name: str | None = None
    item: str | None = None
    note: str | None = None
    added_by: str | None = None
    create_time: Timestamp | None = None
    update_time: Timestamp | None = None


class ListMaterialsResponse(ProtoMessage):
    materials: list[MaterialMessage] = Field(default_factory=list)
    next_page_token: str | None = None
    total_size: int | None = None


def material_message(record: SpaceChild) -> MaterialMessage:
    row: SpaceMaterial = record.row  # type: ignore[assignment]
    return MaterialMessage(
        name=record.name,
        item=item_name(record.workspace_id, row.item_id),
        note=row.note,
        added_by=member_name(record.workspace_id, row.added_by_user_id),
        create_time=row.created_at,
        update_time=row.updated_at,
    )


MATERIAL_FILTERS = FilterSchema({})
MATERIAL_ORDER = OrderSchema(
    {"createTime": SpaceMaterial.created_at},
    tie_breaker=[SpaceMaterial.id],
    default="createTime",
)


# -- Announcements --------------------------------------------------------------


class AnnouncementMessage(ProtoMessage):
    name: str | None = None
    title: str | None = None
    body: str | None = None
    pinned: bool | None = None
    author: str | None = None
    create_time: Timestamp | None = None
    update_time: Timestamp | None = None
    etag: str | None = None


class ListAnnouncementsResponse(ProtoMessage):
    announcements: list[AnnouncementMessage] = Field(default_factory=list)
    next_page_token: str | None = None
    total_size: int | None = None


def announcement_message(record: SpaceChild) -> AnnouncementMessage:
    row: SpaceAnnouncement = record.row  # type: ignore[assignment]
    return AnnouncementMessage(
        name=record.name,
        title=row.title,
        body=row.body,
        pinned=row.pinned,
        author=member_name(record.workspace_id, row.author_user_id),
        create_time=row.created_at,
        update_time=row.updated_at,
        etag=record.etag,
    )


ANNOUNCEMENT_FIELDS = MutableFields(("title", "body", "pinned"))
ANNOUNCEMENT_FILTERS = FilterSchema(
    {"pinned": filtering.boolean(SpaceAnnouncement.pinned)}
)
#: Pinned announcements always come first (the service orders by ``pinned`` before this).
ANNOUNCEMENT_ORDER = OrderSchema(
    {"createTime": SpaceAnnouncement.created_at},
    tie_breaker=[SpaceAnnouncement.id],
    default="createTime desc",
)


# -- Events ---------------------------------------------------------------------


class SpaceEventMessage(ProtoMessage):
    name: str | None = None
    title: str | None = None
    start_time: Timestamp | None = None
    end_time: Timestamp | None = None
    location: str | None = None
    description: str | None = None
    create_time: Timestamp | None = None
    update_time: Timestamp | None = None
    etag: str | None = None


class ListSpaceEventsResponse(ProtoMessage):
    events: list[SpaceEventMessage] = Field(default_factory=list)
    next_page_token: str | None = None
    total_size: int | None = None


def space_event_message(record: SpaceChild) -> SpaceEventMessage:
    row: SpaceEvent = record.row  # type: ignore[assignment]
    return SpaceEventMessage(
        name=record.name,
        title=row.title,
        start_time=row.start_at,
        end_time=row.end_at,
        location=row.location,
        description=row.description,
        create_time=row.created_at,
        update_time=row.updated_at,
        etag=record.etag,
    )


EVENT_FIELDS = MutableFields(
    ("title", "startTime", "endTime", "location", "description")
)
EVENT_FILTERS = FilterSchema(
    {
        "startTime": filtering.timestamp(SpaceEvent.start_at),
        "endTime": filtering.timestamp(SpaceEvent.end_at),
    }
)
EVENT_ORDER = OrderSchema(
    {"startTime": SpaceEvent.start_at}, tie_breaker=[SpaceEvent.id], default="startTime"
)


# -- Request types --------------------------------------------------------------


class RequestTypeFieldMessage(ProtoMessage):
    key: str
    type: Literal["STRING", "TEXT", "NUMBER", "BOOLEAN", "DATE", "SELECT", "ITEM"]
    display_name: str | None = None
    required: bool | None = None
    options: list[str] | None = None


class RequestTypeRuleMessage(ProtoMessage):
    condition: str
    severity: Literal["BLOCK", "WARN"]
    message: str | None = None
    policy_citation: str | None = None


class RequestTypeMessage(ProtoMessage):
    name: str | None = None
    display_name: str | None = None
    description: str | None = None
    fields: list[RequestTypeFieldMessage] | None = None
    rules: list[RequestTypeRuleMessage] | None = None
    sla_duration: str | None = Field(default=None, pattern=r"^[0-9]+(\.[0-9]+)?s$")
    state: Literal["ACTIVE", "DELETED"] | None = None
    create_time: Timestamp | None = None
    update_time: Timestamp | None = None
    etag: str | None = None
    delete_time: Timestamp | None = None
    purge_time: Timestamp | None = None


class ListRequestTypesResponse(ProtoMessage):
    request_types: list[RequestTypeMessage] = Field(default_factory=list)
    next_page_token: str | None = None
    total_size: int | None = None


class UndeleteRequestTypeRequest(ProtoMessage):
    etag: str | None = None


def field_specs(fields: list[RequestTypeFieldMessage] | None) -> list[FieldSpec]:
    return [
        FieldSpec(
            key=entry.key,
            type=entry.type,
            display_name=entry.display_name,
            required=bool(entry.required),
            options=tuple(entry.options or ()),
        )
        for entry in fields or ()
    ]


def rule_specs(rules: list[RequestTypeRuleMessage] | None) -> list[RuleSpec]:
    return [
        RuleSpec(
            condition=rule.condition,
            severity=rule.severity,
            message=rule.message,
            policy_citation=rule.policy_citation,
        )
        for rule in rules or ()
    ]


def _seconds(value: Any) -> str | None:
    if value is None:
        return None
    seconds = value.total_seconds()
    return f"{int(seconds)}s" if seconds == int(seconds) else f"{seconds}s"


def request_type_message(record: RequestTypeRecord) -> RequestTypeMessage:
    row = record.request_type
    return RequestTypeMessage(
        name=record.name,
        display_name=row.display_name,
        description=row.description,
        fields=[
            RequestTypeFieldMessage(
                key=entry["key"],
                type=entry["type"].upper(),
                display_name=entry.get("display_name"),
                required=entry.get("required", False),
                options=entry.get("options") or None,
            )
            for entry in row.fields
        ],
        rules=[
            RequestTypeRuleMessage(
                condition=rule["condition"],
                severity=rule["severity"].upper(),
                message=rule.get("message"),
                policy_citation=(
                    f"workspaces/{record.workspace_id}/items/{rule['policy_citation_item_id']}"
                    if rule.get("policy_citation_item_id") in record.readable_citations
                    else None
                ),
            )
            for rule in row.rules
        ],
        sla_duration=_seconds(row.sla_duration),
        state="DELETED" if row.deleted_at is not None else "ACTIVE",
        create_time=row.created_at,
        update_time=row.updated_at,
        etag=record.etag,
        delete_time=row.deleted_at,
        purge_time=purge_time(row.deleted_at),
    )


REQUEST_TYPE_FIELDS = MutableFields(
    ("displayName", "description", "fields", "rules", "slaDuration")
)
REQUEST_TYPE_FILTERS = FilterSchema(
    {
        "state": filtering.enum(
            case((RequestType.deleted_at.is_(None), "ACTIVE"), else_="DELETED"),
            ("ACTIVE", "DELETED"),
        )
    }
)
REQUEST_TYPE_ORDER = OrderSchema(
    {"displayName": RequestType.display_name},
    tie_breaker=[RequestType.id],
    default="displayName",
)
