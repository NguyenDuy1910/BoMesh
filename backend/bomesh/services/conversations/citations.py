"""Per-reader rendering of stored citations and the audience readability check.

Readability is always the Item visibility rule (``item_model.md`` §6), checked
now: a citation stored months ago still opens only what the reader may read
today. The contribution-reviewer exception never applies.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import MessageCitation
from bomesh.iam.authorizer import Authorizer, ItemRef, Principal
from bomesh.iam.visibility import visible_to
from bomesh.services.conversations.records import (
    UNAVAILABLE,
    CitationRecord,
    StoredCitation,
    stored_citation,
)
from bomesh.services.knowledge_items.names import item_name, passage_name
from bomesh.services.knowledge_items.summary import ItemSummary, get_item_summaries


async def message_citations(
    session: AsyncSession, message_ids: Iterable[UUID]
) -> dict[UUID, tuple[StoredCitation, ...]]:
    """The stored citations of each message (``message_citations``), in citation order."""
    ids = list(dict.fromkeys(message_ids))
    if not ids:
        return {}
    rows = await session.scalars(
        select(MessageCitation)
        .where(MessageCitation.message_id.in_(ids))
        .order_by(MessageCitation.message_id, MessageCitation.position)
    )
    citations: dict[UUID, list[StoredCitation]] = {}
    for row in rows:
        citations.setdefault(row.message_id, []).append(stored_citation(row))
    return {message_id: tuple(values) for message_id, values in citations.items()}


async def render_citations(
    session: AsyncSession,
    authorizer: Authorizer,
    principal: Principal,
    workspace_id: UUID,
    citations: Sequence[StoredCitation],
) -> list[CitationRecord]:
    """``citations`` as ``principal`` may see them; unreadable ones keep only ``available``."""
    summaries = await get_item_summaries(
        session, authorizer, principal, workspace_id, (c.item_id for c in citations)
    )
    return [citation_record(workspace_id, citation, summaries) for citation in citations]


async def unreadable_items(
    authorizer: Authorizer,
    workspace_id: UUID,
    user_ids: Iterable[UUID],
    item_ids: Iterable[UUID],
) -> frozenset[UUID]:
    """Items of ``item_ids`` that at least one of ``user_ids`` cannot read now.

    Used by audience checks (``AUDIENCE_CANNOT_READ_SOURCES``): a share or a
    space artifact is refused when this is not empty. Constant in queries
    whatever the audience and item counts (:func:`visible_to`).
    """
    users = frozenset(user_ids)
    if not users:
        return frozenset()
    readers = await visible_to(
        authorizer, users, (ItemRef(workspace_id, item_id) for item_id in item_ids)
    )
    return frozenset(ref.item_id for ref, readable in readers.items() if not users <= readable)


def citation_record(
    workspace_id: UUID, citation: StoredCitation, summaries: Mapping[UUID, ItemSummary]
) -> CitationRecord:
    """``citation`` for a reader whose readable items are ``summaries`` (``get_item_summaries``)."""
    summary = summaries.get(citation.item_id)
    if summary is None:
        return UNAVAILABLE
    return CitationRecord(
        available=True,
        passage=passage_name(workspace_id, citation.item_id, citation.chunk_id),
        item=item_name(workspace_id, summary.item_id),
        display_name=summary.display_name or citation.title or None,
        page_number=citation.page,
        excerpt=citation.excerpt,
    )


def readable_source(summaries: Mapping[UUID, ItemSummary], item_id: UUID) -> bool:
    """Whether text built from ``item_id`` may be shown: the reader can read it."""
    return item_id in summaries


__all__ = [
    "citation_record",
    "message_citations",
    "readable_source",
    "render_citations",
    "unreadable_items",
]
