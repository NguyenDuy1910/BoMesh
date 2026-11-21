"""References: what a reference (saved, recent, share, material, citation) may show of
an item, after re-checking the visibility rule (invariant 5).

MergeItem re-points references to the kept Document, so a reference always names
the item it shows. A space shows Items only through its ``space_materials``.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import Item, SpaceMaterial
from bomesh.iam.authorizer import Authorizer, ItemRef, Principal
from bomesh.iam.visibility import is_visible
from bomesh.services.knowledge_items.item_store import (
    HIDDEN_TYPES,
    catalog_visibility,
    is_hidden,
    visible_item_ids,
)


@dataclass(frozen=True, slots=True)
class ItemSummary:
    """A readable item as a reference shows it.

    ``locked`` marks a discoverable root the caller cannot read (only
    ``display_name`` may be shown).
    """

    item_id: UUID
    #: ``COLLECTION`` or ``DOCUMENT``.
    item_kind: str
    display_name: str
    parent_id: UUID | None
    mime_type: str | None
    publication_state: str | None
    locked: bool = False


async def get_item_summary(
    session: AsyncSession,
    authorizer: Authorizer,
    principal: Principal,
    workspace_id: UUID,
    item_id: UUID,
) -> ItemSummary | None:
    """The summary of ``item_id`` for ``principal``, or ``None`` when it must look absent."""
    summaries = await get_item_summaries(session, authorizer, principal, workspace_id, (item_id,))
    return summaries.get(item_id)


async def get_item_summaries(
    session: AsyncSession,
    authorizer: Authorizer,
    principal: Principal,
    workspace_id: UUID,
    item_ids: Iterable[UUID],
) -> dict[UUID, ItemSummary]:
    """:func:`get_item_summary` of each readable item, keyed by its ID.

    Rows, ancestries and grants load once for all ids; unreadable ids are absent.
    """
    ids = list(dict.fromkeys(item_ids))
    if not ids:
        return {}
    items = list(
        await session.scalars(select(Item).where(Item.id.in_(ids), Item.tenant_id == workspace_id))
    )
    found = [item.id for item in items]
    paths = await authorizer.ancestries(found)
    await authorizer.collection_permissions_many(principal, [(item_id, False) for item_id in found])
    summaries: dict[UUID, ItemSummary] = {}
    for item in items:
        if not await is_visible(authorizer, principal, ItemRef(workspace_id, item.id)):
            continue
        if any(node.item_type in HIDDEN_TYPES for node in paths[item.id]):
            continue
        summaries[item.id] = _summary(item)
    return summaries


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
        item_kind="COLLECTION",
        display_name=item.item_name,
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
) -> frozenset[UUID]:
    """The given ids the caller can read (one visibility computation for all)."""
    ids = list(dict.fromkeys(item_ids))
    if not ids:
        return frozenset()
    visibility = await catalog_visibility(session, authorizer, principal, workspace_id)
    return await visible_item_ids(session, visibility, ids)


async def collection_ids_for_spaces(
    session: AsyncSession,
    authorizer: Authorizer,
    principal: Principal,
    workspace_id: UUID,
    space_ids: Sequence[UUID],
) -> dict[UUID, tuple[UUID, ...]]:
    """The live Collection materials of each space the caller can read, in the order added.

    Every requested space has an entry.
    """
    result: dict[UUID, list[UUID]] = {space_id: [] for space_id in dict.fromkeys(space_ids)}
    if not result:
        return {}
    rows = list(
        await session.execute(
            _materials(workspace_id, list(result), SpaceMaterial.space_id, Item.id).where(
                Item.item_kind == "collection"
            )
        )
    )
    readable = (await catalog_visibility(session, authorizer, principal, workspace_id)).readable
    for space_id, collection_id in rows:
        if collection_id in readable:
            result[space_id].append(collection_id)
    return {space_id: tuple(values) for space_id, values in result.items()}


async def space_material_items(
    session: AsyncSession, workspace_id: UUID, space_ids: Sequence[UUID]
) -> tuple[tuple[UUID, ...], tuple[UUID, ...]]:
    """The live Collection and Document materials of ``space_ids``, each once in the order
    added. Not narrowed to the caller: readers re-check every Item they show."""
    if not space_ids:
        return (), ()
    collections: dict[UUID, None] = {}
    documents: dict[UUID, None] = {}
    for item_id, kind in await session.execute(
        _materials(workspace_id, space_ids, Item.id, Item.item_kind)
    ):
        (collections if kind == "collection" else documents)[item_id] = None
    return tuple(collections), tuple(documents)


def _materials(workspace_id: UUID, space_ids: Sequence[UUID], *columns: Any) -> Any:
    """``SELECT columns`` of the live Items the materials of ``space_ids`` name, in the order added."""
    return (
        select(*columns)
        .select_from(SpaceMaterial)
        .join(Item, Item.id == SpaceMaterial.item_id)
        .where(
            SpaceMaterial.space_id.in_(list(space_ids)),
            Item.tenant_id == workspace_id,
            Item.deleted_at.is_(None),
        )
        .order_by(SpaceMaterial.created_at, SpaceMaterial.id)
    )


def _discoverable_root(item: Item, workspace_id: UUID) -> bool:
    return (
        item.tenant_id == workspace_id
        and item.item_kind == "collection"
        and item.parent_item_id is None
        and item.deleted_at is None
        and item.discoverable
        and not is_hidden(item)
    )


def _summary(item: Item) -> ItemSummary:
    return ItemSummary(
        item_id=item.id,
        item_kind=item.item_kind.upper(),
        display_name=item.item_name,
        parent_id=item.parent_item_id,
        mime_type=item.mime_type,
        publication_state=None
        if item.is_published is None
        else ("PUBLISHED" if item.is_published else "UNPUBLISHED"),
    )


__all__ = [
    "ItemSummary",
    "collection_ids_for_spaces",
    "get_item_summary",
    "is_visible_or_discoverable_root",
    "readable_item_ids",
    "space_material_items",
    "visible_or_discoverable_summary",
]
