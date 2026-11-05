"""SQL expressions of the Item fields lists, filters, orderings and facets read.

The API builds its AIP-160 filter and orderBy schemas from these, so a field
means the same thing in ListItems, SearchItems and the facets.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, and_, case, exists, func, select
from sqlalchemy.orm import aliased

from bomesh.db.models import Item, ItemRevision, ItemTopic, Topic
from bomesh.services.knowledge_items.item_store import in_subtree

CONTENT_STATE: ColumnElement[Any] = case(
    (Item.status == "ready", "AVAILABLE"),
    (Item.status == "failed", "FAILED"),
    else_="PENDING",
)
PUBLICATION_STATE: ColumnElement[Any] = func.upper(Item.publication_state)
ITEM_TYPE: ColumnElement[Any] = func.upper(Item.item_type)
PURPOSE: ColumnElement[Any] = func.upper(
    func.coalesce(Item.metadata_["purpose"].astext, "knowledge")
)
OWNER_ID: ColumnElement[Any] = Item.metadata_["owner_user_id"].astext
#: ``document.origin.source``: the source's API ID (``ingestion_sources.code``).
SOURCE_CODE: ColumnElement[Any] = Item.metadata_["source"]["source_code"].astext
LANGUAGE: ColumnElement[Any] = Item.metadata_["language"].astext
_NEXT_REVIEW = Item.metadata_["verification"]["next_review_at"].astext
VERIFICATION_STATE: ColumnElement[Any] = case(
    (Item.metadata_["verification"]["state"].astext.is_distinct_from("verified"), "UNVERIFIED"),
    (
        and_(_NEXT_REVIEW.is_not(None), func.cast(_NEXT_REVIEW, Item.updated_at.type) <= func.now()),
        "REVIEW_DUE",
    ),
    else_="VERIFIED",
)


_CURRENT_REVISION = aliased(ItemRevision)
#: When the current content was published: the current live revision's time,
#: else the item's (``recently published`` ordering on Home).
PUBLISH_TIME: ColumnElement[Any] = func.coalesce(
    select(func.max(_CURRENT_REVISION.created_at))
    .where(_CURRENT_REVISION.item_id == Item.id, _CURRENT_REVISION.deleted_at.is_(None))
    .correlate(Item)
    .scalar_subquery(),
    Item.created_at,
)


def indexing_state(processing_version: str) -> ColumnElement[Any]:
    """``document.indexingState``; SUCCEEDED with another configuration is OUTDATED."""
    return case(
        (Item.index_status == "processing", "RUNNING"),
        (
            and_(
                Item.index_status == "ready",
                Item.processed_version.is_distinct_from(processing_version),
            ),
            "OUTDATED",
        ),
        (Item.index_status == "ready", "SUCCEEDED"),
        (Item.index_status == "failed", "FAILED"),
        (Item.index_status == "unsupported", "UNSUPPORTED"),
        else_="PENDING",
    )


def has_topic(code: str) -> ColumnElement[bool]:
    """``document.topics:"workspaces/w/topics/{code}"``."""
    return exists(
        select(ItemTopic.item_id)
        .join(Topic, Topic.id == ItemTopic.topic_id)
        .where(ItemTopic.item_id == Item.id, Topic.code == code)
    )


def has_ancestor(item_id: UUID) -> ColumnElement[bool]:
    """``ancestors:"workspaces/w/items/{item}"``: the canonical subtree only, never links."""
    return in_subtree(Item.id, item_id)


__all__ = [
    "CONTENT_STATE",
    "ITEM_TYPE",
    "LANGUAGE",
    "OWNER_ID",
    "PUBLICATION_STATE",
    "PUBLISH_TIME",
    "PURPOSE",
    "SOURCE_CODE",
    "VERIFICATION_STATE",
    "has_ancestor",
    "has_topic",
    "indexing_state",
]
