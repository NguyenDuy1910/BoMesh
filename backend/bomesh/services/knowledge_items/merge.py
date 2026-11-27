"""MergeItem's reference move: every live reference to a duplicate now names the kept Document.

Each table moves set-based. A row that would collide with a row already naming the
target on the table's unique key is removed — deleted, or tombstoned where the
table keeps tombstones (``message_items``, ``item_shortcuts``) — and the rest are
re-pointed. The duplicate's concept labels move through
:func:`~bomesh.services.taxonomy.assignments.merge_assignments` and its profile,
applicability and supersessions through
:func:`~bomesh.services.taxonomy.profiles.merge_profiles`. Historical rows (audit,
notifications) keep the duplicate.
"""

from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import ColumnElement, Table, delete, exists, func, not_, or_, true, update
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import Item, ItemShortcut, MessageItem, RecentItem, SavedItem, SpaceMaterial
from bomesh.services.knowledge_items.item_store import PURPOSE_ATTACHMENT
from bomesh.services.taxonomy.assignments import merge_assignments
from bomesh.services.taxonomy.profiles import merge_profiles


async def repoint_references(session: AsyncSession, duplicate_id: UUID, target: Item) -> None:
    """Move saved, recent, space material, message and shortcut references, concept
    labels and the document profile to ``target``."""
    for model, key in (
        (SavedItem, ("tenant_id", "user_id")),
        (RecentItem, ("tenant_id", "user_id")),
        (SpaceMaterial, ("space_id",)),
    ):
        await _repoint(session, model.__table__, duplicate_id, target.id, key)
    await _repoint_message_items(session, duplicate_id, target.id)
    await _repoint_shortcuts(session, duplicate_id, target)
    await merge_assignments(session, duplicate_id, target.id)
    await merge_profiles(session, duplicate_id, target.id)


async def _repoint(
    session: AsyncSession, table: Table, duplicate_id: UUID, target_id: UUID, key: Sequence[str]
) -> None:
    """Delete the duplicate's rows the target already has on ``key``; re-point the rest."""
    await session.execute(
        delete(table).where(
            table.c.item_id == duplicate_id, _held_by_target(table, target_id, key)
        )
    )
    await session.execute(
        update(table).where(table.c.item_id == duplicate_id).values(item_id=target_id)
    )


async def _repoint_message_items(session: AsyncSession, duplicate_id: UUID, target_id: UUID) -> None:
    """The primary key covers tombstoned rows too: a row whose key the target already
    holds stays on the duplicate, tombstoned; every other row is re-pointed."""
    table: Table = MessageItem.__table__
    held = _held_by_target(table, target_id, ("message_id", "relation_type"))
    await session.execute(
        update(table)
        .where(table.c.item_id == duplicate_id, table.c.deleted_at.is_(None), held)
        .values(deleted_at=func.now())
    )
    await session.execute(
        update(table)
        .where(table.c.item_id == duplicate_id, not_(held))
        .values(item_id=target_id)
    )


async def _repoint_shortcuts(session: AsyncSession, duplicate_id: UUID, target: Item) -> None:
    """Live shortcuts are unique per container and target, never point into their own
    container and never at a conversation attachment: a live shortcut that cannot move
    is tombstoned. Shortcuts that may name the target are re-pointed; the others keep
    the duplicate (restoring their container never revives an invalid one)."""
    shortcuts: Table = ItemShortcut.__table__
    attachment = target.purpose == PURPOSE_ATTACHMENT
    in_target_parent = shortcuts.c.collection_item_id == target.parent_item_id
    colliding = _held_by_target(shortcuts, target.id, ("collection_item_id",), live_only=True)
    await session.execute(
        update(shortcuts)
        .where(
            shortcuts.c.target_item_id == duplicate_id,
            shortcuts.c.deleted_at.is_(None),
            true() if attachment else or_(in_target_parent, colliding),
        )
        .values(deleted_at=func.now(), updated_at=func.now())
    )
    if attachment:
        return
    await session.execute(
        update(shortcuts)
        .where(shortcuts.c.target_item_id == duplicate_id, not_(in_target_parent))
        .values(target_item_id=target.id, updated_at=func.now())
    )


def _held_by_target(
    table: Table, target_id: UUID, key: Sequence[str], *, live_only: bool = False
) -> ColumnElement[bool]:
    """Whether a row naming ``target_id`` with the same ``key`` exists in ``table``."""
    kept = table.alias("kept")
    item = kept.c.target_item_id if "target_item_id" in kept.c else kept.c.item_id
    conditions = [item == target_id, *(kept.c[name] == table.c[name] for name in key)]
    if live_only:
        conditions.append(kept.c.deleted_at.is_(None))
    return exists().where(*conditions)


__all__ = ["repoint_references"]
