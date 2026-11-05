"""The run engine below the API: batching, the run's Activities, cancelling, reconciling.

The engine tests run against the harness PostgreSQL schema with a scripted
Temporal boundary; the workflow tests run the real workflow on Temporal's
time-skipping test server with fake Activities.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select, update
from temporalio import activity
from temporalio.client import WorkflowFailureError
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment, WorkflowEnvironment
from temporalio.worker import Worker
from temporalio.worker.workflow_sandbox import SandboxedWorkflowRunner, SandboxRestrictions

from config import IngestionRunConfig

from bomesh.db.models import (
    ExternalResource,
    IngestionRun,
    IngestionSource,
    IntegrationConnection,
    Item,
    Tenant,
)
from bomesh.document_index import EmbeddingRejectedError
from bomesh.errors import StatusCode, Unavailable
from bomesh.runtime import AppRuntime
from bomesh.services import DocumentProcessingError, current_processing_version
from bomesh.services.knowledge_items.archive_expansion import ArchiveExpansionResult
from bomesh.services.ingestion.run_engine import (
    START_FAILED_MESSAGE,
    STOPPED_MESSAGE,
    IngestionRunService,
    RunSelection,
)
from bomesh.services.knowledge_items.item_store import ItemService
from bomesh.services.knowledge_items.indexing import INTERRUPTED_MESSAGE
from bomesh.services.workflow import (
    FAIL_BATCH_ACTIVITY,
    FINISH_RUN_ACTIVITY,
    PLAN_BATCHES_ACTIVITY,
    PROCESS_BATCH_ACTIVITY,
    PROVIDER_REJECTED_FAILURE_TYPE,
    START_RUN_ACTIVITY,
    FailBatchInput,
    FinishRunInput,
    IngestionRunInput,
    PlanBatchesInput,
    ProcessBatchInput,
    RunBatch,
    RunStart,
    SourceSyncInput,
)
from bomesh.services.workflow.ingestion_activity import (
    IngestionRunActivities,
    MaintenanceActivities,
    SourceSyncActivities,
)
from bomesh.services.workflow.ingestion_workflow import IngestionRunWorkflow
from harness import Fakes, Sessions, World
from runs_support import document, pause_ingestion, set_run, task_items

pytestmark = pytest.mark.asyncio

SIGNATURE = {
    "embedding_model": "test-embedding",
    "index_schema_version": 1,
    "contextualization_enabled": False,
    "contextualization_model": None,
}
CURRENT = current_processing_version(SIGNATURE)


class _Workflows:
    """The Temporal boundary, as the run engine sees it."""

    def __init__(self) -> None:
        self.started: list[UUID] = []
        self.cancel_requests: list[UUID] = []
        self.open = True
        self.reachable = True
        self.fail_start = False

    async def start_run(self, run_id: UUID, tenant_id: UUID) -> None:
        if self.fail_start:
            raise RuntimeError("temporal is unavailable")
        self.started.append(run_id)

    async def cancel_run(self, run_id: UUID) -> bool:
        self.cancel_requests.append(run_id)
        return self.open

    async def run_is_open(self, run_id: UUID) -> bool:
        if not self.reachable:
            raise RuntimeError("temporal is unavailable")
        return self.open

    async def source_sync_is_open(self, source_id: UUID) -> bool:
        if not self.reachable:
            raise RuntimeError("temporal is unavailable")
        return self.open


def _engine(
    sessions: Sessions,
    workflows: _Workflows,
    *,
    batch_max_items: int = 8,
    batch_max_bytes: int = 64 * 1024 * 1024,
    parallelism: int = 4,
) -> IngestionRunService:
    return IngestionRunService(
        sessions,
        workflows=workflows,  # type: ignore[arg-type]
        processing_signature=lambda: SIGNATURE,
        run_config=IngestionRunConfig(
            batch_max_items=batch_max_items,
            batch_max_bytes=batch_max_bytes,
            parallelism=parallelism,
        ),
    )


async def _create(
    engine: IngestionRunService,
    sessions: Sessions,
    workspace: Tenant,
    selection: RunSelection,
) -> UUID:
    """A run over ``selection`` in every collection, launched."""
    async with sessions.begin() as session:
        run = await engine.snapshot(
            session,
            workspace_id=workspace.id,
            selection=selection,
            collections=None,
            trigger="manual",
            created_by_user_id=None,
        )
        run_id, count = run.id, run.item_count
    await engine.launch(run_id, workspace.id, item_count=count)
    return run_id


async def _run(sessions: Sessions, run_id: UUID) -> IngestionRun:
    async with sessions.begin() as session:
        run = await session.get(IngestionRun, run_id)
        assert run is not None
        return run


async def _index_status(sessions: Sessions, item_id: UUID) -> str | None:
    async with sessions.begin() as session:
        return await session.scalar(select(Item.index_status).where(Item.id == item_id))


async def _workspace(world: World) -> tuple[Tenant, Item]:
    workspace = await world.make_workspace(await world.make_user())
    return workspace, await world.make_collection(workspace, title="Handbook")


# -- Snapshot and planning -----------------------------------------------------


async def test_two_hundred_documents_are_one_run_in_bounded_batches(
    sessions: Sessions, world: World
) -> None:
    workspace, handbook = await _workspace(world)
    for _ in range(200):
        await document(sessions, handbook)
    workflows = _Workflows()
    engine = _engine(sessions, workflows)

    run_id = await _create(engine, sessions, workspace, RunSelection(ancestor=handbook.id))
    await engine.start(run_id)
    batches = await engine.plan_batches(run_id, first_batch_number=0, max_batches=100)

    assert workflows.started == [run_id]
    assert (await _run(sessions, run_id)).item_count == 200
    assert [number for number, _ in batches] == list(range(25))
    assert {len(item_ids) for _, item_ids in batches} == {8}
    assert len({item_id for _, item_ids in batches for item_id in item_ids}) == 200


async def test_batches_are_packed_by_size_and_planning_is_idempotent(
    sessions: Sessions, world: World
) -> None:
    workspace, handbook = await _workspace(world)
    sizes = {"a": 10, "b": 10, "c": 10, "d": 10, "e": 60, "f": 60, "huge": 500}
    ids = {
        name: (await document(sessions, handbook, size_bytes=size)).id
        for name, size in sizes.items()
    }
    engine = _engine(sessions, _Workflows(), batch_max_items=3, batch_max_bytes=100)
    run_id = await _create(engine, sessions, workspace, RunSelection(ancestor=handbook.id))
    assert await engine.start(run_id) == (True, 4)

    first = await engine.plan_batches(run_id, first_batch_number=0, max_batches=2)
    # A retried planning call answers with the batches it already made.
    assert await engine.plan_batches(run_id, first_batch_number=0, max_batches=2) == first
    rest = await engine.plan_batches(run_id, first_batch_number=2, max_batches=5)

    packed = [
        (number, sorted(sizes[name] for name, item_id in ids.items() if item_id in item_ids))
        for number, item_ids in first + rest
    ]
    # At most three per batch and 100 bytes, smallest first; a file over the
    # byte limit is a batch of its own.
    assert packed == [(0, [10, 10, 10]), (1, [10, 60]), (2, [60]), (3, [500])]
    assert await engine.plan_batches(run_id, first_batch_number=4, max_batches=5) == []


# -- Processing a batch ---------------------------------------------------------


class _Ingestion:
    """The processing core: what each Document does when processed."""

    def __init__(self, outcomes: dict[UUID, list[Any]]) -> None:
        self._outcomes = outcomes
        self.calls: list[UUID] = []

    def processing_version(self) -> str:
        return CURRENT

    async def process_document(self, document_id: UUID, *, tenant_id: UUID, progress: Any) -> int:
        self.calls.append(document_id)
        progress("parsing", 0, 0)
        progress("storing", 3, 3)
        planned = self._outcomes.get(document_id)
        outcome = planned.pop(0) if planned else 3
        if isinstance(outcome, BaseException):
            raise outcome
        return int(outcome)


class _Archives:
    def __init__(self, archive_id: UUID | None = None, members: tuple[UUID, ...] = ()) -> None:
        self._archive_id = archive_id
        self._members = members

    async def expand_if_archive(
        self, document_id: UUID, *, tenant_id: UUID, processed_version: str, progress: Any
    ) -> ArchiveExpansionResult | None:
        if document_id != self._archive_id:
            return None
        progress("expanding", len(self._members), len(self._members))
        return ArchiveExpansionResult(archive_id=document_id, document_ids=self._members, skipped=0)


def _activities(
    engine: IngestionRunService, ingestion: _Ingestion, archives: _Archives | None = None
) -> IngestionRunActivities:
    return IngestionRunActivities(
        runs=engine,
        ingestion=ingestion,  # type: ignore[arg-type]
        archives=archives or _Archives(),  # type: ignore[arg-type]
    )


async def _process(
    activities: IngestionRunActivities,
    run_id: UUID,
    workspace: Tenant,
    number: int,
    item_ids: list[UUID],
) -> None:
    await ActivityEnvironment().run(
        activities.process_batch,
        ProcessBatchInput(
            run_id=str(run_id),
            tenant_id=str(workspace.id),
            batch_number=number,
            item_ids=[str(item_id) for item_id in item_ids],
        ),
    )


async def test_one_failing_document_does_not_fail_its_batch_and_a_retry_skips_finished_ones(
    sessions: Sessions, world: World
) -> None:
    workspace, handbook = await _workspace(world)
    good = (await document(sessions, handbook)).id
    broken = (await document(sessions, handbook)).id
    flaky = (await document(sessions, handbook)).id
    engine = _engine(sessions, _Workflows())
    run_id = await _create(engine, sessions, workspace, RunSelection(ancestor=handbook.id))
    await engine.start(run_id)
    ingestion = _Ingestion(
        {
            broken: [DocumentProcessingError("the file could not be read")],
            flaky: [ConnectionError("index unreachable"), 7],
        }
    )
    activities = _activities(engine, ingestion)

    # The index is down while the flaky one runs: the batch fails and Temporal retries it.
    with pytest.raises(ConnectionError):
        await _process(activities, run_id, workspace, 0, [good, broken, flaky])
    tasks = await task_items(sessions, run_id)
    assert tasks[good].status == "succeeded" and tasks[good].chunk_count == 3
    assert tasks[good].revision_number == 1
    assert tasks[broken].status == "failed"
    assert tasks[broken].error == {
        "code": StatusCode.INTERNAL,
        "message": "The file could not be read.",
    }
    assert tasks[broken].error_class == "unsupported_format"
    assert tasks[flaky].status == "running"

    await _process(activities, run_id, workspace, 0, [good, broken, flaky])

    tasks = await task_items(sessions, run_id)
    assert tasks[flaky].status == "succeeded" and tasks[flaky].chunk_count == 7
    assert tasks[flaky].error_class is None
    assert [phase["phase"] for phase in tasks[flaky].phases] == ["parsing", "storing"]
    # Finished Documents were not processed a second time.
    assert ingestion.calls == [good, broken, flaky, flaky]

    await engine.finish(run_id, outcome="succeeded")
    assert (await _run(sessions, run_id)).status == "succeeded"


async def test_a_provider_refusal_stops_the_run_and_cancels_what_is_left(
    sessions: Sessions, world: World
) -> None:
    workspace, handbook = await _workspace(world)
    refused = (await document(sessions, handbook)).id
    behind = (await document(sessions, handbook)).id
    later = (await document(sessions, handbook)).id
    engine = _engine(sessions, _Workflows(), batch_max_items=2)
    run_id = await _create(engine, sessions, workspace, RunSelection(ancestor=handbook.id))
    await engine.start(run_id)
    ingestion = _Ingestion({refused: [EmbeddingRejectedError(402, "no credit left")]})

    with pytest.raises(ApplicationError) as raised:
        await _process(_activities(engine, ingestion), run_id, workspace, 0, [refused, behind])
    assert raised.value.type == PROVIDER_REJECTED_FAILURE_TYPE
    assert raised.value.non_retryable
    assert "no credit" not in raised.value.message

    error = {"code": StatusCode.FAILED_PRECONDITION, "message": raised.value.message}
    await engine.finish(run_id, outcome="failed", error=error)

    run = await _run(sessions, run_id)
    tasks = await task_items(sessions, run_id)
    assert run.status == "failed" and run.error == error
    assert tasks[refused].status == "failed"
    assert tasks[refused].error_class == "provider_refused"
    assert tasks[behind].status == "cancelled" and tasks[later].status == "cancelled"
    assert tasks[later].error == error
    assert ingestion.calls == [refused]


async def test_an_archives_members_join_the_run_that_expanded_it(
    sessions: Sessions, world: World
) -> None:
    workspace, handbook = await _workspace(world)
    archive = (await document(sessions, handbook)).id
    members = (
        (await document(sessions, handbook)).id,
        (await document(sessions, handbook)).id,
    )
    engine = _engine(sessions, _Workflows())
    run_id = await _create(engine, sessions, workspace, RunSelection(items=(archive,)))
    await engine.start(run_id)
    assert await engine.plan_batches(run_id, first_batch_number=0, max_batches=4) == [
        (0, [archive])
    ]
    ingestion = _Ingestion({})

    await _process(
        _activities(engine, ingestion, _Archives(archive, members)), run_id, workspace, 0, [archive]
    )

    tasks = await task_items(sessions, run_id)
    assert tasks[archive].status == "succeeded"
    assert {item_id for item_id, row in tasks.items() if row.status == "queued"} == set(members)
    assert (await _run(sessions, run_id)).item_count == 3
    later = await engine.plan_batches(run_id, first_batch_number=1, max_batches=4)
    assert [(number, set(item_ids)) for number, item_ids in later] == [(1, set(members))]
    # The archive itself was expanded, never parsed.
    assert ingestion.calls == []


async def test_a_scheduled_run_processes_what_its_source_left_pending(
    sessions: Sessions, world: World
) -> None:
    workspace, handbook = await _workspace(world)
    synced = (await document(sessions, handbook)).id
    current = (
        await document(sessions, handbook, index_status="ready", processed_version=CURRENT)
    ).id
    uploaded = (await document(sessions, handbook)).id
    async with sessions.begin() as session:
        connection = IntegrationConnection(
            tenant_id=workspace.id,
            code=f"c{uuid4().hex[:12]}",
            connector_key="confluence",
            display_name="Wiki",
        )
        session.add(connection)
        await session.flush()
        source = IngestionSource(
            tenant_id=workspace.id,
            code="wiki",
            integration_connection_id=connection.id,
            target_item_id=handbook.id,
        )
        session.add(source)
        await session.flush()
        for external_id, item_id in (("page-1", synced), ("page-2", current)):
            session.add(
                ExternalResource(
                    item_id=item_id, ingestion_source_id=source.id, external_id=external_id
                )
            )
        source_id = source.id
    workflows = _Workflows()
    engine = _engine(sessions, workflows)
    activities = SourceSyncActivities(sync=None, runs=engine)  # type: ignore[arg-type]
    scheduled = SourceSyncInput(source_id=str(source_id), tenant_id=str(workspace.id), process=True)

    run_id = await ActivityEnvironment().run(activities.create_scheduled_run, scheduled)

    assert run_id is not None
    assert set(await task_items(sessions, run_id)) == {synced}
    run = await _run(sessions, UUID(run_id))
    assert run.trigger_type == "schedule" and run.created_by_user_id is None
    assert run.scope == {"source_id": str(source_id), "states": ["PENDING", "OUTDATED"]}
    assert uploaded not in await task_items(sessions, run_id)
    # The next firing finds nothing waiting: that is not a failure, and no run is kept.
    assert await ActivityEnvironment().run(activities.create_scheduled_run, scheduled) is None
    assert workflows.started == [UUID(run_id)]
    # A paused workspace skips its schedules silently.
    await set_run(sessions, run_id, status="succeeded")
    await pause_ingestion(sessions, workspace)
    assert await engine.create_scheduled_run(workspace.id, source_id) is None
    async with sessions.begin() as session:
        assert len(list(await session.scalars(select(IngestionRun.id)))) == 1


# -- Cancelling, failing, reconciling ---------------------------------------------


async def _claim_and_mark_processing(
    engine: IngestionRunService, sessions: Sessions, run_id: UUID, item_id: UUID
) -> None:
    assert await engine.claim_item(run_id, item_id)
    async with sessions.begin() as session:
        await ItemService(session).mark_index_processing(item_id)


async def test_cancel_stops_queued_documents_now_and_returns_interrupted_ones_to_pending(
    sessions: Sessions, world: World
) -> None:
    workspace, handbook = await _workspace(world)
    started = (await document(sessions, handbook)).id
    waiting = (await document(sessions, handbook)).id
    workflows = _Workflows()
    engine = _engine(sessions, workflows)
    run_id = await _create(engine, sessions, workspace, RunSelection(ancestor=handbook.id))
    await engine.start(run_id)
    await _claim_and_mark_processing(engine, sessions, run_id, started)

    async with sessions.begin() as session:
        run = await session.get(IngestionRun, run_id, with_for_update=True)
        assert run is not None
        await engine.mark_cancelled(session, run)
    await engine.stop(run_id)

    assert workflows.cancel_requests == [run_id]
    tasks = await task_items(sessions, run_id)
    assert tasks[waiting].status == "cancelled"
    assert tasks[started].status == "running"
    # A batch that sees the cancel takes nothing more.
    assert not await engine.claim_item(run_id, waiting)

    await engine.finish(run_id, outcome="cancelled")
    tasks = await task_items(sessions, run_id)
    assert tasks[started].status == "cancelled"
    assert await _index_status(sessions, started) == "pending"

    # Without an open workflow, a cancel settles the run at once.
    other = await _create(engine, sessions, workspace, RunSelection(items=(waiting,)))
    workflows.open = False
    async with sessions.begin() as session:
        run = await session.get(IngestionRun, other, with_for_update=True)
        assert run is not None
        await engine.mark_cancelled(session, run)
    await engine.stop(other)
    assert (await _run(sessions, other)).finished_at is not None


async def test_a_batch_that_keeps_failing_fails_its_unfinished_documents(
    sessions: Sessions, world: World
) -> None:
    workspace, handbook = await _workspace(world)
    done = (await document(sessions, handbook)).id
    stuck = (await document(sessions, handbook)).id
    untouched = (await document(sessions, handbook)).id
    engine = _engine(sessions, _Workflows())
    run_id = await _create(engine, sessions, workspace, RunSelection(ancestor=handbook.id))
    await engine.start(run_id)
    await engine.plan_batches(run_id, first_batch_number=0, max_batches=1)
    assert await engine.claim_item(run_id, done)
    await engine.record_item_outcome(run_id, done, status="succeeded", chunk_count=2, phases=[])
    await _claim_and_mark_processing(engine, sessions, run_id, stuck)

    await engine.fail_batch(run_id, 0)

    tasks = await task_items(sessions, run_id)
    assert tasks[done].status == "succeeded"
    assert tasks[stuck].status == "failed" and tasks[stuck].error == {
        "code": StatusCode.ABORTED,
        "message": INTERRUPTED_MESSAGE,
    }
    assert tasks[stuck].error_class == "interrupted"
    assert tasks[untouched].status == "failed" and tasks[untouched].error_class == "interrupted"
    assert await _index_status(sessions, stuck) == "failed"


async def test_a_run_whose_workflow_cannot_start_fails_and_holds_nothing(
    sessions: Sessions, world: World
) -> None:
    workspace, handbook = await _workspace(world)
    doc = (await document(sessions, handbook)).id
    workflows = _Workflows()
    workflows.fail_start = True
    engine = _engine(sessions, workflows)

    with pytest.raises(Unavailable):
        await _create(engine, sessions, workspace, RunSelection(items=(doc,)))

    async with sessions.begin() as session:
        (run,) = list(await session.scalars(select(IngestionRun)))
    assert run.status == "failed"
    assert run.error == {"code": StatusCode.UNAVAILABLE, "message": START_FAILED_MESSAGE}
    workflows.fail_start = False
    again = await _create(engine, sessions, workspace, RunSelection(items=(doc,)))
    assert set(await task_items(sessions, again)) == {doc}


async def test_reconcile_ends_a_run_whose_workflow_is_gone(
    sessions: Sessions, world: World
) -> None:
    workspace, handbook = await _workspace(world)
    board = await world.make_collection(workspace, title="Board")
    started = (await document(sessions, handbook)).id
    waiting = (await document(sessions, handbook)).id
    stray = (await document(sessions, board, index_status="processing")).id
    workflows = _Workflows()
    engine = _engine(sessions, workflows)
    run_id = await _create(engine, sessions, workspace, RunSelection(ancestor=handbook.id))
    await engine.start(run_id)
    await _claim_and_mark_processing(engine, sessions, run_id, started)
    await set_run(sessions, run_id, updated_at=datetime.now(UTC) - timedelta(minutes=10))

    # Temporal unreachable proves nothing; an open workflow is left alone.
    workflows.reachable = False
    await engine.reconcile()
    workflows.reachable = True
    await engine.reconcile()
    assert (await _run(sessions, run_id)).status == "running"
    assert await _index_status(sessions, started) == "processing"

    workflows.open = False
    await engine.reconcile()

    run = await _run(sessions, run_id)
    tasks = await task_items(sessions, run_id)
    assert run.status == "failed" and run.error == {
        "code": StatusCode.INTERNAL,
        "message": STOPPED_MESSAGE,
    }
    assert tasks[started].status == "cancelled" and tasks[waiting].status == "cancelled"
    assert await _index_status(sessions, started) == "pending"
    # A Document left processing outside any run waits again too.
    assert await _index_status(sessions, stray) == "pending"


# -- Maintenance -------------------------------------------------------------------


async def test_the_maintenance_activities_reconcile_payloads_and_purge_deleted_items(
    sessions: Sessions, world: World, runtime: AppRuntime, fakes: Fakes
) -> None:
    _, handbook = await _workspace(world)
    dirty = (await document(sessions, handbook)).id
    expired = await document(sessions, handbook)
    assert expired.storage_key is not None
    fakes.storage.put_bytes(b"bytes", expired.storage_key, content_type="text/plain")
    async with sessions.begin() as session:
        await session.execute(
            update(Item).where(Item.id == dirty).values(payload_dirty_at=datetime.now(UTC))
        )
        await session.execute(
            update(Item)
            .where(Item.id == expired.id)
            .values(deleted_at=datetime.now(UTC) - timedelta(days=365))
        )
    activities = MaintenanceActivities(
        runtime.sessions(), index=runtime.item_index(), storage=runtime.object_storage()
    )

    cleaned = await ActivityEnvironment().run(activities.reconcile_payloads)
    purged = await ActivityEnvironment().run(activities.purge_deleted_items)

    assert cleaned == 1 and purged == 1
    assert fakes.storage.objects == {}
    async with sessions.begin() as session:
        assert await session.scalar(select(Item.payload_dirty_at).where(Item.id == dirty)) is None
    assert await ActivityEnvironment().run(activities.purge_deleted_items) == 0


# -- The workflow --------------------------------------------------------------------


class _FakeRun:
    """Activities standing in for the database: a fixed set of batches."""

    def __init__(self, batches: int, *, parallelism: int) -> None:
        self.batches = [RunBatch(number=n, item_ids=[f"item-{n}"]) for n in range(batches)]
        self.parallelism = parallelism
        self.in_flight = 0
        self.max_in_flight = 0
        self.processed: list[int] = []
        self.failed_batches: list[int] = []
        self.finished: list[FinishRunInput] = []
        self.refuse: set[int] = set()
        self.break_: set[int] = set()
        self.hang = False
        self.cancelled: list[int] = []
        self.started = asyncio.Event()

    @activity.defn(name=START_RUN_ACTIVITY)
    async def start_run(self, run_id: str) -> RunStart:
        return RunStart(active=True, parallelism=self.parallelism)

    @activity.defn(name=PLAN_BATCHES_ACTIVITY)
    async def plan_batches(self, input: PlanBatchesInput) -> list[RunBatch]:
        return [b for b in self.batches if b.number >= input.first_batch_number][: input.max_batches]

    @activity.defn(name=PROCESS_BATCH_ACTIVITY)
    async def process_batch(self, input: ProcessBatchInput) -> None:
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        self.started.set()
        try:
            if input.batch_number in self.refuse:
                raise ApplicationError(
                    "The embedding provider refused the request.",
                    type=PROVIDER_REJECTED_FAILURE_TYPE,
                    non_retryable=True,
                )
            if input.batch_number in self.break_:
                raise ApplicationError("index unreachable", non_retryable=False)
            if self.hang:
                while True:
                    activity.heartbeat()
                    await asyncio.sleep(0.05)
            await asyncio.sleep(0.05)
            self.processed.append(input.batch_number)
        except asyncio.CancelledError:
            self.cancelled.append(input.batch_number)
            raise
        finally:
            self.in_flight -= 1

    @activity.defn(name=FAIL_BATCH_ACTIVITY)
    async def fail_batch(self, input: FailBatchInput) -> None:
        self.failed_batches.append(input.batch_number)

    @activity.defn(name=FINISH_RUN_ACTIVITY)
    async def finish_run(self, input: FinishRunInput) -> None:
        self.finished.append(input)

    def all(self) -> list[Any]:
        return [self.start_run, self.plan_batches, self.process_batch, self.fail_batch, self.finish_run]


async def _run_workflow(fake: _FakeRun, *, cancel: bool = False) -> None:
    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(
            env.client,
            task_queue="runs",
            workflows=[IngestionRunWorkflow],
            activities=fake.all(),
            default_heartbeat_throttle_interval=timedelta(seconds=1),
            max_heartbeat_throttle_interval=timedelta(seconds=1),
            workflow_runner=SandboxedWorkflowRunner(
                restrictions=SandboxRestrictions.default.with_passthrough_modules(
                    "bomesh.services",
                    "bomesh.services.workflow",
                    "bomesh.services.workflow.ingestion_workflow",
                )
            ),
        ):
            handle = await env.client.start_workflow(
                IngestionRunWorkflow.run,
                IngestionRunInput(run_id="run-1", tenant_id="tenant-1"),
                id="ingestion-run:run-1",
                task_queue="runs",
            )
            if cancel:
                await asyncio.wait_for(fake.started.wait(), timeout=30)
                await handle.cancel()
                with pytest.raises(WorkflowFailureError):
                    await handle.result()
            else:
                await handle.result()


async def test_the_workflow_runs_every_batch_with_bounded_concurrency() -> None:
    fake = _FakeRun(7, parallelism=2)

    await _run_workflow(fake)

    assert sorted(fake.processed) == list(range(7))
    assert fake.max_in_flight == 2
    assert [(f.outcome, f.error) for f in fake.finished] == [("succeeded", None)]


async def test_a_provider_refusal_stops_planning_and_fails_the_run() -> None:
    fake = _FakeRun(10, parallelism=2)
    fake.refuse = {1}

    await _run_workflow(fake)

    assert len(fake.processed) < 9
    assert fake.failed_batches == []
    assert [(f.outcome, f.error) for f in fake.finished] == [
        ("failed", "The embedding provider refused the request.")
    ]


async def test_a_batch_that_exhausts_its_retries_is_failed_and_the_run_goes_on() -> None:
    fake = _FakeRun(3, parallelism=2)
    fake.break_ = {0}

    await _run_workflow(fake)

    assert fake.failed_batches == [0]
    assert sorted(fake.processed) == [1, 2]
    assert [f.outcome for f in fake.finished] == ["succeeded"]


async def test_cancelling_the_workflow_stops_batches_and_still_finishes_the_run() -> None:
    fake = _FakeRun(4, parallelism=2)
    fake.hang = True

    await _run_workflow(fake, cancel=True)

    assert fake.cancelled
    assert [f.outcome for f in fake.finished] == ["cancelled"]
