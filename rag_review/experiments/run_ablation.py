"""Retrieval ablations on the scratch collection built by build_ablation_index.py.

    cd backend && env -u OPENAI_BASE_URL uv run python ../rag_review/experiments/run_ablation.py \
        DATASET.jsonl OUT_DIR

Each question is searched with its own text as the single query (the agent
normally writes 1-3 queries itself; this isolates the index representation).
Gold labels are verbatim quotes matched with backend/eval/matching.py on the
returned chunk_text, so every representation is scored on the same evidence.

Configurations (one variable at a time):
    {raw,struct,ctx} x {dense, bm25, hybrid}   hybrid = production query shape:
        per query one dense + one BM25 prefetch (limit=candidates), native RRF
    mixed: dense ctx + bm25 raw, dense raw + bm25 ctx
    candidates 20 (production) vs 50 for hybrid ctx
"""

from __future__ import annotations

import asyncio
import json
import os
import statistics
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
from dotenv import load_dotenv
from qdrant_client import QdrantClient, models

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
load_dotenv(ROOT / ".env", override=False)

from bomesh.agent.transports.openai import OpenAITransport  # noqa: E402
from bomesh.document_index import BM25_MODEL, BM25_OPTIONS  # noqa: E402
from eval.matching import matched_gold  # noqa: E402
from eval.metrics import binary_ndcg_at_k, hit_at_k, recall_at_k, reciprocal_rank  # noqa: E402

DATASET, OUT = Path(sys.argv[1]), Path(sys.argv[2])
COLLECTION = os.environ.get("RR_ABLATION_COLLECTION", "rr_ablation")
client = QdrantClient(url=os.environ.get("RR_SCRATCH_QDRANT_URL", "http://127.0.0.1:6333"), timeout=120)
LIMIT = 20
KS = (1, 3, 5, 10, 20)


def bm25(text: str) -> models.Document:
    return models.Document(text=text, model=BM25_MODEL, options=BM25_OPTIONS)


def search(config: dict, text: str, vector: list[float]) -> tuple[list, float]:
    started = time.perf_counter()
    if config["mode"] == "dense":
        result = client.query_points(COLLECTION, query=vector, using=f"d_{config['dense']}", limit=LIMIT, with_payload=True)
    elif config["mode"] == "bm25":
        result = client.query_points(COLLECTION, query=bm25(text), using=f"s_{config['sparse']}", limit=LIMIT, with_payload=True)
    else:
        candidates = config.get("candidates", 20)
        result = client.query_points(
            COLLECTION,
            prefetch=[
                models.Prefetch(query=vector, using=f"d_{config['dense']}", limit=candidates),
                models.Prefetch(query=bm25(text), using=f"s_{config['sparse']}", limit=candidates),
            ],
            query=models.FusionQuery(fusion=models.Fusion.RRF),
            limit=LIMIT,
            with_payload=True,
        )
    return list(result.points), (time.perf_counter() - started) * 1000


CONFIGS = {
    **{f"{r}/dense": {"mode": "dense", "dense": r} for r in ("raw", "struct", "ctx")},
    **{f"{r}/bm25": {"mode": "bm25", "sparse": r} for r in ("raw", "struct", "ctx")},
    **{f"{r}/hybrid": {"mode": "hybrid", "dense": r, "sparse": r} for r in ("raw", "struct", "ctx")},
    "mixed d_ctx+s_raw/hybrid": {"mode": "hybrid", "dense": "ctx", "sparse": "raw"},
    "mixed d_ctx+s_struct/hybrid": {"mode": "hybrid", "dense": "ctx", "sparse": "struct"},
    "ctx/hybrid c50": {"mode": "hybrid", "dense": "ctx", "sparse": "ctx", "candidates": 50},
}


async def embed_questions(questions: list[dict]) -> list[list[float]]:
    cache = OUT / "query_vectors.json"
    if cache.exists():
        stored = json.loads(cache.read_text())
        if [q["question"] for q in questions] == stored["questions"]:
            return stored["vectors"]
    transport = OpenAITransport(embedding_model=os.environ["EMBEDDING_MODEL"])
    vectors = await transport.embed_documents([q["question"] for q in questions])
    cache.write_text(json.dumps({"questions": [q["question"] for q in questions], "vectors": vectors}))
    return vectors


def score(question: dict, points: list) -> dict:
    quotes = [g["quote"] for g in question["gold"]]
    gold_items = {g["item_id"] for g in question["gold"]}
    matches = [matched_gold(p.payload["chunk_text"], quotes) for p in points]
    row = {f"hit@{k}": hit_at_k(matches, k) for k in KS}
    row |= {f"recall@{k}": recall_at_k(matches, len(quotes), k) for k in (5, 10, 20)}
    row["mrr"] = reciprocal_rank(matches)
    row["ndcg@10"] = binary_ndcg_at_k(matches, len(quotes), 10)
    row["dochit@5"] = 1.0 if gold_items & {p.payload["item_id"] for p in points[:5]} else 0.0
    distinct_docs = len({p.payload["item_id"] for p in points[:6]})
    row["distinct_docs@6"] = distinct_docs
    return row


async def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    questions = [json.loads(line) for line in DATASET.open(encoding="utf-8") if line.strip()]
    vectors = await embed_questions(questions)
    results: dict[str, dict] = {}
    raw_scores: dict[str, list] = defaultdict(list)
    per_question: dict[str, dict[str, dict]] = defaultdict(dict)
    for name, config in CONFIGS.items():
        per_type: dict[str, list[dict]] = defaultdict(list)
        latencies = []
        for question, vector in zip(questions, vectors, strict=True):
            points, latency = search(config, question["question"], vector)
            latencies.append(latency)
            if not question["gold"]:
                if config["mode"] != "hybrid" or name == "ctx/hybrid":
                    raw_scores[name].append({"id": question["id"], "answerable": False, "top": points[0].score if points else None})
                continue
            row = score(question, points)
            if config["mode"] != "hybrid" or name == "ctx/hybrid":
                raw_scores[name].append({"id": question["id"], "answerable": True, "top": points[0].score if points else None, "gold_rank": next((i + 1 for i, p in enumerate(points) if matched_gold(p.payload["chunk_text"], [g["quote"] for g in question["gold"]])), None)})
            per_type["all"].append(row)
            per_question[name][question["id"]] = row
            per_type[question["type"]].append(row)
            if question.get("language") == "en":
                per_type["lang:en"].append(row)
        results[name] = {
            group: {metric: round(statistics.fmean(r[metric] for r in rows), 3) for metric in rows[0]} | {"n": len(rows)}
            for group, rows in per_type.items()
        }
        results[name]["latency_ms"] = {
            "p50": round(statistics.median(latencies), 1),
            "p95": round(sorted(latencies)[int(0.95 * (len(latencies) - 1))], 1),
        }
        print(name, results[name]["all"], results[name]["latency_ms"], flush=True)
    (OUT / "ablation.json").write_text(json.dumps(results, ensure_ascii=False, indent=1))
    (OUT / "top_scores.json").write_text(json.dumps(raw_scores, ensure_ascii=False, indent=1))
    (OUT / "per_question.json").write_text(json.dumps(per_question, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
