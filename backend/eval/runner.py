"""Run a dataset through the real retrieval stack and agent, one row per probe.

Stages
- ``retrieval``: the fused hybrid candidates (``ItemIndex.search_item_content``)
  and the final evidence the agent would get (``ItemKnowledgeRetriever.search``).
- ``leak``: the same questions with the gold Collection out of scope, and from
  a tenant that does not exist; any result is a violation.
- ``agent``: one full agent turn per question (the documented loop decides
  whether and how to search), judged for correctness and grounding.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, replace
from time import perf_counter
from typing import Any
from uuid import uuid4

from bomesh.agent.models import AgentContext
from bomesh.agent.protocol.content import DOCUMENT_CITATION_TYPE
from bomesh.document_index import ContextualChunk, ItemIndex
from bomesh.knowledge import Evidence
from bomesh.runtime import AppRuntime
from config import AppConfig
from eval.corpus import tenant_collection_ids
from eval.dataset import BenchmarkQuestion, Dataset
from eval.judge import AnswerJudge, RelevanceJudge
from eval.matching import matched_gold
from eval.metrics import (
    binary_ndcg_at_k,
    hit_at_k,
    ndcg_at_k,
    precision_at_k,
    recall_at_k,
    reciprocal_rank,
)

STAGES = ("retrieval", "leak", "agent")

#: Named retrieval settings compared side by side; ``configured`` is ``.env``.
VARIANTS: dict[str, dict[str, Any]] = {
    "configured": {},
    "fused": {"reranking_enabled": False},
    "rerank": {"reranking_enabled": True},
}

_FUSED_CUTOFFS = (1, 3, 5, 10, 20)
_JUDGED_FUSED_DEPTH = 10
_PREVIEW_CHARACTERS = 300
_BENCHMARK_USER = "bomesh-benchmark"


@dataclass(frozen=True, slots=True)
class RunOptions:
    variants: tuple[str, ...]
    stages: tuple[str, ...]
    candidate_count: int | None
    final_top_k: int | None
    judge: bool
    concurrency: int


@dataclass(frozen=True, slots=True)
class Judges:
    relevance: RelevanceJudge
    answer: AnswerJudge


def variant_config(base: AppConfig, name: str, options: RunOptions) -> AppConfig:
    overrides = dict(VARIANTS[name])
    if options.candidate_count is not None:
        overrides["hybrid_candidate_limit"] = options.candidate_count
    if options.final_top_k is not None:
        overrides["final_top_k"] = options.final_top_k
    return replace(base, retrieval=replace(base.retrieval, **overrides))


async def run_variant(
    *,
    name: str,
    config: AppConfig,
    dataset: Dataset,
    options: RunOptions,
    judges: Judges | None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Return the variant's effective settings and its result rows."""

    runtime = AppRuntime(config)
    fallbacks = _RerankFallbackCounter()
    retriever_log = logging.getLogger("bomesh.knowledge.retriever")
    retriever_log.addHandler(fallbacks)
    try:
        retrieval = config.retrieval
        settings = {
            "variant": name,
            "reranking_enabled": retrieval.reranking_enabled,
            "candidate_count": retrieval.hybrid_candidate_limit,
            "final_top_k": retrieval.final_top_k,
            "agent_model": config.model.chat_model,
            "agent_provider": config.model.agent_provider,
            "reranker_model": config.model.reranker_model or runtime.model_transport().model,
            "processing_signature": runtime.item_index().current_processing_signature(),
        }
        probe = _Probe(runtime, dataset, config, judges, variant=name)
        limiter = asyncio.Semaphore(options.concurrency)
        rows: list[dict[str, Any]] = []
        if "retrieval" in options.stages:
            rows += await _each(limiter, dataset.questions, probe.retrieval, variant=name)
        if "leak" in options.stages:
            probe.other_collections = tuple(
                collection
                for collection in await tenant_collection_ids(
                    runtime.sessions(), tenant_id=dataset.manifest.tenant_id
                )
                if collection not in dataset.manifest.collection_item_ids
            )
            answerable = [q for q in dataset.questions if q.answerable]
            rows += await _each(limiter, answerable, probe.leak, variant=name)
        if "agent" in options.stages:
            rows += await _each(limiter, dataset.questions, probe.agent, variant=name)
        # Failed reranks keep the fused order; a variant that falls back often
        # is not measuring reranking.
        settings["rerank_fallbacks"] = fallbacks.count
        return settings, rows
    finally:
        retriever_log.removeHandler(fallbacks)
        await runtime.aclose()


class _RerankFallbackCounter(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.WARNING)
        self.count = 0

    def emit(self, record: logging.LogRecord) -> None:
        if record.getMessage().startswith("retrieval reranking failed"):
            self.count += 1


class _Probe:
    def __init__(
        self,
        runtime: AppRuntime,
        dataset: Dataset,
        config: AppConfig,
        judges: Judges | None,
        *,
        variant: str,
    ) -> None:
        self._index: ItemIndex = runtime.item_index()
        self._retriever = runtime.knowledge_retriever()
        self._runtime = runtime
        self._judges = judges
        self._variant = variant
        self._tenant_id = dataset.manifest.tenant_id
        self._scope = dataset.manifest.collection_item_ids
        self._candidates = config.retrieval.hybrid_candidate_limit
        self._top_k = config.retrieval.final_top_k
        self.other_collections: tuple[str, ...] = ()

    def _row(self, question: BenchmarkQuestion, stage: str) -> dict[str, Any]:
        return {
            "variant": self._variant,
            "stage": stage,
            "question_id": question.id,
            "type": question.type,
            "language": question.language,
        }

    def _context(self, *, tenant_id: str, scope: tuple[str, ...]) -> AgentContext:
        return AgentContext(
            user_id=_BENCHMARK_USER,
            tenant_id=tenant_id,
            roles=[],
            collection_item_ids=scope,
        )

    # -- retrieval ---------------------------------------------------------

    async def retrieval(self, question: BenchmarkQuestion) -> list[dict[str, Any]]:
        quotes = [gold.quote for gold in question.gold]
        gold_items = {gold.item_id for gold in question.gold}

        started = perf_counter()
        fused = await self._index.search_item_content(
            (question.question,),
            limit=self._candidates,
            tenant_id=self._tenant_id,
            collection_item_ids=self._scope,
        )
        fused_ms = (perf_counter() - started) * 1_000
        started = perf_counter()
        final = await self._retriever.search(
            (question.question,),
            limit=self._top_k,
            ctx=self._context(tenant_id=self._tenant_id, scope=self._scope),
        )
        final_ms = (perf_counter() - started) * 1_000

        fused_passages = [_passage(chunk, quotes) for chunk in fused]
        final_passages = [_passage(evidence, quotes) for evidence in final]
        fused_row = {
            **self._row(question, "fused"),
            "latency_ms": fused_ms,
            "result_count": len(fused_passages),
            "passages": fused_passages,
        }
        final_row = {
            **self._row(question, "final"),
            "latency_ms": final_ms,
            "result_count": len(final_passages),
            "empty": not final_passages,
            "passages": final_passages,
        }
        if question.answerable:
            fused_row.update(_gold_metrics(fused_passages, question, gold_items, _FUSED_CUTOFFS))
            final_row.update(
                _gold_metrics(final_passages, question, gold_items, (1, 3, self._top_k))
            )
            final_row[f"precision@{self._top_k}"] = precision_at_k(
                [frozenset(p["gold"]) for p in final_passages], self._top_k
            )
        if self._judges is not None:
            await self._judge_retrieval(question, fused_row, final_row)
        return [fused_row, final_row]

    async def _judge_retrieval(
        self,
        question: BenchmarkQuestion,
        fused_row: dict[str, Any],
        final_row: dict[str, Any],
    ) -> None:
        assert self._judges is not None
        fused = fused_row["passages"][:_JUDGED_FUSED_DEPTH]
        final = final_row["passages"]
        texts = {p["chunk_id"]: p.pop("_text") for p in fused_row["passages"] + final if "_text" in p}
        pool = list(dict.fromkeys([p["chunk_id"] for p in fused] + [p["chunk_id"] for p in final]))
        grades = dict(
            zip(
                pool,
                await self._judges.relevance.grade(
                    question.question, [texts[chunk_id] for chunk_id in pool]
                ),
                strict=True,
            )
        )
        ideal = list(grades.values())
        for passage in fused + final:
            passage["grade"] = grades[passage["chunk_id"]]
        fused_gains = [float(p["grade"]) for p in fused]
        final_gains = [float(p["grade"]) for p in final]
        k = self._top_k
        fused_row["judged_ndcg@10"] = ndcg_at_k(fused_gains, 10, ideal=ideal)
        final_row[f"judged_ndcg@{k}"] = ndcg_at_k(final_gains, k, ideal=ideal)
        final_row[f"judged_precision@{k}"] = sum(1 for g in final_gains[:k] if g == 2) / k
        if question.answerable:
            final_row[f"judged_answer_found@{k}"] = 1.0 if 2 in final_gains[:k] else 0.0
        else:
            # Unanswerable: the evidence should be empty or at least not
            # mistaken for an answer by anything downstream.
            final_row[f"judged_false_answer@{k}"] = 1.0 if 2 in final_gains[:k] else 0.0

    # -- leak --------------------------------------------------------------

    async def leak(self, question: BenchmarkQuestion) -> list[dict[str, Any]]:
        gold_items = {gold.item_id for gold in question.gold}
        rows: list[dict[str, Any]] = []
        if self.other_collections:
            scope = self.other_collections
            chunks = await self._index.search_item_content(
                (question.question,),
                limit=self._candidates,
                tenant_id=self._tenant_id,
                collection_item_ids=scope,
            )
            evidence = await self._retriever.search(
                (question.question,),
                limit=self._top_k,
                ctx=self._context(tenant_id=self._tenant_id, scope=scope),
            )
            rows.append(
                {
                    **self._row(question, "leak_collection"),
                    "index_violations": _violations(chunks, scope, gold_items),
                    "retriever_violations": _violations(evidence, scope, gold_items),
                }
            )
        foreign_tenant = str(uuid4())
        chunks = await self._index.search_item_content(
            (question.question,),
            limit=self._candidates,
            tenant_id=foreign_tenant,
            collection_item_ids=self._scope,
        )
        evidence = await self._retriever.search(
            (question.question,),
            limit=self._top_k,
            ctx=self._context(tenant_id=foreign_tenant, scope=self._scope),
        )
        rows.append(
            {
                **self._row(question, "leak_tenant"),
                "index_violations": len(chunks),
                "retriever_violations": len(evidence),
            }
        )
        return rows

    # -- agent -------------------------------------------------------------

    async def agent(self, question: BenchmarkQuestion) -> list[dict[str, Any]]:
        context = AgentContext(
            user_id=_BENCHMARK_USER,
            tenant_id=self._tenant_id,
            roles=[],
            collection_item_ids=self._scope,
            conversation_id=f"benchmark-{uuid4().hex}",
            request_id=f"benchmark-{uuid4().hex}",
        )
        started = perf_counter()
        # One turn is several model steps; each step ends with its own
        # response.completed, so calls, citations and usage are summed over
        # them and the answer comes from the last one.
        steps = []
        failure = None
        async for event in self._runtime.agent().run(question.question, context):
            if event.type == "response.completed":
                steps.append(event.response)
            elif event.type in ("response.failed", "response.incomplete"):
                failure = event
        latency_ms = (perf_counter() - started) * 1_000
        row = {**self._row(question, "agent"), "latency_ms": latency_ms}
        if failure is not None or not steps:
            error = getattr(getattr(failure, "response", None), "error", None)
            row["error"] = f"agent turn ended {getattr(failure, 'type', 'without a response')}: {error}"
            return [row]

        calls = [
            {"name": call.name, "arguments": _json_or_text(call.arguments)}
            for step in steps
            for call in step.function_calls
        ]
        searches = [call for call in calls if call["name"] == "knowledge_search"]
        citations = _citations([a for step in steps for a in step.output_annotations])
        cited = await self._cited_passages(citations)
        quotes = [gold.quote for gold in question.gold]
        row.update(
            {
                "answer": steps[-1].final_answer_text.strip(),
                "tool_calls": calls,
                "model_steps": len(steps),
                "searched": 1.0 if searches else 0.0,
                "search_calls": len(searches),
                "citation_count": len(citations),
                "cited": 1.0 if citations else 0.0,
                "citations": [
                    {"item_id": c["item_id"], "chunk_id": c["chunk_id"], "title": c.get("title")}
                    for c in citations
                ],
                "input_tokens": _usage_total(steps, "input_tokens"),
                "output_tokens": _usage_total(steps, "output_tokens"),
            }
        )
        if question.answerable:
            row["cited_gold"] = (
                1.0 if any(matched_gold(text, quotes) for _, text in cited) else 0.0
            )
        if self._judges is not None:
            verdict = await self._judges.answer.judge(
                question=question.question,
                reference=question.reference_answer if question.answerable else None,
                answer=row["answer"],
                cited_passages=cited,
            )
            row.update(
                {
                    "correctness": verdict.correctness,
                    "correct": 1.0 if verdict.correctness == 2 else 0.0,
                    "grounded": 1.0 if verdict.grounded else 0.0,
                    "abstained": 1.0 if verdict.abstained else 0.0,
                    "judge_reason": verdict.reason,
                }
            )
        return [row]

    async def _cited_passages(self, citations: list[dict[str, Any]]) -> list[tuple[str, str]]:
        passages: list[tuple[str, str]] = []
        for citation in {(c["item_id"], c["chunk_id"]): c for c in citations}.values():
            for collection in self._scope:
                chunks = await self._index.get_item_content(
                    citation["item_id"],
                    tenant_id=self._tenant_id,
                    collection_item_id=collection,
                    chunk_id=citation["chunk_id"],
                    limit=1,
                )
                if chunks:
                    passages.append((chunks[0].title or citation["item_id"], chunks[0].chunk_text))
                    break
        return passages


def _passage(source: ContextualChunk | Evidence, quotes: list[str]) -> dict[str, Any]:
    if isinstance(source, Evidence):
        chunk_id, text = source.chunk_id, source.content
    else:
        chunk_id, text = source.id, source.chunk_text
    return {
        "item_id": source.item_id,
        "chunk_id": chunk_id,
        "collection_item_id": source.collection_item_id,
        "title": source.title,
        "score": source.rerank_score if source.rerank_score is not None else source.relevance_score,
        "gold": sorted(matched_gold(text, quotes)),
        "preview": text[:_PREVIEW_CHARACTERS],
        # Judged then dropped; never written to the results file.
        "_text": text,
    }


def _gold_metrics(
    passages: list[dict[str, Any]],
    question: BenchmarkQuestion,
    gold_items: set[str],
    cutoffs: Sequence[int],
) -> dict[str, float]:
    matches = [frozenset(p["gold"]) for p in passages]
    gold_count = len(question.gold)
    item_hits = [frozenset({0}) if p["item_id"] in gold_items else frozenset() for p in passages]
    metrics: dict[str, float] = {"mrr": reciprocal_rank(matches)}
    for k in dict.fromkeys(cutoffs):
        metrics[f"hit@{k}"] = hit_at_k(matches, k)
        metrics[f"recall@{k}"] = recall_at_k(matches, gold_count, k)
        metrics[f"ndcg@{k}"] = binary_ndcg_at_k(matches, gold_count, k)
        metrics[f"doc_hit@{k}"] = hit_at_k(item_hits, k)
    return metrics


def _violations(
    results: Sequence[ContextualChunk | Evidence], scope: tuple[str, ...], gold_items: set[str]
) -> int:
    allowed = set(scope)
    return sum(
        1
        for result in results
        if result.collection_item_id not in allowed or result.item_id in gold_items
    )


def _citations(annotations: Sequence[Any]) -> list[dict[str, Any]]:
    citations: list[dict[str, Any]] = []
    for annotation in annotations:
        payload = (
            annotation.model_dump(mode="json")
            if hasattr(annotation, "model_dump")
            else dict(annotation)
        )
        if payload.get("type") == DOCUMENT_CITATION_TYPE and isinstance(
            payload.get("citation"), dict
        ):
            citations.append(payload["citation"])
    return citations


def _usage_total(steps: Sequence[Any], field: str) -> int | None:
    values = [getattr(step.usage, field, None) for step in steps if step.usage is not None]
    present = [value for value in values if isinstance(value, int)]
    return sum(present) if present else None


def _json_or_text(value: str) -> Any:
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return value


async def _each(
    limiter: asyncio.Semaphore,
    questions: Sequence[BenchmarkQuestion],
    probe: Callable[[BenchmarkQuestion], Awaitable[list[dict[str, Any]]]],
    *,
    variant: str,
) -> list[dict[str, Any]]:
    async def run(question: BenchmarkQuestion) -> list[dict[str, Any]]:
        async with limiter:
            try:
                rows = await probe(question)
            except Exception as exc:  # noqa: BLE001 - one failed probe is a result, not a crash
                return [
                    {
                        "variant": variant,
                        "stage": probe.__name__,
                        "question_id": question.id,
                        "type": question.type,
                        "error": f"{type(exc).__name__}: {exc}",
                    }
                ]
        for row in rows:
            for passage in row.get("passages", ()):
                passage.pop("_text", None)
        return rows

    nested = await asyncio.gather(*(run(question) for question in questions))
    return [row for rows in nested for row in rows]


__all__ = ["STAGES", "VARIANTS", "Judges", "RunOptions", "run_variant", "variant_config"]
