"""Contribution analysis: the ANALYZING → IN_REVIEW system step behind a small port.

:class:`RuleAnalyzer` is deterministic and reads only PostgreSQL rows (no model
call, no object read), so it runs inside the transaction that opens or
resubmits a contribution:

- DUPLICATE: a published, non-personal document with the same title, MIME
  type and size; NEW_REVISION (new documents only): the same title with other
  content, so the contributor probably meant to revise it;
- UNSEARCHABLE_FORMAT: the file type is not one ingestion can process;
- PERSONAL_DATA: the title, file name or note carries an email address or a
  phone-like number;
- suggestions: the document type from the MIME type, ACTIVE topics whose
  name occurs in the title or note, and the governing collection of a related
  document when it accepts contributions.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from bomesh.db.models import Item, Topic
from bomesh.iam.policy import PERSONAL_KIND
from bomesh.services.knowledge_items.item_store import (
    document_type_for_content_type,
    is_knowledge_format,
)

DUPLICATE = "duplicate"
NEW_REVISION = "new_revision"
PERSONAL_DATA = "personal_data"
UNSEARCHABLE_FORMAT = "unsearchable_format"

_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_PHONE = re.compile(r"\+?\d[\d\s().-]{7,}\d")
_RELATED_LIMIT = 5


@dataclass(frozen=True, slots=True)
class Flag:
    kind: str
    related_item_id: UUID | None = None


@dataclass(frozen=True, slots=True)
class Analysis:
    flags: tuple[Flag, ...] = ()
    document_type: str | None = None
    document_type_confidence: float | None = None
    topic_ids: tuple[UUID, ...] = ()
    topics_confidence: float | None = None
    collection_id: UUID | None = None
    collection_confidence: float | None = None
    summary: str | None = None
    summary_confidence: float | None = None

    def suggestions(self) -> dict[str, object]:
        """The ``contributions.suggestions`` JSON (topics live in ``contribution_topics``)."""
        values: dict[str, object | None] = {
            "document_type": self.document_type,
            "document_type_confidence": self.document_type_confidence,
            "topics_confidence": self.topics_confidence if self.topic_ids else None,
            "proposed_topics_confidence": None,
            "collection_id": str(self.collection_id) if self.collection_id else None,
            "collection_confidence": self.collection_confidence,
            "summary": self.summary,
            "summary_confidence": self.summary_confidence,
        }
        return {key: value for key, value in values.items() if value is not None}


class ContributionAnalyzer(Protocol):
    async def analyze(
        self,
        session: AsyncSession,
        candidate: Item,
        *,
        kind: str,
        replaces_item_id: UUID | None,
        note: str | None,
    ) -> Analysis: ...


class RuleAnalyzer:
    """The deterministic analyzer (module docstring)."""

    async def analyze(
        self,
        session: AsyncSession,
        candidate: Item,
        *,
        kind: str,
        replaces_item_id: UUID | None,
        note: str | None,
    ) -> Analysis:
        file_name = str(candidate.metadata_.get("file_name") or candidate.title)
        flags: list[Flag] = []
        related = await _same_title(session, candidate, replaces_item_id)
        for item in related:
            same_content = (item.mime_type, item.size_bytes) == (
                candidate.mime_type,
                candidate.size_bytes,
            )
            if same_content:
                flags.append(Flag(DUPLICATE, item.id))
            elif kind == "new_document":
                flags.append(Flag(NEW_REVISION, item.id))
        if not is_knowledge_format(file_name):
            flags.append(Flag(UNSEARCHABLE_FORMAT))
        text = " ".join(part for part in (candidate.title, file_name, note) if part)
        if _EMAIL.search(text) or _PHONE.search(text):
            flags.append(Flag(PERSONAL_DATA))
        topics = await _matching_topics(session, candidate.tenant_id, text)
        collection = await _accepting_parent(session, related)
        document_type = candidate.document_type or (
            document_type_for_content_type(candidate.mime_type) if candidate.mime_type else None
        )
        return Analysis(
            flags=tuple(flags),
            document_type=document_type,
            document_type_confidence=0.9 if document_type else None,
            topic_ids=topics,
            topics_confidence=0.6 if topics else None,
            collection_id=collection,
            collection_confidence=0.5 if collection else None,
        )


async def _same_title(
    session: AsyncSession, candidate: Item, replaces_item_id: UUID | None
) -> list[Item]:
    parent = aliased(Item)
    excluded = [candidate.id] + ([replaces_item_id] if replaces_item_id else [])
    rows = await session.scalars(
        select(Item)
        .join(parent, parent.id == Item.parent_item_id)
        .where(
            Item.tenant_id == candidate.tenant_id,
            Item.item_type == "document",
            Item.deleted_at.is_(None),
            Item.publication_state == "published",
            Item.id.not_in(excluded),
            func.lower(Item.title) == candidate.title.lower(),
            parent.metadata_["system_kind"].astext.is_distinct_from(PERSONAL_KIND),
        )
        .order_by(Item.created_at, Item.id)
        .limit(_RELATED_LIMIT)
    )
    return list(rows)


async def _matching_topics(session: AsyncSession, workspace_id: UUID, text: str) -> tuple[UUID, ...]:
    lowered = text.lower()
    rows = await session.execute(
        select(Topic.id, Topic.display_name)
        .where(
            Topic.tenant_id == workspace_id,
            Topic.kind == "topic",
            Topic.state == "active",
            Topic.deleted_at.is_(None),
        )
        .order_by(Topic.code)
    )
    return tuple(topic_id for topic_id, name in rows if name.lower() in lowered)


async def _accepting_parent(session: AsyncSession, related: list[Item]) -> UUID | None:
    for item in related:
        parent = await session.get(Item, item.parent_item_id) if item.parent_item_id else None
        if (
            parent is not None
            and parent.item_type == "collection"
            and parent.metadata_.get("accepts_contributions") is True
        ):
            return parent.id
    return None
