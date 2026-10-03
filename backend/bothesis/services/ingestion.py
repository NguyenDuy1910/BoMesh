"""The Ingestion resource: every run that brings content into knowledge.

Two kinds share one resource. A *document* Ingestion processes one upload (or
expands one archive); a *source* Ingestion synchronizes one connector Source.
Two runners execute them, both over the same ingestion core:

- **managed** runs are Temporal executions. Live state, attempts and
  history come from ``TemporalWorkflowService``, and the Activity monitor
  lists them.
- **direct** runs process a user's own upload inside the API process. Their
  state is the Document's Ingestion record, which the core keeps current.

This service decides who may see which run, shapes both into the public
contract, and routes retry/cancel to the lifecycle that owns each kind.
Visibility follows the data a run touches: a document run is visible to
readers of its Collection, a source run to holders of ``source.manage``.
"""

from __future__ import annotations

import asyncio
import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import select
from temporalio.service import RPCError

from bothesis.db.engine import SessionFactory, transaction_scope
from bothesis.db.models import Item
from bothesis.services import (
    COLLECTION_READ_PERMISSION,
    COLLECTION_UPDATE_PERMISSION,
    SOURCE_MANAGE_PERMISSION,
    AuthContext,
    ControlPlaneConflictError,
    ControlPlaneExternalUnavailableError,
    ControlPlaneNotFoundError,
    require_tenant_permission,
)
from bothesis.services.document_presentation import document_ingestion
from bothesis.services.documents import DocumentService
from bothesis.services.identity_access.authorization import AuthorizationService
from bothesis.services.integration_lifecycle import IntegrationLifecycleService
from bothesis.services.item_ingestion import progress_from_phases
from bothesis.services.workflow import (
    DOCUMENT_FAILURE_TYPE,
    INTERRUPTED_FAILURE_TYPE,
    PROVIDER_FAILURE_TYPE,
    WorkflowExecutionNotFoundError,
    ingestion_workflow_id,
    public_ingestion_id,
)
from bothesis.services.workflow.service import TemporalWorkflowService

#: Temporal outcomes the contract names differently or not at all.
_STATUS = {
    "running": "running",
    "completed": "completed",
    "failed": "failed",
    "cancelled": "cancelled",
    "timed_out": "timed_out",
    "terminated": "cancelled",
    "continued_as_new": "running",
}
_FINISHED_UNSUCCESSFULLY = {"failed", "cancelled", "timed_out"}
_WINDOWS = {
    "1h": (timedelta(hours=1), 300),
    "24h": (timedelta(hours=24), 3600),
    "7d": (timedelta(days=7), 21600),
}
#: Executions one summary reads; beyond it the window is sampled newest-first.
_SUMMARY_LIMIT = 2000
#: Failed rows on one list page whose reason is read from history.
_MAX_FAILURE_LOOKUPS = 10
_SAFE_FAILURE_TYPES = {DOCUMENT_FAILURE_TYPE, INTERRUPTED_FAILURE_TYPE, PROVIDER_FAILURE_TYPE}


@dataclass(frozen=True, slots=True)
class _Target:
    """One resolved Ingestion: its execution id, and its Document if it has one."""

    workflow_id: str
    document: Item | None = None

    @property
    def direct(self) -> bool:
        record = (self.document.metadata_.get("ingestion") or {}) if self.document else {}
        return record.get("mode") == "direct"


class IngestionService:
    """List, inspect, summarize, retry, and cancel Ingestions of both kinds."""

    def __init__(
        self,
        session_factory: SessionFactory,
        *,
        workflows: TemporalWorkflowService,
        documents: DocumentService,
        sources: IntegrationLifecycleService,
    ) -> None:
        self._sessions = session_factory
        self._workflows = workflows
        self._documents = documents
        self._sources = sources

    # -- Reads ----------------------------------------------------------------

    async def list_ingestions(
        self,
        access: AuthContext,
        *,
        page: int = 1,
        page_size: int = 20,
        kind: str | None = None,
        status: str | None = None,
        collection_id: UUID | None = None,
        document_id: UUID | None = None,
        source_id: UUID | None = None,
        connection_id: UUID | None = None,
    ) -> dict[str, Any]:
        """Managed runs, newest first: the monitor's view of the pipeline."""

        if source_id is not None:
            # Enforces that the Source exists and is visible to the caller.
            await self._sources.get_source(access, source_id)
        tenant_id, include_sources, collections = await self._scope(access)
        if kind == "document" or document_id is not None:
            include_sources = False
        if kind == "source" or source_id is not None or connection_id is not None:
            collections = ()
        result = await self._temporal(
            self._workflows.list_ingestions(
                tenant_id=str(tenant_id),
                page=page,
                page_size=page_size,
                status=status,
                source_id=_text(source_id),
                integration_connection_id=_text(connection_id),
                include_sources=include_sources,
                document_collection_ids=[str(value) for value in collections],
                collection_id=_text(collection_id),
                document_id=_text(document_id),
                live=True,
            )
        )
        await self._add_failures(result["items"])
        items = [ingestion_resource(raw) for raw in result["items"]]
        if status in {"pending", "running"}:
            items = [item for item in items if item["status"] == status]
        return {**result, "items": items}

    async def summarize(self, access: AuthContext, *, window: str = "24h") -> dict[str, Any]:
        """Throughput, outcomes and durations of the managed runs started inside ``window``."""

        if window not in _WINDOWS:
            raise ValueError("window must be one of 1h, 24h, 7d")
        span, bucket_seconds = _WINDOWS[window]
        tenant_id, include_sources, collections = await self._scope(access)
        now = datetime.now(UTC)
        start = datetime.fromtimestamp(
            math.floor((now - span).timestamp() / bucket_seconds) * bucket_seconds, UTC
        )
        executions, active = await self._temporal(
            asyncio.gather(
                self._workflows.scan_ingestions(
                    tenant_id=str(tenant_id),
                    started_after=start,
                    include_sources=include_sources,
                    document_collection_ids=[str(value) for value in collections],
                    limit=_SUMMARY_LIMIT,
                ),
                self._workflows.list_ingestions(
                    tenant_id=str(tenant_id),
                    page_size=1,
                    status="running",
                    include_sources=include_sources,
                    document_collection_ids=[str(value) for value in collections],
                ),
            )
        )
        return build_summary(
            executions,
            window=window,
            start=start,
            now=now,
            bucket_seconds=bucket_seconds,
            active=int(active["total"]),
        )

    async def get_ingestion(self, access: AuthContext, ingestion_id: UUID) -> dict[str, Any]:
        target = await self._resolve(access, ingestion_id)
        if target.direct:
            return _direct_resource(target.document)
        return ingestion_resource(await self._managed_detail(target, ingestion_id))

    async def list_events(self, access: AuthContext, ingestion_id: UUID) -> dict[str, Any]:
        target = await self._resolve(access, ingestion_id)
        if target.direct:
            return {"items": direct_events(target.document)}
        raw = await self._managed_detail(target, ingestion_id)
        return {"items": build_events(raw, raw["history"])}

    # -- Lifecycle ------------------------------------------------------------

    async def retry_ingestion(self, access: AuthContext, ingestion_id: UUID) -> dict[str, Any]:
        target = await self._resolve(access, ingestion_id)
        if target.direct:
            assert target.document is not None
            if _direct_resource(target.document)["status"] not in _FINISHED_UNSUCCESSFULLY:
                raise ControlPlaneConflictError("only a failed or cancelled ingestion can be retried")
            document = await self._documents.retry_ingestion(access, target.document.id)
            return _direct_resource(document)
        current = ingestion_resource(await self._describe(target.workflow_id))
        if current["status"] not in _FINISHED_UNSUCCESSFULLY:
            raise ControlPlaneConflictError("only a failed or cancelled ingestion can be retried")
        if current["kind"] == "document":
            await self._documents.retry_ingestion(access, UUID(str(current["document_id"])))
        else:
            await self._sources.ingest_source(access, UUID(str(current["source_id"])))
        return ingestion_resource(await self._describe(target.workflow_id))

    async def cancel_ingestion(self, access: AuthContext, ingestion_id: UUID) -> dict[str, Any]:
        target = await self._resolve(access, ingestion_id, write=True)
        if target.direct:
            raise ControlPlaneConflictError(
                "an upload processed directly runs to completion; retry it if it fails"
            )
        current = ingestion_resource(await self._describe(target.workflow_id))
        if current["status"] not in {"pending", "running"}:
            raise ControlPlaneConflictError("only a queued or running ingestion can be cancelled")
        return ingestion_resource(
            await self._temporal(self._workflows.cancel_ingestion(target.workflow_id))
        )

    # -- Internals ------------------------------------------------------------

    async def _scope(self, access: AuthContext) -> tuple[UUID, bool, tuple[UUID, ...]]:
        """The caller's tenant, whether source runs are visible, and readable Collections."""

        tenant_id = require_tenant_permission(access)
        async with transaction_scope(self._sessions) as session:
            collections = await AuthorizationService(session).allowed_collection_ids(
                access, permission=COLLECTION_READ_PERMISSION
            )
        return tenant_id, access.has_permissions(SOURCE_MANAGE_PERMISSION), collections

    async def _managed_detail(self, target: _Target, ingestion_id: UUID) -> dict[str, Any]:
        """One execution's live state with its history (and a document's own record)."""

        try:
            raw, history = await self._temporal(
                asyncio.gather(
                    self._workflows.describe_ingestion(target.workflow_id),
                    self._workflows.ingestion_history(target.workflow_id),
                )
            )
        except WorkflowExecutionNotFoundError as exc:
            raise ControlPlaneNotFoundError(f"ingestion not found: {ingestion_id}") from exc
        raw["history"] = history
        record = (target.document.metadata_.get("ingestion") or {}) if target.document else {}
        raw["recorded_phases"] = record.get("phases") or []
        return raw

    async def _resolve(
        self, access: AuthContext, ingestion_id: UUID, *, write: bool = False
    ) -> _Target:
        """Resolve a public id to its run, enforcing the kind's access rule."""

        tenant_id = require_tenant_permission(access)
        async with transaction_scope(self._sessions) as session:
            # Removed Documents included: an expanded archive's run stays visible.
            document = await session.scalar(
                select(Item).where(
                    Item.tenant_id == tenant_id,
                    Item.item_type == "document",
                    Item.metadata_["ingestion"]["id"].astext == str(ingestion_id),
                )
            )
            if document is not None:
                permission = COLLECTION_UPDATE_PERMISSION if write else COLLECTION_READ_PERMISSION
                allowed = await AuthorizationService(session).allowed_collection_ids(
                    access, permission=permission
                )
                if document.parent_item_id not in allowed:
                    raise ControlPlaneNotFoundError(f"ingestion not found: {ingestion_id}")
                return _Target(ingestion_workflow_id(str(document.id)), document)
        if not access.has_permissions(SOURCE_MANAGE_PERMISSION):
            raise ControlPlaneNotFoundError(f"ingestion not found: {ingestion_id}")
        return _Target(await self._source_workflow_id(tenant_id, ingestion_id))

    async def _source_workflow_id(self, tenant_id: UUID, ingestion_id: UUID) -> str:
        # A Source's execution id is not derivable from its public id, and only
        # eight keyword search attributes fit, so its runs are scanned.
        page = 1
        while True:
            result = await self._temporal(
                self._workflows.list_ingestions(
                    tenant_id=str(tenant_id), page=page, page_size=100
                )
            )
            for item in result["items"]:
                if public_ingestion_id(item["workflow_id"]) == ingestion_id:
                    return str(item["workflow_id"])
            if page * 100 >= result["total"]:
                raise ControlPlaneNotFoundError(f"ingestion not found: {ingestion_id}")
            page += 1

    async def _describe(self, workflow_id: str) -> dict[str, Any]:
        try:
            return await self._temporal(self._workflows.describe_ingestion(workflow_id))
        except WorkflowExecutionNotFoundError as exc:
            raise ControlPlaneNotFoundError("ingestion not found") from exc

    async def _add_failures(self, items: Sequence[dict[str, Any]]) -> None:
        """Read why each failed run on a page failed; history is the only record."""

        failed = [item for item in items if item["status"] in {"failed", "timed_out"}]

        async def lookup(item: dict[str, Any]) -> None:
            try:
                history = await self._workflows.ingestion_history(item["workflow_id"])
            except (WorkflowExecutionNotFoundError, RPCError):
                return
            item["history"] = history

        await asyncio.gather(*(lookup(item) for item in failed[:_MAX_FAILURE_LOOKUPS]))

    @staticmethod
    async def _temporal(awaitable: Any) -> Any:
        try:
            return await awaitable
        except RPCError as exc:
            raise ControlPlaneExternalUnavailableError(
                "ingestion activity is temporarily unavailable"
            ) from exc


def _direct_resource(document: Item | None) -> dict[str, Any]:
    resource = document_ingestion(document) if document is not None else None
    if resource is None:
        raise ControlPlaneNotFoundError("ingestion not found")
    return resource


# -- Contract shaping (pure) --------------------------------------------------


def ingestion_resource(raw: dict[str, Any]) -> dict[str, Any]:
    """Shape Temporal's facts about one execution into the public Ingestion."""

    activity = raw.get("activity") or {}
    heartbeat = activity.get("heartbeat") or {}
    status = _STATUS.get(raw.get("status") or "", "running")
    if status == "running" and "activity" in raw:
        # Queued: the execution exists but no worker has picked its run up.
        # (Only known where live state was read; list rows beyond the live
        # budget stay "running".)
        if not activity:
            status = "pending"
        elif activity.get("state") == "scheduled" and not heartbeat:
            status = "pending" if int(activity.get("attempt") or 1) == 1 else "running"
    kind = raw.get("kind") or "source"
    started_at = _time(raw.get("started_at"))
    finished_at = _time(raw.get("finished_at"))
    history = raw.get("history") or []
    failure = _last_failure(history) or activity.get("last_failure")
    attempt = max(
        [int(activity.get("attempt") or 1)]
        + [int(fact.get("attempt") or 1) for fact in history if fact["type"] == "activity_started"]
    )
    end = finished_at or datetime.now(UTC)
    return {
        "mode": "managed",
        "id": public_ingestion_id(raw["workflow_id"]),
        "kind": kind,
        "title": raw.get("title"),
        "document_id": raw.get("document_id"),
        "collection_id": raw.get("collection_id"),
        "source_id": raw.get("source_id"),
        "connection_id": raw.get("integration_connection_id"),
        "connector_key": raw.get("connector_key") or ("file" if kind == "document" else None),
        "status": status,
        "trigger_type": raw.get("trigger_type") or ("upload" if kind == "document" else "manual"),
        "retry_of_ingestion_id": None,
        "attempt": attempt,
        "error": (
            safe_failure_message(failure, kind=kind)
            if failure and (status in {"failed", "timed_out"} or attempt > 1)
            else None
        ),
        "progress": _progress(raw, status=status, heartbeat=heartbeat, phases=run_phases(raw)),
        "started_at": started_at,
        "finished_at": finished_at,
        "duration_ms": _milliseconds(started_at, end) if started_at else None,
        "created_at": started_at or datetime.now(UTC),
        "updated_at": finished_at or activity.get("heartbeat_at") or started_at or datetime.now(UTC),
    }


def safe_failure_message(failure: dict[str, Any], *, kind: str) -> str:
    """Only messages written for people reach them; anything else is generic."""

    if failure.get("timeout"):
        return "The worker stopped responding before the run finished."
    if failure.get("type") in _SAFE_FAILURE_TYPES and failure.get("message"):
        return str(failure["message"])
    return "The document could not be processed." if kind == "document" else "The sync failed."


def build_events(raw: dict[str, Any], history: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """A managed run's timeline: queued, attempts, pipeline phases and its outcome."""

    kind = raw.get("kind") or "source"
    events: list[dict[str, Any]] = []
    phases = run_phases(raw, history)
    result: Any = None
    add = _event_adder(events)

    for fact in history:
        at = fact["at"]
        kind_of_fact = fact["type"]
        if kind_of_fact == "workflow_started":
            add("queued", at)
        elif kind_of_fact == "activity_started":
            attempt = int(fact.get("attempt") or 1)
            if attempt > 1:
                add(
                    "retrying",
                    at,
                    attempt=attempt,
                    message=safe_failure_message(fact["failure"], kind=kind)
                    if fact.get("failure")
                    else None,
                )
            add("started", at, attempt=attempt)
        elif kind_of_fact == "activity_completed":
            result = fact.get("result")
        elif kind_of_fact == "workflow_completed":
            add("completed", at, message=_outcome_message(kind, result))
        elif kind_of_fact == "workflow_failed":
            add("failed", at, message=safe_failure_message(fact.get("failure") or {}, kind=kind))
        elif kind_of_fact in {"workflow_timed_out", "activity_timed_out"}:
            add("timed_out", at, message="The worker stopped responding before the run finished.")
        elif kind_of_fact == "workflow_cancelled":
            add("cancelled", at, message="Cancelled before it finished.")
        elif kind_of_fact == "workflow_terminated":
            add("cancelled", at, message="Stopped by an operator.")

    activity = raw.get("activity") or {}
    if activity:
        # The attempt in flight is not in history until it ends.
        started_at = activity.get("started_at")
        attempt = int(activity.get("attempt") or 1)
        if started_at is not None and not any(
            event["type"] == "started" and event["attempt"] == attempt for event in events
        ):
            if attempt > 1:
                failure = activity.get("last_failure")
                add(
                    "retrying",
                    started_at,
                    attempt=attempt,
                    message=safe_failure_message(failure, kind=kind) if failure else None,
                )
            add("started", started_at, attempt=attempt)

    if kind == "source" and not phases and raw.get("started_at"):
        phases = [
            {
                "phase": "syncing",
                "started_at": raw["started_at"],
                "finished_at": raw.get("finished_at"),
                "done": 0,
                "total": 0,
            }
        ]
    _add_phase_events(add, phases)
    return _ordered(events)


def run_phases(
    raw: dict[str, Any], history: Sequence[dict[str, Any]] | None = None
) -> list[dict[str, Any]]:
    """The phases a run went through, from wherever they were kept.

    Live: the heartbeat. Finished: the result or failure details in history.
    Cancelled: the Document's own record, since a cancel carries neither.
    """

    heartbeat = (raw.get("activity") or {}).get("heartbeat") or {}
    if heartbeat.get("phases"):
        return list(heartbeat["phases"])
    for fact in reversed(history if history is not None else raw.get("history") or []):
        if fact["type"] == "activity_completed" and isinstance(fact.get("result"), dict):
            return list(fact["result"].get("phases") or [])
        if fact["type"] == "activity_failed":
            details = (fact.get("failure") or {}).get("details")
            if isinstance(details, dict):
                return list(details.get("phases") or [])
    return list(raw.get("recorded_phases") or [])


def build_summary(
    executions: Sequence[dict[str, Any]],
    *,
    window: str,
    start: datetime,
    now: datetime,
    bucket_seconds: int,
    active: int,
) -> dict[str, Any]:
    """Aggregate one window of executions into the charts' projection."""

    count = max(1, math.ceil((now - start).total_seconds() / bucket_seconds))
    buckets = [
        {
            "start": start + timedelta(seconds=bucket_seconds * index),
            "started": 0,
            "completed": 0,
            "failed": 0,
        }
        for index in range(count)
    ]
    totals = {status: 0 for status in ("pending", "running", "completed", "failed", "cancelled", "timed_out")}
    by_kind = {"document": 0, "source": 0}
    durations: list[int] = []

    def bucket(at: datetime) -> dict[str, Any] | None:
        index = int((at - start).total_seconds() // bucket_seconds)
        return buckets[index] if 0 <= index < count else None

    for raw in executions:
        status = _STATUS.get(raw.get("status") or "", "running")
        totals[status] += 1
        by_kind["document" if raw.get("kind") == "document" else "source"] += 1
        started_at = _time(raw.get("started_at"))
        finished_at = _time(raw.get("finished_at"))
        if started_at is not None and (target := bucket(started_at)) is not None:
            target["started"] += 1
        if finished_at is not None:
            if started_at is not None:
                durations.append(_milliseconds(started_at, finished_at))
            if (target := bucket(finished_at)) is not None:
                target["completed" if status == "completed" else "failed"] += 1
    durations.sort()
    return {
        "window": window,
        "generated_at": now,
        "bucket_seconds": bucket_seconds,
        "totals": totals,
        "by_kind": by_kind,
        "buckets": buckets,
        "duration_ms": (
            {
                "p50": _percentile(durations, 0.5),
                "p95": _percentile(durations, 0.95),
                "max": durations[-1],
            }
            if durations
            else None
        ),
        "active": active,
    }


def direct_events(document: Item | None) -> list[dict[str, Any]]:
    """A direct run's timeline, read from the Document's Ingestion record."""

    resource = _direct_resource(document)
    assert document is not None
    record = document.metadata_.get("ingestion") or {}
    events: list[dict[str, Any]] = []
    add = _event_adder(events)
    add("queued", _time(resource["created_at"]))
    if resource["started_at"]:
        add("started", _time(resource["started_at"]), attempt=1)
    _add_phase_events(add, record.get("phases") or [])
    finished = _time(resource["finished_at"])
    if finished is not None:
        status = resource["status"]
        if status == "completed":
            indexed = resource["progress"]["indexed_count"]
            add("completed", finished, message=f"{indexed} chunk{'s' if indexed != 1 else ''} indexed")
        elif status == "cancelled":
            add("cancelled", finished, message="Cancelled before it finished.")
        elif status == "failed":
            add("failed", finished, message=resource["error"] or "The document could not be processed.")
    return _ordered(events)


def _event_adder(events: list[dict[str, Any]]) -> Any:
    def add(type_: str, at: datetime | None, **values: Any) -> None:
        if at is None:
            return
        events.append(
            {
                "type": type_,
                "at": at,
                "attempt": values.get("attempt"),
                "phase": values.get("phase"),
                "message": values.get("message"),
                "duration_ms": values.get("duration_ms"),
            }
        )

    return add


def _add_phase_events(add: Any, phases: Sequence[dict[str, Any]]) -> None:
    for phase in phases:
        started = _time(phase.get("started_at"))
        finished = _time(phase.get("finished_at"))
        add(
            "phase",
            started,
            phase=phase.get("phase"),
            message=_phase_message(phase),
            duration_ms=_milliseconds(started, finished) if started and finished else None,
        )


def _ordered(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    order = {"queued": 0, "retrying": 1, "started": 2, "phase": 3}
    events.sort(key=lambda event: (event["at"], order.get(event["type"], 4)))
    for index, event in enumerate(events):
        event["id"] = str(index)
    return events


def _progress(
    raw: dict[str, Any],
    *,
    status: str,
    heartbeat: dict[str, Any],
    phases: Sequence[dict[str, Any]],
) -> dict[str, Any] | None:
    if raw.get("progress"):
        # A source run answers its own progress query; its phase is "syncing".
        progress = dict(raw["progress"])
        if progress.get("phase") in {"running", None}:
            progress["phase"] = "syncing"
        return progress
    if status == "running" and raw.get("kind") == "source" and not heartbeat.get("phases"):
        return progress_from_phases([{"phase": "syncing"}], status="running")
    if status in {"pending", "running", "completed", "failed", "cancelled", "timed_out"}:
        return progress_from_phases(phases, status=status)
    return None


def _last_failure(history: Sequence[dict[str, Any]]) -> dict[str, Any] | None:
    for fact in reversed(history):
        if fact.get("failure") and fact["type"] in {"workflow_failed", "activity_failed"}:
            return fact["failure"]
    for fact in reversed(history):
        if fact["type"] in {"workflow_timed_out", "activity_timed_out"}:
            return {"timeout": True}
    return None


def _outcome_message(kind: str, result: Any) -> str | None:
    if not isinstance(result, dict):
        return None
    if kind == "document":
        if result.get("document_count"):
            count = int(result["document_count"])
            return f"{count} document{'s' if count != 1 else ''} extracted"
        if result.get("indexed_count"):
            count = int(result["indexed_count"])
            return f"{count} chunk{'s' if count != 1 else ''} indexed"
        return None
    processed = int(result.get("processed_count") or 0)
    indexed = int(result.get("indexed_count") or 0)
    return f"{processed} item{'s' if processed != 1 else ''} processed, {indexed} indexed"


def _phase_message(phase: dict[str, Any]) -> str | None:
    total = int(phase.get("total") or 0)
    if not total:
        return None
    done = int(phase.get("done") or 0)
    unit = "files" if phase.get("phase") == "expanding" else "chunks"
    return f"{done} of {total} {unit}"


def _percentile(values: Sequence[int], fraction: float) -> int:
    index = min(len(values) - 1, max(0, math.ceil(fraction * len(values)) - 1))
    return values[index]


def _milliseconds(start: datetime, end: datetime) -> int:
    return max(0, round((end - start).total_seconds() * 1000))


def _time(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    parsed = datetime.fromisoformat(str(value))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _text(value: UUID | None) -> str | None:
    return str(value) if value is not None else None


__all__ = [
    "IngestionService",
    "build_events",
    "build_summary",
    "ingestion_resource",
    "safe_failure_message",
]
