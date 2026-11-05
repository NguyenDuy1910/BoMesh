"""Saved items (``…/savedItems/{item}``) and recent items (``…/recentItems/{item}``).

Both are references keyed by the item ID. Every read goes through
``get_item_summary``: an entry whose item the member can no longer read
answers exactly like an absent one, and a merged document resolves to its
merge target (``mergedFrom`` keeps the original).
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import ColumnElement, delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import RecentItem, SavedItem
from bomesh.errors import AlreadyExists, InvalidArgument, NotFound
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.knowledge_items.names import parse_item
from bomesh.services.knowledge_items.summary import ItemSummary
from bomesh.services.library.access import LibraryGate, Owner, readable_item, unreadable
from bomesh.services.library.records import ItemReference

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

SAVED = "savedItems"
RECENT = "recentItems"


class SavedItemService:
    def __init__(self, sessions: SessionFactory, request_hash_secret: bytes) -> None:
        self._sessions = sessions
        self._secret = request_hash_secret
        self._gate = LibraryGate(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> SavedItemService:
        return cls(runtime.sessions(), runtime.request_hash_secret())

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        member: str,
        *,
        saved_item_id: str,
        item: str,
        request_id: UUID | None,
    ) -> ItemReference:
        owner = await self._gate.open(ctx, workspace_id, member, "savedItems.create", write=True)
        item_id = parse_item(item, workspace_id, field="item")
        if saved_item_id != str(item_id):
            raise InvalidArgument.for_field(
                "savedItemId", "savedItemId must be the item ID of item."
            )
        async with transaction_scope(self._sessions) as session:
            idempotency = Idempotency(session, self._secret)
            key = None
            if request_id is not None:
                key = idempotency.key(
                    ctx.principal,
                    request_id,
                    method="CreateSavedItem",
                    parent=owner.name,
                    request={"savedItemId": saved_item_id, "item": item},
                )
                if await idempotency.replay(key) is not None:
                    return await _saved(session, ctx, owner, item_id)
            summary = await readable_item(session, ctx, workspace_id, item_id)
            if summary is None:
                raise unreadable(workspace_id, item_id)
            existing = await session.get(
                SavedItem,
                {"tenant_id": workspace_id, "user_id": owner.user_id, "item_id": item_id},
            )
            if existing is not None:
                raise AlreadyExists(f"{_entry_name(owner, SAVED, item_id)} already exists.")
            row = SavedItem(tenant_id=workspace_id, user_id=owner.user_id, item_id=item_id)
            session.add(row)
            await session.flush()
            await session.refresh(row)
            if key is not None:
                await idempotency.remember(key, _entry_name(owner, SAVED, item_id))
            return _reference(owner, item_id, summary, row.created_at)

    async def get(
        self, ctx: RequestContext, workspace_id: UUID, member: str, saved_item: str
    ) -> ItemReference:
        owner = await self._gate.open(ctx, workspace_id, member, "savedItems.get", write=False)
        async with transaction_scope(self._sessions) as session:
            return await _saved(session, ctx, owner, _entry_id(owner, SAVED, saved_item))

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, member: str, query: ListQuery
    ) -> list[ItemReference]:
        owner = await self._gate.open(ctx, workspace_id, member, "savedItems.list", write=False)
        async with transaction_scope(self._sessions) as session:
            rows = await session.execute(
                select(SavedItem.item_id, SavedItem.created_at)
                .where(_owned(SavedItem, owner), query.where)
                .order_by(*query.order_by)
            )
            return await _window(session, ctx, owner, rows.tuples().all(), query)

    async def delete(
        self, ctx: RequestContext, workspace_id: UUID, member: str, saved_item: str
    ) -> None:
        owner = await self._gate.open(ctx, workspace_id, member, "savedItems.delete", write=True)
        item_id = _entry_id(owner, SAVED, saved_item)
        async with transaction_scope(self._sessions) as session:
            await _remove(session, SavedItem, owner, item_id, _entry_name(owner, SAVED, item_id))


class RecentItemService:
    def __init__(self, sessions: SessionFactory) -> None:
        self._sessions = sessions
        self._gate = LibraryGate(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> RecentItemService:
        return cls(runtime.sessions())

    async def get(
        self, ctx: RequestContext, workspace_id: UUID, member: str, recent_item: str
    ) -> ItemReference:
        owner = await self._gate.open(ctx, workspace_id, member, "recentItems.get", write=False)
        async with transaction_scope(self._sessions) as session:
            return await _recent(session, ctx, owner, _entry_id(owner, RECENT, recent_item))

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, member: str, query: ListQuery
    ) -> list[ItemReference]:
        owner = await self._gate.open(ctx, workspace_id, member, "recentItems.list", write=False)
        async with transaction_scope(self._sessions) as session:
            rows = await session.execute(
                select(RecentItem.item_id, RecentItem.viewed_at)
                .where(_owned(RecentItem, owner), query.where)
                .order_by(*query.order_by)
            )
            return await _window(session, ctx, owner, rows.tuples().all(), query)

    async def record_view(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        member: str,
        recent_item: str,
        *,
        item: str | None,
        view_time: datetime | None,
        allow_missing: bool,
    ) -> ItemReference:
        """Set ``viewTime`` (default: now); ``allow_missing`` creates the entry."""
        owner = await self._gate.open(
            ctx, workspace_id, member, "recentItems.update", write=True
        )
        item_id = _entry_id(owner, RECENT, recent_item)
        if item is not None and parse_item(item, workspace_id, field="item") != item_id:
            raise InvalidArgument.for_field("item", "item must match the recentItem ID.")
        moment = view_time or datetime.now(UTC)
        async with transaction_scope(self._sessions) as session:
            summary = await readable_item(session, ctx, workspace_id, item_id)
            if summary is None:
                raise unreadable(workspace_id, item_id)
            key = {"tenant_id": workspace_id, "user_id": owner.user_id, "item_id": item_id}
            row = await session.get(RecentItem, key, with_for_update=True)
            if row is None:
                if not allow_missing:
                    raise NotFound(
                        f"Resource '{_entry_name(owner, RECENT, item_id)}' was not found."
                    )
                row = RecentItem(**key, viewed_at=moment)
                session.add(row)
            else:
                row.viewed_at = moment
            await session.flush()
            return _reference(owner, item_id, summary, row.viewed_at)

    async def delete(
        self, ctx: RequestContext, workspace_id: UUID, member: str, recent_item: str
    ) -> None:
        owner = await self._gate.open(ctx, workspace_id, member, "recentItems.delete", write=True)
        item_id = _entry_id(owner, RECENT, recent_item)
        async with transaction_scope(self._sessions) as session:
            await _remove(session, RecentItem, owner, item_id, _entry_name(owner, RECENT, item_id))

    async def clear(self, ctx: RequestContext, workspace_id: UUID, member: str) -> None:
        owner = await self._gate.open(ctx, workspace_id, member, "recentItems.clear", write=True)
        async with transaction_scope(self._sessions) as session:
            await session.execute(delete(RecentItem).where(_owned(RecentItem, owner)))


# -- Shared ---------------------------------------------------------------------


async def readable_references(
    session: AsyncSession,
    ctx: RequestContext,
    owner: Owner,
    rows: Sequence[tuple[UUID, datetime]],
    *,
    skip: int = 0,
    take: int | None = None,
) -> list[ItemReference]:
    """``rows`` (entry ID, time) in order, keeping readable ones: ``take`` after ``skip``."""
    kept: list[ItemReference] = []
    seen = 0
    for entry_id, moment in rows:
        if take is not None and len(kept) >= take:
            break
        summary = await readable_item(session, ctx, owner.workspace_id, entry_id)
        if summary is None:
            continue
        seen += 1
        if seen > skip:
            kept.append(_reference(owner, entry_id, summary, moment))
    return kept


async def _window(
    session: AsyncSession,
    ctx: RequestContext,
    owner: Owner,
    rows: Sequence[tuple[UUID, datetime]],
    query: ListQuery,
) -> list[ItemReference]:
    """The page window counted over readable entries only, so pages never come back short."""
    return await readable_references(
        session, ctx, owner, rows, skip=query.offset, take=query.limit
    )


async def _saved(
    session: AsyncSession, ctx: RequestContext, owner: Owner, item_id: UUID
) -> ItemReference:
    row = await session.get(
        SavedItem, {"tenant_id": owner.workspace_id, "user_id": owner.user_id, "item_id": item_id}
    )
    return await _readable_entry(session, ctx, owner, SAVED, item_id, row.created_at if row else None)


async def _recent(
    session: AsyncSession, ctx: RequestContext, owner: Owner, item_id: UUID
) -> ItemReference:
    row = await session.get(
        RecentItem,
        {"tenant_id": owner.workspace_id, "user_id": owner.user_id, "item_id": item_id},
    )
    return await _readable_entry(session, ctx, owner, RECENT, item_id, row.viewed_at if row else None)


async def _readable_entry(
    session: AsyncSession,
    ctx: RequestContext,
    owner: Owner,
    collection: str,
    item_id: UUID,
    moment: datetime | None,
) -> ItemReference:
    summary = (
        await readable_item(session, ctx, owner.workspace_id, item_id) if moment else None
    )
    if summary is None or moment is None:
        raise NotFound(f"Resource '{_entry_name(owner, collection, item_id)}' was not found.")
    return _reference(owner, item_id, summary, moment)


async def _remove(
    session: AsyncSession,
    model: type[SavedItem] | type[RecentItem],
    owner: Owner,
    item_id: UUID,
    name: str,
) -> None:
    result = await session.execute(
        delete(model).where(_owned(model, owner), model.item_id == item_id)
    )
    if not getattr(result, "rowcount", 0):
        raise NotFound(f"Resource '{name}' was not found.")


def _owned(model: Any, owner: Owner) -> ColumnElement[bool]:
    return (model.tenant_id == owner.workspace_id) & (model.user_id == owner.user_id)


def _reference(
    owner: Owner, entry_id: UUID, summary: ItemSummary, moment: datetime
) -> ItemReference:
    return ItemReference(
        workspace_id=owner.workspace_id,
        user_id=owner.user_id,
        entry_id=entry_id,
        item_id=summary.item_id,
        merged_from=summary.merged_from,
        time=moment,
    )


def _entry_name(owner: Owner, collection: str, entry_id: UUID | str) -> str:
    return f"{owner.name}/{collection}/{entry_id}"


def _entry_id(owner: Owner, collection: str, entry: str) -> UUID:
    try:
        return UUID(entry)
    except ValueError:
        raise NotFound(
            f"Resource '{_entry_name(owner, collection, entry)}' was not found."
        ) from None


__all__ = ["RecentItemService", "SavedItemService", "readable_references"]
