"""Inventory queries other slices count with (workspace overview, gaps, IAM analysis, shares).

Pure SQL builders: no session, no permission check. Each returns a ``Select``
of one column labelled ``id`` (``item_rows`` returns the few columns a share
names its target with); ``workspace_id`` may be a UUID or a SQL expression (a
bind parameter inside a CTE).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, Select, and_, exists, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from bomesh.db.models import Item, ItemIndexState
from bomesh.iam.visibility import ItemVisibility
from bomesh.services.knowledge_items.item_store import HIDDEN_TYPES, STANDARD_COLLECTION_TYPE

type WorkspaceId = UUID | ColumnElement[Any]


def _documents(workspace_id: WorkspaceId, *conditions: ColumnElement[bool]) -> Select[Any]:
    return select(Item.id.label("id")).where(
        Item.tenant_id == workspace_id,
        Item.item_kind == "document",
        Item.deleted_at.is_(None),
        *conditions,
    )


def failed_document_ids(workspace_id: WorkspaceId) -> Select[Any]:
    """Live documents whose last processing failed."""
    return _documents(
        workspace_id,
        Item.id.in_(
            select(ItemIndexState.item_id).where(ItemIndexState.index_status == "failed")
        ),
    )


def published_document_ids(workspace_id: WorkspaceId) -> Select[Any]:
    return _documents(workspace_id, Item.is_published)


def reverification_due_ids(
    workspace_id: WorkspaceId, now: datetime | ColumnElement[Any]
) -> Select[Any]:
    """Live published documents past ``verification.nextReviewTime``."""
    return _documents(
        workspace_id,
        Item.is_published,
        Item.next_review_at.is_not(None),
        Item.next_review_at < now,
    )


def unpublished_document_ids(workspace_id: WorkspaceId) -> Select[Any]:
    """Live unpublished documents outside system collections (waiting to be published)."""
    parent = aliased(Item)
    return (
        _documents(workspace_id, Item.is_published.is_(False))
        .join(parent, parent.id == Item.parent_item_id)
        .where(parent.item_type == STANDARD_COLLECTION_TYPE)
    )


def root_collection_ids(workspace_id: WorkspaceId, *, at: datetime | None = None) -> Select[Any]:
    """Root collections that are not system collections; live now, or at ``at``."""
    alive = (
        Item.deleted_at.is_(None)
        if at is None
        else and_(Item.created_at < at, or_(Item.deleted_at.is_(None), Item.deleted_at >= at))
    )
    return select(Item.id.label("id")).where(
        Item.tenant_id == workspace_id,
        Item.item_kind == "collection",
        Item.parent_item_id.is_(None),
        Item.item_type == STANDARD_COLLECTION_TYPE,
        alive,
    )


def access_boundary_rows(workspace_id: WorkspaceId) -> Select[Any]:
    """Columns ``id``, ``code`` (empty), ``created_at``: live collections that end
    inheritance (personal ones included); callers order by ``created_at, id``."""
    return select(
        Item.id.label("id"), literal("").label("code"), Item.created_at.label("created_at")
    ).where(
        Item.tenant_id == workspace_id,
        Item.item_kind == "collection",
        Item.deleted_at.is_(None),
        Item.inherit_access.is_(False),
        Item.item_type.not_in(HIDDEN_TYPES),
    )


async def is_live_item(session: AsyncSession, item_id: UUID) -> bool:
    """Whether the item exists and is not deleted."""
    return (
        await session.scalar(
            select(Item.id).where(Item.id == item_id, Item.deleted_at.is_(None))
        )
        is not None
    )


def is_visible_item(item_id: ColumnElement[UUID], visibility: ItemVisibility) -> ColumnElement[bool]:
    """``item_id`` names an item ``visibility`` admits: a probe of that one row."""
    return exists().where(Item.id == item_id, visibility.clause())


def item_rows() -> Select[Any]:
    """Columns ``id``, ``tenant_id``, ``item_name``, ``item_kind``, ``item_type``,
    ``deleted_at`` of every item; callers filter on ``selected_columns``."""
    return select(
        Item.id, Item.tenant_id, Item.item_name, Item.item_kind, Item.item_type, Item.deleted_at
    )


__all__ = [
    "access_boundary_rows",
    "failed_document_ids",
    "is_live_item",
    "is_visible_item",
    "item_rows",
    "published_document_ids",
    "reverification_due_ids",
    "root_collection_ids",
    "unpublished_document_ids",
]
