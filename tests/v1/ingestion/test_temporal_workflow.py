"""[temporal-disabled] The Temporal ``IngestionRunWorkflow`` on the time-skipping test server.

Temporal is disabled in this phase (the ingestion worker executes runs); the
workflow code is kept, unwired, and so are these tests, skipped.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import select
from temporalio import activity
from temporalio.client import WorkflowFailureError
from temporalio.exceptions import ApplicationError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker
from temporalio.worker.workflow_sandbox import SandboxedWorkflowRunner, SandboxRestrictions

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
)
from bomesh.db.models import IngestionRun, Item, Tenant
from bomesh.errors import StatusCode, Unavailable
from bomesh.services.ingestion.run_engine import (
    STOPPED_MESSAGE,
    IngestionRunService,
    RunSelection,
)
from bomesh.services.knowledge_items.item_store import ItemService
from bomesh.services.knowledge_items.queries import has_ancestor
from bomesh.services.workflow.ingestion_workflow import IngestionRunWorkflow
from config import IngestionRunConfig
from harness import Sessions, World
from runs_support import document, set_run, task_items

pytestmark = [pytest.mark.asyncio, pytest.mark.skip(reason="Temporal disabled")]


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


# -- The run engine's Temporal boundary (start, reconcile) ------------------------------

START_FAILED_MESSAGE = "Processing could not be started. Try again in a moment."
SIGNATURE = {
    "embedding_model": "test-embedding",
    "index_schema_version": 1,
    "contextualization_enabled": False,
    "contextualization_model": None,
}


class _Workflows:
    """The Temporal boundary, as the run engine saw it."""

    def __init__(self) -> None:
        self.started: list[UUID] = []
        self.open = True
        self.reachable = True
        self.fail_start = False

    async def start_run(self, run_id: UUID, tenant_id: UUID) -> None:
        if self.fail_start:
            raise RuntimeError("temporal is unavailable")
        self.started.append(run_id)

    async def run_is_open(self, run_id: UUID) -> bool:
        if not self.reachable:
            raise RuntimeError("temporal is unavailable")
        return self.open

    async def source_sync_is_open(self, source_id: UUID) -> bool:
        if not self.reachable:
            raise RuntimeError("temporal is unavailable")
        return self.open


def _engine(sessions: Sessions, workflows: _Workflows) -> IngestionRunService:
    return IngestionRunService(
        sessions,
        workflows=workflows,  # type: ignore[call-arg]
        processing_signature=lambda: SIGNATURE,
        run_config=IngestionRunConfig(),
    )


async def _create(
    engine: IngestionRunService, sessions: Sessions, workspace: Tenant, selection: RunSelection
) -> UUID:
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
    await engine.launch(run_id, workspace.id, item_count=count)  # type: ignore[call-arg]
    return run_id


async def _workspace(world: World) -> tuple[Tenant, Item]:
    workspace = await world.make_workspace(await world.make_user())
    return workspace, await world.make_collection(workspace, item_name="Handbook")


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
    board = await world.make_collection(workspace, item_name="Board")
    started = (await document(sessions, handbook)).id
    waiting = (await document(sessions, handbook)).id
    stray = (await document(sessions, board, index_status="processing")).id
    workflows = _Workflows()
    engine = _engine(sessions, workflows)
    selection = RunSelection(
        filter=f'ancestors:"{handbook.id}"',
        filter_items=frozenset({handbook.id}),
        where=has_ancestor(handbook.id),
    )
    run_id = await _create(engine, sessions, workspace, selection)
    await engine.start(run_id)
    assert await engine.claim_item(run_id, started)
    async with sessions.begin() as session:
        await ItemService(session).mark_index_processing(started)
    await set_run(sessions, run_id, updated_at=datetime.now(UTC) - timedelta(minutes=10))

    workflows.reachable = False
    await engine.reconcile()  # type: ignore[attr-defined]
    workflows.reachable = True
    workflows.open = False
    await engine.reconcile()  # type: ignore[attr-defined]

    async with sessions.begin() as session:
        run = await session.get(IngestionRun, run_id)
    tasks = await task_items(sessions, run_id)
    assert run is not None and run.status == "failed"
    assert run.error == {"code": StatusCode.INTERNAL, "message": STOPPED_MESSAGE}
    assert tasks[started].status == "cancelled" and tasks[waiting].status == "cancelled"
    async with sessions.begin() as session:
        assert await session.scalar(select(Item.index_status).where(Item.id == stray)) == "pending"
