"""Bounded context construction for ranked enterprise evidence."""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field

from bomesh.knowledge import Evidence, EvidenceContext

_INTRODUCTION = (
    "The closest passages the caller may read; they may not answer the question.\n"
    "Cite with [[cite:ref_id]] immediately after each claim it "
    "supports, never collected at the end. Repeat it on every claim, "
    "and place several together when a claim rests on several "
    "sources. Cite using the Source reference value, never the "
    "Document ID.\n"
    "Only the references below exist. Never invent one, and never "
    "write a page, URL, chunk ID, or coordinate.\n\n"
)
_LABEL = "\nEvidence:\n"
_PASSAGE_LABEL = (
    "\nPassage in document order; each part has its own source reference, cite the part a claim comes "
    "from; [match] marks what the search found:\n"
)
#: What turning a single match into a passage adds: the longer label and the match's own reference line.
_PASSAGE_OVERHEAD = len(_PASSAGE_LABEL) - len(_LABEL) + 24
#: Context shorter than this is left out rather than shown as a fragment.
_MIN_PART_CHARACTERS = 120


class EvidenceContextBuilder:
    """Preserve ranking and identities while bounding model-facing evidence."""

    def __init__(
        self,
        *,
        max_characters: int = 16_000,
        max_evidence_characters: int = 1_600,
        max_passage_characters: int = 4_800,
        include_contextual_text: bool = False,
    ) -> None:
        if min(max_characters, max_evidence_characters, max_passage_characters) < 1:
            raise ValueError("context limits must be greater than zero")
        self._max_characters = max_characters
        self._max_evidence_characters = max_evidence_characters
        self._max_passage_characters = max(max_passage_characters, max_evidence_characters)
        self._include_contextual_text = include_contextual_text

    def build(self, evidence: Sequence[Evidence]) -> EvidenceContext:
        """Every match first (strongest first), then the context around them, nearest first.

        A match's context is part of its passage only when it fits; only what is shown
        is returned as evidence, so only shown parts are citable.
        """

        remaining = self._max_characters - len(_INTRODUCTION)
        if remaining <= 0:
            return EvidenceContext(text="", evidence=())
        passages: list[_Passage] = []
        seen: set[tuple[str, str]] = set()
        for item in evidence:
            identity = (item.item_id, item.chunk_id)
            if identity in seen:
                continue
            header = self._header(item)
            available = min(self._max_evidence_characters, remaining - len(header) - len(_LABEL) - 2)
            if available <= 0:
                break
            body = self._body(item, available)
            if not body:
                continue
            passage = _Passage(item=item, header=header, body=body)
            passages.append(passage)
            seen.add(identity)
            remaining -= passage.size + 2
        for passage in passages:
            room = min(self._max_passage_characters - len(passage.body), remaining)
            # A side stops at its first part that is shown elsewhere, does not fit, or is cut:
            # a passage is contiguous text.
            closed: set[bool] = set()
            for part, before in _nearest_first(passage.item):
                if before in closed:
                    continue
                identity = (part.item_id, part.chunk_id)
                cost = len(part.id) + 4 + (_PASSAGE_OVERHEAD if not passage.parts else 0)
                if identity in seen or room - cost < _MIN_PART_CHARACTERS:
                    closed.add(before)
                    continue
                clip = _clip_end if before else self._clip
                text = clip(part.content, room - cost)
                if text != part.content:
                    closed.add(before)
                passage.add(part, text, before=before)
                seen.add(identity)
                spent = cost + len(text)
                room -= spent
                remaining -= spent
        if not passages:
            return EvidenceContext(text="", evidence=())
        return EvidenceContext(
            text=_INTRODUCTION + "\n\n".join(passage.text() for passage in passages),
            evidence=tuple(part for passage in passages for part in passage.evidence()),
        )

    def _header(self, item: Evidence) -> str:
        # The chunk-level source reference is a compact, per-run id: it is the
        # only thing the model may echo back as a citation marker, and a
        # fabricated one simply fails to resolve. The document id is the real,
        # stable Item identity. It is never accepted as a citation marker, so
        # it carries no ability to fabricate grounding.
        lines = [
            f"--- Document: {item.title or 'Untitled source'} ---",
            f"Document ID: {item.item_id}",
            f"Source reference: {item.id}",
        ]
        if item.group:
            lines.append(f"Reading: {item.group}")
        if item.section_path:
            lines.append(f"Section: {' > '.join(item.section_path)}")
        if item.target.location:
            lines.append(f"Location: {item.target.location}")
        if item.target.page is not None:
            lines.append(f"Page: {item.target.page}")
        if item.source is not None:
            lines.append(f"Origin: {item.source.provider.value}")
            if item.source.url:
                lines.append(f"Source URL: {item.source.url}")
        return "\n".join(lines)

    def _body(self, item: Evidence, limit: int) -> str:
        canonical = self._clip(item.content, limit)
        if not self._include_contextual_text or not item.contextual_text:
            return canonical
        contextual = item.contextual_text.strip()
        if contextual == item.content.strip():
            return canonical
        prefix = "Retrieval context (not canonical evidence):\n"
        separator = "\nCanonical evidence:\n"
        canonical_budget = max(1, min(len(item.content), limit * 3 // 4))
        context_budget = limit - len(prefix) - len(separator) - canonical_budget
        if context_budget < 80:
            return canonical
        return (
            f"{prefix}{self._clip(contextual, context_budget)}"
            f"{separator}{self._clip(item.content, canonical_budget)}"
        )

    @staticmethod
    def _clip(text: str, limit: int) -> str:
        if len(text) <= limit:
            return text
        if limit < 2:
            return ""
        return f"{text[: limit - 1].rstrip()}…"


def _clip_end(text: str, limit: int) -> str:
    """The end of ``text`` (context before a match runs into it)."""

    if len(text) <= limit:
        return text
    if limit < 2:
        return ""
    return f"…{text[-(limit - 1):].lstrip()}"


def _nearest_first(item: Evidence) -> Iterator[tuple[Evidence, bool]]:
    """The match's context, nearest first, alternating after and before (``True`` = before)."""

    before = list(reversed(item.context_before))
    after = list(item.context_after)
    for position in range(max(len(before), len(after))):
        if position < len(after):
            yield after[position], False
        if position < len(before):
            yield before[position], True


@dataclass(slots=True)
class _Passage:
    """One match as shown: its header and body, and the context parts that fit."""

    item: Evidence
    header: str
    body: str
    parts: list[tuple[Evidence, str, bool]] = field(default_factory=list)

    @property
    def size(self) -> int:
        return len(self.header) + len(_LABEL) + len(self.body)

    def add(self, part: Evidence, text: str, *, before: bool) -> None:
        self.parts.append((part, text, before))

    def _ordered(self) -> tuple[list[tuple[Evidence, str]], list[tuple[Evidence, str]]]:
        before = sorted(((p, t) for p, t, b in self.parts if b), key=lambda pt: _position(self.item.context_before, pt[0]))
        after = sorted(((p, t) for p, t, b in self.parts if not b), key=lambda pt: _position(self.item.context_after, pt[0]))
        return before, after

    def text(self) -> str:
        if not self.parts:
            return f"{self.header}{_LABEL}{self.body}"
        before, after = self._ordered()
        lines = [f"[{part.id}] {text}" for part, text in before]
        lines.append(f"[{self.item.id}] [match] {self.body}")
        lines += [f"[{part.id}] {text}" for part, text in after]
        return f"{self.header}{_PASSAGE_LABEL}" + "\n".join(lines)

    def evidence(self) -> list[Evidence]:
        """The match first (its document's best match), then the shown context in document order."""

        before, after = self._ordered()
        return [self.item, *(part for part, _ in before), *(part for part, _ in after)]


def _position(parts: tuple[Evidence, ...], part: Evidence) -> int:
    return next(index for index, candidate in enumerate(parts) if candidate is part)


__all__ = ["EvidenceContextBuilder"]
