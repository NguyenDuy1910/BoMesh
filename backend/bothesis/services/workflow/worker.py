"""Temporal worker bootstrap: one workflow, its two Activities, shared clients."""

from __future__ import annotations

import asyncio
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv
from temporalio.worker import Worker
from temporalio.worker.workflow_sandbox import (
    SandboxedWorkflowRunner,
    SandboxRestrictions,
)

from config import AppConfig, get_config

from bothesis.runtime import AppRuntime
from bothesis.services.archive_expansion import ArchiveExpansionService
from bothesis.services.workflow import TemporalSettings
from bothesis.services.workflow.client import TemporalClientProvider
from bothesis.services.workflow.ingestion_activity import IngestionActivities
from bothesis.services.workflow.ingestion_workflow import IngestionWorkflow


class TemporalWorker:
    """Register and run managed ingestion on clients the runtime owns.

    The index, contextualizer, storage and parser are the ones the API uses
    for direct uploads, so both runners produce the same representation.
    """

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
        await self._runtime.workflow_service().ensure_search_attributes()
        worker_config = self._config.worker
        activities = self._activities()
        worker = Worker(
            client,
            task_queue=self._settings.task_queue,
            # Without an explicit id the SDK hashes the code of every loaded
            # module; that scan trips transformers' lazy alias modules (one
            # warning each) and slows startup. Worker versioning is not used.
            build_id="bothesis-ingestion",
            workflows=[IngestionWorkflow],
            activities=[activities.ingest_source, activities.ingest_document],
            # Importing a submodule of ``bothesis.services`` executes that
            # package's database-backed public boundary. Pass through only the
            # already-loaded workflow module and its lightweight contracts;
            # the Workflow code itself remains sandboxed and deterministic.
            workflow_runner=SandboxedWorkflowRunner(
                restrictions=SandboxRestrictions.default.with_passthrough_modules(
                    "bothesis.services",
                    "bothesis.services.workflow",
                    "bothesis.services.workflow.ingestion_workflow",
                )
            ),
            max_concurrent_activities=worker_config.max_concurrent_activities,
            max_task_queue_activities_per_second=worker_config.activity_rate_limit,
            # Heartbeats carry the live pipeline phase the monitor draws, so
            # they are sent within ~2s instead of the SDK's 30s default.
            default_heartbeat_throttle_interval=timedelta(seconds=1),
            max_heartbeat_throttle_interval=timedelta(seconds=2),
            graceful_shutdown_timeout=timedelta(seconds=worker_config.graceful_shutdown_seconds),
        )
        try:
            await worker.run()
        finally:
            await self._runtime.aclose()

    def _activities(self) -> IngestionActivities:
        runtime = self._runtime
        return IngestionActivities(
            runtime.sessions(),
            index=runtime.item_index(),
            raw_storage=runtime.object_storage(),
            stored_content=runtime.stored_file_content(),
            archives=ArchiveExpansionService(
                runtime.sessions(), object_storage=runtime.object_storage()
            ),
            workflows=runtime.workflow_service(),
            providers=runtime.connection_providers(),
            credential_encryption_key=self._config.integration.credential_encryption_key,
            preview=runtime.knowledge_preview(),
        )


async def _main() -> None:
    load_dotenv(Path(__file__).resolve().parents[4] / ".env", override=False)
    await TemporalWorker().run()


if __name__ == "__main__":
    asyncio.run(_main())


__all__ = ["TemporalWorker"]
