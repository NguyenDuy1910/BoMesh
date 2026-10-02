from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any

from temporalio.api.enums.v1 import EventType, IndexedValueType, PendingActivityState
from temporalio.api.failure.v1 import Failure
from temporalio.api.operatorservice.v1 import (
    AddSearchAttributesRequest,
    ListSearchAttributesRequest,
)

from temporalio.client import (
    Schedule,
    ScheduleActionStartWorkflow,
    ScheduleAlreadyRunningError,
    ScheduleDescription,
    ScheduleIntervalSpec,
    ScheduleOverlapPolicy,
    SchedulePolicy,
    ScheduleSpec,
    ScheduleState,
    ScheduleUpdate,
    WorkflowExecution,
    WorkflowExecutionDescription,
    WorkflowQueryFailedError,
    WorkflowQueryRejectedError,
)
from temporalio.common import (
    SearchAttributeKey,
    SearchAttributePair,
    TypedSearchAttributes,
    WorkflowIDConflictPolicy,
    WorkflowIDReusePolicy,
)
from temporalio.exceptions import (
    WorkflowAlreadyStartedError,
)
from temporalio.service import RPCError, RPCStatusCode

from bothesis.services.workflow import (
    INGESTION_WORKFLOW_NAME,
    IngestionProgress,
    IngestionResult,
    IngestionWorkflowInput,
    TemporalSettings,
    WorkflowExecutionNotFoundError,
    ingestion_schedule_id,
    ingestion_workflow_id,
)
from bothesis.services.workflow.client import TemporalClientProvider

log = logging.getLogger(__name__)

_TENANT_ID = SearchAttributeKey.for_keyword("TenantId")
_INGESTION_SOURCE_ID = SearchAttributeKey.for_keyword("IngestionSourceId")
_INTEGRATION_CONNECTION_ID = SearchAttributeKey.for_keyword("IntegrationConnectionId")
_CONNECTOR_KEY = SearchAttributeKey.for_keyword("ConnectorKey")
_WORKFLOW_CATEGORY = SearchAttributeKey.for_keyword("WorkflowCategory")
_TRIGGER_TYPE = SearchAttributeKey.for_keyword("TriggerType")
#: The destination Collection, which is what read access to a run is decided by.
_COLLECTION_ID = SearchAttributeKey.for_keyword("CollectionId")
_SEARCH_ATTRIBUTES = (
    _TENANT_ID,
    _INGESTION_SOURCE_ID,
    _INTEGRATION_CONNECTION_ID,
    _CONNECTOR_KEY,
    _WORKFLOW_CATEGORY,
    _TRIGGER_TYPE,
    _COLLECTION_ID,
)
_TITLE_MEMO = "title"
_WORKFLOW_ID_PREFIX = ingestion_workflow_id("x")[:-1]
#: ``WorkflowCategory`` of a Document ingestion; anything else is a Source's
#: (runs recorded before this value existed say "ingestion").
_DOCUMENT_CATEGORY = "document"
#: Running executions whose live Activity state one list page reads.
_MAX_LIVE_DESCRIBES = 25
_ACTIVITY_STATES = {
    PendingActivityState.PENDING_ACTIVITY_STATE_SCHEDULED: "scheduled",
    PendingActivityState.PENDING_ACTIVITY_STATE_STARTED: "started",
    PendingActivityState.PENDING_ACTIVITY_STATE_CANCEL_REQUESTED: "cancel_requested",
}
_HISTORY_EVENTS = {
    EventType.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED: "workflow_started",
    EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED: "activity_scheduled",
    EventType.EVENT_TYPE_ACTIVITY_TASK_STARTED: "activity_started",
    EventType.EVENT_TYPE_ACTIVITY_TASK_COMPLETED: "activity_completed",
    EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED: "activity_failed",
    EventType.EVENT_TYPE_ACTIVITY_TASK_TIMED_OUT: "activity_timed_out",
    EventType.EVENT_TYPE_ACTIVITY_TASK_CANCELED: "activity_cancelled",
    EventType.EVENT_TYPE_WORKFLOW_EXECUTION_CANCEL_REQUESTED: "cancel_requested",
    EventType.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED: "workflow_completed",
    EventType.EVENT_TYPE_WORKFLOW_EXECUTION_FAILED: "workflow_failed",
    EventType.EVENT_TYPE_WORKFLOW_EXECUTION_TIMED_OUT: "workflow_timed_out",
    EventType.EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED: "workflow_cancelled",
    EventType.EVENT_TYPE_WORKFLOW_EXECUTION_TERMINATED: "workflow_terminated",
}

_OVERLAP_POLICIES = {
    "skip": ScheduleOverlapPolicy.SKIP,
    "queue": ScheduleOverlapPolicy.BUFFER_ONE,
    "replace": ScheduleOverlapPolicy.CANCEL_OTHER,
}
_STATUS_QUERY_VALUES = {
    "running": "Running",
    "completed": "Completed",
    "failed": "Failed",
    "cancelled": "Canceled",
    "canceled": "Canceled",
    "terminated": "Terminated",
    "timed_out": "TimedOut",
}


class TemporalWorkflowService:
    """Use Temporal as the sole runtime for ingestion execution state."""

    def __init__(
        self,
        client_provider: TemporalClientProvider | None = None,
        settings: TemporalSettings | None = None,
    ) -> None:
        self._provider = client_provider or TemporalClientProvider(settings)
        self._settings = self._provider.settings

    async def ensure_search_attributes(self) -> None:
        """Register the custom search attributes executions are started with.

        Idempotent. A namespace this process may not administer (a hosted
        one, typically) is left alone: its operator registers them instead.
        """

        client = await self._provider.get()
        namespace = self._settings.namespace
        try:
            existing = await client.operator_service.list_search_attributes(
                ListSearchAttributesRequest(namespace=namespace)
            )
            missing = {
                key.name: IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD
                for key in _SEARCH_ATTRIBUTES
                if key.name not in existing.custom_attributes
            }
            if missing:
                await client.operator_service.add_search_attributes(
                    AddSearchAttributesRequest(
                        namespace=namespace, search_attributes=missing
                    )
                )
                log.info("registered search attributes %s", sorted(missing))
        except RPCError as exc:
            log.warning("search attributes could not be verified: %s", exc.message)

    async def start_ingestion(
        self,
        input: IngestionWorkflowInput,
        *,
        title: str | None = None,
        collection_id: str | None = None,
    ) -> dict[str, Any]:
        """Start one managed ingestion; an already running one is returned as is."""

        client = await self._provider.get()
        workflow_id = ingestion_workflow_id(input.target_id)
        try:
            handle = await client.start_workflow(
                INGESTION_WORKFLOW_NAME,
                input,
                result_type=IngestionResult,
                id=workflow_id,
                task_queue=self._settings.task_queue,
                id_reuse_policy=WorkflowIDReusePolicy.ALLOW_DUPLICATE,
                id_conflict_policy=WorkflowIDConflictPolicy.FAIL,
                search_attributes=self._search_attributes(input, collection_id=collection_id),
                memo=_memo(title),
                static_summary=f"Ingest {input.kind} {input.target_id}",
            )
            payload = await self._execution_payload(await handle.describe())
            payload["started"] = True
            return payload
        except WorkflowAlreadyStartedError:
            description = await client.get_workflow_handle(workflow_id).describe()
            payload = await self._execution_payload(description)
            payload["started"] = False
            payload["conflict"] = f"{input.kind}_ingestion_already_running"
            return payload

    async def list_ingestions(
        self,
        *,
        tenant_id: str,
        page: int = 1,
        page_size: int = 20,
        status: str | None = None,
        source_id: str | None = None,
        integration_connection_id: str | None = None,
        include_sources: bool = True,
        document_collection_ids: Sequence[str] | None = None,
        collection_id: str | None = None,
        document_id: str | None = None,
        live: bool = False,
    ) -> dict[str, Any]:
        """One page of Ingestions, newest first, each at its latest run.

        An Ingestion is one execution id: a retry, or another manual sync of a
        Source, is a new run of the same id, and describe, events and retry
        all address its latest run. Visibility lists every run, so older runs
        of an id already on the page are skipped. A queued or running run is
        always the latest (a second run of an id cannot start while one is
        open), so those states filter in the query; a closed state is matched
        against each Ingestion's latest run, or a superseded failure would
        show. ``total`` is exact once the listing is exhausted and otherwise
        counts runs, an upper bound.

        Source runs are included when ``include_sources``; document runs only
        for ``document_collection_ids`` (``None`` excludes them). ``live``
        adds the current Activity state of the running executions on the page.
        """

        if page < 1 or not 1 <= page_size <= 100:
            raise ValueError("invalid workflow page")
        wanted = _latest_run_status(status)
        scope = dict(
            tenant_id=tenant_id,
            source_id=source_id,
            integration_connection_id=integration_connection_id,
            include_sources=include_sources,
            document_collection_ids=document_collection_ids,
            collection_id=collection_id,
            document_id=document_id,
        )
        query = self._visibility_query(**scope, status=None if wanted else status)
        if query is None:
            return {"items": [], "total": 0, "page": page, "page_size": page_size}
        client = await self._provider.get()
        offset = (page - 1) * page_size
        seen: set[str] = set()
        latest: list[WorkflowExecution] = []
        exhausted = True
        async for execution in client.list_workflows(
            query, page_size=min(1000, max(100, offset + page_size))
        ):
            if execution.id in seen:
                continue
            seen.add(execution.id)
            if wanted and _status_name(execution) != wanted:
                continue
            if len(latest) == offset + page_size:
                exhausted = False
                break
            latest.append(execution)
        if exhausted:
            total = len(latest)
        else:
            counted = self._visibility_query(**scope, status=status)
            assert counted is not None
            total = (await client.count_workflows(counted)).count
        items = [await self._execution_payload(execution) for execution in latest[offset:]]
        if live:
            await self._add_live_state(items)
        return {"items": items, "total": total, "page": page, "page_size": page_size}

    async def scan_ingestions(
        self,
        *,
        tenant_id: str,
        started_after: datetime,
        include_sources: bool,
        document_collection_ids: Sequence[str] | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        """Every execution started after ``started_after`` (up to ``limit``), newest first."""

        query = self._visibility_query(
            tenant_id=tenant_id,
            include_sources=include_sources,
            document_collection_ids=document_collection_ids,
            started_after=started_after,
        )
        if query is None:
            return []
        client = await self._provider.get()
        return [
            await self._execution_payload(execution)
            async for execution in client.list_workflows(
                query, limit=limit, page_size=min(1000, limit)
            )
        ]

    async def describe_ingestion(
        self, workflow_id: str, *, include_progress: bool = True
    ) -> dict[str, Any]:
        client = await self._provider.get()
        handle = client.get_workflow_handle(workflow_id)
        try:
            description = await handle.describe()
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                raise WorkflowExecutionNotFoundError(workflow_id) from exc
            raise
        payload = await self._execution_payload(description)
        payload["activity"] = await self._activity_state(description)
        if include_progress and payload["kind"] == "source":
            try:
                progress = await handle.query(
                    "progress", result_type=IngestionProgress
                )
                payload["progress"] = self._progress_payload(progress)
            except (WorkflowQueryFailedError, WorkflowQueryRejectedError, RPCError):
                pass
        return payload

    async def ingestion_history(self, workflow_id: str) -> list[dict[str, Any]]:
        """The latest run's history as neutral facts, oldest first.

        Each fact is ``{type, at}`` plus, where it applies, ``attempt``,
        ``result`` (the decoded Activity result) and ``failure``
        (``{message, type, non_retryable, details}`` of the innermost cause).
        """

        client = await self._provider.get()
        handle = client.get_workflow_handle(workflow_id)
        facts: list[dict[str, Any]] = []
        try:
            async for event in handle.fetch_history_events():
                kind = _HISTORY_EVENTS.get(event.event_type)
                if kind is None:
                    continue
                fact: dict[str, Any] = {
                    "type": kind,
                    "at": event.event_time.ToDatetime(tzinfo=UTC),
                }
                if kind == "activity_started":
                    attributes = event.activity_task_started_event_attributes
                    fact["attempt"] = attributes.attempt
                    if attributes.HasField("last_failure"):
                        fact["failure"] = await self._failure(attributes.last_failure)
                elif kind == "activity_completed":
                    result = event.activity_task_completed_event_attributes.result
                    decoded = await client.data_converter.decode(result.payloads)
                    fact["result"] = decoded[0] if decoded else None
                elif kind == "activity_failed":
                    fact["failure"] = await self._failure(
                        event.activity_task_failed_event_attributes.failure
                    )
                elif kind == "workflow_failed":
                    fact["failure"] = await self._failure(
                        event.workflow_execution_failed_event_attributes.failure
                    )
                facts.append(fact)
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                raise WorkflowExecutionNotFoundError(workflow_id) from exc
            raise
        return facts

    async def latest_ingestion(
        self, *, tenant_id: str, source_id: str
    ) -> dict[str, Any] | None:
        result = await self.list_ingestions(
            tenant_id=tenant_id,
            source_id=source_id,
            page=1,
            page_size=1,
        )
        if not result["items"]:
            return None
        return await self.describe_ingestion(result["items"][0]["id"])

    async def cancel_ingestion(self, workflow_id: str) -> dict[str, Any]:
        client = await self._provider.get()
        handle = client.get_workflow_handle(workflow_id)
        try:
            await handle.cancel()
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                raise WorkflowExecutionNotFoundError(workflow_id) from exc
            raise
        return await self.describe_ingestion(workflow_id, include_progress=False)

    async def upsert_schedule(
        self,
        input: IngestionWorkflowInput,
        values: dict[str, Any],
        *,
        title: str | None = None,
        collection_id: str | None = None,
    ) -> dict[str, Any]:
        scheduled_input = replace(input, trigger_type="scheduled")
        schedule = self._schedule(
            scheduled_input, values, title=title, collection_id=collection_id
        )
        schedule_id = ingestion_schedule_id(input.source_id)
        attributes = self._search_attributes(scheduled_input, collection_id=collection_id)
        client = await self._provider.get()
        try:
            handle = await client.create_schedule(
                schedule_id,
                schedule,
                search_attributes=attributes,
            )
        except ScheduleAlreadyRunningError:
            handle = client.get_schedule_handle(schedule_id)

            async def update(_: Any) -> ScheduleUpdate:
                return ScheduleUpdate(schedule=schedule, search_attributes=attributes)

            await handle.update(update)
        return self._schedule_payload(await handle.describe())

    async def describe_schedule(self, source_id: str) -> dict[str, Any] | None:
        client = await self._provider.get()
        handle = client.get_schedule_handle(ingestion_schedule_id(source_id))
        try:
            return self._schedule_payload(await handle.describe())
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                return None
            raise

    async def pause_schedule(self, source_id: str) -> dict[str, Any]:
        handle = (await self._provider.get()).get_schedule_handle(
            ingestion_schedule_id(source_id)
        )
        try:
            await handle.pause(note="Paused by Enterprise Agent administrator")
            return self._schedule_payload(await handle.describe())
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                raise WorkflowExecutionNotFoundError(source_id) from exc
            raise

    async def resume_schedule(self, source_id: str) -> dict[str, Any]:
        handle = (await self._provider.get()).get_schedule_handle(
            ingestion_schedule_id(source_id)
        )
        try:
            await handle.unpause(note="Resumed by Enterprise Agent administrator")
            return self._schedule_payload(await handle.describe())
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                raise WorkflowExecutionNotFoundError(source_id) from exc
            raise

    async def delete_schedule(self, source_id: str) -> None:
        handle = (await self._provider.get()).get_schedule_handle(
            ingestion_schedule_id(source_id)
        )
        try:
            await handle.delete()
        except RPCError as exc:
            if exc.status != RPCStatusCode.NOT_FOUND:
                raise

    def _schedule(
        self,
        input: IngestionWorkflowInput,
        values: dict[str, Any],
        *,
        title: str | None,
        collection_id: str | None,
    ) -> Schedule:
        schedule_type = str(values.get("schedule_type") or "cron").strip().casefold()
        expression = str(values.get("cron_expression") or "").strip()
        if not expression:
            raise ValueError("schedule expression is required")
        if schedule_type == "cron":
            spec = ScheduleSpec(
                cron_expressions=[expression],
                time_zone_name=(str(values.get("timezone") or "UTC").strip()),
            )
        elif schedule_type == "interval":
            try:
                seconds = int(expression)
            except ValueError as exc:
                raise ValueError(
                    "interval schedule expression must be seconds"
                ) from exc
            if seconds < 1:
                raise ValueError("interval schedule must be positive")
            spec = ScheduleSpec(
                intervals=[ScheduleIntervalSpec(every=timedelta(seconds=seconds))]
            )
        else:
            raise ValueError("schedule_type must be cron or interval")
        overlap = str(values.get("overlap_policy") or "skip").strip().casefold()
        if overlap not in _OVERLAP_POLICIES:
            raise ValueError("unsupported overlap policy")
        enabled = values.get("enabled", True)
        if not isinstance(enabled, bool):
            raise ValueError("schedule enabled must be a boolean")
        return Schedule(
            action=ScheduleActionStartWorkflow(
                INGESTION_WORKFLOW_NAME,
                input,
                id=ingestion_workflow_id(input.source_id),
                task_queue=self._settings.task_queue,
                typed_search_attributes=self._search_attributes(
                    input, collection_id=collection_id
                ),
                memo=_memo(title),
                static_summary=f"Scheduled {input.connector_key} ingestion",
            ),
            spec=spec,
            policy=SchedulePolicy(
                overlap=_OVERLAP_POLICIES[overlap],
                catchup_window=timedelta(minutes=5),
                pause_on_failure=False,
            ),
            state=ScheduleState(paused=not enabled),
        )

    @staticmethod
    def _search_attributes(
        input: IngestionWorkflowInput, *, collection_id: str | None = None
    ) -> TypedSearchAttributes:
        pairs = [
            SearchAttributePair(_TENANT_ID, input.tenant_id),
            SearchAttributePair(_WORKFLOW_CATEGORY, input.kind),
            SearchAttributePair(_TRIGGER_TYPE, input.trigger_type),
            SearchAttributePair(_CONNECTOR_KEY, input.connector_key or "file"),
        ]
        if input.source_id is not None:
            pairs.append(SearchAttributePair(_INGESTION_SOURCE_ID, input.source_id))
        if input.integration_connection_id:
            pairs.append(SearchAttributePair(_INTEGRATION_CONNECTION_ID, input.integration_connection_id))
        if collection_id:
            pairs.append(SearchAttributePair(_COLLECTION_ID, collection_id))
        return TypedSearchAttributes(pairs)

    @staticmethod
    def _visibility_query(
        *,
        tenant_id: str,
        status: str | None = None,
        source_id: str | None = None,
        integration_connection_id: str | None = None,
        include_sources: bool = True,
        document_collection_ids: Sequence[str] | None = None,
        collection_id: str | None = None,
        document_id: str | None = None,
        started_after: datetime | None = None,
    ) -> str | None:
        """The visibility query for one caller's view, or ``None`` when it is empty."""

        kinds: list[str] = []
        if include_sources and document_id is None:
            source = [f"WorkflowCategory != '{_DOCUMENT_CATEGORY}'"]
            if source_id:
                source.append(f"IngestionSourceId = '{_visibility_literal(source_id)}'")
            if integration_connection_id:
                source.append(
                    f"IntegrationConnectionId = '{_visibility_literal(integration_connection_id)}'"
                )
            kinds.append(" AND ".join(source))
        readable = tuple(document_collection_ids or ())
        if readable and source_id is None and integration_connection_id is None:
            document = [
                f"WorkflowCategory = '{_DOCUMENT_CATEGORY}'",
                "CollectionId IN ("
                + ", ".join(f"'{_visibility_literal(value)}'" for value in readable)
                + ")",
            ]
            if document_id:
                document.append(
                    f"WorkflowId = '{_visibility_literal(ingestion_workflow_id(document_id))}'"
                )
            kinds.append(" AND ".join(document))
        if not kinds:
            return None
        clauses = [
            f"WorkflowType = '{INGESTION_WORKFLOW_NAME}'",
            f"TenantId = '{_visibility_literal(tenant_id)}'",
            "(" + " OR ".join(f"({kind})" for kind in kinds) + ")",
        ]
        if collection_id:
            clauses.append(f"CollectionId = '{_visibility_literal(collection_id)}'")
        if started_after is not None:
            clauses.append(f"StartTime >= '{started_after.astimezone(UTC).isoformat()}'")
        if status:
            normalized = status.strip().casefold()
            if normalized == "pending":
                # Not a Temporal state: a queued run is a running execution
                # whose Activity has not started, told apart by live state.
                normalized = "running"
            if normalized not in _STATUS_QUERY_VALUES:
                raise ValueError("unsupported workflow status")
            clauses.append(f"ExecutionStatus = '{_STATUS_QUERY_VALUES[normalized]}'")
        return " AND ".join(clauses)

    @staticmethod
    async def _execution_payload(
        execution: WorkflowExecution | WorkflowExecutionDescription,
    ) -> dict[str, Any]:
        status = _status_name(execution)
        attributes = execution.typed_search_attributes
        is_document = attributes.get(_WORKFLOW_CATEGORY) == _DOCUMENT_CATEGORY
        title = await execution.memo_value(_TITLE_MEMO, None)
        return {
            "id": execution.id,
            "workflow_id": execution.id,
            "run_id": execution.run_id,
            "workflow_type": execution.workflow_type,
            "kind": "document" if is_document else "source",
            "title": title if isinstance(title, str) else None,
            "document_id": (
                execution.id.removeprefix(_WORKFLOW_ID_PREFIX) if is_document else None
            ),
            "collection_id": attributes.get(_COLLECTION_ID),
            "status": status,
            "source_id": attributes.get(_INGESTION_SOURCE_ID),
            "integration_connection_id": attributes.get(_INTEGRATION_CONNECTION_ID),
            "tenant_id": attributes.get(_TENANT_ID),
            "connector_key": attributes.get(_CONNECTOR_KEY),
            "trigger_type": attributes.get(_TRIGGER_TYPE),
            "started_at": execution.start_time.isoformat(),
            "finished_at": (
                execution.close_time.isoformat() if execution.close_time else None
            ),
            "history_length": execution.history_length,
        }

    async def _add_live_state(self, items: list[dict[str, Any]]) -> None:
        """Attach live Activity state to the running executions of one page."""

        running = [item for item in items if item["status"] == "running"][:_MAX_LIVE_DESCRIBES]
        if not running:
            return
        client = await self._provider.get()

        async def describe(item: dict[str, Any]) -> None:
            try:
                description = await client.get_workflow_handle(item["id"]).describe()
            except RPCError:
                return
            item["activity"] = await self._activity_state(description)

        await asyncio.gather(*(describe(item) for item in running))

    async def _activity_state(
        self, description: WorkflowExecutionDescription
    ) -> dict[str, Any] | None:
        """The one pending Activity of an execution: its attempt, heartbeat and last failure."""

        pending = description.raw_description.pending_activities
        if not pending:
            return None
        activity = pending[0]
        client = await self._provider.get()
        heartbeat = None
        if activity.heartbeat_details.payloads:
            decoded = await client.data_converter.decode(activity.heartbeat_details.payloads)
            heartbeat = decoded[0] if decoded and isinstance(decoded[0], dict) else None
        return {
            "state": _ACTIVITY_STATES.get(activity.state, "scheduled"),
            "attempt": max(1, activity.attempt),
            "maximum_attempts": activity.maximum_attempts or None,
            "heartbeat": heartbeat,
            "heartbeat_at": (
                activity.last_heartbeat_time.ToDatetime(tzinfo=UTC)
                if activity.HasField("last_heartbeat_time")
                else None
            ),
            "started_at": (
                activity.last_started_time.ToDatetime(tzinfo=UTC)
                if activity.HasField("last_started_time")
                else None
            ),
            "last_failure": (
                await self._failure(activity.last_failure)
                if activity.HasField("last_failure")
                else None
            ),
        }

    async def _failure(self, failure: Failure) -> dict[str, Any]:
        """The innermost cause of a failure chain: what actually went wrong."""

        while failure.HasField("cause"):
            failure = failure.cause
        details = None
        info = failure.application_failure_info
        if failure.HasField("application_failure_info") and info.details.payloads:
            client = await self._provider.get()
            decoded = await client.data_converter.decode(info.details.payloads)
            details = decoded[0] if decoded else None
        return {
            "message": failure.message,
            "type": info.type if failure.HasField("application_failure_info") else None,
            "non_retryable": bool(
                failure.HasField("application_failure_info") and info.non_retryable
            ),
            "timeout": failure.HasField("timeout_failure_info"),
            "details": details,
        }

    @staticmethod
    def _schedule_payload(description: ScheduleDescription) -> dict[str, Any]:
        schedule = description.schedule
        spec = schedule.spec
        if spec.intervals:
            schedule_type = "interval"
            expression = str(round(spec.intervals[0].every.total_seconds()))
        else:
            schedule_type = "cron"
            expression = spec.cron_expressions[0] if spec.cron_expressions else ""
        overlap = {
            ScheduleOverlapPolicy.SKIP: "skip",
            ScheduleOverlapPolicy.BUFFER_ONE: "queue",
            ScheduleOverlapPolicy.CANCEL_OTHER: "replace",
        }.get(schedule.policy.overlap, schedule.policy.overlap.name.casefold())
        return {
            "id": description.id,
            "schedule_type": schedule_type,
            "cron_expression": expression,
            "timezone": spec.time_zone_name,
            "enabled": not schedule.state.paused,
            "paused": schedule.state.paused,
            "overlap_policy": overlap,
            "next_run_at": (
                description.info.next_action_times[0].isoformat()
                if description.info.next_action_times
                else None
            ),
            "last_run_at": (
                description.info.recent_actions[-1].scheduled_at.isoformat()
                if description.info.recent_actions
                else None
            ),
            "num_actions": description.info.num_actions,
            "num_actions_skipped_overlap": (
                description.info.num_actions_skipped_overlap
            ),
        }

    @staticmethod
    def _progress_payload(progress: IngestionProgress) -> dict[str, Any]:
        return {
            "phase": progress.phase,
            "discovered_count": progress.discovered_count,
            "processed_count": progress.processed_count,
            "indexed_count": progress.indexed_count,
            "deleted_count": progress.deleted_count,
            "failed_count": progress.failed_count,
        }


def _visibility_literal(value: str) -> str:
    return value.replace("'", "''")


def _status_name(execution: WorkflowExecution | WorkflowExecutionDescription) -> str:
    status = execution.status.name.casefold() if execution.status else "unknown"
    return "cancelled" if status == "canceled" else status


def _latest_run_status(status: str | None) -> str | None:
    """A requested closed state, which must be matched on each Ingestion's latest run.

    ``None`` when the query itself can filter: no state, or an open one.
    """

    if status is None:
        return None
    normalized = status.strip().casefold()
    if normalized in {"pending", "running"}:
        return None
    if normalized not in _STATUS_QUERY_VALUES:
        raise ValueError("unsupported workflow status")
    return "cancelled" if normalized == "canceled" else normalized



def _memo(title: str | None) -> dict[str, Any] | None:
    return {_TITLE_MEMO: title[:240]} if title else None


__all__ = ["TemporalWorkflowService"]
