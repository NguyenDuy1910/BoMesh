"""Shared contracts and configuration for Temporal orchestration.

Two workflows run on the ingestion task queue. ``IngestionRunWorkflow``
processes one Ingestion Run's snapshot of Documents in bounded batches;
``SourceSyncWorkflow`` syncs one Source's inventory and, when scheduled, then
creates a run for what the sync left pending. Postgres holds every run, item
and sync state; Temporal only orchestrates. This module stays free of
database-backed imports so the workflow sandbox can pass it through.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

INGESTION_TASK_QUEUE = "bomesh-ingestion"
INGESTION_RUN_WORKFLOW_NAME = "bomesh.ingestion_run"
SOURCE_SYNC_WORKFLOW_NAME = "bomesh.source_sync"
START_RUN_ACTIVITY = "bomesh.ingestion_run.start"
PLAN_BATCHES_ACTIVITY = "bomesh.ingestion_run.plan_batches"
PROCESS_BATCH_ACTIVITY = "bomesh.ingestion_run.process_batch"
FAIL_BATCH_ACTIVITY = "bomesh.ingestion_run.fail_batch"
FINISH_RUN_ACTIVITY = "bomesh.ingestion_run.finish"
SYNC_SOURCE_ACTIVITY = "bomesh.source_sync.sync"
CREATE_SCHEDULED_RUN_ACTIVITY = "bomesh.source_sync.create_scheduled_run"
#: The failure type a ``process_batch`` raises when the model provider refused
#: the key, credit or model: the run stops instead of retrying.
PROVIDER_REJECTED_FAILURE_TYPE = "ModelProviderRejected"
TEMPORAL_DEFAULT_NAMESPACE = "default"
TEMPORAL_DEFAULT_TARGET = "127.0.0.1:7233"


@dataclass(frozen=True, slots=True)
class TemporalSettings:
    target: str = TEMPORAL_DEFAULT_TARGET
    namespace: str = TEMPORAL_DEFAULT_NAMESPACE
    task_queue: str = INGESTION_TASK_QUEUE
    api_key: str | None = None
    tls: bool = False

    @classmethod
    def from_environment(cls) -> TemporalSettings:
        """Parse Temporal process configuration once at a composition boundary."""

        return cls(
            target=(
                os.getenv("BOMESH_TEMPORAL_TARGET") or TEMPORAL_DEFAULT_TARGET
            ).strip(),
            namespace=(
                os.getenv("BOMESH_TEMPORAL_NAMESPACE") or TEMPORAL_DEFAULT_NAMESPACE
            ).strip(),
            task_queue=(
                os.getenv("BOMESH_TEMPORAL_TASK_QUEUE") or INGESTION_TASK_QUEUE
            ).strip(),
            api_key=(os.getenv("BOMESH_TEMPORAL_API_KEY") or "").strip() or None,
            tls=_environment_boolean("BOMESH_TEMPORAL_TLS"),
        )

    def __post_init__(self) -> None:
        if not self.target:
            raise ValueError("Temporal target must not be blank")
        if not self.namespace:
            raise ValueError("Temporal namespace must not be blank")
        if not self.task_queue:
            raise ValueError("Temporal task queue must not be blank")


@dataclass(frozen=True, slots=True)
class IngestionRunInput:
    """One Ingestion Run; ``next_batch_number`` carries across continue-as-new."""

    run_id: str
    tenant_id: str
    next_batch_number: int = 0


@dataclass(frozen=True, slots=True)
class RunStart:
    """Whether a run still has work, and how many batches may run at once."""

    active: bool
    parallelism: int = 1


@dataclass(frozen=True, slots=True)
class PlanBatchesInput:
    run_id: str
    first_batch_number: int
    max_batches: int


@dataclass(frozen=True, slots=True)
class RunBatch:
    number: int
    item_ids: list[str] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class ProcessBatchInput:
    run_id: str
    tenant_id: str
    batch_number: int
    item_ids: list[str] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class FailBatchInput:
    run_id: str
    batch_number: int


@dataclass(frozen=True, slots=True)
class FinishRunInput:
    """``outcome``: completed, failed or cancelled; ``error`` explains a failed run."""

    run_id: str
    outcome: str
    error: str | None = None


@dataclass(frozen=True, slots=True)
class SourceSyncInput:
    """Sync one Source; ``process`` then creates a run for what is pending."""

    source_id: str
    tenant_id: str
    process: bool = False


class WorkflowExecutionNotFoundError(LookupError):
    """Raised when a Temporal workflow or schedule is not present."""


def ingestion_run_workflow_id(run_id: str) -> str:
    return f"ingestion-run:{_required(run_id, 'run_id')}"


def source_sync_workflow_id(source_id: str) -> str:
    return f"source-sync:{_required(source_id, 'source_id')}"


def ingestion_schedule_id(source_id: str) -> str:
    return f"ingestion-schedule:{_required(source_id, 'source_id')}"


def _required(value: str, name: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"{name} must not be blank")
    return normalized


def _environment_boolean(name: str, *, default: bool = False) -> bool:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    try:
        value = json.loads(raw_value)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{name} must be a JSON boolean") from exc
    if not isinstance(value, bool):
        raise RuntimeError(f"{name} must be a JSON boolean")
    return value


__all__ = [
    "CREATE_SCHEDULED_RUN_ACTIVITY",
    "FAIL_BATCH_ACTIVITY",
    "FINISH_RUN_ACTIVITY",
    "INGESTION_RUN_WORKFLOW_NAME",
    "INGESTION_TASK_QUEUE",
    "PLAN_BATCHES_ACTIVITY",
    "PROCESS_BATCH_ACTIVITY",
    "PROVIDER_REJECTED_FAILURE_TYPE",
    "SOURCE_SYNC_WORKFLOW_NAME",
    "START_RUN_ACTIVITY",
    "SYNC_SOURCE_ACTIVITY",
    "FailBatchInput",
    "FinishRunInput",
    "IngestionRunInput",
    "PlanBatchesInput",
    "ProcessBatchInput",
    "RunBatch",
    "RunStart",
    "SourceSyncInput",
    "TemporalSettings",
    "WorkflowExecutionNotFoundError",
    "ingestion_run_workflow_id",
    "ingestion_schedule_id",
    "source_sync_workflow_id",
]
