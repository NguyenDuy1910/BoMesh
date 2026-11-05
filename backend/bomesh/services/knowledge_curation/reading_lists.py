"""Reading lists: curated, ordered references that never grant access.

Visibility: PRIVATE → the owner; SPACE → members of the space; WORKSPACE (and
the FEATURED ``readingLists/featured``) → every member; a deleted list → its
owner. Writes: the owner; WORKSPACE and FEATURED lists also holders of
``readingLists.publish``; SPACE lists also the space's leads and staff.
Entries resolve merged items and re-check the visibility rule on every read:
an unreadable entry looks absent and is counted in ``hiddenItemCount``.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh import etag as etags
from bomesh.db.engine import transaction_scope
from bomesh.db.models import ReadingList, ReadingListEntry
from bomesh.errors import AlreadyExists, FailedPrecondition, InvalidArgument, NotFound
from bomesh.iam.authorizer import (
    Authorizer,
    ItemRef,
    Principal,
    SpaceRef,
    WorkspaceRef,
    permission_denied,
)
from bomesh.services.collaboration.membership import space_codes, space_id_for_code
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.retention import RETENTION, is_purged, purge_time
from bomesh.services.knowledge_curation.records import (
    EntryPage,
    EntryRecord,
    ReadingListDraft,
    ReadingListRecord,
    ReadingListSummary,
    entry_name,
    reading_list_name,
)
from bomesh.services.knowledge_curation.support import CurationDeps, now
from bomesh.services.knowledge_items.summary import ItemSummary, get_item_summary

FEATURED = "featured"
PUBLISH = "readingLists.publish"
#: Held by space members (not by plain workspace members): who sees a SPACE list.
SPACE_READ = "spaceMembers.list"
#: Held by space leads and staff: who may curate a SPACE list.
SPACE_CURATE = "materials.create"


class ReadingListService:
    def __init__(self, deps: CurationDeps) -> None:
        self._deps = deps

    @classmethod
    def from_runtime(cls, runtime: Any) -> ReadingListService:
        return cls(CurationDeps.from_runtime(runtime))

    # -- Lists ---------------------------------------------------------------------

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        draft: ReadingListDraft,
        *,
        reading_list_id: str | None,
        request_id: UUID | None,
    ) -> ReadingListRecord:
        """CreateReadingList; ``readingListId`` ``featured`` creates the FEATURED list."""
        await self._open(ctx, workspace_id, "readingLists.create", write=True)
        featured = reading_list_id == FEATURED
        audience = "workspace" if featured else draft.audience
        async with transaction_scope(self._deps.sessions) as session:
            space_id = await _space_id(session, workspace_id, draft.space_code)
        await _require_audience(ctx, workspace_id, audience, space_id, featured=featured)
        async with transaction_scope(self._deps.sessions) as session:
            idempotency = Idempotency(session, self._deps.request_hash_secret)
            key = None
            if request_id is not None:
                key = idempotency.key(
                    ctx.principal,
                    request_id,
                    method="CreateReadingList",
                    parent=f"workspaces/{workspace_id}",
                    request={
                        "readingListId": reading_list_id,
                        "displayName": draft.display_name,
                        "description": draft.description,
                        "audience": audience,
                        "space": draft.space_code,
                    },
                )
                replayed = await idempotency.replay(key)
                if replayed is not None:
                    row = await _load(session, workspace_id, replayed.rsplit("/", 1)[1])
                    return await reading_list_record(session, ctx.authorizer, ctx.principal, row)
            row = await _insert(
                session,
                ctx,
                workspace_id,
                code=reading_list_id or _new_code(),
                kind=FEATURED if featured else "standard",
                title=draft.display_name,
                description=draft.description,
                audience=audience,
                space_id=space_id,
            )
            await _audit(session, ctx, row, "CreateReadingList")
            if key is not None:
                await idempotency.remember(key, reading_list_name(workspace_id, row.code))
            return await reading_list_record(session, ctx.authorizer, ctx.principal, row)

    async def get(self, ctx: RequestContext, workspace_id: UUID, code: str) -> ReadingListRecord:
        await self._open(ctx, workspace_id, "readingLists.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            row = await self._readable(session, ctx, workspace_id, code, "readingLists.get")
            return await reading_list_record(session, ctx.authorizer, ctx.principal, row)

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, query: ListQuery
    ) -> tuple[list[ReadingListRecord], int]:
        await self._open(ctx, workspace_id, "readingLists.list", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            visible = await _visible_clause(session, ctx.authorizer, ctx.principal, workspace_id)
            statement = select(ReadingList).where(ReadingList.tenant_id == workspace_id, visible)
            if query.show_deleted:
                statement = statement.where(
                    ReadingList.deleted_at.is_(None)
                    | (ReadingList.deleted_at > func.now() - RETENTION)
                )
            else:
                statement = statement.where(ReadingList.deleted_at.is_(None))
            total = int(await session.scalar(query.count(statement)) or 0)
            rows = list(await session.scalars(query.apply(statement)))
            return [
                await reading_list_record(session, ctx.authorizer, ctx.principal, row)
                for row in rows
            ], total

    async def update(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        changes: Mapping[str, Any],
        *,
        etag: str | None,
    ) -> ReadingListRecord:
        """UpdateReadingList: ``displayName``, ``description``, ``audience``, ``space``."""
        await self._open(ctx, workspace_id, "readingLists.update", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            row = await self._writable(session, ctx, workspace_id, code, "readingLists.update")
            etags.check(etag, reading_list_etag(row))
            if row.deleted_at is not None:
                raise FailedPrecondition("The reading list is deleted.")
            for path, value in changes.items():
                match path:
                    case "displayName":
                        if not value:
                            raise InvalidArgument.for_field("displayName", "displayName is required.")
                        row.title = value
                    case "description":
                        row.description = value
                    case "audience":
                        if row.kind == FEATURED and value != "workspace":
                            raise InvalidArgument.for_field(
                                "audience", "The FEATURED list is always WORKSPACE."
                            )
                        row.audience = value or "private"
                    case "space":
                        row.space_id = await _space_id(session, workspace_id, value)
            if "audience" in changes and row.audience != "space" and "space" not in changes:
                row.space_id = None
            await _require_audience(
                ctx, workspace_id, row.audience, row.space_id, featured=row.kind == FEATURED
            )
            await session.flush()
            await _audit(session, ctx, row, "UpdateReadingList")
            return await self._record(session, ctx, row)

    async def delete(
        self, ctx: RequestContext, workspace_id: UUID, code: str, *, etag: str | None
    ) -> ReadingListRecord:
        await self._open(ctx, workspace_id, "readingLists.delete", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            row = await self._writable(session, ctx, workspace_id, code, "readingLists.delete")
            etags.check(etag, reading_list_etag(row))
            if row.kind == FEATURED:
                raise FailedPrecondition("The FEATURED reading list cannot be deleted.")
            if row.deleted_at is not None:
                raise FailedPrecondition("The reading list is already deleted.")
            row.deleted_at = await now(session)
            await session.flush()
            await _audit(session, ctx, row, "DeleteReadingList")
            return await self._record(session, ctx, row)

    async def undelete(
        self, ctx: RequestContext, workspace_id: UUID, code: str, *, etag: str | None
    ) -> ReadingListRecord:
        await self._open(ctx, workspace_id, "readingLists.undelete", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            row = await self._writable(session, ctx, workspace_id, code, "readingLists.undelete")
            etags.check(etag, reading_list_etag(row))
            if row.deleted_at is None:
                raise AlreadyExists("The reading list is not deleted.")
            row.deleted_at = None
            await session.flush()
            await _audit(session, ctx, row, "UndeleteReadingList")
            return await self._record(session, ctx, row)

    async def copy(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        *,
        display_name: str | None,
        reading_list_id: str | None,
    ) -> ReadingListRecord:
        """CopyReadingList: a PRIVATE STANDARD list of the caller with the readable entries."""
        await self._open(ctx, workspace_id, "readingLists.create", write=True)
        await ctx.authorizer.require(ctx.principal, "readingLists.get", WorkspaceRef(workspace_id))
        if reading_list_id == FEATURED:
            raise InvalidArgument.for_field("readingListId", "'featured' is reserved.")
        async with transaction_scope(self._deps.sessions) as session:
            source = await self._readable(session, ctx, workspace_id, code, "readingLists.get")
            readable = await _readable_entries(session, ctx.authorizer, ctx.principal, source)
            row = await _insert(
                session,
                ctx,
                workspace_id,
                code=reading_list_id or _new_code(),
                kind="standard",
                title=display_name or source.title,
                description=source.description,
                audience="private",
                space_id=None,
            )
            seen: set[UUID] = set()
            for _, summary in readable:
                if summary.item_id in seen:
                    continue
                seen.add(summary.item_id)
                session.add(
                    ReadingListEntry(
                        reading_list_id=row.id,
                        item_id=summary.item_id,
                        position=len(seen) - 1,
                        added_by_user_id=ctx.user_id,
                    )
                )
            await session.flush()
            await _audit(session, ctx, row, "CopyReadingList")
            return await reading_list_record(session, ctx.authorizer, ctx.principal, row)

    # -- Entries -------------------------------------------------------------------

    async def create_entry(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        item_id: UUID,
        *,
        note: str | None,
        position: int | None,
    ) -> EntryRecord:
        await self._open(ctx, workspace_id, "readingLists.update", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            row = await self._writable(session, ctx, workspace_id, code, "readingLists.update")
            if row.deleted_at is not None:
                raise FailedPrecondition("The reading list is deleted.")
            summary = await get_item_summary(
                session, ctx.authorizer, ctx.principal, workspace_id, item_id
            )
            if summary is None:
                raise permission_denied("items.get", ItemRef(workspace_id, item_id))
            if await session.get(ReadingListEntry, (row.id, item_id)) is not None:
                raise AlreadyExists("The item is already in this reading list.")
            size = await _size(session, row.id)
            at = size if position is None else min(max(position, 0), size)
            await _shift(session, row.id, at, None, +1)
            entry = ReadingListEntry(
                reading_list_id=row.id,
                item_id=item_id,
                note=note,
                position=at,
                added_by_user_id=ctx.user_id,
            )
            session.add(entry)
            row.updated_at = await now(session)
            await session.flush()
            await _audit_entry(session, ctx, row, item_id, "CreateReadingListEntry")
            return _entry_record(row, entry, summary)

    async def get_entry(
        self, ctx: RequestContext, workspace_id: UUID, code: str, entry_id: UUID
    ) -> EntryRecord:
        await self._open(ctx, workspace_id, "readingLists.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            row = await self._readable(session, ctx, workspace_id, code, "readingLists.get")
            entry, summary = await _visible_entry(session, ctx, row, entry_id)
            return _entry_record(row, entry, summary)

    async def list_entries(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        *,
        offset: int,
        limit: int,
    ) -> EntryPage:
        """ListReadingListEntries: by ``position``; unreadable entries omitted and counted."""
        await self._open(ctx, workspace_id, "readingLists.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            row = await self._readable(session, ctx, workspace_id, code, "readingLists.get")
            readable = await _readable_entries(session, ctx.authorizer, ctx.principal, row)
            total = await _size(session, row.id)
            window = readable[offset : offset + limit]
            return EntryPage(
                entries=[_entry_record(row, entry, summary) for entry, summary in window],
                hidden_item_count=total - len(readable),
            )

    async def update_entry(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        entry_id: UUID,
        changes: Mapping[str, Any],
    ) -> EntryRecord:
        """UpdateReadingListEntry: ``note``, ``position`` (the others shift)."""
        await self._open(ctx, workspace_id, "readingLists.update", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            row = await self._writable(session, ctx, workspace_id, code, "readingLists.update")
            entry, summary = await _visible_entry(session, ctx, row, entry_id)
            if "note" in changes:
                entry.note = changes["note"]
            if changes.get("position") is not None:
                size = await _size(session, row.id)
                target = min(max(int(changes["position"]), 0), size - 1)
                if target != entry.position:
                    await _move(session, row.id, entry, target)
            row.updated_at = await now(session)
            await session.flush()
            await _audit_entry(session, ctx, row, entry_id, "UpdateReadingListEntry")
            return _entry_record(row, entry, summary)

    async def delete_entry(
        self, ctx: RequestContext, workspace_id: UUID, code: str, entry_id: UUID
    ) -> None:
        await self._open(ctx, workspace_id, "readingLists.update", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            row = await self._writable(session, ctx, workspace_id, code, "readingLists.update")
            entry, _ = await _visible_entry(session, ctx, row, entry_id)
            position = entry.position
            await session.delete(entry)
            await session.flush()
            await _shift(session, row.id, position + 1, None, -1)
            row.updated_at = await now(session)
            await _audit_entry(session, ctx, row, entry_id, "DeleteReadingListEntry")

    # -- Internals -----------------------------------------------------------------

    async def _open(self, ctx: RequestContext, workspace_id: UUID, permission: str, *, write: bool) -> None:
        await self._deps.workspaces.open(ctx, WorkspaceRef(workspace_id), permission, write=write)

    async def _readable(
        self, session: AsyncSession, ctx: RequestContext, workspace_id: UUID, code: str, permission: str
    ) -> ReadingList:
        row = await _load(session, workspace_id, code)
        if row.deleted_at is not None and row.owner_user_id != ctx.user_id:
            raise NotFound(f"Resource '{reading_list_name(workspace_id, code)}' was not found.")
        if not await may_read(ctx.authorizer, ctx.principal, row):
            raise permission_denied(permission, WorkspaceRef(workspace_id))
        return row

    async def _writable(
        self, session: AsyncSession, ctx: RequestContext, workspace_id: UUID, code: str, permission: str
    ) -> ReadingList:
        row = await _load(session, workspace_id, code, for_update=True)
        if row.deleted_at is not None and row.owner_user_id != ctx.user_id:
            raise NotFound(f"Resource '{reading_list_name(workspace_id, code)}' was not found.")
        if not await _may_write(ctx.authorizer, ctx.principal, row):
            raise permission_denied(permission, WorkspaceRef(workspace_id))
        return row

    async def _record(self, session: AsyncSession, ctx: RequestContext, row: ReadingList) -> ReadingListRecord:
        await session.refresh(row)
        return await reading_list_record(session, ctx.authorizer, ctx.principal, row)


# -- Access ----------------------------------------------------------------------------


async def may_read(authorizer: Authorizer, principal: Principal, row: ReadingList) -> bool:
    if row.owner_user_id == principal.user_id:
        return True
    match row.audience:
        case "workspace":
            return await authorizer.is_active_member(principal, row.tenant_id)
        case "space":
            assert row.space_id is not None
            return SPACE_READ in await authorizer.space_permissions(principal, row.space_id)
    return False


async def _may_write(authorizer: Authorizer, principal: Principal, row: ReadingList) -> bool:
    if row.owner_user_id == principal.user_id:
        return True
    match row.audience:
        case "workspace":
            return PUBLISH in await authorizer.workspace_permissions(principal, row.tenant_id)
        case "space":
            assert row.space_id is not None
            return SPACE_CURATE in await authorizer.space_permissions(principal, row.space_id)
    return False


async def _require_audience(
    ctx: RequestContext,
    workspace_id: UUID,
    audience: str,
    space_id: UUID | None,
    *,
    featured: bool,
) -> None:
    if (audience == "space") != (space_id is not None):
        raise InvalidArgument.for_field("space", "space is required exactly when audience is SPACE.")
    if featured or audience == "workspace":
        await ctx.authorizer.require(ctx.principal, PUBLISH, WorkspaceRef(workspace_id))
    elif audience == "space":
        assert space_id is not None
        if SPACE_CURATE not in await ctx.authorizer.space_permissions(ctx.principal, space_id):
            raise permission_denied(SPACE_CURATE, SpaceRef(workspace_id, space_id))


async def _visible_clause(
    session: AsyncSession, authorizer: Authorizer, principal: Principal, workspace_id: UUID
) -> Any:
    """SQL: lists the caller may read (space membership resolved per space)."""
    spaces = await session.scalars(
        select(ReadingList.space_id)
        .where(ReadingList.tenant_id == workspace_id, ReadingList.audience == "space")
        .distinct()
    )
    member_of = [
        space_id
        for space_id in spaces
        if space_id is not None and SPACE_READ in await authorizer.space_permissions(principal, space_id)
    ]
    return (ReadingList.owner_user_id == principal.user_id) | (
        ReadingList.deleted_at.is_(None)
        & (
            (ReadingList.audience == "workspace")
            | ((ReadingList.audience == "space") & ReadingList.space_id.in_(member_of))
        )
    )


# -- Records -------------------------------------------------------------------------


async def _space_id(session: AsyncSession, workspace_id: UUID, code: str | None) -> UUID | None:
    """The live space a ``space`` field names (by its code); INVALID_ARGUMENT otherwise."""
    if code is None:
        return None
    space_id = await space_id_for_code(session, workspace_id, code)
    if space_id is None:
        raise InvalidArgument.for_field("space", f"'{code}' is not a live space of this workspace.")
    return space_id


def reading_list_etag(row: ReadingList) -> str:
    return etags.compute(reading_list_name(row.tenant_id, row.code), row.updated_at)


async def reading_list_record(
    session: AsyncSession, authorizer: Authorizer, principal: Principal, row: ReadingList
) -> ReadingListRecord:
    readable = await _readable_entries(session, authorizer, principal, row)
    total = await _size(session, row.id)
    return ReadingListRecord(
        workspace_id=row.tenant_id,
        id=row.id,
        code=row.code,
        display_name=row.title,
        description=row.description,
        owner_id=row.owner_user_id,
        audience=row.audience,
        space_code=(await space_codes(session, [row.space_id]))[row.space_id]
        if row.space_id
        else None,
        kind=row.kind,
        item_count=len(readable),
        hidden_item_count=total - len(readable),
        create_time=row.created_at,
        update_time=row.updated_at,
        delete_time=row.deleted_at,
        purge_time=purge_time(row.deleted_at),
        etag=reading_list_etag(row),
    )


def _entry_record(row: ReadingList, entry: ReadingListEntry, summary: ItemSummary) -> EntryRecord:
    return EntryRecord(
        workspace_id=row.tenant_id,
        list_code=row.code,
        entry_id=entry.item_id,
        item_id=summary.item_id,
        note=entry.note,
        position=entry.position,
        added_by=entry.added_by_user_id,
        create_time=entry.created_at,
    )


async def _readable_entries(
    session: AsyncSession, authorizer: Authorizer, principal: Principal, row: ReadingList
) -> list[tuple[ReadingListEntry, ItemSummary]]:
    entries = await session.scalars(
        select(ReadingListEntry)
        .where(ReadingListEntry.reading_list_id == row.id)
        .order_by(ReadingListEntry.position, ReadingListEntry.created_at)
    )
    readable = []
    for entry in entries:
        summary = await get_item_summary(session, authorizer, principal, row.tenant_id, entry.item_id)
        if summary is not None:
            readable.append((entry, summary))
    return readable


async def _visible_entry(
    session: AsyncSession, ctx: RequestContext, row: ReadingList, entry_id: UUID
) -> tuple[ReadingListEntry, ItemSummary]:
    entry = await session.get(ReadingListEntry, (row.id, entry_id))
    summary = (
        await get_item_summary(session, ctx.authorizer, ctx.principal, row.tenant_id, entry_id)
        if entry is not None
        else None
    )
    if entry is None or summary is None:
        raise NotFound(
            f"Resource '{entry_name(row.tenant_id, row.code, entry_id)}' was not found."
        )
    return entry, summary


# -- Persistence ---------------------------------------------------------------------


async def _load(
    session: AsyncSession, workspace_id: UUID, code: str, *, for_update: bool = False
) -> ReadingList:
    statement = select(ReadingList).where(
        ReadingList.tenant_id == workspace_id, ReadingList.code == code
    )
    if for_update:
        statement = statement.with_for_update()
    row = await session.scalar(statement)
    if row is None or is_purged(row.deleted_at):
        raise NotFound(f"Resource '{reading_list_name(workspace_id, code)}' was not found.")
    return row


async def _insert(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    *,
    code: str,
    kind: str,
    title: str,
    description: str | None,
    audience: str,
    space_id: UUID | None,
) -> ReadingList:
    if not title:
        raise InvalidArgument.for_field("displayName", "displayName is required.")
    exists = await session.scalar(
        select(ReadingList.id).where(ReadingList.tenant_id == workspace_id, ReadingList.code == code)
    )
    if exists is not None:
        raise AlreadyExists(f"Reading list '{reading_list_name(workspace_id, code)}' already exists.")
    row = ReadingList(
        tenant_id=workspace_id,
        code=code,
        owner_user_id=ctx.user_id,
        kind=kind,
        title=title,
        description=description,
        audience=audience,
        space_id=space_id,
    )
    session.add(row)
    await session.flush()
    await session.refresh(row)
    return row


async def _size(session: AsyncSession, list_id: UUID) -> int:
    count = await session.scalar(
        select(func.count()).where(ReadingListEntry.reading_list_id == list_id)
    )
    return int(count or 0)


async def _shift(
    session: AsyncSession, list_id: UUID, start: int, stop: int | None, delta: int
) -> None:
    """Add ``delta`` to positions in ``[start, stop]`` (``stop`` None = to the end)."""
    condition = (ReadingListEntry.reading_list_id == list_id) & (ReadingListEntry.position >= start)
    if stop is not None:
        condition = condition & (ReadingListEntry.position <= stop)
    await session.execute(
        update(ReadingListEntry)
        .where(condition)
        .values(position=ReadingListEntry.position + delta)
        .execution_options(synchronize_session=False)
    )


async def _move(session: AsyncSession, list_id: UUID, entry: ReadingListEntry, target: int) -> None:
    current = entry.position
    item_id = entry.item_id
    if target < current:
        await _shift(session, list_id, target, current - 1, +1)
    else:
        await _shift(session, list_id, current + 1, target, -1)
    await session.execute(
        update(ReadingListEntry)
        .where(ReadingListEntry.reading_list_id == list_id, ReadingListEntry.item_id == item_id)
        .values(position=target)
        .execution_options(synchronize_session=False)
    )
    await session.refresh(entry)


def _new_code() -> str:
    return f"l{uuid4().hex[:12]}"


async def _audit(session: AsyncSession, ctx: RequestContext, row: ReadingList, action: str) -> None:
    await Audit(session).record(
        ctx,
        workspace_id=row.tenant_id,
        category="knowledge",
        action=action,
        target=reading_list_name(row.tenant_id, row.code),
    )


async def _audit_entry(
    session: AsyncSession, ctx: RequestContext, row: ReadingList, item_id: UUID, action: str
) -> None:
    await Audit(session).record(
        ctx,
        workspace_id=row.tenant_id,
        category="knowledge",
        action=action,
        target=entry_name(row.tenant_id, row.code, item_id),
        resource_type="reading_list_entry",
    )


# -- Cross-slice API -----------------------------------------------------------------


async def reading_list_summaries(
    session: AsyncSession,
    authorizer: Authorizer,
    principal: Principal,
    workspace_id: UUID,
    *,
    limit: int,
) -> list[ReadingListSummary]:
    """Live STANDARD lists shared with the member (WORKSPACE, or SPACE they belong to)."""
    visible = await _visible_clause(session, authorizer, principal, workspace_id)
    rows = await session.scalars(
        select(ReadingList)
        .where(
            ReadingList.tenant_id == workspace_id,
            ReadingList.kind == "standard",
            ReadingList.audience != "private",
            ReadingList.deleted_at.is_(None),
            visible,
        )
        .order_by(ReadingList.updated_at.desc(), ReadingList.id)
        .limit(limit)
    )
    return [
        ReadingListSummary(
            reading_list_id=row.id,
            code=row.code,
            display_name=row.title,
            item_count=len(await _readable_entries(session, authorizer, principal, row)),
        )
        for row in rows
    ]


async def featured_item_ids(
    session: AsyncSession,
    authorizer: Authorizer,
    principal: Principal,
    workspace_id: UUID,
    *,
    limit: int,
) -> list[UUID]:
    """Readable (merge-resolved) items of ``readingLists/featured``, in position order."""
    row = await session.scalar(
        select(ReadingList).where(
            ReadingList.tenant_id == workspace_id,
            ReadingList.kind == FEATURED,
            ReadingList.deleted_at.is_(None),
        )
    )
    if row is None:
        return []
    readable = await _readable_entries(session, authorizer, principal, row)
    return list(dict.fromkeys(summary.item_id for _, summary in readable))[:limit]


__all__ = [
    "ReadingListService",
    "featured_item_ids",
    "reading_list_etag",
    "reading_list_summaries",
]
