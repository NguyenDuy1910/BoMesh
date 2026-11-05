"""Ingestion Runs: the one way Documents are processed.

Adding data only registers Documents (``pending``) and stores their originals.
Processing happens when someone — a person, an API client, the platform
console or a Source's schedule — creates an Ingestion Run. A run snapshots its
Documents into ``ingestion_run_items`` when it is created
(:meth:`IngestionRunService.snapshot`), so later uploads never join it, and
starts one Temporal workflow (:meth:`IngestionRunService.launch`) that
processes them in bounded batches. Postgres holds every run and task state;
Temporal only orchestrates. Authorization is the caller's: this engine takes
the set of collections a run may draw from.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from sqlalchemy import Select, and_, exists, func, literal, or_, select, update
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import (
    ExternalResource,
    IngestionRun,
    IngestionRunItem,
    IngestionSync,
    Item,
    ItemRevision,
    ItemUpload,
    MessageItem,
    Tenant,
)
from bomesh.errors import StatusCode, Unavailable
from bomesh.iam.policy import PERSONAL_KIND
from bomesh.services import current_processing_version
from bomesh.services.knowledge_items.indexing import INTERRUPTED_MESSAGE
from bomesh.services.knowledge_items.item_store import HIDDEN_KINDS, ItemService
from bomesh.services.workflow.service import TemporalWorkflowService
from config import IngestionRunConfig

log = logging.getLogger(__name__)

ACTIVE_RUN_STATUSES = ("queued", "running")
TERMINAL_ITEM_STATUSES = frozenset({"succeeded", "failed", "cancelled"})
RETRYABLE_ITEM_STATUSES = ("failed", "cancelled")
#: ``IndexingState`` values a selector may name.
INDEXING_STATES = ("PENDING", "RUNNING", "SUCCEEDED", "FAILED", "OUTDATED", "UNSUPPORTED")
#: What a Source's schedule processes after each sync.
SCHEDULED_STATES = ("PENDING", "OUTDATED")

# Provider-neutral failure categories of a task (``errorClass``); never raw messages.
PROVIDER_REFUSED = "provider_refused"
CONTENT_UNAVAILABLE = "content_unavailable"
UNSUPPORTED_FORMAT = "unsupported_format"
INTERRUPTED = "interrupted"
INTERNAL = "internal"

START_FAILED_MESSAGE = "Processing could not be started. Try again in a moment."
STOPPED_MESSAGE = "Processing stopped unexpectedly."
SYNC_STOPPED_MESSAGE = "The sync stopped unexpectedly."
REMOVED_MESSAGE = "The document was removed before it was processed."
RUN_ENDED_MESSAGE = "The run ended before this document was processed."
#: An open run or sync older than this is checked against Temporal.
STALE_AFTER = timedelta(minutes=2)


@dataclass(frozen=True, slots=True)
class RunSelection:
    """The Documents a run asks for; set fields narrow each other.

    ``items`` exactly those Documents, ``ancestor`` a collection's whole
    subtree, ``source_id`` what a Source registered, ``states`` their
    ``IndexingState``. Unset fields do not narrow.
    """

    items: tuple[UUID, ...] = ()
    ancestor: UUID | None = None
    source_id: UUID | None = None
    states: tuple[str, ...] = ()

    @property
    def excludes_personal(self) -> bool:
        """Personal collections are their owners' own unless named by item or ancestor."""
        return not self.items and self.ancestor is None

    def scope(self) -> dict[str, Any]:
        """``ingestion_runs.scope``: the selector as asked for (``design.dbml``)."""
        scope: dict[str, Any] = {}
        if self.items:
            scope["item_ids"] = [str(item) for item in self.items]
        if self.ancestor is not None:
            scope["ancestor_item_id"] = str(self.ancestor)
        if self.source_id is not None:
            scope["source_id"] = str(self.source_id)
        if self.states:
            scope["states"] = list(self.states)
        return scope

    @classmethod
    def from_scope(cls, scope: Mapping[str, Any]) -> RunSelection:
        ancestor, source_id = scope.get("ancestor_item_id"), scope.get("source_id")
        return cls(
            items=tuple(UUID(item) for item in scope.get("item_ids") or ()),
            ancestor=UUID(ancestor) if ancestor else None,
            source_id=UUID(source_id) if source_id else None,
            states=tuple(scope.get("states") or ()),
        )


class IngestionRunService:
    """Snapshot runs, start and stop their workflows, and record what they do."""

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

    async def snapshot(
        self,
        session: AsyncSession,
        *,
        workspace_id: UUID,
        selection: RunSelection,
        collections: Collection[UUID] | None,
        trigger: str,
        created_by_user_id: UUID | None,
        retry_of_run_id: UUID | None = None,
    ) -> IngestionRun:
        """Create a QUEUED run in ``session`` holding the selected Documents.

        ``collections`` are the governing collections the run may draw from
        (``None``: every live collection of the workspace). Never selected:
        conversation attachments, assistant artifacts, unsupported Documents,
        Documents whose content is not available, Documents another active run
        holds and, when :attr:`RunSelection.excludes_personal`, Documents of
        personal collections. The run's ``scope`` records ``selection``.
        """

        # Selection and snapshot are serialized per workspace, so two runs
        # created at once never take the same Document.
        await session.execute(select(func.pg_advisory_xact_lock(_workspace_lock_key(workspace_id))))
        signature = dict(self._processing_signature())
        version = current_processing_version(signature)
        run = IngestionRun(
            id=uuid4(),
            tenant_id=workspace_id,
            trigger_type=trigger,
            scope=selection.scope(),
            retry_of_run_id=retry_of_run_id,
            status="queued",
            configuration=self._configuration(signature, version),
            item_count=0,
            created_by_user_id=created_by_user_id,
        )
        session.add(run)
        await session.flush()
        roots = await _roots(session, workspace_id, selection, collections)
        await session.execute(
            pg_insert(IngestionRunItem).from_select(
                ["run_id", "item_id"],
                select(literal(run.id, PG_UUID(as_uuid=True)), Item.id)
                .select_from(Item)
                .outerjoin(ItemUpload, ItemUpload.item_id == Item.id)
                .where(
                    Item.id.in_(_documents_under(roots, workspace_id=workspace_id)),
                    *_narrowing(selection, version),
                    *_candidate(workspace_id),
                ),
            )
        )
        run.item_count = await _item_count(session, run.id)
        await session.flush()
        await session.refresh(run)
        return run

    async def launch(self, run_id: UUID, workspace_id: UUID, *, item_count: int) -> None:
        """Start a snapshotted run; an empty run succeeds at once.

        A workflow that cannot start fails the run and raises UNAVAILABLE.
        """

        if item_count == 0:
            await self.finish(run_id, outcome="succeeded")
            return
        try:
            await self._workflows.start_run(run_id, workspace_id)
        except Exception as exc:  # noqa: BLE001 - any start failure is reported the same way
            log.warning("ingestion run workflow could not start run_id=%s", run_id, exc_info=exc)
            await self.finish(
                run_id,
                outcome="failed",
                error=_status(StatusCode.UNAVAILABLE, START_FAILED_MESSAGE),
            )
            raise Unavailable(START_FAILED_MESSAGE) from exc

    async def create_scheduled_run(self, workspace_id: UUID, source_id: UUID) -> UUID | None:
        """Process what a Source left pending or outdated (trigger SCHEDULE).

        ``None`` when nothing is selected or the workspace does not process
        now (ingestion paused, workspace not ACTIVE): a schedule skips silently.
        """

        selection = RunSelection(source_id=source_id, states=SCHEDULED_STATES)
        async with transaction_scope(self._session_factory) as session:
            workspace = await session.get(Tenant, workspace_id)
            if (
                workspace is None
                or workspace.status != "active"
                or workspace.ingestion_paused_at is not None
            ):
                return None
            # A schedule that selects nothing leaves no run behind.
            savepoint = await session.begin_nested()
            run = await self.snapshot(
                session,
                workspace_id=workspace_id,
                selection=selection,
                collections=None,
                trigger="schedule",
                created_by_user_id=None,
            )
            if run.item_count == 0:
                await savepoint.rollback()
                return None
            run_id, item_count = run.id, run.item_count
        await self.launch(run_id, workspace_id, item_count=item_count)
        return run_id

    # -- Cancelling ----------------------------------------------------------

    async def mark_cancelled(self, session: AsyncSession, run: IngestionRun) -> None:
        """Cancel an active run (locked by the caller): tasks not started are cancelled now."""

        run.status = "cancelled"
        await session.execute(
            update(IngestionRunItem)
            .where(IngestionRunItem.run_id == run.id, IngestionRunItem.status == "queued")
            .values(status="cancelled", finished_at=_now())
        )

    async def stop(self, run_id: UUID) -> None:
        """Ask the cancelled run's workflow to stop; without one, settle the run now.

        The task each batch is processing stops and its Document waits again.
        """

        try:
            requested = await self._workflows.cancel_run(run_id)
        except Exception:  # noqa: BLE001 - the batches also stop on their own
            log.warning("ingestion run cancel request failed run_id=%s", run_id, exc_info=True)
            requested = True
        if not requested:
            await self.finish(run_id, outcome="cancelled")

    # -- Reading ---------------------------------------------------------------

    async def refresh(self, run: IngestionRun) -> bool:
        """End an open run whose workflow Temporal lost; ``True`` when it changed."""

        if run.status not in ACTIVE_RUN_STATUSES or not _is_stale(run.updated_at):
            return False
        if not await self._workflow_is_lost(run.id):
            return False
        await self._stop_lost_run(run.id)
        return True

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

        The task records the Document's newest live revision it starts from.
        A Document already finished in this run (a retried batch) is not
        processed again; one removed since the run was created is skipped.
        """

        async with transaction_scope(self._session_factory) as session:
            row = (
                await session.execute(
                    select(IngestionRunItem, IngestionRun.status, Item.deleted_at)
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
            run_item, run_status, item_deleted_at = row
            if run_status != "running" or run_item.status in TERMINAL_ITEM_STATUSES:
                return False
            now = _now()
            if item_deleted_at is not None:
                run_item.status = "cancelled"
                run_item.error = _status(StatusCode.NOT_FOUND, REMOVED_MESSAGE)
                run_item.finished_at = now
                return False
            run_item.status = "running"
            run_item.started_at = now
            run_item.finished_at = None
            run_item.error = None
            run_item.error_class = None
            run_item.chunk_count = None
            run_item.phases = []
            run_item.revision_number = await session.scalar(
                select(func.max(ItemRevision.revision_number)).where(
                    ItemRevision.item_id == item_id, ItemRevision.deleted_at.is_(None)
                )
            )
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
        error_class: str | None = None,
        chunk_count: int | None = None,
    ) -> None:
        """Finish one Document in the run: succeeded, failed, or cancelled.

        A failed Document carries its user-safe ``error`` and provider-neutral
        ``error_class``. A cancelled Document was interrupted mid-processing
        and waits again.
        """

        if status not in TERMINAL_ITEM_STATUSES:
            raise ValueError("unsupported run item outcome")
        async with transaction_scope(self._session_factory) as session:
            run_item = await session.get(
                IngestionRunItem, (run_id, item_id), with_for_update=True
            )
            if run_item is None:
                return
            run_item.status = status
            run_item.error = (
                _status(StatusCode.INTERNAL, error) if error is not None else None
            )
            run_item.error_class = error_class if status == "failed" else None
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
                        IngestionRunItem.status.in_(ACTIVE_RUN_STATUSES),
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
                run_item.error = _status(StatusCode.ABORTED, INTERRUPTED_MESSAGE)
                run_item.error_class = INTERRUPTED
                run_item.finished_at = now
            await _release_documents(session, interrupted, to="failed")

    async def finish(
        self, run_id: UUID, *, outcome: str, error: Mapping[str, Any] | None = None
    ) -> None:
        """Record how the run ended and settle every Document it did not finish.

        Idempotent, and never overrides a run already finished (a cancel that
        arrived first stays a cancel). Queued Documents are cancelled; Documents
        interrupted mid-processing go back to pending. ``error`` is the
        google.rpc.Status of a failed run.
        """

        if outcome not in TERMINAL_ITEM_STATUSES:
            raise ValueError("unsupported run outcome")
        async with transaction_scope(self._session_factory) as session:
            run = await session.get(IngestionRun, run_id, with_for_update=True)
            if run is None:
                return
            if run.status in ACTIVE_RUN_STATUSES:
                run.status = outcome
                if outcome == "failed":
                    run.error = dict(error or _status(StatusCode.INTERNAL, STOPPED_MESSAGE))
            if run.finished_at is None:
                run.finished_at = _now()
            if run.status == "cancelled":
                await _settle_items(session, run_id, queued_error=None)
            elif run.status == "failed":
                await _settle_items(session, run_id, queued_error=run.error)
            else:
                await _settle_items(
                    session,
                    run_id,
                    queued_error=_status(StatusCode.CANCELLED, RUN_ENDED_MESSAGE),
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
            lost_sync_sources = list(
                await session.scalars(
                    select(IngestionSync.ingestion_source_id).where(
                        IngestionSync.status == "running",
                        IngestionSync.started_at < cutoff,
                    )
                )
            )
        try:
            for run_id in run_ids:
                if not await self._workflows.run_is_open(run_id):
                    await self._stop_lost_run(run_id)
            for source_id in lost_sync_sources:
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
            run.error = _status(StatusCode.INTERNAL, STOPPED_MESSAGE)
            run.finished_at = run.finished_at or _now()
            await _settle_items(session, run_id, queued_error=None)
        log.warning("ingestion run stopped without its workflow run_id=%s", run_id)

    async def _fail_lost_sync(self, source_id: UUID) -> None:
        async with transaction_scope(self._session_factory) as session:
            await session.execute(
                update(IngestionSync)
                .where(
                    IngestionSync.ingestion_source_id == source_id,
                    IngestionSync.status == "running",
                )
                .values(
                    status="failed",
                    error=_status(StatusCode.INTERNAL, SYNC_STOPPED_MESSAGE),
                    finished_at=_now(),
                )
            )
        log.warning("source sync stopped without its workflow source_id=%s", source_id)


# -- Selection (SQL) -------------------------------------------------------------


async def live_collections(session: AsyncSession, workspace_id: UUID) -> frozenset[UUID]:
    """Every live collection of the workspace (what a workspace-wide holder may process)."""

    return frozenset(
        await session.scalars(
            select(Item.id).where(
                Item.tenant_id == workspace_id,
                Item.item_type == "collection",
                Item.deleted_at.is_(None),
            )
        )
    )


async def governing_collections(
    session: AsyncSession, workspace_id: UUID, document_ids: Sequence[UUID]
) -> dict[UUID, UUID]:
    """Each live Document's nearest Collection."""

    if not document_ids:
        return {}
    governing = _governing_collections(list(document_ids), workspace_id=workspace_id)
    return dict(
        (await session.execute(select(governing.c.document_id, governing.c.collection_id))).all()
    )


async def _roots(
    session: AsyncSession,
    workspace_id: UUID,
    selection: RunSelection,
    collections: Collection[UUID] | None,
) -> set[UUID]:
    """The governing collections the run draws from, exclusions applied."""

    roots = set(
        await live_collections(session, workspace_id) if collections is None else collections
    )
    if selection.ancestor is not None:
        roots &= set(await _collection_tree(session, selection.ancestor))
    excluded_kinds = list(HIDDEN_KINDS)
    if selection.excludes_personal:
        excluded_kinds.append(PERSONAL_KIND)
    excluded = await session.scalars(
        select(Item.id).where(
            Item.tenant_id == workspace_id,
            Item.item_type == "collection",
            Item.metadata_["system_kind"].astext.in_(excluded_kinds),
        )
    )
    return roots - set(excluded)


def _narrowing(selection: RunSelection, version: str) -> list[Any]:
    conditions: list[Any] = []
    if selection.items:
        conditions.append(Item.id.in_(selection.items))
    if selection.source_id is not None:
        conditions.append(
            Item.id.in_(
                select(ExternalResource.item_id).where(
                    ExternalResource.ingestion_source_id == selection.source_id,
                    ExternalResource.deleted_at.is_(None),
                )
            )
        )
    if selection.states:
        conditions.append(_state_filter(selection.states, version))
    return conditions


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


def _candidate(workspace_id: UUID, *, run_id: UUID | None = None) -> tuple[Any, ...]:
    """A processable Document whose content is AVAILABLE, not held by another active run.

    Expects ``ItemUpload`` outer-joined: an upload's bytes must have arrived;
    a connector Item has its original from the sync that registered it.
    Conversation attachments are never processed.
    """

    return (
        Item.tenant_id == workspace_id,
        Item.item_type == "document",
        Item.deleted_at.is_(None),
        Item.status == "ready",
        Item.index_status != "unsupported",
        or_(
            ItemUpload.status == "available",
            and_(ItemUpload.item_id.is_(None), Item.storage_key.is_not(None)),
        ),
        ~exists(
            select(MessageItem.item_id).where(
                MessageItem.item_id == Item.id, MessageItem.relation_type == "attachment"
            )
        ),
        ~_in_active_run(Item.id, except_run_id=run_id),
    )


def _state_filter(states: Sequence[str], version: str) -> Any:
    predicates = {
        "PENDING": Item.index_status == "pending",
        "RUNNING": Item.index_status == "processing",
        "SUCCEEDED": and_(Item.index_status == "ready", Item.processed_version == version),
        "FAILED": Item.index_status == "failed",
        "OUTDATED": and_(
            Item.index_status == "ready", Item.processed_version.is_distinct_from(version)
        ),
        "UNSUPPORTED": Item.index_status == "unsupported",
    }
    return or_(*(predicates[state] for state in states))


def _documents_under(roots: set[UUID], *, workspace_id: UUID) -> Select[Any]:
    """Every Document whose governing Collection is one of ``roots``.

    Connector Documents can sit under other Documents (a page's attachments),
    so the walk descends through Documents, never into another Collection.
    """

    documents = (
        select(Item.id.label("item_id"))
        .where(
            Item.tenant_id == workspace_id,
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


def _governing_collections(document_ids: Sequence[UUID], *, workspace_id: UUID) -> Any:
    """``(document_id, collection_id)``: each live Document's nearest Collection."""

    climb = (
        select(Item.id.label("document_id"), Item.parent_item_id.label("parent_id"))
        .where(
            Item.id.in_(document_ids),
            Item.tenant_id == workspace_id,
            Item.item_type == "document",
            Item.deleted_at.is_(None),
        )
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
    session: AsyncSession, run_id: UUID, *, queued_error: Mapping[str, Any] | None
) -> None:
    """Cancel a stopped run's leftovers; interrupted Documents wait again.

    ``queued_error`` is why queued Documents were not processed; ``None`` for
    a cancelled run, whose running Documents are cancelled rather than failed.
    """

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
        .values(
            status="cancelled",
            error=dict(queued_error) if queued_error is not None else None,
            finished_at=now,
        )
    )
    failing = queued_error is not None
    await session.execute(
        update(IngestionRunItem)
        .where(IngestionRunItem.run_id == run_id, IngestionRunItem.status == "running")
        .values(
            status="failed" if failing else "cancelled",
            error=_status(StatusCode.ABORTED, INTERRUPTED_MESSAGE) if failing else None,
            error_class=INTERRUPTED if failing else None,
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
                Item.deleted_at.is_(None),
            )
        )
    )
    items = ItemService(session)
    for item_id in processing:
        if to == "pending":
            await items.mark_index_pending(item_id)
        else:
            await items.mark_index_failed(item_id)


def _workspace_lock_key(workspace_id: UUID) -> int:
    digest = uuid5(NAMESPACE_URL, f"bomesh:ingestion-run-selection:{workspace_id}")
    return int.from_bytes(digest.bytes[:8], byteorder="big", signed=True)


def _is_stale(updated_at: datetime | None) -> bool:
    return updated_at is None or updated_at < _now() - STALE_AFTER


def _now() -> datetime:
    return datetime.now(UTC)


def _status(code: StatusCode, message: str) -> dict[str, Any]:
    """A user-safe google.rpc.Status."""

    return {"code": int(code), "message": message}


__all__ = [
    "ACTIVE_RUN_STATUSES",
    "CONTENT_UNAVAILABLE",
    "INDEXING_STATES",
    "INTERNAL",
    "INTERRUPTED",
    "PROVIDER_REFUSED",
    "RETRYABLE_ITEM_STATUSES",
    "SCHEDULED_STATES",
    "START_FAILED_MESSAGE",
    "STOPPED_MESSAGE",
    "UNSUPPORTED_FORMAT",
    "IngestionRunService",
    "RunSelection",
    "governing_collections",
    "live_collections",
]
