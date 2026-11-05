"""Typed results of the Library use cases; the API maps them to messages."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from bomesh.db.models import Notification, SavedSearch
from bomesh.services.kernel.retention import purge_time
from bomesh.services.knowledge_items.names import item_name
from bomesh.services.workspaces.records import member_name

#: ``notifications.subject_type`` → the collection ID of the target's resource name.
TARGET_COLLECTIONS: dict[str, str] = {
    "item": "items",
    "contribution": "contributions",
    "request": "requests",
    "ingestion_source": "sources",
    "integration_connection": "connections",
    "space": "spaces",
}


@dataclass(frozen=True, slots=True)
class NotificationRecord:
    notification: Notification

    @property
    def name(self) -> str:
        row = self.notification
        return (
            f"{member_name(row.tenant_id, row.recipient_user_id)}/notifications/{row.id}"
        )

    @property
    def target(self) -> str | None:
        row = self.notification
        if row.subject_type is None or row.subject_id is None:
            return None
        return f"workspaces/{row.tenant_id}/{TARGET_COLLECTIONS[row.subject_type]}/{row.subject_id}"

    @property
    def purge_time(self) -> datetime | None:
        return purge_time(self.notification.deleted_at)


@dataclass(frozen=True, slots=True)
class ItemReference:
    """A saved or recent entry: stored under ``entry_id``, shown as the resolved ``item_id``."""

    workspace_id: UUID
    user_id: UUID
    entry_id: UUID
    item_id: UUID
    merged_from: UUID | None
    time: datetime

    def name(self, collection: str) -> str:
        return f"{member_name(self.workspace_id, self.user_id)}/{collection}/{self.entry_id}"

    @property
    def item(self) -> str:
        return item_name(self.workspace_id, self.item_id)

    @property
    def merged_from_name(self) -> str | None:
        return item_name(self.workspace_id, self.merged_from) if self.merged_from else None


@dataclass(frozen=True, slots=True)
class SavedSearchRecord:
    search: SavedSearch

    @property
    def name(self) -> str:
        row = self.search
        return f"{member_name(row.tenant_id, row.user_id)}/savedSearches/{row.id}"


@dataclass(frozen=True, slots=True)
class HomeItem:
    workspace_id: UUID
    item_id: UUID
    merged_from: UUID | None
    display_name: str
    collection_id: UUID | None
    document_type: str | None
    verification_state: str | None
    publish_time: datetime | None
    thumbnail_uri: str | None


@dataclass(frozen=True, slots=True)
class HomeCollection:
    workspace_id: UUID
    item_id: UUID
    display_name: str
    description: str | None
    access: str | None
    owner_summary: str | None
    document_count: int | None


@dataclass(frozen=True, slots=True)
class HomeTopic:
    workspace_id: UUID
    code: str
    display_name: str
    document_count: int


@dataclass(frozen=True, slots=True)
class HomeTopicDomain:
    domain: HomeTopic
    top_topics: tuple[HomeTopic, ...]


@dataclass(frozen=True, slots=True)
class HomeReadingList:
    workspace_id: UUID
    code: str
    display_name: str
    item_count: int


@dataclass(frozen=True, slots=True)
class HomeContribution:
    workspace_id: UUID
    contribution_id: UUID
    display_name: str
    state: str


@dataclass(frozen=True, slots=True)
class HomeFeatured:
    item: HomeItem
    position: int
    source: str


@dataclass(frozen=True, slots=True)
class HomeRecommended:
    item: HomeItem
    reason_kind: str
    reason_label: str


@dataclass(frozen=True, slots=True)
class HomeCounts:
    collection_count: int
    document_count: int
    saved_item_count: int
    topic_count: int
    unread_notification_count: int


@dataclass(frozen=True, slots=True)
class MemberHomeRecord:
    owner_workspace_id: UUID
    owner_user_id: UUID
    counts: HomeCounts
    suggested_questions: tuple[str, ...]
    topic_domains: tuple[HomeTopicDomain, ...]
    collections: tuple[HomeCollection, ...]
    reading_lists: tuple[HomeReadingList, ...]
    featured: tuple[HomeFeatured, ...]
    recently_published: tuple[HomeItem, ...]
    recommended: tuple[HomeRecommended, ...]
    recent_items: tuple[HomeItem, ...]
    contributions: tuple[HomeContribution, ...]
    review_queue_count: int
    up_next: tuple[HomeItem, ...]

    @property
    def name(self) -> str:
        return f"{member_name(self.owner_workspace_id, self.owner_user_id)}/home"


__all__ = [
    "TARGET_COLLECTIONS",
    "HomeCollection",
    "HomeContribution",
    "HomeCounts",
    "HomeFeatured",
    "HomeItem",
    "HomeReadingList",
    "HomeRecommended",
    "HomeTopic",
    "HomeTopicDomain",
    "ItemReference",
    "MemberHomeRecord",
    "NotificationRecord",
    "SavedSearchRecord",
]
