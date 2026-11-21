"""SQL expressions of the Item fields lists, filters, orderings and facets read.

The API builds its AIP-160 filter and orderBy schemas from these, so a field
means the same thing in ListItems, SearchItems and the facets.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, Text, and_, case, cast, exists, func, or_, select
from sqlalchemy.orm import aliased

from bomesh.db.models import (
    ExternalResource,
    IngestionSource,
    Item,
    ItemRevision,
    ItemTopic,
    Topic,
)
from bomesh.iam.policy import PERSONAL_COLLECTION_TYPE
from bomesh.services.knowledge_items.item_store import in_subtree

#: ``document.contentState`` (derived: :attr:`Item.content_state`).
CONTENT_STATE: ColumnElement[Any] = func.upper(Item.content_state)
PUBLICATION_STATE: ColumnElement[Any] = case(
    (Item.is_published, "PUBLISHED"),
    (Item.is_published.is_(False), "UNPUBLISHED"),
)
ITEM_KIND: ColumnElement[Any] = func.upper(Item.item_kind)
ITEM_TYPE: ColumnElement[Any] = func.upper(Item.item_type)
PURPOSE: ColumnElement[Any] = func.upper(Item.purpose)


def _personal_tree() -> Any:
    """CTE of every member's PERSONAL collection ("My files") and everything under it."""
    root = aliased(Item, name="personal_root")
    seed = select(root.id).where(
        root.item_kind == "collection", root.item_type == PERSONAL_COLLECTION_TYPE
    )
    tree = seed.cte("personal_tree", recursive=True)
    child = aliased(Item, name="personal_child")
    return tree.union_all(select(child.id).where(child.parent_item_id == tree.c.id))


_PERSONAL_TREE = _personal_tree()
#: ``document.collectionKind``: PERSONAL in a member's My files (their private scope),
#: STANDARD in the workspace's shared collections; NULL for collections (a document field).
COLLECTION_KIND: ColumnElement[Any] = case(
    (Item.item_kind != "document", None),
    (Item.id.in_(select(_PERSONAL_TREE.c.id)), "PERSONAL"),
    else_="STANDARD",
)
#: ``document.owner`` as text, the form filters and facets compare.
OWNER_ID: ColumnElement[Any] = cast(Item.owner_user_id, Text)
#: ``document.origin.source``: the API ID (``ingestion_sources.code``) of the source
#: that registered the document (its ``external_resources`` row).
SOURCE_CODE: ColumnElement[Any] = (
    select(IngestionSource.code)
    .join(ExternalResource, ExternalResource.ingestion_source_id == IngestionSource.id)
    .where(ExternalResource.item_id == Item.id, Item.item_kind == "document")
    .order_by(ExternalResource.deleted_at.desc().nulls_first())
    .limit(1)
    .correlate(Item)
    .scalar_subquery()
)
LANGUAGE: ColumnElement[Any] = Item.language_code
VERIFICATION_STATE: ColumnElement[Any] = case(
    (Item.verified_at.is_(None), "UNVERIFIED"),
    (
        and_(Item.next_review_at.is_not(None), Item.next_review_at <= func.now()),
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

#: ``document.mimeType``: the current revision's type (``items`` stores no content facts).
MIME_TYPE: ColumnElement[Any] = (
    select(_CURRENT_REVISION.mime_type)
    .where(_CURRENT_REVISION.id == Item.current_revision_id)
    .correlate(Item)
    .scalar_subquery()
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


#: The domain a tag's topic sits under (``document.topics`` is hierarchical).
_DOMAIN = aliased(Topic)


def has_topic(code: str) -> ColumnElement[bool]:
    """``document.topics:"workspaces/w/topics/{code}"``: tagged with the topic or, for a
    DOMAIN, with any topic under it (like ``ancestors:`` for collections)."""
    return _tagged_with(code)


def has_assistant_topic(code: str) -> ColumnElement[bool]:
    """``document.assistantTopics:"workspaces/w/topics/{code}"``: :func:`has_topic` over
    the tags the assistant applied (no person has set or confirmed them)."""
    return _tagged_with(code, ItemTopic.created_by_user_id.is_(None))


def _tagged_with(code: str, *conditions: ColumnElement[bool]) -> ColumnElement[bool]:
    return exists(
        select(ItemTopic.item_id)
        .join(Topic, Topic.id == ItemTopic.topic_id)
        .outerjoin(_DOMAIN, _DOMAIN.id == Topic.parent_topic_id)
        .where(
            ItemTopic.item_id == Item.id,
            or_(Topic.code == code, _DOMAIN.code == code),
            *conditions,
        )
    )


#: ``document.topics:*``: tagged with at least one topic.
HAS_TOPICS: ColumnElement[bool] = exists().where(ItemTopic.item_id == Item.id)
#: ``document.assistantTopics:*``: carries at least one assistant-applied tag.
HAS_ASSISTANT_TOPICS: ColumnElement[bool] = exists().where(
    ItemTopic.item_id == Item.id, ItemTopic.created_by_user_id.is_(None)
)


def has_ancestor(item_id: UUID) -> ColumnElement[bool]:
    """``ancestors:"workspaces/w/items/{item}"``: the canonical subtree only, never links."""
    return in_subtree(Item.id, item_id)


__all__ = [
    "COLLECTION_KIND",
    "CONTENT_STATE",
    "HAS_ASSISTANT_TOPICS",
    "HAS_TOPICS",
    "ITEM_KIND",
    "ITEM_TYPE",
    "LANGUAGE",
    "OWNER_ID",
    "PUBLICATION_STATE",
    "PUBLISH_TIME",
    "PURPOSE",
    "SOURCE_CODE",
    "VERIFICATION_STATE",
    "has_ancestor",
    "has_assistant_topic",
    "has_topic",
    "indexing_state",
]
