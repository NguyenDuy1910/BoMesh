"""Document metadata other slices change: topics, document type and summary.

The one tagger of ``item_topics``. Topics are validated through
KnowledgeCuration's ``resolve_active_topics`` (it owns the taxonomy).
Callers authorize; these run in the caller's session.
"""

from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import Item, ItemTopic
from bomesh.errors import FailedPrecondition, InvalidArgument
from bomesh.iam.authorizer import ItemRef, not_found
from bomesh.services.knowledge_curation.topics import resolve_active_topics

MAX_DOCUMENT_TYPE = 64


async def tag_document(
    session: AsyncSession,
    workspace_id: UUID,
    item_id: UUID,
    topic_codes: Sequence[str],
    *,
    created_by_user_id: UUID | None,
    field: str = "document.topics",
) -> None:
    """Replace a document's topics; an unknown or inactive topic is INVALID_ARGUMENT."""

    await _document(session, workspace_id, item_id)
    codes = list(dict.fromkeys(topic_codes))
    topics = await resolve_active_topics(session, workspace_id, codes, field=field)
    await session.execute(delete(ItemTopic).where(ItemTopic.item_id == item_id))
    for code in codes:
        session.add(
            ItemTopic(item_id=item_id, topic_id=topics[code], created_by_user_id=created_by_user_id)
        )
    await session.flush()


async def set_document_metadata(
    session: AsyncSession,
    workspace_id: UUID,
    item_id: UUID,
    *,
    document_type: str | None = None,
    summary: str | None = None,
    topics: Sequence[str] | None = None,
    created_by_user_id: UUID | None = None,
) -> None:
    """Set the given fields (``None`` leaves one unchanged; ``summary=""`` clears it)."""
    item = await _document(session, workspace_id, item_id)
    if document_type is not None:
        item.document_type = validated_document_type(document_type)
    if summary is not None:
        metadata = dict(item.metadata_)
        if summary:
            metadata["summary"] = summary
        else:
            metadata.pop("summary", None)
        item.metadata_ = metadata
    await session.flush()
    if topics is not None:
        await tag_document(
            session, workspace_id, item_id, topics, created_by_user_id=created_by_user_id
        )


def validated_document_type(value: str, *, field: str = "document.documentType") -> str:
    if not value or len(value) > MAX_DOCUMENT_TYPE:
        raise InvalidArgument.for_field(
            field, f"documentType must be 1-{MAX_DOCUMENT_TYPE} characters."
        )
    return value


async def _document(session: AsyncSession, workspace_id: UUID, item_id: UUID) -> Item:
    item = await session.get(Item, item_id)
    if item is None or item.tenant_id != workspace_id:
        raise not_found(ItemRef(workspace_id, item_id))
    if item.item_type != "document":
        raise FailedPrecondition("Only DOCUMENT items carry document metadata.")
    return item


__all__ = ["set_document_metadata", "tag_document", "validated_document_type"]
