"""The one Temporal client boundary: start, cancel and inspect executions.

Temporal only orchestrates. What a run or a sync did is read from Postgres;
this service answers whether an execution is still open, and nothing more.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any
from uuid import UUID

from temporalio.client import (
    Schedule,
    ScheduleActionStartWorkflow,
    ScheduleAlreadyRunningError,
    ScheduleDescription,
    ScheduleIntervalSpec,
    ScheduleOverlapPolicy,
    SchedulePolicy,
    ScheduleSpec,
    ScheduleState,
    ScheduleUpdate,
    WorkflowExecutionStatus,
)
from temporalio.common import WorkflowIDConflictPolicy, WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.service import RPCError, RPCStatusCode

from bomesh.services.workflow import (
    INGESTION_RUN_WORKFLOW_NAME,
    SOURCE_SYNC_WORKFLOW_NAME,
    IngestionRunInput,
    SourceSyncInput,
    TemporalSettings,
    WorkflowExecutionNotFoundError,
    ingestion_run_workflow_id,
    ingestion_schedule_id,
    source_sync_workflow_id,
)
from bomesh.services.workflow.client import TemporalClientProvider

_OVERLAP_POLICIES = {
    "skip": ScheduleOverlapPolicy.SKIP,
    "queue": ScheduleOverlapPolicy.BUFFER_ONE,
    "replace": ScheduleOverlapPolicy.CANCEL_OTHER,
}


class TemporalWorkflowService:
    """Start and observe Ingestion Run and Source sync executions."""

    def __init__(
        self,
        client_provider: TemporalClientProvider | None = None,
        settings: TemporalSettings | None = None,
    ) -> None:
        self._provider = client_provider or TemporalClientProvider(settings)
        self._settings = self._provider.settings

    # -- Ingestion Runs ------------------------------------------------------

    async def start_run(self, run_id: UUID | str, tenant_id: UUID | str) -> None:
        """Start the run's one workflow; an execution already started is kept."""

        client = await self._provider.get()
        try:
            await client.start_workflow(
                INGESTION_RUN_WORKFLOW_NAME,
                IngestionRunInput(run_id=str(run_id), tenant_id=str(tenant_id)),
                id=ingestion_run_workflow_id(str(run_id)),
                task_queue=self._settings.task_queue,
                id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
                id_conflict_policy=WorkflowIDConflictPolicy.FAIL,
                static_summary=f"Ingestion run {run_id}",
            )
        except WorkflowAlreadyStartedError:
            return

    async def cancel_run(self, run_id: UUID | str) -> bool:
        """Request cancellation; ``False`` when no open execution is there to cancel."""

        workflow_id = ingestion_run_workflow_id(str(run_id))
        if not await self._is_open(workflow_id):
            return False
        handle = (await self._provider.get()).get_workflow_handle(workflow_id)
        try:
            await handle.cancel()
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                return False
            raise
        return True

    async def run_is_open(self, run_id: UUID | str) -> bool:
        return await self._is_open(ingestion_run_workflow_id(str(run_id)))

    # -- Source syncs --------------------------------------------------------

    async def start_source_sync(
        self, source_id: UUID | str, tenant_id: UUID | str, *, process: bool
    ) -> bool:
        """Start one sync of a Source; ``False`` when one is already running."""

        if await self._schedule_is_running(str(source_id)):
            return False
        client = await self._provider.get()
        try:
            await client.start_workflow(
                SOURCE_SYNC_WORKFLOW_NAME,
                SourceSyncInput(
                    source_id=str(source_id), tenant_id=str(tenant_id), process=process
                ),
                id=source_sync_workflow_id(str(source_id)),
                task_queue=self._settings.task_queue,
                id_reuse_policy=WorkflowIDReusePolicy.ALLOW_DUPLICATE,
                id_conflict_policy=WorkflowIDConflictPolicy.FAIL,
                static_summary=f"Sync source {source_id}",
            )
        except WorkflowAlreadyStartedError:
            return False
        return True

    async def source_sync_is_open(self, source_id: UUID | str) -> bool:
        """Whether a sync of the Source runs now, started by hand or by its schedule."""

        return await self._is_open(
            source_sync_workflow_id(str(source_id))
        ) or await self._schedule_is_running(str(source_id))

    # -- Schedules -----------------------------------------------------------

    async def upsert_schedule(
        self, source_id: UUID | str, tenant_id: UUID | str, values: dict[str, Any]
    ) -> dict[str, Any]:
        """Create or replace a Source's schedule: each firing syncs, then processes."""

        schedule = self._schedule(str(source_id), str(tenant_id), values)
        schedule_id = ingestion_schedule_id(str(source_id))
        client = await self._provider.get()
        try:
            handle = await client.create_schedule(schedule_id, schedule)
        except ScheduleAlreadyRunningError:
            handle = client.get_schedule_handle(schedule_id)

            async def update(_: Any) -> ScheduleUpdate:
                return ScheduleUpdate(schedule=schedule)

            await handle.update(update)
        return _schedule_payload(await handle.describe())

    async def describe_schedule(self, source_id: UUID | str) -> dict[str, Any] | None:
        client = await self._provider.get()
        handle = client.get_schedule_handle(ingestion_schedule_id(str(source_id)))
        try:
            return _schedule_payload(await handle.describe())
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                return None
            raise

    async def pause_schedule(self, source_id: UUID | str) -> dict[str, Any]:
        handle = (await self._provider.get()).get_schedule_handle(
            ingestion_schedule_id(str(source_id))
        )
        try:
            await handle.pause(note="Paused by BoMesh administrator")
            return _schedule_payload(await handle.describe())
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                raise WorkflowExecutionNotFoundError(str(source_id)) from exc
            raise

    async def resume_schedule(self, source_id: UUID | str) -> dict[str, Any]:
        handle = (await self._provider.get()).get_schedule_handle(
            ingestion_schedule_id(str(source_id))
        )
        try:
            await handle.unpause(note="Resumed by BoMesh administrator")
            return _schedule_payload(await handle.describe())
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                raise WorkflowExecutionNotFoundError(str(source_id)) from exc
            raise

    async def delete_schedule(self, source_id: UUID | str) -> None:
        handle = (await self._provider.get()).get_schedule_handle(
            ingestion_schedule_id(str(source_id))
        )
        try:
            await handle.delete()
        except RPCError as exc:
            if exc.status != RPCStatusCode.NOT_FOUND:
                raise

    # -- Internals -----------------------------------------------------------

    async def _is_open(self, workflow_id: str) -> bool:
        """``False`` only when Temporal says the execution is closed or absent.

        Any other failure raises: an unreachable server is not evidence that
        an execution ended.
        """

        handle = (await self._provider.get()).get_workflow_handle(workflow_id)
        try:
            description = await handle.describe()
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                return False
            raise
        return description.status == WorkflowExecutionStatus.RUNNING

    async def _schedule_is_running(self, source_id: str) -> bool:
        """Whether the Source's schedule has a sync of its own in flight.

        A scheduled execution's id carries the firing time, so it is found
        through the schedule rather than by the sync's workflow id.
        """

        handle = (await self._provider.get()).get_schedule_handle(
            ingestion_schedule_id(source_id)
        )
        try:
            description = await handle.describe()
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                return False
            raise
        return bool(description.info.running_actions)

    def _schedule(self, source_id: str, tenant_id: str, values: dict[str, Any]) -> Schedule:
        schedule_type = str(values.get("schedule_type") or "cron").strip().casefold()
        expression = str(values.get("cron_expression") or "").strip()
        if not expression:
            raise ValueError("schedule expression is required")
        if schedule_type == "cron":
            spec = ScheduleSpec(
                cron_expressions=[expression],
                time_zone_name=(str(values.get("timezone") or "UTC").strip()),
            )
        elif schedule_type == "interval":
            try:
                seconds = int(expression)
            except ValueError as exc:
                raise ValueError("interval schedule expression must be seconds") from exc
            if seconds < 1:
                raise ValueError("interval schedule must be positive")
            spec = ScheduleSpec(
                intervals=[ScheduleIntervalSpec(every=timedelta(seconds=seconds))]
            )
        else:
            raise ValueError("schedule_type must be cron or interval")
        overlap = str(values.get("overlap_policy") or "skip").strip().casefold()
        if overlap not in _OVERLAP_POLICIES:
            raise ValueError("unsupported overlap policy")
        enabled = values.get("enabled", True)
        if not isinstance(enabled, bool):
            raise ValueError("schedule enabled must be a boolean")
        return Schedule(
            action=ScheduleActionStartWorkflow(
                SOURCE_SYNC_WORKFLOW_NAME,
                SourceSyncInput(source_id=source_id, tenant_id=tenant_id, process=True),
                id=source_sync_workflow_id(source_id),
                task_queue=self._settings.task_queue,
                static_summary=f"Scheduled sync of source {source_id}",
            ),
            spec=spec,
            policy=SchedulePolicy(
                overlap=_OVERLAP_POLICIES[overlap],
                catchup_window=timedelta(minutes=5),
                pause_on_failure=False,
            ),
            state=ScheduleState(paused=not enabled),
        )


def _schedule_payload(description: ScheduleDescription) -> dict[str, Any]:
    schedule = description.schedule
    spec = schedule.spec
    if spec.intervals:
        schedule_type = "interval"
        expression = str(round(spec.intervals[0].every.total_seconds()))
    else:
        schedule_type = "cron"
        expression = spec.cron_expressions[0] if spec.cron_expressions else ""
    overlap = {
        ScheduleOverlapPolicy.SKIP: "skip",
        ScheduleOverlapPolicy.BUFFER_ONE: "queue",
        ScheduleOverlapPolicy.CANCEL_OTHER: "replace",
    }.get(schedule.policy.overlap, schedule.policy.overlap.name.casefold())
    return {
        "id": description.id,
        "schedule_type": schedule_type,
        "cron_expression": expression,
        "timezone": spec.time_zone_name,
        "enabled": not schedule.state.paused,
        "paused": schedule.state.paused,
        "overlap_policy": overlap,
        "next_run_at": (
            description.info.next_action_times[0].isoformat()
            if description.info.next_action_times
            else None
        ),
        "last_run_at": (
            description.info.recent_actions[-1].scheduled_at.isoformat()
            if description.info.recent_actions
            else None
        ),
        "num_actions": description.info.num_actions,
        "num_actions_skipped_overlap": description.info.num_actions_skipped_overlap,
    }


__all__ = ["TemporalWorkflowService"]
