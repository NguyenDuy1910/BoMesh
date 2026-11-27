"""``concept_rules``: ``implies`` settles a concept, ``prior`` favors one.

A rule holds when its one condition does: the ``when`` concept is held (a
settled label, the issuer, the campus, an applicability unit or program), the
Document sits under the ``when`` collection, or came from the ``when``
ingestion source. ``implies`` is one hop (T → F/A), never chained; a
``prior`` on a concept that is not a target (a top concept of a scheme that
does not assign top concepts) spreads to the target descendants with weight ×
:data:`PRIOR_DECAY` per level.
"""

from __future__ import annotations

from collections.abc import Collection, Iterable
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models.taxonomy import ConceptRule
from bomesh.services.taxonomy.snapshot import SchemeSnapshot, TaxonomySnapshot

PRIOR_DECAY = 0.8
#: The prior weight of a rule without one.
DEFAULT_PRIOR_WEIGHT = 0.5


@dataclass(frozen=True, slots=True)
class RuleView:
    id: UUID
    code: str
    when_concept_id: UUID | None
    when_collection_item_id: UUID | None
    when_source_id: UUID | None
    then_concept_id: UUID
    effect: str
    weight: float | None = None

    @property
    def when(self) -> str:
        """The condition as ``concept:<id>``, ``collection:<id>`` or ``source:<id>``."""

        if self.when_concept_id is not None:
            return f"concept:{self.when_concept_id}"
        if self.when_collection_item_id is not None:
            return f"collection:{self.when_collection_item_id}"
        return f"source:{self.when_source_id}"

    def holds(
        self,
        holding: Collection[UUID],
        ancestor_ids: Collection[UUID],
        source_id: UUID | None,
    ) -> bool:
        if self.when_concept_id is not None:
            return self.when_concept_id in holding
        if self.when_collection_item_id is not None:
            return self.when_collection_item_id in ancestor_ids
        return source_id is not None and self.when_source_id == source_id


async def load_rules(session: AsyncSession, tenant_id: UUID) -> tuple[RuleView, ...]:
    """The tenant's live rules, by code."""

    rows = await session.scalars(
        select(ConceptRule)
        .where(ConceptRule.tenant_id == tenant_id, ConceptRule.deleted_at.is_(None))
        .order_by(ConceptRule.code)
    )
    return tuple(
        RuleView(
            id=rule.id,
            code=rule.code,
            when_concept_id=rule.when_concept_id,
            when_collection_item_id=rule.when_collection_item_id,
            when_source_id=rule.when_ingestion_source_id,
            then_concept_id=rule.then_concept_id,
            effect=rule.effect,
            weight=None if rule.weight is None else float(rule.weight),
        )
        for rule in rows
    )


def _taxonomy(plan_or_taxonomy: object) -> TaxonomySnapshot:
    taxonomy = getattr(plan_or_taxonomy, "taxonomy", plan_or_taxonomy)
    if not isinstance(taxonomy, TaxonomySnapshot):
        raise TypeError("expected a ClassificationPlan or a TaxonomySnapshot")
    return taxonomy


def scheme_of(taxonomy: TaxonomySnapshot, concept_id: UUID) -> SchemeSnapshot | None:
    for scheme in taxonomy.schemes.values():
        if concept_id in scheme.concepts:
            return scheme
    return None


def is_target(scheme: SchemeSnapshot, concept_id: UUID) -> bool:
    """A published concept the scheme assigns (a top concept only when it assigns tops)."""

    concept = scheme.concepts.get(concept_id)
    return (
        concept is not None
        and concept.state == "published"
        and (scheme.assign_top_concepts or not scheme.is_top(concept_id))
    )


def implied_concepts(
    plan_or_taxonomy: object,
    rules: Iterable[RuleView],
    holding: Iterable[UUID],
    ancestor_ids: Collection[UUID],
    source_id: UUID | None,
) -> dict[UUID, RuleView]:
    """Concepts ``implies`` rules settle from what holds (one hop), with the rule that did.

    Only classification targets are implied; the first rule by code wins.
    """

    taxonomy = _taxonomy(plan_or_taxonomy)
    held = frozenset(holding)
    implied: dict[UUID, RuleView] = {}
    for rule in sorted(rules, key=lambda value: value.code):
        if rule.effect != "implies" or rule.then_concept_id in implied:
            continue
        if not rule.holds(held, ancestor_ids, source_id):
            continue
        scheme = scheme_of(taxonomy, rule.then_concept_id)
        if (
            scheme is None
            or scheme.purpose != "classification"
            or not is_target(scheme, rule.then_concept_id)
        ):
            continue
        implied[rule.then_concept_id] = rule
    return implied


def rule_evidence(rule: RuleView) -> dict[str, str]:
    """``evidence`` of a row an ``implies`` rule settles: the rule's code and, for a
    concept condition, the premise concept (what a later rejection or demotion follows)."""

    evidence = {"rule": rule.code}
    if rule.when_concept_id is not None:
        evidence["premise"] = str(rule.when_concept_id)
    return evidence


def prior_scores(
    taxonomy: TaxonomySnapshot,
    rules: Iterable[RuleView],
    holding: Collection[UUID],
    ancestor_ids: Collection[UUID],
    source_id: UUID | None,
) -> dict[UUID, tuple[float, RuleView]]:
    """Target concept → (strongest prior weight, its rule) from the ``prior`` rules that hold."""

    scores: dict[UUID, tuple[float, RuleView]] = {}

    def add(concept_id: UUID, weight: float, rule: RuleView) -> None:
        current = scores.get(concept_id)
        if weight > 0 and (current is None or weight > current[0]):
            scores[concept_id] = (weight, rule)

    for rule in sorted(rules, key=lambda value: value.code):
        if rule.effect != "prior" or not rule.holds(holding, ancestor_ids, source_id):
            continue
        scheme = scheme_of(taxonomy, rule.then_concept_id)
        if scheme is None or scheme.purpose != "classification":
            continue
        weight = DEFAULT_PRIOR_WEIGHT if rule.weight is None else rule.weight
        if is_target(scheme, rule.then_concept_id):
            add(rule.then_concept_id, weight, rule)
            continue
        for descendant, distance in scheme.descendants(rule.then_concept_id).items():
            if is_target(scheme, descendant):
                add(descendant, round(weight * PRIOR_DECAY**distance, 4), rule)
    return scores


__all__ = [
    "DEFAULT_PRIOR_WEIGHT",
    "PRIOR_DECAY",
    "RuleView",
    "implied_concepts",
    "is_target",
    "prior_scores",
    "rule_evidence",
    "scheme_of",
]
