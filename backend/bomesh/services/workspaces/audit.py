"""Workspace audit events: List, Get, ``:export`` (LRO) and ``:summarize``.

``workspaces/-`` reads across workspaces need the platform permission and
are metadata only. A caller reading one workspace without the permission
there (only through a platform role) also gets metadata only.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import ColumnElement

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import AuditLog, Operation
from bomesh.errors import NotFound
from bomesh.iam.authorizer import PlatformRef, WorkspaceRef
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.operations import Operations
from bomesh.services.kernel.workspaces import WorkspaceResolver, workspace_name
from bomesh.services.workspaces.audit_log import (
    ALL_WORKSPACES,
    AuditLogReader,
    AuditScope,
)
from bomesh.services.workspaces.exports import export_audit_events
from bomesh.services.workspaces.records import AuditBucket
from bomesh.services.workspaces.support import own_operation, time_zone, window_start
from bomesh.storage import DocumentStorage

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

#: ``workspaces/-`` (AIP-159).
WILDCARD = "-"


@dataclass(frozen=True, slots=True)
class AuditEvents:
    """Events plus whether the caller may see their target and description."""

    events: list[AuditLog]
    metadata_only: bool


class AuditEventService:
    def __init__(
        self, sessions: SessionFactory, storage: DocumentStorage, request_hash_secret: bytes
    ) -> None:
        self._sessions = sessions
        self._storage = storage
        self._secret = request_hash_secret
        self._resolver = WorkspaceResolver(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> AuditEventService:
        return cls(runtime.sessions(), runtime.object_storage(), runtime.request_hash_secret())

    async def list(
        self, ctx: RequestContext, workspace: UUID | str, query: ListQuery
    ) -> AuditEvents:
        """``workspace`` is an ID or ``-``."""
        scope, metadata_only = await self._open(ctx, workspace, "auditEvents.list")
        async with transaction_scope(self._sessions) as session:
            events = await AuditLogReader(session).list(
                scope,
                where=query.where,
                order_by=query.order_by,
                offset=query.offset,
                limit=query.limit,
            )
        return AuditEvents(events, metadata_only)

    async def get(self, ctx: RequestContext, workspace_id: UUID, event_id: UUID) -> AuditEvents:
        scope, metadata_only = await self._open(ctx, workspace_id, "auditEvents.get")
        async with transaction_scope(self._sessions) as session:
            event = await AuditLogReader(session).get(scope, event_id)
        if event is None:
            raise NotFound(
                f"Resource '{workspace_name(workspace_id)}/auditEvents/{event_id}' was not found."
            )
        return AuditEvents([event], metadata_only)

    async def summarize(
        self,
        ctx: RequestContext,
        workspace: UUID | str,
        *,
        where: ColumnElement[bool],
        window: str | None,
        zone: str | None,
    ) -> list[AuditBucket]:
        scope, _ = await self._open(ctx, workspace, "auditEvents.summarize")
        zone_name = time_zone(zone)
        since = window_start(window)
        async with transaction_scope(self._sessions) as session:
            rows = await AuditLogReader(session).summarize(
                scope, where=where, since=since, time_zone=zone_name
            )
        return [AuditBucket(start, category, count) for start, category, count in rows]

    async def export(
        self,
        ctx: RequestContext,
        workspace: UUID | str,
        *,
        where: ColumnElement[bool],
        filter_text: str,
        request_id: UUID | None,
    ) -> Operation:
        """Write the matching events as CSV; the returned operation is done."""
        scope, metadata_only = await self._open(ctx, workspace, "auditEvents.export")
        parent = f"workspaces/{workspace}"
        async with transaction_scope(self._sessions) as session:
            idempotency = Idempotency(session, self._secret)
            key = None
            if request_id is not None:
                key = idempotency.key(
                    ctx.principal,
                    request_id,
                    method="ExportAuditEvents",
                    parent=parent,
                    request={"filter": filter_text},
                )
                if (replayed := await idempotency.replay(key)) is not None:
                    return await own_operation(session, ctx.user_id, replayed)
            operation = await Operations(session).create(
                ctx.principal,
                verb="exportAuditEvents",
                target=f"{parent}/auditEvents",
                workspace_id=None if scope == ALL_WORKSPACES else scope,
            )
            await Audit(session).record(
                ctx,
                workspace_id=None if scope == ALL_WORKSPACES else scope,
                category="settings",
                action="ExportAuditEvents",
                target=f"{parent}/auditEvents",
                resource_type="auditEvent",
            )
            if key is not None:
                await idempotency.remember(key, f"operations/{operation.id}")
        await export_audit_events(
            self._sessions,
            self._storage,
            operation_id=operation.id,
            scope=scope,
            where=where,
            metadata_only=metadata_only,
        )
        async with transaction_scope(self._sessions) as session:
            return await own_operation(session, ctx.user_id, f"operations/{operation.id}")

    async def _open(
        self, ctx: RequestContext, workspace: UUID | str, permission: str
    ) -> tuple[AuditScope, bool]:
        """The scope to read and whether the read is metadata only."""
        if workspace == WILDCARD:
            await ctx.authorizer.require(
                ctx.principal, permission, PlatformRef("workspaces/-/auditEvents")
            )
            return ALL_WORKSPACES, True
        assert isinstance(workspace, UUID)
        held = await ctx.authorizer.workspace_permissions(ctx.principal, workspace)
        if permission in held:
            await self._resolver.open(ctx, WorkspaceRef(workspace), permission, write=False)
            return workspace, False
        await ctx.authorizer.require(ctx.principal, permission, WorkspaceRef(workspace))
        return workspace, True


__all__ = ["WILDCARD", "AuditEventService", "AuditEvents"]
