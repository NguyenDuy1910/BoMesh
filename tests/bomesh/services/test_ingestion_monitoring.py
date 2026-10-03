"""The Ingestion monitor: who sees which run, and what a run is said to be doing."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from temporalio.client import WorkflowExecutionStatus

from bomesh.services.ingestion import build_events, build_summary, ingestion_resource
from bomesh.services.workflow import (
    DOCUMENT_FAILURE_TYPE,
    INTERRUPTED_FAILURE_TYPE,
    document_ingestion_id,
    ingestion_workflow_id,
)
from bomesh.services.workflow.service import TemporalWorkflowService

T0 = datetime(2026, 9, 28, 10, 0, tzinfo=UTC)
DOCUMENT_ID = "3f0c1c52-8d7e-4a39-9f3e-2f4f5e6a7b8c"


def _document_run(**values: object) -> dict[str, object]:
    return {
        "workflow_id": ingestion_workflow_id(DOCUMENT_ID),
        "kind": "document",
        "title": "travel.docx",
        "document_id": DOCUMENT_ID,
        "collection_id": "c-1",
        "status": "running",
        "trigger_type": "upload",
        "connector_key": "file",
        "started_at": T0.isoformat(),
        "finished_at": None,
        **values,
    }


def test_document_runs_are_only_visible_through_readable_collections() -> None:
    query = TemporalWorkflowService._visibility_query
    documents_only = query(tenant_id="t", include_sources=False, document_collection_ids=["c-1"])
    assert documents_only is not None
    assert "CollectionId IN ('c-1')" in documents_only
    assert "WorkflowCategory != 'document'" not in documents_only
    # No readable Collection and no source permission: nothing to ask Temporal.
    assert query(tenant_id="t", include_sources=False, document_collection_ids=[]) is None
    # Filtering by source never widens into document runs.
    by_source = query(tenant_id="t", source_id="s-1", document_collection_ids=["c-1"])
    assert by_source is not None and "CollectionId IN" not in by_source


def test_a_run_no_worker_has_picked_up_is_pending_then_running_with_its_phase() -> None:
    queued = ingestion_resource(_document_run(activity={"state": "scheduled", "attempt": 1}))
    assert queued["status"] == "pending"
    assert queued["progress"]["phase"] == "queued"

    embedding = ingestion_resource(
        _document_run(
            activity={
                "state": "started",
                "attempt": 1,
                # The shape the Activity heartbeats: PhaseRecorder.snapshot().
                "heartbeat": {
                    "phase": "embedding",
                    "done": 24,
                    "total": 60,
                    "phases": [
                        {"phase": "parsing", "started_at": T0.isoformat(),
                         "finished_at": T0.isoformat(), "done": 0, "total": 0},
                        {"phase": "embedding", "started_at": T0.isoformat(),
                         "finished_at": None, "done": 24, "total": 60},
                    ],
                },
            }
        )
    )
    assert embedding["status"] == "running"
    assert embedding["progress"]["phase"] == "embedding"
    assert (embedding["progress"]["processed_count"], embedding["progress"]["discovered_count"]) == (24, 60)
    # The same identity the Document's own record carries, whichever runner ran it.
    assert embedding["id"] == document_ingestion_id(DOCUMENT_ID)
    assert embedding["mode"] == "managed"


def test_only_failure_messages_written_for_people_are_shown() -> None:
    def failed(failure: dict[str, object]) -> dict[str, object]:
        return ingestion_resource(
            _document_run(
                status="failed",
                finished_at=(T0 + timedelta(seconds=5)).isoformat(),
                history=[{"type": "workflow_failed", "at": T0, "failure": failure}],
            )
        )

    readable = failed({"type": DOCUMENT_FAILURE_TYPE, "message": "document exceeds the configured processing limit"})
    assert readable["error"] == "document exceeds the configured processing limit"
    internal = failed({"type": "ConnectError", "message": "qdrant:6333 connection refused"})
    assert internal["error"] == "The document could not be processed."
    assert failed({"timeout": True})["error"].startswith("The worker stopped responding")


def test_the_timeline_shows_the_retry_its_phases_and_the_outcome() -> None:
    phases = [
        {"phase": "parsing", "started_at": (T0 + timedelta(seconds=3)).isoformat(),
         "finished_at": (T0 + timedelta(seconds=5)).isoformat(), "done": 0, "total": 0},
        {"phase": "embedding", "started_at": (T0 + timedelta(seconds=5)).isoformat(),
         "finished_at": (T0 + timedelta(seconds=8)).isoformat(), "done": 60, "total": 60},
    ]
    history = [
        {"type": "workflow_started", "at": T0},
        {"type": "activity_started", "at": T0 + timedelta(seconds=3), "attempt": 2,
         "failure": {"type": INTERRUPTED_FAILURE_TYPE, "message": "Processing was interrupted before it finished."}},
        {"type": "activity_completed", "at": T0 + timedelta(seconds=9), "result": {"phases": phases, "indexed_count": 60}},
        {"type": "workflow_completed", "at": T0 + timedelta(seconds=9)},
    ]

    events = build_events(_document_run(status="completed"), history)

    assert [(event["type"], event["phase"]) for event in events] == [
        ("queued", None),
        ("retrying", None),
        ("started", None),
        ("phase", "parsing"),
        ("phase", "embedding"),
        ("completed", None),
    ]
    assert events[1]["attempt"] == 2
    assert events[1]["message"] == "Processing was interrupted before it finished."
    assert events[4]["duration_ms"] == 3000
    assert events[4]["message"] == "60 of 60 chunks"
    assert events[-1]["message"] == "60 chunks indexed"


def test_summary_counts_starts_and_finishes_in_their_own_buckets() -> None:
    start = T0
    runs = [
        _document_run(status="completed", started_at=T0 + timedelta(minutes=1),
                      finished_at=T0 + timedelta(minutes=1, seconds=4)),
        _document_run(status="failed", started_at=T0 + timedelta(minutes=2),
                      finished_at=T0 + timedelta(minutes=7)),
        {**_document_run(), "kind": "source", "started_at": T0 + timedelta(minutes=8)},
    ]

    summary = build_summary(
        runs, window="1h", start=start, now=T0 + timedelta(minutes=10), bucket_seconds=300, active=1
    )

    assert [(b["started"], b["completed"], b["failed"]) for b in summary["buckets"]] == [(2, 1, 0), (1, 0, 1)]
    assert summary["totals"]["completed"] == 1 and summary["totals"]["failed"] == 1
    assert summary["totals"]["running"] == 1
    assert summary["by_kind"] == {"document": 2, "source": 1}
    assert summary["duration_ms"] == {"p50": 4000, "p95": 300000, "max": 300000}


def test_a_cancelled_run_keeps_the_phases_it_got_through_and_its_counts() -> None:
    recorded = [
        {"phase": "parsing", "started_at": T0.isoformat(),
         "finished_at": (T0 + timedelta(seconds=1)).isoformat(), "done": 0, "total": 0},
        {"phase": "contextualizing", "started_at": (T0 + timedelta(seconds=1)).isoformat(),
         "finished_at": (T0 + timedelta(seconds=9)).isoformat(), "done": 18, "total": 70},
    ]
    # A cancel's history has no result and no details; only the record has them.
    raw = _document_run(status="cancelled", finished_at=(T0 + timedelta(seconds=9)).isoformat(),
                        history=[{"type": "workflow_started", "at": T0},
                                 {"type": "workflow_cancelled", "at": T0 + timedelta(seconds=9)}],
                        recorded_phases=recorded)

    events = build_events(raw, raw["history"])
    progress = ingestion_resource(raw)["progress"]

    assert [(event["type"], event["phase"]) for event in events] == [
        ("queued", None), ("phase", "parsing"), ("phase", "contextualizing"), ("cancelled", None),
    ]
    assert progress["phase"] == "cancelled"
    assert (progress["discovered_count"], progress["processed_count"]) == (70, 0)


class _Visibility:
    """Temporal's visibility: every run of every execution id, newest first."""

    settings = None

    def __init__(self, runs: list[SimpleNamespace]) -> None:
        self.runs = runs

    async def get(self) -> _Visibility:
        return self

    async def list_workflows(self, query: str, **_: object):  # noqa: ANN201
        wanted = "Failed" if "ExecutionStatus = 'Failed'" in query else None
        for run in self.runs:
            if wanted is None or run.status is WorkflowExecutionStatus.FAILED:
                yield run

    async def count_workflows(self, query: str) -> SimpleNamespace:
        return SimpleNamespace(count=len([run async for run in self.list_workflows(query)]))


def _source_run(source_id: str, run_id: str, status: WorkflowExecutionStatus, minutes: int) -> SimpleNamespace:
    async def memo_value(*_: object) -> None:
        return None

    return SimpleNamespace(
        id=ingestion_workflow_id(source_id), run_id=run_id, workflow_type="bomesh.ingestion",
        status=status, typed_search_attributes={}, memo_value=memo_value,
        start_time=T0 + timedelta(minutes=minutes), close_time=T0 + timedelta(minutes=minutes + 1),
        history_length=10,
    )


@pytest.mark.asyncio
async def test_each_ingestion_is_listed_once_as_its_latest_run() -> None:
    # Source "a" was synced three times; its last sync succeeded after a failure.
    visibility = _Visibility([
        _source_run("a", "a3", WorkflowExecutionStatus.COMPLETED, 30),
        _source_run("b", "b1", WorkflowExecutionStatus.FAILED, 20),
        _source_run("a", "a2", WorkflowExecutionStatus.FAILED, 10),
        _source_run("a", "a1", WorkflowExecutionStatus.COMPLETED, 0),
    ])
    service = TemporalWorkflowService(visibility)  # type: ignore[arg-type]

    listed = await service.list_ingestions(tenant_id="t")
    assert [(item["workflow_id"], item["run_id"]) for item in listed["items"]] == [
        (ingestion_workflow_id("a"), "a3"), (ingestion_workflow_id("b"), "b1"),
    ]
    assert listed["total"] == 2
    # "a" failed once, but it has since succeeded: only "b" is failed now.
    failed = await service.list_ingestions(tenant_id="t", status="failed")
    assert [item["run_id"] for item in failed["items"]] == ["b1"]
    # Pages are pages of Ingestions, not runs.
    second = await service.list_ingestions(tenant_id="t", page=2, page_size=1)
    assert [item["run_id"] for item in second["items"]] == ["b1"]
