"""Pure SQL builders other slices embed (no session, no permission check).

This module imports only models, so any domain may import it.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, ScalarSelect, Select, select

from bomesh.db.models import Request, Space


def open_access_request_ids(workspace_id: UUID) -> Select[Any]:
    """Column ``id``: OPEN COLLECTION_ACCESS and SPACE_MEMBERSHIP requests of the workspace."""
    return select(Request.id).where(
        Request.tenant_id == workspace_id,
        Request.kind.in_(("collection_access", "space_membership")),
        Request.state == "open",
    )


def live_space_rows(workspace_id: UUID) -> Select[Any]:
    """Columns ``id``, ``code``: live spaces of the workspace, oldest first."""
    return (
        select(Space.id, Space.code)
        .where(Space.tenant_id == workspace_id, Space.deleted_at.is_(None))
        .order_by(Space.created_at, Space.id)
    )


def space_rows() -> Select[Any]:
    """Columns ``id``, ``tenant_id``, ``code``, ``space_name``, ``deleted_at`` of
    every space; callers filter on ``selected_columns``."""
    return select(Space.id, Space.tenant_id, Space.code, Space.space_name, Space.deleted_at)


def space_code_of(space_id: ColumnElement[UUID]) -> ScalarSelect[str]:
    """The space ID (``code``) of a row id column, as a correlated SQL scalar."""
    return select(Space.code).where(Space.id == space_id).scalar_subquery()


__all__ = ["live_space_rows", "open_access_request_ids", "space_code_of", "space_rows"]
