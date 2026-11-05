"""Purge: DELETED items past ``purgeTime`` lose their index points and unreferenced objects.

The row stays as lineage (``item_model.md`` §7). An object is deleted only
when no live revision of a non-purged item still references its key
(rollbacks and approved revisions share keys). Objects go first and the
revisions are tombstoned last, so a failed delete is retried on the next run.
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
        for key in await _unreferenced_objects(sessions, item_id):
            await storage.delete(key)
        await _tombstone_revisions(sessions, item_id)
    if due:
        log.info("purged deleted items count=%d", len(due))
    return len(due)


async def _unreferenced_objects(
    sessions: async_sessionmaker[AsyncSession], item_id: UUID
) -> list[str]:
    """Keys of the item's live revisions that no live revision of a non-purged item uses."""
    async with transaction_scope(sessions) as session:
        now = await session.scalar(select(func.now()))
        assert now is not None
        keys = set(
            await session.scalars(
                select(ItemRevision.storage_key).where(
                    ItemRevision.item_id == item_id, ItemRevision.deleted_at.is_(None)
                )
            )
        )
        still_used = await ItemService(session).referenced_object_keys(
            keys, purged_before=now - RETENTION
        )
    return sorted(keys - still_used)


async def _tombstone_revisions(sessions: async_sessionmaker[AsyncSession], item_id: UUID) -> None:
    async with transaction_scope(sessions) as session:
        await session.execute(
            update(ItemRevision)
            .where(ItemRevision.item_id == item_id, ItemRevision.deleted_at.is_(None))
            .values(deleted_at=func.now())
        )


__all__ = ["purge_deleted_items"]
