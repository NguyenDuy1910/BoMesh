"""Pure SQL builders other slices embed (no session, no permission check).

This module imports only models, so any domain may import it.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import Select, select

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


__all__ = ["live_space_rows", "open_access_request_ids"]
