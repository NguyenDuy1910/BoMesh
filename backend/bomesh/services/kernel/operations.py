"""Long-running operations (AIP-151): create, progress, complete and fail ``operations`` rows.

The method permission is checked on ``target`` (the resource name the
operation acts on) by the starting service; reads are own-only and served by
the Operations interface, which renders ``response`` from
``result_name``/``result_object_key`` with the ``@type`` named in
:data:`OPERATION_TYPES` (``x-operation-info`` of ``openapi.yaml``). The
Temporal workflow ID, if any, is derived from the operation ID.

The interface owning a verb registers its hooks in :data:`OPERATION_HANDLERS`
from the module that defines them (``artifacts.artifacts``,
``workspaces.workspaces``), so they exist whenever that module is imported:

- **result loader** (verbs whose result is a resource, ``result_name``):
  ``async (runtime, result_name) -> record``. The HTTP layer maps the record
  to the ``@type`` message (``api.dto.operations.register_response_message``).
  Exports need none.
- **cancel hook**: ``async (runtime, operation) -> None``, called after
  CancelOperation committed the cancellation, to signal the running work. A
  verb is cancellable exactly when it has one.
- **abandon hook**: ``async (runtime, operation) -> None``, called after the
  startup reconciler failed an operation whose process died, to restore the
  owning resource's state.

Work that later tries to settle a finished (cancelled, abandoned) operation
gets ``FailedPrecondition`` from :meth:`Operations.complete` / ``fail``.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, Literal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import Operation
from bomesh.errors import FailedPrecondition, ServiceError, rpc_status
from bomesh.iam.authorizer import Principal

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

Verb = Literal[
    "createWorkspace", "exportAuditEvents", "exportUsage", "createArtifact", "reviseArtifact"
]

#: Finished operations are deleted this long after ``finished_at``.
RETENTION = timedelta(days=30)


@dataclass(frozen=True, slots=True)
class OperationTypes:
    """Message names of ``Operation.response`` and ``Operation.metadata``."""

    response: str
    metadata: str


OPERATION_TYPES: dict[str, OperationTypes] = {
    "createWorkspace": OperationTypes("Workspace", "CreateWorkspaceMetadata"),
    "exportAuditEvents": OperationTypes("WorkspaceExportResponse", "WorkspaceExportMetadata"),
    "exportUsage": OperationTypes("WorkspaceExportResponse", "WorkspaceExportMetadata"),
    "createArtifact": OperationTypes("Artifact", "ArtifactOperationMetadata"),
    "reviseArtifact": OperationTypes("Artifact", "ArtifactOperationMetadata"),
}


def operation_name(operation_id: UUID) -> str:
    return f"operations/{operation_id}"


#: Loads the resource an operation produced (``result_name``), unauthorized: reads are own-only.
ResultLoader = Callable[["AppRuntime", str], Awaitable[Any]]
#: Signals or repairs the work of one operation (cancel and abandon hooks).
OperationHook = Callable[["AppRuntime", Operation], Awaitable[None]]


class OperationHandlers:
    """Per-verb result loaders, cancel hooks and abandon hooks."""

    def __init__(self) -> None:
        self._loaders: dict[str, ResultLoader] = {}
        self._cancel_hooks: dict[str, OperationHook] = {}
        self._abandon_hooks: dict[str, OperationHook] = {}

    def register_result(self, verb: Verb, loader: ResultLoader) -> None:
        self._loaders[verb] = loader

    def register_cancel(self, verb: Verb, hook: OperationHook) -> None:
        self._cancel_hooks[verb] = hook

    def register_abandon(self, verb: Verb, hook: OperationHook) -> None:
        self._abandon_hooks[verb] = hook

    def result_loader(self, verb: str) -> ResultLoader | None:
        return self._loaders.get(verb)

    def cancel_hook(self, verb: str) -> OperationHook | None:
        return self._cancel_hooks.get(verb)

    def abandon_hook(self, verb: str) -> OperationHook | None:
        return self._abandon_hooks.get(verb)

    def snapshot(self) -> Mapping[str, dict[str, Any]]:
        """A copy of every registration (tests restore it with :meth:`restore`)."""
        return {
            "loaders": dict(self._loaders),
            "cancel": dict(self._cancel_hooks),
            "abandon": dict(self._abandon_hooks),
        }

    def restore(self, snapshot: Mapping[str, dict[str, Any]]) -> None:
        self._loaders = dict(snapshot["loaders"])
        self._cancel_hooks = dict(snapshot["cancel"])
        self._abandon_hooks = dict(snapshot["abandon"])


#: The process-wide registry.
OPERATION_HANDLERS = OperationHandlers()


class Operations:
    """Operation lifecycle inside the caller's transaction."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def create(
        self,
        principal: Principal,
        *,
        verb: Verb,
        target: str,
        workspace_id: UUID | None,
    ) -> Operation:
        """Start an operation owned by ``principal`` acting on ``target`` (a resource name)."""
        now = datetime.now(UTC)
        operation = Operation(
            user_id=principal.user_id,
            tenant_id=workspace_id,
            verb=verb,
            target=target,
            created_at=now,
            expires_at=now + RETENTION,
        )
        self._session.add(operation)
        await self._session.flush()
        return operation

    async def progress(self, operation_id: UUID, percent: int) -> Operation:
        operation = await self._running(operation_id)
        operation.progress_percent = max(0, min(100, percent))
        await self._session.flush()
        return operation

    async def complete(
        self,
        operation_id: UUID,
        *,
        result_name: str | None = None,
        result_object_key: str | None = None,
        result_expires_at: datetime | None = None,
    ) -> Operation:
        """Finish successfully with the response's resource name or exported object key."""
        if (result_name is None) == (result_object_key is None):
            raise ValueError("an operation result is exactly one of a name or an object key")
        operation = await self._running(operation_id)
        operation.result_name = result_name
        operation.result_object_key = result_object_key
        operation.result_expires_at = result_expires_at
        operation.progress_percent = 100
        self._finish(operation)
        await self._session.flush()
        return operation

    async def fail(self, operation_id: UUID, error: ServiceError) -> Operation:
        """Finish with a user-safe ``google.rpc.Status`` (also used for cancellation)."""
        operation = await self._running(operation_id)
        operation.error = rpc_status(error)
        self._finish(operation)
        await self._session.flush()
        return operation

    async def _running(self, operation_id: UUID) -> Operation:
        operation = await self._session.scalar(
            select(Operation).where(Operation.id == operation_id).with_for_update()
        )
        if operation is None:
            raise LookupError(f"operation {operation_id} does not exist")
        if operation.finished_at is not None:
            raise FailedPrecondition("The operation has already finished.")
        return operation

    @staticmethod
    def _finish(operation: Operation) -> None:
        operation.finished_at = datetime.now(UTC)
        operation.expires_at = operation.finished_at + RETENTION


__all__ = [
    "OPERATION_HANDLERS",
    "OPERATION_TYPES",
    "RETENTION",
    "OperationHandlers",
    "OperationHook",
    "OperationTypes",
    "Operations",
    "ResultLoader",
    "Verb",
    "operation_name",
]
