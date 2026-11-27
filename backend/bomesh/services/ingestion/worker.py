"""The ingestion worker process: ``python -m bomesh.services.ingestion.worker``.

Same codebase and image as the API, its own process (a separate container in
deployment, scaled on its own). PostgreSQL is the queue: QUEUED/RUNNING
``ingestion_runs`` and RUNNING ``ingestion_syncs`` rows are the work, and a
worker owns a run or sync while it holds its session-level advisory lock on
one dedicated connection. A worker that dies closes that connection, so
PostgreSQL frees its locks and the next worker recovers and resumes the run.

Loops: claim runs and syncs (every ``poll_seconds``), open due schedules
(every 30 s), re-apply dirty index payloads (every minute) and purge deleted
Items (hourly); each maintenance pass runs on one replica at a time. The
preview engine (``document_viewer.md`` "Producing"): a document whose content
arrived is notified on ``bomesh_cover`` and a read that found a revision's
representation missing on ``bomesh_preview`` (``{item}:{revision}``), both
LISTENed on the lock connection; the jobs wait in one deduplicated queue and
run in the worker's document slots under the per-item ``item-preview`` lock
(the representation, then — for the current revision — the cover), as many
at once as ``BOMESH_PREVIEW_CONVERSIONS``. A sweep at start and every ten
minutes (one replica at a time) catches what notifications missed.
SIGTERM/SIGINT stop claiming and give back what runs: interrupted Documents
are queued again for another worker.
"""

from __future__ import annotations

import asyncio
import logging
import signal
from collections.abc import Awaitable, Callable, Sequence
from contextlib import suppress
from datetime import datetime
from pathlib import Path
from uuid import UUID

from dotenv import load_dotenv
from sqlalchemy import and_, func, or_, select, tuple_
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine
from sqlalchemy.pool import NullPool

from bomesh.db.engine import SessionFactory, get_engine, transaction_scope
from bomesh.db.models import IngestionRun, IngestionSource, IngestionSync
from bomesh.runtime import AppRuntime
from bomesh.services.ingestion.executor import (
    STATUS_POLL_SECONDS,
    BatchRetry,
    Interruption,
    RunExecutor,
)
from bomesh.services.ingestion.run_engine import (
    ACTIVE_RUN_STATUSES,
    IngestionRunService,
    LockClaim,
    advisory_lock_key,
    run_lock_key,
)
from bomesh.services.ingestion.source_store import SYNC_RUNNING
from bomesh.services.ingestion.source_sync import SourceSyncService
from bomesh.services.knowledge_items.archive_expansion import ArchiveExpansionService
from bomesh.services.knowledge_items.indexing import ItemIngestionService, reconcile_dirty_payloads
from bomesh.services.knowledge_items.purge import purge_deleted_items
from bomesh.services.previews.covers import COVER_CHANNEL
from bomesh.services.previews.engine import PREVIEW_CHANNEL, PreviewEngine, parse_preview_request
from bomesh.services.taxonomy.proposal_jobs import (
    chat_namer,
    propose_from_clusters,
    propose_from_corrections,
)
from bomesh.services.taxonomy.reclassify import settle_reclassifications
from bomesh.services.workspaces.exports import purge_expired_exports
from config import IngestionWorkerConfig, get_config

log = logging.getLogger(__name__)

#: Open runs (and running syncs) read per page of a claim pass, oldest first.
CLAIM_SCAN = 20
#: How often due Source schedules are opened, and how many per pass.
SCHEDULE_SECONDS = 30.0
SCHEDULE_SCAN = 20
#: A sync an infrastructure failure stopped is tried this many times in all.
SYNC_ATTEMPTS = 3
#: Index upkeep: (name, interval, Items per pass).
PAYLOAD_RECONCILIATION = ("payload-reconciliation", 60.0, 500)
DELETED_ITEM_PURGE = ("deleted-item-purge", 3600.0, 100)
#: Export CSVs past their download window: (name, interval).
EXPORT_PURGE = ("export-purge", 3600.0)
#: Taxonomy upkeep: (name, interval). Reclassifications settle once their runs
#: end; concept proposals from unsure clusters weekly, from corrections daily.
RECLASSIFICATION_SETTLE = ("reclassification-settle", 60.0)
CONCEPT_CLUSTER_PROPOSALS = ("concept-cluster-proposals", 7 * 86400.0)
CONCEPT_CORRECTION_PROPOSALS = ("concept-correction-proposals", 86400.0)
#: Preview engine: the sweep's interval and page; notified jobs queued at most.
PREVIEW_SWEEP_SECONDS = 600.0
PREVIEW_SWEEP_PAGE = 200
PREVIEW_QUEUE = 1000

#: ``(name, interval seconds, one bounded pass)``.
MaintenanceJob = tuple[str, float, Callable[[], Awaitable[int]]]


class LockConnectionLost(RuntimeError):
    """The connection holding this worker's advisory locks is gone, and its locks with it."""


class _AdvisoryLocks:
    """Session-level advisory locks held on one dedicated PostgreSQL connection.

    ``on_lost`` is called (synchronously, at most once per connection) the
    moment the connection is known to be gone: PostgreSQL closed it (asyncpg's
    termination listener) or a statement on it failed. Its locks are gone
    with it. The same connection LISTENs on the channels given to
    :meth:`listen`; a notification sent while it is reconnecting is lost.
    """

    def __init__(self, database_url: str | None, *, on_lost: Callable[[], None]) -> None:
        # A direct connection of its own (never pooled): closing it frees every lock.
        self._engine: AsyncEngine = create_async_engine(
            get_engine(database_url).url, poolclass=NullPool
        )
        self._on_lost = on_lost
        self._connection: AsyncConnection | None = None
        self._driver: object | None = None
        self._lost = False
        self._mutex = asyncio.Lock()
        self._listeners: dict[str, Callable[[str], None]] = {}
        #: The backend holding the locks: every claim made on it carries it.
        self.pid = 0

    def listen(self, channel: str, receive: Callable[[str], None]) -> None:
        """Call ``receive(payload)`` for each NOTIFY on ``channel`` (from the next connect)."""
        self._listeners[channel] = receive

    async def connect(self) -> None:
        async with self._mutex:
            await self._drop()
            connection = await self._engine.connect()
            connection = await connection.execution_options(isolation_level="AUTOCOMMIT")
            driver = (await connection.get_raw_connection()).driver_connection
            self.pid = int(await connection.scalar(select(func.pg_backend_pid())))
            self._connection, self._driver, self._lost = connection, driver, False
            add_listener = getattr(driver, "add_termination_listener", None)
            if add_listener is not None:
                add_listener(lambda terminated: self._terminated(terminated))
            for channel, receive in self._listeners.items():
                await driver.add_listener(  # type: ignore[attr-defined]
                    channel,
                    lambda _connection, _pid, _channel, payload, receive=receive: receive(payload),
                )

    def claim(self, key: int) -> LockClaim:
        return LockClaim(key=key, pid=self.pid)

    async def try_lock(self, key: int) -> bool:
        return bool(await self._scalar(select(func.pg_try_advisory_lock(key))))

    async def unlock(self, claim: LockClaim) -> None:
        """Release ``claim`` if it was made on the current connection (else it is gone)."""
        if claim.pid == self.pid and self._connection is not None and not self._lost:
            await self._scalar(select(func.pg_advisory_unlock(claim.key)))

    async def ping(self) -> None:
        await self._scalar(select(1))

    async def close(self) -> None:
        async with self._mutex:
            await self._drop()
        await self._engine.dispose()

    async def _scalar(self, statement: object) -> object:
        async with self._mutex:
            if self._connection is None or self._lost:
                raise LockConnectionLost("the advisory lock connection is not open")
            try:
                return await self._connection.scalar(statement)  # type: ignore[call-overload]
            except Exception as exc:
                self._mark_lost()
                raise LockConnectionLost("the advisory lock connection failed") from exc

    def _terminated(self, driver: object) -> None:
        if driver is self._driver:
            self._mark_lost()

    def _mark_lost(self) -> None:
        if not self._lost and self._connection is not None:
            self._lost = True
            self._on_lost()

    async def _drop(self) -> None:
        # Closing on purpose is not a loss: forget the connection before closing it.
        connection, self._connection, self._driver = self._connection, None, None
        if connection is not None:
            with suppress(Exception):
                await connection.invalidate()
            with suppress(Exception):
                await connection.close()


class IngestionWorker:
    """Claim and execute runs and syncs, fire schedules, keep the index tidy."""

    def __init__(
        self,
        *,
        sessions: SessionFactory,
        runs: IngestionRunService,
        ingestion: ItemIngestionService,
        archives: ArchiveExpansionService,
        syncs: SourceSyncService,
        config: IngestionWorkerConfig,
        maintenance: Sequence[MaintenanceJob] = (),
        retry: BatchRetry = BatchRetry(),
        status_poll_seconds: float = STATUS_POLL_SECONDS,
        previews: PreviewEngine | None = None,
    ) -> None:
        self._sessions = sessions
        self._runs = runs
        self._ingestion = ingestion
        self._archives = archives
        self._syncs = syncs
        self._config = config
        self._maintenance = tuple(maintenance)
        self._retry = retry
        self._status_poll_seconds = status_poll_seconds
        self._locks = _AdvisoryLocks(config.lock_database_url, on_lost=self._lock_lost)
        #: Worker-wide bound on Documents processed at once.
        self._documents = asyncio.Semaphore(config.max_concurrent_documents)
        self._executions: dict[UUID, tuple[RunExecutor, asyncio.Task[None]]] = {}
        self._sync_tasks: dict[UUID, asyncio.Task[None]] = {}
        self._stopping = asyncio.Event()
        #: ``None``: this worker produces no representations or covers.
        self._previews = previews
        #: Notified ``(item, revision)`` jobs, oldest first (an ordered set);
        #: ``revision`` ``None`` is the current one (content arrival: its cover too).
        self._preview_queue: dict[tuple[UUID, int | None], None] = {}
        self._preview_wake = asyncio.Event()
        if previews is not None:
            self._locks.listen(COVER_CHANNEL, self._content_notified)
            self._locks.listen(PREVIEW_CHANNEL, self._preview_notified)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> IngestionWorker:
        sessions, index = runtime.sessions(), runtime.item_index()
        storage = runtime.object_storage()
        payloads, payload_seconds, payload_limit = PAYLOAD_RECONCILIATION
        purge, purge_seconds, purge_limit = DELETED_ITEM_PURGE
        return cls(
            sessions=sessions,
            runs=runtime.ingestion_run_service(),
            ingestion=runtime.ingestion_service(),
            archives=runtime.archive_expansion_service(),
            syncs=runtime.source_sync_service(),
            config=runtime.config.ingestion_worker,
            maintenance=(
                (
                    payloads,
                    payload_seconds,
                    lambda: reconcile_dirty_payloads(sessions, index, limit=payload_limit),
                ),
                (
                    purge,
                    purge_seconds,
                    lambda: purge_deleted_items(sessions, index, storage, limit=purge_limit),
                ),
                (
                    EXPORT_PURGE[0],
                    EXPORT_PURGE[1],
                    lambda: purge_expired_exports(sessions, storage),
                ),
                (
                    RECLASSIFICATION_SETTLE[0],
                    RECLASSIFICATION_SETTLE[1],
                    lambda: settle_reclassifications(sessions),
                ),
                (
                    CONCEPT_CLUSTER_PROPOSALS[0],
                    CONCEPT_CLUSTER_PROPOSALS[1],
                    lambda: propose_from_clusters(
                        sessions,
                        embed=index.embed_texts,
                        name=chat_namer(
                            runtime.agent_transport(), runtime.config.model.chat_model
                        ),
                    ),
                ),
                (
                    CONCEPT_CORRECTION_PROPOSALS[0],
                    CONCEPT_CORRECTION_PROPOSALS[1],
                    lambda: propose_from_corrections(sessions),
                ),
            ),
            previews=runtime.preview_engine(),
        )

    # -- Lifecycle -------------------------------------------------------------------

    def stop(self) -> None:
        """Ask the worker to shut down gracefully (SIGTERM/SIGINT)."""
        self._stopping.set()

    async def run(self) -> None:
        """Work until :meth:`stop`; then give back what runs and release every lock."""

        await self._locks.connect()
        try:
            await self._runs.release_orphaned_documents()
        except Exception:  # noqa: BLE001 - a startup repair; the next start retries
            log.warning("orphaned documents could not be released", exc_info=True)
        loops = [
            asyncio.create_task(self._every(self._config.poll_seconds, self.claim)),
            asyncio.create_task(self._every(SCHEDULE_SECONDS, self.fire_schedules)),
            *(
                asyncio.create_task(self._every(every, self._exclusive(name, job)))
                for name, every, job in self._maintenance
            ),
            *(
                (
                    *(
                        asyncio.create_task(self._produce_previews())
                        for _ in range(self._previews.conversions)
                    ),
                    asyncio.create_task(self._every(PREVIEW_SWEEP_SECONDS, self.sweep_previews)),
                )
                if self._previews is not None
                else ()
            ),
        ]
        log.info(
            "ingestion worker started max_concurrent_runs=%s max_concurrent_documents=%s",
            self._config.max_concurrent_runs,
            self._config.max_concurrent_documents,
        )
        try:
            await self._stopping.wait()
        finally:
            for loop in loops:
                loop.cancel()
            await asyncio.gather(*loops, return_exceptions=True)
            await self._shutdown()
        log.info("ingestion worker stopped")

    async def _shutdown(self) -> None:
        """Give back every run and sync in flight, then close the lock connection."""

        for executor, _ in self._executions.values():
            executor.interrupt(Interruption.SHUTDOWN)
        for task in self._sync_tasks.values():
            task.cancel()
        tasks = [task for _, task in self._executions.values()] + list(self._sync_tasks.values())
        if tasks:
            _, late = await asyncio.wait(tasks, timeout=self._config.graceful_shutdown_seconds)
            for task in late:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        await self._locks.close()

    async def _every(self, seconds: float, work: Callable[[], Awaitable[object]]) -> None:
        while True:
            try:
                await work()
            except LockConnectionLost:
                try:
                    await self._abandon()
                except Exception:  # noqa: BLE001 - the next pass reconnects again
                    log.exception("ingestion worker could not reopen its lock connection")
            except Exception:  # noqa: BLE001 - the next pass tries again
                log.exception("ingestion worker pass failed")
            await asyncio.sleep(seconds)

    def _lock_lost(self) -> None:
        """The lock connection is gone: stop every run and sync now; write nothing more.

        Another worker may take their locks at once. Executors are abandoned
        (no further writes; PostgreSQL also refuses their claims) and syncs are
        cancelled; the claim loop reconnects once they have stopped.
        """

        log.error("ingestion worker lost its lock connection; abandoning its runs and syncs")
        self._interrupt_all()

    def _interrupt_all(self) -> None:
        for executor, _ in self._executions.values():
            executor.interrupt(Interruption.ABANDONED)
        for task in self._sync_tasks.values():
            task.cancel()

    async def _abandon(self) -> None:
        """Wait for what the lost connection owned to stop, then reconnect."""

        self._interrupt_all()
        tasks = [task for _, task in self._executions.values()] + list(self._sync_tasks.values())
        if tasks:
            # ``wait``, not ``gather``: stopping this loop must not cancel them again.
            await asyncio.wait(tasks)
        await self._locks.connect()

    # -- Claiming --------------------------------------------------------------------

    async def claim(self) -> None:
        """One pass: take open runs and running syncs no worker holds, within the limits.

        Candidates are read oldest first, a page at a time, until this worker
        is at capacity or none are left: rows other workers hold never starve
        newer ones.
        """

        if self._stopping.is_set():
            return
        await self._locks.ping()
        limit = self._config.max_concurrent_runs
        after: tuple[datetime, UUID] | None = None
        while len(self._executions) < limit:
            page = await self._open_runs(after)
            for created_at, run_id in page:
                after = (created_at, run_id)
                if len(self._executions) >= limit:
                    break
                key = run_lock_key(run_id)
                if run_id not in self._executions and await self._locks.try_lock(key):
                    self._start_run(run_id, self._locks.claim(key))
            if len(page) < CLAIM_SCAN:
                break
        after = None
        while len(self._sync_tasks) < limit:
            syncs = await self._running_syncs(after)
            for started_at, sync_id, trigger, source_id, tenant_id in syncs:
                after = (started_at, sync_id)
                if len(self._sync_tasks) >= limit:
                    break
                key = _sync_lock_key(sync_id)
                if sync_id not in self._sync_tasks and await self._locks.try_lock(key):
                    self._sync_tasks[sync_id] = asyncio.create_task(
                        self._sync(
                            sync_id,
                            self._locks.claim(key),
                            process=trigger == "scheduled",
                            source_id=source_id,
                            tenant_id=tenant_id,
                        )
                    )
            if len(syncs) < CLAIM_SCAN:
                break

    async def _open_runs(self, after: tuple[datetime, UUID] | None) -> list[tuple[datetime, UUID]]:
        """A page of queued or running runs (and cancelled ones nobody settled), oldest first."""

        statement = (
            select(IngestionRun.created_at, IngestionRun.id)
            .where(
                or_(
                    IngestionRun.status.in_(ACTIVE_RUN_STATUSES),
                    and_(IngestionRun.status == "cancelled", IngestionRun.finished_at.is_(None)),
                )
            )
            .order_by(IngestionRun.created_at, IngestionRun.id)
            .limit(CLAIM_SCAN)
        )
        if after is not None:
            statement = statement.where(tuple_(IngestionRun.created_at, IngestionRun.id) > after)
        async with transaction_scope(self._sessions) as session:
            return [(row[0], row[1]) for row in await session.execute(statement)]

    async def _running_syncs(
        self, after: tuple[datetime, UUID] | None
    ) -> list[tuple[datetime, UUID, str, UUID, UUID]]:
        """A page of running syncs, oldest first."""

        statement = (
            select(
                IngestionSync.started_at,
                IngestionSync.id,
                IngestionSync.trigger_type,
                IngestionSync.ingestion_source_id,
                IngestionSource.tenant_id,
            )
            .join(IngestionSource, IngestionSource.id == IngestionSync.ingestion_source_id)
            .where(IngestionSync.status == SYNC_RUNNING)
            .order_by(IngestionSync.started_at, IngestionSync.id)
            .limit(CLAIM_SCAN)
        )
        if after is not None:
            statement = statement.where(tuple_(IngestionSync.started_at, IngestionSync.id) > after)
        async with transaction_scope(self._sessions) as session:
            return [(row[0], row[1], row[2], row[3], row[4]) for row in await session.execute(statement)]

    def _start_run(self, run_id: UUID, claim: LockClaim) -> None:
        executor = RunExecutor(
            run_id,
            runs=self._runs,
            ingestion=self._ingestion,
            archives=self._archives,
            documents=self._documents,
            owner=claim,
            retry=self._retry,
            status_poll_seconds=self._status_poll_seconds,
        )
        task = asyncio.create_task(self._execute(executor, claim))
        self._executions[run_id] = (executor, task)

    async def _execute(self, executor: RunExecutor, claim: LockClaim) -> None:
        log.info("ingestion run claimed run_id=%s", executor.run_id)
        try:
            await executor.run()
        except Exception:  # noqa: BLE001 - the run is claimed and resumed again
            log.exception("ingestion run execution failed run_id=%s", executor.run_id)
        finally:
            if self._executions.get(executor.run_id, (None,))[0] is executor:
                del self._executions[executor.run_id]
            with suppress(LockConnectionLost):
                await self._locks.unlock(claim)

    async def _sync(
        self,
        sync_id: UUID,
        claim: LockClaim,
        *,
        process: bool,
        source_id: UUID,
        tenant_id: UUID,
    ) -> None:
        """Run a RUNNING sync row; a scheduled one then processes what it left pending.

        A sync's own failure is recorded on its row by the service; an
        infrastructure failure is retried (a row that ended is not run again).
        """

        try:
            for attempt in range(1, SYNC_ATTEMPTS + 1):
                try:
                    result = await self._syncs.sync(sync_id)
                    break
                except Exception:  # noqa: BLE001 - retried, then left to the row
                    if attempt == SYNC_ATTEMPTS:
                        log.exception("source sync failed sync_id=%s", sync_id)
                        return
                    log.warning("source sync failed, retrying sync_id=%s", sync_id, exc_info=True)
                    await asyncio.sleep(self._retry.delay(attempt))
            if process and result is not None:
                await self._runs.create_scheduled_run(tenant_id, source_id)
        except Exception:  # noqa: BLE001 - logged; the schedule fires again
            log.exception("scheduled processing failed sync_id=%s", sync_id)
        finally:
            if self._sync_tasks.get(sync_id) is asyncio.current_task():
                del self._sync_tasks[sync_id]
            with suppress(LockConnectionLost):
                await self._locks.unlock(claim)

    # -- Schedules and upkeep -----------------------------------------------------

    async def fire_schedules(self) -> int:
        """Open the SCHEDULED sync of every due Source; the claim loop runs them."""
        if self._stopping.is_set():
            return 0
        return await self._syncs.fire_due_schedules(limit=SCHEDULE_SCAN)

    def _exclusive(self, name: str, job: Callable[[], Awaitable[int]]) -> Callable[[], Awaitable[None]]:
        """``job`` run by one replica at a time (a transaction-level advisory lock)."""

        async def run() -> None:
            async with transaction_scope(self._sessions) as session:
                key = advisory_lock_key("ingestion-maintenance", name)
                if not await session.scalar(select(func.pg_try_advisory_xact_lock(key))):
                    return
                handled = await job()
            if handled:
                log.info("ingestion maintenance %s handled %s items", name, handled)

        return run

    # -- Preview engine --------------------------------------------------------------

    def _content_notified(self, payload: str) -> None:
        """``trg_items_cover`` fired: the document's current content needs the engine."""
        try:
            item_id = UUID(payload)
        except ValueError:
            return
        self._enqueue((item_id, None))

    def _preview_notified(self, payload: str) -> None:
        """A read found a revision's representation missing (the reader asks again)."""
        request = parse_preview_request(payload)
        if request is not None:
            self._enqueue(request)

    def _enqueue(self, job: tuple[UUID, int | None]) -> None:
        # A full queue drops the job: the sweep or the reader's next poll asks again.
        if job in self._preview_queue or len(self._preview_queue) < PREVIEW_QUEUE:
            self._preview_queue[job] = None
            self._preview_wake.set()

    async def _produce_previews(self) -> None:
        """Run queued jobs in notification order (one of ``conversions`` such loops)."""
        while True:
            await self._preview_wake.wait()
            self._preview_wake.clear()
            while self._preview_queue and not self._stopping.is_set():
                job = next(iter(self._preview_queue))
                del self._preview_queue[job]
                try:
                    await self._produce(*job)
                except Exception:  # noqa: BLE001 - the sweep or the next read asks again
                    log.warning(
                        "preview engine job failed item_id=%s revision=%s", *job, exc_info=True
                    )

    async def sweep_previews(self) -> int:
        """Settle every document the engine still owes (one replica at a time); how many changed.

        Catches what notifications missed (a worker that was down, a full
        queue, a converter that was unreachable) and backfills documents that
        predate the engine.
        """
        if self._previews is None or self._stopping.is_set():
            return 0
        key = advisory_lock_key("ingestion-maintenance", "preview-sweep")
        if not await self._locks.try_lock(key):
            return 0
        claim = self._locks.claim(key)
        changed = 0
        try:
            after: UUID | None = None
            while not self._stopping.is_set():
                page = await self._previews.pending(after=after, limit=PREVIEW_SWEEP_PAGE)
                for item_id in page:
                    if self._stopping.is_set():
                        break
                    try:
                        changed += int(await self._produce(item_id, None))
                    except LockConnectionLost:
                        raise
                    except Exception:  # noqa: BLE001 - the next sweep tries again
                        log.warning("preview engine job failed item_id=%s", item_id, exc_info=True)
                if len(page) < PREVIEW_SWEEP_PAGE:
                    break
                after = page[-1]
        finally:
            with suppress(LockConnectionLost):
                await self._locks.unlock(claim)
        if changed:
            log.info("ingestion maintenance preview-sweep settled %s documents", changed)
        return changed

    async def _produce(self, item_id: UUID, revision_number: int | None) -> bool:
        """One engine job in one of the worker's document slots, unless another worker runs one."""
        assert self._previews is not None
        key = advisory_lock_key("item-preview", item_id)
        if not await self._locks.try_lock(key):
            return False
        claim = self._locks.claim(key)
        try:
            async with self._documents:
                return await self._previews.produce(item_id, revision_number)
        finally:
            with suppress(LockConnectionLost):
                await self._locks.unlock(claim)


def _sync_lock_key(sync_id: UUID) -> int:
    """The lock a worker holds (session level) while it runs the sync row."""
    return advisory_lock_key("ingestion-sync", sync_id)


async def _main() -> None:
    load_dotenv(Path(__file__).resolve().parents[4] / ".env", override=False)
    config = get_config()
    logging.basicConfig(
        level=config.server.log_level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    runtime = AppRuntime(config)
    worker = IngestionWorker.from_runtime(runtime)
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(signum, worker.stop)
    try:
        await worker.run()
    finally:
        await runtime.aclose()


if __name__ == "__main__":
    asyncio.run(_main())


__all__ = ["IngestionWorker", "LockConnectionLost"]
