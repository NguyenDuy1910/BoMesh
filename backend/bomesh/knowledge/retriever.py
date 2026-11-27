"""Permission-scoped retrieval policy over indexed Item content.

PostgreSQL decides, the index pre-filters (``item_model.md`` §4.10): the
readable and editable collections are computed per search, the index returns
only points of readable collections that are published or editable, and every
hit is re-checked against the visibility rule before any text is returned.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import math
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import replace
from uuid import UUID

from bomesh.document_index import ContextualChunk, ItemContentIndex
from bomesh.document_structure import CitationTarget
from bomesh.knowledge import (
    DocumentFacts,
    Evidence,
    RankedList,
    ReadAccess,
    ReadScope,
    Reranker,
    Retrieval,
    RetrievalContext,
    SearchRanking,
)

log = logging.getLogger(__name__)


class ItemKnowledgeRetriever:
    """Enforce Collection visibility, ranking, and evidence construction."""

    def __init__(
        self,
        index: ItemContentIndex,
        *,
        access: ReadAccess,
        reranker: Reranker | None = None,
        ranking: SearchRanking | None = None,
        candidate_count: int = 20,
        reranking_enabled: bool = False,
        rerank_timeout_seconds: float = 8.0,
    ) -> None:
        if candidate_count < 1:
            raise ValueError("candidate_count must be at least one")
        if rerank_timeout_seconds <= 0:
            raise ValueError("rerank_timeout_seconds must be greater than zero")
        self._index = index
        self._access = access
        self._reranker = reranker
        self._ranking = ranking
        self._candidate_count = candidate_count
        self._reranking_enabled = reranking_enabled
        # Shorter than the tool budget, so a slow reranker falls back to the
        # fused order instead of timing out the whole search.
        self._rerank_timeout_seconds = rerank_timeout_seconds

    async def search(
        self,
        queries: Sequence[str],
        *,
        limit: int,
        ctx: RetrievalContext,
        context_chunks: int = 0,
    ) -> list[Evidence]:
        retrieval = await self.search_interpreted(
            queries, limit=limit, ctx=ctx, context_chunks=context_chunks
        )
        return retrieval.evidence

    async def search_interpreted(
        self,
        queries: Sequence[str],
        *,
        limit: int,
        ctx: RetrievalContext,
        context_chunks: int = 0,
    ) -> Retrieval:
        """The search with the taxonomy ranking (``conversation_loop.md`` "Knowledge retrieval"; ``api_design.md`` SearchItems), when set:
        recall passes narrowed to the documents each reading's concepts match, fused with
        the plain pass and boosted; an ambiguous query's evidence comes in one group per
        reading, each group an equal share of ``limit``."""
        normalized_queries = _validate_search(queries, limit=limit)
        if context_chunks < 0:
            raise ValueError("context_chunks must not be negative")
        tenant_id = _validate_tenant_id(ctx.tenant_id)
        if not ctx.collection_item_ids and not ctx.document_item_ids:
            return Retrieval(evidence=[])
        scope = await self._access.scope(ctx)
        if not scope.readable and not scope.documents:
            return Retrieval(evidence=[])
        plan = (
            await self._ranking.plan(ctx, normalized_queries, scope)
            if self._ranking is not None
            else None
        )
        interpretations = plan.interpretations if plan is not None else ()
        candidates_limit = max(limit, self._candidate_count)
        chunks = await self._candidates(normalized_queries, tenant_id, scope, candidates_limit)
        if plan is None:
            lists = [RankedList(chunks=chunks)] if chunks else []
        else:
            passes = await asyncio.gather(
                *(
                    self._candidates(
                        [recall.query], tenant_id, scope, candidates_limit, within=recall.item_ids
                    )
                    for recall in plan.recalls
                )
            )
            lists = await plan.order(
                chunks,
                {recall.key: found for recall, found in zip(plan.recalls, passes, strict=True)},
            )
        candidates = [chunk for ranked in lists for chunk in ranked.chunks]
        if not candidates:
            return Retrieval(evidence=[], interpretations=interpretations)
        facts = await scope.recheck([chunk.item_id for chunk in candidates])
        ranked, groups = await self._final(lists, facts, normalized_queries, limit)
        evidence = [
            replace(_evidence_from_chunk(chunk, facts[chunk.item_id]), group=group)
            for chunk, group in zip(ranked, groups, strict=True)
        ]
        if context_chunks and ranked:
            evidence = await self._with_context(
                ranked, evidence, facts, tenant_id=tenant_id, count=context_chunks
            )
        return Retrieval(evidence=evidence, interpretations=interpretations)

    async def _candidates(
        self,
        queries: Sequence[str],
        tenant_id: str,
        scope: ReadScope,
        limit: int,
        *,
        within: tuple[str, ...] | None = None,
    ) -> list[ContextualChunk]:
        return await self._index.search_item_content(
            queries,
            limit=limit,
            tenant_id=tenant_id,
            collection_item_ids=scope.readable,
            editable_collection_ids=scope.editable,
            document_item_ids=scope.documents,
            within_item_ids=within,
        )

    async def _final(
        self,
        lists: Sequence[RankedList],
        facts: Mapping[str, DocumentFacts],
        queries: list[str],
        limit: int,
    ) -> tuple[list[ContextualChunk], list[str | None]]:
        """The matches shown and their groups: the reranked single list, or an equal
        share of ``limit`` per group (each chunk once, in its first group)."""
        allowed = [
            [chunk for chunk in ranked.chunks if chunk.item_id in facts] for ranked in lists
        ]
        if len(lists) == 1 and lists[0].group is None:
            chosen = await self._rank(allowed[0], queries=queries, limit=limit) if allowed[0] else []
            return chosen, [None] * len(chosen)
        share = max(1, math.ceil(limit / max(len(lists), 1)))
        chunks: list[ContextualChunk] = []
        groups: list[str | None] = []
        taken: set[str] = set()
        for ranked, kept in zip(lists, allowed, strict=True):
            fresh = [chunk for chunk in kept if chunk.id not in taken][:share]
            taken.update(chunk.id for chunk in fresh)
            chunks.extend(fresh)
            groups.extend([ranked.group] * len(fresh))
        return chunks, groups

    async def _with_context(
        self,
        ranked: list[ContextualChunk],
        evidence: list[Evidence],
        facts: Mapping[str, DocumentFacts],
        *,
        tenant_id: str,
        count: int,
    ) -> list[Evidence]:
        """Each match with ``count`` neighbours a side (on a sheet, the rest of its row), in one index read.

        The matches' documents were re-checked just now, so their neighbours widen nothing. A
        failed read leaves the matches alone: context helps, it is not the evidence.
        """

        wanted: dict[str, set[int]] = defaultdict(set)
        for chunk in ranked:
            reach = _ROW_PARTS if _on_sheet(chunk) else count
            wanted[chunk.item_id].update(range(max(0, chunk.chunk_index - reach), chunk.chunk_index + reach + 1))
        try:
            found = await self._index.get_item_chunks(tenant_id=tenant_id, chunks=wanted)
        except Exception as exc:  # noqa: BLE001 - context is best effort
            log.warning("retrieval context unavailable; matches only: %s", type(exc).__name__)
            return evidence
        at = {(chunk.item_id, chunk.chunk_index): chunk for chunk in found}
        taken = {(chunk.item_id, chunk.chunk_index) for chunk in ranked}
        output: list[Evidence] = []
        for chunk, item in zip(ranked, evidence, strict=True):
            before = _neighbours(chunk, at, taken, step=-1, count=count)
            after = _neighbours(chunk, at, taken, step=1, count=count)
            taken.update((part.item_id, part.chunk_index) for part in (*before, *after))
            document = facts[chunk.item_id]
            output.append(
                replace(
                    item,
                    context_before=tuple(_evidence_from_chunk(part, document) for part in reversed(before)),
                    context_after=tuple(_evidence_from_chunk(part, document) for part in after),
                )
            )
        return output

    async def _rank(
        self,
        chunks: list[ContextualChunk],
        *,
        queries: list[str],
        limit: int,
    ) -> list[ContextualChunk]:
        if not self._reranking_enabled or self._reranker is None:
            return _score_order(chunks, limit=limit)
        try:
            async with asyncio.timeout(self._rerank_timeout_seconds):
                result = self._reranker.rerank(chunks, queries=queries, limit=limit)
                if inspect.isawaitable(result):
                    result = await result
            ranked = list(result)
            if any(not isinstance(chunk, ContextualChunk) for chunk in ranked):
                raise ValueError("reranker returned invalid candidates")
            allowed_ids = {chunk.id for chunk in chunks}
            ranked_ids = [chunk.id for chunk in ranked]
            if not set(ranked_ids).issubset(allowed_ids) or len(ranked_ids) != len(
                set(ranked_ids)
            ):
                raise ValueError("reranker returned invalid candidates")
            # The reranker is the relevance gate: what it leaves out, and an
            # empty answer, are judgments, not failures.
            return ranked[:limit]
        except Exception as exc:  # noqa: BLE001 - optional reranking must fail open
            # Validation failures carry only positions and identifiers, so the
            # reason is logged; anything else could echo a provider payload.
            reason = str(exc) if isinstance(exc, (ValueError, TypeError)) else ""
            log.warning(
                "retrieval reranking failed; preserving score order: %s%s",
                type(exc).__name__,
                f": {reason}" if reason else "",
            )
            return _score_order(chunks, limit=limit)


#: Parts of one table row (chunks with the same sheet highlight) a match on a
#: sheet brings, a side, instead of ``context_chunks``: a long row is cut into
#: parts, and only its first part says whom the row is about.
_ROW_PARTS = 8


def _on_sheet(chunk: ContextualChunk) -> bool:
    return any(highlight.sheet for highlight in chunk.highlights)


def _neighbours(
    match: ContextualChunk,
    at: Mapping[tuple[str, int], ContextualChunk],
    taken: set[tuple[str, int]],
    *,
    step: int,
    count: int,
) -> list[ContextualChunk]:
    """The chunks next to ``match`` going ``step`` (-1 before, 1 after), nearest first.

    A neighbour is the same indexed revision under the same heading or sheet
    (``location``), not another match and not one an earlier match took. On a
    sheet it is only another part of the match's own row: every row line names
    its columns, so the next row is another record, not context.
    """

    found: list[ContextualChunk] = []
    sheet = _on_sheet(match)
    index = match.chunk_index + step
    while (chunk := at.get((match.item_id, index))) is not None and (match.item_id, index) not in taken:
        if (chunk.revision_number, chunk.structure_version, chunk.location) != (
            match.revision_number,
            match.structure_version,
            match.location,
        ):
            break
        if sheet and (chunk.highlights != match.highlights or len(found) == _ROW_PARTS):
            break
        if not sheet and len(found) == count:
            break
        found.append(chunk)
        index += step
    return found


def _score_order(chunks: list[ContextualChunk], *, limit: int) -> list[ContextualChunk]:
    return sorted(
        chunks,
        key=lambda chunk: (
            chunk.relevance_score
            if chunk.relevance_score is not None
            else float("-inf")
        ),
        reverse=True,
    )[:limit]


def _evidence_from_chunk(chunk: ContextualChunk, document: DocumentFacts) -> Evidence:
    # ``id`` starts as the chunk id; the agent's search tool replaces it with the
    # run-scoped ``ref_N`` the model cites (``CitationReferences``).
    return Evidence(
        id=chunk.id,
        item_id=chunk.item_id,
        chunk_id=chunk.id,
        collection_item_id=chunk.collection_item_id,
        title=chunk.title or chunk.item_id,
        content=chunk.chunk_text,
        target=CitationTarget(
            item_id=UUID(chunk.item_id),
            revision_number=chunk.revision_number,
            structure_version=chunk.structure_version,
            refs=chunk.refs,
            quote=chunk.quote,
            location=chunk.location,
            highlights=chunk.highlights,
        ),
        source=chunk.source,
        section_path=tuple(chunk.context.section_path),
        contextual_text=chunk.contextual_text,
        relevance_score=chunk.relevance_score,
        rerank_score=chunk.rerank_score,
        document=document,
    )


def _validate_search(queries: Sequence[str], *, limit: int) -> list[str]:
    # A bare string is a sequence too; searching its characters is never meant.
    if isinstance(queries, str):
        raise TypeError("queries must be a sequence of strings, not one string")
    normalized_queries = list(
        dict.fromkeys(" ".join(query.split()) for query in queries)
    )
    if not normalized_queries or not all(normalized_queries):
        raise ValueError("queries must not be empty")
    if limit < 1:
        raise ValueError("limit must be at least one")
    return normalized_queries


def _validate_tenant_id(tenant_id: str) -> str:
    normalized_tenant_id = tenant_id.strip() if isinstance(tenant_id, str) else ""
    if not normalized_tenant_id:
        raise ValueError("tenant_id must not be empty")
    return normalized_tenant_id


__all__ = ["ItemKnowledgeRetriever"]
