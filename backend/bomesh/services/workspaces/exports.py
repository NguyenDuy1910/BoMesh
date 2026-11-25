"""CSV exports run as long-running operations (ExportAuditEvents, ExportWorkspaceUsage).

The starting service creates the Operation in its own transaction; the export
then reads its rows, stores the CSV at
``bomesh.storage.keys.export_key(operation.workspace_code, operation.id)`` and
completes the operation with its ``result_expires_at`` only (the key is
derived, never stored; the Operations interface signs the ``downloadUri``). Any failure fails the operation instead of leaving it
unfinished: in a new transaction, shielded from the request's cancellation.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import ColumnElement, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Tenant
from bomesh.db.models.operations import Operation
from bomesh.errors import Internal, ServiceError, Unavailable
from bomesh.services.kernel.operations import Operations
from bomesh.services.workspaces.audit_log import AuditScope, export_rows, store_csv
from bomesh.storage import DocumentStorage, ObjectStorageError
from bomesh.storage.keys import export_key, export_operation_id, exports_prefix

#: How long an exported CSV object stays downloadable.
EXPORT_RETENTION = timedelta(days=7)

RowsBuilder = Callable[[AsyncSession], Awaitable[Sequence[Sequence[str]]]]

_log = logging.getLogger(__name__)


async def run_export(
    sessions: SessionFactory,
    storage: DocumentStorage,
    *,
    operation_id: UUID,
    rows: RowsBuilder,
) -> None:
    """Build the rows (in a read transaction), store the CSV and complete the operation."""
    try:
        async with transaction_scope(sessions) as session:
            operation = await session.get(Operation, operation_id)
            if operation is None:
                raise RuntimeError(f"operation {operation_id} does not exist")
            workspace = operation.workspace_code
            data = await rows(session)
        await store_csv(storage, export_key(workspace, operation_id), data)
        async with transaction_scope(sessions) as session:
            await Operations(session).complete(
                operation_id,
                result_expires_at=datetime.now(UTC) + EXPORT_RETENTION,
            )
    except asyncio.CancelledError:
        await _settle(
            sessions, operation_id, Unavailable("The export was interrupted; try again.")
        )
        raise
    except Exception as exc:  # noqa: BLE001 - every failure must finish the operation
        _log.exception("export %s failed", operation_id)
        await _settle(sessions, operation_id, _user_safe(exc))


async def export_audit_events(
    sessions: SessionFactory,
    storage: DocumentStorage,
    *,
    operation_id: UUID,
    scope: AuditScope,
    where: ColumnElement[bool],
    metadata_only: bool,
) -> None:
    """Export the matching audit events (newest first) for an ``exportAuditEvents`` operation.

    ``metadata_only`` (platform callers, ``workspaces/-``) leaves out target and description.
    """

    async def rows(session: AsyncSession) -> Sequence[Sequence[str]]:
        return await export_rows(session, scope, where=where, metadata_only=metadata_only)

    await run_export(sessions, storage, operation_id=operation_id, rows=rows)


async def _settle(sessions: SessionFactory, operation_id: UUID, error: ServiceError) -> None:
    """Fail the operation in its own transaction; a failure here is left to the reconciler."""
    try:
        await asyncio.shield(_fail(sessions, operation_id, error))
    except Exception:  # noqa: BLE001 - the startup reconciler fails it later
        _log.exception("could not fail operation %s", operation_id)


async def _fail(sessions: SessionFactory, operation_id: UUID, error: ServiceError) -> None:
    async with transaction_scope(sessions) as session:
        await Operations(session).fail(operation_id, error)


def _user_safe(exc: Exception) -> ServiceError:
    if isinstance(exc, ServiceError):
        return exc
    if isinstance(exc, ObjectStorageError):
        return Unavailable("The export could not be stored; try again.")
    return Internal("The export failed.")


async def purge_expired_exports(sessions: SessionFactory, storage: DocumentStorage) -> int:
    """Delete every export CSV that is no longer downloadable; returns how many.

    Driven by what is stored, so an object is looked at only while it exists:
    a CSV goes once its operation's ``result_expires_at`` has passed, or when
    its operation is gone or finished without it (failed after storing). A
    CSV of an export still running is kept.
    """
    async with transaction_scope(sessions) as session:
        codes = list(await session.scalars(select(Tenant.code)))
    keys = [
        key
        for prefix in (*(exports_prefix(code) for code in codes), exports_prefix(None))
        for key in await storage.list_keys(prefix)
    ]
    named = {key: export_operation_id(key) for key in keys}
    ids = [operation_id for operation_id in named.values() if operation_id is not None]
    if not ids:
        return 0
    async with transaction_scope(sessions) as session:
        now = datetime.now(UTC)
        states = {
            operation_id: (finished_at, result_expires_at)
            for operation_id, finished_at, result_expires_at in await session.execute(
                select(Operation.id, Operation.finished_at, Operation.result_expires_at).where(
                    Operation.id.in_(ids)
                )
            )
        }
    deleted = 0
    for key, operation_id in named.items():
        if operation_id is None:
            continue
        state = states.get(operation_id)
        if state is not None:
            finished_at, expires_at = state
            if finished_at is None or (expires_at is not None and expires_at > now):
                continue
        await storage.delete(key)
        deleted += 1
    if deleted:
        _log.info("deleted expired export CSVs count=%d", deleted)
    return deleted


__all__ = [
    "EXPORT_RETENTION",
    "RowsBuilder",
    "export_audit_events",
    "purge_expired_exports",
    "run_export",
]
