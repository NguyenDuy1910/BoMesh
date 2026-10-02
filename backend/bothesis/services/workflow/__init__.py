"""Shared contracts and configuration for managed (Temporal) ingestion.

One workflow type runs every managed ingestion; its input names the target:
a connector Source to sync, or one stored Document to index (or expand, for
an archive). Uploads a user makes for themselves do not come through here:
they run the same ingestion core directly (``DocumentService``).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

INGESTION_TASK_QUEUE = "bothesis-ingestion"
INGESTION_WORKFLOW_NAME = "bothesis.ingestion"
SOURCE_INGESTION_ACTIVITY_NAME = "bothesis.ingest_source"
DOCUMENT_INGESTION_ACTIVITY_NAME = "bothesis.ingest_document"
#: Failure types whose message is written for people and may be shown.
DOCUMENT_FAILURE_TYPE = "DocumentIngestionError"
INTERRUPTED_FAILURE_TYPE = "IngestionInterrupted"
TRIGGER_TYPES = frozenset({"manual", "scheduled", "webhook", "initial", "upload", "retry"})
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
                os.getenv("BOTHESIS_TEMPORAL_TARGET") or TEMPORAL_DEFAULT_TARGET
            ).strip(),
            namespace=(
                os.getenv("BOTHESIS_TEMPORAL_NAMESPACE") or TEMPORAL_DEFAULT_NAMESPACE
            ).strip(),
            task_queue=(
                os.getenv("BOTHESIS_TEMPORAL_TASK_QUEUE") or INGESTION_TASK_QUEUE
            ).strip(),
            api_key=(os.getenv("BOTHESIS_TEMPORAL_API_KEY") or "").strip() or None,
            tls=_environment_boolean("BOTHESIS_TEMPORAL_TLS"),
        )

    def __post_init__(self) -> None:
        if not self.target:
            raise ValueError("Temporal target must not be blank")
        if not self.namespace:
            raise ValueError("Temporal namespace must not be blank")
        if not self.task_queue:
            raise ValueError("Temporal task queue must not be blank")


@dataclass(frozen=True, slots=True)
class IngestionWorkflowInput:
    """One managed ingestion: sync ``source_id``, or index ``document_id``."""

    tenant_id: str
    source_id: str | None = None
    connector_key: str | None = None
    integration_connection_id: str | None = None
    test_connection: bool = True
    document_id: str | None = None
    owner_user_id: str | None = None
    trigger_type: str = "manual"

    def __post_init__(self) -> None:
        if not self.tenant_id.strip():
            raise ValueError("tenant_id must not be blank")
        if (self.source_id is None) == (self.document_id is None):
            raise ValueError("an ingestion targets exactly one Source or one Document")
        if self.source_id is not None and not (
            self.source_id.strip() and (self.connector_key or "").strip()
        ):
            raise ValueError("a Source ingestion needs its source id and connector key")
        if self.document_id is not None and not (
            self.document_id.strip() and (self.owner_user_id or "").strip()
        ):
            raise ValueError("a Document ingestion needs its document id and owner")
        if self.trigger_type not in TRIGGER_TYPES:
            raise ValueError("unsupported ingestion trigger type")

    @property
    def kind(self) -> str:
        return "source" if self.source_id is not None else "document"

    @property
    def target_id(self) -> str:
        return str(self.source_id if self.source_id is not None else self.document_id)


@dataclass(frozen=True, slots=True)
class IngestionProgress:
    phase: str = "queued"
    discovered_count: int = 0
    processed_count: int = 0
    indexed_count: int = 0
    deleted_count: int = 0
    failed_count: int = 0


@dataclass(frozen=True, slots=True)
class IngestionResult:
    """What one managed ingestion did; kept in history for its timeline.

    Document runs report ``indexed_count`` chunks (or ``document_count``
    Documents extracted from an archive) and their ``phases``
    (``{phase, started_at, finished_at, done, total}``, in order).
    """

    source_id: str | None = None
    document_id: str | None = None
    discovered_count: int = 0
    processed_count: int = 0
    indexed_count: int = 0
    deleted_count: int = 0
    failed_count: int = 0
    checkpoint_advanced: bool = False
    duration_ms: int = 0
    document_count: int = 0
    phases: list[dict[str, Any]] = field(default_factory=list)


class WorkflowExecutionNotFoundError(LookupError):
    """Raised when a Temporal workflow or schedule is not present."""


def ingestion_workflow_id(target_id: str) -> str:
    """The one execution id of a Source's or a Document's managed ingestion."""

    normalized = target_id.strip()
    if not normalized:
        raise ValueError("ingestion target id must not be blank")
    return f"ingestion:{normalized}"


def ingestion_schedule_id(source_id: str) -> str:
    normalized = source_id.strip()
    if not normalized:
        raise ValueError("source_id must not be blank")
    return f"ingestion-schedule:{normalized}"


def document_ingestion_id(document_id: str) -> UUID:
    """A Document's ingestion id, whichever runner (managed or direct) ran it."""

    return public_ingestion_id(ingestion_workflow_id(document_id))


def public_ingestion_id(workflow_id: str) -> UUID:
    """The contract ``ingestion_id`` of one Temporal workflow; the workflow id stays private."""

    normalized = workflow_id.strip()
    if not normalized:
        raise ValueError("workflow_id must not be blank")
    return uuid5(NAMESPACE_URL, f"bothesis:ingestion:{normalized}")


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
    "DOCUMENT_FAILURE_TYPE",
    "DOCUMENT_INGESTION_ACTIVITY_NAME",
    "INGESTION_TASK_QUEUE",
    "INGESTION_WORKFLOW_NAME",
    "INTERRUPTED_FAILURE_TYPE",
    "SOURCE_INGESTION_ACTIVITY_NAME",
    "TRIGGER_TYPES",
    "IngestionProgress",
    "IngestionResult",
    "IngestionWorkflowInput",
    "TemporalSettings",
    "WorkflowExecutionNotFoundError",
    "document_ingestion_id",
    "ingestion_schedule_id",
    "ingestion_workflow_id",
    "public_ingestion_id",
]
