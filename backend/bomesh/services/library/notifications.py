"""Notifications (``…/members/{member}/notifications/{notification}``): reads and the read flag.

The kernel's ``NotificationPublisher`` writes them. A notification whose subject
(item, contribution or request) the member can no longer read is omitted
everywhere (Get answers NOT_FOUND) and not counted; one past its ``purgeTime`` is gone.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import (
    ColumnElement,
    String,
    and_,
    case,
    cast,
    false,
    func,
    literal,
    or_,
    select,
    tuple_,
    update,
)
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Item, Notification
from bomesh.errors import AlreadyExists, NotFound
from bomesh.iam.authorizer import Authorizer, Principal
from bomesh.services.collaboration.requests import request_readable
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.retention import RETENTION
from bomesh.services.knowledge_curation.contributions import contribution_readable
from bomesh.services.knowledge_items.item_store import catalog_visibility
from bomesh.services.library.access import LibraryGate, Owner
from bomesh.services.library.records import (
    TARGET_COLLECTIONS,
    NotificationRecord,
)

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

#: ``Notification.target`` as SQL, for the ``target`` filter field.
NOTIFICATION_TARGET: ColumnElement[Any] = case(
    *(
        (
            Notification.subject_type == subject_type,
            func.concat(
                "workspaces/",
                cast(Notification.tenant_id, String),
                f"/{collection}/",
                cast(Notification.subject_id, String),
            ),
        )
        for subject_type, collection in TARGET_COLLECTIONS.items()
    ),
    else_=literal(""),
)
#: Whether a principal may still read a non-item subject, by ``subject_type``;
#: each rule is the owning slice's public read check.
SubjectReadRule = Callable[[AsyncSession, Authorizer, Principal, UUID, UUID], Awaitable[bool]]
SUBJECT_READ_RULES: dict[str, SubjectReadRule] = {
    "contribution": contribution_readable,
    "request": request_readable,
}
NOTIFICATION_READ: ColumnElement[bool] = Notification.read_at.is_not(None)


class NotificationService:
    def __init__(self, sessions: SessionFactory) -> None:
        self._sessions = sessions
        self._gate = LibraryGate(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> NotificationService:
        return cls(runtime.sessions())

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, member: str, query: ListQuery
    ) -> tuple[list[NotificationRecord], int]:
        """The page and ``totalSize`` (the matching count, e.g. unread with ``read=false``)."""
        owner = await self._gate.open(ctx, workspace_id, member, "notifications.list", write=False)
        async with transaction_scope(self._sessions) as session:
            statement = select(Notification).where(
                await _readable(session, ctx, owner, include_dismissed=query.show_deleted)
            )
            rows = await session.scalars(query.apply(statement))
            total = await session.scalar(query.count(statement))
            return [NotificationRecord(row) for row in rows], int(total or 0)

    async def get(
        self, ctx: RequestContext, workspace_id: UUID, member: str, notification_id: str
    ) -> NotificationRecord:
        owner = await self._gate.open(ctx, workspace_id, member, "notifications.get", write=False)
        async with transaction_scope(self._sessions) as session:
            return NotificationRecord(await _load(session, ctx, owner, notification_id))

    async def set_read(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        member: str,
        notification_id: str,
        read: bool,
    ) -> NotificationRecord:
        owner = await self._gate.open(
            ctx, workspace_id, member, "notifications.update", write=True
        )
        async with transaction_scope(self._sessions) as session:
            row = await _load(session, ctx, owner, notification_id, for_update=True)
            if read and row.read_at is None:
                row.read_at = datetime.now(UTC)
            elif not read:
                row.read_at = None
            await session.flush()
            return NotificationRecord(row)

    async def dismiss(
        self, ctx: RequestContext, workspace_id: UUID, member: str, notification_id: str
    ) -> NotificationRecord:
        """Soft delete; dismissing a dismissed notification leaves it unchanged."""
        owner = await self._gate.open(
            ctx, workspace_id, member, "notifications.delete", write=True
        )
        async with transaction_scope(self._sessions) as session:
            row = await _load(session, ctx, owner, notification_id, for_update=True)
            if row.deleted_at is None:
                row.deleted_at = datetime.now(UTC)
                await session.flush()
            return NotificationRecord(row)

    async def undelete(
        self, ctx: RequestContext, workspace_id: UUID, member: str, notification_id: str
    ) -> NotificationRecord:
        owner = await self._gate.open(
            ctx, workspace_id, member, "notifications.undelete", write=True
        )
        async with transaction_scope(self._sessions) as session:
            row = await _load(session, ctx, owner, notification_id, for_update=True)
            if row.deleted_at is None:
                raise AlreadyExists(f"{NotificationRecord(row).name} is not dismissed.")
            row.deleted_at = None
            await session.flush()
            return NotificationRecord(row)

    async def mark_read(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        member: str,
        where: ColumnElement[bool],
    ) -> int:
        """Mark every live, unread notification matching ``where`` read; returns how many."""
        owner = await self._gate.open(
            ctx, workspace_id, member, "notifications.markRead", write=True
        )
        async with transaction_scope(self._sessions) as session:
            matching = select(Notification.id).where(
                await _readable(session, ctx, owner, include_dismissed=False),
                Notification.read_at.is_(None),
                where,
            )
            result = await session.execute(
                update(Notification)
                .where(Notification.id.in_(matching))
                .values(read_at=datetime.now(UTC))
                .execution_options(synchronize_session=False)
            )
            return int(getattr(result, "rowcount", 0) or 0)


async def unread_count(session: AsyncSession, ctx: RequestContext, owner: Owner) -> int:
    """Live unread notifications the member may still read (Home's badge)."""
    statement = select(func.count(Notification.id)).where(
        await _readable(session, ctx, owner, include_dismissed=False),
        Notification.read_at.is_(None),
    )
    return int(await session.scalar(statement) or 0)


async def _readable(
    session: AsyncSession, ctx: RequestContext, owner: Owner, *, include_dismissed: bool
) -> ColumnElement[bool]:
    """The member's unpurged notifications whose subject they may still read."""
    conditions = [
        _owned(owner),
        or_(
            Notification.deleted_at.is_(None),
            Notification.deleted_at > datetime.now(UTC) - RETENTION,
        ),
        await _readable_subject(session, ctx, owner),
    ]
    if not include_dismissed:
        conditions.append(Notification.deleted_at.is_(None))
    return and_(*conditions)


async def _readable_subject(
    session: AsyncSession, ctx: RequestContext, owner: Owner
) -> ColumnElement[bool]:
    """No subject, a visible item, or a subject its owning slice's read rule still allows.

    Rules are evaluated per distinct subject the member was notified about, so the
    predicate stays SQL and ``totalSize``, paging and ``markRead`` agree. A subject
    type without a read rule fails closed.
    """
    visibility = await catalog_visibility(
        session, ctx.authorizer, ctx.principal, owner.workspace_id
    )
    subjects = await session.execute(
        select(Notification.subject_type, Notification.subject_id)
        .where(_owned(owner), Notification.subject_type.in_(SUBJECT_READ_RULES))
        .distinct()
    )
    readable: list[tuple[str, UUID]] = []
    for subject_type, subject_id in subjects.tuples():
        rule = SUBJECT_READ_RULES[subject_type]
        if await rule(session, ctx.authorizer, ctx.principal, owner.workspace_id, subject_id):
            readable.append((subject_type, subject_id))
    return or_(
        Notification.subject_type.is_(None),
        and_(
            Notification.subject_type == "item",
            Notification.subject_id.in_(select(Item.id).where(visibility.clause())),
        ),
        tuple_(Notification.subject_type, Notification.subject_id).in_(readable)
        if readable
        else false(),
    )


def _owned(owner: Owner) -> ColumnElement[bool]:
    return and_(
        Notification.tenant_id == owner.workspace_id,
        Notification.recipient_user_id == owner.user_id,
    )


async def _load(
    session: AsyncSession,
    ctx: RequestContext,
    owner: Owner,
    notification_id: str,
    *,
    for_update: bool = False,
) -> Notification:
    name = f"{owner.name}/notifications/{notification_id}"
    try:
        identifier = UUID(notification_id)
    except ValueError:
        raise NotFound(f"Resource '{name}' was not found.") from None
    statement = select(Notification).where(
        Notification.id == identifier,
        await _readable(session, ctx, owner, include_dismissed=True),
    )
    row = await session.scalar(statement.with_for_update() if for_update else statement)
    if row is None:
        raise NotFound(f"Resource '{name}' was not found.")
    return row


__all__ = ["NOTIFICATION_READ", "NOTIFICATION_TARGET", "NotificationService", "unread_count"]
