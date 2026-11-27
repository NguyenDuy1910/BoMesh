"""Background jobs that propose concepts and labels (``item_model.md`` §4.13).

Neither job ever creates a concept: each writes ``concept_proposals`` (state
``open``) with the Documents that motivated it; a curator accepts or rejects.

- :func:`propose_from_clusters` (weekly): per classification scheme, the
  Documents the classifier was unsure about (``outcome = uncertain``, or
  ``empty`` with low confidence) are clustered by an embedding of their title
  and summary; every cluster of at least :data:`MIN_CLUSTER` Documents not
  already proposed becomes a ``new_concept`` proposal (``origin = cluster``),
  named by ONE model call. Chunk vectors stay in Qdrant without a vector read
  API and a Document's mean chunk vector costs a read of every chunk, while
  one batched embedding of short ``title + summary`` texts per scheme and week
  is cheap and needs only the database.
- :func:`propose_from_corrections` (daily): human corrections (a reviewed,
  rejected machine row plus a human row on another concept of the same
  scheme) that recur on at least :data:`MIN_RECURRENCE` Documents whose
  titles share a phrase become a ``label`` proposal for the concept people
  chose (``origin = correction``).
"""

from __future__ import annotations

import json
import logging
import math
import re
from collections import defaultdict
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from bomesh import ModelResponseClient, render_prompt
from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import (
    Concept,
    ConceptLabel,
    ConceptProposal,
    ConceptProposalItem,
    ConceptRelation,
    ConceptScheme,
    Item,
    ItemClassification,
    ItemConcept,
)
from bomesh.services.taxonomy.normalize import normalize_label

log = logging.getLogger(__name__)

#: A cluster proposes a concept from this many Documents.
MIN_CLUSTER = 5
#: Cosine similarity joining a Document to a cluster's centroid.
CLUSTER_SIMILARITY = 0.80
#: ``empty`` outcomes below this confidence join the uncertain pool.
LOW_CONFIDENCE = 0.5
#: Documents embedded per scheme and pass.
POOL_LIMIT = 2000
#: A corrected phrase proposes a label once it recurs on this many Documents.
MIN_RECURRENCE = 3
#: Title phrases considered, in words.
PHRASE_WORDS = (2, 3, 4)
#: Characters of a summary shown to the embedding and the namer.
SUMMARY_CHARACTERS = 400

Embed = Callable[[list[str]], Awaitable[list[list[float]]]]


@dataclass(frozen=True, slots=True)
class ProposalDraft:
    name: str
    definition: str | None


@dataclass(frozen=True, slots=True)
class ClusterDocument:
    title: str
    summary: str | None


#: ``(scheme name, existing top concept names, documents)`` → a draft, ``None`` when unusable.
Namer = Callable[[str, Sequence[str], Sequence[ClusterDocument]], Awaitable[ProposalDraft | None]]


def chat_namer(transport: ModelResponseClient, model: str | None) -> Namer:
    """The production :data:`Namer`: one call to the configured chat model per cluster."""

    async def name(
        scheme_name: str, existing: Sequence[str], documents: Sequence[ClusterDocument]
    ) -> ProposalDraft | None:
        prompt = render_prompt(
            "concept_proposal_name",
            scheme_name=scheme_name,
            existing_concepts="\n".join(f"- {label}" for label in existing) or "- (none)",
            documents="\n".join(
                f"- {document.title}" + (f": {document.summary}" if document.summary else "")
                for document in documents
            ),
        )
        response = await transport.responses(
            model=model, input=prompt, max_output_tokens=256, temperature=0
        )
        return _read_draft(getattr(response, "output_text", None))

    return name


async def propose_from_clusters(
    sessions: SessionFactory,
    *,
    embed: Embed,
    name: Namer,
    min_cluster: int = MIN_CLUSTER,
    similarity: float = CLUSTER_SIMILARITY,
) -> int:
    """Propose new concepts from clusters of unsure Documents; returns proposals created."""

    created = 0
    for scheme_id in await _classification_schemes(sessions):
        async with transaction_scope(sessions) as session:
            scheme = await session.get(ConceptScheme, scheme_id)
            if scheme is None:
                continue
            pool = await _uncertain_pool(session, scheme_id)
            if len(pool) < min_cluster:
                continue
            existing = await _proposed_item_sets(session, scheme_id, origin="cluster")
            top_names = await _top_concept_names(session, scheme_id)
        documents = [ClusterDocument(title, _clip(summary)) for _, title, summary in pool]
        vectors = await embed([_embedding_text(document) for document in documents])
        for members in _cluster(vectors, similarity=similarity):
            if len(members) < min_cluster:
                continue
            item_ids = {pool[index][0] for index in members}
            if any(2 * len(item_ids & proposed) > len(item_ids) for proposed in existing):
                continue
            try:
                draft = await name(scheme.scheme_name, top_names, [documents[i] for i in members])
            except Exception:  # noqa: BLE001 - one unnamed cluster waits for the next pass
                log.warning("concept proposal naming failed scheme_id=%s", scheme_id, exc_info=True)
                continue
            if draft is None:
                continue
            async with transaction_scope(sessions) as session:
                await _create_proposal(
                    session,
                    scheme,
                    kind="new_concept",
                    origin="cluster",
                    name=draft.name,
                    definition=draft.definition,
                    target_concept_id=None,
                    item_ids=sorted(item_ids),
                )
            existing.append(item_ids)
            created += 1
    return created


async def propose_from_corrections(
    sessions: SessionFactory, *, min_recurrence: int = MIN_RECURRENCE
) -> int:
    """Propose labels from corrections that recur with a shared title phrase."""

    async with transaction_scope(sessions) as session:
        rejected = aliased(ItemConcept)
        human = aliased(ItemConcept)
        rows = (
            await session.execute(
                select(human.scheme_id, human.concept_id, Item.id, Item.item_name)
                .distinct()
                .join(Item, Item.id == human.item_id)
                .join(
                    rejected,
                    and_(
                        rejected.item_id == human.item_id,
                        rejected.scheme_id == human.scheme_id,
                        rejected.concept_id != human.concept_id,
                    ),
                )
                .join(Concept, Concept.id == human.concept_id)
                .where(
                    human.source == "human",
                    human.state == "accepted",
                    rejected.source != "human",
                    rejected.state == "rejected",
                    rejected.reviewed_by_user_id.is_not(None),
                    Concept.state == "published",
                    Item.deleted_at.is_(None),
                )
            )
        ).all()
    titles: dict[tuple[UUID, UUID], dict[UUID, str]] = defaultdict(dict)
    for scheme_id, concept_id, item_id, title in rows:
        titles[(scheme_id, concept_id)][item_id] = title
    created = 0
    for (scheme_id, concept_id), documents in titles.items():
        if len(documents) < min_recurrence:
            continue
        async with transaction_scope(sessions) as session:
            scheme = await session.get(ConceptScheme, scheme_id)
            if scheme is None or scheme.deleted_at is not None:
                continue
            known = await _known_phrases(session, scheme_id, concept_id)
            phrase = _shared_phrase(documents, min_recurrence=min_recurrence, known=known)
            if phrase is None:
                continue
            text, item_ids = phrase
            await _create_proposal(
                session,
                scheme,
                kind="label",
                origin="correction",
                name=text,
                definition=None,
                target_concept_id=concept_id,
                item_ids=sorted(item_ids),
            )
            created += 1
    return created


# -- Clustering ------------------------------------------------------------------


def _cluster(vectors: Sequence[Sequence[float]], *, similarity: float) -> list[list[int]]:
    """Leader clustering on unit vectors: join the most similar centroid above ``similarity``."""

    units = [_unit(vector) for vector in vectors]
    sums: list[list[float]] = []
    members: list[list[int]] = []
    for index, vector in enumerate(units):
        best, best_score = -1, similarity
        for cluster, total in enumerate(sums):
            score = _dot(_unit(total), vector)
            if score >= best_score:
                best, best_score = cluster, score
        if best < 0:
            sums.append(list(vector))
            members.append([index])
        else:
            sums[best] = [a + b for a, b in zip(sums[best], vector, strict=True)]
            members[best].append(index)
    return members


def _unit(vector: Sequence[float]) -> list[float]:
    norm = math.sqrt(sum(value * value for value in vector)) or 1.0
    return [value / norm for value in vector]


def _dot(left: Sequence[float], right: Sequence[float]) -> float:
    return sum(a * b for a, b in zip(left, right, strict=True))


# -- Phrases ---------------------------------------------------------------------

_WORD = re.compile(r"\w+", re.UNICODE)


def _shared_phrase(
    documents: dict[UUID, str], *, min_recurrence: int, known: set[str]
) -> tuple[str, set[UUID]] | None:
    """The longest, most shared title phrase on ``min_recurrence`` Documents, not yet a label."""

    holders: dict[str, set[UUID]] = defaultdict(set)
    for item_id, title in documents.items():
        words = _WORD.findall(normalize_label(title))
        for size in PHRASE_WORDS:
            for start in range(len(words) - size + 1):
                phrase = " ".join(words[start : start + size])
                if not all(word.isdigit() for word in words[start : start + size]):
                    holders[phrase].add(item_id)
    candidates = [
        (phrase, items)
        for phrase, items in holders.items()
        if len(items) >= min_recurrence and not _overlaps(phrase, known)
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda entry: (len(entry[1]), len(entry[0].split()), entry[0]))


def _overlaps(phrase: str, known: set[str]) -> bool:
    """Whether ``phrase`` is a known label or proposal, or part of one."""

    padded = f" {phrase} "
    return any(padded in f" {text} " for text in known if text)


async def _known_phrases(session: AsyncSession, scheme_id: UUID, concept_id: UUID) -> set[str]:
    """Labels of the scheme's concepts and label proposals already made for the concept."""

    labels = (
        await session.scalars(
            select(ConceptLabel.normalized)
            .join(Concept, Concept.id == ConceptLabel.concept_id)
            .where(Concept.scheme_id == scheme_id)
        )
    ).all()
    proposed = (
        await session.scalars(
            select(ConceptProposal.proposal_name).where(
                ConceptProposal.scheme_id == scheme_id,
                ConceptProposal.kind == "label",
                ConceptProposal.target_concept_id == concept_id,
            )
        )
    ).all()
    return {" ".join(_WORD.findall(text)) for text in labels} | {
        " ".join(_WORD.findall(normalize_label(text))) for text in proposed
    }


# -- Queries ---------------------------------------------------------------------


async def _classification_schemes(sessions: SessionFactory) -> list[UUID]:
    async with transaction_scope(sessions) as session:
        return list(
            (
                await session.scalars(
                    select(ConceptScheme.id)
                    .where(
                        ConceptScheme.tenant_id.is_not(None),
                        ConceptScheme.purpose == "classification",
                        ConceptScheme.published_version.is_not(None),
                        ConceptScheme.deleted_at.is_(None),
                    )
                    .order_by(ConceptScheme.id)
                )
            ).all()
        )


async def _uncertain_pool(
    session: AsyncSession, scheme_id: UUID
) -> list[tuple[UUID, str, str | None]]:
    rows = await session.execute(
        select(Item.id, Item.item_name, Item.description)
        .join(ItemClassification, ItemClassification.item_id == Item.id)
        .where(
            ItemClassification.scheme_id == scheme_id,
            or_(
                ItemClassification.outcome == "uncertain",
                and_(
                    ItemClassification.outcome == "empty",
                    or_(
                        ItemClassification.confidence.is_(None),
                        ItemClassification.confidence < LOW_CONFIDENCE,
                    ),
                ),
            ),
            Item.deleted_at.is_(None),
        )
        .order_by(Item.id)
        .limit(POOL_LIMIT)
    )
    return [(item_id, title, summary) for item_id, title, summary in rows]


async def _proposed_item_sets(
    session: AsyncSession, scheme_id: UUID, *, origin: str
) -> list[set[UUID]]:
    rows = await session.execute(
        select(ConceptProposalItem.proposal_id, ConceptProposalItem.item_id)
        .join(ConceptProposal, ConceptProposal.id == ConceptProposalItem.proposal_id)
        .where(ConceptProposal.scheme_id == scheme_id, ConceptProposal.origin == origin)
    )
    sets: dict[UUID, set[UUID]] = defaultdict(set)
    for proposal_id, item_id in rows:
        sets[proposal_id].add(item_id)
    return list(sets.values())


async def _top_concept_names(session: AsyncSession, scheme_id: UUID) -> list[str]:
    broader = exists().where(
        ConceptRelation.source_concept_id == Concept.id, ConceptRelation.kind == "broader"
    )
    return list(
        (
            await session.scalars(
                select(ConceptLabel.label_text)
                .join(Concept, Concept.id == ConceptLabel.concept_id)
                .where(
                    Concept.scheme_id == scheme_id,
                    Concept.state == "published",
                    ConceptLabel.kind == "pref",
                    ~broader,
                )
                .order_by(ConceptLabel.label_text)
            )
        ).all()
    )


async def _create_proposal(
    session: AsyncSession,
    scheme: ConceptScheme,
    *,
    kind: str,
    origin: str,
    name: str,
    definition: str | None,
    target_concept_id: UUID | None,
    item_ids: Sequence[UUID],
) -> ConceptProposal:
    assert scheme.tenant_id is not None
    proposal = ConceptProposal(
        tenant_id=scheme.tenant_id,
        scheme_id=scheme.id,
        kind=kind,
        proposal_name=name[:255],
        definition=definition,
        target_concept_id=target_concept_id,
        origin=origin,
        state="open",
    )
    session.add(proposal)
    await session.flush()
    session.add_all(ConceptProposalItem(proposal_id=proposal.id, item_id=item) for item in item_ids)
    await session.flush()
    log.info(
        "concept proposal created scheme_id=%s kind=%s origin=%s documents=%s",
        scheme.id,
        kind,
        origin,
        len(item_ids),
    )
    return proposal


def _embedding_text(document: ClusterDocument) -> str:
    return f"{document.title}\n{document.summary}" if document.summary else document.title


def _clip(summary: str | None) -> str | None:
    return summary[:SUMMARY_CHARACTERS] if summary else None


def _read_draft(text: object) -> ProposalDraft | None:
    if not isinstance(text, str):
        return None
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        answer: Any = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None
    if not isinstance(answer, dict):
        return None
    name = answer.get("name")
    definition = answer.get("definition")
    if not isinstance(name, str) or not name.strip():
        return None
    return ProposalDraft(
        name=name.strip(),
        definition=definition.strip() if isinstance(definition, str) and definition.strip() else None,
    )


__all__ = [
    "ClusterDocument",
    "ProposalDraft",
    "chat_namer",
    "propose_from_clusters",
    "propose_from_corrections",
]
