"""Per-reader rendering of stored citations and the audience readability check.

Readability is always the Item visibility rule (``item_model.md`` §6), checked
now: a citation stored months ago still opens only what the reader may read
today. The contribution-reviewer exception never applies.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.iam.authorizer import Authorizer, ItemRef, Principal
from bomesh.iam.visibility import is_visible
from bomesh.services.conversations.records import (
    UNAVAILABLE,
    CitationRecord,
    StoredCitation,
)
from bomesh.services.knowledge_items.names import item_name, passage_name
from bomesh.services.knowledge_items.summary import ItemSummary, get_item_summary


async def render_citations(
    session: AsyncSession,
    authorizer: Authorizer,
    principal: Principal,
    workspace_id: UUID,
    citations: Sequence[StoredCitation],
) -> list[CitationRecord]:
    """``citations`` as ``principal`` may see them; unreadable ones keep only ``available``."""
    summaries = await readable_summaries(
        session, authorizer, principal, workspace_id, (c.item_id for c in citations)
    )
    return [citation_record(workspace_id, citation, summaries) for citation in citations]


async def readable_summaries(
    session: AsyncSession,
    authorizer: Authorizer,
    principal: Principal,
    workspace_id: UUID,
    item_ids: Iterable[UUID],
) -> dict[UUID, ItemSummary]:
    """The summary of every item ``principal`` can read now, keyed by the cited ID."""
    summaries: dict[UUID, ItemSummary] = {}
    for item_id in dict.fromkeys(item_ids):
        summary = await get_item_summary(session, authorizer, principal, workspace_id, item_id)
        if summary is not None:
            summaries[item_id] = summary
    return summaries


async def unreadable_items(
    authorizer: Authorizer,
    workspace_id: UUID,
    user_ids: Iterable[UUID],
    item_ids: Iterable[UUID],
) -> frozenset[UUID]:
    """Items of ``item_ids`` that at least one of ``user_ids`` cannot read now.

    Used by audience checks (``AUDIENCE_CANNOT_READ_SOURCES``): a share or a
    space artifact is refused when this is not empty.
    """
    items = tuple(dict.fromkeys(item_ids))
    blocked: set[UUID] = set()
    for user_id in dict.fromkeys(user_ids):
        principal = Principal(user_id)
        for item_id in items:
            if item_id not in blocked and not await is_visible(
                authorizer, principal, ItemRef(workspace_id, item_id)
            ):
                blocked.add(item_id)
        if len(blocked) == len(items):
            break
    return frozenset(blocked)


def citation_record(
    workspace_id: UUID, citation: StoredCitation, summaries: Mapping[UUID, ItemSummary]
) -> CitationRecord:
    """``citation`` for a reader whose readable items are ``summaries`` (``readable_summaries``).

    A cited duplicate merged into another document resolves to that target,
    but the cited passage and its excerpt are content of the DELETED
    duplicate, which is never served: only the target is named.
    """
    summary = summaries.get(citation.item_id)
    if summary is None:
        return UNAVAILABLE
    content = summary.serves_content
    return CitationRecord(
        available=True,
        passage=passage_name(workspace_id, citation.item_id, citation.chunk_id) if content else None,
        item=item_name(workspace_id, summary.item_id),
        display_name=summary.display_name or citation.title or None,
        page_number=citation.page if content else None,
        excerpt=citation.excerpt if content else None,
    )


def readable_source(summaries: Mapping[UUID, ItemSummary], item_id: UUID) -> bool:
    """Whether text built from ``item_id`` may be shown: readable, and not only through a merge."""
    summary = summaries.get(item_id)
    return summary is not None and summary.serves_content


__all__ = [
    "citation_record",
    "readable_source",
    "readable_summaries",
    "render_citations",
    "unreadable_items",
]
