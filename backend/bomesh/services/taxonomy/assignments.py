"""Concept labels of Documents (``item_concepts``) and classification outcomes (``item_classifications``).

The one writer of both. Machines (processing, taxonomy runs) replace their own
rows; people decide through UpdateItem, contribution approval and
``:confirmAssignments`` / ``:rejectAssignments``.

Rules (``item_model.md`` §4.13, ``api_design.md`` ConceptScheme ``:publish``, ``document_contract.md`` "Processing"):

- a human-decided row (``source = human`` or ``reviewed_by_user_id`` set) is
  never touched by machines; a concept a person rejected on a Document (or one
  of its sections) is never suggested again by machines;
- machine rows not chosen again are deleted;
- when a scheme has human-accepted whole-document labels, machine rows of it
  are written ``suggested``;
- accepted whole-document labels per scheme stay within ``max_labels`` (the
  extra ones are written ``suggested``) and carry exactly one primary when the
  scheme ``has_primary`` (the classifier's primary, else the highest confidence).

Writes go out in an order the immediate unique indexes accept (delete, demote,
then insert/promote); the cardinality trigger is deferred to commit.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import Select, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import (
    Concept,
    ConceptScheme,
    Contribution,
    DocumentApplicability,
    DocumentProfile,
    ExternalResource,
    Item,
    ItemClassification,
    ItemConcept,
)
from bomesh.errors import InvalidArgument, NotFound
from bomesh.iam.authorizer import item_ancestry
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.knowledge_curation.access import (
    deciding_collection,
    open_new_document_contributions,
)
from bomesh.services.taxonomy.classification import (
    CLASSIFIER_VERSION,
    MachineAssignment,
    SchemeResult,
    implied_concepts,
    load_rules,
)
from bomesh.services.taxonomy.classification.calibration import RULE_CONFIDENCE
from bomesh.services.taxonomy.classification.rules import rule_evidence
from bomesh.services.taxonomy.names import concept_name
from bomesh.services.taxonomy.snapshot import (
    SchemeSnapshot,
    TaxonomySnapshot,
    load_published,
)

#: The UpdateItem field human label edits are validated as.
CONCEPTS_FIELD = "document.concepts"

#: (concept, section_ref): one live label.
_Key = tuple[UUID, str | None]


@dataclass(frozen=True, slots=True)
class ConceptEntry:
    """One whole-document label a person keeps (UpdateItem ``document.concepts``): accepted."""

    concept_id: UUID
    primary: bool = False


@dataclass(frozen=True, slots=True)
class ConceptAssignmentRecord:
    """One live label as reads show it (``Document.concepts[]``)."""

    concept_id: UUID
    notation: str
    scheme_id: UUID
    scheme_code: str
    primary: bool
    section_ref: str | None
    confidence: float | None
    #: rule | lexical | knn | llm | human
    source: str
    #: suggested | accepted
    state: str
    quote: str | None
    reviewer_id: UUID | None
    reviewed_at: datetime | None


def _human_decided(row: ItemConcept) -> bool:
    return row.source == "human" or row.reviewed_by_user_id is not None


def _now() -> datetime:
    return datetime.now(UTC)


# ---- Machine writes ----------------------------------------------------------


async def replace_machine_assignments(
    session: AsyncSession,
    item_id: UUID,
    results: Sequence[SchemeResult],
    *,
    revision_number: int | None,
    classifier_version: str = CLASSIFIER_VERSION,
    suggest_only: bool = False,
) -> None:
    """Write one classification of the Document: its machine rows and outcome per scheme.

    A ``failed`` result keeps the scheme's rows and records the outcome only.
    ``revision_number`` is the classified revision (section labels carry it);
    ``suggest_only`` writes every machine row ``suggested``.
    """

    for result in results:
        if result.outcome != "failed":
            await _write_machine_rows(
                session,
                item_id,
                result.scheme_id,
                result.scheme_version,
                result.assignments,
                result.replace_concepts,
                revision_number=revision_number,
                classifier_version=classifier_version,
                suggest_only=suggest_only,
            )
        await session.execute(
            pg_insert(ItemClassification)
            .values(
                item_id=item_id,
                scheme_id=result.scheme_id,
                outcome=result.outcome,
                confidence=result.confidence,
                scheme_version=result.scheme_version,
                classifier_version=classifier_version,
                revision_number=revision_number,
                classified_at=_now(),
            )
            .on_conflict_do_update(
                index_elements=[
                    ItemClassification.item_id,
                    ItemClassification.scheme_id,
                ],
                set_={
                    "outcome": result.outcome,
                    "confidence": result.confidence,
                    "scheme_version": result.scheme_version,
                    "classifier_version": classifier_version,
                    "revision_number": revision_number,
                    "classified_at": _now(),
                },
            )
        )


async def _write_machine_rows(
    session: AsyncSession,
    item_id: UUID,
    scheme_id: UUID,
    scheme_version: int | None,
    assignments: Iterable[MachineAssignment],
    replace_concepts: frozenset[UUID] | None,
    *,
    revision_number: int | None,
    classifier_version: str,
    suggest_only: bool,
) -> int:
    """Replace the machine rows of one (Document, scheme); returns rows inserted or deleted.

    ``replace_concepts`` (rerank) limits both the rows replaced and the rows
    written to those concepts.
    """

    scheme = await session.get(ConceptScheme, scheme_id)
    if scheme is None:
        return 0
    rows = list(
        await session.scalars(
            select(ItemConcept)
            .where(ItemConcept.item_id == item_id, ItemConcept.scheme_id == scheme_id)
            .with_for_update()
        )
    )
    blocked: set[_Key] = set()
    human_live: set[_Key] = set()
    human_accepted: list[ItemConcept] = []
    existing: dict[_Key, ItemConcept] = {}
    kept: list[ItemConcept] = []
    for row in rows:
        key = (row.concept_id, row.section_ref)
        if _human_decided(row):
            if row.state == "rejected":
                blocked.add(key)
            else:
                human_live.add(key)
                if row.state == "accepted" and row.section_ref is None:
                    human_accepted.append(row)
        elif row.state == "rejected":
            continue
        elif replace_concepts is None or row.concept_id in replace_concepts:
            existing[key] = row
        else:
            kept.append(row)

    chosen: dict[_Key, MachineAssignment] = {}
    for assignment in assignments:
        if assignment.section_ref is not None and revision_number is None:
            continue
        if (
            replace_concepts is not None
            and assignment.concept_id not in replace_concepts
        ):
            continue
        key = (assignment.concept_id, assignment.section_ref)
        if key in blocked or key in human_live:
            continue
        previous = chosen.get(key)
        if previous is None or _rank(assignment) < _rank(previous):
            chosen[key] = assignment

    states = {
        key: (
            "suggested"
            if suggest_only
            or assignment.state != "accepted"
            or (key[1] is None and human_accepted)
            else "accepted"
        )
        for key, assignment in chosen.items()
    }
    kept_accepted = [
        row for row in kept if row.state == "accepted" and row.section_ref is None
    ]
    accepted = sorted(
        (
            key
            for key, state in states.items()
            if state == "accepted" and key[1] is None
        ),
        key=lambda key: _rank(chosen[key]),
    )
    if scheme.max_labels is not None:
        room = max(scheme.max_labels - len(human_accepted) - len(kept_accepted), 0)
        for key in accepted[room:]:
            states[key] = "suggested"
        accepted = accepted[:room]

    primary_key: _Key | None = None
    promote: ItemConcept | None = None
    if scheme.has_primary and not any(
        row.is_primary for row in (*human_accepted, *kept_accepted)
    ):
        if accepted:
            primary_key = accepted[0]
        elif kept_accepted:
            promote = max(kept_accepted, key=lambda row: row.confidence or 0.0)

    changed = 0
    for key, row in existing.items():
        if key not in chosen:
            await session.delete(row)
            changed += 1
    await session.flush()
    for key, row in existing.items():
        if key in chosen and row.is_primary and key != primary_key:
            row.is_primary = False
    await session.flush()
    for key, assignment in chosen.items():
        values: dict[str, Any] = {
            "is_primary": key == primary_key,
            "revision_number": revision_number if key[1] is not None else None,
            "confidence": assignment.confidence,
            "source": assignment.source,
            "state": states[key],
            "scheme_version": scheme_version,
            "classifier_version": classifier_version,
            "evidence": dict(assignment.evidence),
        }
        row = existing.get(key)
        if row is None:
            session.add(
                ItemConcept(
                    item_id=item_id,
                    concept_id=key[0],
                    scheme_id=scheme_id,
                    section_ref=key[1],
                    **values,
                )
            )
            changed += 1
        else:
            for name, value in values.items():
                setattr(row, name, value)
    if promote is not None:
        promote.is_primary = True
    await session.flush()
    return changed


def _rank(assignment: MachineAssignment) -> tuple[bool, float]:
    """The classifier's primary first, then the highest confidence."""
    return (not assignment.primary, -assignment.confidence)


# ---- Human writes ------------------------------------------------------------


async def set_human_assignments(
    session: AsyncSession,
    ctx: RequestContext,
    item_id: UUID,
    scheme_code: str,
    concept_ids: Sequence[UUID],
    primary: UUID | None,
) -> None:
    """A person sets one scheme's whole-document labels (contribution approval).

    Listed concepts are accepted, every other live label of the scheme is
    rejected. ``primary`` must be listed; without it a ``has_primary`` scheme
    takes the first concept. INVALID_ARGUMENT (``document.concepts``) on a
    concept that is not a published, assignable concept of the scheme.
    """

    item = await _document(session, item_id)
    taxonomy = await load_published(session, item.tenant_id)
    scheme = taxonomy.schemes.get(scheme_code)
    if scheme is None or scheme.purpose != "classification":
        raise InvalidArgument.for_field(
            CONCEPTS_FIELD, f"{scheme_code} is not a published classification scheme."
        )
    if primary is not None and primary not in concept_ids:
        raise InvalidArgument.for_field(
            CONCEPTS_FIELD, "The primary concept must be one of the concepts."
        )
    entries = [
        ConceptEntry(concept_id, primary=concept_id == primary)
        for concept_id in concept_ids
    ]
    for entry in entries:
        _assignable(scheme, entry.concept_id)
    await _set_scheme_labels(session, ctx, item, scheme, entries)


async def set_document_concepts(
    session: AsyncSession,
    ctx: RequestContext,
    item_id: UUID,
    entries: Sequence[ConceptEntry],
) -> None:
    """UpdateItem ``document.concepts``: the person's whole-document labels of every scheme.

    A scheme without entries loses its live labels (rejected); section labels
    are kept. Validated as ``document.concepts``.
    """

    item = await _document(session, item_id)
    taxonomy = await load_published(session, item.tenant_id)
    by_scheme: dict[str, list[ConceptEntry]] = defaultdict(list)
    for entry in entries:
        view = taxonomy.by_concept(entry.concept_id)
        scheme = taxonomy.schemes.get(view.scheme_code) if view is not None else None
        if scheme is None or scheme.purpose != "classification":
            raise InvalidArgument.for_field(
                CONCEPTS_FIELD,
                "Each concept must be a published concept of a classification scheme.",
            )
        _assignable(scheme, entry.concept_id)
        by_scheme[scheme.code].append(entry)
    labeled = set(
        await session.scalars(
            select(ConceptScheme.code)
            .join(ItemConcept, ItemConcept.scheme_id == ConceptScheme.id)
            .where(
                ItemConcept.item_id == item_id,
                ItemConcept.state != "rejected",
                ItemConcept.section_ref.is_(None),
            )
            .distinct()
        )
    )
    for code, scheme in taxonomy.schemes.items():
        if scheme.purpose == "classification" and (
            code in by_scheme or code in labeled
        ):
            await _set_scheme_labels(
                session, ctx, item, scheme, by_scheme.get(code, [])
            )


def _assignable(scheme: SchemeSnapshot, concept_id: UUID) -> None:
    if concept_id not in {concept.id for concept in scheme.targets()}:
        raise InvalidArgument.for_field(
            CONCEPTS_FIELD,
            f"A concept of scheme {scheme.code} is not published or cannot be assigned.",
        )


async def _set_scheme_labels(
    session: AsyncSession,
    ctx: RequestContext,
    item: Item,
    scheme: SchemeSnapshot,
    entries: Sequence[ConceptEntry],
) -> None:
    concept_ids = [entry.concept_id for entry in entries]
    if len(set(concept_ids)) != len(concept_ids):
        raise InvalidArgument.for_field(
            CONCEPTS_FIELD, f"A concept of scheme {scheme.code} is repeated."
        )
    accepted = list(entries)
    if scheme.max_labels is not None and len(accepted) > scheme.max_labels:
        raise InvalidArgument.for_field(
            CONCEPTS_FIELD,
            f"Scheme {scheme.code} allows at most {scheme.max_labels} accepted concepts.",
        )
    primaries = [entry.concept_id for entry in entries if entry.primary]
    if primaries and not scheme.has_primary:
        raise InvalidArgument.for_field(
            CONCEPTS_FIELD, f"Scheme {scheme.code} has no primary concept."
        )
    if len(primaries) > 1:
        raise InvalidArgument.for_field(
            CONCEPTS_FIELD, f"Scheme {scheme.code} has one primary concept."
        )
    primary: UUID | None = None
    if scheme.has_primary and accepted:
        primary = primaries[0] if primaries else accepted[0].concept_id

    rows = list(
        await session.scalars(
            select(ItemConcept)
            .where(
                ItemConcept.item_id == item.id,
                ItemConcept.scheme_id == scheme.scheme_id,
                ItemConcept.section_ref.is_(None),
                ItemConcept.state != "rejected",
            )
            .with_for_update()
        )
    )
    live = {row.concept_id: row for row in rows}
    now = _now()
    wanted = {entry.concept_id for entry in accepted}
    for concept_id, row in live.items():
        if row.is_primary and concept_id != primary:
            row.is_primary = False
        if concept_id not in wanted:
            row.state = "rejected"
            row.reviewed_by_user_id = ctx.user_id
            row.reviewed_at = now
    await session.flush()
    for entry in accepted:
        row = live.get(entry.concept_id)
        if row is None:
            session.add(
                ItemConcept(
                    item_id=item.id,
                    concept_id=entry.concept_id,
                    scheme_id=scheme.scheme_id,
                    is_primary=entry.concept_id == primary,
                    source="human",
                    state="accepted",
                    scheme_version=scheme.version,
                    created_by_user_id=ctx.user_id,
                    reviewed_by_user_id=ctx.user_id,
                    reviewed_at=now,
                )
            )
            continue
        if row.state != "accepted" or not _human_decided(row):
            row.state = "accepted"
            row.reviewed_by_user_id = ctx.user_id
            row.reviewed_at = now
        row.is_primary = entry.concept_id == primary
    await session.flush()


async def confirm(
    session: AsyncSession,
    ctx: RequestContext,
    concept_id: UUID,
    item_ids: Sequence[UUID],
) -> int:
    """``:confirmAssignments``: accept the concept's machine labels on ``item_ids``.

    Suggested labels become accepted, accepted machine labels human-reviewed.
    A whole-document label that would exceed ``max_labels`` stays suggested.
    Returns the labels confirmed. The caller resolved the filter and
    authorized ``items.update`` on every item.
    """

    concept, scheme = await _concept(session, concept_id)
    rows = list(
        await session.scalars(
            select(ItemConcept)
            .where(
                ItemConcept.concept_id == concept_id,
                ItemConcept.item_id.in_(list(dict.fromkeys(item_ids))),
                ItemConcept.state != "rejected",
                ItemConcept.reviewed_by_user_id.is_(None),
                ItemConcept.source != "human",
            )
            .with_for_update()
        )
    )
    counts = await _accepted_counts(session, scheme.id, {row.item_id for row in rows})
    now = _now()
    confirmed = 0
    for row in rows:
        if row.state == "suggested" and row.section_ref is None:
            count, has_primary = counts.get(row.item_id, (0, False))
            if scheme.max_labels is not None and count >= scheme.max_labels:
                continue
            if scheme.has_primary and not has_primary:
                row.is_primary = True
                has_primary = True
            counts[row.item_id] = (count + 1, has_primary)
        row.state = "accepted"
        row.reviewed_by_user_id = ctx.user_id
        row.reviewed_at = now
        confirmed += 1
    await session.flush()
    await _audit(session, ctx, concept, scheme, "ConfirmConceptAssignments", confirmed)
    return confirmed


async def reject(
    session: AsyncSession,
    ctx: RequestContext,
    concept_id: UUID,
    item_ids: Sequence[UUID],
) -> int:
    """``:rejectAssignments``: reject the concept's live labels on ``item_ids``.

    A rejected primary hands the primary to the remaining accepted label with
    the highest confidence (a human one first). Returns the labels rejected.
    """

    concept, scheme = await _concept(session, concept_id)
    rows = list(
        await session.scalars(
            select(ItemConcept)
            .where(
                ItemConcept.concept_id == concept_id,
                ItemConcept.item_id.in_(list(dict.fromkeys(item_ids))),
                ItemConcept.state != "rejected",
            )
            .with_for_update()
        )
    )
    now = _now()
    lost_primary: set[UUID] = set()
    for row in rows:
        if row.is_primary:
            lost_primary.add(row.item_id)
            row.is_primary = False
        row.state = "rejected"
        row.reviewed_by_user_id = ctx.user_id
        row.reviewed_at = now
    await session.flush()
    if scheme.has_primary and lost_primary:
        remaining = list(
            await session.scalars(
                select(ItemConcept).where(
                    ItemConcept.item_id.in_(lost_primary),
                    ItemConcept.scheme_id == scheme.id,
                    ItemConcept.state == "accepted",
                    ItemConcept.section_ref.is_(None),
                )
            )
        )
        best: dict[UUID, ItemConcept] = {}
        for row in remaining:
            current = best.get(row.item_id)
            if current is None or _review_rank(row) < _review_rank(current):
                best[row.item_id] = row
        for row in best.values():
            row.is_primary = True
        await session.flush()
    await _audit(session, ctx, concept, scheme, "RejectConceptAssignments", len(rows))
    return len(rows)


def _review_rank(row: ItemConcept) -> tuple[bool, float]:
    return (
        not _human_decided(row),
        -(row.confidence if row.confidence is not None else 1.0),
    )


async def _accepted_counts(
    session: AsyncSession, scheme_id: UUID, item_ids: set[UUID]
) -> dict[UUID, tuple[int, bool]]:
    if not item_ids:
        return {}
    result = await session.execute(
        select(
            ItemConcept.item_id,
            func.count(),
            func.bool_or(ItemConcept.is_primary),
        )
        .where(
            ItemConcept.item_id.in_(item_ids),
            ItemConcept.scheme_id == scheme_id,
            ItemConcept.state == "accepted",
            ItemConcept.section_ref.is_(None),
        )
        .group_by(ItemConcept.item_id)
    )
    return {
        item_id: (int(count), bool(primary)) for item_id, count, primary in result.all()
    }


async def _audit(
    session: AsyncSession,
    ctx: RequestContext,
    concept: Concept,
    scheme: ConceptScheme,
    action: str,
    count: int,
) -> None:
    await Audit(session).record(
        ctx,
        workspace_id=scheme.tenant_id,
        category="knowledge",
        action=action,
        target=concept_name(scheme.tenant_id, scheme.code, concept.notation),
        details={"labels": count},
    )


# ---- Taxonomy changes ----------------------------------------------------------


async def remap(session: AsyncSession, from_id: UUID, to_ids: Sequence[UUID]) -> int:
    """Publish of a merge ``from → to``: move every label of ``from`` to ``to``.

    Source and state are kept and ``evidence.replacedFrom`` records ``from``;
    where the Document already carries ``to`` (same section) the stronger
    label stays (human-decided, then accepted, then confidence). A split
    (≠ 1 target) is not remapped: returns 0. Returns the labels moved or merged.
    """

    if len(to_ids) != 1:
        return 0
    to_id = to_ids[0]
    moving = list(
        await session.scalars(
            select(ItemConcept)
            .where(ItemConcept.concept_id == from_id)
            .with_for_update()
        )
    )
    if not moving:
        return 0
    targets = {
        (row.item_id, row.section_ref): row
        for row in await session.scalars(
            select(ItemConcept)
            .where(
                ItemConcept.concept_id == to_id,
                ItemConcept.item_id.in_({row.item_id for row in moving}),
                ItemConcept.state != "rejected",
            )
            .with_for_update()
        )
    }
    moved: list[ItemConcept] = []
    promote: list[ItemConcept] = []
    for row in moving:
        target = targets.get((row.item_id, row.section_ref))
        if row.state == "rejected" or target is None:
            moved.append(row)
            continue
        if _strength(row) > _strength(target):
            if target.is_primary:
                row.is_primary = True
            await session.delete(target)
            moved.append(row)
        else:
            if row.is_primary and not target.is_primary:
                promote.append(target)
            await session.delete(row)
    await session.flush()
    for row in moved:
        row.concept_id = to_id
        row.evidence = {**(row.evidence or {}), "replacedFrom": str(from_id)}
    for row in promote:
        row.is_primary = True
    await session.flush()
    return len(moving)


def _strength(row: ItemConcept) -> tuple[bool, bool, float]:
    return (
        _human_decided(row),
        row.state == "accepted",
        row.confidence if row.confidence is not None else 1.0,
    )


async def reevaluate_rule_rows(
    session: AsyncSession, tenant_id: UUID, item_ids: Sequence[UUID]
) -> int:
    """Recompute the ``concept_rules`` labels of Documents after the rules changed.

    A rule row (``source = rule`` with ``evidence.rule``) whose rule no longer
    fires is deleted; a newly implied concept the Document does not carry
    gets one (accepted, confidence 1.0, the usual cardinality and review
    rules). Pattern labels and every other row stay; ``item_classifications`` of every
    classification scheme is then recomputed (:func:`settle_outcomes`). Returns rows
    added or deleted.
    """

    taxonomy = await load_published(session, tenant_id)
    rules = tuple(
        rule
        for rule in await load_rules(session, tenant_id)
        if rule.effect == "implies"
    )
    changed = 0
    documents: list[UUID] = []
    for item_id in dict.fromkeys(item_ids):
        item = await session.get(Item, item_id)
        if (
            item is None
            or item.tenant_id != tenant_id
            or item.item_kind != "document"
            or item.deleted_at is not None
        ):
            continue
        changed += await _reevaluate_item(session, taxonomy, rules, item)
        documents.append(item.id)
    await settle_outcomes(
        session,
        (scheme.scheme_id for scheme in taxonomy.schemes.values() if scheme.purpose == "classification"),
        documents,
    )
    return changed


async def _reevaluate_item(
    session: AsyncSession, taxonomy: TaxonomySnapshot, rules: Sequence[Any], item: Item
) -> int:
    rows = list(
        await session.scalars(
            select(ItemConcept).where(
                ItemConcept.item_id == item.id,
                ItemConcept.state != "rejected",
                ItemConcept.section_ref.is_(None),
            )
        )
    )
    rule_rows = [
        row
        for row in rows
        if row.source == "rule"
        and "rule" in (row.evidence or {})
        and not _human_decided(row)
    ]
    rule_row_ids = {row.id for row in rule_rows}
    holding = {
        row.concept_id
        for row in rows
        if row.state == "accepted" and row.id not in rule_row_ids
    }
    holding |= await _profile_concepts(session, item.id)
    ancestor_ids, source_id = await rule_placement(session, item)
    implied = implied_concepts(taxonomy, rules, holding, ancestor_ids, source_id)
    others = {row.concept_id for row in rows if row.id not in rule_row_ids}
    changed = 0
    for scheme in taxonomy.schemes.values():
        if scheme.purpose != "classification":
            continue
        old = {row.concept_id for row in rule_rows if row.scheme_id == scheme.scheme_id}
        new = {
            concept_id
            for concept_id in implied
            if concept_id in scheme.concepts and concept_id not in others
        }
        if not old and not new:
            continue
        changed += await _write_machine_rows(
            session,
            item.id,
            scheme.scheme_id,
            scheme.version,
            [
                MachineAssignment(
                    concept_id=concept_id,
                    primary=False,
                    confidence=1.0,
                    source="rule",
                    state="accepted",
                    evidence=rule_evidence(implied[concept_id]),
                )
                for concept_id in new
            ],
            frozenset(old | new),
            revision_number=None,
            classifier_version=CLASSIFIER_VERSION,
            suggest_only=False,
        )
    return changed


async def follow_premises(
    session: AsyncSession, tenant_id: UUID, premises: Sequence[ItemConcept]
) -> dict[UUID, set[UUID]]:
    """Carry a re-routing or rejection of machine rows to the rule rows they implied.

    ``premises`` are whole-document rows whose state (and confidence) a re-evaluation
    without the model just changed. A live machine rule row on the same Document whose
    ``implies`` rule has that concept as its ``when`` (``evidence.premise``; rows written
    before it was recorded fall back to the rule's ``when_concept``) is rejected with the
    premise (its ``evidence.reason``), or takes the premise's state and confidence, as
    CLASSIFYING writes it. A row another live accepted label or a collection/source rule
    also implies stays. Returns scheme → Documents whose rows changed.
    """

    changed: dict[UUID, dict[UUID, ItemConcept]] = defaultdict(dict)
    for premise in premises:
        if premise.section_ref is None:
            changed[premise.item_id][premise.concept_id] = premise
    if not changed:
        return {}
    rules = {rule.code: rule for rule in await load_rules(session, tenant_id) if rule.effect == "implies"}
    rows = [
        row
        for row in await session.scalars(
            select(ItemConcept).where(
                ItemConcept.item_id.in_(list(changed)),
                ItemConcept.source == "rule",
                ItemConcept.section_ref.is_(None),
                ItemConcept.state.in_(("accepted", "suggested")),
                ItemConcept.evidence["rule"].astext.is_not(None),
            )
        )
        if not _human_decided(row)
    ]
    held: dict[UUID, set[UUID]] = defaultdict(set)
    for item_id, concept_id, source, rule in await session.execute(
        select(
            ItemConcept.item_id,
            ItemConcept.concept_id,
            ItemConcept.source,
            ItemConcept.evidence["rule"].astext,
        ).where(
            ItemConcept.item_id.in_(list(changed)),
            ItemConcept.section_ref.is_(None),
            ItemConcept.state == "accepted",
        )
    ):
        if source != "rule" or rule is None:
            held[item_id].add(concept_id)
    touched: dict[UUID, set[UUID]] = defaultdict(set)
    for row in rows:
        evidence = dict(row.evidence or {})
        rule = rules.get(evidence["rule"])
        recorded = evidence.get("premise")
        premise_id = UUID(recorded) if recorded else (rule.when_concept_id if rule is not None else None)
        premise = changed[row.item_id].get(premise_id) if premise_id is not None else None
        if premise is None:
            continue
        if any(
            other.then_concept_id == row.concept_id
            and other.when_concept_id != premise.concept_id
            and (other.when_concept_id is None or other.when_concept_id in held[row.item_id])
            for other in rules.values()
        ):
            continue
        evidence["premise"] = str(premise.concept_id)
        if premise.state == "rejected":
            evidence["reason"] = (premise.evidence or {}).get("reason", "premise_rejected")
            row.state = "rejected"
        else:
            if "corroborated" in (premise.evidence or {}):
                evidence["corroborated"] = premise.evidence["corroborated"]
            if (row.state, row.confidence, row.evidence) == (premise.state, premise.confidence, evidence):
                continue
            row.state = premise.state
            row.confidence = premise.confidence
        if row.state != "accepted":
            row.is_primary = False
        row.evidence = evidence
        touched[row.scheme_id].add(row.item_id)
    await session.flush()
    return touched


async def write_pattern_rows(
    session: AsyncSession, scheme: SchemeSnapshot, item_id: UUID, hits: Mapping[UUID, str]
) -> int:
    """Re-evaluate a Document's pattern labels of ``scheme`` from ``hits`` (concept → the
    pattern that matched what the Document's title, number and first heading say).

    Exactly one hit settles the scheme as CLASSIFYING does (``source`` RULE, the pattern
    as evidence), replacing the scheme's machine rows when that settles it (an LLM
    fallback, or a minimum of one label). Otherwise only pattern rows that no longer
    stand are deleted; model rows stay. Returns rows inserted or deleted.
    """

    rows = await session.scalars(
        select(ItemConcept).where(
            ItemConcept.item_id == item_id,
            ItemConcept.scheme_id == scheme.scheme_id,
            ItemConcept.state != "rejected",
        )
    )
    patterned = {
        row.concept_id
        for row in rows
        if "pattern" in (row.evidence or {}) and not _human_decided(row)
    }
    assignments: list[MachineAssignment] = []
    replace: frozenset[UUID] | None = frozenset(patterned)
    if len(hits) == 1:
        concept_id, pattern = next(iter(hits.items()))
        assignments.append(
            MachineAssignment(
                concept_id=concept_id,
                primary=False,
                confidence=RULE_CONFIDENCE,
                source="rule",
                state="accepted",
                evidence={"pattern": pattern, "signals": []},
            )
        )
        settles = scheme.llm_policy != "always" or scheme.min_labels <= 1
        replace = None if settles else frozenset(patterned | {concept_id})
    elif not patterned:
        return 0
    return await _write_machine_rows(
        session,
        item_id,
        scheme.scheme_id,
        scheme.version,
        assignments,
        replace,
        revision_number=None,
        classifier_version=CLASSIFIER_VERSION,
        suggest_only=False,
    )


async def _profile_concepts(session: AsyncSession, item_id: UUID) -> set[UUID]:
    """Issuer, campus and applicability concepts: what ``when_concept`` rules also match."""

    profile = await session.get(DocumentProfile, item_id)
    held: set[UUID] = set()
    if profile is not None:
        held.update(
            concept
            for concept in (profile.issuer_concept_id, profile.campus_concept_id)
            if concept is not None
        )
    held.update(
        await session.scalars(
            select(DocumentApplicability.concept_id).where(
                DocumentApplicability.item_id == item_id
            )
        )
    )
    return held


async def rule_placement(
    session: AsyncSession, item: Item
) -> tuple[tuple[UUID, ...], UUID | None]:
    """What collection and source rules match: ancestor Item IDs and the ingestion source.

    The candidate of an open NEW_DOCUMENT contribution is placed where it is
    headed (its deciding collection and that collection's ancestors); a
    Source's NEW_REVISION candidate has the source of the Document it replaces.
    """

    contribution = (
        await open_new_document_contributions(session, item.tenant_id, [item.id])
    ).get(item.id)
    decision = deciding_collection(contribution) if contribution is not None else None
    placement = (
        await item_ancestry(session, decision)
        if decision is not None
        else (await item_ancestry(session, item.id))[1:]
    )
    return tuple(node.item_id for node in placement), await _source_id(session, item.id)


async def _source_id(session: AsyncSession, item_id: UUID) -> UUID | None:
    replaced = (
        select(Contribution.replaces_item_id)
        .where(
            Contribution.item_id == item_id,
            Contribution.ingestion_source_id.is_not(None),
            Contribution.replaces_item_id.is_not(None),
        )
        .limit(1)
        .scalar_subquery()
    )
    return await session.scalar(
        select(ExternalResource.ingestion_source_id)
        .where(
            (ExternalResource.item_id == item_id)
            | (ExternalResource.item_id == replaced)
        )
        .order_by(
            (ExternalResource.item_id == item_id).desc(),
            ExternalResource.deleted_at.desc().nulls_first(),
        )
        .limit(1)
    )


# ---- Reads and merges ----------------------------------------------------------


async def assignment_records(
    session: AsyncSession, item_ids: Iterable[UUID]
) -> dict[UUID, tuple[ConceptAssignmentRecord, ...]]:
    """The live labels of each Document (REJECTED omitted), by scheme position,
    primary first, whole-document before sections, then confidence."""

    ids = list(dict.fromkeys(item_ids))
    if not ids:
        return {}
    query: Select[Any] = (
        select(ItemConcept, Concept.notation, ConceptScheme.code)
        .join(Concept, Concept.id == ItemConcept.concept_id)
        .join(ConceptScheme, ConceptScheme.id == ItemConcept.scheme_id)
        .where(ItemConcept.item_id.in_(ids), ItemConcept.state != "rejected")
        .order_by(
            ItemConcept.item_id,
            ConceptScheme.position,
            ConceptScheme.code,
            ItemConcept.is_primary.desc(),
            ItemConcept.section_ref.desc().nulls_first(),
            ItemConcept.confidence.desc().nulls_first(),
            Concept.notation,
        )
    )
    records: dict[UUID, list[ConceptAssignmentRecord]] = defaultdict(list)
    for row, notation, code in (await session.execute(query)).all():
        quote = (row.evidence or {}).get("quote")
        records[row.item_id].append(
            ConceptAssignmentRecord(
                concept_id=row.concept_id,
                notation=notation,
                scheme_id=row.scheme_id,
                scheme_code=code,
                primary=row.is_primary,
                section_ref=row.section_ref,
                confidence=row.confidence,
                source=row.source,
                state=row.state,
                quote=quote if isinstance(quote, str) else None,
                reviewer_id=row.reviewed_by_user_id,
                reviewed_at=row.reviewed_at,
            )
        )
    return {item_id: tuple(values) for item_id, values in records.items()}


async def merge_assignments(
    session: AsyncSession, duplicate_id: UUID, survivor_id: UUID
) -> None:
    """MergeItem: the survivor takes the duplicate's whole-document labels it lacks.

    The survivor's own labels (live or rejected) win; a taken accepted label
    becomes suggested when the survivor already has accepted labels of that
    scheme or no room is left. A person's rejection is taken too. Section
    labels name the duplicate's structure and are dropped. Rows move (not
    copied), so a label of a since-deprecated concept survives the merge.
    """

    duplicate_rows = list(
        await session.scalars(
            select(ItemConcept)
            .where(ItemConcept.item_id == duplicate_id)
            .with_for_update()
        )
    )
    survivor_rows = list(
        await session.scalars(
            select(ItemConcept)
            .where(
                ItemConcept.item_id == survivor_id, ItemConcept.section_ref.is_(None)
            )
            .with_for_update()
        )
    )
    survivor_concepts = {row.concept_id for row in survivor_rows}
    survivor_accepted = {
        row.scheme_id for row in survivor_rows if row.state == "accepted"
    }
    schemes = {
        scheme.id: scheme
        for scheme in await session.scalars(
            select(ConceptScheme).where(
                ConceptScheme.id.in_({row.scheme_id for row in duplicate_rows})
            )
        )
    }
    taken: list[ItemConcept] = []
    for row in duplicate_rows:
        if row.section_ref is not None or row.concept_id in survivor_concepts:
            continue
        if row.state == "rejected" and not _human_decided(row):
            continue
        taken.append(row)
        survivor_concepts.add(row.concept_id)
    accepted: dict[UUID, list[ItemConcept]] = defaultdict(list)
    for row in taken:
        if row.state != "accepted":
            continue
        scheme = schemes[row.scheme_id]
        room = (
            scheme.max_labels is None
            or len(accepted[row.scheme_id]) < scheme.max_labels
        )
        if row.scheme_id in survivor_accepted or not room:
            row.state = "suggested"
        else:
            accepted[row.scheme_id].append(row)
    primaries: set[UUID] = set()
    for scheme_id, rows in accepted.items():
        if schemes[scheme_id].has_primary:
            primaries.add(next((row for row in rows if row.is_primary), rows[0]).id)
    taken_ids = {row.id for row in taken}
    for row in duplicate_rows:
        if row.id not in taken_ids:
            await session.delete(row)
    await session.flush()
    for row in taken:
        row.item_id = survivor_id
        row.is_primary = row.id in primaries
    await session.flush()


# ---- Lookups -------------------------------------------------------------------


async def _document(session: AsyncSession, item_id: UUID) -> Item:
    item = await session.get(Item, item_id)
    if item is None or item.deleted_at is not None:
        raise NotFound("The document does not exist.")
    if item.item_kind != "document":
        raise InvalidArgument.for_field(
            CONCEPTS_FIELD, "Only documents carry concepts."
        )
    return item


async def _concept(
    session: AsyncSession, concept_id: UUID
) -> tuple[Concept, ConceptScheme]:
    row = (
        await session.execute(
            select(Concept, ConceptScheme)
            .join(ConceptScheme, ConceptScheme.id == Concept.scheme_id)
            .where(Concept.id == concept_id)
        )
    ).first()
    if row is None:
        raise NotFound("The concept does not exist.")
    return row[0], row[1]


async def settle_outcomes(
    session: AsyncSession, scheme_ids: Iterable[UUID], item_ids: Iterable[UUID]
) -> None:
    """Recompute ``item_classifications`` after a re-evaluation without the model.

    Per (Document, scheme): a live (accepted or suggested) label → ``assigned``, its
    confidence the highest live one (a human row counts 1.0); none → ``uncertain``
    when it was ``assigned`` (``empty``, ``uncertain`` and ``failed`` stay). A row whose
    outcome or confidence changes, or that was written for another version, takes the
    scheme's published version and a new ``classified_at``; a Document with live labels
    and no row gets one.
    """

    schemes = list(dict.fromkeys(scheme_ids))
    items = list(dict.fromkeys(item_ids))
    if not schemes or not items:
        return
    versions = {
        scheme_id: version
        for scheme_id, version in (
            await session.execute(
                select(ConceptScheme.id, ConceptScheme.published_version).where(
                    ConceptScheme.id.in_(schemes)
                )
            )
        ).tuples()
    }
    best = {
        (item_id, scheme_id): float(value)
        for item_id, scheme_id, value in (
            await session.execute(
                select(
                    ItemConcept.item_id,
                    ItemConcept.scheme_id,
                    func.max(func.coalesce(ItemConcept.confidence, 1.0)),
                )
                .where(
                    ItemConcept.item_id.in_(items),
                    ItemConcept.scheme_id.in_(schemes),
                    ItemConcept.state.in_(("accepted", "suggested")),
                )
                .group_by(ItemConcept.item_id, ItemConcept.scheme_id)
            )
        ).tuples()
    }
    existing = {
        (row.item_id, row.scheme_id): row
        for row in await session.scalars(
            select(ItemClassification).where(
                ItemClassification.item_id.in_(items),
                ItemClassification.scheme_id.in_(schemes),
            )
        )
    }
    now = _now()
    for key in set(best) | set(existing):
        row = existing.get(key)
        version = versions.get(key[1])
        if key in best:
            outcome, confidence = "assigned", round(best[key], 3)
        elif row is not None and row.outcome == "assigned":
            outcome, confidence = "uncertain", None
        else:
            continue
        if row is None:
            session.add(
                ItemClassification(
                    item_id=key[0],
                    scheme_id=key[1],
                    outcome=outcome,
                    confidence=confidence,
                    scheme_version=version,
                    classifier_version=CLASSIFIER_VERSION,
                    classified_at=now,
                )
            )
            continue
        current = None if row.confidence is None else round(float(row.confidence), 3)
        if (row.outcome, current, row.scheme_version) == (outcome, confidence, version):
            continue
        row.outcome = outcome
        row.confidence = confidence
        row.scheme_version = version
        row.classified_at = now
    await session.flush()


__all__ = [
    "CONCEPTS_FIELD",
    "ConceptAssignmentRecord",
    "ConceptEntry",
    "assignment_records",
    "confirm",
    "follow_premises",
    "merge_assignments",
    "reevaluate_rule_rows",
    "reject",
    "remap",
    "replace_machine_assignments",
    "rule_placement",
    "set_document_concepts",
    "set_human_assignments",
    "settle_outcomes",
    "write_pattern_rows",
]
