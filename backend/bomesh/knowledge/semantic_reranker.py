"""LLM-backed relevance gate and ranking over permission-filtered candidates."""

from __future__ import annotations

import json
from collections.abc import Sequence

from bomesh import ModelResponseClient, render_prompt
from bomesh.document_index import ContextualChunk


class SemanticReranker:
    """Keep the candidates a model judges useful, in the order it ranks them."""

    def __init__(
        self,
        transport: ModelResponseClient,
        *,
        model_name: str | None = None,
        # A reasoning model spends this same budget on reasoning before it
        # writes anything, so a small cap returns an empty response rather than
        # the ID list. The headroom keeps the ordering bounded but reachable.
        max_output_tokens: int = 2_048,
        max_candidate_characters: int = 2_400,
    ) -> None:
        if max_output_tokens < 1 or max_candidate_characters < 1:
            raise ValueError("reranker limits must be greater than zero")
        self._transport = transport
        self._model_name = model_name
        self._max_output_tokens = max_output_tokens
        self._max_candidate_characters = max_candidate_characters

    async def rerank(
        self,
        chunks: Sequence[ContextualChunk],
        *,
        queries: Sequence[str],
        limit: int,
    ) -> list[ContextualChunk]:
        normalized_queries = [query.strip() for query in queries if query.strip()]
        if not normalized_queries:
            raise ValueError("reranking queries must not be empty")
        if limit < 1:
            raise ValueError("limit must be at least one")
        candidates = list(chunks)
        if not candidates:
            return []
        prompt = render_prompt(
            "retrieval_rerank",
            queries=normalized_queries,
            candidates=[self._candidate(chunk) for chunk in candidates],
            result_limit=min(limit, len(candidates)),
        )
        response = await self._transport.responses(
            model=self._model_name,
            input=prompt,
            max_output_tokens=self._max_output_tokens,
            temperature=0,
        )
        raw_text = getattr(response, "output_text", None)
        if not isinstance(raw_text, str) or not raw_text.strip():
            raise ValueError(
                "reranker returned no text "
                f"(status={getattr(response, 'status', 'unknown')})"
            )
        by_id = {chunk.id: chunk for chunk in candidates}
        # Candidates the model leaves out are judged not useful and dropped;
        # an empty list means no candidate answers the queries.
        selected = [by_id[chunk_id] for chunk_id in self._ordered_ids(raw_text, candidates)]
        selected = selected[:limit]
        denominator = max(1, len(selected))
        return [
            chunk.model_copy(
                update={"rerank_score": (denominator - rank) / denominator}
            )
            for rank, chunk in enumerate(selected)
        ]

    def _candidate(self, chunk: ContextualChunk) -> dict[str, object]:
        contextual_budget = self._max_candidate_characters * 2 // 3
        canonical_budget = self._max_candidate_characters - contextual_budget
        return {
            "chunk_id": chunk.id,
            "title": chunk.title,
            "section_path": chunk.context.section_path,
            "contextual_text": chunk.contextual_text[:contextual_budget],
            "chunk_text": chunk.chunk_text[:canonical_budget],
            "retrieval_score": chunk.relevance_score,
        }

    @staticmethod
    def _ordered_ids(
        raw_text: str,
        candidates: Sequence[ContextualChunk],
    ) -> list[str]:
        value = json.loads(_json_object(raw_text))
        if not isinstance(value, dict) or set(value) != {"chunk_ids"}:
            raise ValueError("reranker response must contain only chunk_ids")
        chunk_ids = value["chunk_ids"]
        if not isinstance(chunk_ids, list):
            raise ValueError("reranker chunk_ids must be a list")
        if any(not isinstance(chunk_id, str) for chunk_id in chunk_ids):
            raise ValueError("reranker chunk_ids must contain strings")
        if len(chunk_ids) != len(set(chunk_ids)):
            raise ValueError("reranker chunk_ids must be unique")
        allowed = {chunk.id for chunk in candidates}
        if not set(chunk_ids).issubset(allowed):
            raise ValueError("reranker returned an unknown chunk_id")
        return chunk_ids


def _json_object(raw_text: str) -> str:
    """Return the JSON object a model wrote, ignoring how it wrapped it.

    Models fence the object, tag the fence with a language, or surround it with
    a sentence. The ordering is still theirs; only the wrapping is discarded.
    """

    normalized = raw_text.strip()
    if normalized.startswith("```"):
        fenced = normalized.split("```")
        if len(fenced) >= 3:
            body = fenced[1]
            # Drop an opening language tag such as ```json.
            normalized = body.split("\n", 1)[1] if "\n" in body else body
            normalized = normalized.strip()
    start = normalized.find("{")
    end = normalized.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("reranker response contains no JSON object")
    return normalized[start : end + 1]


__all__ = ["SemanticReranker"]
