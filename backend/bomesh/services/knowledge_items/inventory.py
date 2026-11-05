"""Inventory queries other slices count with (workspace overview, gaps, IAM analysis).

Pure SQL builders: no session, no permission check. Each returns a ``Select``
of one column labelled ``id``; ``workspace_id`` may be a UUID or a SQL
expression (a bind parameter inside a CTE).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, Select, and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from bomesh.db.models import Item
from bomesh.services.knowledge_items.item_store import HIDDEN_KINDS

type WorkspaceId = UUID | ColumnElement[Any]

_NEXT_REVIEW = Item.metadata_["verification"]["next_review_at"].astext
_SYSTEM_KIND = Item.metadata_["system_kind"].astext


def _documents(workspace_id: WorkspaceId, *conditions: ColumnElement[bool]) -> Select[Any]:
    return select(Item.id.label("id")).where(
        Item.tenant_id == workspace_id,
        Item.item_type == "document",
        Item.deleted_at.is_(None),
        *conditions,
    )


def failed_document_ids(workspace_id: WorkspaceId) -> Select[Any]:
    """Live documents whose last processing failed."""
    return _documents(workspace_id, Item.index_status == "failed")


def published_document_ids(workspace_id: WorkspaceId) -> Select[Any]:
    return _documents(workspace_id, Item.publication_state == "published")


def reverification_due_ids(
    workspace_id: WorkspaceId, now: datetime | ColumnElement[Any]
) -> Select[Any]:
    """Live published documents past ``verification.nextReviewTime``."""
    return _documents(
        workspace_id,
        Item.publication_state == "published",
        _NEXT_REVIEW.is_not(None),
        _NEXT_REVIEW.cast(Item.updated_at.type) < now,
    )


def unpublished_document_ids(workspace_id: WorkspaceId) -> Select[Any]:
    """Live unpublished documents outside system collections (waiting to be published)."""
    parent = aliased(Item)
    return (
        _documents(workspace_id, Item.publication_state == "unpublished")
        .join(parent, parent.id == Item.parent_item_id)
        .where(parent.metadata_["system_kind"].astext.is_(None))
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
        Item.item_type == "collection",
        Item.parent_item_id.is_(None),
        _SYSTEM_KIND.is_(None),
        alive,
    )


def access_boundary_ids(workspace_id: WorkspaceId) -> Select[Any]:
    """Live collections that end inheritance (personal ones included), oldest first."""
    return (
        select(Item.id.label("id"))
        .where(
            Item.tenant_id == workspace_id,
            Item.item_type == "collection",
            Item.deleted_at.is_(None),
            Item.inherit_access.is_(False),
            or_(_SYSTEM_KIND.is_(None), _SYSTEM_KIND.not_in(HIDDEN_KINDS)),
        )
        .order_by(Item.created_at, Item.id)
    )


async def is_live_item(session: AsyncSession, item_id: UUID) -> bool:
    """Whether the item exists and is not deleted."""
    return (
        await session.scalar(
            select(Item.id).where(Item.id == item_id, Item.deleted_at.is_(None))
        )
        is not None
    )


__all__ = [
    "access_boundary_ids",
    "failed_document_ids",
    "is_live_item",
    "published_document_ids",
    "reverification_due_ids",
    "root_collection_ids",
    "unpublished_document_ids",
]
