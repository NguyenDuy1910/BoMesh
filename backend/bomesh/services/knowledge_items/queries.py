"""SQL expressions of the Item fields lists, filters, orderings and facets read.

The API builds its AIP-160 filter and orderBy schemas from these, so a field
means the same thing in ListItems, SearchItems and the facets.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import ColumnElement, Text, and_, case, cast, exists, func, or_, select
from sqlalchemy.orm import aliased

from bomesh.db.models import (
    ExternalResource,
    IngestionSource,
    Item,
    ItemIndexState,
    ItemRevision,
    ItemTopic,
    SpaceMaterial,
    Topic,
)
from bomesh.iam.policy import PERSONAL_COLLECTION_TYPE
from bomesh.iam.visibility import below_document_reaching
from bomesh.services.knowledge_items.item_store import collections_below, in_subtree

#: ``document.contentState`` (derived: :attr:`Item.content_state`).
CONTENT_STATE: ColumnElement[Any] = func.upper(Item.content_state)
PUBLICATION_STATE: ColumnElement[Any] = case(
    (Item.is_published, "PUBLISHED"),
    (Item.is_published.is_(False), "UNPUBLISHED"),
)
ITEM_TYPE: ColumnElement[Any] = func.upper(Item.item_type)


def collection_kind(workspace_id: UUID) -> ColumnElement[Any]:
    """``document.collectionKind``: PERSONAL in a member's My files (their private scope),
    STANDARD in the workspace's shared collections; NULL for collections (a document field).

    The collections of the PERSONAL trees are few (the members' My files and their
    folders): a document is PERSONAL when its parent is one; only a document below
    another document climbs to its governing collection.
    """
    root = aliased(Item, name="personal_root")
    roots = select(root.id).where(
        root.tenant_id == workspace_id,
        root.item_kind == "collection",
        root.item_type == PERSONAL_COLLECTION_TYPE,
    )
    personal = select(collections_below(roots, live=False).c.id)
    return case(
        (Item.item_kind != "document", None),
        (Item.parent_item_id.in_(personal), "PERSONAL"),
        (
            below_document_reaching(
                Item, workspace_id, lambda node: node.c.id.in_(personal), live=False
            ),
            "PERSONAL",
        ),
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
#: ``document.summary``; a blank summary is unset (``NOT document.summary:*`` = without one).
SUMMARY: ColumnElement[Any] = func.nullif(func.btrim(Item.description), "")
VERIFICATION_STATE: ColumnElement[Any] = case(
    (Item.verified_at.is_(None), "UNVERIFIED"),
    (
        and_(Item.next_review_at.is_not(None), Item.next_review_at <= func.now()),
        "REVIEW_DUE",
    ),
    else_="VERIFIED",
)


_CURRENT_REVISION = aliased(ItemRevision)
#: When the current content was published: the current revision's time (always the
#: newest live one, a trigger keeps it so), else the item's (``recently published`` on Home).
PUBLISH_TIME: ColumnElement[Any] = func.coalesce(
    select(_CURRENT_REVISION.created_at)
    .where(_CURRENT_REVISION.id == Item.current_revision_id)
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


def indexing_state(
    processing_version: str,
    status: ColumnElement[Any] | None = None,
    version: ColumnElement[Any] | None = None,
) -> ColumnElement[Any]:
    """``document.indexingState``; SUCCEEDED with another configuration is OUTDATED.

    ``status``/``version`` default to the Item's views of its index state; a caller
    reading ``item_index_states`` directly passes its columns (one row read, not one
    correlated subquery per reference)."""
    status = Item.index_status if status is None else status
    version = Item.processed_version if version is None else version
    return case(
        (status == "processing", "RUNNING"),
        (and_(status == "ready", version.is_distinct_from(processing_version)), "OUTDATED"),
        (status == "ready", "SUCCEEDED"),
        (status == "failed", "FAILED"),
        (status == "unsupported", "UNSUPPORTED"),
        else_="PENDING",
    )


def indexing_state_conditions(
    processing_version: str, item_id: ColumnElement[Any] = Item.id
) -> dict[str, ColumnElement[bool]]:
    """``document.indexingState = X`` per value, for the item ``item_id`` names: a
    probe of the set of documents in that state (``item_index_states`` by status,
    hashed once per statement), never the :func:`indexing_state` CASE, which reads
    the row once per branch and per row. A document without the row is PENDING."""

    def in_state(*conditions: ColumnElement[bool]) -> ColumnElement[bool]:
        return item_id.in_(select(ItemIndexState.item_id).where(*conditions))

    status = ItemIndexState.index_status
    version = ItemIndexState.processed_version
    return {
        "RUNNING": in_state(status == "processing"),
        "OUTDATED": in_state(status == "ready", version.is_distinct_from(processing_version)),
        "SUCCEEDED": in_state(status == "ready", version == processing_version),
        "FAILED": in_state(status == "failed"),
        "UNSUPPORTED": in_state(status == "unsupported"),
        "PENDING": ~in_state(status.in_(("processing", "ready", "failed", "unsupported"))),
    }


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
    return in_subtree(Item, item_id)


def in_space(space_id: Any) -> ColumnElement[bool]:
    """``spaces:"workspaces/w/spaces/{space}"``: a live item the space pins as a material,
    or under a collection it pins (the space's collections, whole subtree).

    ``space_id`` is the space's ID or a scalar subquery resolving it. One recursive CTE
    seeded from ``space_materials (space_id, …)``, stepping by ``items.parent_item_id``.
    """
    material = aliased(Item, name="space_material")
    seed = select(material.id).where(
        material.id.in_(select(SpaceMaterial.item_id).where(SpaceMaterial.space_id == space_id)),
        material.deleted_at.is_(None),
    )
    tree = seed.cte(f"space_tree_{uuid4().hex[:8]}", recursive=True)
    child = aliased(Item, name="space_child")
    tree = tree.union_all(
        select(child.id).where(child.parent_item_id == tree.c.id, child.deleted_at.is_(None))
    )
    return Item.id.in_(select(tree.c.id))


__all__ = [
    "CONTENT_STATE",
    "HAS_ASSISTANT_TOPICS",
    "HAS_TOPICS",
    "ITEM_TYPE",
    "LANGUAGE",
    "OWNER_ID",
    "PUBLICATION_STATE",
    "PUBLISH_TIME",
    "SOURCE_CODE",
    "SUMMARY",
    "VERIFICATION_STATE",
    "collection_kind",
    "has_ancestor",
    "has_assistant_topic",
    "has_topic",
    "in_space",
    "indexing_state",
    "indexing_state_conditions",
]
