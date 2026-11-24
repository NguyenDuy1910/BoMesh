"""Notifications (``…/members/{member}/notifications/{notification}``): reads and the read flag.

The kernel's ``NotificationPublisher`` writes them. A notification whose subject
(item, contribution or request) the member can no longer read is omitted
everywhere (Get answers NOT_FOUND) and not counted; one past its ``purgeTime`` is gone.
The read rules are SQL, so every list, count and update evaluates them in one statement.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import (
    ColumnElement,
    Select,
    String,
    and_,
    case,
    cast,
    func,
    literal,
    or_,
    select,
    update,
)
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Contribution, Item, Notification, Request
from bomesh.errors import AlreadyExists, NotFound
from bomesh.iam.authorizer import Authorizer, Principal
from bomesh.iam.visibility import ItemVisibility
from bomesh.services.collaboration.requests import readable_requests
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.retention import RETENTION
from bomesh.services.knowledge_curation.contributions import readable_contributions
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
#: The non-item subjects a principal may still read, by ``subject_type``: the
#: subject's id column and the owning slice's read rule over its table (SQL).
SubjectReadRule = Callable[[Authorizer, Principal, UUID], Awaitable[ColumnElement[bool]]]
SUBJECT_READ_RULES: dict[str, tuple[InstrumentedAttribute[UUID], SubjectReadRule]] = {
    "contribution": (Contribution.id, readable_contributions),
    "request": (Request.id, readable_requests),
}
NOTIFICATION_READ: ColumnElement[bool] = Notification.read_at.is_not(None)


class NotificationService:
    def __init__(self, sessions: SessionFactory) -> None:
        self._sessions = sessions
        self._gate = LibraryGate()

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> NotificationService:
        return cls(runtime.sessions())

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, member: str, query: ListQuery
    ) -> tuple[list[NotificationRecord], int]:
        """The page and ``totalSize`` (the matching count, e.g. unread with ``read=false``)."""
        owner = await self._gate.open(ctx, workspace_id, member, "notifications.list", write=False)
        async with transaction_scope(self._sessions) as session:
            visibility = await _catalog(session, ctx, owner)
            statement = select(Notification).where(
                await _readable(ctx, owner, visibility, include_dismissed=query.show_deleted)
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
            visibility = await _catalog(session, ctx, owner)
            matching = select(Notification.id).where(
                await _readable(ctx, owner, visibility, include_dismissed=False),
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


async def unread_count_statement(
    ctx: RequestContext, owner: Owner, visibility: ItemVisibility
) -> Select[tuple[int]]:
    """``SELECT count`` of the live unread notifications the member may still read
    (Home's badge, composed into Home's one counting statement).

    ``visibility`` is the caller's :func:`catalog_visibility` of the workspace.
    """
    return select(func.count(Notification.id)).where(
        await _readable(ctx, owner, visibility, include_dismissed=False),
        Notification.read_at.is_(None),
    )


async def _catalog(session: AsyncSession, ctx: RequestContext, owner: Owner) -> ItemVisibility:
    return await catalog_visibility(session, ctx.authorizer, ctx.principal, owner.workspace_id)


async def _readable(
    ctx: RequestContext, owner: Owner, visibility: ItemVisibility, *, include_dismissed: bool
) -> ColumnElement[bool]:
    """The member's unpurged notifications whose subject they may still read."""
    conditions = [
        _owned(owner),
        or_(
            Notification.deleted_at.is_(None),
            Notification.deleted_at > datetime.now(UTC) - RETENTION,
        ),
        await _readable_subject(ctx, owner, visibility),
    ]
    if not include_dismissed:
        conditions.append(Notification.deleted_at.is_(None))
    return and_(*conditions)


async def _readable_subject(
    ctx: RequestContext, owner: Owner, visibility: ItemVisibility
) -> ColumnElement[bool]:
    """No subject, a visible item, or a subject its owning slice's read rule still allows.

    Every rule is SQL over its subject table, so the predicate costs a constant
    number of permission lookups and ``totalSize``, paging and ``markRead`` agree.
    A subject type without a read rule fails closed.
    """
    rules = [
        and_(
            Notification.subject_type == subject_type,
            Notification.subject_id.in_(
                select(column).where(
                    await rule(ctx.authorizer, ctx.principal, owner.workspace_id)
                )
            ),
        )
        for subject_type, (column, rule) in SUBJECT_READ_RULES.items()
    ]
    return or_(
        Notification.subject_type.is_(None),
        and_(
            Notification.subject_type == "item",
            Notification.subject_id.in_(select(Item.id).where(visibility.clause())),
        ),
        *rules,
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
    visibility = await _catalog(session, ctx, owner)
    statement = select(Notification).where(
        Notification.id == identifier,
        await _readable(ctx, owner, visibility, include_dismissed=True),
    )
    row = await session.scalar(statement.with_for_update() if for_update else statement)
    if row is None:
        raise NotFound(f"Resource '{name}' was not found.")
    return row


__all__ = [
    "NOTIFICATION_READ",
    "NOTIFICATION_TARGET",
    "NotificationService",
    "unread_count_statement",
]
