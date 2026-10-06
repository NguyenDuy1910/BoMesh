"""Deterministic Temporal workflows: one Ingestion Run, one Source sync.

Orchestration only. Every state a person sees is written by the Activities
into Postgres; the workflows decide what runs next, how much runs at once, and
what happens when something stops.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError, CancelledError

from bomesh.services.workflow import (
    CREATE_SCHEDULED_RUN_ACTIVITY,
    FAIL_BATCH_ACTIVITY,
    FINISH_RUN_ACTIVITY,
    INGESTION_RUN_WORKFLOW_NAME,
    PLAN_BATCHES_ACTIVITY,
    PROCESS_BATCH_ACTIVITY,
    PROVIDER_REJECTED_FAILURE_TYPE,
    SOURCE_SYNC_WORKFLOW_NAME,
    START_RUN_ACTIVITY,
    SYNC_SOURCE_ACTIVITY,
    FailBatchInput,
    FinishRunInput,
    IngestionRunInput,
    PlanBatchesInput,
    ProcessBatchInput,
    RunBatch,
    RunStart,
    SourceSyncInput,
)

#: Short bookkeeping Activities: database writes only.
_BOOKKEEPING = {
    "start_to_close_timeout": timedelta(minutes=2),
    "retry_policy": RetryPolicy(
        initial_interval=timedelta(seconds=1),
        maximum_interval=timedelta(seconds=30),
        maximum_attempts=10,
    ),
}
#: Batches planned per call, relative to how many may run at once.
_PLAN_AHEAD = 2


@workflow.defn(name=INGESTION_RUN_WORKFLOW_NAME)
class IngestionRunWorkflow:
    """Process one run's Documents in size-packed batches, a bounded number at once.

    A batch that keeps failing after its retries has its unfinished Documents
    failed and the run goes on. A provider refusal (key, credit, model) stops
    planning: batches in flight end, and the run fails with the reason. A
    cancel stops the batches in flight and still records the outcome.
    """

    @workflow.run
    async def run(self, input: IngestionRunInput) -> None:
        in_flight: dict[asyncio.Task[None], int] = {}
        stop_reason: list[str] = []
        try:
            start = await workflow.execute_activity(
                START_RUN_ACTIVITY, input.run_id, result_type=RunStart, **_BOOKKEEPING
            )
            if not start.active:
                await self._finish(input.run_id, "cancelled")
                return
            parallelism = max(1, start.parallelism)
            next_batch = input.next_batch_number
            while not stop_reason:
                if workflow.info().is_continue_as_new_suggested():
                    await self._drain(in_flight)
                    workflow.continue_as_new(
                        IngestionRunInput(
                            run_id=input.run_id,
                            tenant_id=input.tenant_id,
                            next_batch_number=next_batch,
                        )
                    )
                batches = await workflow.execute_activity(
                    PLAN_BATCHES_ACTIVITY,
                    PlanBatchesInput(
                        run_id=input.run_id,
                        first_batch_number=next_batch,
                        max_batches=parallelism * _PLAN_AHEAD,
                    ),
                    result_type=list[RunBatch],
                    **_BOOKKEEPING,
                )
                if not batches:
                    if not in_flight:
                        break
                    # A batch still running may append archive members.
                    await self._wait_one(in_flight)
                    continue
                for batch in batches:
                    while len(in_flight) >= parallelism:
                        await self._wait_one(in_flight)
                    if stop_reason:
                        break
                    task = asyncio.create_task(self._batch(input, batch, stop_reason))
                    in_flight[task] = batch.number
                    next_batch = batch.number + 1
            await self._drain(in_flight)
            if stop_reason:
                await self._finish(input.run_id, "failed", stop_reason[0])
            else:
                await self._finish(input.run_id, "completed")
        except asyncio.CancelledError:
            for task in in_flight:
                task.cancel()
            # Each batch records what it interrupted before its cancel completes.
            await asyncio.gather(*in_flight, return_exceptions=True)
            await self._finish(input.run_id, "cancelled")
            raise

    async def _batch(
        self, input: IngestionRunInput, batch: RunBatch, stop_reason: list[str]
    ) -> None:
        try:
            await workflow.execute_activity(
                PROCESS_BATCH_ACTIVITY,
                ProcessBatchInput(
                    run_id=input.run_id,
                    tenant_id=input.tenant_id,
                    batch_number=batch.number,
                    item_ids=batch.item_ids,
                ),
                start_to_close_timeout=timedelta(hours=2),
                # A silent batch is a lost worker; heartbeats also carry cancels.
                heartbeat_timeout=timedelta(minutes=2),
                # A cancel completes only once the batch has recorded it.
                cancellation_type=workflow.ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
                retry_policy=RetryPolicy(
                    initial_interval=timedelta(seconds=5),
                    backoff_coefficient=2.0,
                    maximum_interval=timedelta(minutes=2),
                    maximum_attempts=5,
                    non_retryable_error_types=[PROVIDER_REJECTED_FAILURE_TYPE],
                ),
            )
        except ActivityError as exc:
            cause = exc.cause
            if isinstance(cause, CancelledError):
                # The run is being cancelled; the batch recorded what it stopped.
                return
            if (
                isinstance(cause, ApplicationError)
                and cause.type == PROVIDER_REJECTED_FAILURE_TYPE
            ):
                if not stop_reason:
                    stop_reason.append(cause.message)
                return
            await workflow.execute_activity(
                FAIL_BATCH_ACTIVITY,
                FailBatchInput(run_id=input.run_id, batch_number=batch.number),
                **_BOOKKEEPING,
            )

    @staticmethod
    async def _wait_one(in_flight: dict[asyncio.Task[None], int]) -> None:
        done, _ = await workflow.wait(list(in_flight), return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            in_flight.pop(task, None)
            task.result()

    @staticmethod
    async def _drain(in_flight: dict[asyncio.Task[None], int]) -> None:
        while in_flight:
            await IngestionRunWorkflow._wait_one(in_flight)

    @staticmethod
    async def _finish(run_id: str, outcome: str, error: str | None = None) -> None:
        await workflow.execute_activity(
            FINISH_RUN_ACTIVITY,
            FinishRunInput(run_id=run_id, outcome=outcome, error=error),
            **_BOOKKEEPING,
        )


@workflow.defn(name=SOURCE_SYNC_WORKFLOW_NAME)
class SourceSyncWorkflow:
    """Sync one Source's inventory; a scheduled sync then processes what is pending."""

    @workflow.run
    async def run(self, input: SourceSyncInput) -> None:
        await workflow.execute_activity(
            SYNC_SOURCE_ACTIVITY,
            input,
            start_to_close_timeout=timedelta(hours=8),
            heartbeat_timeout=timedelta(minutes=2),
            cancellation_type=workflow.ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
            retry_policy=RetryPolicy(
                initial_interval=timedelta(seconds=5),
                backoff_coefficient=2.0,
                maximum_interval=timedelta(minutes=2),
                maximum_attempts=3,
            ),
        )
        if input.process:
            await workflow.execute_activity(
                CREATE_SCHEDULED_RUN_ACTIVITY, input, **_BOOKKEEPING
            )


__all__ = ["IngestionRunWorkflow", "SourceSyncWorkflow"]
