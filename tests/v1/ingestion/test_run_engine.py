"""The run engine below the API: batching, processing a batch, cancelling, recovering.

The engine and the worker's :class:`RunExecutor` run against the harness
PostgreSQL schema with a scripted processing core.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select, update

from config import IngestionRunConfig

from bomesh.db.models import (
    ExternalResource,
    IngestionRun,
    IngestionSource,
    IntegrationConnection,
    Item,
    ItemIndexState,
    Tenant,
)
from bomesh.document_index import EmbeddingRejectedError
from bomesh.errors import StatusCode
from bomesh.runtime import AppRuntime
from bomesh.services import DocumentProcessingError, current_processing_version
from bomesh.services.ingestion.executor import PLAN_AHEAD, ProviderRefused, RunExecutor
from bomesh.services.knowledge_items.archive_expansion import ArchiveExpansionResult
from bomesh.services.ingestion.run_engine import (
    IngestionRunService,
    RunSelection,
    run_lock_key,
)
from bomesh.services.knowledge_items.indexing import (
    INTERRUPTED_MESSAGE,
    reconcile_dirty_payloads,
)
from bomesh.services.knowledge_items.item_store import ItemService
from bomesh.services.knowledge_items.purge import purge_deleted_items
from bomesh.services.knowledge_items.queries import has_ancestor
from harness import Fakes, Sessions, World
from runs_support import document, held_lock, pause_ingestion, set_run, task_items

pytestmark = pytest.mark.asyncio

SIGNATURE = {
    "embedding_model": "test-embedding",
    "index_schema_version": 1,
    "contextualization_enabled": False,
    "contextualization_model": None,
}
CURRENT = current_processing_version(SIGNATURE)


def _engine(
    sessions: Sessions,
    *,
    batch_max_items: int = 8,
    batch_max_bytes: int = 64 * 1024 * 1024,
    parallelism: int = 4,
) -> IngestionRunService:
    return IngestionRunService(
        sessions,
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
    await engine.launch(run_id, item_count=count)
    return run_id


def _subtree(collection_id: UUID) -> RunSelection:
    """What the API makes of ``filter: ancestors:"…/items/{collection}"``."""
    return RunSelection(
        filter=f'ancestors:"{collection_id}"',
        filter_items=frozenset({collection_id}),
        where=has_ancestor(collection_id),
    )


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


async def _plan_all(
    engine: IngestionRunService, run_id: UUID, *, max_batches: int
) -> list[tuple[int, list[UUID]]]:
    """Plan the whole run the way the executor does, ``max_batches`` per call."""
    planned: list[tuple[int, list[UUID]]] = []
    while batches := await engine.plan_batches(
        run_id, first_batch_number=len(planned), max_batches=max_batches
    ):
        planned.extend(batches)
    return planned


async def test_two_hundred_documents_are_one_queued_run_in_bounded_batches(
    sessions: Sessions, world: World
) -> None:
    workspace, handbook = await _workspace(world)
    for _ in range(200):
        await document(sessions, handbook)
    engine = _engine(sessions)

    run_id = await _create(engine, sessions, workspace, _subtree(handbook.id))
    # The QUEUED row is the queue: nothing else happens until a worker claims it.
    assert (await _run(sessions, run_id)).status == "queued"
    await engine.start(run_id)
    batches = await _plan_all(engine, run_id, max_batches=8)

    assert (await _run(sessions, run_id)).item_count == 200
    # Numbered without gaps; each batch within the item limit; every task planned once.
    assert [number for number, _ in batches] == list(range(len(batches)))
    assert all(1 <= len(item_ids) <= 8 for _, item_ids in batches)
    planned = [item_id for _, item_ids in batches for item_id in item_ids]
    assert len(planned) == len(set(planned)) == 200
    assert set(planned) == set(await task_items(sessions, run_id))


async def test_a_small_run_is_spread_over_its_parallelism(
    sessions: Sessions, world: World
) -> None:
    workspace, handbook = await _workspace(world)
    for _ in range(5):
        await document(sessions, handbook)
    engine = _engine(sessions, parallelism=4)
    run_id = await _create(engine, sessions, workspace, _subtree(handbook.id))
    _, parallelism = await engine.start(run_id)

    # The executor plans ``parallelism * PLAN_AHEAD`` batches per call.
    batches = await engine.plan_batches(
        run_id, first_batch_number=0, max_batches=parallelism * PLAN_AHEAD
    )

    assert len(batches) >= parallelism == 4
    planned = [item_id for _, item_ids in batches for item_id in item_ids]
    assert len(planned) == len(set(planned)) == 5


async def test_batches_are_packed_by_size_and_planning_is_idempotent(
    sessions: Sessions, world: World
) -> None:
    workspace, handbook = await _workspace(world)
    sizes = {"a": 10, "b": 10, "c": 10, "d": 10, "e": 60, "f": 60, "huge": 500}
    ids = {
        name: (await document(sessions, handbook, size_bytes=size)).id
        for name, size in sizes.items()
    }
    engine = _engine(sessions, batch_max_items=3, batch_max_bytes=100)
    run_id = await _create(engine, sessions, workspace, _subtree(handbook.id))
    assert await engine.start(run_id) == (True, 4)

    first = await engine.plan_batches(run_id, first_batch_number=0, max_batches=2)
    # A repeated planning call answers with the batches it already made.
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


async def test_an_empty_run_succeeds_at_once(sessions: Sessions, world: World) -> None:
    workspace, handbook = await _workspace(world)
    engine = _engine(sessions)

    run_id = await _create(engine, sessions, workspace, _subtree(handbook.id))

    run = await _run(sessions, run_id)
    assert (run.status, run.item_count) == ("succeeded", 0)
    assert run.finished_at is not None


# -- Processing a batch ---------------------------------------------------------


class _Ingestion:
    """The processing core: what each Document does when processed."""

    def __init__(self, outcomes: dict[UUID, list[Any]]) -> None:
        self._outcomes = outcomes
        self.calls: list[UUID] = []
        self.classifications: list[Any] = []

    def processing_version(self) -> str:
        return CURRENT

    async def classification_request(self, tenant_id: UUID, classification: Any) -> Any:
        return None

    async def process_document(
        self, document_id: UUID, *, tenant_id: UUID, progress: Any, classification: Any = None
    ) -> int:
        self.calls.append(document_id)
        self.classifications.append(classification)
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


def _executor(
    engine: IngestionRunService,
    run_id: UUID,
    ingestion: _Ingestion,
    archives: _Archives | None = None,
) -> RunExecutor:
    return RunExecutor(
        run_id,
        runs=engine,
        ingestion=ingestion,  # type: ignore[arg-type]
        archives=archives or _Archives(),  # type: ignore[arg-type]
        documents=asyncio.Semaphore(4),
    )


async def test_one_failing_document_does_not_fail_its_batch_and_a_retry_skips_finished_ones(
    sessions: Sessions, world: World
) -> None:
    workspace, handbook = await _workspace(world)
    good = (await document(sessions, handbook)).id
    broken = (await document(sessions, handbook)).id
    flaky = (await document(sessions, handbook)).id
    engine = _engine(sessions)
    run_id = await _create(engine, sessions, workspace, _subtree(handbook.id))
    await engine.start(run_id)
    ingestion = _Ingestion(
        {
            broken: [DocumentProcessingError("the file could not be read")],
            flaky: [ConnectionError("index unreachable"), 7],
        }
    )
    executor = _executor(engine, run_id, ingestion)

    # The index is down while the flaky one runs: the batch fails and is retried.
    with pytest.raises(ConnectionError):
        await executor.process_batch(workspace.id, [good, broken, flaky])
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

    await executor.process_batch(workspace.id, [good, broken, flaky])

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
    engine = _engine(sessions, batch_max_items=2)
    run_id = await _create(engine, sessions, workspace, _subtree(handbook.id))
    await engine.start(run_id)
    ingestion = _Ingestion({refused: [EmbeddingRejectedError(402, "no credit left")]})

    executor = _executor(engine, run_id, ingestion)
    with pytest.raises(ProviderRefused) as raised:
        await executor.process_batch(workspace.id, [refused, behind])
    assert "no credit" not in str(raised.value)
    # Another batch of the run starts nothing after the refusal.
    await executor.process_batch(workspace.id, [later])

    error = {"code": StatusCode.FAILED_PRECONDITION, "message": str(raised.value)}
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
    engine = _engine(sessions)
    run_id = await _create(engine, sessions, workspace, RunSelection(items=(archive,)))
    await engine.start(run_id)
    assert await engine.plan_batches(run_id, first_batch_number=0, max_batches=4) == [
        (0, [archive])
    ]
    ingestion = _Ingestion({})

    await _executor(engine, run_id, ingestion, _Archives(archive, members)).process_batch(
        workspace.id, [archive]
    )

    tasks = await task_items(sessions, run_id)
    assert tasks[archive].status == "succeeded"
    assert {item_id for item_id, row in tasks.items() if row.status == "queued"} == set(members)
    assert (await _run(sessions, run_id)).item_count == 3
    # The archive itself was expanded, never parsed.
    assert ingestion.calls == []
    # The members are planned in the same run, after the archive's batch ...
    later = await engine.plan_batches(run_id, first_batch_number=1, max_batches=4)
    assert all(number >= 1 for number, _ in later)
    planned = [item_id for _, item_ids in later for item_id in item_ids]
    assert sorted(planned) == sorted(members)
    # ... and processed like any other Document of the run.
    for _, item_ids in later:
        await _executor(engine, run_id, ingestion).process_batch(workspace.id, item_ids)
    tasks = await task_items(sessions, run_id)
    assert {tasks[member].status for member in members} == {"succeeded"}
    assert sorted(ingestion.calls) == sorted(members)


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
    engine = _engine(sessions)

    run_id = await engine.create_scheduled_run(workspace.id, source_id)

    assert run_id is not None
    assert set(await task_items(sessions, run_id)) == {synced}
    run = await _run(sessions, run_id)
    assert run.trigger_type == "schedule" and run.created_by_user_id is None
    assert run.status == "queued"
    states = "document.indexingState = PENDING OR document.indexingState = OUTDATED"
    assert run.scope == {
        "filter": f'document.origin.source = "workspaces/{workspace.id}/sources/wiki" AND ({states})'
    }
    assert uploaded not in await task_items(sessions, run_id)
    # The next firing finds nothing waiting: that is not a failure, and no run is kept.
    assert await engine.create_scheduled_run(workspace.id, source_id) is None
    # A paused workspace skips its schedules silently.
    await set_run(sessions, run_id, status="succeeded")
    await pause_ingestion(sessions, workspace)
    assert await engine.create_scheduled_run(workspace.id, source_id) is None
    async with sessions.begin() as session:
        assert len(list(await session.scalars(select(IngestionRun.id)))) == 1


# -- Cancelling, failing, recovering ------------------------------------------------


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
    engine = _engine(sessions)
    run_id = await _create(engine, sessions, workspace, _subtree(handbook.id))
    await engine.start(run_id)
    await _claim_and_mark_processing(engine, sessions, run_id, started)

    # A worker holds the run: the cancel is left for it to settle.
    async with held_lock(run_lock_key(run_id)):
        async with sessions.begin() as session:
            run = await session.get(IngestionRun, run_id, with_for_update=True)
            assert run is not None
            await engine.mark_cancelled(session, run)
        await engine.stop(run_id)

        assert (await _run(sessions, run_id)).finished_at is None
        tasks = await task_items(sessions, run_id)
        assert tasks[waiting].status == "cancelled"
        assert tasks[started].status == "running"
        # A batch that sees the cancel takes nothing more.
        assert not await engine.claim_item(run_id, waiting)

        await engine.finish(run_id, outcome="cancelled")
    tasks = await task_items(sessions, run_id)
    assert tasks[started].status == "cancelled"
    assert await _index_status(sessions, started) == "pending"

    # No worker holds it: a cancel settles the run at once.
    other = await _create(engine, sessions, workspace, RunSelection(items=(waiting,)))
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
    engine = _engine(sessions)
    run_id = await _create(engine, sessions, workspace, _subtree(handbook.id))
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


async def test_recover_fails_what_a_dead_worker_ran_and_replans_the_rest(
    sessions: Sessions, world: World
) -> None:
    workspace, handbook = await _workspace(world)
    done = (await document(sessions, handbook)).id
    started = (await document(sessions, handbook)).id
    waiting = (await document(sessions, handbook)).id
    engine = _engine(sessions, batch_max_items=1)
    run_id = await _create(engine, sessions, workspace, _subtree(handbook.id))
    await engine.start(run_id)
    planned = await engine.plan_batches(run_id, first_batch_number=0, max_batches=3)
    assert len(planned) == 3
    assert await engine.claim_item(run_id, done)
    await engine.record_item_outcome(run_id, done, status="succeeded", chunk_count=1, phases=[])
    await _claim_and_mark_processing(engine, sessions, run_id, started)

    recovered = await engine.recover(run_id)

    assert recovered is not None
    run, next_batch = recovered
    assert (run.id, run.status, next_batch) == (run_id, "running", 3)
    tasks = await task_items(sessions, run_id)
    assert tasks[done].status == "succeeded"
    assert (tasks[started].status, tasks[started].error_class) == ("failed", "interrupted")
    assert tasks[started].error == {"code": StatusCode.ABORTED, "message": INTERRUPTED_MESSAGE}
    assert await _index_status(sessions, started) == "pending"
    assert (tasks[waiting].status, tasks[waiting].batch_number) == ("queued", None)
    assert await engine.plan_batches(run_id, first_batch_number=3, max_batches=3) == [
        (3, [waiting])
    ]


async def test_documents_left_processing_outside_any_active_run_wait_again(
    sessions: Sessions, world: World
) -> None:
    workspace, handbook = await _workspace(world)
    held = (await document(sessions, handbook)).id
    stray = (await document(sessions, handbook, index_status="processing")).id
    engine = _engine(sessions)
    run_id = await _create(engine, sessions, workspace, RunSelection(items=(held,)))
    await engine.start(run_id)
    await _claim_and_mark_processing(engine, sessions, run_id, held)

    await engine.release_orphaned_documents()

    assert await _index_status(sessions, stray) == "pending"
    # A Document an active run holds is left alone.
    assert await _index_status(sessions, held) == "processing"


# -- Maintenance -------------------------------------------------------------------


async def test_the_maintenance_passes_reconcile_payloads_and_purge_deleted_items(
    sessions: Sessions, world: World, runtime: AppRuntime, fakes: Fakes
) -> None:
    _, handbook = await _workspace(world)
    dirty = (await document(sessions, handbook)).id
    expired = await document(sessions, handbook)
    assert expired.storage_key is not None
    fakes.storage.put_bytes(b"bytes", expired.storage_key, content_type="text/plain")
    async with sessions.begin() as session:
        await session.execute(
            update(ItemIndexState)
            .where(ItemIndexState.item_id == dirty)
            .values(payload_dirty_at=datetime.now(UTC))
        )
        await session.execute(
            update(Item)
            .where(Item.id == expired.id)
            .values(deleted_at=datetime.now(UTC) - timedelta(days=365))
        )
    index, storage = runtime.item_index(), runtime.object_storage()

    cleaned = await reconcile_dirty_payloads(runtime.sessions(), index, limit=500)
    purged = await purge_deleted_items(runtime.sessions(), index, storage, limit=100)

    assert cleaned == 1 and purged == 1
    assert fakes.storage.objects == {}
    async with sessions.begin() as session:
        dirty_at = select(ItemIndexState.payload_dirty_at).where(ItemIndexState.item_id == dirty)
        assert await session.scalar(dirty_at) is None
    assert await purge_deleted_items(runtime.sessions(), index, storage, limit=100) == 0
