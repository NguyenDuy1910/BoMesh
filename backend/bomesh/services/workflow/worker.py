"""Temporal worker bootstrap: run, sync and maintenance workflows, their Activities, shared clients."""

from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv
from temporalio.client import (
    Client,
    Schedule,
    ScheduleActionStartWorkflow,
    ScheduleAlreadyRunningError,
    ScheduleIntervalSpec,
    ScheduleOverlapPolicy,
    SchedulePolicy,
    ScheduleSpec,
)
from temporalio.worker import Worker
from temporalio.worker.workflow_sandbox import (
    SandboxedWorkflowRunner,
    SandboxRestrictions,
)

from bomesh.runtime import AppRuntime
from bomesh.services.workflow import (
    DELETED_ITEM_PURGE_SCHEDULE_ID,
    MAINTENANCE_WORKFLOW_NAME,
    PAYLOAD_RECONCILIATION_SCHEDULE_ID,
    PURGE_DELETED_ITEMS_ACTIVITY,
    RECONCILE_PAYLOADS_ACTIVITY,
    TemporalSettings,
)
from bomesh.services.workflow.client import TemporalClientProvider
from bomesh.services.workflow.ingestion_activity import (
    IngestionRunActivities,
    MaintenanceActivities,
    SourceSyncActivities,
)
from bomesh.services.workflow.ingestion_workflow import (
    IngestionRunWorkflow,
    MaintenanceWorkflow,
    SourceSyncWorkflow,
)
from config import AppConfig, get_config

log = logging.getLogger(__name__)

#: ``(Schedule ID, Activity, interval)`` of the periodic index upkeep.
_MAINTENANCE_SCHEDULES = (
    (PAYLOAD_RECONCILIATION_SCHEDULE_ID, RECONCILE_PAYLOADS_ACTIVITY, timedelta(minutes=1)),
    (DELETED_ITEM_PURGE_SCHEDULE_ID, PURGE_DELETED_ITEMS_ACTIVITY, timedelta(hours=1)),
)


class TemporalWorker:
    """Register and run the ingestion workflows on clients the runtime owns."""

    def __init__(
        self,
        settings: TemporalSettings | None = None,
        config: AppConfig | None = None,
    ) -> None:
        self._settings = settings or TemporalSettings.from_environment()
        self._config = config or get_config()
        self._runtime = AppRuntime(self._config)

    async def run(self) -> None:
        client = await TemporalClientProvider(self._settings).get()
        runtime = self._runtime
        runs = runtime.ingestion_run_service()
        try:
            await runs.reconcile()
        except Exception:  # noqa: BLE001 - startup repairs are best effort
            log.warning("ingestion reconciliation failed at worker startup", exc_info=True)
        await _ensure_maintenance_schedules(client, self._settings.task_queue)
        run_activities = IngestionRunActivities(
            runs=runs,
            ingestion=runtime.ingestion_service(),
            archives=runtime.archive_expansion_service(),
        )
        sync_activities = SourceSyncActivities(sync=runtime.source_sync_service(), runs=runs)
        maintenance = MaintenanceActivities(
            runtime.sessions(), index=runtime.item_index(), storage=runtime.object_storage()
        )
        worker_config = self._config.worker
        worker = Worker(
            client,
            task_queue=self._settings.task_queue,
            # Without an explicit id the SDK hashes the code of every loaded
            # module; that scan trips transformers' lazy alias modules (one
            # warning each) and slows startup. Worker versioning is not used.
            build_id="bomesh-ingestion",
            workflows=[IngestionRunWorkflow, SourceSyncWorkflow, MaintenanceWorkflow],
            activities=[
                run_activities.start_run,
                run_activities.plan_batches,
                run_activities.process_batch,
                run_activities.fail_batch,
                run_activities.finish_run,
                sync_activities.begin_scheduled_sync,
                sync_activities.sync_source,
                sync_activities.create_scheduled_run,
                maintenance.reconcile_payloads,
                maintenance.purge_deleted_items,
            ],
            # Importing a submodule of ``bomesh.services`` executes that
            # package's database-backed public boundary. Pass through only the
            # already-loaded workflow module and its lightweight contracts;
            # the Workflow code itself remains sandboxed and deterministic.
            workflow_runner=SandboxedWorkflowRunner(
                restrictions=SandboxRestrictions.default.with_passthrough_modules(
                    "bomesh.services",
                    "bomesh.services.workflow",
                    "bomesh.services.workflow.ingestion_workflow",
                )
            ),
            max_concurrent_activities=worker_config.max_concurrent_activities,
            max_task_queue_activities_per_second=worker_config.activity_rate_limit,
            # Heartbeats are how a cancel reaches a batch; keep them prompt.
            default_heartbeat_throttle_interval=timedelta(seconds=1),
            max_heartbeat_throttle_interval=timedelta(seconds=2),
            graceful_shutdown_timeout=timedelta(seconds=worker_config.graceful_shutdown_seconds),
        )
        try:
            await worker.run()
        finally:
            await runtime.aclose()


async def _ensure_maintenance_schedules(client: Client, task_queue: str) -> None:
    """Create each maintenance Schedule once; an existing one is kept as it is."""

    for schedule_id, activity_name, every in _MAINTENANCE_SCHEDULES:
        schedule = Schedule(
            action=ScheduleActionStartWorkflow(
                MAINTENANCE_WORKFLOW_NAME,
                activity_name,
                id=schedule_id,
                task_queue=task_queue,
            ),
            spec=ScheduleSpec(intervals=[ScheduleIntervalSpec(every=every)]),
            policy=SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP),
        )
        with suppress(ScheduleAlreadyRunningError):
            await client.create_schedule(schedule_id, schedule)


async def _main() -> None:
    load_dotenv(Path(__file__).resolve().parents[4] / ".env", override=False)
    await TemporalWorker().run()


if __name__ == "__main__":
    asyncio.run(_main())


__all__ = ["TemporalWorker"]
