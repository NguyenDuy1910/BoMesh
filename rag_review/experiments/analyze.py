"""Summaries quoted in ARCHITECTURE_REVIEW.md, recomputed from results/.

    python3 rag_review/experiments/analyze.py [LANGFUSE_OBSERVATIONS.jsonl]

- ablation: paired bootstrap (10k resamples, 95% CI) between index representations
- rerank: generative reranker vs RRF top-6
- agent: search decision, search recall, abstention, steps, latency, tokens
- traces (optional): production Langfuse v2 observations export
"""

from __future__ import annotations

import collections
import json
import random
import re
import statistics as st
import sys
from pathlib import Path

RESULTS = Path(__file__).resolve().parent / "results"
ABSTAIN = re.compile(
    r"không tìm thấy|không có (thông tin|tài liệu|dữ liệu)|chưa (tìm thấy|có thông tin)|không thấy|"
    r"couldn.t find|could not find|no (matching|relevant)|not (find|found)|không xác định được|chưa thể",
    re.IGNORECASE,
)


def pct(values, p):
    values = sorted(values)
    return values[min(len(values) - 1, int(p * (len(values) - 1)))] if values else None


def bootstrap(a: dict, b: dict, metric: str) -> tuple[float, float, float, int, int]:
    ids = sorted(set(a) & set(b))
    diffs = [a[i][metric] - b[i][metric] for i in ids]
    random.seed(0)
    means = sorted(sum(random.choice(diffs) for _ in diffs) / len(diffs) for _ in range(10_000))
    return round(sum(diffs) / len(diffs), 3), round(means[250], 3), round(means[9750], 3), sum(d > 0 for d in diffs), sum(d < 0 for d in diffs)


def ablation() -> None:
    summary = json.loads((RESULTS / "ablation.json").read_text())
    rows = json.loads((RESULTS / "per_question.json").read_text())
    print("## ablation (answerable questions, single query = question text)")
    for name, groups in summary.items():
        a = groups["all"]
        print(f"{name:28} hit@1 {a['hit@1']:.3f} hit@5 {a['hit@5']:.3f} recall@10 {a['recall@10']:.3f} recall@20 {a['recall@20']:.3f} mrr {a['mrr']:.3f} ndcg@10 {a['ndcg@10']:.3f} lat {groups['latency_ms']}")
    for a, b in [("ctx/hybrid", "raw/hybrid"), ("ctx/hybrid", "struct/hybrid"), ("struct/hybrid", "raw/hybrid"), ("ctx/hybrid", "ctx/dense"), ("ctx/hybrid", "ctx/bm25"), ("ctx/bm25", "raw/bm25"), ("ctx/dense", "raw/dense"), ("ctx/hybrid", "mixed d_ctx+s_raw/hybrid"), ("ctx/hybrid c50", "ctx/hybrid")]:
        print(f"{a} − {b}:", {m: bootstrap(rows[a], rows[b], m) for m in ("hit@5", "recall@10", "mrr")})


def rerank() -> None:
    rows = json.loads((RESULTS / "rerank.json").read_text())
    print("\n## rerank", json.loads((RESULTS / "rerank_summary.json").read_text()))
    answerable = [r for r in rows if r["answerable"]]
    diffs = {r["id"]: {"d": r["rerank"]["hit@6"]} for r in answerable}
    base = {r["id"]: {"d": r["rrf"]["hit@6"]} for r in answerable}
    print("rerank − rrf hit@6:", bootstrap(diffs, base, "d"))


def agent() -> None:
    path = RESULTS / "agent_baseline.jsonl"
    if not path.exists():
        return
    rows = [json.loads(line) for line in path.open(encoding="utf-8")]

    def group(r):
        if r["id"].startswith("nosearch"):
            return "should-not-search"
        if r["id"].startswith("mustsearch"):
            return "production-must-search"
        return "unanswerable" if r["type"] == "unanswerable" else "answerable"

    print(f"\n## agent ({len(rows)} turns, failures {sum(1 for r in rows if r['failure'])})")
    for name, rs in sorted(collections.defaultdict(list, {g: [r for r in rows if group(r) == g] for g in {group(r) for r in rows}}).items()):
        line = (
            f"{name:24} n={len(rs):3} searched={st.fmean(r['search_calls'] > 0 for r in rs):.2f} "
            f"searches/turn={st.fmean(r['search_calls'] for r in rs):.2f} steps={st.fmean(r['model_steps'] for r in rs):.2f} "
            f"latency p50/p95={pct([r['latency_s'] for r in rs], .5)}/{pct([r['latency_s'] for r in rs], .95)}s "
            f"input tokens p50={pct([r['input_tokens'] for r in rs], .5)} abstained={st.fmean(bool(ABSTAIN.search(r['answer'])) for r in rs):.2f}"
        )
        if name == "answerable":
            per_q = collections.defaultdict(list)
            for r in rs:
                per_q[r["id"]].append(r["retrieved_gold"])
            line += (
                f" search-recall={st.fmean(r['retrieved_gold'] for r in rs):.3f} pass^3={st.fmean(all(v) for v in per_q.values()):.3f}"
                f" pass@3={st.fmean(any(v) for v in per_q.values()):.3f} cited={st.fmean(r['citations'] > 0 for r in rs):.3f}"
            )
        print(line)


def traces(path: Path) -> None:
    rows = [json.loads(line) for line in path.open(encoding="utf-8")]
    by_trace = collections.defaultdict(list)
    for r in rows:
        by_trace[r["traceId"]].append(r)
    turns = [r for r in rows if r["name"] == "agent.turn"]
    print(f"\n## production traces: {len(turns)} turns {min(r['startTime'] for r in turns)[:10]}..{max(r['startTime'] for r in turns)[:10]}")
    for name in ("agent.turn", "model.sample", "knowledge.retrieve"):
        lat = [r["latency"] for r in rows if r["name"] == name and r.get("latency") is not None]
        print(f"{name:20} n={len(lat)} p50={pct(lat, .5):.2f}s p95={pct(lat, .95):.2f}s")
    searches = collections.Counter(sum(o["name"] == "tool.execute: knowledge_search" for o in by_trace[t["traceId"]]) for t in turns)
    print("searches per turn", dict(searches))
    outcomes = collections.Counter()
    for r in rows:
        if r["name"] == "knowledge.retrieve" and r.get("output"):
            out = json.loads(r["output"]) if isinstance(r["output"], str) else r["output"]
            outcomes[out.get("outcome")] += 1
    print("retrieval outcomes", dict(outcomes))
    print("errors", dict(collections.Counter((r["name"], r.get("statusMessage")) for r in rows if r.get("level") == "ERROR")))


if __name__ == "__main__":
    ablation()
    rerank()
    agent()
    if len(sys.argv) > 1:
        traces(Path(sys.argv[1]))
