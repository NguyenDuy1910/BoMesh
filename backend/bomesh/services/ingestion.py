"""Ingestion Runs: the one way Documents are processed.

Adding data only registers Documents (``pending``) and stores their originals.
Processing happens when someone — a person, an API client, or a Source's
schedule — creates an Ingestion Run, and every trigger goes through one
method, :meth:`IngestionRunService.create_run`. A run snapshots its Documents
into ``ingestion_run_items`` when it is created, so later uploads never join
it, and starts one Temporal workflow that processes them in bounded batches.
Postgres holds every run and item state; Temporal only orchestrates.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from sqlalchemy import Select, and_, case, exists, func, literal, or_, select, update
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from config import IngestionRunConfig

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import (
    ExternalResource,
    IngestionRun,
    IngestionRunItem,
    IngestionSource,
    IntegrationConnection,
    Item,
    ItemUpload,
    User,
)
from bomesh.services import (
    COLLECTION_READ_PERMISSION,
    INGESTION_MANAGE_PERMISSION,
    INGESTION_READ_PERMISSION,
    INGESTION_RUN_PERMISSION,
    AuthContext,
    AuthorizationError,
    ControlPlaneConflictError,
    ControlPlaneExternalUnavailableError,
    ControlPlaneNotFoundError,
    DocumentNotFoundError,
    current_processing_version,
)
from bomesh.services.identity_access.authorization import AuthorizationService
from bomesh.services.item import ItemService
from bomesh.services.item_ingestion import INTERRUPTED_MESSAGE
from bomesh.services.workflow.service import TemporalWorkflowService

log = logging.getLogger(__name__)

TRIGGERS = frozenset({"manual", "api", "scheduled"})
DEFAULT_STATES = ("pending", "outdated")
SELECTABLE_STATES = frozenset({"pending", "failed", "outdated", "ready"})
ACTIVE_RUN_STATUSES = ("queued", "running")
ITEM_STATUSES = ("queued", "running", "succeeded", "failed", "skipped", "cancelled")
TERMINAL_ITEM_STATUSES = frozenset({"succeeded", "failed", "skipped", "cancelled"})
RETRYABLE_ITEM_STATUSES = ("failed", "cancelled", "skipped")
RUN_PHASES = frozenset(
    {"parsing", "contextualizing", "embedding", "storing", "downloading", "expanding"}
)

NOTHING_TO_PROCESS_MESSAGE = (
    "Nothing to process: the selected documents are already processed or being processed."
)
NOTHING_TO_RETRY_MESSAGE = (
    "Nothing to retry: no document in this run failed, was cancelled or was skipped."
)
START_FAILED_MESSAGE = "Processing could not be started. Try again in a moment."
STOPPED_MESSAGE = "Processing stopped unexpectedly."
SYNC_STOPPED_MESSAGE = "The sync stopped unexpectedly."
REMOVED_MESSAGE = "The document was removed before it was processed."
RUN_ENDED_MESSAGE = "The run ended before this document was processed."
#: An open run or sync older than this is checked against Temporal.
STALE_AFTER = timedelta(minutes=2)


class NothingToProcessError(ControlPlaneConflictError):
    """No selected Document is waiting: all are processed or in another run."""


class IngestionRunService:
    """Create, read, cancel and retry runs, and keep their state as they execute."""

    def __init__(
        self,
        session_factory: SessionFactory,
        *,
        workflows: TemporalWorkflowService,
        processing_signature: Callable[[], Mapping[str, Any]],
        run_config: IngestionRunConfig,
    ) -> None:
        self._session_factory = session_factory
        self._workflows = workflows
        self._processing_signature = processing_signature
        self._run_config = run_config

    # -- Creating ------------------------------------------------------------

    async def create_run(
        self,
        access: AuthContext | None,
        *,
        trigger: str,
        tenant_id: UUID | None = None,
        document_ids: Sequence[UUID] | None = None,
        collection_id: UUID | None = None,
        source_id: UUID | None = None,
        states: Sequence[str] | None = None,
        retry_of_run_id: UUID | None = None,
    ) -> dict[str, Any]:
        """Snapshot the selected Documents into a new run and start its workflow.

        The one entry for manual, API and scheduled processing. ``access`` is
        the person or client asking; only a scheduled run has none, and then
        ``tenant_id`` names the workspace. Selectors narrow each other:
        ``document_ids`` exactly (filtered by ``states`` only when given),
        ``collection_id`` its whole subtree, ``source_id`` the Source's
        Documents, none of them the workspace without personal Collections;
        ``states`` defaults to pending and outdated. Documents in another
        active run are left out.
        """

        if trigger not in TRIGGERS:
            raise ValueError("unsupported ingestion run trigger")
        if (access is None) != (trigger == "scheduled"):
            raise ValueError("only a scheduled run is created without an actor")
        if access is not None:
            if access.tenant_id is None:
                raise ControlPlaneNotFoundError("tenant context is required")
            tenant_id = access.tenant_id
        if tenant_id is None:
            raise ValueError("a scheduled run needs its workspace")
        requested_states = tuple(dict.fromkeys(states or ()))
        if not SELECTABLE_STATES.issuperset(requested_states):
            raise ValueError("unsupported processing state")
        explicit = tuple(dict.fromkeys(document_ids or ()))
        selected_states = requested_states or (() if explicit else DEFAULT_STATES)
        signature = dict(self._processing_signature())
        version = current_processing_version(signature)
        run_id = uuid4()

        async with transaction_scope(self._session_factory) as session:
            # Selection and snapshot are serialized per workspace, so two runs
            # created at once never take the same Document.
            await session.execute(select(func.pg_advisory_xact_lock(_tenant_lock_key(tenant_id))))
            selection = await self._selection(
                session,
                access,
                tenant_id=tenant_id,
                document_ids=explicit,
                collection_id=collection_id,
                source_id=source_id,
            )
            session.add(
                IngestionRun(
                    id=run_id,
                    tenant_id=tenant_id,
                    trigger_type=trigger,
                    scope={
                        "selected_documents": len(explicit) if explicit else None,
                        "collection_id": _text(collection_id),
                        "source_id": _text(source_id),
                        "states": list(selected_states),
                        "retry_of_run_id": _text(retry_of_run_id),
                    },
                    status="queued",
                    configuration=self._configuration(signature, version),
                    item_count=0,
                    created_by_user_id=access.user_id if access is not None else None,
                )
            )
            await session.flush()
            await session.execute(
                pg_insert(IngestionRunItem).from_select(
                    ["run_id", "item_id"],
                    select(literal(run_id, PG_UUID(as_uuid=True)), Item.id)
                    .select_from(Item)
                    .outerjoin(ItemUpload, ItemUpload.item_id == Item.id)
                    .where(
                        *selection,
                        *_candidate(tenant_id),
                        _state_filter(selected_states, version),
                    ),
                )
            )
            count = await _item_count(session, run_id)
            if count == 0:
                raise NothingToProcessError(NOTHING_TO_PROCESS_MESSAGE)
            await session.execute(
                update(IngestionRun).where(IngestionRun.id == run_id).values(item_count=count)
            )

        try:
            await self._workflows.start_run(run_id, tenant_id)
        except Exception as exc:  # noqa: BLE001 - any start failure is reported the same way
            log.warning("ingestion run workflow could not start run_id=%s", run_id, exc_info=exc)
            await self.finish(run_id, outcome="failed", error=START_FAILED_MESSAGE)
            raise ControlPlaneExternalUnavailableError(START_FAILED_MESSAGE) from exc
        async with transaction_scope(self._session_factory) as session:
            run = await session.get(IngestionRun, run_id)
            assert run is not None
            return (await self._resources(session, [run]))[0]

    async def retry_run(self, access: AuthContext, run_id: UUID) -> dict[str, Any]:
        """A new run over this run's failed, cancelled and skipped Documents."""

        tenant_id = _tenant(access)
        async with transaction_scope(self._session_factory) as session:
            run = await self._visible_run(session, access, run_id)
            governing = _governing_collections(
                select(IngestionRunItem.item_id).where(
                    IngestionRunItem.run_id == run.id,
                    IngestionRunItem.status.in_(RETRYABLE_ITEM_STATUSES),
                ),
                tenant_id=tenant_id,
            )
            readable = await AuthorizationService(session).allowed_collection_ids(
                access, permission=COLLECTION_READ_PERMISSION
            )
            document_ids = list(
                await session.scalars(
                    select(governing.c.document_id)
                    .where(governing.c.collection_id.in_(readable))
                    .order_by(governing.c.document_id)
                )
            )
        if not document_ids:
            raise NothingToProcessError(NOTHING_TO_RETRY_MESSAGE)
        return await self.create_run(
            access,
            trigger="manual",
            document_ids=document_ids,
            retry_of_run_id=run_id,
        )

    # -- Reading -------------------------------------------------------------

    async def list_runs(
        self,
        access: AuthContext,
        *,
        page: int = 1,
        page_size: int = 20,
        status: str | None = None,
        source_id: UUID | None = None,
        collection_id: UUID | None = None,
    ) -> dict[str, Any]:
        """Runs newest first: every workspace run with ``ingestion.read``, else one's own."""

        if page < 1 or not 1 <= page_size <= 100:
            raise ValueError("invalid page")
        conditions = self._visibility(access)
        if status is not None:
            conditions.append(IngestionRun.status == status)
        if source_id is not None:
            conditions.append(IngestionRun.scope["source_id"].astext == str(source_id))
        if collection_id is not None:
            conditions.append(IngestionRun.scope["collection_id"].astext == str(collection_id))
        async with transaction_scope(self._session_factory) as session:
            total = await session.scalar(
                select(func.count()).select_from(IngestionRun).where(*conditions)
            )
            runs = list(
                await session.scalars(
                    select(IngestionRun)
                    .where(*conditions)
                    .order_by(IngestionRun.created_at.desc(), IngestionRun.id.desc())
                    .limit(page_size)
                    .offset((page - 1) * page_size)
                )
            )
            items = await self._resources(session, runs)
        return {"items": items, "page": page, "page_size": page_size, "total": int(total or 0)}

    async def get_run(self, access: AuthContext, run_id: UUID) -> dict[str, Any]:
        async with transaction_scope(self._session_factory) as session:
            run = await self._visible_run(session, access, run_id)
            stale = run.status in ACTIVE_RUN_STATUSES and _is_stale(run.updated_at)
        if stale and await self._workflow_is_lost(run_id):
            await self._stop_lost_run(run_id)
        async with transaction_scope(self._session_factory) as session:
            run = await self._visible_run(session, access, run_id)
            return (await self._resources(session, [run]))[0]

    async def list_run_items(
        self,
        access: AuthContext,
        run_id: UUID,
        *,
        page: int = 1,
        page_size: int = 50,
        status: str | None = None,
    ) -> dict[str, Any]:
        """A run's Documents: running, failed, queued, then the rest; then by name.

        Documents in Collections the caller cannot read are left out.
        """

        if page < 1 or not 1 <= page_size <= 100:
            raise ValueError("invalid page")
        tenant_id = _tenant(access)
        async with transaction_scope(self._session_factory) as session:
            run = await self._visible_run(session, access, run_id)
            readable = await AuthorizationService(session).allowed_collection_ids(
                access, permission=COLLECTION_READ_PERMISSION
            )
            governing = _governing_collections(
                select(IngestionRunItem.item_id).where(IngestionRunItem.run_id == run.id),
                tenant_id=tenant_id,
                include_deleted=True,
            )
            conditions = [
                IngestionRunItem.run_id == run.id,
                governing.c.collection_id.in_(readable),
            ]
            if status is not None:
                conditions.append(IngestionRunItem.status == status)
            listed = (
                select(IngestionRunItem, Item.title, Item.metadata_, governing.c.collection_id)
                .join(Item, Item.id == IngestionRunItem.item_id)
                .join(governing, governing.c.document_id == IngestionRunItem.item_id)
                .where(*conditions)
            )
            total = await session.scalar(
                select(func.count()).select_from(listed.subquery())
            )
            rows = (
                await session.execute(
                    listed.order_by(
                        case(
                            (IngestionRunItem.status == "running", 0),
                            (IngestionRunItem.status == "failed", 1),
                            (IngestionRunItem.status == "queued", 2),
                            else_=3,
                        ),
                        func.lower(Item.title),
                        Item.id,
                    )
                    .limit(page_size)
                    .offset((page - 1) * page_size)
                )
            ).all()
        return {
            "items": [
                _item_resource(run_item, title, metadata, collection)
                for run_item, title, metadata, collection in rows
            ],
            "page": page,
            "page_size": page_size,
            "total": int(total or 0),
        }

    # -- Cancelling ----------------------------------------------------------

    async def cancel_run(self, access: AuthContext, run_id: UUID) -> dict[str, Any]:
        """Stop a run: its creator or ``ingestion.manage``; a finished run is a conflict.

        Documents not started are cancelled at once; the one each batch is
        processing stops and goes back to pending.
        """

        async with transaction_scope(self._session_factory) as session:
            run = await self._visible_run(session, access, run_id, for_update=True)
            if run.created_by_user_id != access.user_id and not access.has_permissions(
                INGESTION_MANAGE_PERMISSION
            ):
                raise AuthorizationError("ingestion.manage is required to cancel this run")
            if run.status not in ACTIVE_RUN_STATUSES:
                raise ControlPlaneConflictError("The run has already finished.")
            run.status = "cancelled"
            await session.execute(
                update(IngestionRunItem)
                .where(
                    IngestionRunItem.run_id == run.id,
                    IngestionRunItem.status == "queued",
                )
                .values(status="cancelled", finished_at=_now())
            )
        try:
            requested = await self._workflows.cancel_run(run_id)
        except Exception:  # noqa: BLE001 - the batches also stop on their own
            log.warning("ingestion run cancel request failed run_id=%s", run_id, exc_info=True)
            requested = True
        if not requested:
            await self.finish(run_id, outcome="cancelled")
        async with transaction_scope(self._session_factory) as session:
            run = await self._visible_run(session, access, run_id)
            return (await self._resources(session, [run]))[0]

    # -- Execution (called by the run's Activities) ---------------------------

    async def start(self, run_id: UUID) -> tuple[bool, int]:
        """Mark the run running; ``(still active, batches allowed at once)``."""

        async with transaction_scope(self._session_factory) as session:
            run = await session.get(IngestionRun, run_id, with_for_update=True)
            if run is None:
                return False, 1
            if run.status == "queued":
                run.status = "running"
                run.started_at = _now()
            parallelism = int(run.configuration.get("parallelism") or 1)
            return run.status == "running", max(1, parallelism)

    async def plan_batches(
        self, run_id: UUID, *, first_batch_number: int, max_batches: int
    ) -> list[tuple[int, list[UUID]]]:
        """The run's next batches, numbered from ``first_batch_number``.

        Idempotent: batches already planned at or after that number are
        returned as they are. Otherwise queued Documents not yet in a batch
        are packed, smallest first, up to the run's item and byte limits; a
        file larger than the byte limit is a batch of its own. Empty when
        nothing is left to plan or the run stopped.
        """

        if max_batches < 1:
            raise ValueError("max_batches must be positive")
        async with transaction_scope(self._session_factory) as session:
            run = await session.get(IngestionRun, run_id, with_for_update=True)
            if run is None or run.status != "running":
                return []
            planned = (
                await session.execute(
                    select(IngestionRunItem.batch_number, IngestionRunItem.item_id)
                    .join(Item, Item.id == IngestionRunItem.item_id)
                    .where(
                        IngestionRunItem.run_id == run_id,
                        IngestionRunItem.batch_number >= first_batch_number,
                    )
                    .order_by(
                        IngestionRunItem.batch_number,
                        func.coalesce(Item.size_bytes, 0),
                        IngestionRunItem.item_id,
                    )
                )
            ).all()
            if planned:
                existing: dict[int, list[UUID]] = {}
                for number, item_id in planned:
                    existing.setdefault(int(number), []).append(item_id)
                return sorted(existing.items())[:max_batches]

            max_items = int(run.configuration.get("batch_max_items") or 1)
            max_bytes = int(run.configuration.get("batch_max_bytes") or 1)
            unplanned = (
                await session.execute(
                    select(IngestionRunItem.item_id, func.coalesce(Item.size_bytes, 0))
                    .join(Item, Item.id == IngestionRunItem.item_id)
                    .where(
                        IngestionRunItem.run_id == run_id,
                        IngestionRunItem.batch_number.is_(None),
                        IngestionRunItem.status == "queued",
                    )
                    .order_by(func.coalesce(Item.size_bytes, 0), IngestionRunItem.item_id)
                    .limit(max_batches * max_items)
                )
            ).all()
            batches = _pack(unplanned, max_items=max_items, max_bytes=max_bytes, max_batches=max_batches)
            highest = await session.scalar(
                select(func.max(IngestionRunItem.batch_number)).where(
                    IngestionRunItem.run_id == run_id
                )
            )
            first = max(first_batch_number, -1 if highest is None else int(highest) + 1)
            numbered = [(first + offset, batch) for offset, batch in enumerate(batches)]
            for number, item_ids in numbered:
                await session.execute(
                    update(IngestionRunItem)
                    .where(
                        IngestionRunItem.run_id == run_id,
                        IngestionRunItem.item_id.in_(item_ids),
                    )
                    .values(batch_number=number)
                )
            return numbered

    async def claim_item(self, run_id: UUID, item_id: UUID) -> bool:
        """Start one Document of a running run; ``False`` when it must not be processed.

        A Document already finished in this run (a retried batch) is not
        processed again; one removed since the run was created is skipped.
        """

        async with transaction_scope(self._session_factory) as session:
            row = (
                await session.execute(
                    select(IngestionRunItem, IngestionRun.status, Item.status)
                    .join(IngestionRun, IngestionRun.id == IngestionRunItem.run_id)
                    .join(Item, Item.id == IngestionRunItem.item_id)
                    .where(
                        IngestionRunItem.run_id == run_id,
                        IngestionRunItem.item_id == item_id,
                    )
                    .with_for_update(of=IngestionRunItem)
                )
            ).first()
            if row is None:
                return False
            run_item, run_status, item_status = row
            if run_status != "running" or run_item.status in TERMINAL_ITEM_STATUSES:
                return False
            now = _now()
            if item_status == "deleted":
                run_item.status = "skipped"
                run_item.error = REMOVED_MESSAGE
                run_item.finished_at = now
                return False
            run_item.status = "running"
            run_item.started_at = now
            run_item.finished_at = None
            run_item.error = None
            run_item.chunk_count = None
            run_item.phases = []
            return True

    async def record_item_phases(
        self, run_id: UUID, item_id: UUID, phases: Sequence[Mapping[str, Any]]
    ) -> None:
        async with transaction_scope(self._session_factory) as session:
            await session.execute(
                update(IngestionRunItem)
                .where(
                    IngestionRunItem.run_id == run_id,
                    IngestionRunItem.item_id == item_id,
                    IngestionRunItem.status == "running",
                )
                .values(phases=[dict(phase) for phase in phases])
            )

    async def record_item_outcome(
        self,
        run_id: UUID,
        item_id: UUID,
        *,
        status: str,
        phases: Sequence[Mapping[str, Any]],
        error: str | None = None,
        chunk_count: int | None = None,
    ) -> None:
        """Finish one Document in the run: succeeded, failed, or cancelled.

        A cancelled Document was interrupted mid-processing and waits again.
        """

        if status not in {"succeeded", "failed", "cancelled"}:
            raise ValueError("unsupported run item outcome")
        async with transaction_scope(self._session_factory) as session:
            run_item = await session.get(
                IngestionRunItem, (run_id, item_id), with_for_update=True
            )
            if run_item is None:
                return
            run_item.status = status
            run_item.error = error
            run_item.chunk_count = chunk_count
            run_item.phases = [dict(phase) for phase in phases]
            run_item.finished_at = _now()
            if status == "cancelled":
                await _release_documents(session, [item_id], to="pending")

    async def append_items(self, run_id: UUID, item_ids: Sequence[UUID]) -> int:
        """Take Documents found while running (an archive's members) into the run.

        Only processable Documents no other active run holds join; the run's
        ``item_count`` follows. Returns how many joined.
        """

        if not item_ids:
            return 0
        async with transaction_scope(self._session_factory) as session:
            run = await session.get(IngestionRun, run_id, with_for_update=True)
            if run is None or run.status not in ACTIVE_RUN_STATUSES:
                return 0
            before = run.item_count
            await session.execute(
                pg_insert(IngestionRunItem)
                .from_select(
                    ["run_id", "item_id"],
                    select(literal(run_id, PG_UUID(as_uuid=True)), Item.id)
                    .select_from(Item)
                    .outerjoin(ItemUpload, ItemUpload.item_id == Item.id)
                    .where(Item.id.in_(list(item_ids)), *_candidate(run.tenant_id, run_id=run_id)),
                )
                .on_conflict_do_nothing()
            )
            run.item_count = await _item_count(session, run_id)
            return run.item_count - before

    async def fail_batch(self, run_id: UUID, batch_number: int) -> None:
        """A batch that kept failing: its unfinished Documents fail, the run goes on."""

        async with transaction_scope(self._session_factory) as session:
            unfinished = list(
                await session.scalars(
                    select(IngestionRunItem)
                    .where(
                        IngestionRunItem.run_id == run_id,
                        IngestionRunItem.batch_number == batch_number,
                        IngestionRunItem.status.in_(("queued", "running")),
                    )
                    .with_for_update()
                )
            )
            now = _now()
            interrupted = [
                run_item.item_id for run_item in unfinished if run_item.status == "running"
            ]
            for run_item in unfinished:
                run_item.status = "failed"
                run_item.error = INTERRUPTED_MESSAGE
                run_item.finished_at = now
            await _release_documents(session, interrupted, to="failed")

    async def finish(self, run_id: UUID, *, outcome: str, error: str | None = None) -> None:
        """Record how the run ended and settle every Document it did not finish.

        Idempotent, and never overrides a run already finished (a cancel that
        arrived first stays a cancel). Queued Documents are skipped (cancelled
        for a cancelled run); Documents interrupted mid-processing go back to
        pending.
        """

        if outcome not in {"completed", "failed", "cancelled"}:
            raise ValueError("unsupported run outcome")
        async with transaction_scope(self._session_factory) as session:
            run = await session.get(IngestionRun, run_id, with_for_update=True)
            if run is None:
                return
            if run.status in ACTIVE_RUN_STATUSES:
                run.status = outcome
                if outcome == "failed":
                    run.error = error or STOPPED_MESSAGE
            if run.finished_at is None:
                run.finished_at = _now()
            if run.status == "cancelled":
                await _settle_items(session, run_id, queued="cancelled", queued_error=None)
            elif run.status == "failed":
                await _settle_items(session, run_id, queued="skipped", queued_error=run.error)
            else:
                await _settle_items(
                    session, run_id, queued="skipped", queued_error=RUN_ENDED_MESSAGE
                )

    # -- Reconciliation --------------------------------------------------------

    async def reconcile(self) -> None:
        """Repair state a lost workflow left behind; safe to call any time.

        A run or sync still open in Postgres whose execution Temporal no longer
        has (or has closed) ends as failed; Documents left processing outside
        any active run wait again. Nothing is concluded while Temporal cannot
        be reached.
        """

        cutoff = _now() - STALE_AFTER
        async with transaction_scope(self._session_factory) as session:
            run_ids = list(
                await session.scalars(
                    select(IngestionRun.id).where(
                        IngestionRun.status.in_(ACTIVE_RUN_STATUSES),
                        IngestionRun.updated_at < cutoff,
                    )
                )
            )
            source_ids = list(
                await session.scalars(
                    select(IngestionSource.id).where(
                        IngestionSource.last_sync_status == "running",
                        IngestionSource.deleted_at.is_(None),
                        IngestionSource.updated_at < cutoff,
                    )
                )
            )
        try:
            for run_id in run_ids:
                if not await self._workflows.run_is_open(run_id):
                    await self._stop_lost_run(run_id)
            for source_id in source_ids:
                if not await self._workflows.source_sync_is_open(source_id):
                    await self._fail_lost_sync(source_id)
        except Exception:  # noqa: BLE001 - an unreachable Temporal proves nothing
            log.warning("ingestion reconciliation skipped: Temporal unavailable", exc_info=True)
            return
        async with transaction_scope(self._session_factory) as session:
            orphaned = list(
                await session.scalars(
                    select(Item.id).where(
                        Item.item_type == "document",
                        Item.index_status == "processing",
                        Item.status != "deleted",
                        Item.deleted_at.is_(None),
                        ~_in_active_run(Item.id),
                    )
                )
            )
            await _release_documents(session, orphaned, to="pending")

    # -- Internals ---------------------------------------------------------------

    def _configuration(self, signature: Mapping[str, Any], version: str) -> dict[str, Any]:
        config = self._run_config
        return {
            "processing_version": version,
            "embedding_model": signature.get("embedding_model"),
            "contextualization_model": (
                signature.get("contextualization_model")
                if signature.get("contextualization_enabled")
                else None
            ),
            "batch_max_items": config.batch_max_items,
            "batch_max_bytes": config.batch_max_bytes,
            "parallelism": config.parallelism,
        }

    async def _selection(
        self,
        session: AsyncSession,
        access: AuthContext | None,
        *,
        tenant_id: UUID,
        document_ids: tuple[UUID, ...],
        collection_id: UUID | None,
        source_id: UUID | None,
    ) -> list[Any]:
        """The conditions naming the Documents a run may take; raises 404/403 first."""

        authorization = AuthorizationService(session)
        if access is None:
            runnable = set(
                await session.scalars(
                    select(Item.id).where(*_active_collections(tenant_id))
                )
            )
            readable = runnable
        else:
            runnable = set(
                await authorization.allowed_collection_ids(
                    access, permission=INGESTION_RUN_PERMISSION
                )
            )
            readable = set(
                await authorization.allowed_collection_ids(
                    access, permission=COLLECTION_READ_PERMISSION
                )
            )
            if not runnable:
                raise AuthorizationError("ingestion.run is required to process documents")

        conditions: list[Any] = []
        if document_ids:
            governing = _governing_collections(document_ids, tenant_id=tenant_id)
            found = dict(
                (
                    await session.execute(
                        select(governing.c.document_id, governing.c.collection_id)
                    )
                ).all()
            )
            for document_id in document_ids:
                if found.get(document_id) not in readable:
                    raise DocumentNotFoundError(f"document not found: {document_id}")
            if any(found[document_id] not in runnable for document_id in document_ids):
                raise AuthorizationError("ingestion.run is required for this Collection")
            conditions.append(Item.id.in_(document_ids))

        if collection_id is not None:
            if collection_id not in readable:
                raise ControlPlaneNotFoundError(f"collection not found: {collection_id}")
            if collection_id not in runnable:
                raise AuthorizationError("ingestion.run is required for this Collection")
            roots = runnable & set(await _collection_tree(session, collection_id))
            conditions.append(Item.id.in_(_documents_under(roots, tenant_id=tenant_id)))
        elif not document_ids:
            roots = runnable
            if source_id is None:
                # The workspace: personal system Collections are their owners' own.
                roots = roots - set(
                    await session.scalars(
                        select(Item.id).where(
                            *_active_collections(tenant_id),
                            Item.metadata_.has_key("system_kind"),
                        )
                    )
                )
            conditions.append(Item.id.in_(_documents_under(roots, tenant_id=tenant_id)))

        if source_id is not None:
            source = await session.scalar(
                select(IngestionSource.id)
                .join(
                    IntegrationConnection,
                    IntegrationConnection.id == IngestionSource.integration_connection_id,
                )
                .where(
                    IngestionSource.id == source_id,
                    IngestionSource.deleted_at.is_(None),
                    IntegrationConnection.tenant_id == tenant_id,
                )
            )
            if source is None:
                raise ControlPlaneNotFoundError(f"source not found: {source_id}")
            conditions.append(
                Item.id.in_(
                    select(ExternalResource.item_id).where(
                        ExternalResource.ingestion_source_id == source_id,
                        ExternalResource.deleted_at.is_(None),
                    )
                )
            )
        return conditions

    def _visibility(self, access: AuthContext) -> list[Any]:
        conditions: list[Any] = [IngestionRun.tenant_id == _tenant(access)]
        if not access.has_permissions(INGESTION_READ_PERMISSION):
            if access.user_id is None:
                conditions.append(literal(False))
            else:
                conditions.append(IngestionRun.created_by_user_id == access.user_id)
        return conditions

    async def _visible_run(
        self,
        session: AsyncSession,
        access: AuthContext,
        run_id: UUID,
        *,
        for_update: bool = False,
    ) -> IngestionRun:
        statement = select(IngestionRun).where(
            IngestionRun.id == run_id, *self._visibility(access)
        )
        if for_update:
            statement = statement.with_for_update()
        run = await session.scalar(statement)
        if run is None:
            raise ControlPlaneNotFoundError(f"ingestion run not found: {run_id}")
        return run

    async def _resources(
        self, session: AsyncSession, runs: Sequence[IngestionRun]
    ) -> list[dict[str, Any]]:
        if not runs:
            return []
        counts: dict[UUID, dict[str, int]] = {}
        for run_id, status, count in (
            await session.execute(
                select(IngestionRunItem.run_id, IngestionRunItem.status, func.count())
                .where(IngestionRunItem.run_id.in_([run.id for run in runs]))
                .group_by(IngestionRunItem.run_id, IngestionRunItem.status)
            )
        ).all():
            counts.setdefault(run_id, {})[status] = int(count)
        creator_ids = {run.created_by_user_id for run in runs if run.created_by_user_id}
        creators = {
            user.id: user
            for user in await session.scalars(select(User).where(User.id.in_(creator_ids)))
        } if creator_ids else {}
        return [
            _run_resource(run, counts.get(run.id, {}), creators.get(run.created_by_user_id))
            for run in runs
        ]

    async def _workflow_is_lost(self, run_id: UUID) -> bool:
        try:
            return not await self._workflows.run_is_open(run_id)
        except Exception:  # noqa: BLE001 - an unreachable Temporal proves nothing
            log.warning("ingestion run state check failed run_id=%s", run_id, exc_info=True)
            return False

    async def _stop_lost_run(self, run_id: UUID) -> None:
        """A run whose workflow is gone: failed, and nothing it held stays waiting on it."""

        async with transaction_scope(self._session_factory) as session:
            run = await session.get(IngestionRun, run_id, with_for_update=True)
            if run is None or run.status not in ACTIVE_RUN_STATUSES:
                return
            run.status = "failed"
            run.error = STOPPED_MESSAGE
            run.finished_at = run.finished_at or _now()
            await _settle_items(session, run_id, queued="cancelled", queued_error=None)
        log.warning("ingestion run stopped without its workflow run_id=%s", run_id)

    async def _fail_lost_sync(self, source_id: UUID) -> None:
        async with transaction_scope(self._session_factory) as session:
            await session.execute(
                update(IngestionSource)
                .where(
                    IngestionSource.id == source_id,
                    IngestionSource.last_sync_status == "running",
                )
                .values(last_sync_status="failed", last_sync_error=SYNC_STOPPED_MESSAGE)
            )
        log.warning("source sync stopped without its workflow source_id=%s", source_id)


# -- Selection (SQL) -------------------------------------------------------------


def _active_collections(tenant_id: UUID) -> tuple[Any, ...]:
    return (
        Item.tenant_id == tenant_id,
        Item.item_type == "collection",
        Item.status != "deleted",
        Item.deleted_at.is_(None),
    )


def _in_active_run(item_id: Any, *, except_run_id: UUID | None = None) -> Any:
    """Whether a Document is queued or running in a queued or running run."""

    conditions = [
        IngestionRunItem.item_id == item_id,
        IngestionRunItem.status.in_(ACTIVE_RUN_STATUSES),
        IngestionRun.status.in_(ACTIVE_RUN_STATUSES),
    ]
    if except_run_id is not None:
        conditions.append(IngestionRunItem.run_id != except_run_id)
    return exists(
        select(IngestionRunItem.item_id)
        .join(IngestionRun, IngestionRun.id == IngestionRunItem.run_id)
        .where(*conditions)
    )


def _candidate(tenant_id: UUID, *, run_id: UUID | None = None) -> tuple[Any, ...]:
    """A processable Document with its original stored, not held by another active run.

    Expects ``ItemUpload`` outer-joined: an upload's bytes must have arrived;
    a connector Item has its original from the sync that registered it.
    """

    return (
        Item.tenant_id == tenant_id,
        Item.item_type == "document",
        Item.status != "deleted",
        Item.deleted_at.is_(None),
        Item.index_status != "unsupported",
        or_(
            ItemUpload.status == "available",
            and_(ItemUpload.item_id.is_(None), Item.storage_key.is_not(None)),
        ),
        ~_in_active_run(Item.id, except_run_id=run_id),
    )


def _state_filter(states: Sequence[str], version: str) -> Any:
    if not states:
        return literal(True)
    predicates = {
        "pending": Item.index_status == "pending",
        "failed": Item.index_status == "failed",
        "ready": and_(Item.index_status == "ready", Item.processed_version == version),
        "outdated": and_(
            Item.index_status == "ready", Item.processed_version.is_distinct_from(version)
        ),
    }
    return or_(*(predicates[state] for state in states))


def _documents_under(roots: set[UUID], *, tenant_id: UUID) -> Select[Any]:
    """Every Document whose governing Collection is one of ``roots``.

    Connector Documents can sit under other Documents (a page's attachments),
    so the walk descends through Documents, never into another Collection.
    """

    documents = (
        select(Item.id.label("item_id"))
        .where(
            Item.tenant_id == tenant_id,
            Item.item_type == "document",
            Item.parent_item_id.in_(list(roots)),
        )
        .cte("run_scope_documents", recursive=True)
    )
    child = aliased(Item)
    documents = documents.union_all(
        select(child.id).join(documents, child.parent_item_id == documents.c.item_id).where(
            child.item_type == "document"
        )
    )
    return select(documents.c.item_id)


def _governing_collections(
    document_ids: Sequence[UUID] | Select[Any],
    *,
    tenant_id: UUID,
    include_deleted: bool = False,
) -> Any:
    """``(document_id, collection_id)``: each Document's nearest Collection."""

    conditions = [
        Item.id.in_(document_ids),
        Item.tenant_id == tenant_id,
        Item.item_type == "document",
    ]
    if not include_deleted:
        conditions += [Item.status != "deleted", Item.deleted_at.is_(None)]
    climb = (
        select(Item.id.label("document_id"), Item.parent_item_id.label("parent_id"))
        .where(*conditions)
        .cte("governing_climb", recursive=True)
    )
    parent = aliased(Item)
    climb = climb.union_all(
        select(climb.c.document_id, parent.parent_item_id)
        .join(parent, parent.id == climb.c.parent_id)
        .where(parent.item_type == "document")
    )
    collection = aliased(Item)
    return (
        select(climb.c.document_id, collection.id.label("collection_id"))
        .join(collection, collection.id == climb.c.parent_id)
        .where(collection.item_type == "collection")
        .subquery("governing")
    )


async def _collection_tree(session: AsyncSession, collection_id: UUID) -> list[UUID]:
    tree = (
        select(Item.id.label("item_id"))
        .where(Item.id == collection_id, Item.item_type == "collection")
        .cte("collection_tree", recursive=True)
    )
    child = aliased(Item)
    tree = tree.union_all(
        select(child.id)
        .join(tree, child.parent_item_id == tree.c.item_id)
        .where(
            child.item_type == "collection",
            child.status != "deleted",
            child.deleted_at.is_(None),
        )
    )
    return list(await session.scalars(select(tree.c.item_id)))


def _pack(
    candidates: Sequence[Any], *, max_items: int, max_bytes: int, max_batches: int
) -> list[list[UUID]]:
    """Greedy next-fit packing of ``(item_id, size)`` in order."""

    batches: list[list[UUID]] = []
    current: list[UUID] = []
    current_bytes = 0
    for item_id, size in candidates:
        if current and (len(current) >= max_items or current_bytes + int(size) > max_bytes):
            batches.append(current)
            current, current_bytes = [], 0
            if len(batches) == max_batches:
                break
        current.append(item_id)
        current_bytes += int(size)
    if current and len(batches) < max_batches:
        batches.append(current)
    return batches


# -- State transitions (SQL) -------------------------------------------------------


async def _item_count(session: AsyncSession, run_id: UUID) -> int:
    return int(
        await session.scalar(
            select(func.count())
            .select_from(IngestionRunItem)
            .where(IngestionRunItem.run_id == run_id)
        )
        or 0
    )


async def _settle_items(
    session: AsyncSession, run_id: UUID, *, queued: str, queued_error: str | None
) -> None:
    """Finish a stopped run's leftovers; interrupted Documents wait again."""

    now = _now()
    interrupted = list(
        await session.scalars(
            select(IngestionRunItem.item_id).where(
                IngestionRunItem.run_id == run_id, IngestionRunItem.status == "running"
            )
        )
    )
    await session.execute(
        update(IngestionRunItem)
        .where(IngestionRunItem.run_id == run_id, IngestionRunItem.status == "queued")
        .values(status=queued, error=queued_error, finished_at=now)
    )
    await session.execute(
        update(IngestionRunItem)
        .where(IngestionRunItem.run_id == run_id, IngestionRunItem.status == "running")
        .values(
            status="cancelled" if queued == "cancelled" else "failed",
            error=None if queued == "cancelled" else INTERRUPTED_MESSAGE,
            finished_at=now,
        )
    )
    await _release_documents(session, interrupted, to="pending")


async def _release_documents(session: AsyncSession, item_ids: Sequence[UUID], *, to: str) -> None:
    """Move Documents a run left ``processing`` to ``pending`` or ``failed``."""

    if not item_ids:
        return
    processing = list(
        await session.scalars(
            select(Item.id).where(
                Item.id.in_(list(item_ids)),
                Item.index_status == "processing",
                Item.status != "deleted",
            )
        )
    )
    items = ItemService(session)
    for item_id in processing:
        if to == "pending":
            await items.mark_index_pending(item_id)
        else:
            await items.mark_index_failed(item_id)


# -- Shaping -------------------------------------------------------------------------


def _run_resource(
    run: IngestionRun, counts: Mapping[str, int], creator: User | None
) -> dict[str, Any]:
    scope = run.scope or {}
    return {
        "id": run.id,
        "status": run.status,
        "trigger": run.trigger_type,
        "scope": {
            "selected_documents": scope.get("selected_documents"),
            "collection_id": scope.get("collection_id"),
            "source_id": scope.get("source_id"),
            "states": list(scope.get("states") or []),
            "retry_of_run_id": scope.get("retry_of_run_id"),
        },
        "counts": {
            "total": run.item_count,
            **{status: counts.get(status, 0) for status in ITEM_STATUSES},
        },
        "error": run.error,
        "created_by": (
            {"id": creator.id, "email": creator.email, "display_name": creator.display_name}
            if creator is not None
            else None
        ),
        "configuration": dict(run.configuration or {}),
        "created_at": run.created_at,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
        "updated_at": run.updated_at,
    }


def _item_resource(
    run_item: IngestionRunItem,
    title: str,
    metadata: Mapping[str, Any],
    collection_id: UUID | None,
) -> dict[str, Any]:
    phases = [
        dict(phase)
        for phase in run_item.phases or []
        if isinstance(phase, Mapping) and phase.get("phase") in RUN_PHASES
    ]
    return {
        "document_id": run_item.item_id,
        "name": str(metadata.get("file_name") or title),
        "collection_id": collection_id,
        "status": run_item.status,
        "phase": phases[-1]["phase"] if phases else None,
        "error": run_item.error,
        "chunk_count": run_item.chunk_count,
        "phases": phases,
        "started_at": run_item.started_at,
        "finished_at": run_item.finished_at,
    }


def _tenant(access: AuthContext) -> UUID:
    if access.tenant_id is None:
        raise ControlPlaneNotFoundError("tenant context is required")
    return access.tenant_id


def _tenant_lock_key(tenant_id: UUID) -> int:
    digest = uuid5(NAMESPACE_URL, f"bomesh:ingestion-run-selection:{tenant_id}")
    return int.from_bytes(digest.bytes[:8], byteorder="big", signed=True)


def _is_stale(updated_at: datetime | None) -> bool:
    return updated_at is None or updated_at < _now() - STALE_AFTER


def _now() -> datetime:
    return datetime.now(UTC)


def _text(value: UUID | None) -> str | None:
    return str(value) if value is not None else None


__all__ = [
    "DEFAULT_STATES",
    "NOTHING_TO_PROCESS_MESSAGE",
    "IngestionRunService",
    "NothingToProcessError",
]
