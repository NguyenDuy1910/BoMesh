"""Ingestion runs and tasks messages: IngestionRun, IngestionTask, the run summary, filters."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import ColumnElement, func

from api.aip import filtering
from api.aip.filtering import FilterSchema, Operator
from api.aip.messages import ProtoMessage, Timestamp
from api.aip.ordering import OrderSchema
from bomesh.db.models import IngestionRun, IngestionRunItem
from bomesh.services.ingestion.common import parse_child_name, run_name, task_name
from bomesh.services.ingestion.names import source_name
from bomesh.services.ingestion.runs import (
    IngestionRunRecord,
    RunSelector,
    WorkspaceIngestionSummary,
)
from bomesh.services.ingestion.tasks import IngestionTaskRecord, TaskPhase
from bomesh.services.kernel.workspaces import workspace_name
from bomesh.services.knowledge_items.names import item_name, parse_item, revision_name

IndexingState = Literal["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "OUTDATED", "UNSUPPORTED"]
RunTrigger = Literal["MANUAL", "API", "SCHEDULE", "PLATFORM_RETRY"]
RunState = Literal["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]
TaskPhaseName = Literal[
    "QUEUED", "FETCHING", "PARSING", "OCR", "CHUNKING", "EMBEDDING", "INDEXING", "PUBLISHING"
]
PhaseState = Literal["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "SKIPPED"]

_RUN_STATES = ("QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED")
_TRIGGERS = ("MANUAL", "API", "SCHEDULE", "PLATFORM_RETRY")


class IngestionRunSelectorMessage(ProtoMessage):
    items: list[str] | None = None
    ancestor: str | None = None
    source: str | None = None
    states: list[IndexingState] | None = None


class IngestionRunCountsMessage(ProtoMessage):
    total_count: int | None = None
    queued_count: int | None = None
    running_count: int | None = None
    succeeded_count: int | None = None
    failed_count: int | None = None
    cancelled_count: int | None = None


class IngestionRunMessage(ProtoMessage):
    """``IngestionRun``; on create only ``selector`` and ``trigger`` are read."""

    name: str | None = None
    selector: IngestionRunSelectorMessage | None = None
    trigger: RunTrigger | None = None
    state: RunState | None = None
    counts: IngestionRunCountsMessage | None = None
    error: dict[str, Any] | None = None
    retry_of: str | None = None
    create_time: Timestamp | None = None
    start_time: Timestamp | None = None
    end_time: Timestamp | None = None


class ListIngestionRunsResponse(ProtoMessage):
    ingestion_runs: list[IngestionRunMessage]
    next_page_token: str | None = None


class CancelIngestionRunRequest(ProtoMessage):
    """Empty body; the run is named by the path."""


class RetryIngestionRunRequest(ProtoMessage):
    """Empty body; the run is named by the path."""


class IngestionTaskPhaseMessage(ProtoMessage):
    phase: TaskPhaseName
    state: PhaseState
    start_time: Timestamp | None = None
    end_time: Timestamp | None = None


class IngestionTaskMessage(ProtoMessage):
    name: str
    item: str | None = None
    revision: str | None = None
    state: RunState
    phase: TaskPhaseName | None = None
    phases: list[IngestionTaskPhaseMessage]
    error: dict[str, Any] | None = None
    error_class: str | None = None
    create_time: Timestamp
    start_time: Timestamp | None = None
    end_time: Timestamp | None = None


class ListIngestionTasksResponse(ProtoMessage):
    tasks: list[IngestionTaskMessage]
    next_page_token: str | None = None


class IngestionErrorClassCountMessage(ProtoMessage):
    error_class: str
    task_count: int


class IngestionWorkspaceSummaryMessage(ProtoMessage):
    workspace: str
    queued_task_count: int
    running_task_count: int
    throughput_per_hour: float
    failure_rate: float
    error_classes: list[IngestionErrorClassCountMessage]


class SummarizeIngestionRunsResponse(ProtoMessage):
    workspace_summaries: list[IngestionWorkspaceSummaryMessage]


def run_selector(
    message: IngestionRunSelectorMessage | None, *, workspace_id: UUID
) -> RunSelector | None:
    """The selector with its references parsed; malformed names are INVALID_ARGUMENT."""
    if message is None:
        return None
    return RunSelector(
        items=tuple(
            parse_item(item, workspace_id, field="selector.items")
            for item in message.items or ()
        ),
        ancestor=(
            parse_item(message.ancestor, workspace_id, field="selector.ancestor")
            if message.ancestor
            else None
        ),
        source=(
            parse_child_name(
                message.source,
                workspace_id=workspace_id,
                collection="sources",
                field="selector.source",
            )
            if message.source
            else None
        ),
        states=tuple(message.states or ()),
    )


def ingestion_run_message(record: IngestionRunRecord) -> IngestionRunMessage:
    counts = record.counts
    return IngestionRunMessage(
        name=run_name(record.workspace_id, record.run_id),
        selector=(
            _selector_message(record.selector, workspace_id=record.workspace_id)
            if record.selector is not None
            else None
        ),
        trigger=record.trigger.upper(),  # type: ignore[arg-type]
        state=record.state.upper(),  # type: ignore[arg-type]
        counts=IngestionRunCountsMessage(
            total_count=counts.total,
            queued_count=counts.queued,
            running_count=counts.running,
            succeeded_count=counts.succeeded,
            failed_count=counts.failed,
            cancelled_count=counts.cancelled,
        ),
        error=dict(record.error) if record.error is not None else None,
        retry_of=(
            run_name(record.workspace_id, record.retry_of) if record.retry_of is not None else None
        ),
        create_time=record.create_time,
        start_time=record.start_time,
        end_time=record.end_time,
    )


def ingestion_task_message(record: IngestionTaskRecord) -> IngestionTaskMessage:
    workspace_id = record.workspace_id
    return IngestionTaskMessage(
        name=task_name(workspace_id, record.run_id, record.item_id),
        item=None if record.metadata_only else item_name(workspace_id, record.item_id),
        revision=(
            revision_name(workspace_id, record.item_id, record.revision_number)
            if record.revision_number is not None and not record.metadata_only
            else None
        ),
        state=record.state.upper(),  # type: ignore[arg-type]
        phase=record.phase,  # type: ignore[arg-type]
        phases=[_phase_message(phase) for phase in record.phases],
        error=dict(record.error) if record.error is not None else None,
        error_class=record.error_class,
        create_time=record.create_time,
        start_time=record.start_time,
        end_time=record.end_time,
    )


def workspace_summary_message(summary: WorkspaceIngestionSummary) -> IngestionWorkspaceSummaryMessage:
    return IngestionWorkspaceSummaryMessage(
        workspace=workspace_name(summary.workspace_id),
        queued_task_count=summary.queued_task_count,
        running_task_count=summary.running_task_count,
        throughput_per_hour=summary.throughput_per_hour,
        failure_rate=summary.failure_rate,
        error_classes=[
            IngestionErrorClassCountMessage(error_class=error_class, task_count=count)
            for error_class, count in summary.error_classes
        ],
    )


def summary_window(filter: str | None) -> tuple[ColumnElement[bool], datetime | None]:
    """SummarizeIngestionRuns ``filter`` (runs' ``createTime``): the WHERE and its lower bound."""
    node = filtering.parse(filter)
    where = SUMMARY_FILTERS.compile(node)
    lower_bounds = [
        datetime.fromisoformat(restriction.value.text)
        for restriction in filtering.restrictions(node)
        if restriction.operator in (Operator.GT, Operator.GE)
    ]
    return where, min(lower_bounds) if lower_bounds else None


def _selector_message(
    selector: RunSelector, *, workspace_id: UUID
) -> IngestionRunSelectorMessage:
    return IngestionRunSelectorMessage(
        items=[item_name(workspace_id, item) for item in selector.items] or None,
        ancestor=item_name(workspace_id, selector.ancestor) if selector.ancestor else None,
        source=source_name(workspace_id, selector.source) if selector.source else None,
        states=list(selector.states) or None,  # type: ignore[arg-type]
    )


def _phase_message(phase: TaskPhase) -> IngestionTaskPhaseMessage:
    return IngestionTaskPhaseMessage(
        phase=phase.phase,  # type: ignore[arg-type]
        state=phase.state,  # type: ignore[arg-type]
        start_time=phase.start_time,
        end_time=phase.end_time,
    )


def _upper(column: Any) -> ColumnElement[str]:
    return func.upper(column)


RUN_FILTERS = FilterSchema(
    {
        "state": filtering.enum(_upper(IngestionRun.status), _RUN_STATES),
        "trigger": filtering.enum(_upper(IngestionRun.trigger_type), _TRIGGERS),
        "createTime": filtering.timestamp(IngestionRun.created_at),
    }
)
RUN_ORDER = OrderSchema(
    {"createTime": IngestionRun.created_at},
    tie_breaker=[IngestionRun.id],
    default="createTime desc",
)
TASK_FILTERS = FilterSchema(
    {
        "state": filtering.enum(_upper(IngestionRunItem.status), _RUN_STATES),
        "errorClass": filtering.string(IngestionRunItem.error_class),
        "createTime": filtering.timestamp(IngestionRunItem.created_at),
    }
)
TASK_ORDER = OrderSchema(
    {
        "createTime": IngestionRunItem.created_at,
        "startTime": IngestionRunItem.started_at,
        "endTime": IngestionRunItem.finished_at,
    },
    tie_breaker=[IngestionRunItem.run_id, IngestionRunItem.item_id],
    default="createTime desc",
)
SUMMARY_FILTERS = FilterSchema({"createTime": filtering.timestamp(IngestionRun.created_at)})


__all__ = [
    "RUN_FILTERS",
    "RUN_ORDER",
    "SUMMARY_FILTERS",
    "TASK_FILTERS",
    "TASK_ORDER",
    "CancelIngestionRunRequest",
    "IngestionRunMessage",
    "IngestionTaskMessage",
    "ListIngestionRunsResponse",
    "ListIngestionTasksResponse",
    "RetryIngestionRunRequest",
    "SummarizeIngestionRunsResponse",
    "ingestion_run_message",
    "ingestion_task_message",
    "run_selector",
    "summary_window",
    "workspace_summary_message",
]
