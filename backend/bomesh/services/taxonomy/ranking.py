"""Facet-aware ranking of retrieval hits (``conversation_loop.md`` "Knowledge retrieval"; ``api_design.md`` SearchItems).

Shared by SearchItems and the agent's ``knowledge_search``:

- :func:`plan_query` interprets a query against the published taxonomy and loads
  the searcher's affiliation (``member_affiliations``);
- :func:`facet_items` lists the documents a reading's concepts match (accepted
  labels, hierarchical through ``concept_closure``; OR within a scheme, AND across),
  for the recall pass that narrows the index search with ``within_item_ids``;
- :func:`item_signals` reads, in two statements, what the boost needs per document;
- :func:`rank` fuses the plain and recall passes (RRF) and multiplies each chunk's
  score by ``1 + w·match`` (``match`` = share of the reading's schemes the chunk's
  document — or its section, for section labels — carries), the applicability boost,
  recency for a time-sensitive document type, and the supersession demotion. A
  document whose applicability is *explicit* and names another unit or program than
  the searcher's, which the query does not name, is dropped (§8.4).

Facets never filter hits otherwise: a misread query only loses its boost.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, and_, func, select, true
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from bomesh.db.models import (
    Concept,
    ConceptClosure,
    ConceptLabel,
    ConceptScheme,
    DocumentApplicability,
    DocumentProfile,
    DocumentSupersession,
    Item,
    ItemConcept,
    ItemRevision,
    MemberAffiliation,
)
from bomesh.document_index import ContextualChunk
from bomesh.services.taxonomy.authority import (
    APPLICABILITY_AUTO_THRESHOLD,
    PROGRAM_SCHEME,
    program_faculties,
)
from bomesh.services.taxonomy.query import Interpretation, Option, interpret, label_index
from bomesh.services.taxonomy.snapshot import TaxonomySnapshot, load_published

#: ``w`` of ``1 + w·match``.
CONCEPT_BOOST = 0.5
#: A document applying to the searcher's program, unit (or a unit through the
#: program's faculty) or cohort, or to a unit the query names.
APPLICABILITY_BOOST = 0.3
#: Recency for a time-sensitive document type: ``1 + w·½^(age / half-life)``.
RECENCY_BOOST = 1.0
RECENCY_HALF_LIFE_DAYS = 90.0
#: Score factor of a superseded document unless the query asks for history.
SUPERSEDED_FACTOR = 0.5
#: Documents a recall pass may narrow to (readable ones matching the reading's facets).
RECALL_LIMIT = 5000
#: Reciprocal-rank fusion constant.
RRF_K = 60
#: Documents per ambiguity group.
GROUP_SIZE = 5

_PREFERRED_LANGUAGE = "vi"


@dataclass(frozen=True, slots=True)
class Affiliation:
    """The searcher's ``Member.affiliation`` as concept sets.

    ``base`` are the programs and units the member belongs to (a program's faculty
    included); ``scope`` adds their ancestors (a document of the whole school or
    faculty applies to the member)."""

    base: frozenset[UUID]
    scope: frozenset[UUID]
    cohort: int | None


@dataclass(frozen=True, slots=True)
class Reading:
    """One way to read the query: the resolved terms, plus one option of the grouped
    ambiguity (``option`` None = the resolved terms alone)."""

    option: Option | None
    facets: Mapping[str, frozenset[UUID]]
    time_sensitive: bool

    @property
    def concepts(self) -> frozenset[UUID]:
        return frozenset(cid for ids in self.facets.values() for cid in ids)


@dataclass(frozen=True, slots=True)
class QueryPlan:
    taxonomy: TaxonomySnapshot
    interpretation: Interpretation
    affiliation: Affiliation | None
    #: Org-unit/program concepts the query names, with their hierarchy and
    #: faculty links: a document applying to one of them is never excluded.
    named: frozenset[UUID]

    def reading(self, option: Option | None = None) -> Reading:
        facets = self.interpretation.facets(option)
        return Reading(
            option=option,
            facets=facets,
            time_sensitive=any(
                (concept := self.taxonomy.by_concept(cid)) is not None and concept.time_sensitive
                for ids in facets.values()
                for cid in ids
            ),
        )

    def readings(self) -> tuple[Reading, ...]:
        """The grouped options' readings (empty without an ambiguity)."""
        return tuple(self.reading(option) for option in self.interpretation.options())

    @property
    def active(self) -> bool:
        """Whether ranking changes anything for this query and searcher."""
        return not self.interpretation.empty or self.affiliation is not None


async def plan_queries(
    session: AsyncSession, tenant_id: UUID, user_id: UUID | None, queries: Sequence[str]
) -> list[QueryPlan]:
    """Each query's interpretation, with the searcher's affiliation (read once)."""
    taxonomy = await load_published(session, tenant_id)
    affiliation = (
        await load_affiliation(session, taxonomy, tenant_id, user_id)
        if user_id is not None and taxonomy.schemes
        else None
    )
    index = label_index(taxonomy) if taxonomy.schemes else None
    plans: list[QueryPlan] = []
    for query in queries:
        interpretation = interpret(index, query) if index is not None else Interpretation()
        plans.append(
            QueryPlan(
                taxonomy=taxonomy,
                interpretation=interpretation,
                affiliation=affiliation,
                named=_with_hierarchy(taxonomy, interpretation.authorities, descendants=True),
            )
        )
    return plans


async def plan_query(
    session: AsyncSession, tenant_id: UUID, user_id: UUID | None, query: str
) -> QueryPlan:
    """The interpretation of ``query`` and the searcher's affiliation."""
    return (await plan_queries(session, tenant_id, user_id, [query]))[0]


def plan_concepts(plan: QueryPlan) -> set[UUID]:
    """Every concept the plan's interpretation names (for :func:`concept_refs`)."""
    interpretation = plan.interpretation
    found = {cid for term in interpretation.terms for cid in term.concepts}
    found.update(
        cid
        for ambiguity in interpretation.ambiguities
        for option in ambiguity.options
        for cid in option.concepts
    )
    found.update(interpretation.authorities)
    return found


def reading_label(
    plan: QueryPlan, scheme: str, concepts: Iterable[UUID], names: Mapping[UUID, ConceptRef]
) -> str:
    """``Scheme name: Concept / Concept`` (current concept names)."""
    snapshot = plan.taxonomy.schemes.get(scheme)
    title = snapshot.name if snapshot is not None else scheme
    shown = " / ".join(names[cid].display_name for cid in concepts if cid in names)
    return f"{title}: {shown}" if shown else title


async def load_affiliation(
    session: AsyncSession, taxonomy: TaxonomySnapshot, tenant_id: UUID, user_id: UUID
) -> Affiliation | None:
    rows = (
        await session.execute(
            select(MemberAffiliation.concept_id, MemberAffiliation.cohort).where(
                MemberAffiliation.tenant_id == tenant_id, MemberAffiliation.user_id == user_id
            )
        )
    ).all()
    if not rows:
        return None
    direct = {concept_id for concept_id, _ in rows}
    base = direct | {unit for cid in direct for unit in program_faculties(taxonomy, cid)}
    cohorts = [cohort for _, cohort in rows if cohort is not None]
    return Affiliation(
        base=frozenset(base),
        scope=_with_hierarchy(taxonomy, base, descendants=False),
        cohort=max(cohorts) if cohorts else None,
    )


def _ancestors(taxonomy: TaxonomySnapshot, concept_id: UUID) -> set[UUID]:
    for scheme in taxonomy.schemes.values():
        if concept_id in scheme.concepts:
            return set(scheme.ancestors(concept_id))
    return set()


def _descendants(taxonomy: TaxonomySnapshot, concept_id: UUID) -> set[UUID]:
    for scheme in taxonomy.schemes.values():
        if concept_id in scheme.concepts:
            return set(scheme.descendants(concept_id))
    return set()


def _with_hierarchy(
    taxonomy: TaxonomySnapshot, concepts: Iterable[UUID], *, descendants: bool
) -> frozenset[UUID]:
    """``concepts`` with their ancestors, their programs' faculties (and those
    faculties' ancestors) and, with ``descendants``, everything below them and the
    programs of the units among them."""
    found: set[UUID] = set()
    for concept_id in concepts:
        found.add(concept_id)
        found.update(_ancestors(taxonomy, concept_id))
        for unit in program_faculties(taxonomy, concept_id):
            found.add(unit)
            found.update(_ancestors(taxonomy, unit))
        if descendants:
            below = {concept_id, *_descendants(taxonomy, concept_id)}
            found.update(below)
            programs = taxonomy.schemes.get(PROGRAM_SCHEME)
            if programs is not None:
                found.update(
                    program
                    for program in programs.concepts
                    if program_faculties(taxonomy, program) & below
                )
    return frozenset(found)


# -- Facet matching ----------------------------------------------------------------------


def labeled_with(
    concept: Any, *, state: str = "accepted", item_id: ColumnElement[Any] = Item.id
) -> ColumnElement[bool]:
    """``item_id`` carries a label in ``state`` on ``concept`` or a concept below it
    (``concept_closure`` of the published graph; section labels count)."""
    return item_id.in_(
        select(ItemConcept.item_id)
        .join(ConceptClosure, ConceptClosure.descendant_id == ItemConcept.concept_id)
        .where(ConceptClosure.ancestor_id == concept, ItemConcept.state == state)
    )


def facet_condition(
    facets: Mapping[str, Iterable[UUID]], item_id: ColumnElement[Any] = Item.id
) -> ColumnElement[bool]:
    """AND across schemes of (OR within the scheme) :func:`labeled_with`."""
    return and_(
        true(),
        *(
            item_id.in_(
                select(ItemConcept.item_id)
                .join(ConceptClosure, ConceptClosure.descendant_id == ItemConcept.concept_id)
                .where(
                    ConceptClosure.ancestor_id.in_(list(concepts)),
                    ItemConcept.state == "accepted",
                )
            )
            for concepts in facets.values()
            if concepts
        ),
    )


async def facet_items(
    session: AsyncSession, reading: Reading, admitted: ColumnElement[bool]
) -> list[UUID]:
    """Documents ``admitted`` (the caller's visibility) that match the reading's facets,
    most recently updated first, at most :data:`RECALL_LIMIT`."""
    if not reading.facets:
        return []
    return list(
        await session.scalars(
            select(Item.id)
            .where(Item.item_kind == "document", admitted, facet_condition(reading.facets))
            .order_by(Item.updated_at.desc(), Item.id)
            .limit(RECALL_LIMIT)
        )
    )


# -- Signals ------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ItemSignals:
    #: Accepted whole-document concepts with their ancestors.
    concepts: frozenset[UUID] = frozenset()
    #: Level-1 heading → accepted section concepts with their ancestors.
    sections: Mapping[str, frozenset[UUID]] | None = None
    level: str | None = None
    applies_to: tuple[UUID, ...] = ()
    cohorts: tuple[int, ...] = ()
    #: Applicability set by a person, or extracted with confidence ≥ the auto threshold.
    explicit: bool = False
    #: ``issued_on``, else the publish date of the current content.
    issued: date | None = None
    superseded: bool = False


_SUPERSEDER = aliased(Item, name="superseder")
_CURRENT = aliased(ItemRevision, name="signal_revision")


async def item_signals(
    session: AsyncSession, item_ids: Iterable[UUID]
) -> dict[UUID, ItemSignals]:
    """What ranking reads about ``item_ids``: labels (one statement) and profile,
    applicability, publish time and supersession (one statement)."""
    ids = list(dict.fromkeys(item_ids))
    if not ids:
        return {}
    whole: dict[UUID, set[UUID]] = {}
    sections: dict[UUID, dict[str, set[UUID]]] = {}
    labels = await session.execute(
        select(
            ItemConcept.item_id,
            ConceptClosure.ancestor_id,
            ItemConcept.section_ref.is_not(None),
            ItemConcept.evidence["section"].astext,
        )
        .join(ConceptClosure, ConceptClosure.descendant_id == ItemConcept.concept_id)
        .where(ItemConcept.item_id.in_(ids), ItemConcept.state == "accepted")
    )
    for item_id, concept_id, is_section, heading in labels.tuples():
        if not is_section:
            whole.setdefault(item_id, set()).add(concept_id)
        elif heading:
            sections.setdefault(item_id, {}).setdefault(heading, set()).add(concept_id)
    applies_to = (
        select(func.array_agg(DocumentApplicability.concept_id))
        .where(DocumentApplicability.item_id == Item.id)
        .correlate(Item)
        .scalar_subquery()
    )
    superseded = (
        select(DocumentSupersession.superseded_item_id)
        .join(_SUPERSEDER, _SUPERSEDER.id == DocumentSupersession.item_id)
        .where(
            DocumentSupersession.superseded_item_id == Item.id,
            _SUPERSEDER.deleted_at.is_(None),
        )
        .correlate(Item)
        .exists()
    )
    published = func.coalesce(
        select(_CURRENT.created_at)
        .where(_CURRENT.id == Item.current_revision_id)
        .correlate(Item)
        .scalar_subquery(),
        Item.created_at,
    )
    rows = await session.execute(
        select(
            Item.id,
            DocumentProfile.applicability_level,
            DocumentProfile.applicability_cohorts,
            DocumentProfile.applicability_confidence,
            DocumentProfile.field_sources["applicability"].astext,
            DocumentProfile.issued_on,
            published,
            applies_to,
            superseded,
        )
        .outerjoin(DocumentProfile, DocumentProfile.item_id == Item.id)
        .where(Item.id.in_(ids))
    )
    signals: dict[UUID, ItemSignals] = {}
    for (
        item_id,
        level,
        cohorts,
        confidence,
        source,
        issued_on,
        publish_time,
        concepts,
        is_superseded,
    ) in rows.tuples():
        explicit = source == "human" or (
            source == "extracted"
            and confidence is not None
            and confidence >= APPLICABILITY_AUTO_THRESHOLD
        )
        signals[item_id] = ItemSignals(
            concepts=frozenset(whole.get(item_id, ())),
            sections={
                heading: frozenset(values)
                for heading, values in sections.get(item_id, {}).items()
            },
            level=level,
            applies_to=tuple(value for value in (concepts or ()) if value is not None),
            cohorts=tuple(cohorts or ()),
            explicit=explicit,
            issued=issued_on or (publish_time.date() if publish_time is not None else None),
            superseded=bool(is_superseded),
        )
    return signals


def carries(signals: ItemSignals | None, concepts: Iterable[UUID]) -> bool:
    """Whether the document has an accepted label (whole or section) on one of
    ``concepts`` or below it: the ``document.concepts`` filter of those concepts ORed."""
    if signals is None:
        return False
    wanted = set(concepts)
    if wanted & signals.concepts:
        return True
    return any(wanted & values for values in (signals.sections or {}).values())


# -- Scoring ------------------------------------------------------------------------------


def applicability(plan: QueryPlan, signals: ItemSignals) -> str:
    """``exclude``, ``boost`` or ``keep`` (§8.4 with D2)."""
    if signals.applies_to and plan.named and any(
        concept in plan.named for concept in signals.applies_to
    ):
        return "boost"
    affiliation = plan.affiliation
    if affiliation is None or signals.level in (None, "institution"):
        return "keep"
    if signals.applies_to:
        if any(_applies(plan.taxonomy, concept, affiliation) for concept in signals.applies_to):
            return "boost"
        return "exclude" if signals.explicit else "keep"
    if signals.cohorts and affiliation.cohort in signals.cohorts:
        return "boost"
    return "keep"


def _applies(taxonomy: TaxonomySnapshot, concept: UUID, affiliation: Affiliation) -> bool:
    """A document applying to ``concept`` applies to the member: the concept is one of
    theirs or above them (their school, faculty), or below one of theirs (a unit of
    their faculty)."""
    if concept in affiliation.scope:
        return True
    return bool(_ancestors(taxonomy, concept) & affiliation.base) or bool(
        program_faculties(taxonomy, concept) & affiliation.base
    )


def factor(
    plan: QueryPlan,
    reading: Reading,
    signals: ItemSignals | None,
    *,
    section: str | None = None,
    today: date | None = None,
) -> float | None:
    """The chunk's score multiplier; None drops it (explicitly another unit's document)."""
    if signals is None:
        return 1.0
    decision = applicability(plan, signals)
    if decision == "exclude":
        return None
    value = 1.0
    if reading.facets:
        concepts = signals.concepts
        if section is not None and signals.sections:
            concepts = concepts | signals.sections.get(section, frozenset())
        matched = sum(1 for ids in reading.facets.values() if ids & concepts)
        value *= 1 + CONCEPT_BOOST * matched / len(reading.facets)
    if decision == "boost":
        value *= 1 + APPLICABILITY_BOOST
    if reading.time_sensitive and signals.issued is not None:
        age = max(((today or datetime.now(UTC).date()) - signals.issued).days, 0)
        value *= 1 + RECENCY_BOOST * 0.5 ** (age / RECENCY_HALF_LIFE_DAYS)
    if signals.superseded and not plan.interpretation.asks_history:
        value *= SUPERSEDED_FACTOR
    return value


def fuse(passes: Sequence[Sequence[ContextualChunk]]) -> list[ContextualChunk]:
    """One list of the passes' chunks: a single pass keeps its scores; several are
    fused by reciprocal rank (each chunk once, scored ``Σ 1/(k + rank)``)."""
    non_empty = [chunks for chunks in passes if chunks]
    if len(non_empty) <= 1:
        return list(non_empty[0]) if non_empty else []
    scores: dict[str, float] = {}
    first: dict[str, ContextualChunk] = {}
    for chunks in non_empty:
        for rank, chunk in enumerate(chunks, start=1):
            scores[chunk.id] = scores.get(chunk.id, 0.0) + 1.0 / (RRF_K + rank)
            first.setdefault(chunk.id, chunk)
    return [
        first[chunk_id].model_copy(update={"relevance_score": score})
        for chunk_id, score in sorted(scores.items(), key=lambda entry: (-entry[1], entry[0]))
    ]


def rank(
    readings: Sequence[tuple[QueryPlan, Reading]],
    passes: Sequence[Sequence[ContextualChunk]],
    signals: Mapping[UUID, ItemSignals],
) -> list[ContextualChunk]:
    """The passes fused, boosted and filtered (§8.3–8.5), strongest first.

    With several readings (one per query of a multi-query search) a chunk takes its
    best multiplier, and is dropped only when every reading excludes it."""
    today = datetime.now(UTC).date()
    ranked: list[ContextualChunk] = []
    for chunk in fuse(passes):
        section = chunk.context.section_path[0] if chunk.context.section_path else None
        item = signals.get(UUID(chunk.item_id))
        multipliers = [
            value
            for plan, reading in readings
            if (value := factor(plan, reading, item, section=section, today=today)) is not None
        ]
        if not multipliers:
            continue
        score = (chunk.relevance_score or 0.0) * max(multipliers)
        ranked.append(chunk.model_copy(update={"relevance_score": score}))
    ranked.sort(key=lambda chunk: (-(chunk.relevance_score or 0.0), chunk.id))
    return ranked


# -- Names --------------------------------------------------------------------------------


def preferred_label(concept_id: ColumnElement[Any]) -> ColumnElement[Any]:
    """The concept's CURRENT prefLabel (people read current names), Vietnamese first."""
    return (
        select(ConceptLabel.label_text)
        .where(ConceptLabel.concept_id == concept_id, ConceptLabel.kind == "pref")
        .order_by(
            (ConceptLabel.language_code != _PREFERRED_LANGUAGE), ConceptLabel.language_code
        )
        .limit(1)
        .scalar_subquery()
    )


@dataclass(frozen=True, slots=True)
class ConceptRef:
    scheme: str
    notation: str
    display_name: str


async def concept_refs(
    session: AsyncSession, concept_ids: Iterable[UUID]
) -> dict[UUID, ConceptRef]:
    """Scheme code, notation and current display name of each concept (one statement)."""
    ids = list(dict.fromkeys(concept_ids))
    if not ids:
        return {}
    rows = await session.execute(
        select(Concept.id, ConceptScheme.code, Concept.notation, preferred_label(Concept.id))
        .join(ConceptScheme, ConceptScheme.id == Concept.scheme_id)
        .where(Concept.id.in_(ids))
    )
    return {
        concept_id: ConceptRef(scheme=scheme, notation=notation, display_name=name or notation)
        for concept_id, scheme, notation, name in rows.tuples()
    }


def scheme_concept(workspace_id: UUID, scheme: str, notation: str) -> Any:
    """The ID of concept ``notation`` of the workspace's scheme ``scheme`` (scalar subquery)."""
    return (
        select(Concept.id)
        .join(ConceptScheme, ConceptScheme.id == Concept.scheme_id)
        .where(
            ConceptScheme.tenant_id == workspace_id,
            ConceptScheme.code == scheme,
            ConceptScheme.deleted_at.is_(None),
            Concept.notation == notation,
        )
        .scalar_subquery()
    )


__all__ = [
    "APPLICABILITY_BOOST",
    "CONCEPT_BOOST",
    "GROUP_SIZE",
    "RECALL_LIMIT",
    "Affiliation",
    "ConceptRef",
    "ItemSignals",
    "QueryPlan",
    "Reading",
    "applicability",
    "carries",
    "concept_refs",
    "facet_condition",
    "facet_items",
    "factor",
    "fuse",
    "item_signals",
    "labeled_with",
    "load_affiliation",
    "plan_concepts",
    "plan_queries",
    "plan_query",
    "preferred_label",
    "rank",
    "reading_label",
    "scheme_concept",
]
