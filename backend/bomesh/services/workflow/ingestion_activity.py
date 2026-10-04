"""Side-effecting Temporal Activities of Ingestion Runs and Source syncs.

They only orchestrate the services that own each step: ``IngestionRunService``
keeps run and item state, ``ItemIngestionService`` processes one Document,
``ArchiveExpansionService`` turns an archive into Documents, and
``SourceSyncService`` syncs a Source's inventory.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from contextlib import suppress
from typing import Any
from uuid import UUID

import httpx
from temporalio import activity
from temporalio.exceptions import ApplicationError

from bomesh.document_index import EmbeddingRejectedError
from bomesh.services import (
    ConnectionAuthorizationRequiredError,
    ControlPlaneNotFoundError,
    ControlPlaneValidationError,
    DocumentNotFoundError,
    DocumentProcessingError,
    InvalidDocumentStateError,
)
from bomesh.services.archive_expansion import ArchiveExpansionService
from bomesh.services.ingestion import IngestionRunService, NothingToProcessError
from bomesh.services.item_ingestion import ItemIngestionService, PhaseRecorder, failure_message
from bomesh.services.source_sync import SourceSyncService
from bomesh.services.workflow import (
    CREATE_SCHEDULED_RUN_ACTIVITY,
    FAIL_BATCH_ACTIVITY,
    FINISH_RUN_ACTIVITY,
    PLAN_BATCHES_ACTIVITY,
    PROCESS_BATCH_ACTIVITY,
    PROVIDER_REJECTED_FAILURE_TYPE,
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
#: Sync failures retrying cannot fix: configuration, identity, or a removed Source.
_PERMANENT_SYNC_ERRORS = (
    ConnectionAuthorizationRequiredError,
    ControlPlaneNotFoundError,
    ControlPlaneValidationError,
    InvalidDocumentStateError,
    PermissionError,
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
                run_id, item_id, status="failed", error=message, phases=recorder.close()
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
        await self._runs.finish(UUID(input.run_id), outcome=input.outcome, error=input.error)


class SourceSyncActivities:
    """The Activities of ``SourceSyncWorkflow``."""

    def __init__(self, *, sync: SourceSyncService, runs: IngestionRunService) -> None:
        self._sync = sync
        self._runs = runs

    @activity.defn(name=SYNC_SOURCE_ACTIVITY)
    async def sync_source(self, input: SourceSyncInput) -> None:
        heartbeat = asyncio.create_task(_heartbeat(lambda: {"phase": "syncing"}))
        try:
            await self._sync.sync(UUID(input.source_id))
        except httpx.HTTPStatusError as exc:
            raise ApplicationError(
                str(exc),
                type="ConnectorHTTPError",
                non_retryable=exc.response.status_code in {400, 401, 403, 404, 422},
            ) from exc
        except _PERMANENT_SYNC_ERRORS as exc:
            raise ApplicationError(str(exc), type=type(exc).__name__, non_retryable=True) from exc
        finally:
            await _stop(heartbeat)

    @activity.defn(name=CREATE_SCHEDULED_RUN_ACTIVITY)
    async def create_scheduled_run(self, input: SourceSyncInput) -> str | None:
        """Process what the scheduled sync left pending; nothing pending is not an error."""

        try:
            run = await self._runs.create_run(
                None,
                trigger="scheduled",
                tenant_id=UUID(input.tenant_id),
                source_id=UUID(input.source_id),
                states=["pending", "outdated"],
            )
        except NothingToProcessError:
            return None
        return str(run["id"])


async def _heartbeat(details: Callable[[], Any]) -> None:
    while True:
        activity.heartbeat(details())
        await asyncio.sleep(_HEARTBEAT_SECONDS)


async def _stop(task: asyncio.Task[None]) -> None:
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


__all__ = ["IngestionRunActivities", "SourceSyncActivities"]
