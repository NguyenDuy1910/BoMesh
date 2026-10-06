"""Temporal worker bootstrap: run and sync workflows, their Activities, shared clients."""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv
from temporalio.worker import Worker
from temporalio.worker.workflow_sandbox import (
    SandboxedWorkflowRunner,
    SandboxRestrictions,
)

from config import AppConfig, get_config

from bomesh.runtime import AppRuntime
from bomesh.services.workflow import TemporalSettings
from bomesh.services.workflow.client import TemporalClientProvider
from bomesh.services.workflow.ingestion_activity import (
    IngestionRunActivities,
    SourceSyncActivities,
)
from bomesh.services.workflow.ingestion_workflow import IngestionRunWorkflow, SourceSyncWorkflow

log = logging.getLogger(__name__)


class TemporalWorker:
    """Register and run Ingestion Runs and Source syncs on clients the runtime owns."""

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
        run_activities = IngestionRunActivities(
            runs=runs,
            ingestion=runtime.ingestion_service(),
            archives=runtime.archive_expansion_service(),
        )
        sync_activities = SourceSyncActivities(sync=runtime.source_sync_service(), runs=runs)
        worker_config = self._config.worker
        worker = Worker(
            client,
            task_queue=self._settings.task_queue,
            # Without an explicit id the SDK hashes the code of every loaded
            # module; that scan trips transformers' lazy alias modules (one
            # warning each) and slows startup. Worker versioning is not used.
            build_id="bomesh-ingestion",
            workflows=[IngestionRunWorkflow, SourceSyncWorkflow],
            activities=[
                run_activities.start_run,
                run_activities.plan_batches,
                run_activities.process_batch,
                run_activities.fail_batch,
                run_activities.finish_run,
                sync_activities.sync_source,
                sync_activities.create_scheduled_run,
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


async def _main() -> None:
    load_dotenv(Path(__file__).resolve().parents[4] / ".env", override=False)
    await TemporalWorker().run()


if __name__ == "__main__":
    asyncio.run(_main())


__all__ = ["TemporalWorker"]
