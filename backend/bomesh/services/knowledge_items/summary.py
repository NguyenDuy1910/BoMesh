"""References: what a reference (reading list, saved, recent, share, material, citation)
may show of an item, after re-checking the visibility rule (invariant 5).

A DELETED duplicate merged into another document (``metadata.merged_into``)
resolves to the end of its merge chain at read time. The duplicate's own
content is never served: a summary that resolved through a merge has
``merged_from`` set and ``serves_content`` false.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import Item
from bomesh.iam.authorizer import Authorizer, ItemRef, Principal, item_ancestry
from bomesh.iam.visibility import is_visible
from bomesh.services.knowledge_items.item_store import (
    HIDDEN_KINDS,
    catalog_visibility,
    is_hidden,
    visible_item_ids,
)

#: Merge chains longer than this are treated as broken (unreadable).
MAX_MERGE_DEPTH = 16


@dataclass(frozen=True, slots=True)
class ItemSummary:
    """A readable item as a reference shows it.

    ``merged_from`` is the referenced duplicate when the reference resolved
    through a merge; ``locked`` marks a discoverable root the caller cannot
    read (only ``display_name`` may be shown).
    """

    item_id: UUID
    merged_from: UUID | None
    item_type: str
    display_name: str
    parent_id: UUID | None
    mime_type: str | None
    publication_state: str | None
    locked: bool = False

    @property
    def serves_content(self) -> bool:
        """Whether the referenced item's own text (excerpts, passages) may be shown."""
        return self.merged_from is None and not self.locked


async def get_item_summary(
    session: AsyncSession,
    authorizer: Authorizer,
    principal: Principal,
    workspace_id: UUID,
    item_id: UUID,
) -> ItemSummary | None:
    """The summary of ``item_id`` for ``principal``, or ``None`` when it must look absent."""
    referenced = await session.get(Item, item_id)
    if referenced is None or referenced.tenant_id != workspace_id:
        return None
    item = await _merge_target(session, referenced)
    if item is None:
        return None
    if not await is_visible(authorizer, principal, ItemRef(workspace_id, item.id)):
        return None
    if any(node.system_kind in HIDDEN_KINDS for node in await authorizer.ancestry(item.id)):
        return None
    return _summary(item, merged_from=referenced.id if item.id != referenced.id else None)


async def visible_or_discoverable_summary(
    session: AsyncSession,
    authorizer: Authorizer,
    principal: Principal,
    workspace_id: UUID,
    item_id: UUID,
) -> ItemSummary | None:
    """:func:`get_item_summary`, or a LOCKED summary of a discoverable root the caller
    cannot read (members may request access to it); ``None`` otherwise."""
    summary = await get_item_summary(session, authorizer, principal, workspace_id, item_id)
    if summary is not None:
        return summary
    if not await authorizer.is_active_member(principal, workspace_id):
        return None
    item = await session.get(Item, item_id)
    if item is None or not _discoverable_root(item, workspace_id):
        return None
    return ItemSummary(
        item_id=item.id,
        merged_from=None,
        item_type="COLLECTION",
        display_name=item.title,
        parent_id=None,
        mime_type=None,
        publication_state=None,
        locked=True,
    )


async def is_visible_or_discoverable_root(
    session: AsyncSession,
    authorizer: Authorizer,
    principal: Principal,
    workspace_id: UUID,
    item_id: UUID,
) -> bool:
    return (
        await visible_or_discoverable_summary(
            session, authorizer, principal, workspace_id, item_id
        )
        is not None
    )


async def readable_item_ids(
    session: AsyncSession,
    authorizer: Authorizer,
    principal: Principal,
    workspace_id: UUID,
    item_ids: Iterable[UUID],
    *,
    follow_merges: bool = True,
) -> frozenset[UUID]:
    """The given ids the caller can read (one visibility computation for all).

    With ``follow_merges`` a merged duplicate counts when the end of its
    merge chain is readable; without it, only ids readable themselves count.
    """
    ids = list(dict.fromkeys(item_ids))
    if not ids:
        return frozenset()
    visibility = await catalog_visibility(session, authorizer, principal, workspace_id)
    rows = {
        row.id: row
        for row in await session.scalars(
            select(Item).where(Item.id.in_(ids), Item.tenant_id == workspace_id)
        )
    }
    resolved: dict[UUID, UUID] = {}
    for item_id, row in rows.items():
        target = await _merge_target(session, row) if follow_merges else row
        if target is not None:
            resolved[item_id] = target.id
    visible = await visible_item_ids(session, visibility, resolved.values())
    return frozenset(item_id for item_id, target in resolved.items() if target in visible)


async def collection_ids_for_spaces(
    session: AsyncSession,
    workspace_id: UUID,
    space_ids: Sequence[UUID],
    *,
    principal: Principal | None = None,
    authorizer: Authorizer | None = None,
) -> dict[UUID, tuple[UUID, ...]]:
    """Live, non-hidden COLLECTIONs linked to each space (``collection.space``).

    Ordered by creation; filtered to readable collections when ``principal``
    and ``authorizer`` are given. Every requested space has an entry.
    """
    result: dict[UUID, list[UUID]] = {space_id: [] for space_id in dict.fromkeys(space_ids)}
    if not result:
        return {}
    rows = list(
        await session.execute(
            select(Item.space_id, Item.id)
            .where(
                Item.tenant_id == workspace_id,
                Item.item_type == "collection",
                Item.deleted_at.is_(None),
                Item.space_id.in_(list(result)),
            )
            .order_by(Item.created_at, Item.id)
        )
    )
    readable: frozenset[UUID] | None = None
    if principal is not None:
        if authorizer is None:
            raise ValueError("a principal needs an authorizer")
        visibility = await catalog_visibility(session, authorizer, principal, workspace_id)
        readable = visibility.readable
    for space_id, collection_id in rows:
        if readable is None or collection_id in readable:
            result[space_id].append(collection_id)
    if readable is None:
        hidden = await _hidden_or_dead(session, [collection_id for _, collection_id in rows])
        return {
            space_id: tuple(value for value in values if value not in hidden)
            for space_id, values in result.items()
        }
    return {space_id: tuple(values) for space_id, values in result.items()}


async def _hidden_or_dead(session: AsyncSession, collection_ids: list[UUID]) -> frozenset[UUID]:
    """Collections under a hidden system collection or a deleted ancestor."""
    excluded: set[UUID] = set()
    for collection_id in collection_ids:
        path = await item_ancestry(session, collection_id)
        if any(
            node.deleted_at is not None or node.system_kind in HIDDEN_KINDS for node in path
        ):
            excluded.add(collection_id)
    return frozenset(excluded)


async def _merge_target(session: AsyncSession, item: Item) -> Item | None:
    """The end of ``item``'s merge chain (``item`` itself when not merged); None if broken."""
    seen = {item.id}
    current = item
    for _ in range(MAX_MERGE_DEPTH):
        merged_into = current.metadata_.get("merged_into")
        if current.deleted_at is None or not merged_into:
            return current
        try:
            target_id = UUID(str(merged_into))
        except ValueError:
            return None
        if target_id in seen:
            return None
        seen.add(target_id)
        target = await session.get(Item, target_id)
        if target is None or target.tenant_id != item.tenant_id:
            return None
        current = target
    return None


def _discoverable_root(item: Item, workspace_id: UUID) -> bool:
    return (
        item.tenant_id == workspace_id
        and item.item_type == "collection"
        and item.parent_item_id is None
        and item.deleted_at is None
        and item.metadata_.get("discoverable") is True
        and not is_hidden(item)
    )


def _summary(item: Item, *, merged_from: UUID | None) -> ItemSummary:
    return ItemSummary(
        item_id=item.id,
        merged_from=merged_from,
        item_type=item.item_type.upper(),
        display_name=item.title,
        parent_id=item.parent_item_id,
        mime_type=item.mime_type,
        publication_state=item.publication_state.upper() if item.publication_state else None,
    )


__all__ = [
    "MAX_MERGE_DEPTH",
    "ItemSummary",
    "collection_ids_for_spaces",
    "get_item_summary",
    "is_visible_or_discoverable_root",
    "readable_item_ids",
    "visible_or_discoverable_summary",
]
