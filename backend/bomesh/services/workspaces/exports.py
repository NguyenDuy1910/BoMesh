"""CSV exports run as long-running operations (ExportAuditEvents, ExportWorkspaceUsage).

The starting service creates the Operation in its own transaction; the export
then reads its rows, stores ``exports/{kind}/{operation}.csv`` and completes
the operation with that object key (the Operations interface signs the
``downloadUri``). Any failure fails the operation instead of leaving it
unfinished: in a new transaction, shielded from the request's cancellation.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import ColumnElement
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.errors import Internal, ServiceError, Unavailable
from bomesh.services.kernel.operations import Operations
from bomesh.services.workspaces.audit_log import AuditScope, export_rows, store_csv
from bomesh.storage import DocumentStorage, ObjectStorageError

#: How long an exported CSV object stays downloadable.
EXPORT_RETENTION = timedelta(days=7)

RowsBuilder = Callable[[AsyncSession], Awaitable[Sequence[Sequence[str]]]]

_log = logging.getLogger(__name__)


async def run_export(
    sessions: SessionFactory,
    storage: DocumentStorage,
    *,
    operation_id: UUID,
    kind: str,
    rows: RowsBuilder,
) -> None:
    """Build the rows (in a read transaction), store the CSV and complete the operation."""
    try:
        async with transaction_scope(sessions) as session:
            data = await rows(session)
        key = f"exports/{kind}/{operation_id}.csv"
        await store_csv(storage, key, data)
        async with transaction_scope(sessions) as session:
            await Operations(session).complete(
                operation_id,
                result_object_key=key,
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

    await run_export(sessions, storage, operation_id=operation_id, kind="audit", rows=rows)


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


__all__ = ["EXPORT_RETENTION", "RowsBuilder", "export_audit_events", "run_export"]
