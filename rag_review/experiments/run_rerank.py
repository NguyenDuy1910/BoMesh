"""Production generative reranker vs fused RRF order, on the scratch ablation collection.

    cd backend && env -u OPENAI_BASE_URL -u OPENROUTER_API_KEY -u OPENROUTER_MODEL \
        uv run python ../rag_review/experiments/run_rerank.py DATASET.jsonl SNAP_DIR OUT_DIR

Candidates: the production query shape (ctx dense + ctx BM25, RRF, 20 candidates).
Reranker: bomesh.knowledge.SemanticReranker on OpenRouterTransport with the
configured OPENROUTER_MODEL — the exact production wiring (runtime.py:441-447).
Scores the first 6 (final_top_k) of each order with the eval quote matcher, and
records how often the reranker returns nothing for answerable vs unanswerable.
"""

from __future__ import annotations

import asyncio
import json
import os
import statistics
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from qdrant_client import QdrantClient, models

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
load_dotenv(ROOT / ".env", override=False)

from bomesh.agent.transports.openrouter import OpenRouterTransport  # noqa: E402
from bomesh.connector.protocol import CitationInfo, EffectiveAccess, Hierarchy, SourceIdentity, SourceProvider  # noqa: E402
from bomesh.document_index import BM25_MODEL, BM25_OPTIONS, ChunkContext, ContextualChunk  # noqa: E402
from bomesh.knowledge import SemanticReranker  # noqa: E402
from eval.matching import matched_gold  # noqa: E402
from eval.metrics import hit_at_k, recall_at_k  # noqa: E402

DATASET, SNAP, OUT = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
client = QdrantClient(url=os.environ.get("RR_SCRATCH_QDRANT_URL", "http://127.0.0.1:16335"), timeout=120)
TOP_K, CANDIDATES = 6, 20


def candidates(question: str, vector: list[float], by_id: dict[str, dict]) -> list[ContextualChunk]:
    result = client.query_points(
        "rr_ablation",
        prefetch=[
            models.Prefetch(query=vector, using="d_ctx", limit=CANDIDATES),
            models.Prefetch(query=models.Document(text=question, model=BM25_MODEL, options=BM25_OPTIONS), using="s_ctx", limit=CANDIDATES),
        ],
        query=models.FusionQuery(fusion=models.Fusion.RRF),
        limit=CANDIDATES,
    )
    chunks = []
    for point in result.points:
        row = by_id[str(point.id)]
        chunks.append(
            ContextualChunk(
                id=row["chunk_id"], item_id=row["item_id"], chunk_index=row["chunk_index"],
                content_type=row["content_type"], chunk_text=row["chunk_text"], contextual_text=row["contextual_text"],
                context=ChunkContext(section_path=row.get("section_path") or []), title=row.get("title"),
                collection_item_id=row["collection_item_id"],
                source=SourceIdentity(connector_id="file", provider=SourceProvider.CONFLUENCE, external_id=row["external_id"]),
                hierarchy=Hierarchy(), access=EffectiveAccess(), citation=CitationInfo(), relevance_score=point.score,
            )
        )
    return chunks


def scored(question: dict, chunks: list[ContextualChunk]) -> dict:
    quotes = [g["quote"] for g in question["gold"]]
    matches = [matched_gold(c.chunk_text, quotes) for c in chunks]
    return {"hit@1": hit_at_k(matches, 1), "hit@3": hit_at_k(matches, 3), "hit@6": hit_at_k(matches, 6), "recall@6": recall_at_k(matches, len(quotes), 6)}


async def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    questions = [json.loads(line) for line in DATASET.open(encoding="utf-8") if line.strip()]
    vectors = json.loads((OUT / "query_vectors.json").read_text())["vectors"]
    by_id = {r["point_id"]: r for r in (json.loads(line) for line in (SNAP / "points.jsonl").open(encoding="utf-8"))}
    if os.environ.get("RR_RERANK_PROVIDER") == "openai":
        # Same model served by OpenAI (OPENAI_MODEL) when OpenRouter is unreachable.
        # OpenAI rejects `temperature` for this model (production passes 0,
        # semantic_reranker.py), so the experiment strips it.
        from bomesh.agent.transports.openai import OpenAITransport

        class _NoTemperature(OpenAITransport):
            async def responses(self, **kwargs):  # type: ignore[override]
                kwargs.pop("temperature", None)
                return await super().responses(**kwargs)

        reranker = SemanticReranker(_NoTemperature(), model_name=os.environ["OPENAI_MODEL"])
    else:
        reranker = SemanticReranker(OpenRouterTransport(base_url=os.environ.get("OPEN_ROUTER_BASE_URL")), model_name=os.environ["OPENROUTER_MODEL"])
    rows = []
    for question, vector in zip(questions, vectors, strict=True):
        pool = candidates(question["question"], vector, by_id)
        started = time.perf_counter()
        error = None
        try:
            reranked = await reranker.rerank(pool, queries=[question["question"]], limit=TOP_K)
        except Exception as exc:  # noqa: BLE001 - production fails open; record it
            reranked, error = pool[:TOP_K], f"{type(exc).__name__}: {exc}"[:200]
        latency = (time.perf_counter() - started) * 1000
        row = {"id": question["id"], "answerable": bool(question["gold"]), "latency_ms": round(latency), "rerank_count": len(reranked), "error": error}
        if question["gold"]:
            row["rrf"] = scored(question, pool[:TOP_K])
            row["rerank"] = scored(question, reranked)
        rows.append(row)
        print(question["id"], row.get("rrf", {}).get("hit@6"), row.get("rerank", {}).get("hit@6"), len(reranked), row["latency_ms"], error or "", flush=True)
    (OUT / "rerank.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    answerable = [r for r in rows if r["answerable"]]
    summary = {
        variant: {m: round(statistics.fmean(r[variant][m] for r in answerable), 3) for m in ("hit@1", "hit@3", "hit@6", "recall@6")}
        for variant in ("rrf", "rerank")
    }
    summary["empty_on_unanswerable"] = f"{sum(1 for r in rows if not r['answerable'] and r['rerank_count'] == 0)}/{sum(1 for r in rows if not r['answerable'])}"
    summary["empty_on_answerable"] = f"{sum(1 for r in answerable if r['rerank_count'] == 0)}/{len(answerable)}"
    summary["errors"] = sum(1 for r in rows if r["error"])
    lat = sorted(r["latency_ms"] for r in rows)
    summary["latency_ms"] = {"p50": lat[len(lat) // 2], "p95": lat[int(0.95 * (len(lat) - 1))]}
    (OUT / "rerank_summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    asyncio.run(main())
