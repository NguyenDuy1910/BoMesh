"""Side-effecting Temporal Activities of Ingestion Runs, Source syncs and index upkeep.

They only orchestrate the services that own each step: ``IngestionRunService``
keeps run and item state, ``ItemIngestionService`` processes one Document,
``ArchiveExpansionService`` turns an archive into Documents,
``SourceSyncService`` syncs a Source's inventory, and the index-upkeep jobs
(re-applying dirty payloads, purging deleted Items) belong to KnowledgeItems.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from contextlib import suppress
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from temporalio import activity
from temporalio.exceptions import ApplicationError

from bomesh.document_index import EmbeddingRejectedError, ItemIndex
from bomesh.errors import StatusCode
from bomesh.services import (
    DocumentNotFoundError,
    DocumentProcessingError,
    DocumentUnavailableError,
    InvalidDocumentStateError,
)
from bomesh.services.ingestion.run_engine import (
    CONTENT_UNAVAILABLE,
    INTERNAL,
    PROVIDER_REFUSED,
    UNSUPPORTED_FORMAT,
    IngestionRunService,
)
from bomesh.services.ingestion.source_sync import SourceSyncService
from bomesh.services.knowledge_items.archive_expansion import ArchiveExpansionService
from bomesh.services.knowledge_items.indexing import (
    ItemIngestionService,
    PhaseRecorder,
    failure_message,
    reconcile_dirty_payloads,
)
from bomesh.services.knowledge_items.purge import purge_deleted_items
from bomesh.services.workflow import (
    BEGIN_SCHEDULED_SYNC_ACTIVITY,
    CREATE_SCHEDULED_RUN_ACTIVITY,
    DELETED_ITEM_PURGE_LIMIT,
    FAIL_BATCH_ACTIVITY,
    FINISH_RUN_ACTIVITY,
    PAYLOAD_RECONCILIATION_LIMIT,
    PLAN_BATCHES_ACTIVITY,
    PROCESS_BATCH_ACTIVITY,
    PROVIDER_REJECTED_FAILURE_TYPE,
    PURGE_DELETED_ITEMS_ACTIVITY,
    RECONCILE_PAYLOADS_ACTIVITY,
    START_RUN_ACTIVITY,
    SYNC_SOURCE_ACTIVITY,
    FailBatchInput,
    FinishRunInput,
    PlanBatchesInput,
    ProcessBatchInput,
    RunBatch,
    RunStart,
    SourceSyncInput,
)
from bomesh.storage import DocumentStorage

log = logging.getLogger(__name__)

#: How often a running Activity repeats its heartbeat (the SDK throttles the
#: rest); a phase can run long without reporting.
_HEARTBEAT_SECONDS = 1.0
#: How often a Document's phases in flight are written to its run item.
_PHASE_PERSIST_SECONDS = 2.0
#: Errors a Document's content causes; retrying cannot change them.
_DOCUMENT_ERRORS = (
    DocumentProcessingError,
    DocumentNotFoundError,
    InvalidDocumentStateError,
    ValueError,
)


class IngestionRunActivities:
    """The Activities of ``IngestionRunWorkflow``."""

    def __init__(
        self,
        *,
        runs: IngestionRunService,
        ingestion: ItemIngestionService,
        archives: ArchiveExpansionService,
    ) -> None:
        self._runs = runs
        self._ingestion = ingestion
        self._archives = archives

    @activity.defn(name=START_RUN_ACTIVITY)
    async def start_run(self, run_id: str) -> RunStart:
        active, parallelism = await self._runs.start(UUID(run_id))
        return RunStart(active=active, parallelism=parallelism)

    @activity.defn(name=PLAN_BATCHES_ACTIVITY)
    async def plan_batches(self, input: PlanBatchesInput) -> list[RunBatch]:
        planned = await self._runs.plan_batches(
            UUID(input.run_id),
            first_batch_number=input.first_batch_number,
            max_batches=input.max_batches,
        )
        return [
            RunBatch(number=number, item_ids=[str(item_id) for item_id in item_ids])
            for number, item_ids in planned
        ]

    @activity.defn(name=PROCESS_BATCH_ACTIVITY)
    async def process_batch(self, input: ProcessBatchInput) -> None:
        """Process a batch's Documents one after another.

        A Document's own failure is recorded on it and the batch goes on. An
        infrastructure failure raises so Temporal retries the batch; Documents
        it already finished are not processed again. A provider refusal fails
        that Document and stops the run.
        """

        run_id = UUID(input.run_id)
        tenant_id = UUID(input.tenant_id)
        current: dict[str, Any] = {"item": None, "recorder": None}
        heartbeat = asyncio.create_task(
            _heartbeat(
                lambda: {
                    "batch": input.batch_number,
                    "item": current["item"],
                    **(current["recorder"].snapshot() if current["recorder"] else {}),
                }
            )
        )
        try:
            for raw_item_id in input.item_ids:
                item_id = UUID(raw_item_id)
                if not await self._runs.claim_item(run_id, item_id):
                    continue
                recorder = PhaseRecorder()
                current.update(item=raw_item_id, recorder=recorder)
                await self._process_item(run_id, tenant_id, item_id, recorder)
        finally:
            await _stop(heartbeat)

    async def _process_item(
        self, run_id: UUID, tenant_id: UUID, item_id: UUID, recorder: PhaseRecorder
    ) -> None:
        persisting = asyncio.create_task(self._persist_phases(run_id, item_id, recorder))
        try:
            chunk_count = await self._process(run_id, tenant_id, item_id, recorder)
        except asyncio.CancelledError:
            await _stop(persisting)
            await self._runs.record_item_outcome(
                run_id, item_id, status="cancelled", phases=recorder.close()
            )
            raise
        except EmbeddingRejectedError as exc:
            await _stop(persisting)
            message = failure_message(exc)
            log.warning(
                "model provider refused processing run_id=%s document_id=%s: %s",
                run_id,
                item_id,
                exc,
            )
            await self._runs.record_item_outcome(
                run_id,
                item_id,
                status="failed",
                error=message,
                error_class=PROVIDER_REFUSED,
                phases=recorder.close(),
            )
            # Every other Document would be refused the same way: stop the run.
            raise ApplicationError(
                message, type=PROVIDER_REJECTED_FAILURE_TYPE, non_retryable=True
            ) from None
        except _DOCUMENT_ERRORS as exc:
            await _stop(persisting)
            log.info("document processing failed run_id=%s document_id=%s", run_id, item_id)
            await self._runs.record_item_outcome(
                run_id,
                item_id,
                status="failed",
                error=failure_message(exc),
                error_class=_error_class(exc),
                phases=recorder.close(),
            )
            return
        except Exception:
            await _stop(persisting)
            # Infrastructure: the run item stays running so the retry takes it again.
            with suppress(Exception):
                await self._runs.record_item_phases(run_id, item_id, recorder.close())
            log.exception("document processing interrupted run_id=%s document_id=%s", run_id, item_id)
            raise
        await _stop(persisting)
        await self._runs.record_item_outcome(
            run_id,
            item_id,
            status="succeeded",
            chunk_count=chunk_count,
            phases=recorder.close(completed=True),
        )

    async def _process(
        self, run_id: UUID, tenant_id: UUID, item_id: UUID, recorder: PhaseRecorder
    ) -> int | None:
        expanded = await self._archives.expand_if_archive(
            item_id,
            tenant_id=tenant_id,
            processed_version=self._ingestion.processing_version(),
            progress=recorder,
        )
        if expanded is not None:
            # The members are this run's Documents now; the archive is done.
            await self._runs.append_items(run_id, expanded.document_ids)
            return None
        return await self._ingestion.process_document(
            item_id, tenant_id=tenant_id, progress=recorder
        )

    async def _persist_phases(
        self, run_id: UUID, item_id: UUID, recorder: PhaseRecorder
    ) -> None:
        seen = recorder.version
        while True:
            await asyncio.sleep(_PHASE_PERSIST_SECONDS)
            if recorder.version != seen:
                seen = recorder.version
                with suppress(Exception):
                    await self._runs.record_item_phases(run_id, item_id, recorder.phases)

    @activity.defn(name=FAIL_BATCH_ACTIVITY)
    async def fail_batch(self, input: FailBatchInput) -> None:
        await self._runs.fail_batch(UUID(input.run_id), input.batch_number)

    @activity.defn(name=FINISH_RUN_ACTIVITY)
    async def finish_run(self, input: FinishRunInput) -> None:
        # The only reason a run stops on its own is the model provider refusing it.
        error = (
            {"code": int(StatusCode.FAILED_PRECONDITION), "message": input.error}
            if input.error is not None
            else None
        )
        await self._runs.finish(UUID(input.run_id), outcome=input.outcome, error=error)


class SourceSyncActivities:
    """The Activities of ``SourceSyncWorkflow``."""

    def __init__(self, *, sync: SourceSyncService, runs: IngestionRunService) -> None:
        self._sync = sync
        self._runs = runs

    @activity.defn(name=BEGIN_SCHEDULED_SYNC_ACTIVITY)
    async def begin_scheduled_sync(self, input: SourceSyncInput) -> str | None:
        """Open the firing's RUNNING sync row; ``None`` skips the firing."""
        sync_id = await self._sync.begin_scheduled_sync(UUID(input.source_id))
        return str(sync_id) if sync_id is not None else None

    @activity.defn(name=SYNC_SOURCE_ACTIVITY)
    async def sync_source(self, input: SourceSyncInput) -> None:
        """Run the sync row; a failure is already recorded on it, so it is not retried."""
        if input.sync_id is None:
            raise ApplicationError("a sync needs its sync row", non_retryable=True)
        heartbeat = asyncio.create_task(_heartbeat(lambda: {"phase": "syncing"}))
        try:
            await self._sync.sync(UUID(input.sync_id))
        except Exception as exc:
            raise ApplicationError(str(exc), type=type(exc).__name__, non_retryable=True) from exc
        finally:
            await _stop(heartbeat)

    @activity.defn(name=CREATE_SCHEDULED_RUN_ACTIVITY)
    async def create_scheduled_run(self, input: SourceSyncInput) -> str | None:
        """Process what the scheduled sync left pending; nothing pending is not an error."""

        run_id = await self._runs.create_scheduled_run(
            UUID(input.tenant_id), UUID(input.source_id)
        )
        return str(run_id) if run_id is not None else None


class MaintenanceActivities:
    """The index-upkeep Activities ``MaintenanceWorkflow`` runs on a Schedule.

    Each runs one bounded pass and returns how many Items it handled.
    """

    def __init__(
        self,
        sessions: async_sessionmaker[AsyncSession],
        *,
        index: ItemIndex,
        storage: DocumentStorage,
    ) -> None:
        self._sessions = sessions
        self._index = index
        self._storage = storage

    @activity.defn(name=RECONCILE_PAYLOADS_ACTIVITY)
    async def reconcile_payloads(self) -> int:
        """Re-apply the index payloads of Items changed since they were indexed."""
        return await reconcile_dirty_payloads(
            self._sessions, self._index, limit=PAYLOAD_RECONCILIATION_LIMIT
        )

    @activity.defn(name=PURGE_DELETED_ITEMS_ACTIVITY)
    async def purge_deleted_items(self) -> int:
        """Purge Items deleted beyond their retention (points, revisions, unshared objects)."""
        return await purge_deleted_items(
            self._sessions, self._index, self._storage, limit=DELETED_ITEM_PURGE_LIMIT
        )


def _error_class(exc: BaseException) -> str:
    """The provider-neutral ``errorClass`` of a Document's own failure."""

    if isinstance(exc, (DocumentUnavailableError, DocumentNotFoundError, InvalidDocumentStateError)):
        return CONTENT_UNAVAILABLE
    if isinstance(exc, DocumentProcessingError):
        return UNSUPPORTED_FORMAT
    return INTERNAL


async def _heartbeat(details: Callable[[], Any]) -> None:
    while True:
        activity.heartbeat(details())
        await asyncio.sleep(_HEARTBEAT_SECONDS)


async def _stop(task: asyncio.Task[None]) -> None:
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


__all__ = [
    "IngestionRunActivities",
    "MaintenanceActivities",
    "SourceSyncActivities",
]
