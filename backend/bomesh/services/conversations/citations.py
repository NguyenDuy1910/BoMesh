"""Per-reader rendering of stored citations and the audience readability check.

Readability is always the Item visibility rule (``item_model.md`` §6), checked
now: a citation stored months ago still opens only what the reader may read
today. The contribution-reviewer exception never applies.

A citation is a :class:`CitationTarget`: blocks of one revision's Structured
Document. Freshness (``api_design.md`` §7 Living answers) is computed on every
read: a citation is outdated when the cited document's current revision is a
later one than the cited revision.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import Item, ItemRevision, Message, MessageCitation
from bomesh.document_structure import CitationTarget
from bomesh.iam.authorizer import Authorizer, ItemRef, Principal
from bomesh.iam.visibility import visible_to
from bomesh.services.conversations.records import (
    UNAVAILABLE,
    CitationRecord,
    OutdatedSourceRecord,
    citation_target,
)
from bomesh.services.knowledge_items.names import item_name, revision_name
from bomesh.services.knowledge_items.summary import ItemSummary, get_item_summaries


@dataclass(frozen=True, slots=True)
class CurrentRevision:
    """A document's current revision: its number and when it was created."""

    number: int
    created_at: datetime


async def message_citations(
    session: AsyncSession, message_ids: Iterable[UUID]
) -> dict[UUID, tuple[CitationTarget, ...]]:
    """The stored citations of each message (``message_citations``), in citation order."""
    ids = list(dict.fromkeys(message_ids))
    if not ids:
        return {}
    rows = await session.scalars(
        select(MessageCitation)
        .where(MessageCitation.message_id.in_(ids))
        .order_by(MessageCitation.message_id, MessageCitation.position)
    )
    citations: dict[UUID, list[CitationTarget]] = {}
    for row in rows:
        citations.setdefault(row.message_id, []).append(citation_target(row))
    return {message_id: tuple(values) for message_id, values in citations.items()}


async def current_revisions(
    session: AsyncSession, item_ids: Iterable[UUID]
) -> dict[UUID, CurrentRevision]:
    """Each document's current revision, in one query.

    Items without a current revision (collections, uploads in progress) are absent.
    """
    ids = list(dict.fromkeys(item_ids))
    if not ids:
        return {}
    rows = await session.execute(
        select(Item.id, ItemRevision.revision_number, ItemRevision.created_at)
        .join(ItemRevision, ItemRevision.id == Item.current_revision_id)
        .where(Item.id.in_(ids))
    )
    return {
        item_id: CurrentRevision(number, created_at)
        for item_id, number, created_at in rows.tuples().all()
    }


async def outdated_sources(
    session: AsyncSession,
    authorizer: Authorizer,
    principal: Principal,
    workspace_id: UUID,
    conversation_ids: Iterable[UUID],
) -> dict[UUID, tuple[OutdatedSourceRecord, ...]]:
    """Per conversation, the documents ``principal`` can read that its current answers
    cite and that changed since: their current revision is later than the cited one.

    Most recent change first; conversations with none are absent. One query for
    all ``conversation_ids`` plus one readability check of the cited documents.
    """
    ids = list(dict.fromkeys(conversation_ids))
    if not ids:
        return {}
    rows = (
        await session.execute(
            select(Message.conversation_id, Item.id, ItemRevision.created_at)
            .select_from(Message)
            .join(MessageCitation, MessageCitation.message_id == Message.id)
            .join(Item, Item.id == MessageCitation.item_id)
            .join(ItemRevision, ItemRevision.id == Item.current_revision_id)
            .where(
                Message.conversation_id.in_(ids),
                Message.superseded_at.is_(None),
                Message.role == "assistant",
                ItemRevision.revision_number > MessageCitation.revision_number,
            )
            .distinct()
        )
    ).tuples().all()
    summaries = await get_item_summaries(
        session, authorizer, principal, workspace_id, (item_id for _, item_id, _ in rows)
    )
    grouped: dict[UUID, list[OutdatedSourceRecord]] = {}
    for conversation_id, item_id, changed_at in rows:
        summary = summaries.get(item_id)
        if summary is None:
            continue
        grouped.setdefault(conversation_id, []).append(
            OutdatedSourceRecord(
                item=item_name(workspace_id, item_id),
                display_name=summary.display_name,
                update_time=changed_at,
            )
        )
    return {
        conversation_id: tuple(
            sorted(sources, key=lambda source: (source.update_time, source.item), reverse=True)
        )
        for conversation_id, sources in grouped.items()
    }


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
    workspace_id: UUID,
    target: CitationTarget,
    summaries: Mapping[UUID, ItemSummary],
    *,
    current: Mapping[UUID, CurrentRevision] | None = None,
) -> CitationRecord:
    """``target`` for a reader whose readable items are ``summaries`` (``get_item_summaries``).

    A message's citation passes the cited documents' ``current`` revisions
    (:func:`current_revisions`): it then carries ``update_time`` and
    ``outdated`` (the current revision is later than the cited one).
    """
    summary = summaries.get(target.item_id)
    if summary is None:
        return UNAVAILABLE
    revision = current.get(target.item_id) if current is not None else None
    return CitationRecord(
        available=True,
        item=item_name(workspace_id, summary.item_id),
        display_name=summary.display_name or None,
        revision=revision_name(workspace_id, target.item_id, target.revision_number),
        structure_version=target.structure_version,
        refs=target.refs,
        quote=target.quote,
        location=target.location,
        highlights=target.highlights,
        outdated=revision.number > target.revision_number if revision is not None else None,
        update_time=revision.created_at if revision is not None else None,
    )


def readable_source(summaries: Mapping[UUID, ItemSummary], item_id: UUID) -> bool:
    """Whether text built from ``item_id`` may be shown: the reader can read it."""
    return item_id in summaries


__all__ = [
    "CurrentRevision",
    "citation_record",
    "current_revisions",
    "message_citations",
    "outdated_sources",
    "readable_source",
    "unreadable_items",
]
