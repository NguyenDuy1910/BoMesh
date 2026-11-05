"""Get, List and Cancel the caller's own long-running operations (AIP-151)."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Operation
from bomesh.errors import (
    Cancelled,
    FailedPrecondition,
    NotFound,
    PermissionDenied,
    Unavailable,
)
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.operations import (
    OPERATION_HANDLERS,
    OPERATION_TYPES,
    OperationHandlers,
    Operations,
    operation_name,
)

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

log = logging.getLogger(__name__)

#: Longest lifetime of a signed export download URI (the storage maximum).
MAX_DOWNLOAD_SECONDS = 604_800
OPERATION_NOT_CANCELLABLE = "OPERATION_NOT_CANCELLABLE"


@dataclass(frozen=True, slots=True)
class ExportResult:
    """``WorkspaceExportResponse``: no ``download_uri`` once the CSV has expired."""

    download_uri: str | None
    expire_time: datetime | None


@dataclass(frozen=True, slots=True)
class OperationView:
    """An operation with its message types and rendered response.

    ``response`` is an :class:`ExportResult` for exports, the record the
    verb's result loader returned for resource results, and ``None`` until
    the operation succeeds.
    """

    operation: Operation
    metadata_type: str
    response_type: str
    response: ExportResult | Any

    @property
    def name(self) -> str:
        return operation_name(self.operation.id)


class OperationService:
    """Own-only reads and cancellation of ``operations`` rows."""

    def __init__(
        self,
        runtime: AppRuntime,
        *,
        handlers: OperationHandlers = OPERATION_HANDLERS,
    ) -> None:
        self._runtime = runtime
        self._sessions: SessionFactory = runtime.sessions()
        self._handlers = handlers

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> OperationService:
        return cls(runtime)

    async def get(self, ctx: RequestContext, operation_id: UUID) -> OperationView:
        async with transaction_scope(self._sessions) as session:
            operation = await _owned(session, ctx, operation_id)
        return await self.describe(operation)

    async def list(self, ctx: RequestContext, query: ListQuery) -> list[OperationView]:
        """The caller's unexpired operations, filtered, ordered and windowed by ``query``."""
        async with transaction_scope(self._sessions) as session:
            rows = (
                await session.scalars(
                    query.apply(
                        select(Operation).where(
                            Operation.user_id == ctx.principal.user_id,
                            Operation.expires_at > datetime.now(UTC),
                        )
                    )
                )
            ).all()
        return [await self.describe(row) for row in rows]

    async def cancel(self, ctx: RequestContext, operation_id: UUID) -> None:
        """End the operation with CANCELLED, then signal its work through the verb's hook."""
        async with transaction_scope(self._sessions) as session:
            operation = await _owned(session, ctx, operation_id, for_update=True)
            if operation.finished_at is not None:
                raise FailedPrecondition("The operation has already finished.")
            hook = self._handlers.cancel_hook(operation.verb)
            if hook is None:
                raise FailedPrecondition(
                    f"Operations of kind '{operation.verb}' cannot be cancelled.",
                    reason=OPERATION_NOT_CANCELLABLE,
                )
            operation.cancel_requested_at = datetime.now(UTC)
            await Operations(session).fail(
                operation.id, Cancelled("The operation was cancelled.")
            )
        try:
            await hook(self._runtime, operation)
        except Exception:  # noqa: BLE001 - best effort: the operation is already cancelled
            log.warning("cancel hook for %s failed", operation_name(operation.id), exc_info=True)

    async def describe(self, operation: Operation) -> OperationView:
        """Render ``operation`` for its owner; other interfaces return this from their methods."""
        types = OPERATION_TYPES[operation.verb]
        return OperationView(
            operation=operation,
            metadata_type=types.metadata,
            response_type=types.response,
            response=await self._response(operation),
        )

    async def _response(self, operation: Operation) -> ExportResult | Any:
        if operation.finished_at is None or operation.error is not None:
            return None
        if operation.result_object_key is not None:
            return self._export_result(operation.result_object_key, operation.result_expires_at)
        if operation.result_name is None:
            return None
        loader = self._handlers.result_loader(operation.verb)
        if loader is None:
            raise RuntimeError(f"no result loader is registered for '{operation.verb}'")
        return await loader(self._runtime, operation.result_name)

    def _export_result(self, object_key: str, expires_at: datetime | None) -> ExportResult:
        remaining = (
            MAX_DOWNLOAD_SECONDS
            if expires_at is None
            else int((expires_at - datetime.now(UTC)).total_seconds())
        )
        if remaining < 1:
            return ExportResult(download_uri=None, expire_time=expires_at)
        signed = self._runtime.object_storage().presign_download(
            object_key, expires_seconds=min(remaining, MAX_DOWNLOAD_SECONDS)
        )
        return ExportResult(download_uri=signed.url, expire_time=expires_at)


async def reconcile_abandoned_operations(
    runtime: AppRuntime,
    *,
    started_before: datetime,
    handlers: OperationHandlers = OPERATION_HANDLERS,
) -> int:
    """Fail every operation left unfinished by a process that is gone; return how many.

    Operations carry no lease or heartbeat, so liveness is decided by start
    time: at startup of a single-replica deployment every unfinished
    operation started before this process (``started_before``) has lost its
    worker. Each one ends with UNAVAILABLE, then its verb's abandon hook
    repairs the owning resource; a failing hook is logged and does not stop
    the others.
    """
    async with transaction_scope(runtime.sessions()) as session:
        abandoned = (
            await session.scalars(
                select(Operation)
                .where(Operation.finished_at.is_(None), Operation.created_at < started_before)
                .order_by(Operation.created_at, Operation.id)
                .with_for_update(skip_locked=True)
            )
        ).all()
        operations = Operations(session)
        for operation in abandoned:
            await operations.fail(
                operation.id,
                Unavailable("The operation was interrupted by a service restart; start it again."),
            )
    for operation in abandoned:
        hook = handlers.abandon_hook(operation.verb)
        if hook is None:
            continue
        try:
            await hook(runtime, operation)
        except Exception:  # noqa: BLE001 - one broken repair must not block the rest
            log.warning(
                "abandon hook for %s failed", operation_name(operation.id), exc_info=True
            )
    return len(abandoned)


async def _owned(
    session: AsyncSession,
    ctx: RequestContext,
    operation_id: UUID,
    *,
    for_update: bool = False,
) -> Operation:
    """The caller's operation: absent or expired → NOT_FOUND, someone else's → PERMISSION_DENIED."""
    statement = select(Operation).where(Operation.id == operation_id)
    if for_update:
        statement = statement.with_for_update()
    operation = await session.scalar(statement)
    name = operation_name(operation_id)
    if operation is None or operation.expires_at <= datetime.now(UTC):
        raise NotFound(f"Operation '{name}' does not exist.")
    if operation.user_id != ctx.principal.user_id:
        raise PermissionDenied(f"Operation '{name}' was started by another user.")
    return operation


__all__ = [
    "MAX_DOWNLOAD_SECONDS",
    "OPERATION_NOT_CANCELLABLE",
    "ExportResult",
    "OperationService",
    "OperationView",
    "reconcile_abandoned_operations",
]
