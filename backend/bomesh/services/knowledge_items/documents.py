"""Document metadata other slices change: summary and title.

Concept labels are :mod:`bomesh.services.taxonomy.assignments`'s. Callers
authorize; these run in the caller's session.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import Item
from bomesh.errors import FailedPrecondition
from bomesh.iam.authorizer import ItemRef, not_found


async def set_document_metadata(
    session: AsyncSession,
    workspace_id: UUID,
    item_id: UUID,
    *,
    summary: str | None = None,
    title: str | None = None,
) -> None:
    """Set the given fields (``None`` leaves one unchanged; ``summary=""`` clears it).

    ``summary`` is the document's ``description``, ``title`` its ``displayName``
    (validated by the caller).
    """
    item = await _document(session, workspace_id, item_id)
    if summary is not None:
        item.description = summary or None
    if title is not None:
        item.item_name = title
    await session.flush()


async def _document(session: AsyncSession, workspace_id: UUID, item_id: UUID) -> Item:
    item = await session.get(Item, item_id)
    if item is None or item.tenant_id != workspace_id:
        raise not_found(ItemRef(workspace_id, item_id))
    if item.item_kind != "document":
        raise FailedPrecondition("Only DOCUMENT items carry document metadata.")
    return item


__all__ = ["set_document_metadata"]
