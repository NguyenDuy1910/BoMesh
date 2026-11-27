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
- suggestions: the governing collection of a related document when it accepts
  contributions (concept suggestions are SUGGESTED item_concepts on the
  candidate, written by indexing).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from bomesh.db.models import Item
from bomesh.iam.policy import PERSONAL_COLLECTION_TYPE
from bomesh.services.knowledge_items.item_store import is_knowledge_format

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
    collection_id: UUID | None = None
    collection_confidence: float | None = None
    summary: str | None = None
    summary_confidence: float | None = None

    def suggestions(self) -> dict[str, object]:
        """The ``contributions.suggestions`` JSON (summary/title/collection)."""
        values: dict[str, object | None] = {
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
        file_name = candidate.file_name or candidate.item_name
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
        text = " ".join(part for part in (candidate.item_name, file_name, note) if part)
        if _EMAIL.search(text) or _PHONE.search(text):
            flags.append(Flag(PERSONAL_DATA))
        collection = await _accepting_parent(session, related)
        return Analysis(
            flags=tuple(flags),
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
            Item.item_kind == "document",
            Item.deleted_at.is_(None),
            Item.is_published,
            Item.id.not_in(excluded),
            func.lower(Item.item_name) == candidate.item_name.lower(),
            parent.item_type != PERSONAL_COLLECTION_TYPE,
        )
        .order_by(Item.created_at, Item.id)
        .limit(_RELATED_LIMIT)
    )
    return list(rows)


async def _accepting_parent(session: AsyncSession, related: list[Item]) -> UUID | None:
    for item in related:
        parent = await session.get(Item, item.parent_item_id) if item.parent_item_id else None
        if (
            parent is not None
            and parent.item_kind == "collection"
            and parent.accepts_contributions
        ):
            return parent.id
    return None
