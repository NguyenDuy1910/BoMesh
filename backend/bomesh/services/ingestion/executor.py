"""Execute one Ingestion Run inside the ingestion worker.

The worker runs a :class:`RunExecutor` while it holds the run's advisory lock.
It plans size-packed batches, runs a bounded number of them at once and
processes each batch's Documents one after another. PostgreSQL holds every
run and task state (:class:`IngestionRunService`); ``ItemIngestionService``
processes one Document and ``ArchiveExpansionService`` turns an archive into
Documents. A Document's own failure fails only that Document; an
infrastructure failure retries its batch here, then fails what the batch did
not finish; a model provider refusal stops the run.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from dataclasses import dataclass
from enum import StrEnum
from uuid import UUID

from bomesh.document_index import ClassificationRequest, EmbeddingRejectedError
from bomesh.errors import StatusCode
from bomesh.services import (
    DocumentNotFoundError,
    DocumentProcessingError,
    DocumentUnavailableError,
    InvalidDocumentStateError,
)
from bomesh.services.ingestion.run_engine import (
    ACTIVE_RUN_STATUSES,
    CONTENT_UNAVAILABLE,
    INTERNAL,
    PROVIDER_REFUSED,
    UNSUPPORTED_FORMAT,
    IngestionRunService,
    LockClaim,
    OwnershipLost,
    RunClassification,
)
from bomesh.services.knowledge_items.archive_expansion import ArchiveExpansionService
from bomesh.services.knowledge_items.indexing import (
    ItemIngestionService,
    PhaseRecorder,
    failure_message,
)

log = logging.getLogger(__name__)

#: Batches planned per call, relative to how many may run at once.
PLAN_AHEAD = 2
#: How often a Document's phases in flight are written to its task.
PHASE_PERSIST_SECONDS = 2.0
#: How often the executor reads the run's status to see a cancel.
STATUS_POLL_SECONDS = 3.0
#: Errors a Document's content causes; retrying cannot change them.
_DOCUMENT_ERRORS = (
    DocumentProcessingError,
    DocumentNotFoundError,
    InvalidDocumentStateError,
    ValueError,
)


@dataclass(frozen=True, slots=True)
class BatchRetry:
    """How a batch an infrastructure failure stopped is tried again."""

    initial_seconds: float = 5.0
    backoff: float = 2.0
    maximum_seconds: float = 120.0
    attempts: int = 5

    def delay(self, failures: int) -> float:
        """The wait after the ``failures``-th failed attempt."""
        return min(self.initial_seconds * self.backoff ** (failures - 1), self.maximum_seconds)


class Interruption(StrEnum):
    """Why an executor stops before its run ends."""

    #: The run was cancelled: interrupted Documents are cancelled, the run finishes.
    CANCELLED = "cancelled"
    #: The worker shuts down: interrupted Documents are queued again for another worker.
    SHUTDOWN = "shutdown"
    #: The worker lost its lock: another worker may own the run; nothing is written.
    ABANDONED = "abandoned"


class ProviderRefused(Exception):
    """The model provider refused a Document; every other one would be refused too."""


class RunExecutor:
    """Execute one run the worker holds the lock of, until it ends or is interrupted.

    Every write carries ``owner`` (the worker's claim of the run); a write is
    refused once the executor was abandoned (lock connection lost) and, in
    PostgreSQL, once the claim's connection no longer holds the run's lock.
    """

    def __init__(
        self,
        run_id: UUID,
        *,
        runs: IngestionRunService,
        ingestion: ItemIngestionService,
        archives: ArchiveExpansionService,
        documents: asyncio.Semaphore,
        owner: LockClaim | None = None,
        retry: BatchRetry = BatchRetry(),
        status_poll_seconds: float = STATUS_POLL_SECONDS,
    ) -> None:
        self.run_id = run_id
        self._runs = runs
        self._ingestion = ingestion
        self._archives = archives
        #: Worker-wide: how many Documents are processed at once.
        self._documents = documents
        self._owner = owner
        self._retry = retry
        self._status_poll_seconds = status_poll_seconds
        self._interruption: Interruption | None = None
        self._task: asyncio.Task[None] | None = None
        #: The provider's refusal (user-safe), once one Document was refused:
        #: no batch starts another Document of the run.
        self._refusal: str | None = None

    def interrupt(self, reason: Interruption) -> None:
        """Stop executing for ``reason``; the first reason given wins.

        ``ABANDONED`` always wins: once the lock is gone, nothing is written.
        """

        if self._interruption is Interruption.ABANDONED or (
            self._interruption is not None and reason is not Interruption.ABANDONED
        ):
            return
        self._interruption = reason
        if self._task is not None and not self._task.done():
            self._task.cancel()

    def _claim(self) -> LockClaim | None:
        """The claim a write carries; refused at once when the executor was abandoned."""

        if self._interruption is Interruption.ABANDONED:
            raise OwnershipLost(f"run {self.run_id} was abandoned")
        return self._owner

    async def run(self) -> None:
        """Recover the run, process what is left, and finish it.

        An unexpected (bookkeeping) failure gives the run back like a
        shutdown and is raised: the run is claimed again and resumed.
        """

        self._task = asyncio.current_task()
        if self._interruption is not None:
            return
        in_flight: dict[asyncio.Task[None], int] = {}
        watcher: asyncio.Task[None] | None = None
        try:
            recovered = await self._runs.recover(self.run_id, owner=self._claim())
            if recovered is None:
                return
            run, next_batch = recovered
            active, parallelism = await self._runs.start(self.run_id, owner=self._claim())
            if not active:
                await self._runs.finish(self.run_id, outcome="cancelled", owner=self._claim())
                return
            watcher = asyncio.create_task(self._watch())
            classification = await self._ingestion.classification_request(
                run.tenant_id, RunClassification.from_configuration(run.configuration)
            )
            refusal = await self._execute(
                run.tenant_id, next_batch, parallelism, classification, in_flight
            )
            await _stop(watcher)
            if refusal is None:
                await self._runs.finish(self.run_id, outcome="succeeded", owner=self._claim())
            else:
                await self._runs.finish(
                    self.run_id,
                    outcome="failed",
                    error={"code": int(StatusCode.FAILED_PRECONDITION), "message": refusal},
                    owner=self._claim(),
                )
        except asyncio.CancelledError:
            # A cancel that did not come through ``interrupt`` is the worker stopping.
            self._interruption = self._interruption or Interruption.SHUTDOWN
            await self._unwind(in_flight)
        except OwnershipLost:
            log.warning("ingestion run lock lost; abandoning run_id=%s", self.run_id)
            self._interruption = Interruption.ABANDONED
            await self._unwind(in_flight)
        except Exception:
            self._interruption = self._interruption or Interruption.SHUTDOWN
            await self._unwind(in_flight)
            raise
        finally:
            if watcher is not None:
                await _stop(watcher)

    async def process_batch(
        self,
        tenant_id: UUID,
        item_ids: list[UUID],
        classification: ClassificationRequest | None = None,
    ) -> None:
        """Process a batch's Documents one after another.

        A Document's own failure is recorded on it and the batch goes on. An
        infrastructure failure is raised (the batch is retried; Documents it
        already finished are not processed again). A provider refusal fails
        that Document and raises :class:`ProviderRefused` with the user-safe
        reason; after a refusal anywhere in the run, no batch starts another
        Document (those left are cancelled when the run finishes).
        """

        for item_id in item_ids:
            if self._refusal is not None:
                return
            async with self._documents:
                # Checked again: a refusal may come while waiting for a slot.
                if self._refusal is not None:
                    return
                if not await self._runs.claim_item(self.run_id, item_id, owner=self._claim()):
                    continue
                await self._process_item(tenant_id, item_id, PhaseRecorder(), classification)

    # -- Orchestration -----------------------------------------------------------

    async def _execute(
        self,
        tenant_id: UUID,
        next_batch: int,
        parallelism: int,
        classification: ClassificationRequest | None,
        in_flight: dict[asyncio.Task[None], int],
    ) -> str | None:
        """Plan and run every batch; the provider's refusal when it stopped the run."""

        while self._refusal is None:
            batches = await self._runs.plan_batches(
                self.run_id,
                first_batch_number=next_batch,
                max_batches=parallelism * PLAN_AHEAD,
                owner=self._claim(),
            )
            if not batches:
                if not in_flight:
                    break
                # A batch still running may append archive members.
                await _wait_one(in_flight)
                continue
            for number, item_ids in batches:
                while len(in_flight) >= parallelism:
                    await _wait_one(in_flight)
                if self._refusal is not None:
                    break
                task = asyncio.create_task(self._batch(tenant_id, number, item_ids, classification))
                in_flight[task] = number
                next_batch = number + 1
        while in_flight:
            await _wait_one(in_flight)
        return self._refusal

    async def _batch(
        self,
        tenant_id: UUID,
        number: int,
        item_ids: list[UUID],
        classification: ClassificationRequest | None,
    ) -> None:
        for attempt in range(1, self._retry.attempts + 1):
            try:
                await self.process_batch(tenant_id, item_ids, classification)
                return
            except ProviderRefused:
                return
            except OwnershipLost:
                raise
            except Exception:
                if attempt == self._retry.attempts:
                    break
                log.warning(
                    "ingestion batch failed, retrying run_id=%s batch=%s attempt=%s",
                    self.run_id,
                    number,
                    attempt,
                    exc_info=True,
                )
                await asyncio.sleep(self._retry.delay(attempt))
        log.error("ingestion batch failed after retries run_id=%s batch=%s", self.run_id, number)
        await self._runs.fail_batch(self.run_id, number, owner=self._claim())

    async def _watch(self) -> None:
        """Interrupt the run once it is no longer active (a cancel)."""

        while True:
            await asyncio.sleep(self._status_poll_seconds)
            try:
                status = await self._runs.status(self.run_id)
            except Exception:  # noqa: BLE001 - the next read tells
                log.warning("ingestion run status read failed run_id=%s", self.run_id, exc_info=True)
                continue
            if status not in ACTIVE_RUN_STATUSES:
                self.interrupt(Interruption.CANCELLED)
                return

    async def _unwind(self, in_flight: dict[asyncio.Task[None], int]) -> None:
        """Stop the batches in flight, then settle the run for the interruption."""

        for task in in_flight:
            task.cancel()
        # Each batch records what it interrupted before its cancel completes.
        await asyncio.gather(*in_flight, return_exceptions=True)
        in_flight.clear()
        try:
            if self._interruption is Interruption.CANCELLED:
                await self._runs.finish(self.run_id, outcome="cancelled", owner=self._claim())
            elif self._interruption is Interruption.SHUTDOWN:
                await self._runs.requeue(self.run_id, owner=self._claim())
        except OwnershipLost:
            log.warning("ingestion run lock lost while stopping run_id=%s", self.run_id)
        # ABANDONED: another worker may own the run now; it recovers it.

    # -- One Document ------------------------------------------------------------

    async def _process_item(
        self,
        tenant_id: UUID,
        item_id: UUID,
        recorder: PhaseRecorder,
        classification: ClassificationRequest | None,
    ) -> None:
        persisting = asyncio.create_task(self._persist_phases(item_id, recorder))
        try:
            chunk_count = await self._process(tenant_id, item_id, recorder, classification)
        except asyncio.CancelledError:
            await _stop(persisting)
            if self._interruption in (None, Interruption.CANCELLED):
                await self._runs.record_item_outcome(
                    self.run_id,
                    item_id,
                    status="cancelled",
                    phases=recorder.close(),
                    owner=self._claim(),
                )
            raise
        except EmbeddingRejectedError as exc:
            await _stop(persisting)
            message = failure_message(exc)
            # Every other Document would be refused too: no batch starts another.
            self._refusal = self._refusal or message
            log.warning(
                "model provider refused processing run_id=%s document_id=%s: %s",
                self.run_id,
                item_id,
                exc,
            )
            await self._runs.record_item_outcome(
                self.run_id,
                item_id,
                status="failed",
                error=message,
                error_class=PROVIDER_REFUSED,
                phases=recorder.close(),
                owner=self._claim(),
            )
            raise ProviderRefused(message) from None
        except _DOCUMENT_ERRORS as exc:
            await _stop(persisting)
            log.info("document processing failed run_id=%s document_id=%s", self.run_id, item_id)
            await self._runs.record_item_outcome(
                self.run_id,
                item_id,
                status="failed",
                error=failure_message(exc),
                error_class=_error_class(exc),
                phases=recorder.close(),
                owner=self._claim(),
            )
            return
        except OwnershipLost:
            await _stop(persisting)
            raise
        except Exception:
            await _stop(persisting)
            # Infrastructure: the task stays running so the retry takes it again.
            with suppress(Exception):
                await self._runs.record_item_phases(
                    self.run_id, item_id, recorder.close(), owner=self._claim()
                )
            log.exception(
                "document processing interrupted run_id=%s document_id=%s", self.run_id, item_id
            )
            raise
        await _stop(persisting)
        await self._runs.record_item_outcome(
            self.run_id,
            item_id,
            status="succeeded",
            chunk_count=chunk_count,
            phases=recorder.close(completed=True),
            owner=self._claim(),
        )

    async def _process(
        self,
        tenant_id: UUID,
        item_id: UUID,
        recorder: PhaseRecorder,
        classification: ClassificationRequest | None,
    ) -> int | None:
        expanded = await self._archives.expand_if_archive(
            item_id,
            tenant_id=tenant_id,
            processed_version=self._ingestion.processing_version(),
            progress=recorder,
        )
        if expanded is not None:
            # The members are this run's Documents now; the archive is done.
            await self._runs.append_items(
                self.run_id, expanded.document_ids, owner=self._claim()
            )
            return None
        return await self._ingestion.process_document(
            item_id, tenant_id=tenant_id, progress=recorder, classification=classification
        )

    async def _persist_phases(self, item_id: UUID, recorder: PhaseRecorder) -> None:
        seen = recorder.version
        while True:
            await asyncio.sleep(PHASE_PERSIST_SECONDS)
            if recorder.version != seen:
                seen = recorder.version
                with suppress(Exception):
                    await self._runs.record_item_phases(
                        self.run_id, item_id, recorder.phases, owner=self._claim()
                    )


def _error_class(exc: BaseException) -> str:
    """The provider-neutral ``errorClass`` of a Document's own failure."""

    if isinstance(exc, (DocumentUnavailableError, DocumentNotFoundError, InvalidDocumentStateError)):
        return CONTENT_UNAVAILABLE
    if isinstance(exc, DocumentProcessingError):
        return UNSUPPORTED_FORMAT
    return INTERNAL


async def _wait_one(in_flight: dict[asyncio.Task[None], int]) -> None:
    done, _ = await asyncio.wait(list(in_flight), return_when=asyncio.FIRST_COMPLETED)
    for task in done:
        in_flight.pop(task, None)
        task.result()


async def _stop(task: asyncio.Task[None]) -> None:
    """Cancel a helper task and wait for it; a cancel of the caller still propagates."""
    task.cancel()
    await asyncio.wait([task])


__all__ = ["BatchRetry", "Interruption", "ProviderRefused", "RunExecutor"]
