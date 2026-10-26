"""Aggregate result rows into ``summary.json`` and a side-by-side ``summary.md``."""

from __future__ import annotations

import json
from collections import defaultdict
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from eval.metrics import mean, percentile

#: Row fields that are not averaged as quality metrics.
_NON_METRICS = frozenset(
    {"latency_ms", "result_count", "input_tokens", "output_tokens", "correctness"}
)
_SUMMED = frozenset({"index_violations", "retriever_violations"})


def summarize(
    rows: list[dict[str, Any]], settings: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    grouped: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
    for row in rows:
        grouped[row.get("variant", "?")][row["stage"]].append(row)

    stages: dict[str, dict[str, Any]] = {}
    by_type: dict[str, dict[str, Any]] = {}
    for variant, variant_stages in grouped.items():
        stages[variant] = {
            stage: _stage_summary(stage_rows) for stage, stage_rows in variant_stages.items()
        }
        agent_rows = [r for r in variant_stages.get("agent", []) if "error" not in r]
        if agent_rows:
            stages[variant]["agent"].update(_agent_split(agent_rows))
        k = settings.get(variant, {}).get("final_top_k")
        final_rows = [r for r in variant_stages.get("final", []) if "error" not in r]
        by_type[variant] = _by_type(final_rows, k)
    return {"variants": settings, "stages": stages, "by_type": by_type}


def _stage_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    ok = [row for row in rows if "error" not in row]
    summary: dict[str, Any] = {"n": len(ok), "errors": len(rows) - len(ok)}
    keys = {
        key
        for row in ok
        for key, value in row.items()
        if isinstance(value, (int, float)) and not isinstance(value, bool)
    }
    for key in sorted(keys):
        values = [float(row[key]) for row in ok if isinstance(row.get(key), (int, float))]
        if key in _SUMMED:
            summary[key] = sum(values)
        elif key == "latency_ms":
            summary["latency_p50_ms"] = percentile(values, 50)
            summary["latency_p95_ms"] = percentile(values, 95)
        elif key in _NON_METRICS:
            summary[f"mean_{key}"] = mean(values)
        else:
            summary[key] = mean(values)
    if "empty" in (ok[0] if ok else {}):
        unanswerable = [row for row in ok if row["type"] == "unanswerable"]
        answerable = [row for row in ok if row["type"] != "unanswerable"]
        summary["unanswerable_empty"] = mean(1.0 if r["empty"] else 0.0 for r in unanswerable)
        summary["answerable_empty"] = mean(1.0 if r["empty"] else 0.0 for r in answerable)
    return summary


def _agent_split(rows: list[dict[str, Any]]) -> dict[str, Any]:
    answerable = [row for row in rows if row["type"] != "unanswerable"]
    unanswerable = [row for row in rows if row["type"] == "unanswerable"]

    def share(selected: Iterable[dict[str, Any]], key: str) -> float | None:
        return mean(float(row[key]) for row in selected if key in row)

    return {
        "answerable_correct": share(answerable, "correct"),
        "answerable_mean_correctness": mean(
            row["correctness"] / 2 for row in answerable if "correctness" in row
        ),
        "false_abstention": share(answerable, "abstained"),
        "unanswerable_abstained": share(unanswerable, "abstained"),
        "unanswerable_correct": share(unanswerable, "correct"),
        "mean_tool_calls": mean(len(row.get("tool_calls", ())) for row in rows),
    }


def _by_type(rows: list[dict[str, Any]], k: int | None) -> dict[str, Any]:
    if k is None:
        return {}
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[row["type"]].append(row)
    keys = (f"recall@{k}", "mrr", f"judged_answer_found@{k}", "unanswerable_empty")
    result: dict[str, Any] = {}
    for question_type, type_rows in sorted(grouped.items()):
        entry: dict[str, Any] = {"n": len(type_rows)}
        for key in keys:
            if key == "unanswerable_empty":
                if question_type == "unanswerable":
                    entry[key] = mean(1.0 if r["empty"] else 0.0 for r in type_rows)
                continue
            entry[key] = mean(float(r[key]) for r in type_rows if key in r)
        result[question_type] = entry
    return result


def render_markdown(summary: dict[str, Any], *, title: str) -> str:
    variants = list(summary["variants"])
    stages = summary["stages"]
    lines = [f"# {title}", ""]

    def value(variant: str, stage: str, key: str, *, scale: float = 1.0, digits: int = 3) -> str:
        found = stages.get(variant, {}).get(stage, {}).get(key)
        return "–" if found is None else f"{found * scale:.{digits}f}"

    lines += ["## Settings", ""]
    if summary.get("judge_model"):
        lines += [f"Judge model: `{summary['judge_model']}`", ""]
    lines += _table(
        ["Variant", "Rerank", "Candidates", "Final k", "Agent model", "Reranker model",
         "Rerank fallbacks"],
        [
            [
                name,
                str(settings["reranking_enabled"]),
                str(settings["candidate_count"]),
                str(settings["final_top_k"]),
                str(settings["agent_model"]),
                str(settings["reranker_model"]),
                str(settings.get("rerank_fallbacks", "–")),
            ]
            for name, settings in summary["variants"].items()
        ],
    )

    if any("fused" in stages.get(v, {}) for v in variants):
        lines += ["## Retrieval: fused hybrid candidates (dense + BM25, RRF)", ""]
        lines += _table(
            ["Variant", "n", "Hit@1", "Hit@5", "Recall@10", "Recall@20", "MRR", "nDCG@10",
             "DocHit@5", "Judged nDCG@10", "p50 ms", "p95 ms", "Errors"],
            [
                [
                    v,
                    value(v, "fused", "n", digits=0),
                    value(v, "fused", "hit@1"),
                    value(v, "fused", "hit@5"),
                    value(v, "fused", "recall@10"),
                    value(v, "fused", "recall@20"),
                    value(v, "fused", "mrr"),
                    value(v, "fused", "ndcg@10"),
                    value(v, "fused", "doc_hit@5"),
                    value(v, "fused", "judged_ndcg@10"),
                    value(v, "fused", "latency_p50_ms", digits=0),
                    value(v, "fused", "latency_p95_ms", digits=0),
                    value(v, "fused", "errors", digits=0),
                ]
                for v in variants
            ],
        )

    if any("final" in stages.get(v, {}) for v in variants):
        lines += ["## Retrieval: final evidence given to the agent", ""]
        rows = []
        for v in variants:
            k = summary["variants"][v]["final_top_k"]
            rows.append(
                [
                    v,
                    str(k),
                    value(v, "final", "hit@1"),
                    value(v, "final", f"hit@{k}"),
                    value(v, "final", f"recall@{k}"),
                    value(v, "final", f"precision@{k}"),
                    value(v, "final", "mrr"),
                    value(v, "final", f"ndcg@{k}"),
                    value(v, "final", f"judged_precision@{k}"),
                    value(v, "final", f"judged_ndcg@{k}"),
                    value(v, "final", f"judged_answer_found@{k}"),
                    value(v, "final", "unanswerable_empty"),
                    value(v, "final", f"judged_false_answer@{k}"),
                    value(v, "final", "latency_p50_ms", digits=0),
                    value(v, "final", "latency_p95_ms", digits=0),
                ]
            )
        lines += _table(
            ["Variant", "k", "Hit@1", "Hit@k", "Recall@k", "P@k", "MRR", "nDCG@k",
             "Judged P@k", "Judged nDCG@k", "Answer found@k", "Unanswerable empty",
             "False answer@k", "p50 ms", "p95 ms"],
            rows,
        )
        types = sorted({t for v in variants for t in summary["by_type"].get(v, {})})
        lines += ["### Final Recall@k by question type", ""]
        lines += _table(
            ["Type", *[f"{v} (n)" for v in variants]],
            [
                [
                    question_type,
                    *[
                        _type_cell(summary["by_type"].get(v, {}).get(question_type), v, summary)
                        for v in variants
                    ],
                ]
                for question_type in types
            ],
        )

    leak_stages = ("leak_collection", "leak_tenant")
    if any(stage in stages.get(v, {}) for v in variants for stage in leak_stages):
        lines += ["## Permission leak probes (must be 0)", ""]
        lines += _table(
            ["Variant", "Probe", "n", "Index violations", "Retriever violations", "Errors"],
            [
                [
                    v,
                    stage,
                    value(v, stage, "n", digits=0),
                    value(v, stage, "index_violations", digits=0),
                    value(v, stage, "retriever_violations", digits=0),
                    value(v, stage, "errors", digits=0),
                ]
                for v in variants
                for stage in leak_stages
                if stage in stages.get(v, {})
            ],
        )

    if any("agent" in stages.get(v, {}) for v in variants):
        lines += ["## Agent end to end", ""]
        lines += _table(
            ["Variant", "n", "Correct", "Mean correctness", "Grounded", "Cited",
             "Cited gold", "Searched", "Unanswerable abstained", "False abstention",
             "Tool calls", "Input tokens", "Output tokens", "p50 s", "p95 s", "Errors"],
            [
                [
                    v,
                    value(v, "agent", "n", digits=0),
                    value(v, "agent", "answerable_correct"),
                    value(v, "agent", "answerable_mean_correctness"),
                    value(v, "agent", "grounded"),
                    value(v, "agent", "cited"),
                    value(v, "agent", "cited_gold"),
                    value(v, "agent", "searched"),
                    value(v, "agent", "unanswerable_abstained"),
                    value(v, "agent", "false_abstention"),
                    value(v, "agent", "mean_tool_calls", digits=1),
                    value(v, "agent", "mean_input_tokens", digits=0),
                    value(v, "agent", "mean_output_tokens", digits=0),
                    value(v, "agent", "latency_p50_ms", scale=0.001, digits=1),
                    value(v, "agent", "latency_p95_ms", scale=0.001, digits=1),
                    value(v, "agent", "errors", digits=0),
                ]
                for v in variants
            ],
        )
    return "\n".join(lines) + "\n"


def _type_cell(entry: dict[str, Any] | None, variant: str, summary: dict[str, Any]) -> str:
    if not entry:
        return "–"
    k = summary["variants"][variant]["final_top_k"]
    metric = entry.get(f"recall@{k}")
    if metric is None:
        metric = entry.get("unanswerable_empty")
        label = "empty "
    else:
        label = ""
    shown = "–" if metric is None else f"{label}{metric:.3f}"
    return f"{shown} ({entry['n']})"


def _table(header: list[str], rows: list[list[str]]) -> list[str]:
    return [
        "| " + " | ".join(header) + " |",
        "|" + "|".join("---" for _ in header) + "|",
        *("| " + " | ".join(row) + " |" for row in rows),
        "",
    ]


def write_run(
    directory: Path,
    *,
    rows: list[dict[str, Any]],
    summary: dict[str, Any],
    manifest: dict[str, Any],
    title: str,
) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "results.jsonl").open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    (directory / "summary.json").write_text(
        json.dumps({**summary, "dataset": manifest}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (directory / "summary.md").write_text(render_markdown(summary, title=title), "utf-8")


__all__ = ["render_markdown", "summarize", "write_run"]
