"""Ingestion Runs: the one way Documents are processed.

Adding data only registers Documents (``pending``) and stores their originals.
Processing happens when someone — a person, an API client, the platform
console or a Source's schedule — creates an Ingestion Run. A run snapshots its
Documents into ``ingestion_run_items`` when it is created
(:meth:`IngestionRunService.snapshot`), so later uploads never join it. The
QUEUED row is the queue: an ingestion worker
(``bomesh.services.ingestion.worker``) owns a run while it holds the run's
session-level advisory lock (:func:`run_lock_key`) and processes it in bounded
batches; a run whose worker died is recovered (:meth:`IngestionRunService.recover`)
and resumed by the next worker that takes the lock. Authorization is the
caller's: this engine takes the set of collections a run may draw from.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from sqlalchemy import Select, and_, case, exists, func, literal, or_, select, text, update
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import (
    ExternalResource,
    IngestionRun,
    IngestionRunItem,
    IngestionSource,
    Item,
    ItemRevision,
    ItemUpload,
    MessageItem,
    Tenant,
)
from bomesh.errors import StatusCode
from bomesh.iam.policy import PERSONAL_COLLECTION_TYPE
from bomesh.services import current_processing_version
from bomesh.services.ingestion.names import source_name
from bomesh.services.knowledge_items.indexing import INTERRUPTED_MESSAGE
from bomesh.services.knowledge_items.item_store import HIDDEN_TYPES, ItemService
# [temporal-disabled] from bomesh.services.workflow.service import TemporalWorkflowService
from config import IngestionRunConfig

log = logging.getLogger(__name__)

ACTIVE_RUN_STATUSES = ("queued", "running")
TERMINAL_ITEM_STATUSES = frozenset({"succeeded", "failed", "cancelled"})
RETRYABLE_ITEM_STATUSES = ("failed", "cancelled")
#: What a Source's schedule processes after each sync.
SCHEDULED_STATES = ("PENDING", "OUTDATED")

# Provider-neutral failure categories of a task (``errorClass``); never raw messages.
PROVIDER_REFUSED = "provider_refused"
CONTENT_UNAVAILABLE = "content_unavailable"
UNSUPPORTED_FORMAT = "unsupported_format"
INTERRUPTED = "interrupted"
INTERNAL = "internal"

STOPPED_MESSAGE = "Processing stopped unexpectedly."
REMOVED_MESSAGE = "The document was removed before it was processed."
RUN_ENDED_MESSAGE = "The run ended before this document was processed."
# [temporal-disabled] Temporal-only constants (re-enabling also needs the imports
# ``timedelta``, ``Unavailable`` and ``IngestionSync`` back):
# START_FAILED_MESSAGE = "Processing could not be started. Try again in a moment."
# SYNC_STOPPED_MESSAGE = "The sync stopped unexpectedly."
# #: An open run or sync older than this is checked against Temporal.
# STALE_AFTER = timedelta(minutes=2)


@dataclass(frozen=True, slots=True)
class RunSelection:
    """The Documents a run asks for (``IngestionRunSelector``); set fields narrow each other.

    ``items`` exactly those Documents; ``filter`` the AIP-160 document filter
    as asked, ``filter_items`` the items it names and ``where`` its condition
    on ``Item``, compiled once at creation and never stored. Unset fields do
    not narrow.
    """

    items: tuple[UUID, ...] = ()
    filter: str | None = None
    filter_items: frozenset[UUID] = frozenset()
    where: Any = field(default=None, compare=False)

    @property
    def is_empty(self) -> bool:
        return not (self.items or self.filter)

    @property
    def excludes_personal(self) -> bool:
        """Personal collections are their owners' own unless named by item or by the filter."""
        return not self.items and not self.filter_items

    def scope(self) -> dict[str, Any]:
        """``ingestion_runs.scope``: the selector as asked for (``design.dbml``)."""
        scope: dict[str, Any] = {}
        if self.items:
            scope["item_ids"] = [str(item) for item in self.items]
        if self.filter:
            scope["filter"] = self.filter
        if self.filter_items:
            scope["filter_item_ids"] = sorted(str(item) for item in self.filter_items)
        return scope

    @classmethod
    def from_scope(cls, scope: Mapping[str, Any]) -> RunSelection:
        return cls(
            items=tuple(UUID(item) for item in scope.get("item_ids") or ()),
            filter=scope.get("filter"),
            filter_items=frozenset(UUID(item) for item in scope.get("filter_item_ids") or ()),
        )


@dataclass(frozen=True, slots=True)
class RunClassification:
    """``IngestionRun.classification``: candidate topic codes (none = every ACTIVE topic), a note."""

    topics: tuple[str, ...] = ()
    note: str | None = None

    def configuration(self) -> dict[str, Any]:
        """``ingestion_runs.configuration.classification``."""
        return {"topics": list(self.topics), "note": self.note}

    @classmethod
    def from_configuration(cls, configuration: Mapping[str, Any]) -> RunClassification | None:
        stored = configuration.get("classification")
        if not stored:
            return None
        return cls(topics=tuple(stored.get("topics") or ()), note=stored.get("note"))


@dataclass(frozen=True, slots=True)
class LockClaim:
    """A worker's claim of a run: advisory lock ``key`` held by backend ``pid``.

    ``pid`` is the claim's generation: a lock connection opened again is a new
    backend, so a claim made on a lost connection never validates again.
    """

    key: int
    pid: int


class OwnershipLost(RuntimeError):
    """The worker's lock connection no longer holds the run's lock: it must not write."""


class IngestionRunService:
    """Snapshot runs, settle them, and record what the ingestion worker does with them."""

    def __init__(
        self,
        session_factory: SessionFactory,
        *,
        # [temporal-disabled] workflows: TemporalWorkflowService,
        processing_signature: Callable[[], Mapping[str, Any]],
        run_config: IngestionRunConfig,
    ) -> None:
        self._session_factory = session_factory
        # [temporal-disabled] self._workflows = workflows
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
        classification: RunClassification | None = None,
    ) -> IngestionRun:
        """Create a QUEUED run in ``session`` holding the selected Documents.

        ``collections`` are the governing collections the run may draw from
        (``None``: every live collection of the workspace). Never selected:
        conversation attachments, assistant artifacts, unsupported Documents,
        Documents whose content is not available, Documents another active run
        holds and, when :attr:`RunSelection.excludes_personal`, Documents of
        personal collections. The run's ``scope`` records ``selection`` and its
        ``configuration`` the ``classification``.
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
            configuration=self._configuration(signature, version, classification),
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
                    *_narrowing(selection),
                    *_candidate(workspace_id),
                ),
            )
        )
        run.item_count = await _item_count(session, run.id)
        await session.flush()
        await session.refresh(run)
        return run

    async def launch(self, run_id: UUID, *, item_count: int) -> None:
        """Hand a snapshotted run to the workers; an empty run succeeds at once.

        The QUEUED row is the queue: an ingestion worker claims it.
        """

        if item_count == 0:
            await self.finish(run_id, outcome="succeeded")

    # [temporal-disabled] The Temporal launch, verbatim. Re-enabling restores the
    # ``workspace_id`` argument (callers: runs.py create/retry, create_scheduled_run).
    # async def launch(self, run_id: UUID, workspace_id: UUID, *, item_count: int) -> None:
    #     """Start a snapshotted run; an empty run succeeds at once.
    #
    #     A workflow that cannot start fails the run and raises UNAVAILABLE.
    #     """
    #
    #     if item_count == 0:
    #         await self.finish(run_id, outcome="succeeded")
    #         return
    #     try:
    #         await self._workflows.start_run(run_id, workspace_id)
    #     except Exception as exc:  # noqa: BLE001 - any start failure is reported the same way
    #         log.warning("ingestion run workflow could not start run_id=%s", run_id, exc_info=exc)
    #         await self.finish(
    #             run_id,
    #             outcome="failed",
    #             error=_status(StatusCode.UNAVAILABLE, START_FAILED_MESSAGE),
    #         )
    #         raise Unavailable(START_FAILED_MESSAGE) from exc

    async def create_scheduled_run(self, workspace_id: UUID, source_id: UUID) -> UUID | None:
        """Process what a Source left pending or outdated (trigger SCHEDULE).

        ``None`` when nothing is selected or the workspace does not process
        now (ingestion paused, workspace not ACTIVE): a schedule skips silently.
        """

        async with transaction_scope(self._session_factory) as session:
            workspace = await session.get(Tenant, workspace_id)
            if (
                workspace is None
                or workspace.status != "active"
                or workspace.ingestion_paused_at is not None
            ):
                return None
            source_code = await session.scalar(
                select(IngestionSource.code).where(IngestionSource.id == source_id)
            )
            if source_code is None:
                return None
            version = current_processing_version(dict(self._processing_signature()))
            states = " OR ".join(f"document.indexingState = {state}" for state in SCHEDULED_STATES)
            selection = RunSelection(
                filter=f'document.origin.source = "{source_name(workspace_id, source_code)}"'
                f" AND ({states})",
                where=and_(_registered_by(source_id), _state_filter(SCHEDULED_STATES, version)),
            )
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
        # [temporal-disabled] await self.launch(run_id, workspace_id, item_count=item_count)
        await self.launch(run_id, item_count=item_count)
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
        """Settle a cancelled run no worker executes; an owning worker settles its own.

        A worker holds the run's advisory lock while it executes the run: it
        sees the cancel within seconds, stops the Document each batch is
        processing (that Document waits again) and finishes the run.
        """

        async with transaction_scope(self._session_factory) as session:
            unowned = await session.scalar(
                select(func.pg_try_advisory_xact_lock(run_lock_key(run_id)))
            )
            if unowned:
                await _finish_run(session, run_id, outcome="cancelled", error=None)

    # [temporal-disabled] The Temporal stop, verbatim.
    # async def stop(self, run_id: UUID) -> None:
    #     """Ask the cancelled run's workflow to stop; without one, settle the run now.
    #
    #     The task each batch is processing stops and its Document waits again.
    #     """
    #
    #     try:
    #         requested = await self._workflows.cancel_run(run_id)
    #     except Exception:  # noqa: BLE001 - the batches also stop on their own
    #         log.warning("ingestion run cancel request failed run_id=%s", run_id, exc_info=True)
    #         requested = True
    #     if not requested:
    #         await self.finish(run_id, outcome="cancelled")
    #
    # -- Reading (Temporal) -------------------------------------------------------
    #
    # async def refresh(self, run: IngestionRun) -> bool:
    #     """End an open run whose workflow Temporal lost; ``True`` when it changed."""
    #
    #     if run.status not in ACTIVE_RUN_STATUSES or not _is_stale(run.updated_at):
    #         return False
    #     if not await self._workflow_is_lost(run.id):
    #         return False
    #     await self._stop_lost_run(run.id)
    #     return True

    # -- Execution (called by the ingestion worker) ----------------------------
    #
    # Every write below takes ``owner``: the worker's claim of the run. With an
    # owner, the write commits only while that claim's lock connection still
    # holds the run's advisory lock (checked in the same transaction, with the
    # run row locked so a recovering worker waits for it); otherwise it raises
    # :class:`OwnershipLost` and writes nothing. ``None`` (tests) skips the check.

    async def status(self, run_id: UUID) -> str | None:
        """The run's status (``None`` when it is gone): how a worker sees a cancel."""

        async with transaction_scope(self._session_factory) as session:
            return await session.scalar(select(IngestionRun.status).where(IngestionRun.id == run_id))

    async def recover(
        self, run_id: UUID, *, owner: LockClaim | None = None
    ) -> tuple[IngestionRun, int] | None:
        """Take over a claimed run whatever its previous worker left behind.

        Called by the worker that just acquired the run's lock, so every task
        still ``running`` belongs to a worker that died: it fails as
        ``interrupted`` and its Document waits again. Queued tasks lose their
        batch and are planned afresh. Returns the run and the first batch
        number not used yet (``None`` when the run is gone).
        """

        async with transaction_scope(self._session_factory) as session:
            run = await session.get(IngestionRun, run_id, with_for_update=True)
            if run is None:
                return None
            await _require_owner(session, owner)
            # Numbers already used stay used, so new batches never repeat one.
            highest = await session.scalar(
                select(func.max(IngestionRunItem.batch_number)).where(
                    IngestionRunItem.run_id == run_id
                )
            )
            await _release_tasks(session, run_id, interrupted="failed")
            return run, 0 if highest is None else int(highest) + 1

    async def requeue(self, run_id: UUID, *, owner: LockClaim | None = None) -> None:
        """Give back a run a worker stops executing (shutdown): nothing it ran is lost.

        Interrupted tasks are queued again and their Documents wait again;
        queued tasks lose their batch. The next worker resumes the run.
        """

        async with transaction_scope(self._session_factory) as session:
            await _lock_run(session, run_id, owner)
            await _release_tasks(session, run_id, interrupted="queued")

    async def start(self, run_id: UUID, *, owner: LockClaim | None = None) -> tuple[bool, int]:
        """Mark the run running; ``(still active, batches allowed at once)``."""

        async with transaction_scope(self._session_factory) as session:
            run = await session.get(IngestionRun, run_id, with_for_update=True)
            if run is None:
                return False, 1
            await _require_owner(session, owner)
            if run.status == "queued":
                run.status = "running"
                run.started_at = _now()
            parallelism = int(run.configuration.get("parallelism") or 1)
            return run.status == "running", max(1, parallelism)

    async def plan_batches(
        self,
        run_id: UUID,
        *,
        first_batch_number: int,
        max_batches: int,
        owner: LockClaim | None = None,
    ) -> list[tuple[int, list[UUID]]]:
        """The run's next batches, numbered from ``first_batch_number``.

        Idempotent: batches already planned at or after that number are
        returned as they are. Otherwise queued Documents not yet in a batch
        are packed, smallest first, up to the run's item and byte limits (a
        short tail is spread evenly over ``max_batches``); a
        file larger than the byte limit is a batch of its own. Empty when
        nothing is left to plan or the run stopped.
        """

        if max_batches < 1:
            raise ValueError("max_batches must be positive")
        async with transaction_scope(self._session_factory) as session:
            run = await session.get(IngestionRun, run_id, with_for_update=True)
            if run is None or run.status != "running":
                return []
            await _require_owner(session, owner)
            planned = (
                await session.execute(
                    select(IngestionRunItem.batch_number, IngestionRunItem.item_id)
                    .join(Item, Item.id == IngestionRunItem.item_id)
                    .outerjoin(ItemRevision, ItemRevision.id == Item.current_revision_id)
                    .where(
                        IngestionRunItem.run_id == run_id,
                        IngestionRunItem.batch_number >= first_batch_number,
                    )
                    .order_by(
                        IngestionRunItem.batch_number,
                        func.coalesce(ItemRevision.size_bytes, 0),
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
                    select(IngestionRunItem.item_id, func.coalesce(ItemRevision.size_bytes, 0))
                    .join(Item, Item.id == IngestionRunItem.item_id)
                    .outerjoin(ItemRevision, ItemRevision.id == Item.current_revision_id)
                    .where(
                        IngestionRunItem.run_id == run_id,
                        IngestionRunItem.batch_number.is_(None),
                        IngestionRunItem.status == "queued",
                    )
                    .order_by(func.coalesce(ItemRevision.size_bytes, 0), IngestionRunItem.item_id)
                    .limit(max_batches * max_items)
                )
            ).all()
            # A short tail is spread over every batch this call may plan, so
            # a small run uses the run's parallelism instead of one serial batch.
            per_batch = min(max_items, max(1, -(-len(unplanned) // max_batches)))
            batches = _pack(unplanned, max_items=per_batch, max_bytes=max_bytes, max_batches=max_batches)
            highest = await session.scalar(
                select(func.max(IngestionRunItem.batch_number)).where(
                    IngestionRunItem.run_id == run_id
                )
            )
            first = max(first_batch_number, -1 if highest is None else int(highest) + 1)
            numbered = [(first + offset, batch) for offset, batch in enumerate(batches)]
            if numbered:
                # One statement plans every batch of this call.
                await session.execute(
                    update(IngestionRunItem)
                    .where(
                        IngestionRunItem.run_id == run_id,
                        IngestionRunItem.item_id.in_(
                            [item_id for _, item_ids in numbered for item_id in item_ids]
                        ),
                    )
                    .values(
                        batch_number=case(
                            {
                                item_id: number
                                for number, item_ids in numbered
                                for item_id in item_ids
                            },
                            value=IngestionRunItem.item_id,
                        )
                    )
                )
            return numbered

    async def claim_item(
        self, run_id: UUID, item_id: UUID, *, owner: LockClaim | None = None
    ) -> bool:
        """Start one Document of a running run; ``False`` when it must not be processed.

        The task records the Document's newest live revision it starts from.
        A Document already finished in this run (a retried batch) is not
        processed again; one removed since the run was created is skipped.
        """

        async with transaction_scope(self._session_factory) as session:
            await _lock_run(session, run_id, owner)
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
        self,
        run_id: UUID,
        item_id: UUID,
        phases: Sequence[Mapping[str, Any]],
        *,
        owner: LockClaim | None = None,
    ) -> None:
        async with transaction_scope(self._session_factory) as session:
            await _lock_run(session, run_id, owner)
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
        owner: LockClaim | None = None,
    ) -> None:
        """Finish one running Document in the run: succeeded, failed, or cancelled.

        A failed Document carries its user-safe ``error`` and provider-neutral
        ``error_class``. A cancelled Document was interrupted mid-processing
        and waits again. A task no longer ``running`` (settled meanwhile) is
        left as it is.
        """

        if status not in TERMINAL_ITEM_STATUSES:
            raise ValueError("unsupported run item outcome")
        async with transaction_scope(self._session_factory) as session:
            await _lock_run(session, run_id, owner)
            run_item = await session.get(
                IngestionRunItem, (run_id, item_id), with_for_update=True
            )
            if run_item is None or run_item.status != "running":
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

    async def append_items(
        self, run_id: UUID, item_ids: Sequence[UUID], *, owner: LockClaim | None = None
    ) -> int:
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
            await _require_owner(session, owner)
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

    async def fail_batch(
        self, run_id: UUID, batch_number: int, *, owner: LockClaim | None = None
    ) -> None:
        """A batch that kept failing: its unfinished Documents fail, the run goes on."""

        async with transaction_scope(self._session_factory) as session:
            await _lock_run(session, run_id, owner)
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
        self,
        run_id: UUID,
        *,
        outcome: str,
        error: Mapping[str, Any] | None = None,
        owner: LockClaim | None = None,
    ) -> None:
        """Record how the run ended and settle every Document it did not finish.

        Only an active run (or a cancelled one not settled yet) is finished; a
        finished run is left as it is, so a cancel that arrived first stays a
        cancel. Queued Documents are cancelled; Documents interrupted
        mid-processing go back to pending. ``error`` is the google.rpc.Status
        of a failed run.
        """

        if outcome not in TERMINAL_ITEM_STATUSES:
            raise ValueError("unsupported run outcome")
        async with transaction_scope(self._session_factory) as session:
            await _finish_run(session, run_id, outcome=outcome, error=error, owner=owner)

    # -- Repair ------------------------------------------------------------------

    async def release_orphaned_documents(self) -> None:
        """Documents left ``processing`` outside any active run wait again.

        Safe at any time: a Document an active run holds is never touched.
        """

        async with transaction_scope(self._session_factory) as session:
            orphaned = list(
                await session.scalars(
                    select(Item.id).where(
                        Item.item_kind == "document",
                        Item.index_status == "processing",
                        Item.deleted_at.is_(None),
                        ~_in_active_run(Item.id),
                    )
                )
            )
            await _release_documents(session, orphaned, to="pending")

    # [temporal-disabled] The Temporal reconciliation, verbatim (called at API and
    # worker startup): runs/syncs whose Temporal execution was lost ended FAILED.
    # async def reconcile(self) -> None:
    #     """Repair state a lost workflow left behind; safe to call any time.
    #
    #     A run or sync still open in Postgres whose execution Temporal no longer
    #     has (or has closed) ends as failed; Documents left processing outside
    #     any active run wait again. Nothing is concluded while Temporal cannot
    #     be reached.
    #     """
    #
    #     cutoff = _now() - STALE_AFTER
    #     async with transaction_scope(self._session_factory) as session:
    #         run_ids = list(
    #             await session.scalars(
    #                 select(IngestionRun.id).where(
    #                     IngestionRun.status.in_(ACTIVE_RUN_STATUSES),
    #                     IngestionRun.updated_at < cutoff,
    #                 )
    #             )
    #         )
    #         lost_sync_sources = list(
    #             await session.scalars(
    #                 select(IngestionSync.ingestion_source_id).where(
    #                     IngestionSync.status == "running",
    #                     IngestionSync.started_at < cutoff,
    #                 )
    #             )
    #         )
    #     try:
    #         for run_id in run_ids:
    #             if not await self._workflows.run_is_open(run_id):
    #                 await self._stop_lost_run(run_id)
    #         for source_id in lost_sync_sources:
    #             if not await self._workflows.source_sync_is_open(source_id):
    #                 await self._fail_lost_sync(source_id)
    #     except Exception:  # noqa: BLE001 - an unreachable Temporal proves nothing
    #         log.warning("ingestion reconciliation skipped: Temporal unavailable", exc_info=True)
    #         return
    #     await self.release_orphaned_documents()
    #
    # async def _workflow_is_lost(self, run_id: UUID) -> bool:
    #     try:
    #         return not await self._workflows.run_is_open(run_id)
    #     except Exception:  # noqa: BLE001 - an unreachable Temporal proves nothing
    #         log.warning("ingestion run state check failed run_id=%s", run_id, exc_info=True)
    #         return False
    #
    # async def _stop_lost_run(self, run_id: UUID) -> None:
    #     """A run whose workflow is gone: failed, and nothing it held stays waiting on it."""
    #
    #     async with transaction_scope(self._session_factory) as session:
    #         run = await session.get(IngestionRun, run_id, with_for_update=True)
    #         if run is None or run.status not in ACTIVE_RUN_STATUSES:
    #             return
    #         run.status = "failed"
    #         run.error = _status(StatusCode.INTERNAL, STOPPED_MESSAGE)
    #         run.finished_at = run.finished_at or _now()
    #         await _settle_items(session, run_id, queued_error=None)
    #     log.warning("ingestion run stopped without its workflow run_id=%s", run_id)
    #
    # async def _fail_lost_sync(self, source_id: UUID) -> None:
    #     async with transaction_scope(self._session_factory) as session:
    #         await session.execute(
    #             update(IngestionSync)
    #             .where(
    #                 IngestionSync.ingestion_source_id == source_id,
    #                 IngestionSync.status == "running",
    #             )
    #             .values(
    #                 status="failed",
    #                 error=_status(StatusCode.INTERNAL, SYNC_STOPPED_MESSAGE),
    #                 finished_at=_now(),
    #             )
    #         )
    #     log.warning("source sync stopped without its workflow source_id=%s", source_id)

    # -- Internals ---------------------------------------------------------------

    def _configuration(
        self,
        signature: Mapping[str, Any],
        version: str,
        classification: RunClassification | None,
    ) -> dict[str, Any]:
        config = self._run_config
        configuration: dict[str, Any] = {
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
        if classification is not None:
            configuration["classification"] = classification.configuration()
        return configuration


# -- Selection (SQL) -------------------------------------------------------------


async def live_collections(session: AsyncSession, workspace_id: UUID) -> frozenset[UUID]:
    """Every live collection of the workspace (what a workspace-wide holder may process)."""

    return frozenset(
        await session.scalars(
            select(Item.id).where(
                Item.tenant_id == workspace_id,
                Item.item_kind == "collection",
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
    excluded_types = list(HIDDEN_TYPES)
    if selection.excludes_personal:
        excluded_types.append(PERSONAL_COLLECTION_TYPE)
    excluded = await session.scalars(
        select(Item.id).where(
            Item.tenant_id == workspace_id,
            Item.item_kind == "collection",
            Item.item_type.in_(excluded_types),
        )
    )
    return roots - set(excluded)


def _narrowing(selection: RunSelection) -> list[Any]:
    conditions: list[Any] = []
    if selection.items:
        conditions.append(Item.id.in_(selection.items))
    if selection.where is not None:
        conditions.append(selection.where)
    return conditions


def _registered_by(source_id: UUID) -> Any:
    """Documents a Source registered and still tracks."""

    return Item.id.in_(
        select(ExternalResource.item_id).where(
            ExternalResource.ingestion_source_id == source_id,
            ExternalResource.deleted_at.is_(None),
        )
    )


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
        Item.item_kind == "document",
        Item.deleted_at.is_(None),
        Item.current_revision_id.is_not(None),
        Item.index_status != "unsupported",
        or_(
            ItemUpload.status == "available",
            and_(ItemUpload.item_id.is_(None), Item.current_revision_id.is_not(None)),
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
            Item.item_kind == "document",
            Item.parent_item_id.in_(list(roots)),
        )
        .cte("run_scope_documents", recursive=True)
    )
    child = aliased(Item)
    documents = documents.union_all(
        select(child.id).join(documents, child.parent_item_id == documents.c.item_id).where(
            child.item_kind == "document"
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
            Item.item_kind == "document",
            Item.deleted_at.is_(None),
        )
        .cte("governing_climb", recursive=True)
    )
    parent = aliased(Item)
    climb = climb.union_all(
        select(climb.c.document_id, parent.parent_item_id)
        .join(parent, parent.id == climb.c.parent_id)
        .where(parent.item_kind == "document")
    )
    collection = aliased(Item)
    return (
        select(climb.c.document_id, collection.id.label("collection_id"))
        .join(collection, collection.id == climb.c.parent_id)
        .where(collection.item_kind == "collection")
        .subquery("governing")
    )


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


async def _lock_run(session: AsyncSession, run_id: UUID, owner: LockClaim | None) -> None:
    """Share-lock the run row (a recovering worker waits), then require ``owner``'s claim."""

    if owner is None:
        return
    await session.execute(
        select(IngestionRun.id).where(IngestionRun.id == run_id).with_for_update(read=True)
    )
    await _require_owner(session, owner)


async def _require_owner(session: AsyncSession, owner: LockClaim | None) -> None:
    """Raise :class:`OwnershipLost` unless ``owner``'s connection still holds its lock.

    The caller holds the run row lock, so the claim cannot change hands before
    this transaction commits: a worker that takes the lock over recovers the
    run only after it.
    """

    if owner is None:
        return
    held = await session.scalar(
        text(
            "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted"
            " AND pid = :pid AND classid = CAST(:high AS oid)"
            " AND objid = CAST(:low AS oid) AND objsubid = 1)"
        ),
        {"pid": owner.pid, "high": (owner.key >> 32) & 0xFFFFFFFF, "low": owner.key & 0xFFFFFFFF},
    )
    if not held:
        raise OwnershipLost(f"this worker no longer holds lock {owner.key}")


async def _finish_run(
    session: AsyncSession,
    run_id: UUID,
    *,
    outcome: str,
    error: Mapping[str, Any] | None,
    owner: LockClaim | None = None,
) -> None:
    """:meth:`IngestionRunService.finish` inside the caller's transaction."""

    run = await session.get(IngestionRun, run_id, with_for_update=True)
    if run is None:
        return
    await _require_owner(session, owner)
    if run.status not in ACTIVE_RUN_STATUSES and run.finished_at is not None:
        return
    if run.status in ACTIVE_RUN_STATUSES:
        run.status = outcome
        if outcome == "failed":
            run.error = dict(error or _status(StatusCode.INTERNAL, STOPPED_MESSAGE))
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


async def _release_tasks(session: AsyncSession, run_id: UUID, *, interrupted: str) -> None:
    """Free a run's tasks from the worker that executed it; their Documents wait again.

    ``interrupted`` is what a ``running`` task becomes: ``failed`` (its worker
    died: ``interrupted``) or ``queued`` (its worker gave it back). Queued tasks
    lose their batch so the next worker plans them afresh.
    """

    values: dict[str, Any] = (
        {
            "status": "failed",
            "error": _status(StatusCode.ABORTED, INTERRUPTED_MESSAGE),
            "error_class": INTERRUPTED,
            "finished_at": _now(),
        }
        if interrupted == "failed"
        else {
            "status": "queued",
            "batch_number": None,
            "started_at": None,
            "phases": [],
        }
    )
    released = list(
        await session.scalars(
            update(IngestionRunItem)
            .where(IngestionRunItem.run_id == run_id, IngestionRunItem.status == "running")
            .values(**values)
            .returning(IngestionRunItem.item_id)
        )
    )
    await session.execute(
        update(IngestionRunItem)
        .where(
            IngestionRunItem.run_id == run_id,
            IngestionRunItem.status == "queued",
            IngestionRunItem.batch_number.is_not(None),
        )
        .values(batch_number=None)
    )
    await _release_documents(session, released, to="pending")


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


def advisory_lock_key(namespace: str, value: UUID | str) -> int:
    """A PostgreSQL advisory lock key (signed int64) for ``value`` in ``namespace``."""

    digest = uuid5(NAMESPACE_URL, f"bomesh:{namespace}:{value}")
    return int.from_bytes(digest.bytes[:8], byteorder="big", signed=True)


def run_lock_key(run_id: UUID) -> int:
    """The lock an ingestion worker holds (session level) while it executes the run."""

    return advisory_lock_key("ingestion-run", run_id)


def _workspace_lock_key(workspace_id: UUID) -> int:
    return advisory_lock_key("ingestion-run-selection", workspace_id)


# [temporal-disabled] Used by the Temporal ``refresh``/``reconcile`` only.
# def _is_stale(updated_at: datetime | None) -> bool:
#     return updated_at is None or updated_at < _now() - STALE_AFTER


def _now() -> datetime:
    return datetime.now(UTC)


def _status(code: StatusCode, message: str) -> dict[str, Any]:
    """A user-safe google.rpc.Status."""

    return {"code": int(code), "message": message}


__all__ = [
    "ACTIVE_RUN_STATUSES",
    "CONTENT_UNAVAILABLE",
    "INTERNAL",
    "INTERRUPTED",
    "PROVIDER_REFUSED",
    "RETRYABLE_ITEM_STATUSES",
    "SCHEDULED_STATES",
    "STOPPED_MESSAGE",
    "UNSUPPORTED_FORMAT",
    "IngestionRunService",
    "LockClaim",
    "OwnershipLost",
    "RunClassification",
    "RunSelection",
    "advisory_lock_key",
    "governing_collections",
    "live_collections",
    "run_lock_key",
]
