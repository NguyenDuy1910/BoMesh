"""Embedding signals for candidates: concept-card cosine and kNN over reviewed Documents.

Both are best effort: any failure is logged and the signal is left out, so a
Document is still classified from lexical matches, rules and priors.

- **card**: a concept card is its labels, definition, scope note and
  examples, embedded with the index's embedding model once per published
  scheme version and model, stored at ``taxonomy_cards_key`` and cached
  in-process. The score is the cosine between the Document probe (title +
  leading text) and the card, kept only for the scheme's
  ``SHORTLIST_SIZE`` best cards (so it agrees with a candidate, not with all).
- **knn**: the nearest indexed chunks among Documents carrying human-decided
  accepted whole-document labels of the scheme (the
  :data:`KNN_LABELED_ITEMS` most recently decided, the Document itself
  excluded), grouped by Document; each of the :data:`KNN_ITEMS` nearest
  Documents votes ``1 / rank`` for its labels and a concept scores its share
  of the vote (0..1).
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from bomesh.db.models.knowledge import ItemConcept
from bomesh.storage import DocumentStorage, ObjectNotFoundError
from bomesh.storage.keys import IMMUTABLE_CACHE_CONTROL, taxonomy_cards_key

from .calibration import SHORTLIST_SIZE
from .rules import is_target

if TYPE_CHECKING:
    from bomesh.document_index import EmbeddingService, ItemIndex
    from bomesh.services.taxonomy.snapshot import ConceptView, SchemeSnapshot

    from .pipeline import ClassificationPlan, DocumentInput

log = logging.getLogger(__name__)

PROBE_CHARACTERS = 2000
KNN_LABELED_ITEMS = 2000
KNN_CHUNKS = 40
KNN_ITEMS = 10
#: How long the reviewed-Document set of a tenant is reused.
LABELED_TTL_SECONDS = 300.0
CARD_BATCH = 32
MAX_CARDS_BYTES = 64 * 1024 * 1024

#: (scheme_id, version, embedding model) → concept → card vector; published versions are immutable.
_CARDS: dict[tuple[UUID, int, str], dict[UUID, list[float]]] = {}

#: scheme code → concept → {kind: score}
SignalScores = dict[str, dict[UUID, dict[str, float]]]


def card_text(scheme: SchemeSnapshot, concept: ConceptView) -> str:
    """Labels + definition + scope note + examples of one concept."""

    labels = list(dict.fromkeys([*concept.pref_labels.values(), *(text for _l, text in concept.alt_labels)]))
    ancestors = [
        scheme.concepts[ancestor]
        for ancestor, _distance in sorted(scheme.ancestors(concept.id).items(), key=lambda pair: -pair[1])
    ]
    path = " › ".join(
        next(iter(view.pref_labels.values()), view.notation) for view in ancestors
    )
    lines = [" | ".join(labels) or concept.notation]
    if path:
        lines.append(path)
    lines.extend(value for value in (concept.definition, concept.scope_note) if value)
    if concept.examples:
        lines.append("; ".join(concept.examples))
    return "\n".join(lines)


def _cosine(left: Sequence[float], right: Sequence[float]) -> float:
    dot = sum(a * b for a, b in zip(left, right, strict=False))
    norm = math.sqrt(sum(a * a for a in left)) * math.sqrt(sum(b * b for b in right))
    return dot / norm if norm else 0.0


class Signals:
    """Card and kNN signal sources for one ingestion service (or run)."""

    def __init__(
        self,
        *,
        sessions: async_sessionmaker[AsyncSession],
        index: ItemIndex,
        storage: DocumentStorage | None,
    ) -> None:
        self._sessions = sessions
        self._index = index
        self._storage = storage
        #: tenant → (loaded at, item id → scheme code → concepts).
        self._labeled: dict[UUID, tuple[float, dict[str, dict[str, frozenset[UUID]]]]] = {}
        self._card_locks: dict[tuple[UUID, int, str], asyncio.Lock] = {}

    async def collect(
        self, plan: ClassificationPlan, doc: DocumentInput, schemes: Sequence[str]
    ) -> SignalScores:
        """``card`` and ``knn`` scores of the given schemes' targets; ``{}`` when unavailable."""

        if not schemes:
            return {}
        embedder = getattr(self._index, "embedder", None)
        if embedder is None:
            return {}
        probe = f"{doc.title}\n{doc.head[:PROBE_CHARACTERS]}".strip()
        if not probe:
            return {}
        try:
            vector = await embedder.embed_query(probe)
        except Exception:
            log.warning("classification probe embedding failed", exc_info=True)
            return {}
        scores: SignalScores = {code: {} for code in schemes}
        for code in schemes:
            try:
                cards = await self._cards(plan, plan.scheme(code), embedder)
            except Exception:
                log.warning("concept cards of scheme %s unavailable", code, exc_info=True)
                continue
            ranked = sorted(
                ((concept, _cosine(vector, card)) for concept, card in cards.items()),
                key=lambda pair: -pair[1],
            )[:SHORTLIST_SIZE]
            for concept, similarity in ranked:
                if similarity > 0:
                    scores[code].setdefault(concept, {})["card"] = round(min(similarity, 1.0), 4)
        try:
            await self._knn(plan, doc, schemes, probe, vector, scores)
        except Exception:
            log.warning("classification kNN signal failed", exc_info=True)
        return {code: values for code, values in scores.items() if values}

    async def _cards(
        self, plan: ClassificationPlan, scheme: SchemeSnapshot, embedder: EmbeddingService
    ) -> dict[UUID, list[float]]:
        model = embedder.embedding_model
        cache_key = (scheme.scheme_id, scheme.version, model)
        cached = _CARDS.get(cache_key)
        if cached is not None:
            return cached
        lock = self._card_locks.setdefault(cache_key, asyncio.Lock())
        async with lock:
            cached = _CARDS.get(cache_key)
            if cached is not None:
                return cached
            targets = [concept for concept in scheme.concepts.values() if is_target(scheme, concept.id)]
            key = taxonomy_cards_key(plan.workspace_code, scheme.code, scheme.version, model)
            cards = await self._stored_cards(key)
            missing = [concept for concept in targets if concept.id not in cards]
            if missing:
                for start in range(0, len(missing), CARD_BATCH):
                    batch = missing[start : start + CARD_BATCH]
                    vectors = await embedder.embed_documents([card_text(scheme, concept) for concept in batch])
                    for concept, card in zip(batch, vectors, strict=True):
                        cards[concept.id] = card
                await self._store_cards(key, scheme, model, cards)
            wanted = {concept.id for concept in targets}
            cards = {concept: card for concept, card in cards.items() if concept in wanted}
            _CARDS[cache_key] = cards
            return cards

    async def _stored_cards(self, key: str) -> dict[UUID, list[float]]:
        if self._storage is None:
            return {}
        try:
            data = await self._storage.read(key, max_bytes=MAX_CARDS_BYTES)
        except ObjectNotFoundError:
            return {}
        stored = json.loads(data)
        return {UUID(concept): list(card) for concept, card in stored.get("cards", {}).items()}

    async def _store_cards(
        self, key: str, scheme: SchemeSnapshot, model: str, cards: Mapping[UUID, list[float]]
    ) -> None:
        if self._storage is None:
            return
        payload = {
            "scheme": scheme.code,
            "version": scheme.version,
            "embedding_model": model,
            "cards": {str(concept): card for concept, card in cards.items()},
        }
        try:
            await asyncio.to_thread(
                self._storage.put_bytes,
                json.dumps(payload, separators=(",", ":")).encode("utf-8"),
                key,
                content_type="application/json",
                cache_control=IMMUTABLE_CACHE_CONTROL,
            )
        except Exception:
            log.warning("could not store concept cards at %s", key, exc_info=True)

    async def _labeled_items(self, plan: ClassificationPlan) -> dict[str, dict[str, frozenset[UUID]]]:
        """Recently human-decided Documents → scheme code → accepted whole-document concepts."""

        now = time.monotonic()
        cached = self._labeled.get(plan.tenant_id)
        if cached is not None and now - cached[0] < LABELED_TTL_SECONDS:
            return cached[1]
        codes = {
            scheme.scheme_id: code
            for code, scheme in plan.taxonomy.schemes.items()
            if scheme.purpose == "classification"
        }
        decided = (
            ItemConcept.scheme_id.in_(codes),
            ItemConcept.state == "accepted",
            ItemConcept.section_ref.is_(None),
            or_(ItemConcept.source == "human", ItemConcept.reviewed_by_user_id.is_not(None)),
        )
        recent = (
            select(ItemConcept.item_id)
            .where(*decided)
            .group_by(ItemConcept.item_id)
            .order_by(func.max(ItemConcept.updated_at).desc())
            .limit(KNN_LABELED_ITEMS)
            .subquery()
        )
        async with self._sessions() as session:
            rows = (
                await session.execute(
                    select(ItemConcept.item_id, ItemConcept.scheme_id, ItemConcept.concept_id).where(
                        *decided, ItemConcept.item_id.in_(select(recent.c.item_id))
                    )
                )
            ).all()
        labeled: dict[str, dict[str, set[UUID]]] = {}
        for item_id, scheme_id, concept_id in rows:
            labeled.setdefault(str(item_id), {}).setdefault(codes[scheme_id], set()).add(concept_id)
        frozen = {
            item: {code: frozenset(concepts) for code, concepts in by_scheme.items()}
            for item, by_scheme in labeled.items()
        }
        self._labeled[plan.tenant_id] = (now, frozen)
        return frozen

    async def _knn(
        self,
        plan: ClassificationPlan,
        doc: DocumentInput,
        schemes: Sequence[str],
        probe: str,
        vector: list[float],
        scores: SignalScores,
    ) -> None:
        labeled = await self._labeled_items(plan)
        own = str(doc.item_id) if doc.item_id is not None else None
        candidates = tuple(
            item
            for item, by_scheme in labeled.items()
            if item != own and any(code in by_scheme for code in schemes)
        )
        if not candidates:
            return
        chunks: list[Any] = await self._index.nearest_items(
            probe,
            vector,
            tenant_id=str(plan.tenant_id),
            document_item_ids=candidates,
            limit=KNN_CHUNKS,
        )
        nearest = list(dict.fromkeys(chunk.item_id for chunk in chunks if chunk.item_id != own))[:KNN_ITEMS]
        for code in schemes:
            votes: dict[UUID, float] = {}
            total = 0.0
            for rank, item in enumerate(nearest):
                concepts = labeled.get(item, {}).get(code)
                if not concepts:
                    continue
                weight = 1.0 / (rank + 1)
                total += weight
                for concept in concepts:
                    votes[concept] = votes.get(concept, 0.0) + weight
            if not total:
                continue
            scheme = plan.scheme(code)
            for concept, vote in votes.items():
                if is_target(scheme, concept):
                    scores[code].setdefault(concept, {})["knn"] = round(vote / total, 4)


__all__ = ["KNN_LABELED_ITEMS", "Signals", "card_text"]
