"""SearchItems and agent retrieval: PostgreSQL decides, the index pre-filters.

Readable and editable collections come from PostgreSQL per request; the index
returns only points of readable collections that are published or editable;
every hit is then re-checked in PostgreSQL before any text is returned
(``item_model.md`` §4.10, invariant 7).

Facets: the value and interval facets of one request are counted by one
grouped statement; concept, collection (``ancestors``) and space facets have
their own. A facet that can only count what the search matched is empty,
without a statement, when the search matched nothing.

A text query is also read against the published taxonomy
(:mod:`bomesh.services.taxonomy.ranking`): the concepts it names boost the
documents labeled with them and add a recall pass over those documents, the
searcher's affiliation boosts (or, explicitly scoped elsewhere, drops) documents
by applicability, and an ambiguous term's readings come back as groups.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import Text, and_, case, cast, func, or_, select, true, tuple_
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import transaction_scope
from bomesh.db.models import (
    Concept,
    ConceptClosure,
    ConceptScheme,
    Item,
    ItemClassification,
    ItemConcept,
    Space,
    SpaceMaterial,
    TenantMembership,
    User,
)
from bomesh.document_index import ContextualChunk
from bomesh.document_structure import CitationTarget
from bomesh.errors import Unavailable
from bomesh.iam.authorizer import WorkspaceAccess, WorkspaceRef
from bomesh.iam.visibility import ItemVisibility
from bomesh.knowledge import Evidence, ItemKnowledgeRetriever
from bomesh.request_timing import stage
from bomesh.services.kernel.context import RequestContext
from bomesh.services.knowledge_items.item_store import catalog_visibility
from bomesh.services.knowledge_items.queries import (
    ITEM_TYPE,
    LANGUAGE,
    MIME_TYPE,
    OWNER_ID,
    SOURCE_CODE,
    VERIFICATION_STATE,
)
from bomesh.services.knowledge_items.records import (
    Facet,
    FacetRequest,
    FacetValue,
    InterpretationAmbiguity,
    InterpretationOption,
    InterpretedConcept,
    Interval,
    ItemRecord,
    SearchGroup,
    SearchInterpretation,
    SearchPage,
    SearchReference,
    SearchRequest,
    SearchResult,
)
from bomesh.services.knowledge_items.support import (
    KnowledgeDeps,
    Projector,
    load_referenced,
)
from bomesh.services.taxonomy.ranking import (
    GROUP_SIZE,
    ConceptRef,
    QueryPlan,
    carries,
    concept_refs,
    facet_items,
    item_signals,
    plan_concepts,
    plan_query,
    preferred_label,
    rank,
    reading_label,
)

log = logging.getLogger(__name__)

#: Chunks read from the index for one search; hits are grouped per document.
CANDIDATE_CHUNKS = 200
SNIPPET_CHARACTERS = 240
DEFAULT_FACET_LIMIT = 10
#: ``ErrorInfo.reason`` of a text search the index did not answer in time (or failed).
SEARCH_UNAVAILABLE = "SEARCH_UNAVAILABLE"

_SCALAR_FACETS: dict[str, Any] = {
    "itemType": ITEM_TYPE,
    "document.mimeType": MIME_TYPE,
    "document.languageCode": LANGUAGE,
    "document.owner": OWNER_ID,
    "document.origin.source": SOURCE_CODE,
    "document.verification.state": VERIFICATION_STATE,
}
#: Interval facets (``FacetSpec.intervals``): field → the timestamp they bucket.
_INTERVAL_FACETS: dict[str, Any] = {"updateTime": Item.updated_at}
INTERVAL_FACET_FIELDS = frozenset(_INTERVAL_FACETS)
#: Hierarchical concept facets → the label state they count: ``document.suggestedConcepts``
#: counts the assistant's labels nobody confirmed (Studio's Suggestions, one statement).
_CONCEPT_FACETS = {"document.concepts": "accepted", "document.suggestedConcepts": "suggested"}
CONCEPT_FACET_FIELDS = frozenset(_CONCEPT_FACETS)
FACET_FIELDS = frozenset(
    {
        *_SCALAR_FACETS,
        *_INTERVAL_FACETS,
        *_CONCEPT_FACETS,
        "document.uncertainSchemes",
        "ancestors",
        "spaces",
    }
)


@dataclass(slots=True)
class _Hit:
    score: float
    chunks: list[ContextualChunk]


@dataclass(slots=True)
class _Reading:
    """A text query's interpretation: the plan, current concept names, and the hits of
    each option of its grouped ambiguity (by option display name)."""

    plan: QueryPlan
    names: Mapping[UUID, ConceptRef]
    groups: list[tuple[str, dict[UUID, _Hit]]]


class ItemSearchService:
    """The one catalog and retrieval search over DOCUMENT items."""

    def __init__(self, deps: KnowledgeDeps) -> None:
        self._deps = deps

    @classmethod
    def from_runtime(cls, runtime: Any) -> ItemSearchService:
        return cls(KnowledgeDeps.from_runtime(runtime))

    async def search(
        self, ctx: RequestContext, workspace_id: UUID, request: SearchRequest
    ) -> SearchPage:
        await self._deps.workspaces.open(ctx, WorkspaceRef(workspace_id), "items.search", write=False)
        with stage("visibility"):
            async with transaction_scope(self._deps.sessions) as session:
                for referenced in request.referenced_items:
                    await load_referenced(
                        session, ctx, workspace_id, referenced, permission="items.get"
                    )
                query = request.query.strip()
                excluded: UUID | None = None
                if request.related_item_id is not None:
                    related = await load_referenced(
                        session, ctx, workspace_id, request.related_item_id, permission="items.get"
                    )
                    query = " ".join(
                        part
                        for part in (query, related.item_name, related.description)
                        if isinstance(part, str) and part
                    )
                    excluded = related.id
                visibility = await catalog_visibility(
                    session, ctx.authorizer, ctx.principal, workspace_id
                )
                # Only the searcher's own words are interpreted, never a related item's text.
                plan = (
                    await plan_query(session, workspace_id, ctx.user_id, query)
                    if query and request.related_item_id is None
                    else None
                )
        reading: _Reading | None = None
        hits: dict[UUID, _Hit] | None = None
        if query:
            hits, reading = await self._hits(
                workspace_id, visibility, query, plan if plan is not None and plan.active else None
            )
        if hits is not None and excluded is not None:
            hits.pop(excluded, None)
        # A text search without hits matches nothing, whatever the filters say.
        nothing = hits is not None and not hits
        async with transaction_scope(self._deps.sessions) as session:
            visible = and_(Item.item_kind == "document", visibility.clause())
            scope = visible if hits is None else and_(visible, Item.id.in_(list(hits)))
            with stage("page"):
                rows, total = (
                    ([], 0)
                    if nothing
                    else await self._page(session, and_(scope, request.where), request, hits)
                )
            groups = (
                await self._group_rows(session, and_(visible, request.where), reading)
                if reading is not None and request.offset == 0
                else []
            )
            with stage("projection"):
                projector = Projector(session, ctx, workspace_id, self._deps, visibility=visibility)
                shown = {row.id: row for row in rows}
                for _, _, group_rows in groups:
                    shown.update((row.id, row) for row in group_rows)
                records = await projector.project_many(list(shown.values()))
            by_id = {record.item_id: record for record in records}
            results = [self._result(by_id[row.id], hits, request) for row in rows if row.id in by_id]
            with stage("facets"):
                facets = await self._facets(
                    session,
                    workspace_id,
                    visibility,
                    scope,
                    request,
                    matched_nothing=nothing or total == 0,
                    scope_empty=nothing,
                )
        interpretation = (
            _interpretation(
                reading,
                tuple(
                    SearchGroup(
                        option=option,
                        results=tuple(
                            self._result(by_id[row.id], group_hits, request)
                            for row in group_rows
                            if row.id in by_id
                        ),
                    )
                    for option, group_hits, group_rows in groups
                ),
            )
            if reading is not None
            else None
        )
        return SearchPage(
            results=results, facets=facets, total_size=total, interpretation=interpretation
        )

    async def _group_rows(
        self, session: AsyncSession, matching: Any, reading: _Reading
    ) -> list[tuple[str, dict[UUID, _Hit], list[Item]]]:
        """Each option's top :data:`GROUP_SIZE` matching documents, in one statement."""
        wanted = {item_id for _, hits in reading.groups for item_id in hits}
        if not wanted:
            return [(option, hits, []) for option, hits in reading.groups]
        rows = {
            row.id: row
            for row in await session.scalars(
                select(Item).where(matching, Item.id.in_(list(wanted)))
            )
        }
        groups: list[tuple[str, dict[UUID, _Hit], list[Item]]] = []
        for option, hits in reading.groups:
            ranked = sorted(
                (item_id for item_id in hits if item_id in rows),
                key=lambda item_id: (-hits[item_id].score, str(item_id)),
            )
            groups.append((option, hits, [rows[item_id] for item_id in ranked[:GROUP_SIZE]]))
        return groups

    async def _hits(
        self,
        workspace_id: UUID,
        visibility: ItemVisibility,
        query: str,
        plan: QueryPlan | None,
    ) -> tuple[dict[UUID, _Hit], _Reading | None]:
        """Hits of the index per document, ranked by the plan when there is one: a recall
        pass per reading over the readable documents its concepts match, fused with the
        plain pass, boosted, and without documents the searcher's applicability excludes.
        Each ambiguity group keeps only documents its option's filter matches."""
        if not visibility.readable:
            return {}, None
        base = await self._search_index(workspace_id, visibility, query)
        if plan is None:
            return _by_document(base), None
        readings = [plan.reading(), *plan.readings()]
        async with transaction_scope(self._deps.sessions) as session:
            admitted = visibility.clause()
            recall_ids = [await facet_items(session, reading, admitted) for reading in readings]
            names = await concept_refs(session, plan_concepts(plan))
        recalled = await asyncio.gather(
            *(
                self._search_index(workspace_id, visibility, query, within=ids)
                if ids
                else _nothing()
                for ids in recall_ids
            )
        )
        found = {UUID(chunk.item_id) for chunks in (base, *recalled) for chunk in chunks}
        async with transaction_scope(self._deps.sessions) as session:
            signals = await item_signals(session, found)
        main = rank([(plan, readings[0])], [base, recalled[0]], signals)
        groups = [
            (
                _option_label(plan, reading.option, names),
                {
                    item_id: hit
                    for item_id, hit in _by_document(
                        rank([(plan, reading)], [base, extra], signals)
                    ).items()
                    if carries(signals.get(item_id), reading.option.concepts)
                },
            )
            for reading, extra in zip(readings[1:], recalled[1:], strict=True)
            if reading.option is not None
        ]
        return _by_document(main), _Reading(plan=plan, names=names, groups=groups)

    async def _search_index(
        self,
        workspace_id: UUID,
        visibility: ItemVisibility,
        query: str,
        *,
        within: Iterable[UUID] | None = None,
    ) -> list[ContextualChunk]:
        """One index search; a late or failing index is UNAVAILABLE (retryable)."""
        try:
            return await self._deps.index.search_item_content(
                [query],
                limit=CANDIDATE_CHUNKS,
                tenant_id=str(workspace_id),
                collection_item_ids=tuple(str(value) for value in visibility.readable),
                editable_collection_ids=tuple(str(value) for value in visibility.editable),
                within_item_ids=tuple(str(value) for value in within) if within is not None else None,
            )
        except TimeoutError as exc:
            log.warning("search: the index did not answer before the search deadline")
            raise Unavailable(
                "Search could not reach the search index in time; try again.",
                reason=SEARCH_UNAVAILABLE,
            ) from exc
        except Exception as exc:  # embedding provider and index errors vary by transport
            log.warning("search: the index failed", exc_info=True)
            raise Unavailable(
                "Search could not reach the search index; try again.", reason=SEARCH_UNAVAILABLE
            ) from exc

    async def _page(
        self,
        session: AsyncSession,
        matching: Any,
        request: SearchRequest,
        hits: dict[UUID, _Hit] | None,
    ) -> tuple[list[Item], int]:
        """The requested window of matching documents and how many match in all.

        Ordered by ``orderBy`` (else newest first) the window carries the total
        (``count(*) OVER ()``); ranked by relevance every hit row loads anyway.
        """
        if hits is None or request.order_by:
            order = request.order_by or (Item.updated_at.desc(), Item.id)
            window = (
                await session.execute(
                    select(Item, func.count().over())
                    .where(matching)
                    .order_by(*order)
                    .offset(request.offset)
                    .limit(request.limit)
                )
            ).all()
            if window:
                return [item for item, _ in window], int(window[0][1])
            if request.offset == 0:
                return [], 0
            total = await session.scalar(
                select(func.count()).select_from(select(Item.id).where(matching).subquery())
            )
            return [], int(total or 0)
        rows = {row.id: row for row in await session.scalars(select(Item).where(matching))}
        ranked = sorted(rows, key=lambda item_id: (-hits[item_id].score, str(item_id)))
        window = ranked[request.offset : request.offset + request.limit]
        return [rows[item_id] for item_id in window], len(rows)

    @staticmethod
    def _result(
        record: ItemRecord, hits: dict[UUID, _Hit] | None, request: SearchRequest
    ) -> SearchResult:
        hit = hits.get(record.item_id) if hits is not None else None
        if hit is None:
            return SearchResult(item=record, score=None)
        chunks = sorted(hit.chunks, key=lambda chunk: -(chunk.relevance_score or 0.0))
        return SearchResult(
            item=record,
            score=hit.score,
            snippets=(chunks[0].chunk_text[:SNIPPET_CHARACTERS],) if request.snippets else (),
            references=tuple(
                SearchReference(
                    target=CitationTarget(
                        item_id=record.item_id,
                        revision_number=chunk.revision_number,
                        structure_version=chunk.structure_version,
                        refs=chunk.refs,
                        quote=chunk.quote,
                        location=chunk.location,
                        highlights=chunk.highlights,
                    ),
                    score=chunk.relevance_score,
                )
                for chunk in chunks[: request.references]
            ),
        )

    async def _facets(
        self,
        session: AsyncSession,
        workspace_id: UUID,
        visibility: ItemVisibility,
        scope: Any,
        request: SearchRequest,
        *,
        matched_nothing: bool,
        scope_empty: bool,
    ) -> list[Facet]:
        """Disjunctive counts: the facet's own clause is left out of ``facet.where``.

        A facet over the search's own filter counts nothing when the search
        matched nothing; with an empty scope (a text search without hits)
        every facet does. No statement runs for those.
        """
        values: dict[int, tuple[FacetValue, ...]] = {}
        grouped: list[tuple[int, FacetRequest]] = []
        for position, facet in enumerate(request.facets):
            if scope_empty or (matched_nothing and facet.matches_request):
                values[position] = _empty_values(facet)
            elif facet.field in _SCALAR_FACETS or facet.field in _INTERVAL_FACETS:
                grouped.append((position, facet))
            else:
                matching = select(Item.id).where(scope, facet.where).subquery()
                limit = facet.limit or DEFAULT_FACET_LIMIT
                values[position] = (
                    await self._concept_facet(
                        session,
                        workspace_id,
                        matching,
                        limit,
                        state=_CONCEPT_FACETS[facet.field],
                        schemes=facet.prefixes,
                    )
                    if facet.field in _CONCEPT_FACETS
                    else await self._uncertain_facet(session, workspace_id, matching, limit)
                    if facet.field == "document.uncertainSchemes"
                    else await self._space_facet(session, workspace_id, matching, limit)
                    if facet.field == "spaces"
                    else await self._ancestor_facet(
                        session, workspace_id, visibility, matching, limit
                    )
                )
        if grouped:
            values.update(
                await self._grouped_facets(session, workspace_id, scope, request.where, grouped)
            )
        return [
            Facet(field=facet.field, values=values[position])
            for position, facet in enumerate(request.facets)
        ]

    async def _grouped_facets(
        self,
        session: AsyncSession,
        workspace_id: UUID,
        scope: Any,
        request_where: Any,
        facets: Sequence[tuple[int, FacetRequest]],
    ) -> dict[int, tuple[FacetValue, ...]]:
        """Value and interval facets (by request position) in one statement.

        The visible documents any of the facets matches are read once;
        ``GROUPING SETS`` groups them per value facet (plus the grand total that
        carries the interval counts, inclusive bounds) and each facet counts only
        the documents its own ``where`` matches (``count(*) FILTER``). A value
        facet keeps its ``limit`` most frequent non-null values (ties by value);
        owners carry their display names (else email) while they are members of
        the workspace, like GetMember.
        """
        # One match column per distinct filter: facets on the request's own filter share one.
        match_columns: dict[int, str] = {}
        columns: list[Any] = [Item.id]
        conditions: list[Any] = []
        if any(facet.matches_request for _, facet in facets):
            columns.append(request_where.label("m_request"))
            conditions.append(request_where)
        for position, facet in facets:
            if facet.matches_request:
                match_columns[position] = "m_request"
            else:
                match_columns[position] = f"m{position}"
                columns.append(facet.where.label(f"m{position}"))
                conditions.append(facet.where)
        value_facets = [(p, facet) for p, facet in facets if facet.field in _SCALAR_FACETS]
        interval_facets = [(p, facet) for p, facet in facets if facet.field in _INTERVAL_FACETS]
        columns.extend(_SCALAR_FACETS[facet.field].label(f"v{p}") for p, facet in value_facets)
        columns.extend(
            _INTERVAL_FACETS[facet.field].label(f"t{p}") for p, facet in interval_facets
        )
        documents = select(*columns).where(scope, or_(*conditions)).subquery("facet_documents")
        d = documents.c
        interval_counts = [
            func.count()
            .filter(and_(d[match_columns[p]], _within(d[f"t{p}"], interval)))
            .label(f"i{p}_{k}")
            for p, facet in interval_facets
            for k, interval in enumerate(facet.intervals)
        ]
        results: dict[int, tuple[FacetValue, ...]] = {}
        if not value_facets:
            row = (await session.execute(select(*interval_counts))).one()
            results.update(_interval_values(interval_facets, row._mapping))
            return results

        # GROUPING() sets a bit (leftmost argument = highest) per column a row is not grouped by.
        width = len(value_facets)
        total = (1 << width) - 1
        masks = {p: total - (1 << (width - 1 - k)) for k, (p, _) in enumerate(value_facets)}
        value_columns = [d[f"v{p}"] for p, _ in value_facets]
        sets = [tuple_(column) for column in value_columns]
        if interval_facets:
            sets.append(tuple_())
        groups = (
            select(
                func.grouping(*value_columns).label("grouping_set"),
                *value_columns,
                *(
                    func.count().filter(d[match_columns[p]]).label(f"c{p}")
                    for p, _ in value_facets
                ),
                *interval_counts,
            )
            .group_by(func.grouping_sets(*sets))
            .subquery("facet_groups")
        )
        g = groups.c
        value = case(
            {masks[p]: cast(g[f"v{p}"], Text) for p, _ in value_facets}, value=g.grouping_set
        )
        documents_count = case(
            {masks[p]: g[f"c{p}"] for p, _ in value_facets}, value=g.grouping_set
        )
        interval_names = [column.name for column in interval_counts]
        ranked = (
            select(
                g.grouping_set,
                value.label("value"),
                documents_count.label("documents"),
                *(g[name] for name in interval_names),
                func.row_number()
                .over(partition_by=g.grouping_set, order_by=(documents_count.desc(), value))
                .label("position"),
            )
            .where(
                or_(
                    g.grouping_set == total,
                    and_(value.is_not(None), documents_count > 0),
                )
            )
            .subquery("facet_ranked")
        )
        r = ranked.c
        limit = case(
            {masks[p]: facet.limit or DEFAULT_FACET_LIMIT for p, facet in value_facets},
            value=r.grouping_set,
        )
        statement = select(
            r.grouping_set, r.value, r.documents, *(r[name] for name in interval_names)
        )
        source: Any = ranked
        owner_sets = [masks[p] for p, facet in value_facets if facet.field == "document.owner"]
        if owner_sets:
            owner = case(
                (r.grouping_set.in_(owner_sets), cast(r.value, PG_UUID(as_uuid=True))),
                else_=None,
            )
            source = ranked.outerjoin(
                TenantMembership,
                and_(
                    TenantMembership.user_id == owner,
                    TenantMembership.tenant_id == workspace_id,
                    TenantMembership.deleted_at.is_(None),
                ),
            ).outerjoin(User, User.id == TenantMembership.user_id)
            statement = statement.add_columns(
                func.coalesce(User.user_name, User.email).label("owner_name")
            )
        rows = await session.execute(
            statement.select_from(source)
            .where(or_(r.grouping_set == total, r.position <= limit))
            .order_by(r.grouping_set, r.position)
        )
        positions = {mask: p for p, mask in masks.items()}
        values: dict[int, list[FacetValue]] = {p: [] for p, _ in value_facets}
        for row in rows:
            fields = row._mapping
            if fields["grouping_set"] == total:
                results.update(_interval_values(interval_facets, fields))
                continue
            values[positions[fields["grouping_set"]]].append(
                FacetValue(
                    value=fields["value"],
                    display_name=fields.get("owner_name") or None,
                    document_count=int(fields["documents"]),
                )
            )
        results.update({p: tuple(entries) for p, entries in values.items()})
        return results

    async def _concept_facet(
        self,
        session: AsyncSession,
        workspace_id: UUID,
        matching: Any,
        limit: int,
        *,
        state: str,
        schemes: Sequence[str],
    ) -> tuple[FacetValue, ...]:
        """Counts per concept, hierarchical like the ``document.concepts:`` filter: a concept
        counts the documents labeled (in ``state``) with it or any concept below it, each
        once however many labels or parents lead there (poly-hierarchy). ``schemes``
        (``FacetKey.prefixes``) keeps those schemes' concepts; none = every classification
        scheme. Values are ``{scheme}/{notation}`` with the current prefLabel."""
        pairs = (
            select(ItemConcept.item_id, ConceptClosure.ancestor_id)
            .join(ConceptClosure, ConceptClosure.descendant_id == ItemConcept.concept_id)
            .where(ItemConcept.item_id.in_(select(matching.c.id)), ItemConcept.state == state)
            .distinct()
            .subquery("facet_concepts")
        )
        documents = func.count()
        rows = await session.execute(
            select(ConceptScheme.code, Concept.notation, preferred_label(Concept.id), documents)
            .select_from(pairs)
            .join(Concept, Concept.id == pairs.c.ancestor_id)
            .join(ConceptScheme, ConceptScheme.id == Concept.scheme_id)
            .where(
                ConceptScheme.tenant_id == workspace_id,
                ConceptScheme.deleted_at.is_(None),
                ConceptScheme.code.in_(list(schemes))
                if schemes
                else ConceptScheme.purpose == "classification",
            )
            .group_by(Concept.id, ConceptScheme.code, Concept.notation)
            .order_by(documents.desc(), ConceptScheme.code, Concept.notation)
            .limit(limit)
        )
        return tuple(
            FacetValue(
                value=f"{scheme}/{notation}",
                display_name=display_name or notation,
                document_count=int(count),
            )
            for scheme, notation, display_name, count in rows.tuples()
        )

    async def _uncertain_facet(
        self, session: AsyncSession, workspace_id: UUID, matching: Any, limit: int
    ) -> tuple[FacetValue, ...]:
        """Counts per scheme of the documents the classifier left uncertain in it (the
        ``document.uncertainSchemes:`` filter); values are scheme codes with their names."""
        documents = func.count()
        rows = await session.execute(
            select(ConceptScheme.code, ConceptScheme.scheme_name, documents)
            .join(ItemClassification, ItemClassification.scheme_id == ConceptScheme.id)
            .where(
                ItemClassification.item_id.in_(select(matching.c.id)),
                ItemClassification.outcome == "uncertain",
                ConceptScheme.tenant_id == workspace_id,
                ConceptScheme.deleted_at.is_(None),
            )
            .group_by(ConceptScheme.id, ConceptScheme.code, ConceptScheme.scheme_name)
            .order_by(documents.desc(), ConceptScheme.code)
            .limit(limit)
        )
        return tuple(
            FacetValue(value=code, display_name=name, document_count=int(count))
            for code, name, count in rows.tuples()
        )

    async def _ancestor_facet(
        self,
        session: AsyncSession,
        workspace_id: UUID,
        visibility: ItemVisibility,
        matching: Any,
        limit: int,
    ) -> tuple[FacetValue, ...]:
        """Counts per readable ancestor collection (the ``Item.ancestors`` truncation)."""
        seed = select(Item.id.label("document_id"), Item.parent_item_id.label("ancestor_id")).where(
            Item.id.in_(select(matching.c.id))
        ).cte("facet_ancestors", recursive=True)
        parent = Item.__table__.alias("facet_parent")
        tree = seed.union_all(
            select(seed.c.document_id, parent.c.parent_item_id).where(
                parent.c.id == seed.c.ancestor_id, parent.c.parent_item_id.is_not(None)
            )
        )
        rows = await session.execute(
            select(Item.id, Item.item_name, func.count(func.distinct(tree.c.document_id)))
            .join(tree, tree.c.ancestor_id == Item.id)
            .where(Item.item_kind == "collection", Item.id.in_(visibility.readable))
            .group_by(Item.id, Item.item_name)
            .order_by(func.count(func.distinct(tree.c.document_id)).desc(), Item.item_name)
            .limit(limit)
        )
        return tuple(
            FacetValue(
                value=str(identifier),
                display_name=name,
                document_count=int(count),
            )
            for identifier, name, count in rows
        )

    async def _space_facet(
        self, session: AsyncSession, workspace_id: UUID, matching: Any, limit: int
    ) -> tuple[FacetValue, ...]:
        """Counts per live space whose materials hold the document: pinned itself or under
        a pinned collection (the ``spaces:`` filter). Each document's live self-and-ancestor
        chain is joined to ``space_materials (item_id)``."""
        seed = select(Item.id.label("document_id"), Item.id.label("holder_id")).where(
            Item.id.in_(select(matching.c.id))
        ).cte("facet_space_chain", recursive=True)
        holder = Item.__table__.alias("facet_holder")
        parent = Item.__table__.alias("facet_holder_parent")
        chain = seed.union_all(
            select(seed.c.document_id, parent.c.id).where(
                holder.c.id == seed.c.holder_id,
                parent.c.id == holder.c.parent_item_id,
                parent.c.deleted_at.is_(None),
            )
        )
        documents = func.count(func.distinct(chain.c.document_id))
        rows = await session.execute(
            select(Space.code, Space.space_name, documents)
            .join(SpaceMaterial, SpaceMaterial.space_id == Space.id)
            .join(chain, chain.c.holder_id == SpaceMaterial.item_id)
            .where(Space.tenant_id == workspace_id, Space.deleted_at.is_(None))
            .group_by(Space.id, Space.code, Space.space_name)
            .order_by(documents.desc(), Space.code)
            .limit(limit)
        )
        return tuple(
            FacetValue(value=code, display_name=name, document_count=int(count))
            for code, name, count in rows
        )


def _within(column: Any, interval: Interval) -> Any:
    """``column`` inside ``interval`` (inclusive bounds; an open side matches)."""
    return and_(
        column >= interval.minimum if interval.minimum is not None else true(),
        column <= interval.maximum if interval.maximum is not None else true(),
    )


def _interval_values(
    facets: Sequence[tuple[int, FacetRequest]], counts: Mapping[str, Any]
) -> dict[int, tuple[FacetValue, ...]]:
    """One value per requested interval, in request order, from the ``i{position}_{k}`` counts."""
    return {
        p: tuple(
            FacetValue(
                value=None,
                display_name=None,
                document_count=int(counts[f"i{p}_{k}"]),
                interval=interval,
            )
            for k, interval in enumerate(facet.intervals)
        )
        for p, facet in facets
    }


def _empty_values(facet: FacetRequest) -> tuple[FacetValue, ...]:
    """A facet over no documents: no values, or a zero count per interval."""
    return tuple(
        FacetValue(value=None, display_name=None, document_count=0, interval=interval)
        for interval in facet.intervals
    )


def _by_document(chunks: Sequence[ContextualChunk]) -> dict[UUID, _Hit]:
    """Hits per document: its chunks, scored by its best one."""
    hits: dict[UUID, _Hit] = {}
    for chunk in chunks:
        hit = hits.setdefault(UUID(chunk.item_id), _Hit(score=0.0, chunks=[]))
        hit.score = max(hit.score, chunk.relevance_score or 0.0)
        hit.chunks.append(chunk)
    return hits


async def _nothing() -> list[ContextualChunk]:
    return []


def _option_label(plan: QueryPlan, option: Any, names: Mapping[UUID, ConceptRef]) -> str:
    return reading_label(plan, option.scheme, option.concepts, names)


def _interpretation(
    reading: _Reading, groups: tuple[SearchGroup, ...]
) -> SearchInterpretation | None:
    """``SearchItemsResponse.interpretation``; None when the query names no concept."""
    interpretation = reading.plan.interpretation
    names = reading.names
    concepts = tuple(
        InterpretedConcept(scheme=term.scheme, notation=names[cid].notation, text=term.text)
        for term in interpretation.terms
        for cid in term.concepts
        if cid in names
    )
    ambiguities = tuple(
        InterpretationAmbiguity(
            text=ambiguity.text,
            options=tuple(
                InterpretationOption(
                    scheme=option.scheme,
                    concepts=tuple(
                        (names[cid].scheme, names[cid].notation)
                        for cid in option.concepts
                        if cid in names
                    ),
                    display_name=_option_label(reading.plan, option, names),
                )
                for option in ambiguity.options
            ),
        )
        for ambiguity in interpretation.ambiguities
    )
    if not concepts and not ambiguities:
        return None
    return SearchInterpretation(concepts=concepts, ambiguities=ambiguities, groups=groups)


async def retrieve_passages(
    retriever: ItemKnowledgeRetriever,
    access: WorkspaceAccess,
    queries: Sequence[str],
    scope_collections: Sequence[UUID] | None,
    *,
    limit: int,
) -> list[Evidence]:
    """Passages the caller may read for the agent's knowledge tool.

    ``scope_collections`` narrows the search to those collections' subtrees;
    ``None`` searches every collection the caller can read. The retriever
    re-checks every hit in PostgreSQL.
    """
    if scope_collections is None:
        scope_collections = tuple(await access.allowed_collections("items.get"))
    return await retriever.search(
        queries,
        limit=limit,
        ctx=_Scope(
            tenant_id=str(access.workspace_id),
            user_id=str(access.user_id),
            collection_item_ids=tuple(str(value) for value in scope_collections),
        ),
    )


@dataclass(frozen=True, slots=True)
class _Scope:
    tenant_id: str
    user_id: str
    collection_item_ids: tuple[str, ...]
    document_item_ids: tuple[str, ...] = ()


__all__ = ["FACET_FIELDS", "INTERVAL_FACET_FIELDS", "ItemSearchService", "retrieve_passages"]
