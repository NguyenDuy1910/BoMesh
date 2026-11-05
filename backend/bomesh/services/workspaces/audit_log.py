"""Append-only audit log: record events, read them back, render and store them as CSV.

Events carry safe operational metadata, never content. Reads are scoped
(:data:`AuditScope`): one workspace, every workspace (``workspaces/-``) or the
platform (events with no workspace). ``metadata_only`` reads and exports drop
``target`` and ``description`` (platform callers, ``workspaces/-``).
"""

from __future__ import annotations

import asyncio
import csv
import io
import re
from collections.abc import Iterable, Mapping, Sequence
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import ColumnElement, Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import AuditLog
from bomesh.db.models.workspaces import AUDIT_CATEGORIES, AUDIT_OUTCOMES
from bomesh.iam.authorizer import Principal
from bomesh.storage import DocumentStorage

_SENSITIVE_DETAIL_TERMS = frozenset(
    {"authorization", "content", "credential", "password", "secret", "token"}
)

#: One workspace, every workspace (``"all"``) or the platform (``None``).
AuditScope = UUID | Literal["all"] | None
ALL_WORKSPACES: Literal["all"] = "all"

_WORD = re.compile(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+")


class AuditService:
    """Write one audit event inside the caller's transaction."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def record(
        self,
        *,
        workspace_id: UUID | None,
        actor: Principal | None,
        category: str,
        action: str,
        resource_type: str,
        target_name: str | None = None,
        outcome: str = "succeeded",
        details: Mapping[str, Any] | None = None,
        ip_address: str | None = None,
    ) -> AuditLog:
        """Record one action; ``workspace_id=None`` files it under the platform.

        ``category`` is an ``AuditEvent.category`` value in lower case
        (``knowledge``, ``people``, …); ``actor=None`` is the system.
        ``target_name`` is the target's resource name; details are redacted
        of anything that looks like a secret or content.
        """
        if category not in AUDIT_CATEGORIES:
            raise ValueError(f"unknown audit category: {category}")
        if outcome not in AUDIT_OUTCOMES:
            raise ValueError(f"unknown audit outcome: {outcome}")
        event = AuditLog(
            tenant_id=workspace_id,
            actor_user_id=actor.user_id if actor is not None else None,
            actor_session_id=actor.session_id if actor is not None else None,
            category=category,
            action=_text(action, 96),
            resource_type=_text(resource_type, 32),
            target_name=_text(target_name, 512) if target_name is not None else None,
            outcome=outcome,
            ip_address=ip_address,
            details=_safe_details(details or {}),
        )
        self._session.add(event)
        await self._session.flush()
        return event


class AuditLogReader:
    """Scoped reads of audit events inside the caller's transaction.

    ``where`` and ``order_by`` come from the API filter and order schemas
    (``AUDIT_FILTER_FIELDS``/``AUDIT_ORDER`` in ``api.dto.workspaces``).
    """

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def list(
        self,
        scope: AuditScope,
        *,
        where: ColumnElement[bool],
        order_by: Sequence[ColumnElement[Any]],
        offset: int,
        limit: int,
    ) -> list[AuditLog]:
        rows = await self._session.scalars(
            _scoped(scope)
            .where(where)
            .order_by(*order_by)
            .offset(offset)
            .limit(limit)
        )
        return list(rows)

    async def count(self, scope: AuditScope, where: ColumnElement[bool]) -> int:
        statement = select(func.count()).select_from(_scoped(scope).where(where).subquery())
        return int(await self._session.scalar(statement) or 0)

    async def get(self, scope: AuditScope, event_id: UUID) -> AuditLog | None:
        return await self._session.scalar(_scoped(scope).where(AuditLog.id == event_id))

    async def summarize(
        self,
        scope: AuditScope,
        *,
        where: ColumnElement[bool],
        since: datetime,
        time_zone: str,
    ) -> list[tuple[datetime, str, int]]:
        """``(bucket start, category, count)`` per local day in ``time_zone`` since ``since``."""
        local_day = func.date_trunc("day", func.timezone(time_zone, AuditLog.created_at))
        bucket = func.timezone(time_zone, local_day).label("bucket")
        statement = (
            select(bucket, AuditLog.category, func.count())
            .where(_scope_clause(scope), where, AuditLog.created_at >= since)
            .group_by(bucket, AuditLog.category)
            .order_by(bucket, AuditLog.category)
        )
        rows = await self._session.execute(statement)
        return [(start, category, int(count)) for start, category, count in rows]


def audit_description(event: AuditLog) -> str:
    """The fixed template of ``AuditEvent.description``: action words and resource type.

    ``CreateMember`` on a ``member`` reads "Create member (member)"; it never
    holds titles, names or other workspace content.
    """
    words = _WORD.findall(event.action) or [event.action]
    sentence = " ".join([words[0].capitalize(), *(word.lower() for word in words[1:])])
    return f"{sentence} ({event.resource_type})"


def audit_event_name(event: AuditLog) -> str:
    """``workspaces/{w}/auditEvents/{e}``, or ``auditEvents/{e}`` for a platform event."""
    if event.tenant_id is None:
        return f"auditEvents/{event.id}"
    return f"workspaces/{event.tenant_id}/auditEvents/{event.id}"


def audit_actor(event: AuditLog) -> str:
    """``users/{user}`` or ``system``."""
    return f"users/{event.actor_user_id}" if event.actor_user_id is not None else "system"


def audit_rows(events: Iterable[AuditLog], *, metadata_only: bool) -> list[list[str]]:
    """The CSV rows of ``events`` (header first), as ExportAuditEvents writes them."""
    header = ["name", "createTime", "actor", "category", "action", "outcome", "ipAddress"]
    if not metadata_only:
        header += ["target", "description"]
    rows = [header]
    for event in events:
        row = [
            audit_event_name(event),
            _rfc3339(event.created_at),
            audit_actor(event),
            event.category.upper(),
            event.action,
            event.outcome.upper(),
            str(event.ip_address) if event.ip_address is not None else "",
        ]
        if not metadata_only:
            row += [event.target_name or "", audit_description(event)]
        rows.append(row)
    return rows


async def export_rows(
    session: AsyncSession,
    scope: AuditScope,
    *,
    where: ColumnElement[bool],
    metadata_only: bool,
) -> list[list[str]]:
    """The CSV rows of the matching events, newest first (ExportAuditEvents)."""
    events = await session.scalars(
        _scoped(scope).where(where).order_by(AuditLog.created_at.desc(), AuditLog.id)
    )
    return audit_rows(events, metadata_only=metadata_only)


async def store_csv(storage: DocumentStorage, key: str, rows: Sequence[Sequence[str]]) -> None:
    """Write ``rows`` as a CSV object (raises ``ObjectStorageError``)."""
    await asyncio.to_thread(storage.put_bytes, _csv(rows), key, content_type="text/csv")


def _scope_clause(scope: AuditScope) -> ColumnElement[bool]:
    if scope is None:
        return AuditLog.tenant_id.is_(None)
    if scope == ALL_WORKSPACES:
        return AuditLog.tenant_id.is_not(None)
    return AuditLog.tenant_id == scope


def _scoped(scope: AuditScope) -> Select[tuple[AuditLog]]:
    return select(AuditLog).where(_scope_clause(scope))


def _csv(rows: Sequence[Sequence[str]]) -> bytes:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerows(rows)
    return buffer.getvalue().encode()


def _rfc3339(value: datetime) -> str:
    utc = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    return utc.replace(tzinfo=None).isoformat() + "Z"


def _text(value: str, max_length: int) -> str:
    normalized = value.strip()
    if not normalized or len(normalized) > max_length:
        raise ValueError(f"audit value must be 1..{max_length} characters: {value!r}")
    return normalized


def _safe_details(value: Mapping[str, Any]) -> dict[str, Any]:
    safe: dict[str, Any] = {}
    for raw_key, raw_value in value.items():
        key = str(raw_key)[:128]
        normalized_key = key.casefold()
        if any(term in normalized_key for term in _SENSITIVE_DETAIL_TERMS):
            safe[key] = "[redacted]"
        elif isinstance(raw_value, Mapping):
            safe[key] = _safe_details(raw_value)
        elif isinstance(raw_value, (str, int, float, bool)) or raw_value is None:
            safe[key] = raw_value if not isinstance(raw_value, str) else raw_value[:512]
        elif isinstance(raw_value, (list, tuple)):
            safe[key] = [str(item)[:256] for item in raw_value[:50]]
        else:
            safe[key] = str(raw_value)[:512]
    return safe


__all__ = [
    "ALL_WORKSPACES",
    "AuditLogReader",
    "AuditScope",
    "AuditService",
    "audit_actor",
    "audit_description",
    "audit_event_name",
    "audit_rows",
    "export_rows",
    "store_csv",
]
