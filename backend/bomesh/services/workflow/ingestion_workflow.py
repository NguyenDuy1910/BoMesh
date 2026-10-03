"""The one deterministic Temporal workflow for managed ingestion."""

from __future__ import annotations

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

from bomesh.services.workflow import (
    DOCUMENT_INGESTION_ACTIVITY_NAME,
    INGESTION_WORKFLOW_NAME,
    SOURCE_INGESTION_ACTIVITY_NAME,
    IngestionProgress,
    IngestionResult,
    IngestionWorkflowInput,
)


@workflow.defn(name=INGESTION_WORKFLOW_NAME)
class IngestionWorkflow:
    """Run one managed ingestion — a Source sync or one Document — as one Activity.

    Orchestration only: durable retries, heartbeated liveness, cancellation
    that completes once the Activity has recorded it, and a progress query.
    The work itself is the shared ingestion core the Activity calls.
    """

    def __init__(self) -> None:
        self._progress = IngestionProgress()

    @workflow.run
    async def run(self, input: IngestionWorkflowInput) -> IngestionResult:
        self._progress = IngestionProgress(phase="running")
        is_source = input.source_id is not None
        try:
            result = await workflow.execute_activity(
                SOURCE_INGESTION_ACTIVITY_NAME if is_source else DOCUMENT_INGESTION_ACTIVITY_NAME,
                input,
                result_type=IngestionResult,
                start_to_close_timeout=timedelta(hours=8 if is_source else 2),
                # A silent Activity is a lost worker; heartbeats are also how a
                # cancel reaches it.
                heartbeat_timeout=timedelta(minutes=2),
                # A cancel completes only once the Activity has recorded it, so
                # a retry can never overlap the attempt still running.
                cancellation_type=workflow.ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
                retry_policy=RetryPolicy(
                    initial_interval=timedelta(seconds=2),
                    backoff_coefficient=2.0,
                    maximum_interval=timedelta(minutes=2),
                    maximum_attempts=5,
                ),
            )
        except Exception:
            self._progress = IngestionProgress(phase="failed")
            raise
        self._progress = IngestionProgress(
            phase="completed",
            discovered_count=result.discovered_count,
            processed_count=result.processed_count,
            indexed_count=result.indexed_count,
            deleted_count=result.deleted_count,
            failed_count=result.failed_count,
        )
        return result

    @workflow.query
    def progress(self) -> IngestionProgress:
        return self._progress


__all__ = ["IngestionWorkflow"]
