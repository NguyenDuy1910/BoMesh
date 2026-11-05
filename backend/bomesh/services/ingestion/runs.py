"""IngestionRun: Create, Get, List, Cancel, Retry and Summarize (``api_design.md`` §6).

Selection rules (``item_model.md`` §6 invariant 10): explicit ``items[]`` are
checked one by one (each needs ``ingestionRuns.create`` on its governing
collection and must be visible, else PERMISSION_DENIED); ``ancestor``,
``source`` and ``states`` silently narrow to the collections where the caller
holds ``ingestionRuns.create`` — every live collection for a holder at the
workspace (or, for platform callers, platform) scope. The selection is
resolved once into the run's tasks (the engine's snapshot).

Members read runs through the Item visibility rule: ``counts`` and
``selector.items[]`` cover only items they can see. Platform callers (not
ACTIVE members) and ``workspaces/-`` reads are metadata-only: full counts,
never ``selector`` or ``error``.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import ColumnElement, func, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import (
    IngestionRun,
    IngestionRunItem,
    IngestionSource,
    Item,
    Tenant,
)
from bomesh.errors import (
    FailedPrecondition,
    InvalidArgument,
    NotFound,
    PermissionDenied,
)
from bomesh.iam.authorizer import ItemRef, PlatformRef, WorkspaceRef, permission_denied
from bomesh.iam.visibility import ItemVisibility, is_visible
from bomesh.services.ingestion.common import is_platform_caller, run_name
from bomesh.services.ingestion.names import source_name
from bomesh.services.ingestion.run_engine import (
    ACTIVE_RUN_STATUSES,
    INDEXING_STATES,
    INTERNAL,
    RETRYABLE_ITEM_STATUSES,
    IngestionRunService,
    RunSelection,
    governing_collections,
    live_collections,
)
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.workspaces import (
    WorkspaceResolver,
    require_usable,
    workspace_name,
)
from bomesh.services.knowledge_items.item_store import catalog_visibility
from bomesh.services.knowledge_items.names import item_name

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

CREATE = "ingestionRuns.create"
MAX_SELECTED_ITEMS = 1000
PAUSED_MESSAGE = "Ingestion is paused for this workspace."
#: Triggers a caller may ask for; ``SCHEDULE`` is set only by a Source's schedule.
_REQUESTED_TRIGGERS = {"MANUAL": "manual", "API": "api", "PLATFORM_RETRY": "platform_retry"}
#: Window of the throughput, failure rate and error classes without a ``createTime`` bound.
SUMMARY_WINDOW = timedelta(hours=1)
#: Run states RetryIngestionRun accepts.
_RETRYABLE_RUN_STATUSES = ("failed", "cancelled")


@dataclass(frozen=True, slots=True)
class RunSelector:
    """``IngestionRunSelector`` with references parsed: item IDs, collection ID, source ID."""

    items: tuple[UUID, ...] = ()
    ancestor: UUID | None = None
    source: str | None = None
    #: ``IndexingState`` values.
    states: tuple[str, ...] = ()

    @property
    def is_empty(self) -> bool:
        return not (self.items or self.ancestor or self.source or self.states)


@dataclass(frozen=True, slots=True)
class RunCounts:
    queued: int = 0
    running: int = 0
    succeeded: int = 0
    failed: int = 0
    cancelled: int = 0

    @property
    def total(self) -> int:
        return self.queued + self.running + self.succeeded + self.failed + self.cancelled


@dataclass(frozen=True, slots=True)
class IngestionRunRecord:
    """One run as the caller may read it; ``selector``/``error`` are ``None`` when metadata-only."""

    workspace_id: UUID
    run_id: UUID
    #: ``ingestion_runs.status`` (queued, running, succeeded, failed, cancelled).
    state: str
    #: ``ingestion_runs.trigger_type`` (manual, api, schedule, platform_retry).
    trigger: str
    counts: RunCounts
    selector: RunSelector | None
    error: Mapping[str, Any] | None
    retry_of: UUID | None
    create_time: datetime
    start_time: datetime | None
    end_time: datetime | None


@dataclass(frozen=True, slots=True)
class WorkspaceIngestionSummary:
    """Queue, throughput and failures of one workspace; never names."""

    workspace_id: UUID
    queued_task_count: int
    running_task_count: int
    throughput_per_hour: float
    failure_rate: float
    #: ``(errorClass, taskCount)``, most frequent first.
    error_classes: tuple[tuple[str, int], ...]


class IngestionRuns:
    """The IngestionRun resource on top of the run engine (:class:`IngestionRunService`)."""

    def __init__(
        self, sessions: SessionFactory, engine: IngestionRunService, request_hash_secret: bytes
    ) -> None:
        self._sessions = sessions
        self._engine = engine
        self._secret = request_hash_secret
        self._workspaces = WorkspaceResolver(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> IngestionRuns:
        return cls(
            runtime.sessions(), runtime.ingestion_run_service(), runtime.request_hash_secret()
        )

    # -- Create and retry ------------------------------------------------------

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        selector: RunSelector | None,
        *,
        trigger: str = "MANUAL",
        request_id: UUID | None = None,
        validate_only: bool = False,
    ) -> IngestionRunRecord:
        """CreateIngestionRun: snapshot the selection and start processing it.

        Nothing selected is an empty run that succeeds at once.
        """
        collections = await self._processable_collections(ctx, workspace_id)
        await self._open_for_processing(workspace_id)
        platform = await is_platform_caller(ctx, workspace_id)
        db_trigger = _requested_trigger(trigger, platform=platform)
        selection = await self._resolve(ctx, workspace_id, selector, collections)
        visibility = await self._visibility(ctx, workspace_id)
        request = {"selector": selection.scope(), "trigger": trigger}
        async with transaction_scope(self._sessions) as session:
            idempotency = Idempotency(session, self._secret)
            key = (
                idempotency.key(
                    ctx.principal,
                    request_id,
                    method="CreateIngestionRun",
                    parent=workspace_name(workspace_id),
                    request=request,
                )
                if request_id is not None and not validate_only
                else None
            )
            replayed = await idempotency.replay(key) if key is not None else None
            if replayed is not None:
                return await _replayed(session, workspace_id, replayed, visibility)
            savepoint = await session.begin_nested() if validate_only else None
            run = await self._engine.snapshot(
                session,
                workspace_id=workspace_id,
                selection=selection,
                collections=collections,
                trigger=db_trigger,
                created_by_user_id=ctx.user_id,
            )
            if savepoint is not None:
                (record,) = await _records(session, [run], visibility)
                await savepoint.rollback()
                return record
            name = run_name(workspace_id, run.id)
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="sources",
                action="CreateIngestionRun",
                target=name,
            )
            if key is not None:
                await idempotency.remember(key, name)
            run_id, item_count = run.id, run.item_count
        await self._engine.launch(run_id, workspace_id, item_count=item_count)
        return await self._read(workspace_id, run_id, visibility)

    async def retry(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        run_id: UUID,
        *,
        request_id: UUID | None = None,
    ) -> IngestionRunRecord:
        """RetryIngestionRun: a new run over the failed and cancelled tasks of a stopped run.

        The retried Documents silently narrow to the collections where the
        caller holds ``ingestionRuns.create``; the selection exclusions apply again.
        """
        collections = await self._processable_collections(ctx, workspace_id)
        await self._open_for_processing(workspace_id)
        platform = await is_platform_caller(ctx, workspace_id)
        visibility = await self._visibility(ctx, workspace_id)
        target = run_name(workspace_id, run_id)
        async with transaction_scope(self._sessions) as session:
            idempotency = Idempotency(session, self._secret)
            key = (
                idempotency.key(
                    ctx.principal,
                    request_id,
                    method="RetryIngestionRun",
                    parent=target,
                    request={},
                )
                if request_id is not None
                else None
            )
            replayed = await idempotency.replay(key) if key is not None else None
            if replayed is not None:
                return await _replayed(session, workspace_id, replayed, visibility)
            retried = await _run(session, workspace_id, run_id)
            if retried.status not in _RETRYABLE_RUN_STATUSES:
                raise FailedPrecondition(
                    f"Ingestion run '{target}' is {retried.status.upper()}; "
                    "only a FAILED or CANCELLED run can be retried."
                )
            items = tuple(
                await session.scalars(
                    select(IngestionRunItem.item_id)
                    .where(
                        IngestionRunItem.run_id == run_id,
                        IngestionRunItem.status.in_(RETRYABLE_ITEM_STATUSES),
                    )
                    .order_by(IngestionRunItem.item_id)
                )
            )
            run = await self._engine.snapshot(
                session,
                workspace_id=workspace_id,
                selection=RunSelection(items=items),
                collections=collections,
                trigger="platform_retry" if platform else "manual",
                created_by_user_id=ctx.user_id,
                retry_of_run_id=run_id,
            )
            name = run_name(workspace_id, run.id)
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="sources",
                action="RetryIngestionRun",
                target=target,
                details={"ingestionRun": name},
            )
            if key is not None:
                await idempotency.remember(key, name)
            new_id, item_count = run.id, run.item_count
        await self._engine.launch(new_id, workspace_id, item_count=item_count)
        return await self._read(workspace_id, new_id, visibility)

    # -- Read ------------------------------------------------------------------

    async def get(
        self, ctx: RequestContext, workspace_id: UUID, run_id: UUID
    ) -> IngestionRunRecord:
        """GetIngestionRun; an open run whose workflow Temporal lost ends as FAILED first."""
        await self._workspaces.open(
            ctx, WorkspaceRef(workspace_id), "ingestionRuns.get", write=False
        )
        visibility = await self._visibility(ctx, workspace_id)
        async with transaction_scope(self._sessions) as session:
            run = await _run(session, workspace_id, run_id)
        await self._engine.refresh(run)
        return await self._read(workspace_id, run_id, visibility)

    async def list(
        self, ctx: RequestContext, workspace_id: UUID | None, query: ListQuery
    ) -> list[IngestionRunRecord]:
        """ListIngestionRuns; ``workspace_id=None`` is ``workspaces/-`` (platform, metadata-only)."""
        if workspace_id is None:
            await ctx.authorizer.require(ctx.principal, "ingestionRuns.list", PlatformRef())
            visibility, scope = None, true()
        else:
            await self._workspaces.open(
                ctx, WorkspaceRef(workspace_id), "ingestionRuns.list", write=False
            )
            visibility = await self._visibility(ctx, workspace_id)
            scope = IngestionRun.tenant_id == workspace_id
        async with transaction_scope(self._sessions) as session:
            runs = list(await session.scalars(query.apply(select(IngestionRun).where(scope))))
            return await _records(session, runs, visibility)

    # -- Cancel ----------------------------------------------------------------

    async def cancel(
        self, ctx: RequestContext, workspace_id: UUID, run_id: UUID
    ) -> IngestionRunRecord:
        """CancelIngestionRun: QUEUED/RUNNING → CANCELLED, else FAILED_PRECONDITION."""
        await self._workspaces.open(
            ctx, WorkspaceRef(workspace_id), "ingestionRuns.cancel", write=True
        )
        visibility = await self._visibility(ctx, workspace_id)
        target = run_name(workspace_id, run_id)
        async with transaction_scope(self._sessions) as session:
            run = await _run(session, workspace_id, run_id, for_update=True)
            if run.status not in ACTIVE_RUN_STATUSES:
                raise FailedPrecondition(
                    f"Ingestion run '{target}' is {run.status.upper()}; "
                    "only a QUEUED or RUNNING run can be cancelled."
                )
            await self._engine.mark_cancelled(session, run)
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="sources",
                action="CancelIngestionRun",
                target=target,
            )
        await self._engine.stop(run_id)
        return await self._read(workspace_id, run_id, visibility)

    # -- Summarize ---------------------------------------------------------------

    async def summarize(
        self,
        ctx: RequestContext,
        workspace_id: UUID | None,
        *,
        where: ColumnElement[bool],
        since: datetime | None = None,
    ) -> list[WorkspaceIngestionSummary]:
        """SummarizeIngestionRuns over the runs matching ``where`` (their ``createTime``).

        Queue counts are the matching runs' queued and running tasks now.
        Throughput, failure rate and error classes count their tasks that
        finished since ``since`` (default: the last hour). ``workspace_id=None``
        (``workspaces/-``, platform) returns one row per workspace.
        """
        if workspace_id is None:
            await ctx.authorizer.require(ctx.principal, "ingestionRuns.summarize", PlatformRef())
        else:
            await self._workspaces.open(
                ctx, WorkspaceRef(workspace_id), "ingestionRuns.summarize", write=False
            )
        now = datetime.now(UTC)
        start = since or now - SUMMARY_WINDOW
        hours = max((now - start).total_seconds(), 1.0) / 3600
        runs = select(IngestionRun.id, IngestionRun.tenant_id).where(where)
        if workspace_id is not None:
            runs = runs.where(IngestionRun.tenant_id == workspace_id)
        matching = runs.subquery()
        tasks = (
            select(matching.c.tenant_id, IngestionRunItem.status, func.count())
            .select_from(IngestionRunItem)
            .join(matching, matching.c.id == IngestionRunItem.run_id)
            .group_by(matching.c.tenant_id, IngestionRunItem.status)
        )
        error_class = func.coalesce(IngestionRunItem.error_class, INTERNAL)
        async with transaction_scope(self._sessions) as session:
            workspaces = (
                [workspace_id]
                if workspace_id is not None
                else list(await session.scalars(select(Tenant.id).order_by(Tenant.id)))
            )
            queue = _by_workspace(
                await session.execute(
                    tasks.where(IngestionRunItem.status.in_(ACTIVE_RUN_STATUSES))
                )
            )
            finished = _by_workspace(
                await session.execute(
                    tasks.where(
                        IngestionRunItem.status.in_(("succeeded", "failed")),
                        IngestionRunItem.finished_at >= start,
                    )
                )
            )
            classes = _by_workspace(
                await session.execute(
                    select(matching.c.tenant_id, error_class, func.count())
                    .select_from(IngestionRunItem)
                    .join(matching, matching.c.id == IngestionRunItem.run_id)
                    .where(
                        IngestionRunItem.status == "failed",
                        IngestionRunItem.finished_at >= start,
                    )
                    .group_by(matching.c.tenant_id, error_class)
                )
            )
        return [
            _summary(
                workspace,
                queue.get(workspace, {}),
                finished.get(workspace, {}),
                classes.get(workspace, {}),
                hours=hours,
            )
            for workspace in workspaces
        ]

    # -- Internals ---------------------------------------------------------------

    async def _processable_collections(
        self, ctx: RequestContext, workspace_id: UUID
    ) -> frozenset[UUID]:
        """Collections where the caller holds ``ingestionRuns.create``.

        PERMISSION_DENIED unless held at the workspace or platform scope or on
        at least one collection.
        """
        authorizer, principal = ctx.authorizer, ctx.principal
        workspace_wide = CREATE in await authorizer.permissions(
            principal, WorkspaceRef(workspace_id)
        )
        if await authorizer.is_active_member(principal, workspace_id):
            collections = await authorizer.allowed_collections(principal, workspace_id, CREATE)
        elif workspace_wide:
            async with transaction_scope(self._sessions) as session:
                collections = await live_collections(session, workspace_id)
        else:
            collections = frozenset()
        if not workspace_wide and not collections:
            raise permission_denied(CREATE, WorkspaceRef(workspace_id))
        return collections

    async def _open_for_processing(self, workspace_id: UUID) -> None:
        workspace = await self._workspaces.get(workspace_id)
        require_usable(workspace, write=True)
        if workspace.ingestion_paused_at is not None:
            raise FailedPrecondition(PAUSED_MESSAGE)

    async def _resolve(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        selector: RunSelector | None,
        collections: frozenset[UUID],
    ) -> RunSelection:
        """Validate the selector and check its references; the engine selection."""
        if selector is None or selector.is_empty:
            raise InvalidArgument.for_field(
                "selector",
                "A selector with items, ancestor, source or states is required.",
            )
        items = tuple(dict.fromkeys(selector.items))
        if len(items) > MAX_SELECTED_ITEMS:
            raise InvalidArgument.for_field(
                "selector.items", f"At most {MAX_SELECTED_ITEMS} items can be selected."
            )
        states = tuple(dict.fromkeys(selector.states))
        if not set(states) <= set(INDEXING_STATES):
            raise InvalidArgument.for_field(
                "selector.states", f"States must be among {', '.join(INDEXING_STATES)}."
            )
        await self._check_items(ctx, workspace_id, items, collections)
        if selector.ancestor is not None:
            await _check_ancestor(ctx, workspace_id, selector.ancestor)
        source_id = (
            await self._source_id(ctx, workspace_id, selector.source)
            if selector.source is not None
            else None
        )
        return RunSelection(
            items=items, ancestor=selector.ancestor, source_id=source_id, states=states
        )

    async def _check_items(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        items: Sequence[UUID],
        collections: frozenset[UUID],
    ) -> None:
        """Each explicit item: visible (else 403), a DOCUMENT (else 400), processable (else 403)."""
        if not items:
            return
        async with transaction_scope(self._sessions) as session:
            visibility = await catalog_visibility(
                session, ctx.authorizer, ctx.principal, workspace_id
            )
            types = dict(
                (
                    await session.execute(
                        select(Item.id, Item.item_type).where(
                            Item.id.in_(items), visibility.clause(Item)
                        )
                    )
                ).all()
            )
            governing = await governing_collections(
                session, workspace_id, [item for item in items if types.get(item) == "document"]
            )
        for item in items:
            ref = ItemRef(workspace_id, item)
            if item not in types:
                raise permission_denied(CREATE, ref)
            if types[item] != "document":
                raise InvalidArgument.for_field(
                    "selector.items", f"'{ref.name}' is not a DOCUMENT item."
                )
            if governing.get(item) not in collections:
                raise permission_denied(CREATE, ref)

    async def _source_id(self, ctx: RequestContext, workspace_id: UUID, source: str) -> UUID:
        """The live source the caller can read (``sources.get``); PERMISSION_DENIED otherwise."""
        name = source_name(workspace_id, source)
        readable = "sources.get" in await ctx.authorizer.permissions(
            ctx.principal, WorkspaceRef(workspace_id)
        )
        source_id = None
        if readable:
            async with transaction_scope(self._sessions) as session:
                source_id = await session.scalar(
                    select(IngestionSource.id).where(
                        IngestionSource.tenant_id == workspace_id,
                        IngestionSource.code == source,
                        IngestionSource.deleted_at.is_(None),
                    )
                )
        if source_id is None:
            raise PermissionDenied(
                f"Permission 'sources.get' denied on resource '{name}' (or it might not exist)",
                metadata={"permission": "sources.get", "resource": name},
            )
        return source_id

    async def _visibility(
        self, ctx: RequestContext, workspace_id: UUID
    ) -> ItemVisibility | None:
        """The caller's catalog visibility; ``None`` for platform callers, who read metadata only."""
        if await is_platform_caller(ctx, workspace_id):
            return None
        async with transaction_scope(self._sessions) as session:
            return await catalog_visibility(session, ctx.authorizer, ctx.principal, workspace_id)

    async def _read(
        self, workspace_id: UUID, run_id: UUID, visibility: ItemVisibility | None
    ) -> IngestionRunRecord:
        async with transaction_scope(self._sessions) as session:
            run = await _run(session, workspace_id, run_id)
            (record,) = await _records(session, [run], visibility)
            return record


async def _check_ancestor(ctx: RequestContext, workspace_id: UUID, ancestor: UUID) -> None:
    ref = ItemRef(workspace_id, ancestor)
    if not await is_visible(ctx.authorizer, ctx.principal, ref):
        raise permission_denied("items.get", ref)
    (node, *_) = await ctx.authorizer.ancestry(ancestor)
    if node.item_type != "collection":
        raise InvalidArgument.for_field(
            "selector.ancestor", f"'{item_name(workspace_id, ancestor)}' is not a COLLECTION item."
        )


def _requested_trigger(trigger: str, *, platform: bool) -> str:
    if trigger == "PLATFORM_RETRY" and not platform:
        raise InvalidArgument.for_field(
            "trigger", "PLATFORM_RETRY is reserved for the platform console."
        )
    if trigger not in _REQUESTED_TRIGGERS:
        raise InvalidArgument.for_field(
            "trigger", "trigger must be MANUAL, API or PLATFORM_RETRY."
        )
    return _REQUESTED_TRIGGERS[trigger]


async def _run(
    session: AsyncSession, workspace_id: UUID, run_id: UUID, *, for_update: bool = False
) -> IngestionRun:
    statement = select(IngestionRun).where(
        IngestionRun.id == run_id, IngestionRun.tenant_id == workspace_id
    )
    if for_update:
        statement = statement.with_for_update()
    run = await session.scalar(statement)
    if run is None:
        raise NotFound(f"Resource '{run_name(workspace_id, run_id)}' was not found.")
    return run


async def _replayed(
    session: AsyncSession,
    workspace_id: UUID,
    name: str,
    visibility: ItemVisibility | None,
) -> IngestionRunRecord:
    run = await _run(session, workspace_id, UUID(name.rsplit("/", 1)[-1]))
    (record,) = await _records(session, [run], visibility)
    return record


async def _records(
    session: AsyncSession, runs: Sequence[IngestionRun], visibility: ItemVisibility | None
) -> list[IngestionRunRecord]:
    """Shape runs for the caller; ``visibility=None`` reads them as metadata."""
    if not runs:
        return []
    counted = (
        select(IngestionRunItem.run_id, IngestionRunItem.status, func.count())
        .where(IngestionRunItem.run_id.in_([run.id for run in runs]))
        .group_by(IngestionRunItem.run_id, IngestionRunItem.status)
    )
    selected: set[UUID] = set()
    scopes = {run.id: RunSelection.from_scope(run.scope or {}) for run in runs}
    if visibility is not None:
        counted = counted.join(Item, Item.id == IngestionRunItem.item_id).where(
            visibility.clause(Item)
        )
        # Echoed references: explicit items and the ancestor, each only if visible.
        selected = {item for scope in scopes.values() for item in scope.items} | {
            scope.ancestor for scope in scopes.values() if scope.ancestor is not None
        }
    counts: dict[UUID, dict[str, int]] = {}
    for run_id, status, count in (await session.execute(counted)).all():
        counts.setdefault(run_id, {})[status] = int(count)
    visible: set[UUID] = set()
    sources: dict[UUID, str] = {}
    if visibility is not None:
        if selected:
            visible = set(
                await session.scalars(
                    select(Item.id).where(Item.id.in_(selected), visibility.clause(Item))
                )
            )
        source_ids = {scope.source_id for scope in scopes.values() if scope.source_id}
        if source_ids:
            sources = dict(
                (
                    await session.execute(
                        select(IngestionSource.id, IngestionSource.code).where(
                            IngestionSource.id.in_(source_ids)
                        )
                    )
                ).all()
            )
    return [
        _record(
            run,
            counts.get(run.id, {}),
            _selector(scopes[run.id], visible, sources) if visibility is not None else None,
        )
        for run in runs
    ]


def _record(
    run: IngestionRun, counts: Mapping[str, int], selector: RunSelector | None
) -> IngestionRunRecord:
    return IngestionRunRecord(
        workspace_id=run.tenant_id,
        run_id=run.id,
        state=run.status,
        trigger=run.trigger_type,
        counts=RunCounts(
            queued=counts.get("queued", 0),
            running=counts.get("running", 0),
            succeeded=counts.get("succeeded", 0),
            failed=counts.get("failed", 0),
            cancelled=counts.get("cancelled", 0),
        ),
        selector=selector,
        error=run.error if selector is not None else None,
        retry_of=run.retry_of_run_id,
        create_time=run.created_at,
        start_time=run.started_at,
        end_time=run.finished_at,
    )


def _selector(
    scope: RunSelection, visible: set[UUID], sources: Mapping[UUID, str]
) -> RunSelector:
    """The run's selector for a member: only visible items and ancestor are echoed."""
    return RunSelector(
        items=tuple(item for item in scope.items if item in visible),
        ancestor=scope.ancestor if scope.ancestor in visible else None,
        source=sources.get(scope.source_id) if scope.source_id is not None else None,
        states=scope.states,
    )


def _by_workspace(rows: Any) -> dict[UUID, dict[str, int]]:
    grouped: dict[UUID, dict[str, int]] = {}
    for workspace_id, key, count in rows.all():
        grouped.setdefault(workspace_id, {})[key] = int(count)
    return grouped


def _summary(
    workspace_id: UUID,
    queue: Mapping[str, int],
    finished: Mapping[str, int],
    classes: Mapping[str, int],
    *,
    hours: float,
) -> WorkspaceIngestionSummary:
    succeeded, failed = finished.get("succeeded", 0), finished.get("failed", 0)
    return WorkspaceIngestionSummary(
        workspace_id=workspace_id,
        queued_task_count=queue.get("queued", 0),
        running_task_count=queue.get("running", 0),
        throughput_per_hour=succeeded / hours,
        failure_rate=failed / (failed + succeeded) if failed + succeeded else 0.0,
        error_classes=tuple(sorted(classes.items(), key=lambda entry: (-entry[1], entry[0]))),
    )


__all__ = [
    "MAX_SELECTED_ITEMS",
    "PAUSED_MESSAGE",
    "IngestionRunRecord",
    "IngestionRuns",
    "RunCounts",
    "RunSelector",
    "WorkspaceIngestionSummary",
]
