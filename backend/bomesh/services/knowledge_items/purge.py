"""Purge: DELETED items past ``purgeTime`` lose their index points and unreferenced objects.

The row stays as lineage (``item_model.md`` §7). A content's object and its
derived products are deleted only when no live revision of a non-purged item
still shows that content (rollbacks and approved revisions share it). Objects
go first and the revisions are tombstoned last, so a failed delete is retried
on the next run.
"""

from __future__ import annotations

import logging
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, ItemRevision
from bomesh.document_index import ItemIndex
from bomesh.services.kernel.retention import RETENTION
from bomesh.services.knowledge_items.item_store import ItemService
from bomesh.storage import DocumentStorage
from bomesh.storage.keys import content_key, derived_prefix

log = logging.getLogger(__name__)


async def purge_deleted_items(
    sessions: async_sessionmaker[AsyncSession],
    index: ItemIndex,
    storage: DocumentStorage,
    *,
    limit: int = 100,
) -> int:
    """Purge up to ``limit`` items past their purge time; returns how many were purged."""
    async with transaction_scope(sessions) as session:
        now = await session.scalar(select(func.now()))
        assert now is not None
        due = list(
            await session.execute(
                select(Item.id, Item.tenant_id)
                .join(ItemRevision, ItemRevision.item_id == Item.id)
                .where(
                    Item.deleted_at.is_not(None),
                    Item.deleted_at <= now - RETENTION,
                    ItemRevision.deleted_at.is_(None),
                )
                .distinct()
                .limit(limit)
            )
        )
    for item_id, tenant_id in due:
        await index.purge_item_content(str(item_id), tenant_id=str(tenant_id))
        for content_id in await _unreferenced_contents(sessions, item_id):
            await storage.delete(content_key(tenant_id, content_id))
            await storage.delete_prefix(derived_prefix(tenant_id, content_id))
        await _tombstone_revisions(sessions, item_id)
    if due:
        log.info("purged deleted items count=%d", len(due))
    return len(due)


async def _unreferenced_contents(
    sessions: async_sessionmaker[AsyncSession], item_id: UUID
) -> list[UUID]:
    """Contents of the item's live revisions that no live revision of a non-purged item shows."""
    async with transaction_scope(sessions) as session:
        now = await session.scalar(select(func.now()))
        assert now is not None
        contents = set(
            await session.scalars(
                select(ItemRevision.content_id).where(
                    ItemRevision.item_id == item_id, ItemRevision.deleted_at.is_(None)
                )
            )
        )
        still_used = await ItemService(session).referenced_content_ids(
            contents, purged_before=now - RETENTION
        )
    return sorted(contents - still_used, key=str)


async def _tombstone_revisions(sessions: async_sessionmaker[AsyncSession], item_id: UUID) -> None:
    """Tombstone the item's live revisions; with none left it shows none (the etag stays)."""
    async with transaction_scope(sessions) as session:
        await session.execute(
            update(ItemRevision)
            .where(ItemRevision.item_id == item_id, ItemRevision.deleted_at.is_(None))
            .values(deleted_at=func.now())
        )
        await session.execute(
            update(Item)
            .where(Item.id == item_id)
            .values(current_revision_id=None, updated_at=Item.updated_at)
        )


__all__ = ["purge_deleted_items"]
