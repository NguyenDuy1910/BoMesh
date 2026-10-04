"""Ingestion Runs: what a run takes, how it is batched, and how it ends.

The service tests run against PostgreSQL (one schema per test) with a fake
Temporal boundary; the workflow tests run the real workflow on Temporal's
time-skipping test server with fake Activities.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
import pytest_asyncio
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from temporalio import activity
from temporalio.client import WorkflowFailureError
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment, WorkflowEnvironment
from temporalio.worker import Worker
from temporalio.worker.workflow_sandbox import SandboxedWorkflowRunner, SandboxRestrictions

from config import IngestionRunConfig

from api.routers import IngestionRun as IngestionRunResource
from api.routers import IngestionRunItemPage, IngestionRunPage
from bomesh.db.models import (
    Base,
    ExternalResource,
    IngestionRun,
    IngestionRunItem,
    IngestionSource,
    IntegrationConnection,
    Item,
    ItemUpload,
    Role,
)
from bomesh.document_index import EmbeddingRejectedError
from bomesh.connector.protocol import (
    Chunk,
    CitationInfo,
    DocumentItem,
    DocumentKind,
    SourceIdentity,
    SourceProvider,
)
from bomesh.services import (
    COLLECTION_EDITOR_ROLE,
    COLLECTION_VIEWER_ROLE,
    TENANT_ADMIN_ROLE,
    TENANT_MEMBER_ROLE,
    AuthContext,
    AuthorizationError,
    ControlPlaneConflictError,
    ControlPlaneExternalUnavailableError,
    ControlPlaneNotFoundError,
    DocumentNotFoundError,
    DocumentProcessingError,
    CanonicalDocumentContent,
    current_processing_version,
)
from bomesh.services.archive_expansion import ArchiveExpansionResult
from bomesh.services.identity_access.identity_store import IdentityStoreService
from bomesh.services.identity_access.role_assignments import RoleAssignmentService
from bomesh.services.ingestion import (
    NOTHING_TO_PROCESS_MESSAGE,
    START_FAILED_MESSAGE,
    STOPPED_MESSAGE,
    IngestionRunService,
    NothingToProcessError,
)
from bomesh.services.item import ItemService
from bomesh.services.item_ingestion import INTERRUPTED_MESSAGE, ItemIngestionService
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
    SourceSyncActivities,
)
from bomesh.services.workflow.ingestion_workflow import IngestionRunWorkflow

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
database = pytest.mark.skipif(
    not TEST_DATABASE_URL,
    reason="TEST_DATABASE_URL is required for PostgreSQL ingestion run tests",
)

SIGNATURE = {
    "embedding_model": "test-embedding",
    "index_schema_version": 1,
    "contextualization_enabled": False,
    "contextualization_model": None,
}
CURRENT = current_processing_version(SIGNATURE)


@pytest_asyncio.fixture
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    if not TEST_DATABASE_URL:
        pytest.skip("TEST_DATABASE_URL is required for PostgreSQL ingestion run tests")
    schema = f"test_runs_{uuid4().hex}"
    admin_engine = create_async_engine(TEST_DATABASE_URL)
    async with admin_engine.begin() as connection:
        await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_async_engine(
        TEST_DATABASE_URL,
        connect_args={"server_settings": {"search_path": schema}},
    )
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory.begin() as session:
        await IdentityStoreService(session).sync_system_roles()
    try:
        yield factory
    finally:
        await engine.dispose()
        async with admin_engine.begin() as connection:
            await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await admin_engine.dispose()


class _Workflows:
    """The Temporal boundary, as the run service sees it."""

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


class _World:
    def __init__(self) -> None:
        self.tenant_id: UUID
        self.admin: AuthContext
        self.editor: AuthContext
        self.viewer: AuthContext
        self.member: AuthContext
        self.handbook: UUID
        self.policies: UUID
        self.board: UUID
        self.personal: UUID


def _runs(
    session_factory: async_sessionmaker[AsyncSession],
    workflows: _Workflows,
    *,
    batch_max_items: int = 8,
    batch_max_bytes: int = 64 * 1024 * 1024,
    parallelism: int = 4,
) -> IngestionRunService:
    return IngestionRunService(
        session_factory,
        workflows=workflows,  # type: ignore[arg-type]
        processing_signature=lambda: SIGNATURE,
        run_config=IngestionRunConfig(
            batch_max_items=batch_max_items,
            batch_max_bytes=batch_max_bytes,
            parallelism=parallelism,
        ),
    )


async def _person(
    session: AsyncSession, tenant_id: UUID, email: str, tenant_role: str
) -> UUID:
    identity = IdentityStoreService(session)
    user = await identity.create_user(email)
    await identity.assign_membership(user.id, tenant_id)
    role_id = await session.scalar(select(Role.id).where(Role.code == tenant_role, Role.is_system))
    assert role_id is not None
    await RoleAssignmentService(session).replace_tenant_roles(
        user_id=user.id, tenant_id=tenant_id, role_ids=[role_id]
    )
    return user.id


async def _world(session_factory: async_sessionmaker[AsyncSession]) -> _World:
    """A workspace: Handbook (with Policies nested), Board, and a personal Collection.

    The editor may process Handbook (and so Policies); the viewer may only
    read it; the member holds nothing.
    """

    world = _World()
    async with session_factory.begin() as session:
        identity = IdentityStoreService(session)
        tenant = await identity.create_tenant("acme", "Acme")
        world.tenant_id = tenant.id
        admin_id = await _person(session, tenant.id, "admin@example.test", TENANT_ADMIN_ROLE)
        editor_id = await _person(session, tenant.id, "editor@example.test", TENANT_MEMBER_ROLE)
        viewer_id = await _person(session, tenant.id, "viewer@example.test", TENANT_MEMBER_ROLE)
        member_id = await _person(session, tenant.id, "member@example.test", TENANT_MEMBER_ROLE)
        items = ItemService(session)
        world.handbook = (
            await items.create_collection(
                tenant_id=tenant.id, title="Handbook", created_by_user_id=admin_id
            )
        ).id
        world.policies = (
            await items.create_collection(
                tenant_id=tenant.id,
                title="Policies",
                created_by_user_id=admin_id,
                parent_item_id=world.handbook,
            )
        ).id
        world.board = (
            await items.create_collection(
                tenant_id=tenant.id, title="Board", created_by_user_id=admin_id
            )
        ).id
        world.personal = (
            await items.create_collection(
                tenant_id=tenant.id,
                title="My uploads",
                created_by_user_id=admin_id,
                metadata={"system_kind": "uploads"},
            )
        ).id
        grants = RoleAssignmentService(session)
        await grants.grant_collection_role(
            world.handbook,
            principal_type="user",
            principal_id=editor_id,
            role_code=COLLECTION_EDITOR_ROLE,
        )
        await grants.grant_collection_role(
            world.handbook,
            principal_type="user",
            principal_id=viewer_id,
            role_code=COLLECTION_VIEWER_ROLE,
        )
        world.admin = await identity.get_context(admin_id, tenant_id=tenant.id)
        world.editor = await identity.get_context(editor_id, tenant_id=tenant.id)
        world.viewer = await identity.get_context(viewer_id, tenant_id=tenant.id)
        world.member = await identity.get_context(member_id, tenant_id=tenant.id)
    return world


async def _document(
    session_factory: async_sessionmaker[AsyncSession],
    world: _World,
    collection_id: UUID,
    title: str,
    *,
    index_status: str = "pending",
    processed_version: str | None = None,
    size_bytes: int = 1024,
    upload_status: str | None = "available",
    deleted: bool = False,
    document_type: str = "plain_text",
) -> UUID:
    """One Document with its original stored; ``upload_status=None`` is a connector Item."""

    document_id = uuid4()
    async with session_factory.begin() as session:
        session.add(
            Item(
                id=document_id,
                tenant_id=world.tenant_id,
                item_type="document",
                parent_item_id=collection_id,
                parent_relation="contains",
                document_type=document_type,
                title=title,
                mime_type="text/plain",
                size_bytes=size_bytes,
                storage_key=f"tenants/{world.tenant_id}/items/{document_id}/raw",
                metadata_={"file_name": title},
                status="deleted" if deleted else "ready",
                deleted_at=datetime.now(UTC) if deleted else None,
                index_status=index_status,
                processed_version=processed_version,
                created_by_user_id=world.admin.user_id,
            )
        )
        await session.flush()
        if upload_status is not None:
            session.add(
                ItemUpload(
                    item_id=document_id,
                    tenant_id=world.tenant_id,
                    owner_user_id=world.admin.user_id,
                    idempotency_key=str(document_id),
                    status=upload_status,
                )
            )
    return document_id


async def _run_items(
    session_factory: async_sessionmaker[AsyncSession], run_id: UUID
) -> dict[UUID, IngestionRunItem]:
    async with session_factory.begin() as session:
        return {
            row.item_id: row
            for row in await session.scalars(
                select(IngestionRunItem).where(IngestionRunItem.run_id == run_id)
            )
        }


async def _index_status(session_factory: async_sessionmaker[AsyncSession], item_id: UUID) -> str:
    async with session_factory.begin() as session:
        item = await session.get(Item, item_id)
        assert item is not None and item.index_status is not None
        return item.index_status


# -- Selection ---------------------------------------------------------------------


@database
@pytest.mark.asyncio
async def test_a_collection_run_takes_its_whole_subtree_waiting_for_processing(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(session_factory)
    pending = await _document(session_factory, world, world.handbook, "pending.txt")
    nested = await _document(session_factory, world, world.policies, "nested.txt")
    outdated = await _document(
        session_factory, world, world.handbook, "outdated.txt",
        index_status="ready", processed_version="parser=old",
    )
    connector = await _document(
        session_factory, world, world.handbook, "page.html", upload_status=None
    )
    # Not waiting, not processable, or not here: none of these may be taken.
    await _document(
        session_factory, world, world.handbook, "current.txt",
        index_status="ready", processed_version=CURRENT,
    )
    failed = await _document(session_factory, world, world.handbook, "failed.txt", index_status="failed")
    await _document(session_factory, world, world.handbook, "photo.png", index_status="unsupported")
    await _document(session_factory, world, world.handbook, "removed.txt", deleted=True)
    await _document(session_factory, world, world.handbook, "uploading.txt", upload_status="pending")
    await _document(session_factory, world, world.board, "elsewhere.txt")
    workflows = _Workflows()
    runs = _runs(session_factory, workflows)

    run = await runs.create_run(world.editor, trigger="manual", collection_id=world.handbook)

    assert set(await _run_items(session_factory, run["id"])) == {
        pending, nested, outdated, connector,
    }
    assert run["status"] == "queued"
    assert run["counts"]["total"] == 4 and run["counts"]["queued"] == 4
    assert run["scope"]["states"] == ["pending", "outdated"]
    assert run["scope"]["collection_id"] == str(world.handbook)
    assert run["configuration"]["processing_version"] == CURRENT
    assert run["created_by"]["id"] == world.editor.user_id
    assert workflows.started == [run["id"]]

    # Asking for failed Documents is a separate, explicit choice.
    retry = await runs.create_run(
        world.editor, trigger="manual", collection_id=world.handbook, states=["failed"]
    )
    assert set(await _run_items(session_factory, retry["id"])) == {failed}


@database
@pytest.mark.asyncio
async def test_documents_another_run_holds_are_left_out_and_nothing_left_is_a_conflict(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(session_factory)
    first = await _document(session_factory, world, world.handbook, "a.txt")
    workflows = _Workflows()
    runs = _runs(session_factory, workflows)
    holding = await runs.create_run(world.editor, trigger="manual", collection_id=world.handbook)
    second = await _document(session_factory, world, world.handbook, "b.txt")

    taken = await runs.create_run(world.editor, trigger="api", document_ids=[first, second])
    assert set(await _run_items(session_factory, taken["id"])) == {second}

    with pytest.raises(NothingToProcessError, match="Nothing to process") as raised:
        await runs.create_run(world.editor, trigger="manual", collection_id=world.handbook)
    assert isinstance(raised.value, ControlPlaneConflictError)
    assert str(raised.value) == NOTHING_TO_PROCESS_MESSAGE
    assert workflows.started == [holding["id"], taken["id"]]
    async with session_factory.begin() as session:
        assert len(list(await session.scalars(select(IngestionRun.id)))) == 2

    # A finished run holds nothing any more.
    await runs.finish(holding["id"], outcome="completed")
    again = await runs.create_run(world.editor, trigger="manual", document_ids=[first])
    assert set(await _run_items(session_factory, again["id"])) == {first}


@database
@pytest.mark.asyncio
async def test_processing_needs_ingestion_run_and_unreadable_documents_do_not_exist(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(session_factory)
    handbook_document = await _document(session_factory, world, world.handbook, "a.txt")
    board_document = await _document(session_factory, world, world.board, "b.txt")
    runs = _runs(session_factory, _Workflows())

    # The viewer can read the Handbook but not process it.
    with pytest.raises(AuthorizationError):
        await runs.create_run(world.viewer, trigger="manual", document_ids=[handbook_document])
    # The editor cannot even read the Board: its Document is not there.
    with pytest.raises(DocumentNotFoundError):
        await runs.create_run(
            world.editor, trigger="manual", document_ids=[handbook_document, board_document]
        )
    with pytest.raises(ControlPlaneNotFoundError):
        await runs.create_run(world.editor, trigger="manual", collection_id=world.board)
    # Someone who may process nothing is told so, whatever they select.
    with pytest.raises(AuthorizationError):
        await runs.create_run(world.member, trigger="manual", states=["pending"])

    # The editor's workspace-wide run is what the editor may process.
    run = await runs.create_run(world.editor, trigger="manual", states=["pending"])
    assert set(await _run_items(session_factory, run["id"])) == {handbook_document}


@database
@pytest.mark.asyncio
async def test_a_workspace_run_leaves_personal_collections_to_their_owners(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(session_factory)
    shared = await _document(session_factory, world, world.board, "shared.txt")
    personal = await _document(session_factory, world, world.personal, "mine.txt")
    runs = _runs(session_factory, _Workflows())

    run = await runs.create_run(world.admin, trigger="api", states=["pending"])
    assert set(await _run_items(session_factory, run["id"])) == {shared}

    # Named explicitly, a personal Document is the caller's to process.
    mine = await runs.create_run(world.admin, trigger="manual", document_ids=[personal])
    assert set(await _run_items(session_factory, mine["id"])) == {personal}


@database
@pytest.mark.asyncio
async def test_a_run_keeps_the_documents_it_was_created_with(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(session_factory)
    before = await _document(session_factory, world, world.handbook, "before.txt")
    runs = _runs(session_factory, _Workflows())
    run = await runs.create_run(world.editor, trigger="manual", collection_id=world.handbook)

    await _document(session_factory, world, world.handbook, "after.txt")
    assert await runs.start(run["id"]) == (True, 4)
    planned = await runs.plan_batches(run["id"], first_batch_number=0, max_batches=10)

    assert planned == [(0, [before])]
    assert (await runs.get_run(world.editor, run["id"]))["counts"]["total"] == 1


@database
@pytest.mark.asyncio
async def test_two_hundred_documents_are_one_run_in_bounded_batches(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(session_factory)
    async with session_factory.begin() as session:
        for index in range(200):
            session.add(
                Item(
                    tenant_id=world.tenant_id,
                    item_type="document",
                    parent_item_id=world.handbook,
                    parent_relation="contains",
                    document_type="plain_text",
                    title=f"doc-{index:03}.txt",
                    size_bytes=1024,
                    storage_key=f"raw/{index}",
                    status="ready",
                    index_status="pending",
                )
            )
    workflows = _Workflows()
    runs = _runs(session_factory, workflows)

    run = await runs.create_run(world.admin, trigger="manual", collection_id=world.handbook)
    await runs.start(run["id"])
    batches = await runs.plan_batches(run["id"], first_batch_number=0, max_batches=100)

    assert workflows.started == [run["id"]]
    assert run["counts"]["total"] == 200
    assert [number for number, _ in batches] == list(range(25))
    assert {len(item_ids) for _, item_ids in batches} == {8}
    assert len({item_id for _, item_ids in batches for item_id in item_ids}) == 200


# -- Planning ------------------------------------------------------------------------


@database
@pytest.mark.asyncio
async def test_batches_are_packed_by_size_and_planning_is_idempotent(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(session_factory)
    sizes = {"a": 10, "b": 10, "c": 10, "d": 10, "e": 60, "f": 60, "huge": 500}
    ids = {
        name: await _document(session_factory, world, world.handbook, name, size_bytes=size)
        for name, size in sizes.items()
    }
    runs = _runs(session_factory, _Workflows(), batch_max_items=3, batch_max_bytes=100)
    run = await runs.create_run(world.editor, trigger="manual", collection_id=world.handbook)
    await runs.start(run["id"])

    first = await runs.plan_batches(run["id"], first_batch_number=0, max_batches=2)
    # A retried planning call answers with the batches it already made.
    assert await runs.plan_batches(run["id"], first_batch_number=0, max_batches=2) == first
    rest = await runs.plan_batches(run["id"], first_batch_number=2, max_batches=5)

    packed = [
        (number, sorted(sizes[name] for name, item_id in ids.items() if item_id in item_ids))
        for number, item_ids in first + rest
    ]
    # At most three per batch and 100 bytes, smallest first; a file over the
    # byte limit is a batch of its own.
    assert packed == [(0, [10, 10, 10]), (1, [10, 60]), (2, [60]), (3, [500])]
    assert await runs.plan_batches(run["id"], first_batch_number=4, max_batches=5) == []


# -- Processing a batch ---------------------------------------------------------------


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
    runs: IngestionRunService, ingestion: _Ingestion, archives: _Archives | None = None
) -> IngestionRunActivities:
    return IngestionRunActivities(
        runs=runs,
        ingestion=ingestion,  # type: ignore[arg-type]
        archives=archives or _Archives(),  # type: ignore[arg-type]
    )


async def _process(
    activities: IngestionRunActivities, run: dict[str, Any], tenant_id: UUID, number: int, item_ids: list[UUID]
) -> None:
    await ActivityEnvironment().run(
        activities.process_batch,
        ProcessBatchInput(
            run_id=str(run["id"]),
            tenant_id=str(tenant_id),
            batch_number=number,
            item_ids=[str(item_id) for item_id in item_ids],
        ),
    )


@database
@pytest.mark.asyncio
async def test_one_failing_document_does_not_fail_its_batch_and_a_retry_skips_finished_ones(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(session_factory)
    good = await _document(session_factory, world, world.handbook, "good.txt")
    broken = await _document(session_factory, world, world.handbook, "broken.txt")
    flaky = await _document(session_factory, world, world.handbook, "flaky.txt")
    runs = _runs(session_factory, _Workflows())
    run = await runs.create_run(world.editor, trigger="manual", collection_id=world.handbook)
    await runs.start(run["id"])
    ingestion = _Ingestion(
        {
            broken: [DocumentProcessingError("the file could not be read")],
            flaky: [ConnectionError("index unreachable"), 7],
        }
    )
    activities = _activities(runs, ingestion)

    # The index is down while the flaky one runs: the batch fails and Temporal retries it.
    with pytest.raises(ConnectionError):
        await _process(activities, run, world.tenant_id, 0, [good, broken, flaky])
    items = await _run_items(session_factory, run["id"])
    assert items[good].status == "succeeded" and items[good].chunk_count == 3
    assert items[broken].status == "failed"
    assert items[broken].error == "The file could not be read."
    assert items[flaky].status == "running"

    await _process(activities, run, world.tenant_id, 0, [good, broken, flaky])

    items = await _run_items(session_factory, run["id"])
    assert items[flaky].status == "succeeded" and items[flaky].chunk_count == 7
    assert [phase["phase"] for phase in items[flaky].phases] == ["parsing", "storing"]
    # Finished Documents were not processed a second time.
    assert ingestion.calls == [good, broken, flaky, flaky]

    await runs.finish(run["id"], outcome="completed")
    finished = await runs.get_run(world.editor, run["id"])
    assert finished["status"] == "completed"
    assert finished["counts"]["succeeded"] == 2 and finished["counts"]["failed"] == 1


@database
@pytest.mark.asyncio
async def test_a_provider_refusal_stops_the_run_and_skips_what_is_left(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(session_factory)
    refused = await _document(session_factory, world, world.handbook, "a.txt")
    behind = await _document(session_factory, world, world.handbook, "b.txt")
    later = await _document(session_factory, world, world.handbook, "c.txt")
    runs = _runs(session_factory, _Workflows(), batch_max_items=2)
    run = await runs.create_run(world.editor, trigger="manual", collection_id=world.handbook)
    await runs.start(run["id"])
    ingestion = _Ingestion({refused: [EmbeddingRejectedError(402, "no credit left")]})

    with pytest.raises(ApplicationError) as raised:
        await _process(_activities(runs, ingestion), run, world.tenant_id, 0, [refused, behind])
    assert raised.value.type == PROVIDER_REJECTED_FAILURE_TYPE
    assert raised.value.non_retryable
    assert "no credit" not in raised.value.message

    await runs.finish(run["id"], outcome="failed", error=raised.value.message)

    finished = await runs.get_run(world.editor, run["id"])
    items = await _run_items(session_factory, run["id"])
    assert finished["status"] == "failed"
    assert finished["error"] == raised.value.message
    assert items[refused].status == "failed"
    assert items[behind].status == "skipped" and items[later].status == "skipped"
    assert items[later].error == raised.value.message
    assert ingestion.calls == [refused]


@database
@pytest.mark.asyncio
async def test_an_archives_members_join_the_run_that_expanded_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(session_factory)
    archive = await _document(
        session_factory, world, world.handbook, "bundle.zip", document_type="archive"
    )
    members = (
        await _document(session_factory, world, world.handbook, "one.txt"),
        await _document(session_factory, world, world.handbook, "two.txt"),
    )
    runs = _runs(session_factory, _Workflows())
    run = await runs.create_run(world.editor, trigger="manual", document_ids=[archive])
    await runs.start(run["id"])
    planned = await runs.plan_batches(run["id"], first_batch_number=0, max_batches=4)
    assert planned == [(0, [archive])]
    ingestion = _Ingestion({})

    await _process(
        _activities(runs, ingestion, _Archives(archive, members)), run, world.tenant_id, 0, [archive]
    )

    items = await _run_items(session_factory, run["id"])
    assert items[archive].status == "succeeded"
    assert {item_id for item_id, row in items.items() if row.status == "queued"} == set(members)
    assert (await runs.get_run(world.editor, run["id"]))["counts"]["total"] == 3
    later = await runs.plan_batches(run["id"], first_batch_number=1, max_batches=4)
    assert [(number, set(item_ids)) for number, item_ids in later] == [(1, set(members))]
    # The archive itself was expanded, never parsed.
    assert ingestion.calls == []


@database
@pytest.mark.asyncio
async def test_a_scheduled_run_processes_what_its_source_left_pending(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(session_factory)
    synced = await _document(session_factory, world, world.handbook, "page.html", upload_status=None)
    current = await _document(
        session_factory, world, world.handbook, "old.html",
        upload_status=None, index_status="ready", processed_version=CURRENT,
    )
    uploaded = await _document(session_factory, world, world.handbook, "upload.txt")
    async with session_factory.begin() as session:
        connection = IntegrationConnection(
            tenant_id=world.tenant_id, connector_key="confluence", display_name="Wiki"
        )
        session.add(connection)
        await session.flush()
        source = IngestionSource(
            integration_connection_id=connection.id, target_item_id=world.handbook
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
    runs = _runs(session_factory, workflows)
    sync = SourceSyncActivities(sync=None, runs=runs)  # type: ignore[arg-type]
    scheduled = SourceSyncInput(
        source_id=str(source_id), tenant_id=str(world.tenant_id), process=True
    )

    run_id = await ActivityEnvironment().run(sync.create_scheduled_run, scheduled)

    assert run_id is not None
    assert set(await _run_items(session_factory, UUID(run_id))) == {synced}
    page = await runs.list_runs(world.admin, source_id=source_id)
    assert [(run["trigger"], run["created_by"]) for run in page["items"]] == [("scheduled", None)]
    # The next firing finds nothing waiting: that is not a failure.
    assert await ActivityEnvironment().run(sync.create_scheduled_run, scheduled) is None
    assert workflows.started == [UUID(run_id)]
    assert uploaded not in await _run_items(session_factory, UUID(run_id))


# -- The processing core ---------------------------------------------------------------


class _Content:
    def __init__(self, *, unreadable: bool = False) -> None:
        self._unreadable = unreadable

    async def canonicalize(self, document: Item) -> CanonicalDocumentContent:
        if self._unreadable:
            raise DocumentProcessingError("the file has no text to index")
        item = DocumentItem(
            id=str(document.id),
            title=document.title,
            document_kind=DocumentKind.NOTE,
            source=SourceIdentity(
                connector_id="connection-1",
                provider=SourceProvider.CONFLUENCE,
                external_id="page-1",
            ),
        )
        chunk = Chunk(
            id=f"{document.id}:0",
            item_id=str(document.id),
            chunk_index=0,
            chunk_text="grounded evidence",
            content_type="text",
            citation=CitationInfo(),
        )
        return CanonicalDocumentContent(item=item, chunks=(chunk,))


class _Index:
    def __init__(self) -> None:
        self.contexts: list[Any] = []

    def current_processing_signature(self) -> dict[str, Any]:
        return dict(SIGNATURE)

    async def index_item_content(
        self, item: DocumentItem, chunks: Any, *, context: Any, progress: Any = None
    ) -> int:
        self.contexts.append(context)
        if progress is not None:
            progress("storing", len(chunks), len(chunks))
        return len(chunks)


@database
@pytest.mark.asyncio
async def test_processing_a_document_makes_it_ready_with_the_current_version(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(session_factory)
    page = await _document(session_factory, world, world.handbook, "page.html", upload_status=None)
    # A connector attachment sits under its page; its Collection is still the Handbook.
    attachment = await _document(session_factory, world, page, "diagram.pdf", upload_status=None)
    index = _Index()
    ingestion = ItemIngestionService(
        session_factory, index=index, content=_Content()  # type: ignore[arg-type]
    )

    count = await ingestion.process_document(attachment, tenant_id=world.tenant_id)

    assert count == 1
    assert index.contexts[0].collection_item_id == str(world.handbook)
    assert index.contexts[0].parent_item_id == str(page)
    assert index.contexts[0].connector_key == "confluence"
    async with session_factory.begin() as session:
        processed = await session.get(Item, attachment)
        assert processed is not None
        assert processed.index_status == "ready"
        assert processed.processed_version == CURRENT

    unreadable = ItemIngestionService(
        session_factory, index=index, content=_Content(unreadable=True)  # type: ignore[arg-type]
    )
    with pytest.raises(DocumentProcessingError):
        await unreadable.process_document(page, tenant_id=world.tenant_id)
    assert await _index_status(session_factory, page) == "failed"


# -- Cancelling, failing, reconciling ---------------------------------------------------


@database
@pytest.mark.asyncio
async def test_cancel_stops_queued_documents_now_and_returns_interrupted_ones_to_pending(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(session_factory)
    started = await _document(session_factory, world, world.handbook, "a.txt")
    waiting = await _document(session_factory, world, world.handbook, "b.txt")
    workflows = _Workflows()
    runs = _runs(session_factory, workflows)
    run = await runs.create_run(world.editor, trigger="manual", collection_id=world.handbook)
    await runs.start(run["id"])
    assert await runs.claim_item(run["id"], started)
    async with session_factory.begin() as session:
        await ItemService(session).mark_index_processing(started)

    with pytest.raises(ControlPlaneNotFoundError):
        await runs.cancel_run(world.viewer, run["id"])
    cancelled = await runs.cancel_run(world.editor, run["id"])

    assert cancelled["status"] == "cancelled"
    assert workflows.cancel_requests == [run["id"]]
    items = await _run_items(session_factory, run["id"])
    assert items[waiting].status == "cancelled"
    assert items[started].status == "running"
    # A batch that sees the cancel takes nothing more.
    assert not await runs.claim_item(run["id"], waiting)

    await runs.finish(run["id"], outcome="cancelled")
    items = await _run_items(session_factory, run["id"])
    assert items[started].status == "cancelled"
    assert await _index_status(session_factory, started) == "pending"
    with pytest.raises(ControlPlaneConflictError):
        await runs.cancel_run(world.editor, run["id"])


@database
@pytest.mark.asyncio
async def test_only_the_creator_or_a_manager_may_cancel_and_a_missing_workflow_cancels_at_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(session_factory)
    await _document(session_factory, world, world.handbook, "a.txt")
    workflows = _Workflows()
    runs = _runs(session_factory, workflows)
    run = await runs.create_run(world.admin, trigger="manual", collection_id=world.handbook)

    with pytest.raises(ControlPlaneNotFoundError):
        # Not the editor's run, and the editor cannot see every run.
        await runs.cancel_run(world.editor, run["id"])

    workflows.open = False
    cancelled = await runs.cancel_run(world.admin, run["id"])
    assert cancelled["status"] == "cancelled"
    assert cancelled["finished_at"] is not None
    assert cancelled["counts"]["cancelled"] == 1


@database
@pytest.mark.asyncio
async def test_a_batch_that_keeps_failing_fails_its_unfinished_documents(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(session_factory)
    done = await _document(session_factory, world, world.handbook, "a.txt")
    stuck = await _document(session_factory, world, world.handbook, "b.txt")
    untouched = await _document(session_factory, world, world.handbook, "c.txt")
    runs = _runs(session_factory, _Workflows())
    run = await runs.create_run(world.editor, trigger="manual", collection_id=world.handbook)
    await runs.start(run["id"])
    await runs.plan_batches(run["id"], first_batch_number=0, max_batches=1)
    assert await runs.claim_item(run["id"], done)
    await runs.record_item_outcome(run["id"], done, status="succeeded", chunk_count=2, phases=[])
    assert await runs.claim_item(run["id"], stuck)
    async with session_factory.begin() as session:
        await ItemService(session).mark_index_processing(stuck)

    await runs.fail_batch(run["id"], 0)

    items = await _run_items(session_factory, run["id"])
    assert items[done].status == "succeeded"
    assert items[stuck].status == "failed" and items[stuck].error == INTERRUPTED_MESSAGE
    assert items[untouched].status == "failed"
    assert await _index_status(session_factory, stuck) == "failed"


@database
@pytest.mark.asyncio
async def test_a_run_whose_workflow_cannot_start_fails_and_holds_nothing(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(session_factory)
    document = await _document(session_factory, world, world.handbook, "a.txt")
    workflows = _Workflows()
    workflows.fail_start = True
    runs = _runs(session_factory, workflows)

    with pytest.raises(ControlPlaneExternalUnavailableError):
        await runs.create_run(world.editor, trigger="manual", document_ids=[document])

    page = await runs.list_runs(world.editor)
    assert page["total"] == 1
    assert page["items"][0]["status"] == "failed"
    assert page["items"][0]["error"] == START_FAILED_MESSAGE
    workflows.fail_start = False
    again = await runs.create_run(world.editor, trigger="manual", document_ids=[document])
    assert set(await _run_items(session_factory, again["id"])) == {document}


@database
@pytest.mark.asyncio
async def test_reconcile_ends_a_run_whose_workflow_is_gone(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(session_factory)
    started = await _document(session_factory, world, world.handbook, "a.txt")
    waiting = await _document(session_factory, world, world.handbook, "b.txt")
    stray = await _document(session_factory, world, world.board, "c.txt", index_status="processing")
    workflows = _Workflows()
    runs = _runs(session_factory, workflows)
    run = await runs.create_run(world.editor, trigger="manual", collection_id=world.handbook)
    await runs.start(run["id"])
    assert await runs.claim_item(run["id"], started)
    async with session_factory.begin() as session:
        await ItemService(session).mark_index_processing(started)
        await session.execute(
            update(IngestionRun)
            .where(IngestionRun.id == run["id"])
            .values(updated_at=datetime.now(UTC) - timedelta(minutes=10))
        )

    # Temporal unreachable proves nothing; an open workflow is left alone.
    workflows.reachable = False
    await runs.reconcile()
    workflows.reachable = True
    await runs.reconcile()
    assert (await runs.get_run(world.editor, run["id"]))["status"] == "running"
    assert await _index_status(session_factory, started) == "processing"

    workflows.open = False
    await runs.reconcile()

    failed = await runs.get_run(world.editor, run["id"])
    items = await _run_items(session_factory, run["id"])
    assert failed["status"] == "failed" and failed["error"] == STOPPED_MESSAGE
    assert items[started].status == "cancelled" and items[waiting].status == "cancelled"
    assert await _index_status(session_factory, started) == "pending"
    # A Document left processing outside any run waits again too.
    assert await _index_status(session_factory, stray) == "pending"


@database
@pytest.mark.asyncio
async def test_reading_a_stale_run_finds_a_lost_workflow(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(session_factory)
    await _document(session_factory, world, world.handbook, "a.txt")
    workflows = _Workflows()
    runs = _runs(session_factory, workflows)
    run = await runs.create_run(world.editor, trigger="manual", collection_id=world.handbook)
    async with session_factory.begin() as session:
        await session.execute(
            update(IngestionRun)
            .where(IngestionRun.id == run["id"])
            .values(updated_at=datetime.now(UTC) - timedelta(minutes=10))
        )
    workflows.open = False

    read = await runs.get_run(world.editor, run["id"])

    assert read["status"] == "failed" and read["error"] == STOPPED_MESSAGE


# -- Reading and retrying ----------------------------------------------------------------


@database
@pytest.mark.asyncio
async def test_runs_are_visible_to_their_creator_or_with_ingestion_read(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(session_factory)
    await _document(session_factory, world, world.handbook, "a.txt")
    await _document(session_factory, world, world.board, "b.txt")
    runs = _runs(session_factory, _Workflows())
    mine = await runs.create_run(world.editor, trigger="manual", collection_id=world.handbook)
    theirs = await runs.create_run(world.admin, trigger="manual", collection_id=world.board)

    assert [run["id"] for run in (await runs.list_runs(world.editor))["items"]] == [mine["id"]]
    assert [run["id"] for run in (await runs.list_runs(world.admin))["items"]] == [
        theirs["id"], mine["id"],
    ]
    by_collection = await runs.list_runs(world.admin, collection_id=world.board)
    assert [run["id"] for run in by_collection["items"]] == [theirs["id"]]
    with pytest.raises(ControlPlaneNotFoundError):
        await runs.get_run(world.editor, theirs["id"])
    with pytest.raises(ControlPlaneNotFoundError):
        await runs.list_run_items(world.editor, theirs["id"])


@database
@pytest.mark.asyncio
async def test_run_items_list_the_work_in_progress_first_and_retry_takes_what_did_not_finish(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    world = await _world(session_factory)
    names = ["alpha.txt", "beta.txt", "gamma.txt", "delta.txt"]
    ids = {name: await _document(session_factory, world, world.handbook, name) for name in names}
    runs = _runs(session_factory, _Workflows())
    run = await runs.create_run(world.editor, trigger="manual", collection_id=world.handbook)
    await runs.start(run["id"])
    for name, outcome in (("alpha.txt", "succeeded"), ("gamma.txt", "failed")):
        assert await runs.claim_item(run["id"], ids[name])
        await runs.record_item_outcome(
            run["id"], ids[name], status=outcome, error="Bad file." if outcome == "failed" else None,
            phases=[{"phase": "parsing", "started_at": None, "finished_at": None, "done": 0, "total": 0}],
        )
    assert await runs.claim_item(run["id"], ids["delta.txt"])

    page = await runs.list_run_items(world.editor, run["id"])
    # What the HTTP layer returns: the service output must fit the contract.
    IngestionRunItemPage.model_validate(page)
    IngestionRunPage.model_validate(await runs.list_runs(world.editor))
    assert [item["name"] for item in page["items"]] == [
        "delta.txt", "gamma.txt", "beta.txt", "alpha.txt",
    ]
    assert page["items"][1]["error"] == "Bad file." and page["items"][1]["phase"] == "parsing"
    failed_only = await runs.list_run_items(world.editor, run["id"], status="failed")
    assert [item["document_id"] for item in failed_only["items"]] == [ids["gamma.txt"]]

    await runs.finish(run["id"], outcome="completed")
    retry = await runs.retry_run(world.editor, run["id"])

    resource = IngestionRunResource.model_validate(retry)
    assert resource.scope.retry_of_run_id == run["id"]
    assert resource.created_by is not None and resource.created_by.id == world.editor.user_id
    assert retry["trigger"] == "manual"
    assert set(await _run_items(session_factory, retry["id"])) == {
        ids["gamma.txt"], ids["beta.txt"], ids["delta.txt"],
    }
    await runs.finish(retry["id"], outcome="completed")
    clean = await runs.create_run(world.editor, trigger="manual", document_ids=[ids["alpha.txt"]])
    await runs.start(clean["id"])
    assert await runs.claim_item(clean["id"], ids["alpha.txt"])
    await runs.record_item_outcome(clean["id"], ids["alpha.txt"], status="succeeded", phases=[])
    await runs.finish(clean["id"], outcome="completed")
    with pytest.raises(NothingToProcessError):
        await runs.retry_run(world.editor, clean["id"])


# -- The workflow ---------------------------------------------------------------------------


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


@pytest.mark.asyncio
async def test_the_workflow_runs_every_batch_with_bounded_concurrency() -> None:
    fake = _FakeRun(7, parallelism=2)

    await _run_workflow(fake)

    assert sorted(fake.processed) == list(range(7))
    assert fake.max_in_flight == 2
    assert [(f.outcome, f.error) for f in fake.finished] == [("completed", None)]


@pytest.mark.asyncio
async def test_a_provider_refusal_stops_planning_and_fails_the_run() -> None:
    fake = _FakeRun(10, parallelism=2)
    fake.refuse = {1}

    await _run_workflow(fake)

    assert len(fake.processed) < 9
    assert fake.failed_batches == []
    assert [(f.outcome, f.error) for f in fake.finished] == [
        ("failed", "The embedding provider refused the request.")
    ]


@pytest.mark.asyncio
async def test_a_batch_that_exhausts_its_retries_is_failed_and_the_run_goes_on() -> None:
    fake = _FakeRun(3, parallelism=2)
    fake.break_ = {0}

    await _run_workflow(fake)

    assert fake.failed_batches == [0]
    assert sorted(fake.processed) == [1, 2]
    assert [f.outcome for f in fake.finished] == ["completed"]


@pytest.mark.asyncio
async def test_cancelling_the_workflow_stops_batches_and_still_finishes_the_run() -> None:
    fake = _FakeRun(4, parallelism=2)
    fake.hang = True

    await _run_workflow(fake, cancel=True)

    assert fake.cancelled
    assert [f.outcome for f in fake.finished] == ["cancelled"]
