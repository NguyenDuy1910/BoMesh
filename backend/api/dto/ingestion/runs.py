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
from api.dto.ingestion.connectors import format_duration
from api.dto.knowledge_items import item_filters, referenced_items
from bomesh.db.models import IngestionRun, IngestionRunItem
from bomesh.services.ingestion.common import run_name, task_name
from bomesh.services.ingestion.run_engine import RunClassification, RunSelection
from bomesh.services.ingestion.runs import IngestionRunRecord, WorkspaceIngestionSummary
from bomesh.services.ingestion.tasks import IngestionTaskRecord, TaskPhase
from bomesh.services.kernel.workspaces import workspace_name
from bomesh.services.knowledge_items.names import item_name, parse_item, revision_name

IndexingState = Literal["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "OUTDATED", "UNSUPPORTED"]
RunTrigger = Literal["MANUAL", "API", "SCHEDULE", "PLATFORM_RETRY", "TAXONOMY"]
RunState = Literal["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]
TaskPhaseName = Literal[
    "QUEUED", "FETCHING", "PARSING", "OCR", "CLASSIFYING", "CHUNKING", "EMBEDDING", "INDEXING"
]
PhaseState = Literal["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "SKIPPED"]

_RUN_STATES = ("QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED")
_TRIGGERS = ("MANUAL", "API", "SCHEDULE", "PLATFORM_RETRY", "TAXONOMY")


class IngestionRunSelectorMessage(ProtoMessage):
    items: list[str] | None = None
    filter: str | None = None


class IngestionRunClassificationMessage(ProtoMessage):
    #: Concept names ``workspaces/{w}/conceptSchemes/{scheme}/concepts/{concept}``.
    concepts: list[str] | None = None
    note: str | None = None


class IngestionRunCountsMessage(ProtoMessage):
    total_count: int | None = None
    queued_count: int | None = None
    running_count: int | None = None
    succeeded_count: int | None = None
    failed_count: int | None = None
    cancelled_count: int | None = None


class IngestionRunMessage(ProtoMessage):
    """``IngestionRun``; on create only ``selector``, ``classification``, ``readImages``,
    ``classifyOnly`` and ``trigger`` are read."""

    name: str | None = None
    selector: IngestionRunSelectorMessage | None = None
    classification: IngestionRunClassificationMessage | None = None
    read_images: bool | None = None
    classify_only: bool | None = None
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
    total_size: int | None = None


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
    #: ``google.protobuf.Duration`` (``"12.5s"``); absent when no task succeeded in the window.
    median_processing_duration: str | None = None


class SummarizeIngestionRunsResponse(ProtoMessage):
    workspace_summaries: list[IngestionWorkspaceSummaryMessage]


def run_selector(
    message: IngestionRunSelectorMessage | None, *, workspace_id: UUID, processing_version: str
) -> RunSelection | None:
    """The selector with its items parsed and its filter compiled (the ListItems grammar).

    Malformed names, filters and unknown filter fields are INVALID_ARGUMENT.
    """
    if message is None:
        return None
    text = (message.filter or "").strip() or None
    node = filtering.parse(text, field="selector.filter")
    where = (
        item_filters(workspace_id, processing_version, field="selector.filter").compile(node)
        if node is not None
        else None
    )
    return RunSelection(
        items=tuple(
            parse_item(item, workspace_id, field="selector.items") for item in message.items or ()
        ),
        filter=text,
        filter_items=referenced_items(text, workspace_id),
        where=where,
    )


def run_classification(
    message: IngestionRunClassificationMessage | None,
) -> RunClassification | None:
    """The classification as given; the service parses and resolves its concept names."""
    if message is None:
        return None
    return RunClassification(concepts=tuple(message.concepts or ()), note=message.note)


def ingestion_run_message(record: IngestionRunRecord) -> IngestionRunMessage:
    counts = record.counts
    return IngestionRunMessage(
        name=run_name(record.workspace_id, record.run_id),
        selector=(
            _selector_message(record.selector, workspace_id=record.workspace_id)
            if record.selector is not None
            else None
        ),
        classification=(
            IngestionRunClassificationMessage(
                concepts=list(record.concept_names) or None,
                note=record.classification.note,
            )
            if record.classification is not None
            else None
        ),
        read_images=record.read_images,
        classify_only=record.classify_only,
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
        median_processing_duration=format_duration(summary.median_processing_duration)
        if summary.median_processing_duration is not None
        else None,
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
    selector: RunSelection, *, workspace_id: UUID
) -> IngestionRunSelectorMessage:
    return IngestionRunSelectorMessage(
        items=[item_name(workspace_id, item) for item in selector.items] or None,
        filter=selector.filter,
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
#: ``IngestionTask.name`` as SQL text (task ID = item ID): ``name = "*<id prefix>*"``.
_TASK_NAME: ColumnElement[str] = func.concat(
    "workspaces/",
    IngestionRun.tenant_id,
    "/ingestionRuns/",
    IngestionRunItem.run_id,
    "/tasks/",
    IngestionRunItem.item_id,
)
TASK_FILTERS = FilterSchema(
    {
        "name": filtering.string(_TASK_NAME),
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
    "run_classification",
    "run_selector",
    "summary_window",
    "workspace_summary_message",
]
