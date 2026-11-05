"""Library messages: MemberHome, Notification, SavedItem, RecentItem, SavedSearch."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from api.aip import filtering
from api.aip.fieldmask import MutableFields
from api.aip.filtering import FilterSchema
from api.aip.messages import ProtoMessage, Timestamp
from api.aip.ordering import OrderSchema
from bomesh.db.models import Notification, RecentItem, SavedItem, SavedSearch
from bomesh.services.knowledge_curation.records import (
    contribution_name,
    reading_list_name,
    topic_name,
)
from bomesh.services.knowledge_items.names import item_name
from bomesh.services.library.notifications import NOTIFICATION_READ, NOTIFICATION_TARGET
from bomesh.services.library.records import (
    HomeCollection,
    HomeItem,
    HomeTopic,
    ItemReference,
    MemberHomeRecord,
    NotificationRecord,
    SavedSearchRecord,
)

# -- Notifications --------------------------------------------------------------


class NotificationMessage(ProtoMessage):
    name: str | None = None
    kind: str | None = None
    title: str | None = None
    body: str | None = None
    target: str | None = None
    read: bool | None = None
    create_time: Timestamp | None = None
    delete_time: Timestamp | None = None
    purge_time: Timestamp | None = None


class ListNotificationsResponse(ProtoMessage):
    notifications: list[NotificationMessage]
    next_page_token: str | None = None
    total_size: int | None = None


class UndeleteNotificationRequest(ProtoMessage):
    pass


class MarkNotificationsReadRequest(ProtoMessage):
    filter: str | None = None


class MarkNotificationsReadResponse(ProtoMessage):
    updated_count: int


def notification_message(record: NotificationRecord) -> NotificationMessage:
    row = record.notification
    return NotificationMessage(
        name=record.name,
        kind=row.kind,
        title=row.title,
        body=row.body,
        target=record.target,
        read=row.read_at is not None,
        create_time=row.created_at,
        delete_time=row.deleted_at,
        purge_time=record.purge_time,
    )


NOTIFICATION_FIELDS = MutableFields(("read",))
NOTIFICATION_FILTERS = FilterSchema(
    {
        "read": filtering.boolean(NOTIFICATION_READ),
        "kind": filtering.string(Notification.kind),
        "createTime": filtering.timestamp(Notification.created_at),
        "target": filtering.string(NOTIFICATION_TARGET),
    }
)
NOTIFICATION_ORDER = OrderSchema(
    {"createTime": Notification.created_at},
    tie_breaker=[Notification.id],
    default="createTime desc",
)

# -- Saved and recent items -----------------------------------------------------


class SavedItemMessage(ProtoMessage):
    name: str | None = None
    item: str | None = None
    merged_from: str | None = None
    create_time: Timestamp | None = None


class ListSavedItemsResponse(ProtoMessage):
    saved_items: list[SavedItemMessage]
    next_page_token: str | None = None


class RecentItemMessage(ProtoMessage):
    name: str | None = None
    item: str | None = None
    merged_from: str | None = None
    view_time: Timestamp | None = None


class ListRecentItemsResponse(ProtoMessage):
    recent_items: list[RecentItemMessage]
    next_page_token: str | None = None


class ClearRecentItemsRequest(ProtoMessage):
    pass


def saved_item_message(record: ItemReference) -> SavedItemMessage:
    return SavedItemMessage(
        name=record.name("savedItems"),
        item=record.item,
        merged_from=record.merged_from_name,
        create_time=record.time,
    )


def recent_item_message(record: ItemReference) -> RecentItemMessage:
    return RecentItemMessage(
        name=record.name("recentItems"),
        item=record.item,
        merged_from=record.merged_from_name,
        view_time=record.time,
    )


#: Saved and recent items accept no filter fields.
NO_FILTERS = FilterSchema({})
SAVED_ITEM_ORDER = OrderSchema(
    {"createTime": SavedItem.created_at},
    tie_breaker=[SavedItem.item_id],
    default="createTime desc",
)
RECENT_ITEM_ORDER = OrderSchema(
    {"viewTime": RecentItem.viewed_at},
    tie_breaker=[RecentItem.item_id],
    default="viewTime desc",
)
RECENT_ITEM_FIELDS = MutableFields(("viewTime",))

# -- Saved searches -------------------------------------------------------------

Layout = Literal["LIST", "TABLE", "GRID"]


class SavedSearchMessage(ProtoMessage):
    name: str | None = None
    display_name: str | None = None
    query: str | None = None
    filter: str | None = None
    order_by: str | None = None
    layout: Layout | None = None
    create_time: Timestamp | None = None
    update_time: Timestamp | None = None


class ListSavedSearchesResponse(ProtoMessage):
    saved_searches: list[SavedSearchMessage]
    next_page_token: str | None = None


def saved_search_message(record: SavedSearchRecord) -> SavedSearchMessage:
    row = record.search
    return SavedSearchMessage(
        name=record.name,
        display_name=row.display_name,
        query=row.query,
        filter=row.filter,
        order_by=row.order_by,
        layout=row.layout.upper(),  # type: ignore[arg-type]
        create_time=row.created_at,
        update_time=row.updated_at,
    )


SAVED_SEARCH_FIELDS = MutableFields(("displayName", "query", "filter", "orderBy", "layout"))
SAVED_SEARCH_ORDER = OrderSchema(
    {"displayName": SavedSearch.display_name, "updateTime": SavedSearch.updated_at},
    tie_breaker=[SavedSearch.id],
    default="displayName",
)

# -- Home -----------------------------------------------------------------------

VerificationState = Literal["VERIFIED", "REVIEW_DUE", "UNVERIFIED"]


class MemberHomeItem(ProtoMessage):
    item: str
    merged_from: str | None = None
    display_name: str | None = None
    collection: str | None = None
    document_type: str | None = None
    publish_time: Timestamp | None = None
    thumbnail_uri: str | None = None
    verification_state: VerificationState | None = None


class MemberHomeCounts(ProtoMessage):
    collection_count: int
    document_count: int
    saved_item_count: int
    topic_count: int
    unread_notification_count: int


class MemberHomeTopTopic(ProtoMessage):
    topic: str
    display_name: str | None = None
    document_count: int | None = None


class MemberHomeTopicDomain(ProtoMessage):
    topic: str
    display_name: str | None = None
    document_count: int | None = None
    top_topics: list[MemberHomeTopTopic] | None = None


class MemberHomeCollection(ProtoMessage):
    collection: str
    display_name: str | None = None
    description: str | None = None
    access: Literal["READER", "EDITOR", "OWNER", "LOCKED"] | None = None
    owner_summary: str | None = None
    document_count: int | None = None


class MemberHomeReadingList(ProtoMessage):
    reading_list: str
    display_name: str | None = None
    item_count: int | None = None


class MemberHomeFeaturedItem(ProtoMessage):
    item: MemberHomeItem
    position: int
    source: Literal["CURATED", "POPULAR"]


class MemberHomeRecommendedReason(ProtoMessage):
    kind: Literal["BECAUSE_YOU_READ", "FROM_YOUR_SPACE", "SAVED_TOPIC", "POPULAR"]
    label: str | None = None


class MemberHomeRecommendedItem(ProtoMessage):
    item: MemberHomeItem
    reason: MemberHomeRecommendedReason


class MemberHomeContribution(ProtoMessage):
    contribution: str
    display_name: str | None = None
    state: str | None = None


class MemberHomeContinue(ProtoMessage):
    recent_items: list[MemberHomeItem]
    contributions: list[MemberHomeContribution]
    review_queue_count: int
    up_next: list[MemberHomeItem]


class MemberHome(ProtoMessage):
    name: str
    counts: MemberHomeCounts
    suggested_questions: list[str]
    topic_domains: list[MemberHomeTopicDomain]
    collections: list[MemberHomeCollection]
    reading_lists: list[MemberHomeReadingList]
    featured: list[MemberHomeFeaturedItem]
    recently_published: list[MemberHomeItem]
    recommended: list[MemberHomeRecommendedItem]
    continue_: MemberHomeContinue = Field(alias="continue")


def _home_item(card: HomeItem) -> MemberHomeItem:
    return MemberHomeItem(
        item=item_name(card.workspace_id, card.item_id),
        merged_from=(
            item_name(card.workspace_id, card.merged_from) if card.merged_from else None
        ),
        display_name=card.display_name,
        collection=(
            item_name(card.workspace_id, card.collection_id) if card.collection_id else None
        ),
        document_type=card.document_type,
        verification_state=card.verification_state,  # type: ignore[arg-type]
        publish_time=card.publish_time,
        thumbnail_uri=card.thumbnail_uri,
    )


def _topic_name(topic: HomeTopic) -> str:
    return topic_name(topic.workspace_id, topic.code)


def _collection(entry: HomeCollection) -> MemberHomeCollection:
    return MemberHomeCollection(
        collection=item_name(entry.workspace_id, entry.item_id),
        display_name=entry.display_name,
        description=entry.description,
        access=entry.access,  # type: ignore[arg-type]
        owner_summary=entry.owner_summary,
        document_count=entry.document_count,
    )


def member_home_message(record: MemberHomeRecord) -> MemberHome:
    ws = record.owner_workspace_id
    return MemberHome(
        name=record.name,
        counts=MemberHomeCounts(
            collection_count=record.counts.collection_count,
            document_count=record.counts.document_count,
            saved_item_count=record.counts.saved_item_count,
            topic_count=record.counts.topic_count,
            unread_notification_count=record.counts.unread_notification_count,
        ),
        suggested_questions=list(record.suggested_questions),
        topic_domains=[
            MemberHomeTopicDomain(
                topic=_topic_name(domain.domain),
                display_name=domain.domain.display_name,
                document_count=domain.domain.document_count,
                top_topics=[
                    MemberHomeTopTopic(
                        topic=_topic_name(topic),
                        display_name=topic.display_name,
                        document_count=topic.document_count,
                    )
                    for topic in domain.top_topics
                ],
            )
            for domain in record.topic_domains
        ],
        collections=[_collection(entry) for entry in record.collections],
        reading_lists=[
            MemberHomeReadingList(
                reading_list=reading_list_name(ws, entry.code),
                display_name=entry.display_name,
                item_count=entry.item_count,
            )
            for entry in record.reading_lists
        ],
        featured=[
            MemberHomeFeaturedItem(
                item=_home_item(entry.item),
                position=entry.position,
                source=entry.source,  # type: ignore[arg-type]
            )
            for entry in record.featured
        ],
        recently_published=[_home_item(card) for card in record.recently_published],
        recommended=[
            MemberHomeRecommendedItem(
                item=_home_item(entry.item),
                reason=MemberHomeRecommendedReason(
                    kind=entry.reason_kind,  # type: ignore[arg-type]
                    label=entry.reason_label,
                ),
            )
            for entry in record.recommended
        ],
        continue_=MemberHomeContinue(
            recent_items=[_home_item(card) for card in record.recent_items],
            contributions=[
                MemberHomeContribution(
                    contribution=contribution_name(ws, entry.contribution_id),
                    display_name=entry.display_name,
                    state=entry.state,
                )
                for entry in record.contributions
            ],
            review_queue_count=record.review_queue_count,
            up_next=[_home_item(card) for card in record.up_next],
        ),
    )


__all__ = [
    "NOTIFICATION_FIELDS",
    "NOTIFICATION_FILTERS",
    "NOTIFICATION_ORDER",
    "NO_FILTERS",
    "RECENT_ITEM_FIELDS",
    "RECENT_ITEM_ORDER",
    "SAVED_ITEM_ORDER",
    "SAVED_SEARCH_FIELDS",
    "SAVED_SEARCH_ORDER",
    "ClearRecentItemsRequest",
    "ListNotificationsResponse",
    "ListRecentItemsResponse",
    "ListSavedItemsResponse",
    "ListSavedSearchesResponse",
    "MarkNotificationsReadRequest",
    "MarkNotificationsReadResponse",
    "MemberHome",
    "NotificationMessage",
    "RecentItemMessage",
    "SavedItemMessage",
    "SavedSearchMessage",
    "UndeleteNotificationRequest",
    "member_home_message",
    "notification_message",
    "recent_item_message",
    "saved_item_message",
    "saved_search_message",
]
