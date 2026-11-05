"""The Source and Connection resource names, owned by the Ingestion slice (AIP-122).

A source is named by its ``code`` (``workspaces/{workspace}/sources/{code}``).
The code is chosen at creation, never changes and is never reused, even after
the source is deleted, so other slices may keep it as a stable reference
(synced documents carry it in ``metadata.source.source_code``). This module
imports nothing of the Ingestion services, so any slice can use it.
"""

from __future__ import annotations

from collections.abc import Iterable
from uuid import UUID

from sqlalchemy import ScalarSelect, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import IngestionSource
from bomesh.errors import InvalidArgument


def connection_name(workspace_id: UUID, code: str) -> str:
    return f"workspaces/{workspace_id}/connections/{code}"


def source_name(workspace_id: UUID, code: str) -> str:
    return f"workspaces/{workspace_id}/sources/{code}"


def parse_source(name: str, workspace_id: UUID, *, field: str) -> str:
    """The code of ``workspaces/{workspace}/sources/{code}`` in this workspace."""
    parts = name.split("/")
    if (
        len(parts) != 4
        or parts[0] != "workspaces"
        or parts[1] != str(workspace_id)
        or parts[2] != "sources"
        or not parts[3]
    ):
        raise InvalidArgument.for_field(field, f"'{name}' is not a source of this workspace.")
    return parts[3]


def source_id_by_code(workspace_id: UUID, code: str) -> ScalarSelect[UUID]:
    """``SELECT id`` of the workspace's source ``code`` (deleted ones included), for filters."""
    return (
        select(IngestionSource.id)
        .where(IngestionSource.tenant_id == workspace_id, IngestionSource.code == code)
        .scalar_subquery()
    )


async def source_codes(session: AsyncSession, source_ids: Iterable[UUID]) -> dict[UUID, str]:
    """The code of each source ID (deleted sources included), for rendering names."""
    ids = set(source_ids)
    if not ids:
        return {}
    rows = await session.execute(
        select(IngestionSource.id, IngestionSource.code).where(IngestionSource.id.in_(ids))
    )
    return {source_id: code for source_id, code in rows.all()}


__all__ = ["connection_name", "parse_source", "source_codes", "source_id_by_code", "source_name"]
