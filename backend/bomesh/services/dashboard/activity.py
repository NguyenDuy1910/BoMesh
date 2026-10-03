"""Workspace activity: who signed in, asked, and changed what, over time.

One aggregation feeds both the Activity dashboard and the overview's usage
panel. Every count is a read-only SQL aggregate over durable rows; buckets are
cut on the caller's wall clock (``date_trunc`` on ``ts AT TIME ZONE tz``) and
every bucket in the window is emitted, zero-filled, oldest first.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import Select, and_, false, func, literal, or_, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import AccessSession, AuditLog, Conversation, Message, User
from bomesh.services import (
    ACTIVE_STATUS,
    AUDIT_READ_PERMISSION,
    TENANT_READ_PERMISSION,
    AuthContext,
    ControlPlaneNotFoundError,
    ControlPlaneValidationError,
    require_tenant_permission,
    timestamp,
)

ActivityWindow = Literal["24h", "7d", "30d"]
BucketUnit = Literal["hour", "day"]

#: window -> (bucket unit, bucket count)
_WINDOWS: dict[str, tuple[BucketUnit, int]] = {
    "24h": ("hour", 24),
    "7d": ("day", 7),
    "30d": ("day", 30),
}
_UNIT_STEP = {"hour": timedelta(hours=1), "day": timedelta(days=1)}

#: Event kinds that make their user "active" in a span. Creating a
#: conversation is counted on its own but is not, by itself, presence.
_PRESENCE = ("sign_in", "seen", "question", "change")

_TOP_CHANGES = 8
_TOP_PEOPLE = 10
_USAGE_DAYS = 30
_USAGE_TOTAL_DAYS = 7


def resolve_timezone(name: str) -> ZoneInfo:
    """Return the IANA zone, or reject the request as invalid input."""

    try:
        return ZoneInfo(name.strip())
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ControlPlaneValidationError(f"unknown timezone: {name}") from exc


class ActivityService:
    """Aggregate tenant activity into totals, wall-clock buckets, and leaders."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def workspace_activity(
        self,
        actor: AuthContext,
        workspace_id: UUID,
        *,
        window: str = "7d",
        tz: str = "UTC",
    ) -> dict[str, Any]:
        tenant_id = require_tenant_permission(actor, AUDIT_READ_PERMISSION)
        if workspace_id != tenant_id:
            raise ControlPlaneNotFoundError(f"tenant not found: {workspace_id}")
        if window not in _WINDOWS:
            raise ControlPlaneValidationError("window must be one of 24h, 7d, 30d")
        zone = resolve_timezone(tz)
        unit, count = _WINDOWS[window]
        now = datetime.now(UTC)
        keys = _bucket_keys(now, zone, unit, count)
        start = keys[0].replace(tzinfo=zone)
        totals, previous = await self._totals(tenant_id, start=start, end=now)
        return {
            "window": window,
            "timezone": zone.key,
            "bucket": unit,
            "start": timestamp(start),
            "generated_at": timestamp(now),
            "totals": totals,
            "previous": previous,
            "live_sessions": await self._live_sessions(tenant_id, now),
            "buckets": await self._buckets(tenant_id, zone, unit, keys, end=now),
            "sign_in_methods": await self._sign_in_methods(tenant_id, start, now),
            "top_changes": await self._top_changes(tenant_id, start, now),
            "people": await self._people(tenant_id, start, now),
        }

    async def usage(self, actor: AuthContext, *, tz: str = "UTC") -> dict[str, Any]:
        """The overview's usage panel: 30 daily buckets and a 7-day comparison.

        ``totals`` covers the same span as the ``7d`` activity window, so the
        two screens agree; ``previous`` is the equally long span before it.
        """

        tenant_id = require_tenant_permission(actor, TENANT_READ_PERMISSION)
        zone = resolve_timezone(tz)
        now = datetime.now(UTC)
        keys = _bucket_keys(now, zone, "day", _USAGE_DAYS)
        start = keys[-_USAGE_TOTAL_DAYS].replace(tzinfo=zone)
        totals, previous = await self._totals(tenant_id, start=start, end=now)
        usage_fields = ("active_users", "questions", "sign_ins")
        return {
            "timezone": zone.key,
            "buckets": [
                {"start": bucket["start"], **{key: bucket[key] for key in usage_fields}}
                for bucket in await self._buckets(tenant_id, zone, "day", keys, end=now)
            ],
            "totals": {key: totals[key] for key in usage_fields},
            "previous": {key: previous[key] for key in usage_fields},
        }

    # -- Aggregates ---------------------------------------------------------

    async def _totals(
        self, tenant_id: UUID, *, start: datetime, end: datetime
    ) -> tuple[dict[str, int], dict[str, int]]:
        """Totals for ``[start, end]`` and the equally long span before it."""

        previous_start = start - (end - start)
        events = _events(tenant_id, previous_start, end)
        current = events.c.at >= start
        before = events.c.at < start
        row = (
            await self._session.execute(
                select(*_total_columns(events, current), *_total_columns(events, before))
            )
        ).one()
        width = len(row) // 2
        return _totals_payload(row[:width]), _totals_payload(row[width:])

    async def _buckets(
        self,
        tenant_id: UUID,
        zone: ZoneInfo,
        unit: BucketUnit,
        keys: list[datetime],
        *,
        end: datetime,
    ) -> list[dict[str, Any]]:
        start = keys[0].replace(tzinfo=zone)
        events = _events(tenant_id, start, end)
        stamped = select(
            events,
            func.date_trunc(unit, func.timezone(zone.key, events.c.at)).label("bucket"),
        ).subquery("stamped")
        presence = stamped.c.kind.in_(_PRESENCE)
        rows = await self._session.execute(
            select(
                stamped.c.bucket,
                func.count(stamped.c.user_id.distinct()).filter(presence),
                func.count().filter(stamped.c.kind == "sign_in"),
                func.count().filter(stamped.c.kind == "question"),
                func.count().filter(stamped.c.kind == "change"),
                func.count().filter(stamped.c.kind == "change", stamped.c.failed),
            ).group_by(stamped.c.bucket)
        )
        counted = {row[0]: row[1:] for row in rows}
        payload = []
        for key in keys:
            active, sign_ins, questions, changes, failed = counted.get(key, (0,) * 5)
            payload.append(
                {
                    "start": timestamp(key.replace(tzinfo=zone)),
                    "active_users": int(active),
                    "sign_ins": int(sign_ins),
                    "questions": int(questions),
                    "changes": int(changes),
                    "failed_changes": int(failed),
                }
            )
        return payload

    async def _live_sessions(self, tenant_id: UUID, now: datetime) -> int:
        return int(
            await self._session.scalar(
                select(func.count())
                .select_from(AccessSession)
                .where(
                    AccessSession.tenant_id == tenant_id,
                    AccessSession.status == ACTIVE_STATUS,
                    AccessSession.expires_at > now,
                    or_(
                        AccessSession.idle_expires_at.is_(None),
                        AccessSession.idle_expires_at > now,
                    ),
                )
            )
            or 0
        )

    async def _sign_in_methods(
        self, tenant_id: UUID, start: datetime, end: datetime
    ) -> list[dict[str, Any]]:
        count = func.count().label("count")
        rows = await self._session.execute(
            select(AccessSession.authentication_method, count)
            .where(
                AccessSession.tenant_id == tenant_id,
                AccessSession.kind == "user",
                AccessSession.created_at >= start,
                AccessSession.created_at <= end,
            )
            .group_by(AccessSession.authentication_method)
            .order_by(count.desc(), AccessSession.authentication_method)
        )
        return [{"method": method, "count": int(total)} for method, total in rows]

    async def _top_changes(
        self, tenant_id: UUID, start: datetime, end: datetime
    ) -> list[dict[str, Any]]:
        count = func.count().label("count")
        rows = await self._session.execute(
            select(
                AuditLog.action,
                count,
                func.count().filter(AuditLog.outcome != "success").label("failed"),
            )
            .where(
                AuditLog.tenant_id == tenant_id,
                AuditLog.created_at >= start,
                AuditLog.created_at <= end,
            )
            .group_by(AuditLog.action)
            .order_by(count.desc(), AuditLog.action)
            .limit(_TOP_CHANGES)
        )
        return [
            {"action": action, "count": int(total), "failed": int(failed)}
            for action, total, failed in rows
        ]

    async def _people(
        self, tenant_id: UUID, start: datetime, end: datetime
    ) -> list[dict[str, Any]]:
        events = _events(tenant_id, start, end)
        presence = events.c.kind.in_(_PRESENCE)
        per_user = (
            select(
                events.c.user_id,
                func.count().filter(events.c.kind == "question").label("questions"),
                func.count().filter(events.c.kind == "conversation").label("conversations"),
                func.count().filter(events.c.kind == "sign_in").label("sign_ins"),
                func.count().filter(events.c.kind == "change").label("changes"),
                func.max(events.c.at).filter(presence).label("last_active_at"),
            )
            .where(events.c.user_id.is_not(None))
            .group_by(events.c.user_id)
            .having(func.count().filter(presence) > 0)
            .subquery("per_user")
        )
        rows = await self._session.execute(
            select(per_user, User.email, User.display_name)
            .outerjoin(User, User.id == per_user.c.user_id)
            .order_by(
                (per_user.c.questions + per_user.c.sign_ins + per_user.c.changes).desc(),
                per_user.c.last_active_at.desc().nulls_last(),
                per_user.c.user_id,
            )
            .limit(_TOP_PEOPLE)
        )
        return [
            {
                "user_id": str(row.user_id),
                "email": row.email,
                "display_name": row.display_name,
                "questions": int(row.questions),
                "conversations": int(row.conversations),
                "sign_ins": int(row.sign_ins),
                "changes": int(row.changes),
                "last_active_at": timestamp(row.last_active_at),
            }
            for row in rows
        ]


def _events(tenant_id: UUID, since: datetime, until: datetime):
    """Every tenant activity event in ``[since, until]`` as one row each.

    Columns: ``user_id`` (nullable for system audit events), ``at``, ``kind``
    (``sign_in``, ``seen``, ``question``, ``conversation``, ``change``), and
    ``failed`` (only ever true for a change).
    """

    def within(column) -> Any:
        return and_(column >= since, column <= until)

    def row(user_id, at, kind: str, failed=None) -> list[Any]:
        return [
            user_id.label("user_id"),
            at.label("at"),
            literal(kind).label("kind"),
            (failed if failed is not None else false()).label("failed"),
        ]

    user_sessions = and_(
        AccessSession.tenant_id == tenant_id, AccessSession.kind == "user"
    )
    branches: list[Select[Any]] = [
        select(
            *row(AccessSession.user_id, AccessSession.created_at, "sign_in")
        ).where(user_sessions, within(AccessSession.created_at)),
        select(*row(AccessSession.user_id, AccessSession.last_seen_at, "seen")).where(
            user_sessions, within(AccessSession.last_seen_at)
        ),
        select(*row(Conversation.owner_user_id, Message.created_at, "question"))
        .join(Conversation, Conversation.id == Message.conversation_id)
        .where(
            Conversation.tenant_id == tenant_id,
            Message.role == "user",
            within(Message.created_at),
        ),
        select(
            *row(Conversation.owner_user_id, Conversation.created_at, "conversation")
        ).where(Conversation.tenant_id == tenant_id, within(Conversation.created_at)),
        select(
            *row(
                AuditLog.actor_user_id,
                AuditLog.created_at,
                "change",
                AuditLog.outcome != "success",
            )
        ).where(AuditLog.tenant_id == tenant_id, within(AuditLog.created_at)),
    ]
    return union_all(*branches).subquery("activity_events")


def _total_columns(events: Any, period: Any) -> list[Any]:
    return [
        func.count(events.c.user_id.distinct()).filter(
            period, events.c.kind.in_(_PRESENCE)
        ),
        func.count().filter(period, events.c.kind == "sign_in"),
        func.count().filter(period, events.c.kind == "question"),
        func.count().filter(period, events.c.kind == "conversation"),
        func.count().filter(period, events.c.kind == "change"),
        func.count().filter(period, events.c.kind == "change", events.c.failed),
    ]


def _totals_payload(values: Any) -> dict[str, int]:
    active, sign_ins, questions, conversations, changes, failed = (
        int(value or 0) for value in values
    )
    return {
        "active_users": active,
        "sign_ins": sign_ins,
        "questions": questions,
        "conversations": conversations,
        "changes": changes,
        "failed_changes": failed,
    }


def _bucket_keys(
    now: datetime, zone: ZoneInfo, unit: BucketUnit, count: int
) -> list[datetime]:
    """Wall-clock bucket starts in ``zone``, oldest first, ending at ``now``'s.

    Naive on purpose: they compare equal to ``date_trunc`` over
    ``ts AT TIME ZONE zone``, which is how SQL labels each event's bucket.
    """

    local = now.astimezone(zone).replace(tzinfo=None)
    last = local.replace(minute=0, second=0, microsecond=0)
    if unit == "day":
        last = last.replace(hour=0)
    step = _UNIT_STEP[unit]
    return [last - step * (count - 1 - index) for index in range(count)]


__all__ = ["ActivityService", "resolve_timezone"]
