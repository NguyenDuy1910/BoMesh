"""Source engine: computed state, schedules and the ``ingestion_syncs`` ledger.

A Source is one external resource synchronized into one Collection through a
Connection. Its state is never stored: it is computed from ``paused_at``, the
connection status and the latest ``ingestion_syncs`` row. Each sync is one
row; a partial unique index keeps one running sync per Source. The schedule
(``schedule_cron`` + ``schedule_time_zone``) is fired by Temporal;
``next_sync_at`` mirrors its next firing for the scheduler scan and the UI.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter
from sqlalchemy import ColumnElement, and_, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from bomesh.db.models import (
    Contribution,
    ExternalResource,
    IngestionSource,
    IngestionSync,
    IntegrationConnection,
    Item,
    Tenant,
)
from bomesh.db.models.knowledge import OPEN_CONTRIBUTION_STATES
from bomesh.errors import InvalidArgument
from bomesh.services import CONNECTION_NEEDS_AUTHORIZATION
from bomesh.services.ingestion.connection_store import connector_is_active

SOURCE_ACTIVE = "active"
SOURCE_PAUSED = "paused"
SOURCE_FAILED = "failed"
SOURCE_REAUTHORIZATION_REQUIRED = "reauthorization_required"
SOURCE_STATES = (SOURCE_ACTIVE, SOURCE_PAUSED, SOURCE_FAILED, SOURCE_REAUTHORIZATION_REQUIRED)

SYNC_RUNNING = "running"
SYNC_SUCCEEDED = "succeeded"
SYNC_FAILED = "failed"
#: ``ingestion_syncs.failures`` keeps at most this many entries.
MAX_SYNC_FAILURES = 100
#: Slice-wide refusal while ``tenants.ingestion_paused_at`` is set.
INGESTION_PAUSED = "Ingestion is paused for this workspace."
_CRON_FIELDS = 5


@dataclass(frozen=True, slots=True)
class SyncCounts:
    added: int = 0
    updated: int = 0
    removed: int = 0
    failed: int = 0


# -- State ------------------------------------------------------------------------


def source_state(
    source: IngestionSource, connection: IntegrationConnection, latest: IngestionSync | None
) -> str:
    """PAUSED, else REAUTHORIZATION_REQUIRED, else FAILED (latest sync failed), else ACTIVE."""
    if source.paused_at is not None:
        return SOURCE_PAUSED
    if connection.status in CONNECTION_NEEDS_AUTHORIZATION:
        return SOURCE_REAUTHORIZATION_REQUIRED
    if latest is not None and latest.status == SYNC_FAILED:
        return SOURCE_FAILED
    return SOURCE_ACTIVE


def source_state_column() -> ColumnElement[str]:
    """:func:`source_state` as SQL over ``ingestion_sources`` joined to its connection."""
    latest_status = (
        select(IngestionSync.status)
        .where(IngestionSync.ingestion_source_id == IngestionSource.id)
        .order_by(IngestionSync.started_at.desc(), IngestionSync.id.desc())
        .limit(1)
        .scalar_subquery()
    )
    return case(
        (IngestionSource.paused_at.is_not(None), SOURCE_PAUSED),
        (
            IntegrationConnection.status.in_(CONNECTION_NEEDS_AUTHORIZATION),
            SOURCE_REAUTHORIZATION_REQUIRED,
        ),
        (latest_status == SYNC_FAILED, SOURCE_FAILED),
        else_=SOURCE_ACTIVE,
    )


# -- Schedule ---------------------------------------------------------------------


def validate_schedule(cron: str, time_zone: str) -> None:
    """A 5-field cron expression and an IANA time zone; INVALID_ARGUMENT otherwise."""
    if len(cron.split()) != _CRON_FIELDS or not croniter.is_valid(cron):
        raise InvalidArgument.for_field(
            "schedule.cron", f"'{cron}' is not a 5-field cron expression."
        )
    _zone(time_zone)


def next_sync_time(cron: str, time_zone: str, *, after: datetime) -> datetime:
    """The first firing of the schedule strictly after ``after``, in UTC."""
    local = after.astimezone(_zone(time_zone))
    return croniter(cron, local).get_next(datetime).astimezone(UTC)


def refresh_next_sync(source: IngestionSource, *, now: datetime) -> None:
    """``next_sync_at``: the next firing, or ``None`` when unscheduled or paused."""
    if source.schedule_cron is None or source.schedule_time_zone is None or source.paused_at:
        source.next_sync_at = None
        return
    source.next_sync_at = next_sync_time(
        source.schedule_cron, source.schedule_time_zone, after=now
    )


def _zone(time_zone: str) -> ZoneInfo:
    try:
        return ZoneInfo(time_zone)
    except (ZoneInfoNotFoundError, ValueError):
        raise InvalidArgument.for_field(
            "schedule.timeZone", f"'{time_zone}' is not an IANA time zone."
        ) from None


# -- Reads ------------------------------------------------------------------------


async def load_source(
    session: AsyncSession, source_id: UUID, *, for_update: bool = False
) -> IngestionSource | None:
    """A live Source with its connection; ``None`` when absent or deleted."""
    statement = (
        select(IngestionSource)
        .options(joinedload(IngestionSource.integration_connection))
        .where(IngestionSource.id == source_id, IngestionSource.deleted_at.is_(None))
    )
    if for_update:
        statement = statement.with_for_update(of=IngestionSource)
    return await session.scalar(statement)


async def latest_syncs(
    session: AsyncSession, source_ids: Iterable[UUID]
) -> dict[UUID, IngestionSync]:
    ids = list(source_ids)
    if not ids:
        return {}
    syncs = await session.scalars(
        select(IngestionSync)
        .where(IngestionSync.ingestion_source_id.in_(ids))
        .order_by(
            IngestionSync.ingestion_source_id,
            IngestionSync.started_at.desc(),
            IngestionSync.id.desc(),
        )
        .distinct(IngestionSync.ingestion_source_id)
    )
    return {sync.ingestion_source_id: sync for sync in syncs}


async def sync_refusal(session: AsyncSession, source: IngestionSource) -> str | None:
    """Why the Source cannot sync now, in words for its manager; ``None`` when it can.

    ``source.integration_connection`` must be loaded.
    """
    connection = source.integration_connection
    if source.deleted_at is not None or connection.deleted_at is not None:
        return "This source was deleted."
    if source.paused_at is not None:
        return "This source is paused. Resume it to sync."
    if connection.status in CONNECTION_NEEDS_AUTHORIZATION:
        return "Reconnect the account behind this source to sync."
    if connection.status != "active":
        return "The connection behind this source is not active."
    workspace = await session.get(Tenant, source.tenant_id)
    if workspace is not None and workspace.ingestion_paused_at is not None:
        return INGESTION_PAUSED
    if not await connector_is_active(session, connection.connector_key):
        return "The connector of this source is disabled."
    return None


async def running_sync(session: AsyncSession, source_id: UUID) -> IngestionSync | None:
    return await session.scalar(
        select(IngestionSync).where(
            IngestionSync.ingestion_source_id == source_id,
            IngestionSync.status == SYNC_RUNNING,
        )
    )


async def pending_document_counts(
    session: AsyncSession, source_ids: Iterable[UUID], *, processing_version: str
) -> dict[UUID, int]:
    """Each Source's live Documents waiting for processing: PENDING or OUTDATED."""
    ids = list(source_ids)
    if not ids:
        return {}
    waiting = or_(
        Item.index_status == "pending",
        and_(
            Item.index_status == "ready",
            Item.processed_version.is_distinct_from(processing_version),
        ),
    )
    rows = await session.execute(
        select(ExternalResource.ingestion_source_id, func.count(Item.id.distinct()))
        .join(Item, Item.id == ExternalResource.item_id)
        .where(
            ExternalResource.ingestion_source_id.in_(ids),
            ExternalResource.deleted_at.is_(None),
            Item.item_type == "document",
            Item.deleted_at.is_(None),
            waiting,
        )
        .group_by(ExternalResource.ingestion_source_id)
    )
    return {source_id: int(count) for source_id, count in rows.all()}


async def in_review_counts(session: AsyncSession, source_ids: Iterable[UUID]) -> dict[UUID, int]:
    """Each Source's open SOURCE contributions."""
    ids = list(source_ids)
    if not ids:
        return {}
    rows = await session.execute(
        select(Contribution.ingestion_source_id, func.count())
        .where(
            Contribution.ingestion_source_id.in_(ids),
            Contribution.state.in_(OPEN_CONTRIBUTION_STATES),
            Contribution.deleted_at.is_(None),
        )
        .group_by(Contribution.ingestion_source_id)
    )
    return {source_id: int(count) for source_id, count in rows.all()}


# -- Sync ledger ------------------------------------------------------------------


async def start_sync(
    session: AsyncSession,
    source: IngestionSource,
    *,
    trigger: str,
    created_by_user_id: UUID | None = None,
) -> IngestionSync:
    """Insert the Source's RUNNING sync row (the caller holds the Source row lock)."""
    sync = IngestionSync(
        ingestion_source_id=source.id,
        trigger_type=trigger,
        status=SYNC_RUNNING,
        created_by_user_id=created_by_user_id,
        started_at=await session.scalar(select(func.now())),
    )
    session.add(sync)
    await session.flush()
    return sync


async def finish_sync(
    session: AsyncSession,
    sync_id: UUID,
    *,
    counts: SyncCounts,
    failures: Sequence[Mapping[str, Any]] = (),
    error: Mapping[str, Any] | None = None,
) -> IngestionSync | None:
    """Record how a running sync ended: ``error`` set means it failed as a whole."""
    sync = await session.get(IngestionSync, sync_id, with_for_update=True)
    if sync is None or sync.status != SYNC_RUNNING:
        return None
    sync.status = SYNC_FAILED if error is not None else SYNC_SUCCEEDED
    sync.added_count = counts.added
    sync.updated_count = counts.updated
    sync.removed_count = counts.removed
    sync.failed_count = counts.failed
    sync.failures = [dict(failure) for failure in failures[:MAX_SYNC_FAILURES]]
    sync.error = dict(error) if error is not None else None
    sync.finished_at = datetime.now(UTC)
    await session.flush()
    return sync


__all__ = [
    "INGESTION_PAUSED",
    "MAX_SYNC_FAILURES",
    "SOURCE_ACTIVE",
    "SOURCE_FAILED",
    "SOURCE_PAUSED",
    "SOURCE_REAUTHORIZATION_REQUIRED",
    "SOURCE_STATES",
    "SYNC_FAILED",
    "SYNC_RUNNING",
    "SYNC_SUCCEEDED",
    "SyncCounts",
    "finish_sync",
    "in_review_counts",
    "latest_syncs",
    "load_source",
    "next_sync_time",
    "pending_document_counts",
    "refresh_next_sync",
    "running_sync",
    "source_state",
    "source_state_column",
    "start_sync",
    "sync_refusal",
    "validate_schedule",
]
