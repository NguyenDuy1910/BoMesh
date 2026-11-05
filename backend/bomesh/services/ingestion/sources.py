"""Sources (``workspaces/{w}/sources/{s}``) and their syncs (``…/syncs/{sync}``).

A Source points one Connection at one external resource and one destination
COLLECTION. Its state is computed (``bomesh.services.ingestion.source_store``); a
sync is one ``ingestion_syncs`` row. Manual and creation syncs insert their
RUNNING row here and hand its ID to the ``SourceSyncWorkflow``; schedule
firings open their own row in the worker. Temporal calls run after the
database transaction commits.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid4

from sqlalchemy import Select, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import contains_eager

from bomesh import etag as etags
from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import (
    IngestionSource,
    IngestionSync,
    IntegrationConnection,
    Item,
    Tenant,
)
from bomesh.errors import (
    AlreadyExists,
    FailedPrecondition,
    InvalidArgument,
    NotFound,
    PermissionDenied,
    StatusCode,
)
from bomesh.iam.authorizer import WorkspaceRef
from bomesh.integrations.registry import ConnectionProviderRegistry
from bomesh.services.ingestion.common import parse_child_name, sync_name
from bomesh.services.ingestion.connection_store import (
    IntegrationConnectionService,
    connector_is_active,
)
from bomesh.services.ingestion.names import connection_name, source_name
from bomesh.services.ingestion.source_store import (
    INGESTION_PAUSED,
    SOURCE_ACTIVE,
    SOURCE_PAUSED,
    SyncCounts,
    finish_sync,
    in_review_counts,
    latest_syncs,
    pending_document_counts,
    refresh_next_sync,
    running_sync,
    source_state,
    start_sync,
    sync_refusal,
    validate_schedule,
)
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.workspaces import WorkspaceResolver, workspace_name
from bomesh.services.knowledge_items.names import item_name, parse_item
from bomesh.services.workflow import WorkflowExecutionNotFoundError
from bomesh.services.workflow.service import TemporalWorkflowService

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

log = logging.getLogger(__name__)

AUTO_PUBLISH = "auto_publish"
REVIEW_FIRST = "review_first"
PUBLISHING_POLICIES = (AUTO_PUBLISH, REVIEW_FIRST)
#: AIP-122 resource ID a client may choose with ``sourceId``.
SOURCE_ID = re.compile(r"^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$")
_MAX_DISPLAY_NAME = 255
_MAX_RESOURCE_TYPE = 64
_MAX_RESOURCE_LABEL = 255


# -- Inputs -------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ExternalResourceRef:
    type: str
    resource_id: str
    display_name: str | None = None


@dataclass(frozen=True, slots=True)
class SourceSchedule:
    cron: str
    time_zone: str


@dataclass(frozen=True, slots=True)
class SourceDraft:
    """CreateSource input; ``publishing_policy`` ``None`` takes the workspace default."""

    connection: str
    target_collection: str
    external_resource: ExternalResourceRef
    display_name: str | None = None
    config: Mapping[str, Any] | None = None
    schedule: SourceSchedule | None = None
    publishing_policy: str | None = None


@dataclass(frozen=True, slots=True)
class SourceChanges:
    """UpdateSource input: only ``paths`` change; ``None`` clears a field."""

    paths: frozenset[str]
    display_name: str | None = None
    config: Mapping[str, Any] | None = None
    schedule: SourceSchedule | None = None
    publishing_policy: str | None = None


# -- Records ------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SyncRecord:
    """One sync and the name of its source."""

    sync: IngestionSync
    workspace_id: UUID
    source_code: str

    @property
    def name(self) -> str:
        return sync_name(self.workspace_id, self.source_code, self.sync.id)


@dataclass(frozen=True, slots=True)
class SourceRecord:
    """A Source with its computed fields; ``create_time`` is ``None`` under validateOnly."""

    workspace_id: UUID
    code: str
    connection_code: str
    target_item_id: UUID
    resource_type: str | None
    resource_id: str | None
    resource_label: str | None
    display_name: str | None
    config: Mapping[str, Any]
    schedule: SourceSchedule | None
    publishing_policy: str
    state: str
    last_sync: SyncRecord | None = None
    pending_document_count: int = 0
    in_review_count: int = 0
    create_time: datetime | None = None
    update_time: datetime | None = None

    @property
    def name(self) -> str:
        return source_name(self.workspace_id, self.code)

    @property
    def connection(self) -> str:
        return connection_name(self.workspace_id, self.connection_code)

    @property
    def target_collection(self) -> str:
        return item_name(self.workspace_id, self.target_item_id)

    @property
    def etag(self) -> str | None:
        return etags.compute(self.name, self.update_time) if self.update_time else None


@dataclass(frozen=True, slots=True)
class _Resolved:
    """CreateSource references after authorization."""

    connection: IntegrationConnection
    target: Item
    policy: str
    config: dict[str, Any] = field(default_factory=dict)


# -- Service ------------------------------------------------------------------------


class SourceService:
    """Create, read, update, delete, pause and resume Sources, and sync them."""

    def __init__(
        self,
        sessions: SessionFactory,
        *,
        workflows: TemporalWorkflowService,
        providers: ConnectionProviderRegistry,
        credential_encryption_key: str | None,
        request_hash_secret: bytes,
        processing_version: Any,
    ) -> None:
        self._sessions = sessions
        self._resolver = WorkspaceResolver(sessions)
        self._workflows = workflows
        self._providers = providers
        self._credential_encryption_key = credential_encryption_key
        self._request_hash_secret = request_hash_secret
        #: ``() -> str``: the processing version a ready Document must match.
        self._processing_version = processing_version

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> SourceService:
        return cls(
            runtime.sessions(),
            workflows=runtime.workflow_service(),
            providers=runtime.connection_providers(),
            credential_encryption_key=runtime.config.integration.credential_encryption_key,
            request_hash_secret=runtime.request_hash_secret(),
            processing_version=runtime.processing_version,
        )

    # -- Sources ----------------------------------------------------------------

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        draft: SourceDraft,
        *,
        source_id: str | None = None,
        request_id: UUID | None = None,
        validate_only: bool = False,
    ) -> SourceRecord:
        """CreateSource: authorize the references, insert, then start the CREATION sync."""
        workspace = await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "sources.create", write=True
        )
        code = _source_code(source_id)
        _validate_draft(draft)
        resolved = await self._resolve(ctx, workspace, draft)
        parent = workspace_name(workspace_id)
        async with transaction_scope(self._sessions) as session:
            idempotency = Idempotency(session, self._request_hash_secret)
            key = (
                idempotency.key(
                    ctx.principal,
                    request_id,
                    method="CreateSource",
                    parent=parent,
                    request=_draft_fingerprint(draft, source_id),
                )
                if request_id is not None and not validate_only
                else None
            )
            replayed = await idempotency.replay(key) if key is not None else None
            if replayed is None:
                await _require_unique(session, workspace_id, code)
                source = _new_source(ctx, workspace_id, code, draft, resolved)
                if validate_only:
                    return _draft_record(source, resolved.connection, draft)
                sync_id = await self._insert(session, ctx, source, workspace)
                if key is not None:
                    await idempotency.remember(key, source_name(workspace_id, code))
        if replayed is not None:
            replayed_record = await self.get(ctx, workspace_id, replayed.rsplit("/", 1)[-1])
            if replayed_record.schedule is not None:
                # The first attempt may have committed without reaching Temporal.
                await self._ensure_schedule_by_code(workspace_id, replayed_record.code)
            return replayed_record
        if draft.schedule is not None:
            await self._apply_schedule(source.id, workspace_id)
        if sync_id is not None:
            await self._start(source.id, workspace_id, sync_id)
        return await self.get(ctx, workspace_id, code)

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, query: ListQuery
    ) -> tuple[list[SourceRecord], int]:
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "sources.list", write=False)
        async with transaction_scope(self._sessions) as session:
            statement = _sources(workspace_id)
            total = await session.scalar(query.count(statement))
            sources = list((await session.scalars(query.apply(statement))).unique())
            records = await self._records(session, workspace_id, sources)
        return records, int(total or 0)

    async def get(self, ctx: RequestContext, workspace_id: UUID, code: str) -> SourceRecord:
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "sources.get", write=False)
        async with transaction_scope(self._sessions) as session:
            source = await _source(session, workspace_id, code)
            return (await self._records(session, workspace_id, [source]))[0]

    async def update(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        changes: SourceChanges,
        *,
        etag: str | None = None,
    ) -> SourceRecord:
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "sources.update", write=True)
        _validate_changes(changes)
        async with transaction_scope(self._sessions) as session:
            source = await _source(session, workspace_id, code, for_update=True)
            etags.check(etag, etags.compute(source_name(workspace_id, code), source.updated_at))
            workspace = await session.get(Tenant, workspace_id)
            assert workspace is not None
            if "publishingPolicy" in changes.paths:
                policy = _policy(changes.publishing_policy, workspace)
                if policy == AUTO_PUBLISH:
                    await _require_collection(ctx, source.target_item_id, "items.publish")
                source.publishing_policy = policy
            if "displayName" in changes.paths:
                source.display_name = changes.display_name
            if "config" in changes.paths:
                source.config = await self._config(
                    session,
                    source.integration_connection,
                    source.resource_type,
                    source.external_resource_id,
                    changes.config,
                )
                # A replaced config is a new scope: the next sync lists everything.
                source.sync_checkpoint = None
            if "schedule" in changes.paths:
                schedule = changes.schedule
                source.schedule_cron = schedule.cron if schedule else None
                source.schedule_time_zone = schedule.time_zone if schedule else None
                refresh_next_sync(source, now=datetime.now(UTC))
            source.updated_at = await session.scalar(select(func.now()))
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="sources",
                action="UpdateSource",
                target=source_name(workspace_id, code),
            )
            source_id = source.id
        if "schedule" in changes.paths:
            await self._apply_schedule(source_id, workspace_id)
        return await self.get(ctx, workspace_id, code)

    async def delete(
        self, ctx: RequestContext, workspace_id: UUID, code: str, *, etag: str | None = None
    ) -> None:
        """DeleteSource: tombstone the row (items it registered remain) and drop its schedule."""
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "sources.delete", write=True)
        async with transaction_scope(self._sessions) as session:
            source = await _source(session, workspace_id, code, for_update=True)
            etags.check(etag, etags.compute(source_name(workspace_id, code), source.updated_at))
            source.deleted_at = datetime.now(UTC)
            source.next_sync_at = None
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="sources",
                action="DeleteSource",
                target=source_name(workspace_id, code),
            )
            source_id = source.id
        await self._workflows.delete_schedule(source_id)

    async def pause(
        self, ctx: RequestContext, workspace_id: UUID, code: str, *, etag: str | None = None
    ) -> SourceRecord:
        """PauseSource: ACTIVE → PAUSED; its schedule stops firing."""
        return await self._transition(ctx, workspace_id, code, etag=etag, pause=True)

    async def resume(
        self, ctx: RequestContext, workspace_id: UUID, code: str, *, etag: str | None = None
    ) -> SourceRecord:
        """ResumeSource: PAUSED → ACTIVE (not while the connection needs reauthorization)."""
        return await self._transition(ctx, workspace_id, code, etag=etag, pause=False)

    # -- Syncs ------------------------------------------------------------------

    async def create_sync(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        *,
        request_id: UUID | None = None,
    ) -> SyncRecord:
        """CreateSync: a MANUAL sync now; FAILED_PRECONDITION while one runs or it cannot run."""
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "syncs.create", write=True)
        name = source_name(workspace_id, code)
        async with transaction_scope(self._sessions) as session:
            source = await _source(session, workspace_id, code)
            source_id = source.id
        sync_open = await self._workflows.source_sync_is_open(source_id)
        async with transaction_scope(self._sessions) as session:
            idempotency = Idempotency(session, self._request_hash_secret)
            key = (
                idempotency.key(
                    ctx.principal, request_id, method="CreateSync", parent=name, request={}
                )
                if request_id is not None
                else None
            )
            replayed = await idempotency.replay(key) if key is not None else None
            if replayed is None:
                source = await _source(session, workspace_id, code, for_update=True)
                refusal = await sync_refusal(session, source)
                if refusal is not None:
                    raise FailedPrecondition(refusal)
                if sync_open or await running_sync(session, source.id) is not None:
                    raise FailedPrecondition("A sync of this source is already running.")
                sync = await start_sync(
                    session, source, trigger="manual", created_by_user_id=ctx.principal.user_id
                )
                created = SyncRecord(sync, workspace_id, code)
                await Audit(session).record(
                    ctx,
                    workspace_id=workspace_id,
                    category="sources",
                    action="CreateSync",
                    target=created.name,
                )
                if key is not None:
                    await idempotency.remember(key, created.name)
        if replayed is not None:
            return await self.get_sync(
                ctx, workspace_id, code, UUID(replayed.rsplit("/", 1)[-1])
            )
        await self._start(source_id, workspace_id, created.sync.id)
        return await self.get_sync(ctx, workspace_id, code, created.sync.id)

    async def list_syncs(
        self, ctx: RequestContext, workspace_id: UUID, code: str | None, query: ListQuery
    ) -> tuple[list[SyncRecord], int]:
        """ListSyncs of one source, or of every live source with ``code`` ``None`` (``sources/-``)."""
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "syncs.list", write=False)
        async with transaction_scope(self._sessions) as session:
            statement = _syncs(workspace_id)
            if code is not None:
                source = await _source(session, workspace_id, code)
                statement = statement.where(IngestionSync.ingestion_source_id == source.id)
            total = await session.scalar(query.count(statement))
            rows = (await session.execute(query.apply(statement))).all()
        return [SyncRecord(sync, workspace_id, source_code) for sync, source_code in rows], int(
            total or 0
        )

    async def get_sync(
        self, ctx: RequestContext, workspace_id: UUID, code: str, sync_id: UUID
    ) -> SyncRecord:
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "syncs.get", write=False)
        async with transaction_scope(self._sessions) as session:
            source = await _source(session, workspace_id, code)
            sync = await session.scalar(
                select(IngestionSync).where(
                    IngestionSync.id == sync_id, IngestionSync.ingestion_source_id == source.id
                )
            )
        if sync is None:
            raise NotFound(f"Sync '{sync_name(workspace_id, code, sync_id)}' does not exist.")
        return SyncRecord(sync, workspace_id, code)

    # -- Internals --------------------------------------------------------------

    async def _resolve(
        self, ctx: RequestContext, workspace: Tenant, draft: SourceDraft
    ) -> _Resolved:
        """Authorize the connection and target collection (unreadable → 403), then check them."""
        workspace_id = workspace.id
        connection_code = parse_child_name(
            draft.connection, workspace_id=workspace_id, collection="connections", field="connection"
        )
        target_id = parse_item(draft.target_collection, workspace_id, field="targetCollection")
        policy = _policy(draft.publishing_policy, workspace)
        async with transaction_scope(self._sessions) as session:
            connection = await session.scalar(
                select(IntegrationConnection).where(
                    IntegrationConnection.tenant_id == workspace_id,
                    IntegrationConnection.code == connection_code,
                    IntegrationConnection.deleted_at.is_(None),
                )
            )
            if connection is None or (
                connection.owner_user_id is not None
                and connection.owner_user_id != ctx.principal.user_id
            ):
                raise PermissionDenied(
                    f"Connection '{draft.connection}' cannot be used by the caller "
                    "(or it might not exist)."
                )
            await _require_collection(ctx, target_id, "items.create")
            if policy == AUTO_PUBLISH:
                await _require_collection(ctx, target_id, "items.publish")
            target = await session.get(Item, target_id)
            assert target is not None
            if target.item_type != "collection":
                raise InvalidArgument.for_field(
                    "targetCollection", "targetCollection must be a COLLECTION item."
                )
            if connection.status != "active":
                raise FailedPrecondition("The connection is not ACTIVE.")
            if not await connector_is_active(session, connection.connector_key):
                raise FailedPrecondition("The connector of this connection is disabled.")
            config = await self._config(
                session,
                connection,
                draft.external_resource.type,
                draft.external_resource.resource_id,
                draft.config,
            )
        return _Resolved(connection=connection, target=target, policy=policy, config=config)

    async def _config(
        self,
        session: AsyncSession,
        connection: IntegrationConnection,
        resource_type: str | None,
        resource_id: str | None,
        config: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        """The connector config: what the selected resource implies, overlaid by ``config``."""
        connections = IntegrationConnectionService(
            session,
            providers=self._providers,
            credential_encryption_key=self._credential_encryption_key,
        )
        implied: dict[str, Any] = {}
        if resource_type is not None and resource_id is not None:
            try:
                implied = await connections.resource_source_config(
                    connection, resource_type=resource_type, external_resource_id=resource_id
                )
            except ValueError as exc:
                raise InvalidArgument.for_field("externalResource.type", str(exc)) from None
        return IntegrationConnectionService.non_secret_config({**implied, **dict(config or {})})

    async def _insert(
        self, session: AsyncSession, ctx: RequestContext, source: IngestionSource, workspace: Tenant
    ) -> UUID | None:
        """Insert the source and its RUNNING CREATION sync (none while ingestion is paused)."""
        session.add(source)
        try:
            await session.flush()
        except IntegrityError:
            raise AlreadyExists(
                f"Source '{source_name(workspace.id, source.code)}' or one syncing the same "
                "external resource already exists."
            ) from None
        refresh_next_sync(source, now=datetime.now(UTC))
        await Audit(session).record(
            ctx,
            workspace_id=workspace.id,
            category="sources",
            action="CreateSource",
            target=source_name(workspace.id, source.code),
        )
        if workspace.ingestion_paused_at is not None:
            return None
        sync = await start_sync(
            session, source, trigger="creation", created_by_user_id=ctx.principal.user_id
        )
        return sync.id

    async def _transition(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        *,
        etag: str | None,
        pause: bool,
    ) -> SourceRecord:
        action = "PauseSource" if pause else "ResumeSource"
        permission = "sources.pause" if pause else "sources.resume"
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), permission, write=True)
        name = source_name(workspace_id, code)
        async with transaction_scope(self._sessions) as session:
            source = await _source(session, workspace_id, code, for_update=True)
            etags.check(etag, etags.compute(name, source.updated_at))
            latest = (await latest_syncs(session, [source.id])).get(source.id)
            state = source_state(source, source.integration_connection, latest)
            if pause and state != SOURCE_ACTIVE:
                raise FailedPrecondition(f"Only an ACTIVE source can be paused; it is {state.upper()}.")
            if not pause and state != SOURCE_PAUSED:
                raise FailedPrecondition(f"Only a PAUSED source can be resumed; it is {state.upper()}.")
            if not pause and (
                source.integration_connection.status != "active"
            ):
                raise FailedPrecondition(
                    "Reconnect the account behind this source before resuming it."
                )
            source.paused_at = datetime.now(UTC) if pause else None
            refresh_next_sync(source, now=datetime.now(UTC))
            await Audit(session).record(
                ctx, workspace_id=workspace_id, category="sources", action=action, target=name
            )
            source_id = source.id
            scheduled = source.schedule_cron is not None
        if scheduled:
            try:
                if pause:
                    await self._workflows.pause_schedule(source_id)
                else:
                    await self._workflows.resume_schedule(source_id)
            except WorkflowExecutionNotFoundError:
                await self._apply_schedule(source_id, workspace_id)
        return await self.get(ctx, workspace_id, code)

    async def _apply_schedule(self, source_id: UUID, workspace_id: UUID) -> None:
        """Make the Temporal schedule match the row: create/replace, or delete when unscheduled."""
        async with transaction_scope(self._sessions) as session:
            source = await session.get(IngestionSource, source_id)
            assert source is not None
            cron, time_zone = source.schedule_cron, source.schedule_time_zone
            enabled = source.paused_at is None and source.deleted_at is None
        if cron is None or time_zone is None:
            await self._workflows.delete_schedule(source_id)
            return
        await self._workflows.upsert_schedule(
            source_id,
            workspace_id,
            {"cron_expression": cron, "timezone": time_zone, "enabled": enabled},
        )

    async def _ensure_schedule_by_code(self, workspace_id: UUID, code: str) -> None:
        async with transaction_scope(self._sessions) as session:
            source = await _source(session, workspace_id, code)
            source_id = source.id
        await self._apply_schedule(source_id, workspace_id)

    async def _start(self, source_id: UUID, workspace_id: UUID, sync_id: UUID) -> None:
        """Start the workflow of a RUNNING sync row; a start that fails ends the row FAILED."""
        try:
            started = await self._workflows.start_source_sync(
                source_id, workspace_id, sync_id=sync_id
            )
            error = (
                None
                if started
                else {
                    "code": int(StatusCode.ABORTED),
                    "message": "A sync of this source was already running.",
                }
            )
        except Exception:
            log.exception("could not start the sync of source %s", source_id)
            error = {
                "code": int(StatusCode.UNAVAILABLE),
                "message": "The sync could not be started. Try again later.",
            }
        if error is not None:
            async with transaction_scope(self._sessions) as session:
                await finish_sync(session, sync_id, counts=SyncCounts(), error=error)

    async def _records(
        self, session: AsyncSession, workspace_id: UUID, sources: Sequence[IngestionSource]
    ) -> list[SourceRecord]:
        ids = [source.id for source in sources]
        latest = await latest_syncs(session, ids)
        pending = await pending_document_counts(
            session, ids, processing_version=self._processing_version()
        )
        in_review = await in_review_counts(session, ids)
        return [
            _record(
                source,
                latest.get(source.id),
                pending=pending.get(source.id, 0),
                in_review=in_review.get(source.id, 0),
            )
            for source in sources
        ]


# -- Queries ------------------------------------------------------------------------


def _sources(workspace_id: UUID) -> Select[tuple[IngestionSource]]:
    """Live sources with their connection (joined for filters, ordering and state)."""
    return (
        select(IngestionSource)
        .join(
            IntegrationConnection,
            IntegrationConnection.id == IngestionSource.integration_connection_id,
        )
        .options(contains_eager(IngestionSource.integration_connection))
        .where(IngestionSource.tenant_id == workspace_id, IngestionSource.deleted_at.is_(None))
    )


def _syncs(workspace_id: UUID) -> Select[tuple[IngestionSync, str]]:
    """Syncs of the workspace's live sources, with the source ID for canonical names."""
    return (
        select(IngestionSync, IngestionSource.code)
        .join(IngestionSource, IngestionSource.id == IngestionSync.ingestion_source_id)
        .where(IngestionSource.tenant_id == workspace_id, IngestionSource.deleted_at.is_(None))
    )


async def _source(
    session: AsyncSession, workspace_id: UUID, code: str, *, for_update: bool = False
) -> IngestionSource:
    statement = _sources(workspace_id).where(IngestionSource.code == code)
    if for_update:
        statement = statement.with_for_update(of=IngestionSource)
    source = await session.scalar(statement)
    if source is None:
        raise NotFound(f"Source '{source_name(workspace_id, code)}' does not exist.")
    return source


async def _require_unique(session: AsyncSession, workspace_id: UUID, code: str) -> None:
    taken = await session.scalar(
        select(IngestionSource.id).where(
            IngestionSource.tenant_id == workspace_id, IngestionSource.code == code
        )
    )
    if taken is not None:
        raise AlreadyExists(f"Source '{source_name(workspace_id, code)}' already exists.")


async def _require_collection(ctx: RequestContext, item_id: UUID, permission: str) -> None:
    """``permission`` on the collection; an unreadable or absent one is PERMISSION_DENIED."""
    held = await ctx.authorizer.collection_permissions(ctx.principal, item_id)
    if permission not in held:
        raise PermissionDenied(
            f"Permission '{permission}' denied on resource "
            f"'targetCollection' (or it might not exist)."
        )


# -- Mapping and validation ---------------------------------------------------------


def _record(
    source: IngestionSource, latest: IngestionSync | None, *, pending: int, in_review: int
) -> SourceRecord:
    connection = source.integration_connection
    return SourceRecord(
        workspace_id=source.tenant_id,
        code=source.code,
        connection_code=connection.code,
        target_item_id=source.target_item_id,
        resource_type=source.resource_type,
        resource_id=source.external_resource_id,
        resource_label=source.external_resource_label,
        display_name=source.display_name,
        config=dict(source.config),
        schedule=(
            SourceSchedule(source.schedule_cron, source.schedule_time_zone)
            if source.schedule_cron is not None and source.schedule_time_zone is not None
            else None
        ),
        publishing_policy=source.publishing_policy,
        state=source_state(source, connection, latest),
        last_sync=SyncRecord(latest, source.tenant_id, source.code) if latest else None,
        pending_document_count=pending,
        in_review_count=in_review,
        create_time=source.created_at,
        update_time=source.updated_at,
    )


def _draft_record(
    source: IngestionSource, connection: IntegrationConnection, draft: SourceDraft
) -> SourceRecord:
    """What CreateSource would return (validateOnly): nothing stored, no sync yet."""
    return SourceRecord(
        workspace_id=source.tenant_id,
        code=source.code,
        connection_code=connection.code,
        target_item_id=source.target_item_id,
        resource_type=source.resource_type,
        resource_id=source.external_resource_id,
        resource_label=source.external_resource_label,
        display_name=source.display_name,
        config=dict(source.config),
        schedule=draft.schedule,
        publishing_policy=source.publishing_policy,
        state=SOURCE_ACTIVE,
    )


def _new_source(
    ctx: RequestContext,
    workspace_id: UUID,
    code: str,
    draft: SourceDraft,
    resolved: _Resolved,
) -> IngestionSource:
    resource = draft.external_resource
    return IngestionSource(
        id=uuid4(),
        tenant_id=workspace_id,
        code=code,
        integration_connection_id=resolved.connection.id,
        target_item_id=resolved.target.id,
        display_name=draft.display_name,
        resource_type=resource.type,
        external_resource_id=resource.resource_id,
        external_resource_label=resource.display_name,
        config=resolved.config,
        schedule_cron=draft.schedule.cron if draft.schedule else None,
        schedule_time_zone=draft.schedule.time_zone if draft.schedule else None,
        publishing_policy=resolved.policy,
        created_by_user_id=ctx.principal.user_id,
    )


def _source_code(source_id: str | None) -> str:
    if source_id is None:
        return str(uuid4())
    if not SOURCE_ID.match(source_id):
        raise InvalidArgument.for_field(
            "sourceId", "sourceId must match ^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$."
        )
    return source_id


def _policy(value: str | None, workspace: Tenant) -> str:
    """The stored policy: the given one, else the workspace default, else AUTO_PUBLISH."""
    if value is None:
        default = workspace.settings.get("default_publishing_policy")
        return default if default in PUBLISHING_POLICIES else AUTO_PUBLISH
    if value not in PUBLISHING_POLICIES:
        raise InvalidArgument.for_field(
            "publishingPolicy", "publishingPolicy must be AUTO_PUBLISH or REVIEW_FIRST."
        )
    return value


def _validate_draft(draft: SourceDraft) -> None:
    resource = draft.external_resource
    if not resource.type.strip() or len(resource.type) > _MAX_RESOURCE_TYPE:
        raise InvalidArgument.for_field(
            "externalResource.type", "externalResource.type is required (at most 64 characters)."
        )
    if not resource.resource_id.strip():
        raise InvalidArgument.for_field(
            "externalResource.resourceId", "externalResource.resourceId is required."
        )
    if resource.display_name is not None and len(resource.display_name) > _MAX_RESOURCE_LABEL:
        raise InvalidArgument.for_field(
            "externalResource.displayName", "displayName is at most 255 characters."
        )
    _validate_display_name(draft.display_name)
    if draft.schedule is not None:
        validate_schedule(draft.schedule.cron, draft.schedule.time_zone)


def _validate_changes(changes: SourceChanges) -> None:
    if "displayName" in changes.paths:
        _validate_display_name(changes.display_name)
    if "schedule" in changes.paths and changes.schedule is not None:
        validate_schedule(changes.schedule.cron, changes.schedule.time_zone)


def _validate_display_name(value: str | None) -> None:
    if value is not None and len(value) > _MAX_DISPLAY_NAME:
        raise InvalidArgument.for_field("displayName", "displayName is at most 255 characters.")


def _draft_fingerprint(draft: SourceDraft, source_id: str | None) -> dict[str, Any]:
    resource = draft.external_resource
    return {
        "sourceId": source_id,
        "connection": draft.connection,
        "targetCollection": draft.target_collection,
        "externalResource": [resource.type, resource.resource_id, resource.display_name],
        "displayName": draft.display_name,
        "config": dict(draft.config or {}),
        "schedule": [draft.schedule.cron, draft.schedule.time_zone] if draft.schedule else None,
        "publishingPolicy": draft.publishing_policy,
    }


__all__ = [
    "AUTO_PUBLISH",
    "INGESTION_PAUSED",
    "PUBLISHING_POLICIES",
    "REVIEW_FIRST",
    "ExternalResourceRef",
    "SourceChanges",
    "SourceDraft",
    "SourceRecord",
    "SourceSchedule",
    "SourceService",
    "SyncRecord",
]
