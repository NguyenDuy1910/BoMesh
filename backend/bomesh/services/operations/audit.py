"""Platform-level audit events (``audit_logs`` with no workspace): List, Get and Export.

Reading is the audit engine's (:mod:`bomesh.services.workspaces.audit_log`) and the CSV
export is Workspaces' (:mod:`bomesh.services.workspaces.exports`), both
with scope ``None`` (the platform); this service authorizes and starts the
export operation.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import ColumnElement, select

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import AuditLog, Operation
from bomesh.errors import NotFound
from bomesh.iam.authorizer import PlatformRef
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.operations import Operations, operation_name
from bomesh.services.workspaces.audit_log import AuditLogReader
from bomesh.services.workspaces.exports import export_audit_events

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

#: ``metadata.target`` of platform audit exports: the platform's audit event collection.
EXPORT_TARGET = "auditEvents"


class PlatformAuditService:
    """Platform roles only (``auditEvents.*`` on the platform)."""

    def __init__(
        self, sessions: SessionFactory, storage: Any, request_hash_secret: bytes
    ) -> None:
        self._sessions = sessions
        self._storage = storage
        self._secret = request_hash_secret

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> PlatformAuditService:
        return cls(runtime.sessions(), runtime.object_storage(), runtime.request_hash_secret())

    async def list(self, ctx: RequestContext, query: ListQuery) -> list[AuditLog]:
        await ctx.authorizer.require(ctx.principal, "auditEvents.list", PlatformRef())
        async with transaction_scope(self._sessions) as session:
            return await AuditLogReader(session).list(
                None,
                where=query.where,
                order_by=query.order_by,
                offset=query.offset,
                limit=query.limit,
            )

    async def get(self, ctx: RequestContext, event_id: UUID) -> AuditLog:
        await ctx.authorizer.require(ctx.principal, "auditEvents.get", PlatformRef())
        async with transaction_scope(self._sessions) as session:
            event = await AuditLogReader(session).get(None, event_id)
        if event is None:
            raise NotFound(f"Audit event 'auditEvents/{event_id}' does not exist.")
        return event

    async def export(
        self,
        ctx: RequestContext,
        *,
        where: ColumnElement[bool],
        filter: str,
        request_id: UUID | None,
    ) -> Operation:
        """Write the matching events as CSV; the returned operation is already done."""
        await ctx.authorizer.require(ctx.principal, "auditEvents.export", PlatformRef())
        async with transaction_scope(self._sessions) as session:
            idempotency = Idempotency(session, self._secret)
            key = (
                idempotency.key(
                    ctx.principal,
                    request_id,
                    method="ExportPlatformAuditEvents",
                    parent="",
                    request={"filter": filter},
                )
                if request_id is not None
                else None
            )
            replayed = await idempotency.replay(key) if key is not None else None
            if replayed is not None:
                return await _operation(session, UUID(replayed.removeprefix("operations/")))
            operation = await Operations(session).create(
                ctx.principal, verb="exportAuditEvents", target=EXPORT_TARGET, workspace_id=None
            )
            if key is not None:
                await idempotency.remember(key, operation_name(operation.id))
            operation_id = operation.id
        await export_audit_events(
            self._sessions,
            self._storage,
            operation_id=operation_id,
            scope=None,
            where=where,
            metadata_only=False,
        )
        async with transaction_scope(self._sessions) as session:
            return await _operation(session, operation_id)


async def _operation(session: Any, operation_id: UUID) -> Operation:
    operation = await session.scalar(select(Operation).where(Operation.id == operation_id))
    if operation is None:
        raise NotFound(f"Operation '{operation_name(operation_id)}' does not exist.")
    return operation


__all__ = ["EXPORT_TARGET", "PlatformAuditService"]
