"""Reclassification after a scheme publish or a concept-rule change (``api_design.md`` ConceptScheme ``:publish``).

Publish (TaxonomyApi) writes ``concept_scheme_versions.reclassification``
``{remapped, rerank: [{concept, among}], rerun_parents: [{parent, among}],
patterns_changed: [concept], thresholds_changed, state: pending}`` and, after its
commit, calls :func:`schedule_reclassification`. Only the changes that need the model
become a ``classify_only`` Ingestion Run (``trigger_type = taxonomy``) over
exactly the affected Documents:

- split ``A → A1, A2``: rerank among ``{A1, A2}`` on Documents carrying ``A``;
  a Document whose ``A`` label is human gets SUGGESTED rows only;
- a new child under ``P``: rerank among ``P`` and its children on ``P``'s Documents;
- deprecation without replacement: machine rows are rejected here
  (``evidence.reason = deprecated``); Documents left without any label of a
  scheme with ``min_labels >= 1`` rerun that scheme.

Threshold changes re-route stored machine rows by their confidence without the
model. Changed ``matchPatterns`` re-evaluate pattern labels without the model,
like a rule change: on the Documents whose label of the scheme came from a
pattern or rule, or whose title, number or first heading (the leading chunks in
the index) an old or new pattern of a changed concept matches. Human rows are
never modified.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import and_, exists, func, select, union
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import (
    Concept,
    ConceptClosure,
    ConceptReplacement,
    ConceptRule,
    ConceptScheme,
    ConceptSchemeVersion,
    ExternalResource,
    IngestionRun,
    Item,
    ItemClassification,
    ItemConcept,
)
from bomesh.services.ingestion.run_engine import RunClassification, RunSelection
from bomesh.services.taxonomy.assignments import (
    follow_premises,
    reevaluate_rule_rows,
    settle_outcomes,
    write_pattern_rows,
)
from bomesh.services.taxonomy.changes import published_snapshot
from bomesh.services.taxonomy.classification import pattern_hits, pattern_text, scheme_patterns
from bomesh.services.taxonomy.classification.pipeline import HEAD_CHARACTERS

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime
    from bomesh.services.kernel.context import RequestContext

log = logging.getLogger(__name__)

#: ``ingestion_runs.scope.item_ids`` holds at most this many Documents.
RUN_ITEMS = 1000
#: Documents whose rule rows are recomputed per transaction.
RULE_BATCH = 200
#: Leading chunks read from the index to rebuild what patterns read of a Document.
PATTERN_CHUNKS = 4
LIVE_STATES = ("suggested", "accepted")
TERMINAL_RUN_STATUSES = ("succeeded", "failed", "cancelled")


@dataclass(frozen=True, slots=True)
class _Group:
    """Documents of one run: the rerank candidates per scheme and whether rows stay suggested."""

    rerank: tuple[str, ...]
    suggest_only: bool


async def schedule_reclassification(
    deps: AppRuntime,
    ctx: RequestContext | None,
    tenant_id: UUID,
    scheme_id: UUID,
    version: int,
) -> UUID | None:
    """Apply the model-free part of a publish and queue the runs the rest needs.

    Idempotent per ``(scheme, version)``: once the reclassification left
    ``pending`` it is not scheduled again. Returns the first run created
    (``None`` when nothing needs the model).
    """

    run_service = deps.ingestion_run_service()
    launched: list[tuple[UUID, int]] = []
    async with transaction_scope(deps.sessions()) as session:
        row = await session.scalar(
            select(ConceptSchemeVersion)
            .where(
                ConceptSchemeVersion.scheme_id == scheme_id,
                ConceptSchemeVersion.version == version,
            )
            .with_for_update()
        )
        scheme = await session.get(ConceptScheme, scheme_id)
        if row is None or scheme is None or scheme.tenant_id != tenant_id:
            return None
        plan = dict(row.reclassification or {})
        if plan.get("state", "pending") != "pending":
            runs = plan.get("runs") or []
            return UUID(runs[0]) if runs else None

        rejected, orphans = await _reject_deprecated(session, scheme, version)
        rerouted = await reroute_by_thresholds(session, scheme) if plan.get("thresholds_changed") else 0
        patterned = (
            await reevaluate_patterns(deps, session, scheme, version, plan["patterns_changed"])
            if plan.get("patterns_changed")
            else 0
        )

        groups: dict[_Group, list[UUID]] = defaultdict(list)
        for group, items in (await _rerank_groups(session, scheme, plan)).items():
            groups[group].extend(items)
        if orphans:
            groups[_Group(rerank=(), suggest_only=False)].extend(orphans)

        for group, items in groups.items():
            for start in range(0, len(items), RUN_ITEMS):
                chunk = tuple(items[start : start + RUN_ITEMS])
                savepoint = await session.begin_nested()
                run = await run_service.snapshot(
                    session,
                    workspace_id=tenant_id,
                    selection=RunSelection(items=chunk),
                    collections=None,
                    trigger="taxonomy",
                    created_by_user_id=ctx.user_id if ctx is not None else None,
                    classification=RunClassification(
                        rerank={scheme.code: group.rerank} if group.rerank else {},
                        schemes=(scheme.code,),
                        suggest_only=group.suggest_only,
                    ),
                    classify_only=True,
                )
                if run.item_count == 0:
                    await savepoint.rollback()
                    continue
                launched.append((run.id, run.item_count))

        row.reclassification = {
            **plan,
            "state": "running" if launched else "done",
            "runs": [str(run_id) for run_id, _ in launched],
            "rejected": rejected,
            "rerouted": rerouted,
            "patterns_reevaluated": patterned,
        }
    for run_id, item_count in launched:
        await run_service.launch(run_id, item_count=item_count)
    log.info(
        "reclassification scheme_id=%s version=%s runs=%s rejected=%s rerouted=%s",
        scheme_id,
        version,
        len(launched),
        rejected,
        rerouted,
    )
    return launched[0][0] if launched else None


async def settle_reclassifications(sessions: SessionFactory) -> int:
    """Mark ``running`` reclassifications ``done`` once every run they created ended."""

    settled = 0
    async with transaction_scope(sessions) as session:
        rows = (
            await session.scalars(
                select(ConceptSchemeVersion)
                .where(ConceptSchemeVersion.reclassification["state"].astext == "running")
                .with_for_update(skip_locked=True)
            )
        ).all()
        for row in rows:
            plan = dict(row.reclassification or {})
            run_ids = [UUID(run) for run in plan.get("runs") or ()]
            open_runs = await session.scalar(
                select(func.count())
                .select_from(IngestionRun)
                .where(
                    IngestionRun.id.in_(run_ids),
                    IngestionRun.status.not_in(TERMINAL_RUN_STATUSES),
                )
            )
            if open_runs:
                continue
            row.reclassification = {**plan, "state": "done"}
            settled += 1
    return settled


async def reevaluate_rules(
    deps: AppRuntime,
    ctx: RequestContext | None,
    tenant_id: UUID,
    rule_ids: Sequence[UUID],
    previous: Sequence[Mapping[str, Any]] = (),
) -> int:
    """Recompute rule-derived rows of every Document an old or new rule condition matches.

    ``previous`` carries the rule rows before an update or delete
    (``when_concept_id | when_collection_item_id | when_ingestion_source_id``);
    the current rows are read by ``rule_ids``. No model call: rule rows come
    from ``assignments.reevaluate_rule_rows``. Returns the Documents recomputed.
    """

    sessions = deps.sessions()
    async with transaction_scope(sessions) as session:
        rules = (
            await session.execute(
                select(
                    ConceptRule.when_concept_id,
                    ConceptRule.when_collection_item_id,
                    ConceptRule.when_ingestion_source_id,
                ).where(ConceptRule.tenant_id == tenant_id, ConceptRule.id.in_(rule_ids))
            )
        ).all()
        conditions = [tuple(rule) for rule in rules] + [
            (
                _uuid(old.get("when_concept_id")),
                _uuid(old.get("when_collection_item_id")),
                _uuid(old.get("when_ingestion_source_id")),
            )
            for old in previous
        ]
        selects = [
            _matching_documents(tenant_id, concept, collection, source)
            for concept, collection, source in conditions
            if concept or collection or source
        ]
        if not selects:
            return 0
        item_ids = list((await session.scalars(union(*selects))).all())
    for start in range(0, len(item_ids), RULE_BATCH):
        async with transaction_scope(sessions) as session:
            await reevaluate_rule_rows(session, tenant_id, item_ids[start : start + RULE_BATCH])
    log.info("concept rules re-evaluated tenant_id=%s documents=%s", tenant_id, len(item_ids))
    return len(item_ids)


async def reevaluate_patterns(
    deps: AppRuntime,
    session: AsyncSession,
    scheme: ConceptScheme,
    version: int,
    changed: Sequence[str],
) -> int:
    """Re-evaluate the scheme's pattern labels after ``changed`` concepts' ``matchPatterns``
    changed in ``version``, without the model; returns the Documents re-evaluated.

    Among the live Documents the classifier has seen in the scheme, those whose label of
    the scheme came from a pattern or rule, or whose title, number or first heading an
    old or new pattern of a changed concept matches, get their pattern rows from the
    published patterns (``assignments.write_pattern_rows``), then their ``implies`` rule
    rows and outcomes.
    """

    current = await published_snapshot(session, scheme, version)
    if current is None or scheme.tenant_id is None:
        return 0
    previous = await published_snapshot(session, scheme, version - 1) if version > 1 else None
    concepts = {UUID(value) for value in changed}
    patterns = scheme_patterns(current)
    touched = [entry for entry in patterns if entry[0] in concepts]
    if previous is not None:
        touched += [entry for entry in scheme_patterns(previous) if entry[0] in concepts]
    seen = union(
        select(ItemClassification.item_id).where(ItemClassification.scheme_id == scheme.id),
        select(ItemConcept.item_id).where(
            ItemConcept.scheme_id == scheme.id, ItemConcept.state.in_(LIVE_STATES)
        ),
    ).subquery()
    documents = (
        await session.execute(
            select(Item.id, Item.item_name)
            .where(
                Item.id.in_(select(seen.c.item_id)),
                Item.tenant_id == scheme.tenant_id,
                Item.item_kind == "document",
                Item.deleted_at.is_(None),
            )
            .order_by(Item.id)
        )
    ).all()
    ruled = set(
        await session.scalars(
            select(ItemConcept.item_id).where(
                ItemConcept.scheme_id == scheme.id,
                ItemConcept.source == "rule",
                ItemConcept.state.in_(LIVE_STATES),
            )
        )
    )
    selected: list[UUID] = []
    for start in range(0, len(documents), RULE_BATCH):
        batch = documents[start : start + RULE_BATCH]
        texts = await _pattern_texts(deps, scheme.tenant_id, batch)
        for item_id, _name in batch:
            text = texts[item_id]
            if item_id not in ruled and not pattern_hits(touched, text):
                continue
            await write_pattern_rows(session, current, item_id, pattern_hits(patterns, text))
            selected.append(item_id)
    if selected:
        await reevaluate_rule_rows(session, scheme.tenant_id, selected)
        await settle_documents(session, scheme, selected)
    return len(selected)


async def _pattern_texts(
    deps: AppRuntime, tenant_id: UUID, documents: Sequence[Any]
) -> dict[UUID, str]:
    """What patterns read of each Document: its title, the number and first heading of
    its leading indexed chunks (one index read)."""

    chunks = await deps.item_index().get_item_chunks(
        tenant_id=str(tenant_id),
        chunks={str(item_id): range(PATTERN_CHUNKS) for item_id, _name in documents},
    )
    leading: dict[str, list[Any]] = defaultdict(list)
    for chunk in chunks:
        leading[chunk.item_id].append(chunk)
    texts: dict[UUID, str] = {}
    for item_id, name in documents:
        ordered = sorted(leading.get(str(item_id), ()), key=lambda chunk: chunk.chunk_index)
        heading = next(
            (chunk.context.section_path[0] for chunk in ordered if chunk.context.section_path), None
        )
        head = "\n".join(chunk.chunk_text for chunk in ordered)[:HEAD_CHARACTERS]
        title = name or next((chunk.title for chunk in ordered if chunk.title), "")
        texts[item_id] = pattern_text(title, head, heading)
    return texts



async def reroute_by_thresholds(session: AsyncSession, scheme: ConceptScheme) -> int:
    """Re-route the scheme's live machine rows by stored confidence; returns rows changed.

    ``>= auto_threshold`` → accepted, ``>= review_threshold`` → suggested, lower →
    rejected (``evidence.reason = below_threshold``). A model pick nothing
    corroborated (``evidence.corroborated = false``) is never accepted. Cardinality
    and the primary are then repaired per Document, and the rule rows a re-routed row
    implied follow it (``assignments.follow_premises``).
    """

    auto = float(scheme.auto_threshold) if scheme.auto_threshold is not None else None
    review = float(scheme.review_threshold) if scheme.review_threshold is not None else 0.0
    rows = (
        await session.scalars(
            select(ItemConcept).where(
                ItemConcept.scheme_id == scheme.id,
                ItemConcept.source != "human",
                ItemConcept.state.in_(LIVE_STATES),
                ItemConcept.confidence.is_not(None),
            )
        )
    ).all()
    changed: set[UUID] = set()
    moved: list[ItemConcept] = []
    rerouted = 0
    for row in rows:
        confidence = float(row.confidence or 0.0)
        if auto is not None and confidence >= auto and row.evidence.get("corroborated") is not False:
            state = "accepted"
        elif confidence >= review:
            state = "suggested"
        else:
            state = "rejected"
        if state == row.state:
            continue
        # A changed row never keeps a stale primary; settle_documents picks one.
        row.is_primary = False
        if state == "rejected":
            row.evidence = {**row.evidence, "reason": "below_threshold"}
        row.state = state
        changed.add(row.item_id)
        moved.append(row)
        rerouted += 1
    await session.flush()
    await settle_documents(session, scheme, changed)
    await _follow_premises(session, scheme, moved)
    return rerouted


async def settle_documents(
    session: AsyncSession, scheme: ConceptScheme, item_ids: Iterable[UUID]
) -> None:
    """Repair ``max_labels`` and the primary of machine rows, then ``item_classifications``.

    Human rows count but are never changed: machine accepted rows beyond
    ``max_labels`` (lowest confidence first) go back to suggested, and a scheme
    with a primary gets one on its highest-confidence accepted row when no
    accepted row carries it.
    """

    item_ids = list(item_ids)
    if not item_ids:
        return
    rows = (
        await session.scalars(
            select(ItemConcept).where(
                ItemConcept.scheme_id == scheme.id,
                ItemConcept.item_id.in_(item_ids),
                ItemConcept.state.in_(LIVE_STATES),
                ItemConcept.section_ref.is_(None),
            )
        )
    ).all()
    by_item: dict[UUID, list[ItemConcept]] = defaultdict(list)
    for row in rows:
        by_item[row.item_id].append(row)
    promote: list[ItemConcept] = []
    for item_rows in by_item.values():
        accepted = [row for row in item_rows if row.state == "accepted"]
        human = [row for row in accepted if row.source == "human"]
        machine = sorted(
            (row for row in accepted if row.source != "human"),
            key=lambda row: row.confidence or 0.0,
            reverse=True,
        )
        if scheme.max_labels is not None:
            keep = max(scheme.max_labels - len(human), 0)
            for row in machine[keep:]:
                row.state = "suggested"
                row.is_primary = False
            machine = machine[:keep]
        for row in item_rows:
            if row.state != "accepted" and row.source != "human" and row.is_primary:
                row.is_primary = False
        if not scheme.has_primary or not (human or machine):
            continue
        if any(row.is_primary for row in human):
            for row in machine:
                row.is_primary = False
            continue
        primaries = [row for row in machine if row.is_primary]
        if len(primaries) == 1:
            continue
        for row in primaries:
            row.is_primary = False
        if machine:
            promote.append(machine[0])
    await session.flush()
    for row in promote:
        row.is_primary = True
    await session.flush()
    await settle_outcomes(session, (scheme.id,), item_ids)


async def _reject_deprecated(
    session: AsyncSession, scheme: ConceptScheme, version: int
) -> tuple[int, list[UUID]]:
    """Reject machine rows of concepts this version deprecated without replacement.

    Returns ``(rows rejected, Documents left without any label of the scheme
    when it requires one)``.
    """

    deprecated = (
        select(Concept.id)
        .where(
            Concept.scheme_id == scheme.id,
            Concept.state == "deprecated",
            Concept.deprecated_version == version,
            ~exists().where(ConceptReplacement.concept_id == Concept.id),
        )
        .scalar_subquery()
    )
    rows = (
        await session.scalars(
            select(ItemConcept).where(
                ItemConcept.concept_id.in_(deprecated),
                ItemConcept.source != "human",
                ItemConcept.state.in_(LIVE_STATES),
            )
        )
    ).all()
    if not rows:
        return 0, []
    touched: set[UUID] = set()
    for row in rows:
        row.state = "rejected"
        row.is_primary = False
        row.evidence = {**row.evidence, "reason": "deprecated"}
        touched.add(row.item_id)
    await session.flush()
    await settle_documents(session, scheme, touched)
    await _follow_premises(session, scheme, rows)
    if scheme.min_labels < 1:
        return len(rows), []
    labelled = set(
        (
            await session.scalars(
                select(ItemConcept.item_id).where(
                    ItemConcept.scheme_id == scheme.id,
                    ItemConcept.item_id.in_(touched),
                    ItemConcept.state.in_(LIVE_STATES),
                )
            )
        ).all()
    )
    return len(rows), sorted(touched - labelled)


async def _follow_premises(
    session: AsyncSession, scheme: ConceptScheme, premises: Sequence[ItemConcept]
) -> None:
    """Carry re-routed or rejected rows to the rule rows they implied, then settle those
    schemes (cardinality, primary, ``item_classifications``)."""

    if scheme.tenant_id is None or not premises:
        return
    for scheme_id, item_ids in (await follow_premises(session, scheme.tenant_id, premises)).items():
        implied = await session.get(ConceptScheme, scheme_id)
        if implied is not None:
            await settle_documents(session, implied, item_ids)


async def _rerank_groups(
    session: AsyncSession, scheme: ConceptScheme, plan: Mapping[str, Any]
) -> dict[_Group, list[UUID]]:
    """Documents per run group: split concepts and parents with new children.

    A Document affected by several changes is reranked once among the union
    of their candidates; one whose replaced/parent label is human gets
    suggestions only.
    """

    changes: list[tuple[UUID, tuple[str, ...]]] = [
        (UUID(str(entry["concept"])), tuple(str(cid) for cid in entry.get("among") or ()))
        for entry in plan.get("rerank") or ()
    ] + [
        (UUID(str(entry["parent"])), tuple(str(cid) for cid in entry.get("among") or ()))
        for entry in plan.get("rerun_parents") or ()
    ]
    candidates: dict[UUID, set[str]] = defaultdict(set)
    human: set[UUID] = set()
    for concept_id, among in changes:
        if not among:
            continue
        rows = (
            await session.execute(
                select(ItemConcept.item_id, ItemConcept.source)
                .join(Item, Item.id == ItemConcept.item_id)
                .where(
                    ItemConcept.scheme_id == scheme.id,
                    ItemConcept.concept_id == concept_id,
                    ItemConcept.state.in_(LIVE_STATES),
                    Item.deleted_at.is_(None),
                )
            )
        ).all()
        for item_id, source in rows:
            candidates[item_id].update(among)
            if source == "human":
                human.add(item_id)
    groups: dict[_Group, list[UUID]] = defaultdict(list)
    for item_id in sorted(candidates):
        group = _Group(rerank=tuple(sorted(candidates[item_id])), suggest_only=item_id in human)
        groups[group].append(item_id)
    return groups


def _matching_documents(
    tenant_id: UUID, concept_id: UUID | None, collection_id: UUID | None, source_id: UUID | None
) -> Any:
    """Live Documents a rule condition matches (concept via closure, collection subtree, source)."""

    if concept_id is not None:
        return (
            select(ItemConcept.item_id)
            .join(ConceptClosure, ConceptClosure.descendant_id == ItemConcept.concept_id)
            .join(Item, Item.id == ItemConcept.item_id)
            .where(
                ConceptClosure.ancestor_id == concept_id,
                ItemConcept.state.in_(LIVE_STATES),
                Item.tenant_id == tenant_id,
                Item.deleted_at.is_(None),
            )
        )
    if collection_id is not None:
        child = aliased(Item)
        tree = (
            select(Item.id)
            .where(Item.id == collection_id, Item.tenant_id == tenant_id)
            .cte("rule_collection_tree", recursive=True)
        )
        tree = tree.union_all(
            select(child.id).where(child.parent_item_id == tree.c.id, child.deleted_at.is_(None))
        )
        return select(Item.id).where(
            Item.id.in_(select(tree.c.id)),
            Item.item_kind == "document",
            Item.deleted_at.is_(None),
        )
    return select(ExternalResource.item_id).join(Item, Item.id == ExternalResource.item_id).where(
        and_(
            ExternalResource.ingestion_source_id == source_id,
            ExternalResource.deleted_at.is_(None),
            Item.tenant_id == tenant_id,
            Item.item_kind == "document",
            Item.deleted_at.is_(None),
        )
    )


def _uuid(value: Any) -> UUID | None:
    return UUID(str(value)) if value else None


__all__ = [
    "reevaluate_patterns",
    "reevaluate_rules",
    "reroute_by_thresholds",
    "schedule_reclassification",
    "settle_documents",
    "settle_reclassifications",
]
