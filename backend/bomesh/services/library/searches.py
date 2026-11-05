"""Saved searches (``…/members/{member}/savedSearches/{savedSearch}``): stored SearchItems requests.

The API validates ``filter``/``orderBy`` against SearchItems' schemas and
passes the items the filter names; each must be readable (PERMISSION_DENIED
otherwise, as SearchItems answers).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import SavedSearch
from bomesh.db.models.workspaces import SAVED_SEARCH_LAYOUTS
from bomesh.errors import InvalidArgument, NotFound
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.library.access import LibraryGate, Owner, readable_item, unreadable
from bomesh.services.library.records import SavedSearchRecord

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

DISPLAY_NAME_MAX = 200
DEFAULT_LAYOUT = "LIST"
LAYOUTS = tuple(layout.upper() for layout in SAVED_SEARCH_LAYOUTS)


class SavedSearchService:
    def __init__(self, sessions: SessionFactory, request_hash_secret: bytes) -> None:
        self._sessions = sessions
        self._secret = request_hash_secret
        self._gate = LibraryGate(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> SavedSearchService:
        return cls(runtime.sessions(), runtime.request_hash_secret())

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        member: str,
        fields: Mapping[str, Any],
        *,
        referenced: Iterable[UUID],
        request_id: UUID | None,
    ) -> SavedSearchRecord:
        """``fields`` keyed by JSON name: displayName, query, filter, orderBy, layout."""
        owner = await self._gate.open(
            ctx, workspace_id, member, "savedSearches.create", write=True
        )
        row = SavedSearch(tenant_id=workspace_id, user_id=owner.user_id, layout=DEFAULT_LAYOUT.lower())
        _apply(row, {"displayName": None, **fields})
        async with transaction_scope(self._sessions) as session:
            idempotency = Idempotency(session, self._secret)
            key = None
            if request_id is not None:
                key = idempotency.key(
                    ctx.principal,
                    request_id,
                    method="CreateSavedSearch",
                    parent=owner.name,
                    request=dict(fields),
                )
                if (replayed := await idempotency.replay(key)) is not None:
                    return await _load(session, owner, replayed.rsplit("/", 1)[-1])
            await _require_readable(session, ctx, workspace_id, referenced)
            session.add(row)
            await session.flush()
            await session.refresh(row)
            record = SavedSearchRecord(row)
            if key is not None:
                await idempotency.remember(key, record.name)
            return record

    async def get(
        self, ctx: RequestContext, workspace_id: UUID, member: str, saved_search: str
    ) -> SavedSearchRecord:
        owner = await self._gate.open(ctx, workspace_id, member, "savedSearches.get", write=False)
        async with transaction_scope(self._sessions) as session:
            return await _load(session, owner, saved_search)

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, member: str, query: ListQuery
    ) -> list[SavedSearchRecord]:
        owner = await self._gate.open(ctx, workspace_id, member, "savedSearches.list", write=False)
        async with transaction_scope(self._sessions) as session:
            rows = await session.scalars(query.apply(_owned(owner)))
            return [SavedSearchRecord(row) for row in rows]

    async def update(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        member: str,
        saved_search: str,
        changes: Mapping[str, Any],
        *,
        referenced: Iterable[UUID],
    ) -> SavedSearchRecord:
        owner = await self._gate.open(
            ctx, workspace_id, member, "savedSearches.update", write=True
        )
        async with transaction_scope(self._sessions) as session:
            row = (await _load(session, owner, saved_search, for_update=True)).search
            await _require_readable(session, ctx, workspace_id, referenced)
            _apply(row, changes)
            row.updated_at = func.now()
            await session.flush()
            await session.refresh(row)
            return SavedSearchRecord(row)

    async def delete(
        self, ctx: RequestContext, workspace_id: UUID, member: str, saved_search: str
    ) -> None:
        owner = await self._gate.open(
            ctx, workspace_id, member, "savedSearches.delete", write=True
        )
        async with transaction_scope(self._sessions) as session:
            row = (await _load(session, owner, saved_search, for_update=True)).search
            await session.delete(row)


def _apply(row: SavedSearch, changes: Mapping[str, Any]) -> None:
    for path, value in changes.items():
        match path:
            case "displayName":
                row.display_name = _display_name(value)
            case "query":
                row.query = value or None
            case "filter":
                row.filter = value or None
            case "orderBy":
                row.order_by = value or None
            case "layout":
                row.layout = _layout(value)


def _display_name(value: object) -> str:
    text = value.strip() if isinstance(value, str) else ""
    if not text or len(text) > DISPLAY_NAME_MAX:
        raise InvalidArgument.for_field(
            "displayName", f"displayName must be 1-{DISPLAY_NAME_MAX} characters."
        )
    return text


def _layout(value: object) -> str:
    layout = value or DEFAULT_LAYOUT
    if layout not in LAYOUTS:
        raise InvalidArgument.for_field("layout", f"layout must be one of {', '.join(LAYOUTS)}.")
    return str(layout).lower()


async def _require_readable(
    session: AsyncSession, ctx: RequestContext, workspace_id: UUID, items: Iterable[UUID]
) -> None:
    for item_id in items:
        if await readable_item(session, ctx, workspace_id, item_id) is None:
            raise unreadable(workspace_id, item_id)


def _owned(owner: Owner) -> Select[tuple[SavedSearch]]:
    return select(SavedSearch).where(
        SavedSearch.tenant_id == owner.workspace_id,
        SavedSearch.user_id == owner.user_id,
    )


async def _load(
    session: AsyncSession, owner: Owner, saved_search: str, *, for_update: bool = False
) -> SavedSearchRecord:
    try:
        identifier = UUID(saved_search)
    except ValueError:
        identifier = None
    row = None
    if identifier is not None:
        statement = _owned(owner).where(SavedSearch.id == identifier)
        row = await session.scalar(statement.with_for_update() if for_update else statement)
    if row is None:
        raise NotFound(f"Resource '{owner.name}/savedSearches/{saved_search}' was not found.")
    return SavedSearchRecord(row)


__all__ = ["DEFAULT_LAYOUT", "LAYOUTS", "SavedSearchService"]
