"""Typed results of the Library use cases; the API maps them to messages."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from bomesh.db.models import Notification, SavedSearch
from bomesh.services.kernel.retention import purge_time
from bomesh.services.knowledge_items.names import item_name
from bomesh.services.knowledge_items.records import Cover
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
    """A saved or recent entry, keyed by the item it names."""

    workspace_id: UUID
    user_id: UUID
    item_id: UUID
    time: datetime

    def name(self, collection: str) -> str:
        return f"{member_name(self.workspace_id, self.user_id)}/{collection}/{self.item_id}"

    @property
    def item(self) -> str:
        return item_name(self.workspace_id, self.item_id)


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
    display_name: str
    collection_id: UUID | None
    verification_state: str | None
    publish_time: datetime | None
    cover: Cover | None


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
class HomeConcept:
    """A concept of the Home scheme: its current display name and the caller's documents in it."""

    workspace_id: UUID
    scheme_code: str
    notation: str
    display_name: str
    document_count: int


@dataclass(frozen=True, slots=True)
class HomeFeaturedConcept:
    concept: HomeConcept
    description: str | None
    icon: str | None
    color: str | None
    new_document_count: int
    top_concepts: tuple[HomeConcept, ...]


@dataclass(frozen=True, slots=True)
class HomeStarterPrompt:
    title: str
    prompt: str


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


@dataclass(frozen=True, slots=True)
class HomeRecommended:
    item: HomeItem
    reason_kind: str
    #: The reason's subject: a starter prompt's title, a concept's or a space's name; empty for POPULAR.
    reason_label: str


@dataclass(frozen=True, slots=True)
class HomeCounts:
    collection_count: int
    document_count: int
    saved_item_count: int
    conversation_count: int
    unread_notification_count: int


@dataclass(frozen=True, slots=True)
class MemberHomeRecord:
    owner_workspace_id: UUID
    owner_user_id: UUID
    join_time: datetime | None
    counts: HomeCounts
    starter_prompts: tuple[HomeStarterPrompt, ...]
    featured_concepts: tuple[HomeFeaturedConcept, ...]
    collections: tuple[HomeCollection, ...]
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
    "HomeConcept",
    "HomeContribution",
    "HomeCounts",
    "HomeFeatured",
    "HomeFeaturedConcept",
    "HomeItem",
    "HomeRecommended",
    "HomeStarterPrompt",
    "ItemReference",
    "MemberHomeRecord",
    "NotificationRecord",
    "SavedSearchRecord",
]
