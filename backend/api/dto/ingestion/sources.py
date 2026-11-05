"""Source and Sync messages, their filters and orders, and record → message mapping."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import func

from api.aip import filtering
from api.aip.fieldmask import MutableFields
from api.aip.filtering import FilterSchema
from api.aip.messages import ProtoMessage, Timestamp
from api.aip.ordering import OrderSchema
from bomesh.db.models import IngestionSource, IngestionSync, IntegrationConnection
from bomesh.db.models.ingestion import SYNC_STATUSES, SYNC_TRIGGERS
from bomesh.errors import InvalidArgument
from bomesh.services.ingestion.common import parse_child_name
from bomesh.services.ingestion.source_store import SOURCE_STATES, source_state_column
from bomesh.services.ingestion.sources import (
    PUBLISHING_POLICIES,
    ExternalResourceRef,
    SourceChanges,
    SourceDraft,
    SourceRecord,
    SourceSchedule,
    SyncRecord,
)
from bomesh.services.knowledge_items.names import parse_item

#: Everything else (connection, targetCollection, externalResource) is immutable.
SOURCE_FIELDS = MutableFields(("displayName", "config", "schedule", "publishingPolicy"))


class SourceExternalResourceMessage(ProtoMessage):
    type: str | None = None
    resource_id: str | None = None
    display_name: str | None = None


class SourceScheduleMessage(ProtoMessage):
    cron: str | None = None
    time_zone: str | None = None


class SourceSyncSummaryMessage(ProtoMessage):
    sync: str | None = None
    state: str | None = None
    added_count: int | None = None
    updated_count: int | None = None
    removed_count: int | None = None
    failed_count: int | None = None
    end_time: Timestamp | None = None


class SourceMessage(ProtoMessage):
    name: str | None = None
    connection: str | None = None
    target_collection: str | None = None
    external_resource: SourceExternalResourceMessage | None = None
    display_name: str | None = None
    config: dict[str, Any] | None = None
    schedule: SourceScheduleMessage | None = None
    publishing_policy: str | None = None
    state: str | None = None
    last_sync: SourceSyncSummaryMessage | None = None
    pending_document_count: int | None = None
    in_review_count: int | None = None
    etag: str | None = None
    create_time: Timestamp | None = None
    update_time: Timestamp | None = None


class ListSourcesResponse(ProtoMessage):
    sources: list[SourceMessage]
    next_page_token: str | None = None
    total_size: int | None = None


class PauseSourceRequest(ProtoMessage):
    etag: str | None = None


class ResumeSourceRequest(ProtoMessage):
    etag: str | None = None


class SourceSyncFailureMessage(ProtoMessage):
    resource_id: str | None = None
    display_name: str | None = None
    message: str | None = None


class SyncMessage(ProtoMessage):
    """Every field is output-only: a CreateSync body is accepted and ignored."""

    name: str | None = None
    state: str | None = None
    trigger: str | None = None
    start_time: Timestamp | None = None
    end_time: Timestamp | None = None
    added_count: int | None = None
    updated_count: int | None = None
    removed_count: int | None = None
    failed_count: int | None = None
    failures: list[SourceSyncFailureMessage] | None = None
    error: dict[str, Any] | None = None


class ListSyncsResponse(ProtoMessage):
    syncs: list[SyncMessage]
    next_page_token: str | None = None
    total_size: int | None = None


# -- Filters and orders --------------------------------------------------------------


def source_filters(workspace_id: UUID) -> FilterSchema:
    return FilterSchema(
        {
            "state": filtering.enum(
                func.upper(source_state_column()), (state.upper() for state in SOURCE_STATES)
            ),
            "displayName": filtering.string(IngestionSource.display_name),
            "connection": filtering.resource_name(
                IntegrationConnection.code,
                lambda name: parse_child_name(
                    name, workspace_id=workspace_id, collection="connections", field="filter"
                ),
            ),
            "targetCollection": filtering.resource_name(
                IngestionSource.target_item_id,
                lambda name: parse_item(name, workspace_id, field="filter"),
            ),
            "publishingPolicy": filtering.enum(
                func.upper(IngestionSource.publishing_policy),
                (policy.upper() for policy in PUBLISHING_POLICIES),
            ),
            "externalResource.type": filtering.string(IngestionSource.resource_type),
            "createTime": filtering.timestamp(IngestionSource.created_at),
            "updateTime": filtering.timestamp(IngestionSource.updated_at),
        }
    )


SOURCE_ORDER = OrderSchema(
    {
        "createTime": IngestionSource.created_at,
        "updateTime": IngestionSource.updated_at,
        "displayName": IngestionSource.display_name,
    },
    tie_breaker=(IngestionSource.id,),
    default="createTime desc",
)


def sync_filters(workspace_id: UUID) -> FilterSchema:
    return FilterSchema(
        {
            "state": filtering.enum(
                func.upper(IngestionSync.status), (status.upper() for status in SYNC_STATUSES)
            ),
            "trigger": filtering.enum(
                func.upper(IngestionSync.trigger_type),
                (trigger.upper() for trigger in SYNC_TRIGGERS),
            ),
            "startTime": filtering.timestamp(IngestionSync.started_at),
            "endTime": filtering.timestamp(IngestionSync.finished_at),
            "source": filtering.resource_name(
                IngestionSource.code,
                lambda name: parse_child_name(
                    name, workspace_id=workspace_id, collection="sources", field="filter"
                ),
            ),
        }
    )


SYNC_ORDER = OrderSchema(
    {"startTime": IngestionSync.started_at, "endTime": IngestionSync.finished_at},
    tie_breaker=(IngestionSync.id,),
    default="startTime desc",
)


# -- Requests → inputs ---------------------------------------------------------------


def source_draft(body: SourceMessage) -> SourceDraft:
    """CreateSource body → draft; output-only fields are ignored."""
    resource = body.external_resource
    if body.connection is None:
        raise InvalidArgument.for_field("connection", "connection is required.")
    if body.target_collection is None:
        raise InvalidArgument.for_field("targetCollection", "targetCollection is required.")
    if resource is None or resource.type is None or resource.resource_id is None:
        raise InvalidArgument.for_field(
            "externalResource", "externalResource.type and externalResource.resourceId are required."
        )
    return SourceDraft(
        connection=body.connection,
        target_collection=body.target_collection,
        external_resource=ExternalResourceRef(
            type=resource.type,
            resource_id=resource.resource_id,
            display_name=resource.display_name,
        ),
        display_name=body.display_name,
        config=body.config,
        schedule=_schedule(body.schedule),
        publishing_policy=_policy(body.publishing_policy),
    )


def source_changes(body: SourceMessage, update_mask: str | None) -> SourceChanges:
    """UpdateSource body + mask → changes; masking an immutable field is INVALID_ARGUMENT."""
    mask = SOURCE_FIELDS.parse(update_mask, body)
    return SourceChanges(
        paths=frozenset(mask.paths),
        display_name=body.display_name,
        config=body.config,
        schedule=_schedule(body.schedule),
        publishing_policy=_policy(body.publishing_policy),
    )


def _schedule(message: SourceScheduleMessage | None) -> SourceSchedule | None:
    if message is None or (message.cron is None and message.time_zone is None):
        return None
    if not message.cron or not message.time_zone:
        raise InvalidArgument.for_field(
            "schedule", "schedule needs both cron and timeZone."
        )
    return SourceSchedule(cron=message.cron, time_zone=message.time_zone)


def _policy(value: str | None) -> str | None:
    if value is None:
        return None
    stored = value.lower()
    if value != value.upper() or stored not in PUBLISHING_POLICIES:
        raise InvalidArgument.for_field(
            "publishingPolicy", "publishingPolicy must be AUTO_PUBLISH or REVIEW_FIRST."
        )
    return stored


# -- Records → messages --------------------------------------------------------------


def source_message(record: SourceRecord) -> SourceMessage:
    return SourceMessage(
        name=record.name,
        connection=record.connection,
        target_collection=record.target_collection,
        external_resource=SourceExternalResourceMessage(
            type=record.resource_type,
            resource_id=record.resource_id,
            display_name=record.resource_label,
        ),
        display_name=record.display_name,
        config=dict(record.config),
        schedule=(
            SourceScheduleMessage(cron=record.schedule.cron, time_zone=record.schedule.time_zone)
            if record.schedule is not None
            else None
        ),
        publishing_policy=record.publishing_policy.upper(),
        state=record.state.upper(),
        last_sync=_summary(record.last_sync) if record.last_sync is not None else None,
        pending_document_count=record.pending_document_count,
        in_review_count=record.in_review_count,
        etag=record.etag,
        create_time=record.create_time,
        update_time=record.update_time,
    )


def _summary(record: SyncRecord) -> SourceSyncSummaryMessage:
    sync = record.sync
    return SourceSyncSummaryMessage(
        sync=record.name,
        state=sync.status.upper(),
        added_count=sync.added_count,
        updated_count=sync.updated_count,
        removed_count=sync.removed_count,
        failed_count=sync.failed_count,
        end_time=sync.finished_at,
    )


def sync_message(record: SyncRecord) -> SyncMessage:
    sync = record.sync
    return SyncMessage(
        name=record.name,
        state=sync.status.upper(),
        trigger=sync.trigger_type.upper(),
        start_time=sync.started_at,
        end_time=sync.finished_at,
        added_count=sync.added_count,
        updated_count=sync.updated_count,
        removed_count=sync.removed_count,
        failed_count=sync.failed_count,
        failures=[
            SourceSyncFailureMessage(
                resource_id=failure.get("external_id"),
                display_name=failure.get("display_name"),
                message=failure.get("message"),
            )
            for failure in sync.failures
        ],
        error=dict(sync.error) if sync.error is not None else None,
    )


__all__ = [
    "SOURCE_FIELDS",
    "SOURCE_ORDER",
    "SYNC_ORDER",
    "ListSourcesResponse",
    "ListSyncsResponse",
    "PauseSourceRequest",
    "ResumeSourceRequest",
    "SourceMessage",
    "SyncMessage",
    "source_changes",
    "source_draft",
    "source_filters",
    "source_message",
    "sync_filters",
    "sync_message",
]
