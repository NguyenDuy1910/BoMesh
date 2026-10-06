"""Permission-scoped retrieval policy over indexed Item content."""

from __future__ import annotations

import inspect
import logging
from collections.abc import Sequence
from hashlib import sha256

from bomesh.document_index import ContextualChunk, ItemContentIndex
from bomesh.knowledge import Evidence, Reranker, RetrievalContext

log = logging.getLogger(__name__)


class ItemKnowledgeRetriever:
    """Enforce Collection visibility, ranking, and evidence construction."""

    def __init__(
        self,
        index: ItemContentIndex,
        *,
        reranker: Reranker | None = None,
        candidate_count: int = 20,
        reranking_enabled: bool = True,
    ) -> None:
        if candidate_count < 1:
            raise ValueError("candidate_count must be at least one")
        self._index = index
        self._reranker = reranker
        self._candidate_count = candidate_count
        self._reranking_enabled = reranking_enabled

    async def search(
        self,
        queries: Sequence[str],
        *,
        limit: int,
        ctx: RetrievalContext,
    ) -> list[Evidence]:
        normalized_queries = _validate_search(queries, limit=limit)
        tenant_id = _validate_tenant_id(ctx.tenant_id)
        if not ctx.collection_item_ids:
            return []
        chunks = await self._index.search_item_content(
            normalized_queries,
            limit=max(limit, self._candidate_count),
            tenant_id=tenant_id,
            collection_item_ids=ctx.collection_item_ids,
        )
        allowed_collections = set(ctx.collection_item_ids)
        visible = [
            chunk for chunk in chunks if chunk.collection_item_id in allowed_collections
        ]
        if not visible:
            return []
        ranked = await self._rank(visible, queries=normalized_queries, limit=limit)
        return [_evidence_from_chunk(chunk) for chunk in ranked]

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


def source_reference(item_id: str, chunk_id: str) -> str:
    """Return the stable, model-safe reference for one retrieved chunk.

    The model never sees an Item or chunk identifier: it cites this reference,
    and the backend maps it back to canonical metadata. The value is derived
    from the identity it stands for, so the same chunk keeps the same reference
    across retrieval rounds and concurrent tool calls without run state.
    """

    digest = sha256(f"{item_id}\0{chunk_id}".encode()).hexdigest()
    return f"source-{digest[:8]}"


def _evidence_from_chunk(chunk: ContextualChunk) -> Evidence:
    return Evidence(
        id=source_reference(chunk.item_id, chunk.id),
        item_id=chunk.item_id,
        chunk_id=chunk.id,
        collection_item_id=chunk.collection_item_id,
        title=chunk.title or chunk.item_id,
        content=chunk.chunk_text,
        source=chunk.source,
        citation=chunk.citation,
        section_path=tuple(chunk.context.section_path),
        contextual_text=chunk.contextual_text,
        relevance_score=chunk.relevance_score,
        rerank_score=chunk.rerank_score,
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


__all__ = ["ItemKnowledgeRetriever", "source_reference"]
