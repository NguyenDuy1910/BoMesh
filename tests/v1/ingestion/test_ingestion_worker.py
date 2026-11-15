"""The ingestion worker on real PostgreSQL: claiming, recovering, stopping, schedules.

A fake processing core stands in for ``ItemIngestionService``; the worker's
advisory locks live on their own connections, as in production.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select

from bomesh.db.models import (
    IngestionRun,
    IngestionSource,
    IngestionSync,
    IntegrationConnection,
    Item,
    Tenant,
)
from bomesh.document_index import EmbeddingRejectedError
from bomesh.errors import StatusCode
from bomesh.runtime import AppRuntime
from bomesh.services.ingestion.executor import BatchRetry
from bomesh.services.ingestion.run_engine import (
    IngestionRunService,
    LockClaim,
    OwnershipLost,
    RunSelection,
    run_lock_key,
)
from bomesh.services.ingestion.worker import IngestionWorker
from bomesh.services.knowledge_items.covers import DocumentCovers
from bomesh.services.knowledge_items.item_store import ItemService
from config import IngestionWorkerConfig
from harness import TEST_DATABASE_URL, Sessions, World
from runs_support import document, held_lock, task_items

pytestmark = pytest.mark.asyncio


class _Ingestion:
    """The processing core: marks each Document processing, then succeeds.

    Calls from ``block_from`` on wait for ``gate``; call ``refuse_call`` is
    refused by the model provider. A ``stubborn`` core ignores a cancel and
    finishes its document anyway once ``gate`` opens: a stale executor that
    would like to write.
    """

    def __init__(
        self,
        sessions: Sessions,
        *,
        block_from: int | None = None,
        refuse_call: int | None = None,
        stubborn: bool = False,
    ) -> None:
        self._sessions = sessions
        self._block_from = block_from
        self._refuse_call = refuse_call
        self._stubborn = stubborn
        self.gate = asyncio.Event()
        self.calls: list[UUID] = []
        self.blocked = asyncio.Event()
        self.cancelled = asyncio.Event()
        self.finished: list[UUID] = []
        self.classification_requests = 0

    def processing_version(self) -> str:
        return "test-version"

    async def classification_request(self, tenant_id: UUID, classification: Any) -> Any:
        self.classification_requests += 1
        return None

    async def process_document(
        self, document_id: UUID, *, tenant_id: UUID, progress: Any, classification: Any = None
    ) -> int:
        call = len(self.calls)
        self.calls.append(document_id)
        async with self._sessions.begin() as session:
            await ItemService(session).mark_index_processing(document_id)
        progress("parsing", 0, 1)
        if call == self._refuse_call:
            raise EmbeddingRejectedError(402, "no credit left")
        if self._block_from is not None and call >= self._block_from:
            self.blocked.set()
            try:
                await self.gate.wait()
            except asyncio.CancelledError:
                self.cancelled.set()
                if not self._stubborn:
                    raise
                await self.gate.wait()
        await asyncio.sleep(0.01)
        self.finished.append(document_id)
        return 2


class _Archives:
    async def expand_if_archive(self, document_id: UUID, **_: Any) -> None:
        return None


def _worker(
    runtime: AppRuntime,
    ingestion: _Ingestion,
    *,
    max_concurrent_runs: int = 2,
    max_concurrent_documents: int = 4,
    covers: DocumentCovers | None = None,
) -> IngestionWorker:
    return IngestionWorker(
        sessions=runtime.sessions(),
        runs=runtime.ingestion_run_service(),
        ingestion=ingestion,  # type: ignore[arg-type]
        archives=_Archives(),  # type: ignore[arg-type]
        syncs=runtime.source_sync_service(),
        config=IngestionWorkerConfig(
            max_concurrent_runs=max_concurrent_runs,
            max_concurrent_documents=max_concurrent_documents,
            poll_seconds=0.05,
            graceful_shutdown_seconds=5,
            lock_database_url=TEST_DATABASE_URL,
        ),
        retry=BatchRetry(initial_seconds=0.01, maximum_seconds=0.01),
        status_poll_seconds=0.05,
        covers=covers,
    )


async def _queue(runtime: AppRuntime, workspace: Tenant, item_ids: list[UUID]) -> UUID:
    """A QUEUED run over ``item_ids``: what CreateIngestionRun leaves for the workers."""
    engine = runtime.ingestion_run_service()
    async with runtime.sessions().begin() as session:
        run = await engine.snapshot(
            session,
            workspace_id=workspace.id,
            selection=RunSelection(items=tuple(item_ids)),
            collections=None,
            trigger="manual",
            created_by_user_id=None,
        )
        run_id = run.id
    assert run.item_count == len(item_ids)
    return run_id


async def _documents(sessions: Sessions, world: World, count: int) -> tuple[Tenant, list[UUID]]:
    workspace = await world.make_workspace(await world.make_user())
    handbook = await world.make_collection(workspace, title="Handbook")
    return workspace, [(await document(sessions, handbook)).id for _ in range(count)]


async def _run(sessions: Sessions, run_id: UUID) -> IngestionRun:
    async with sessions.begin() as session:
        run = await session.get(IngestionRun, run_id)
        assert run is not None
        return run


async def _index_statuses(sessions: Sessions, item_ids: list[UUID]) -> set[str]:
    async with sessions.begin() as session:
        return set(await session.scalars(select(Item.index_status).where(Item.id.in_(item_ids))))


async def _until_finished(sessions: Sessions, run_id: UUID, timeout: float = 15.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while (await _run(sessions, run_id)).finished_at is None:
        assert asyncio.get_running_loop().time() < deadline, "the run did not finish in time"
        await asyncio.sleep(0.05)


async def _stop(worker: IngestionWorker, task: asyncio.Task[None]) -> None:
    worker.stop()
    await asyncio.wait_for(task, timeout=15)


async def test_a_run_whose_worker_died_is_recovered_and_resumed(
    sessions: Sessions, world: World, runtime: AppRuntime
) -> None:
    workspace, items = await _documents(sessions, world, 3)
    run_id = await _queue(runtime, workspace, items)
    engine = runtime.ingestion_run_service()
    ingestion = _Ingestion(sessions)
    worker = _worker(runtime, ingestion)

    # A first worker took the run and died mid-document; while its connection
    # lives, its lock keeps every other worker away.
    async with held_lock(run_lock_key(run_id)):
        await engine.start(run_id)
        await engine.plan_batches(run_id, first_batch_number=0, max_batches=8)
        interrupted = items[0]
        assert await engine.claim_item(run_id, interrupted)
        async with sessions.begin() as session:
            await ItemService(session).mark_index_processing(interrupted)
        task = asyncio.create_task(worker.run())
        await asyncio.sleep(0.5)
        assert ingestion.calls == []
        assert (await task_items(sessions, run_id))[interrupted].status == "running"
    # Its connection closed: PostgreSQL freed the lock.
    try:
        await _until_finished(sessions, run_id)
    finally:
        await _stop(worker, task)

    run = await _run(sessions, run_id)
    tasks = await task_items(sessions, run_id)
    assert run.status == "succeeded"
    assert (tasks[interrupted].status, tasks[interrupted].error_class) == ("failed", "interrupted")
    assert {tasks[item].status for item in items[1:]} == {"succeeded"}
    assert sorted(ingestion.calls) == sorted(items[1:])
    assert ingestion.classification_requests == 1
    assert await _index_statuses(sessions, [interrupted]) == {"pending"}


async def test_stop_keeps_what_finished_and_returns_the_rest_to_pending(
    sessions: Sessions, world: World, runtime: AppRuntime
) -> None:
    workspace, items = await _documents(sessions, world, 3)
    run_id = await _queue(runtime, workspace, items)
    engine = runtime.ingestion_run_service()
    ingestion = _Ingestion(sessions, block_from=1)
    # One document at a time: the first finishes before the second starts,
    # whatever batches the run was planned into.
    worker = _worker(runtime, ingestion, max_concurrent_documents=1)
    task = asyncio.create_task(worker.run())
    try:
        await asyncio.wait_for(ingestion.blocked.wait(), timeout=15)
        # CancelIngestionRun: the worker holds the run, so it settles it.
        async with sessions.begin() as session:
            run = await session.get(IngestionRun, run_id, with_for_update=True)
            assert run is not None
            await engine.mark_cancelled(session, run)
        await engine.stop(run_id)
        await _until_finished(sessions, run_id)
    finally:
        await _stop(worker, task)

    run = await _run(sessions, run_id)
    tasks = await task_items(sessions, run_id)
    finished, interrupted = ingestion.calls
    rest = [item for item in items if item != finished]
    assert run.status == "cancelled"
    assert tasks[finished].status == "succeeded"
    assert {tasks[item].status for item in rest} == {"cancelled"}
    assert interrupted in rest
    assert await _index_statuses(sessions, rest) == {"pending"}


async def test_a_graceful_shutdown_requeues_the_document_in_flight(
    sessions: Sessions, world: World, runtime: AppRuntime
) -> None:
    workspace, items = await _documents(sessions, world, 3)
    run_id = await _queue(runtime, workspace, items)
    first = _Ingestion(sessions, block_from=1)
    stopping = _worker(runtime, first, max_concurrent_documents=1)
    task = asyncio.create_task(stopping.run())
    await asyncio.wait_for(first.blocked.wait(), timeout=15)

    await _stop(stopping, task)

    done, in_flight = first.calls
    tasks = await task_items(sessions, run_id)
    assert (await _run(sessions, run_id)).status == "running"
    assert tasks[done].status == "succeeded"
    # Given back, not failed or cancelled: the next worker processes them.
    rest = [item for item in items if item != done]
    assert in_flight in rest
    assert {(tasks[item].status, tasks[item].batch_number) for item in rest} == {("queued", None)}
    assert {tasks[item].error_class for item in rest} == {None}
    assert await _index_statuses(sessions, rest) == {"pending"}

    second = _Ingestion(sessions)
    resuming = _worker(runtime, second)
    task = asyncio.create_task(resuming.run())
    try:
        await _until_finished(sessions, run_id)
    finally:
        await _stop(resuming, task)

    tasks = await task_items(sessions, run_id)
    assert (await _run(sessions, run_id)).status == "succeeded"
    assert {row.status for row in tasks.values()} == {"succeeded"}
    assert sorted(second.calls) == sorted(item for item in items if item != done)


async def test_a_provider_refusal_stops_every_batch_and_fails_the_run(
    sessions: Sessions, world: World, runtime: AppRuntime
) -> None:
    # Twenty Documents: batches of several Documents each, run side by side.
    workspace, items = await _documents(sessions, world, 20)
    run_id = await _queue(runtime, workspace, items)
    # Call 0 is refused while call 1 (another batch) is still at the provider.
    ingestion = _Ingestion(sessions, refuse_call=0, block_from=1)
    worker = _worker(runtime, ingestion, max_concurrent_documents=2)
    task = asyncio.create_task(worker.run())
    try:
        await asyncio.wait_for(ingestion.blocked.wait(), timeout=15)
        refused, in_flight = ingestion.calls
        while (await task_items(sessions, run_id))[refused].status != "failed":
            await asyncio.sleep(0.05)
        # The Document already at the provider may finish.
        ingestion.gate.set()
        await _until_finished(sessions, run_id)
    finally:
        await _stop(worker, task)

    run = await _run(sessions, run_id)
    tasks = await task_items(sessions, run_id)
    batch_sizes: dict[int, int] = {}
    for row in tasks.values():
        if row.batch_number is not None:
            batch_sizes[row.batch_number] = batch_sizes.get(row.batch_number, 0) + 1
    assert max(batch_sizes.values()) > 1
    assert run.status == "failed"
    assert run.error is not None and run.error["code"] == StatusCode.FAILED_PRECONDITION
    assert "no credit" not in run.error["message"]
    assert (tasks[refused].status, tasks[refused].error_class) == ("failed", "provider_refused")
    assert tasks[in_flight].status == "succeeded"
    # Nothing new started after the refusal, in its batch or any other.
    assert ingestion.calls == [refused, in_flight]
    rest = [item for item in items if item not in ingestion.calls]
    assert {tasks[item].status for item in rest} == {"cancelled"}
    assert await _index_statuses(sessions, rest) == {"pending"}


async def test_two_workers_never_execute_the_same_run(
    sessions: Sessions, world: World, runtime: AppRuntime
) -> None:
    workspace, items = await _documents(sessions, world, 6)
    run_id = await _queue(runtime, workspace, items)
    ingestions = [_Ingestion(sessions), _Ingestion(sessions)]
    workers = [_worker(runtime, ingestion) for ingestion in ingestions]
    tasks = [asyncio.create_task(worker.run()) for worker in workers]
    try:
        await _until_finished(sessions, run_id)
    finally:
        for worker, task in zip(workers, tasks, strict=True):
            await _stop(worker, task)

    assert (await _run(sessions, run_id)).status == "succeeded"
    calls = sorted((len(ingestion.calls) for ingestion in ingestions))
    assert calls == [0, 6]
    assert sum(ingestion.classification_requests for ingestion in ingestions) == 1


async def test_a_due_schedule_fires_once_and_moves_to_its_next_firing(
    sessions: Sessions, world: World, runtime: AppRuntime
) -> None:
    workspace = await world.make_workspace(await world.make_user())
    handbook = await world.make_collection(workspace, title="Handbook")
    missed = datetime.now(UTC) - timedelta(days=3)
    async with sessions.begin() as session:
        connection = IntegrationConnection(
            tenant_id=workspace.id,
            code=f"c{uuid4().hex[:12]}",
            connector_key="confluence",
            display_name="Wiki",
            status="active",
        )
        session.add(connection)
        await session.flush()
        source = IngestionSource(
            tenant_id=workspace.id,
            code="wiki",
            integration_connection_id=connection.id,
            target_item_id=handbook.id,
            schedule_cron="0 6 * * *",
            schedule_time_zone="UTC",
            next_sync_at=missed,
        )
        session.add(source)
        await session.flush()
        source_id = source.id
    worker = _worker(runtime, _Ingestion(sessions))

    # Three missed firings fire once; the next pass finds nothing due.
    assert await worker.fire_schedules() == 1
    assert await worker.fire_schedules() == 0

    async with sessions.begin() as session:
        syncs = list(
            await session.scalars(
                select(IngestionSync).where(IngestionSync.ingestion_source_id == source_id)
            )
        )
        stored = await session.get(IngestionSource, source_id)
    assert [(sync.trigger_type, sync.status) for sync in syncs] == [("scheduled", "running")]
    assert stored is not None and stored.next_sync_at is not None
    assert stored.next_sync_at > datetime.now(UTC)
    assert (stored.next_sync_at.hour, stored.next_sync_at.minute) == (6, 0)


async def test_cancelling_a_run_no_worker_holds_settles_it_at_once(
    sessions: Sessions, world: World, runtime: AppRuntime
) -> None:
    workspace, items = await _documents(sessions, world, 2)
    run_id = await _queue(runtime, workspace, items)
    engine: IngestionRunService = runtime.ingestion_run_service()

    async with sessions.begin() as session:
        run = await session.get(IngestionRun, run_id, with_for_update=True)
        assert run is not None
        await engine.mark_cancelled(session, run)
    await engine.stop(run_id)

    run = await _run(sessions, run_id)
    assert (run.status, run.finished_at is not None) == ("cancelled", True)
    assert {row.status for row in (await task_items(sessions, run_id)).values()} == {"cancelled"}


async def _terminate(pid: int) -> None:
    """Kill one PostgreSQL backend, as a network loss or a DBA would."""
    async with held_lock() as connection:
        assert await connection.scalar(select(func.pg_terminate_backend(pid)))


async def test_a_worker_that_loses_its_lock_stops_at_once_and_writes_nothing(
    sessions: Sessions, world: World, runtime: AppRuntime
) -> None:
    workspace, items = await _documents(sessions, world, 3)
    run_id = await _queue(runtime, workspace, items)
    stale = _Ingestion(sessions, block_from=0, stubborn=True)
    losing = _worker(runtime, stale, max_concurrent_documents=1)
    losing_task = asyncio.create_task(losing.run())
    await asyncio.wait_for(stale.blocked.wait(), timeout=15)
    [in_flight] = stale.calls

    await _terminate(losing._locks.pid)
    # The lock holder signals the loss: the document in flight is interrupted now.
    await asyncio.wait_for(stale.cancelled.wait(), timeout=5)

    fresh = _Ingestion(sessions)
    recovering = _worker(runtime, fresh)
    recovering_task = asyncio.create_task(recovering.run())
    try:
        await _until_finished(sessions, run_id)
    finally:
        await _stop(recovering, recovering_task)
    tasks = await task_items(sessions, run_id)
    assert (await _run(sessions, run_id)).status == "succeeded"
    assert (tasks[in_flight].status, tasks[in_flight].error_class) == ("failed", "interrupted")
    assert sorted(fresh.calls) == sorted(item for item in items if item != in_flight)

    # The stale executor finishes its document after all: it must not write.
    stale.gate.set()
    await _stop(losing, losing_task)
    assert stale.finished == [in_flight]
    after = await task_items(sessions, run_id)
    assert (after[in_flight].status, after[in_flight].error_class) == ("failed", "interrupted")
    assert after[in_flight].chunk_count is None
    assert (await _run(sessions, run_id)).status == "succeeded"


async def test_a_write_under_a_lost_claim_is_refused(
    sessions: Sessions, world: World, runtime: AppRuntime
) -> None:
    workspace, items = await _documents(sessions, world, 2)
    run_id = await _queue(runtime, workspace, items)
    engine = runtime.ingestion_run_service()
    key = run_lock_key(run_id)
    async with held_lock(key) as connection:
        claim = LockClaim(key=key, pid=await connection.scalar(select(func.pg_backend_pid())))
        await engine.start(run_id, owner=claim)
        assert await engine.claim_item(run_id, items[0], owner=claim)
    # The claim's connection is gone (and its lock with it).

    with pytest.raises(OwnershipLost):
        await engine.record_item_outcome(
            run_id, items[0], status="succeeded", phases=[], chunk_count=4, owner=claim
        )
    with pytest.raises(OwnershipLost):
        await engine.claim_item(run_id, items[1], owner=claim)
    with pytest.raises(OwnershipLost):
        await engine.finish(run_id, outcome="succeeded", owner=claim)

    tasks = await task_items(sessions, run_id)
    assert (tasks[items[0]].status, tasks[items[0]].chunk_count) == ("running", None)
    assert tasks[items[1]].status == "queued"
    assert (await _run(sessions, run_id)).status == "running"


async def test_claiming_pages_past_runs_other_workers_hold(
    sessions: Sessions, world: World, runtime: AppRuntime
) -> None:
    workspace, items = await _documents(sessions, world, 23)
    run_ids = [await _queue(runtime, workspace, [item]) for item in items]
    held, free = run_ids[:-1], run_ids[-1]
    ingestion = _Ingestion(sessions)
    worker = _worker(runtime, ingestion, max_concurrent_runs=1)

    # 22 older runs (more than one page) belong to other workers.
    async with held_lock(*(run_lock_key(run_id) for run_id in held)):
        task = asyncio.create_task(worker.run())
        try:
            await _until_finished(sessions, free)
        finally:
            await _stop(worker, task)

    assert (await _run(sessions, free)).status == "succeeded"
    assert ingestion.calls == [items[-1]]
    async with sessions.begin() as session:
        statuses = set(
            await session.scalars(select(IngestionRun.status).where(IngestionRun.id.in_(held)))
        )
    assert statuses == {"queued"}


async def _until_cover(sessions: Sessions, item_id: UUID, timeout: float = 10.0) -> dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        async with sessions.begin() as session:
            item = await session.get(Item, item_id)
            assert item is not None
            cover = item.metadata_.get("cover")
            if cover is not None and cover.get("source") == item.storage_key:
                return cover
        assert asyncio.get_running_loop().time() < deadline, "no cover was produced in time"
        await asyncio.sleep(0.05)


async def test_covers_come_from_notifications_and_the_startup_sweep(
    sessions: Sessions, world: World, runtime: AppRuntime
) -> None:
    workspace = await world.make_workspace(await world.make_user())
    handbook = await world.make_collection(workspace, title="Handbook")
    storage = runtime.object_storage()
    # Stored while no worker listened: only the sweep can find it.
    older = await document(sessions, handbook, title="older.txt", size_bytes=6)
    assert older.storage_key is not None
    storage.put_bytes(b"older\n", older.storage_key, content_type="text/plain")
    worker = _worker(
        runtime, _Ingestion(sessions), covers=DocumentCovers(sessions, storage)
    )

    task = asyncio.create_task(worker.run())
    try:
        assert (await _until_cover(sessions, older.id))["lines"] == ["older"]
        # Content arriving while the worker runs is notified.
        newer = await document(sessions, handbook, title="newer.txt", stored=False)
        key = f"workspaces/{workspace.id}/items/{newer.id}/1"
        storage.put_bytes(b"newer\n", key, content_type="text/plain")
        async with sessions.begin() as session:
            row = await session.get(Item, newer.id)
            assert row is not None
            await ItemService(session).append_revision(
                row, storage_key=key, mime_type="text/plain", size_bytes=6
            )
        assert (await _until_cover(sessions, newer.id, timeout=5.0))["lines"] == ["newer"]
    finally:
        await _stop(worker, task)
