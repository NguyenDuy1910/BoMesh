"""SQL builders other slices use to report on ingestion without reading its tables themselves.

Pure ``Select`` statements: no session, no permission check. The caller runs
them inside its own authorized read.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import Select, select

from bomesh.db.models import (
    IngestionRun,
    IngestionRunItem,
    IngestionSource,
    IntegrationConnection,
)
from bomesh.services import CONNECTION_REAUTHORIZATION_REQUIRED
from bomesh.services.ingestion.source_store import SOURCE_FAILED, source_state_column


def failing_source_codes(workspace_id: UUID) -> Select[tuple[str]]:
    """``code`` of the workspace's live sources whose ``state`` is FAILED.

    FAILED as ``Source.state`` computes it: not paused, the connection does not
    need reauthorization, and the latest sync failed.
    """
    return (
        select(IngestionSource.code)
        .join(
            IntegrationConnection,
            IntegrationConnection.id == IngestionSource.integration_connection_id,
        )
        .where(
            IngestionSource.tenant_id == workspace_id,
            IngestionSource.deleted_at.is_(None),
            source_state_column() == SOURCE_FAILED,
        )
    )


def expired_connection_codes(workspace_id: UUID) -> Select[tuple[str]]:
    """``code`` of the workspace's live workspace-owned connections needing reauthorization."""
    return select(IntegrationConnection.code).where(
        IntegrationConnection.tenant_id == workspace_id,
        IntegrationConnection.deleted_at.is_(None),
        IntegrationConnection.owner_user_id.is_(None),
        IntegrationConnection.status == CONNECTION_REAUTHORIZATION_REQUIRED,
    )


def processed_document_rows() -> Select[tuple[UUID, UUID, object]]:
    """``(tenant_id, item_id, processed_at)``: one row per task that SUCCEEDED."""
    return (
        select(
            IngestionRun.tenant_id.label("tenant_id"),
            IngestionRunItem.item_id.label("item_id"),
            IngestionRunItem.finished_at.label("processed_at"),
        )
        .join(IngestionRun, IngestionRun.id == IngestionRunItem.run_id)
        .where(IngestionRunItem.status == "succeeded")
    )


__all__ = ["expired_connection_codes", "failing_source_codes", "processed_document_rows"]
