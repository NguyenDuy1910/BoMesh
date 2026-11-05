"""What a space shows: materials, announcements and events (all hard-deleted).

A material references an Item and never changes its access: pinning needs the
item to be visible to the caller, and reads omit materials whose item the
reader cannot see (it reads as absent).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh import etag
from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Space, SpaceAnnouncement, SpaceEvent, SpaceMaterial
from bomesh.errors import AlreadyExists, InvalidArgument, PermissionDenied
from bomesh.services.collaboration.records import SpaceChild, space_name
from bomesh.services.collaboration.support import (
    Gate,
    missing,
    now,
    replay,
)
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.knowledge_items.names import parse_item
from bomesh.services.knowledge_items.summary import get_item_summary, readable_item_ids

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

MAX_TITLE = 300

type Child = SpaceMaterial | SpaceAnnouncement | SpaceEvent


class _SpaceContent:
    """Shared plumbing: gate the space, load one child, audit."""

    model: type[Child]
    collection: str
    resource: str
    #: Ordering applied before the caller's ``orderBy``.
    leading_order: tuple[Any, ...] = ()

    def __init__(self, sessions: SessionFactory, request_hash_secret: bytes) -> None:
        self._sessions = sessions
        self._secret = request_hash_secret
        self._gate = Gate(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> Any:
        return cls(runtime.sessions(), runtime.request_hash_secret())

    async def _space(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        method: str,
        *,
        write: bool,
    ) -> Space:
        return await self._gate.space(
            ctx, workspace_id, code, f"{self.resource}.{method}", write=write
        )

    def _record(self, workspace_id: UUID, space: Space, row: Child) -> SpaceChild:
        return SpaceChild(workspace_id, space.code, self.collection, row)

    def _name(self, workspace_id: UUID, space: Space, child_id: UUID | str) -> str:
        return f"{space_name(workspace_id, space.code)}/{self.collection}/{child_id}"

    async def _row(
        self,
        session: AsyncSession,
        workspace_id: UUID,
        space: Space,
        child_id: UUID,
        *,
        for_update: bool = False,
    ) -> Any:
        statement = select(self.model).where(
            self.model.id == child_id, self.model.space_id == space.id
        )
        row = await session.scalar(
            statement.with_for_update() if for_update else statement
        )
        if row is None:
            raise missing(self._name(workspace_id, space, child_id))
        return row

    async def _create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        space: Space,
        row: Child,
        *,
        method: str,
        request: Mapping[str, Any],
        request_id: UUID | None,
        session: AsyncSession,
        check: Callable[[], Awaitable[None]] | None = None,
    ) -> SpaceChild:
        """Insert ``row`` unless ``request_id`` replays; ``check`` runs only for a new write."""
        idempotency = Idempotency(session, self._secret)
        key, replayed = await replay(
            idempotency,
            ctx,
            request_id,
            method=method,
            parent=space_name(workspace_id, space.code),
            request=request,
        )
        if replayed is not None:
            existing = await self._row(
                session, workspace_id, space, UUID(replayed.rsplit("/", 1)[-1])
            )
            return self._record(workspace_id, space, existing)
        if check is not None:
            await check()
        session.add(row)
        await session.flush()
        record = self._record(workspace_id, space, row)
        await _audit(session, ctx, workspace_id, method, record.name)
        if key is not None:
            await idempotency.remember(key, record.name)
        return record

    async def _list(
        self, ctx: RequestContext, workspace_id: UUID, code: str, query: ListQuery
    ) -> list[SpaceChild]:
        space = await self._space(ctx, workspace_id, code, "list", write=False)
        statement = (
            select(self.model)
            .where(self.model.space_id == space.id)
            .order_by(*self.leading_order)
        )
        async with transaction_scope(self._sessions) as session:
            rows = await session.scalars(query.apply(statement))
            return [self._record(workspace_id, space, row) for row in rows]

    async def _get(
        self, ctx: RequestContext, workspace_id: UUID, code: str, child_id: UUID
    ) -> SpaceChild:
        space = await self._space(ctx, workspace_id, code, "get", write=False)
        async with transaction_scope(self._sessions) as session:
            return self._record(
                workspace_id,
                space,
                await self._row(session, workspace_id, space, child_id),
            )

    async def _update(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        child_id: UUID,
        changes: Mapping[str, Any],
        *,
        expected_etag: str | None,
        method: str,
    ) -> SpaceChild:
        space = await self._space(ctx, workspace_id, code, "update", write=True)
        async with transaction_scope(self._sessions) as session:
            row = await self._row(
                session, workspace_id, space, child_id, for_update=True
            )
            record = self._record(workspace_id, space, row)
            etag.check(expected_etag, record.etag)
            self._apply(row, changes)
            row.updated_at = now()
            await session.flush()
            await _audit(session, ctx, workspace_id, method, record.name)
            return record

    def _apply(self, row: Any, changes: Mapping[str, Any]) -> None:
        raise NotImplementedError

    async def _delete(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        child_id: UUID,
        *,
        expected_etag: str | None,
        method: str,
    ) -> None:
        space = await self._space(ctx, workspace_id, code, "delete", write=True)
        async with transaction_scope(self._sessions) as session:
            row = await self._row(
                session, workspace_id, space, child_id, for_update=True
            )
            record = self._record(workspace_id, space, row)
            etag.check(expected_etag, record.etag)
            await session.execute(delete(self.model).where(self.model.id == row.id))
            await _audit(session, ctx, workspace_id, method, record.name)


# -- Announcements --------------------------------------------------------------


class AnnouncementService(_SpaceContent):
    model = SpaceAnnouncement
    collection = "announcements"
    resource = "announcements"
    leading_order = (SpaceAnnouncement.pinned.desc(),)

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        *,
        title: str,
        body: str | None,
        pinned: bool,
        request_id: UUID | None,
    ) -> SpaceChild:
        space = await self._space(ctx, workspace_id, code, "create", write=True)
        row = SpaceAnnouncement(
            space_id=space.id,
            title=_title(title),
            body=body or None,
            pinned=pinned,
            author_user_id=ctx.user_id,
        )
        async with transaction_scope(self._sessions) as session:
            return await self._create(
                ctx,
                workspace_id,
                space,
                row,
                method="CreateAnnouncement",
                request={"title": title, "body": body, "pinned": pinned},
                request_id=request_id,
                session=session,
            )

    async def get(
        self, ctx: RequestContext, workspace_id: UUID, code: str, announcement_id: UUID
    ) -> SpaceChild:
        return await self._get(ctx, workspace_id, code, announcement_id)

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, code: str, query: ListQuery
    ) -> list[SpaceChild]:
        return await self._list(ctx, workspace_id, code, query)

    async def update(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        announcement_id: UUID,
        changes: Mapping[str, Any],
        *,
        expected_etag: str | None,
    ) -> SpaceChild:
        """``changes`` keyed by mask path: title, body, pinned."""
        return await self._update(
            ctx,
            workspace_id,
            code,
            announcement_id,
            changes,
            expected_etag=expected_etag,
            method="UpdateAnnouncement",
        )

    def _apply(self, row: SpaceAnnouncement, changes: Mapping[str, Any]) -> None:
        if "title" in changes:
            row.title = _title(changes["title"])
        if "body" in changes:
            row.body = changes["body"] or None
        if "pinned" in changes:
            row.pinned = bool(changes["pinned"])

    async def delete(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        announcement_id: UUID,
        *,
        expected_etag: str | None,
    ) -> None:
        await self._delete(
            ctx,
            workspace_id,
            code,
            announcement_id,
            expected_etag=expected_etag,
            method="DeleteAnnouncement",
        )


# -- Events ---------------------------------------------------------------------


class SpaceEventService(_SpaceContent):
    model = SpaceEvent
    collection = "events"
    resource = "events"

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        *,
        title: str,
        start_time: datetime | None,
        end_time: datetime | None,
        location: str | None,
        description: str | None,
        request_id: UUID | None,
    ) -> SpaceChild:
        space = await self._space(ctx, workspace_id, code, "create", write=True)
        if start_time is None:
            raise InvalidArgument.for_field("startTime", "startTime is required.")
        _check_window(start_time, end_time)
        row = SpaceEvent(
            space_id=space.id,
            title=_title(title),
            start_at=start_time,
            end_at=end_time,
            location=location or None,
            description=description or None,
            created_by_user_id=ctx.user_id,
        )
        async with transaction_scope(self._sessions) as session:
            return await self._create(
                ctx,
                workspace_id,
                space,
                row,
                method="CreateSpaceEvent",
                request={
                    "title": title,
                    "startTime": start_time,
                    "endTime": end_time,
                    "location": location,
                    "description": description,
                },
                request_id=request_id,
                session=session,
            )

    async def get(
        self, ctx: RequestContext, workspace_id: UUID, code: str, event_id: UUID
    ) -> SpaceChild:
        return await self._get(ctx, workspace_id, code, event_id)

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, code: str, query: ListQuery
    ) -> list[SpaceChild]:
        return await self._list(ctx, workspace_id, code, query)

    async def update(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        event_id: UUID,
        changes: Mapping[str, Any],
        *,
        expected_etag: str | None,
    ) -> SpaceChild:
        """``changes`` keyed by mask path: title, startTime, endTime, location, description."""
        return await self._update(
            ctx,
            workspace_id,
            code,
            event_id,
            changes,
            expected_etag=expected_etag,
            method="UpdateSpaceEvent",
        )

    def _apply(self, row: SpaceEvent, changes: Mapping[str, Any]) -> None:
        if "title" in changes:
            row.title = _title(changes["title"])
        if "startTime" in changes:
            if changes["startTime"] is None:
                raise InvalidArgument.for_field("startTime", "startTime is required.")
            row.start_at = changes["startTime"]
        if "endTime" in changes:
            row.end_at = changes["endTime"]
        if "location" in changes:
            row.location = changes["location"] or None
        if "description" in changes:
            row.description = changes["description"] or None
        _check_window(row.start_at, row.end_at)

    async def delete(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        event_id: UUID,
        *,
        expected_etag: str | None,
    ) -> None:
        await self._delete(
            ctx,
            workspace_id,
            code,
            event_id,
            expected_etag=expected_etag,
            method="DeleteSpaceEvent",
        )


# -- Materials ------------------------------------------------------------------


class MaterialService(_SpaceContent):
    model = SpaceMaterial
    collection = "materials"
    resource = "materials"

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        *,
        item: str,
        note: str | None,
        request_id: UUID | None,
    ) -> SpaceChild:
        """Pin a DOCUMENT or COLLECTION the caller can see (403 otherwise); access is unchanged."""
        space = await self._space(ctx, workspace_id, code, "create", write=True)
        item_id = parse_item(item, workspace_id, field="item")
        row = SpaceMaterial(
            space_id=space.id,
            item_id=item_id,
            note=note or None,
            added_by_user_id=ctx.user_id,
        )
        async with transaction_scope(self._sessions) as session:

            async def check() -> None:
                summary = await get_item_summary(
                    session, ctx.authorizer, ctx.principal, workspace_id, item_id
                )
                if summary is None:
                    raise PermissionDenied(
                        f"Permission 'items.get' denied on resource '{item}' "
                        "(or it might not exist)",
                        metadata={"permission": "items.get", "resource": item},
                    )
                if summary.item_type not in {"DOCUMENT", "COLLECTION"}:
                    raise InvalidArgument.for_field(
                        "item", "A material is a DOCUMENT or a COLLECTION."
                    )
                taken = await session.scalar(
                    select(SpaceMaterial.id).where(
                        SpaceMaterial.space_id == space.id,
                        SpaceMaterial.item_id == item_id,
                    )
                )
                if taken is not None:
                    raise AlreadyExists(
                        f"'{item}' is already a material of this space."
                    )

            return await self._create(
                ctx,
                workspace_id,
                space,
                row,
                method="CreateMaterial",
                request={"item": item, "note": note},
                request_id=request_id,
                session=session,
                check=check,
            )

    async def get(
        self, ctx: RequestContext, workspace_id: UUID, code: str, material_id: UUID
    ) -> SpaceChild:
        """A material whose item the caller can still see; otherwise it reads as absent."""
        space = await self._space(ctx, workspace_id, code, "get", write=False)
        async with transaction_scope(self._sessions) as session:
            row = await self._readable_row(
                ctx, session, workspace_id, space, material_id
            )
            return self._record(workspace_id, space, row)

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, code: str, query: ListQuery
    ) -> list[SpaceChild]:
        """Materials whose item the caller can see (merges followed), paged in SQL."""
        space = await self._space(ctx, workspace_id, code, "list", write=False)
        async with transaction_scope(self._sessions) as session:
            pinned = list(
                await session.scalars(
                    select(SpaceMaterial.item_id).where(
                        SpaceMaterial.space_id == space.id
                    )
                )
            )
            readable = await readable_item_ids(
                session, ctx.authorizer, ctx.principal, workspace_id, pinned
            )
            statement = select(SpaceMaterial).where(
                SpaceMaterial.space_id == space.id, SpaceMaterial.item_id.in_(readable)
            )
            rows = await session.scalars(query.apply(statement))
            return [self._record(workspace_id, space, row) for row in rows]

    async def delete(
        self, ctx: RequestContext, workspace_id: UUID, code: str, material_id: UUID
    ) -> None:
        """Remove a material; one whose item the caller cannot see reads as absent."""
        space = await self._space(ctx, workspace_id, code, "delete", write=True)
        async with transaction_scope(self._sessions) as session:
            row = await self._readable_row(
                ctx, session, workspace_id, space, material_id, for_update=True
            )
            record = self._record(workspace_id, space, row)
            await session.execute(
                delete(SpaceMaterial).where(SpaceMaterial.id == row.id)
            )
            await _audit(session, ctx, workspace_id, "DeleteMaterial", record.name)

    async def _readable_row(
        self,
        ctx: RequestContext,
        session: AsyncSession,
        workspace_id: UUID,
        space: Space,
        material_id: UUID,
        *,
        for_update: bool = False,
    ) -> SpaceMaterial:
        row = await self._row(
            session, workspace_id, space, material_id, for_update=for_update
        )
        readable = await readable_item_ids(
            session, ctx.authorizer, ctx.principal, workspace_id, [row.item_id]
        )
        if row.item_id not in readable:
            raise missing(self._name(workspace_id, space, material_id))
        return row


def _title(value: str | None) -> str:
    title = (value or "").strip()
    if not title:
        raise InvalidArgument.for_field("title", "title is required.")
    if len(title) > MAX_TITLE:
        raise InvalidArgument.for_field(
            "title", f"title is longer than {MAX_TITLE} characters."
        )
    return title


def _check_window(start: datetime, end: datetime | None) -> None:
    if end is not None and end < start:
        raise InvalidArgument.for_field(
            "endTime", "endTime must not precede startTime."
        )


async def _audit(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    action: str,
    target: str,
) -> None:
    await Audit(session).record(
        ctx, workspace_id=workspace_id, category="spaces", action=action, target=target
    )


__all__ = ["AnnouncementService", "MaterialService", "SpaceEventService"]
