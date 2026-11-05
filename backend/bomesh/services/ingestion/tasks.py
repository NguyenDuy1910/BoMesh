"""IngestionTask: Get and List (``api_design.md`` §6); one task per Document of a run, task ID = item ID.

Members see a task only if they can see its item (the Item visibility rule,
``item_model.md`` §6.3, re-checked in PostgreSQL); a task of an invisible
item is omitted from lists and answers Get like a missing one. Platform
callers (not ACTIVE members) and ``workspaces/-`` reads see every task as
metadata: never the item, its revision, file names or content; their task
errors carry only the status code and a fixed message.

Members need ``tasks.list``/``tasks.get``, which collection roles grant: a task
is readable when its item is visible and its governing collection is one
where the caller holds the method permission.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import Select, select

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import IngestionRun, IngestionRunItem, Item
from bomesh.errors import NotFound
from bomesh.iam.authorizer import PlatformRef, WorkspaceRef, permission_denied
from bomesh.iam.visibility import ItemVisibility
from bomesh.services.ingestion.common import (
    WILDCARD,
    is_platform_caller,
    run_name,
    task_name,
)
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.workspaces import WorkspaceResolver, require_usable
from bomesh.services.knowledge_items.item_store import catalog_visibility

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

#: The processing pipeline's own phases → the contract's task phases.
PHASES = {
    "downloading": "FETCHING",
    "expanding": "PARSING",
    "parsing": "PARSING",
    "contextualizing": "CHUNKING",
    "embedding": "EMBEDDING",
    "storing": "INDEXING",
}
#: The state of a task's last phase, by the task's state.
_LAST_PHASE_STATES = {
    "queued": "PENDING",
    "running": "RUNNING",
    "succeeded": "SUCCEEDED",
    "failed": "FAILED",
    "cancelled": "SKIPPED",
}
#: The message of a task error read as metadata: the real one may name files.
METADATA_ONLY_ERROR = "The document could not be processed."


@dataclass(frozen=True, slots=True)
class TaskPhase:
    #: ``IngestionTask.phase`` value (FETCHING, PARSING, ...).
    phase: str
    #: PENDING, RUNNING, SUCCEEDED, FAILED or SKIPPED.
    state: str
    start_time: datetime | None
    end_time: datetime | None


@dataclass(frozen=True, slots=True)
class IngestionTaskRecord:
    """One task as the caller may read it; ``metadata_only`` hides the item and its revision."""

    workspace_id: UUID
    run_id: UUID
    item_id: UUID
    #: ``ingestion_run_items.status`` (queued, running, succeeded, failed, cancelled).
    state: str
    #: The current ``IngestionTask.phase``; ``None`` for a finished task that never started one.
    phase: str | None
    phases: tuple[TaskPhase, ...]
    error: Mapping[str, Any] | None
    error_class: str | None
    revision_number: int | None
    metadata_only: bool
    create_time: datetime
    start_time: datetime | None
    end_time: datetime | None


class IngestionTasks:
    """Read a run's tasks under the Item visibility rule."""

    def __init__(self, sessions: SessionFactory) -> None:
        self._sessions = sessions
        self._workspaces = WorkspaceResolver(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> IngestionTasks:
        return cls(runtime.sessions())

    async def list(
        self,
        ctx: RequestContext,
        workspace_id: UUID | None,
        run_id: UUID | None,
        query: ListQuery,
    ) -> list[IngestionTaskRecord]:
        """ListIngestionTasks; ``None`` for the workspace or run is the ``-`` wildcard."""
        visibility = await self._open(ctx, workspace_id, "tasks.list")
        async with transaction_scope(self._sessions) as session:
            if run_id is not None:
                await _require_run(session, workspace_id, run_id)
            statement = _tasks(workspace_id, visibility)
            if run_id is not None:
                statement = statement.where(IngestionRunItem.run_id == run_id)
            rows = (await session.execute(query.apply(statement))).all()
        return [_record(task, workspace, visibility is None) for task, workspace in rows]

    async def get(
        self, ctx: RequestContext, workspace_id: UUID, run_id: UUID, task_id: UUID
    ) -> IngestionTaskRecord:
        """GetIngestionTask; a task whose item the caller cannot see is NOT_FOUND."""
        visibility = await self._open(ctx, workspace_id, "tasks.get")
        async with transaction_scope(self._sessions) as session:
            row = (
                await session.execute(
                    _tasks(workspace_id, visibility).where(
                        IngestionRunItem.run_id == run_id, IngestionRunItem.item_id == task_id
                    )
                )
            ).first()
        if row is None:
            raise NotFound(
                f"Resource '{task_name(workspace_id, run_id, task_id)}' was not found."
            )
        task, workspace = row
        return _record(task, workspace, visibility is None)

    async def _open(
        self, ctx: RequestContext, workspace_id: UUID | None, permission: str
    ) -> ItemVisibility | None:
        """Gate the read; the caller's Item visibility, or ``None`` for a metadata-only read.

        ``workspaces/-`` needs ``permission`` at platform scope; a platform
        caller needs it on the workspace (from their platform role); a member
        needs ``permission`` on at least one collection (or the workspace) and
        sees tasks of visible items governed by those collections.
        """
        if workspace_id is None:
            await ctx.authorizer.require(ctx.principal, permission, PlatformRef())
            return None
        if await is_platform_caller(ctx, workspace_id):
            await self._workspaces.open(ctx, WorkspaceRef(workspace_id), permission, write=False)
            return None
        require_usable(await self._workspaces.get(workspace_id), write=False)
        allowed = await ctx.authorizer.allowed_collections(ctx.principal, workspace_id, permission)
        if not allowed:
            raise permission_denied(permission, WorkspaceRef(workspace_id))
        async with transaction_scope(self._sessions) as session:
            visibility = await catalog_visibility(
                session, ctx.authorizer, ctx.principal, workspace_id
            )
        return replace(
            visibility,
            readable=visibility.readable & allowed,
            editable=visibility.editable & allowed,
        )


def _tasks(workspace_id: UUID | None, visibility: ItemVisibility | None) -> Select[Any]:
    statement = select(IngestionRunItem, IngestionRun.tenant_id).join(
        IngestionRun, IngestionRun.id == IngestionRunItem.run_id
    )
    if workspace_id is not None:
        statement = statement.where(IngestionRun.tenant_id == workspace_id)
    if visibility is not None:
        statement = statement.join(Item, Item.id == IngestionRunItem.item_id).where(
            visibility.clause(Item)
        )
    return statement


async def _require_run(session: Any, workspace_id: UUID | None, run_id: UUID) -> None:
    statement = select(IngestionRun.id).where(IngestionRun.id == run_id)
    if workspace_id is not None:
        statement = statement.where(IngestionRun.tenant_id == workspace_id)
    if await session.scalar(statement) is None:
        name = (
            run_name(workspace_id, run_id)
            if workspace_id is not None
            else f"workspaces/{WILDCARD}/ingestionRuns/{run_id}"
        )
        raise NotFound(f"Resource '{name}' was not found.")


def _record(
    task: IngestionRunItem, workspace_id: UUID, metadata_only: bool
) -> IngestionTaskRecord:
    phases = task_phases(task.status, task.phases or ())
    if phases:
        phase: str | None = phases[-1].phase
    else:
        phase = "QUEUED" if task.status in ("queued", "running") else None
    return IngestionTaskRecord(
        workspace_id=workspace_id,
        run_id=task.run_id,
        item_id=task.item_id,
        state=task.status,
        phase=phase,
        phases=phases,
        error=_error(task.error) if metadata_only else task.error,
        error_class=task.error_class,
        revision_number=None if metadata_only else task.revision_number,
        metadata_only=metadata_only,
        create_time=task.created_at,
        start_time=task.started_at,
        end_time=task.finished_at,
    )


def _error(error: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """A task error as metadata: its status code and a fixed message."""
    if error is None:
        return None
    return {"code": error.get("code"), "message": METADATA_ONLY_ERROR}


def task_phases(status: str, recorded: Sequence[Any]) -> tuple[TaskPhase, ...]:
    """The contract's phases of what the pipeline recorded, consecutive repeats merged.

    Every phase but the last handed over to the next one, so it SUCCEEDED; the
    last one follows the task (RUNNING, SUCCEEDED, FAILED, or SKIPPED when the
    task was cancelled).
    """
    entries = [
        entry for entry in recorded if isinstance(entry, Mapping) and entry.get("phase") in PHASES
    ]
    phases: list[TaskPhase] = []
    for index, entry in enumerate(entries):
        name = PHASES[entry["phase"]]
        state = _LAST_PHASE_STATES[status] if index == len(entries) - 1 else "SUCCEEDED"
        end = _time(entry.get("finished_at"))
        if phases and phases[-1].phase == name:
            phases[-1] = TaskPhase(name, state, phases[-1].start_time, end)
        else:
            phases.append(TaskPhase(name, state, _time(entry.get("started_at")), end))
    return tuple(phases)


def _time(value: Any) -> datetime | None:
    return datetime.fromisoformat(value) if isinstance(value, str) and value else None


__all__ = ["METADATA_ONLY_ERROR", "PHASES", "IngestionTaskRecord", "IngestionTasks", "TaskPhase", "task_phases"]
