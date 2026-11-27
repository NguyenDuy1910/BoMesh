"""The taxonomy ranking of agent retrieval (``conversation_loop.md`` "Knowledge retrieval").

:class:`TaxonomySearchRanking` is the :class:`~bomesh.knowledge.SearchRanking` the
retriever consults: every query of a ``knowledge_search`` call is interpreted and
ranked as SearchItems ranks it (:mod:`bomesh.services.taxonomy.ranking`), and the
first ambiguous query's evidence comes in one group per reading, so the model can
say how it read the question or ask which reading was meant.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import or_
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item
from bomesh.document_index import ContextualChunk
from bomesh.iam.visibility import ItemVisibility
from bomesh.knowledge import (
    QueryInterpretation,
    RankedList,
    ReadScope,
    Recall,
    RetrievalContext,
)
from bomesh.services.taxonomy.ranking import (
    ConceptRef,
    QueryPlan,
    Reading,
    concept_refs,
    facet_items,
    item_signals,
    plan_concepts,
    plan_queries,
    rank,
    reading_label,
)


class TaxonomySearchRanking:
    """Plans one retrieval's interpretation, recall passes and boosts in PostgreSQL."""

    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = sessions

    async def plan(
        self, ctx: RetrievalContext, queries: Sequence[str], scope: ReadScope
    ) -> _Plan | None:
        workspace_id = UUID(ctx.tenant_id)
        visibility = ItemVisibility(
            workspace_id=workspace_id,
            readable=frozenset(UUID(value) for value in scope.readable),
            editable=frozenset(UUID(value) for value in scope.editable),
        )
        admitted = visibility.clause()
        if scope.documents:
            admitted = or_(admitted, Item.id.in_([UUID(value) for value in scope.documents]))
        async with transaction_scope(self._sessions) as session:
            plans = await plan_queries(session, workspace_id, UUID(ctx.user_id), queries)
            if not any(plan.active for plan in plans):
                return None
            grouped = next(
                (index for index, plan in enumerate(plans) if plan.interpretation.options()),
                None,
            )
            recalls: list[Recall] = []
            for index, (query, plan) in enumerate(zip(queries, plans, strict=True)):
                readings = [(str(index), plan.reading())]
                if index == grouped:
                    readings += [
                        (f"{index}:{position}", reading)
                        for position, reading in enumerate(plan.readings())
                    ]
                for key, reading in readings:
                    ids = await facet_items(session, reading, admitted)
                    if ids:
                        recalls.append(
                            Recall(key=key, query=query, item_ids=tuple(str(value) for value in ids))
                        )
            names = await concept_refs(
                session, {cid for plan in plans for cid in plan_concepts(plan)}
            )
        return _Plan(
            sessions=self._sessions,
            plans=tuple(plans),
            grouped=grouped,
            names=names,
            recalls=tuple(recalls),
            interpretations=tuple(
                _interpretation(query, plan, names)
                for query, plan in zip(queries, plans, strict=True)
            ),
        )


def _interpretation(
    query: str, plan: QueryPlan, names: Mapping[UUID, ConceptRef]
) -> QueryInterpretation:
    interpretation = plan.interpretation
    concepts = [
        f'"{term.text}" → {reading_label(plan, term.scheme, term.concepts, names)}'
        for term in interpretation.terms
    ]
    concepts += [
        f"names {names[cid].display_name}"
        for cid in sorted(interpretation.authorities, key=str)
        if cid in names
    ]
    ambiguity = interpretation.ambiguities[0] if interpretation.ambiguities else None
    return QueryInterpretation(
        query=query,
        concepts=tuple(concepts),
        ambiguity=ambiguity.text if ambiguity is not None else None,
        options=tuple(
            reading_label(plan, option.scheme, option.concepts, names)
            for option in (ambiguity.options if ambiguity is not None else ())
        ),
    )


@dataclass(frozen=True, slots=True)
class _Plan:
    sessions: async_sessionmaker[AsyncSession]
    plans: tuple[QueryPlan, ...]
    #: The query whose ambiguity is answered as groups.
    grouped: int | None
    names: Mapping[UUID, ConceptRef]
    recalls: tuple[Recall, ...]
    interpretations: tuple[QueryInterpretation, ...]

    async def order(
        self, base: Sequence[ContextualChunk], recalled: Mapping[str, Sequence[ContextualChunk]]
    ) -> list[RankedList]:
        found = [*base, *(chunk for chunks in recalled.values() for chunk in chunks)]
        if not found:
            return []
        async with transaction_scope(self.sessions) as session:
            signals = await item_signals(session, {UUID(chunk.item_id) for chunk in found})
        if self.grouped is None:
            main_passes = [base, *(recalled.get(str(index), ()) for index in range(len(self.plans)))]
            readings = [(plan, plan.reading()) for plan in self.plans]
            return [RankedList(chunks=rank(readings, main_passes, signals))]
        plan = self.plans[self.grouped]
        groups: list[RankedList] = []
        for position, reading in enumerate(plan.readings()):
            passes = [base, recalled.get(f"{self.grouped}:{position}", ())]
            groups.append(
                RankedList(
                    chunks=rank([(plan, reading)], passes, signals),
                    group=_option_label(plan, reading, self.names),
                )
            )
        return groups


def _option_label(plan: QueryPlan, reading: Reading, names: Mapping[UUID, ConceptRef]) -> str:
    option = reading.option
    assert option is not None
    return reading_label(plan, option.scheme, option.concepts, names)


__all__ = ["TaxonomySearchRanking"]
