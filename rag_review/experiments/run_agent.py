"""Agent-stage baseline on the production runtime wiring (read-only).

    cd backend && DATABASE_URL=... QDRANT_URL=... QDRANT_API_KEY=... \
      BOMESH_AGENT_MODEL_PROVIDER=openai BOMESH_EMBEDDING_PROVIDER=openai BOMESH_SANDBOX_ENABLED=false \
      env -u OPENAI_BASE_URL uv run python ../rag_review/experiments/run_agent.py \
        DATASET_DIR USER_ID TRIALS OUT.jsonl

DATASET_DIR is a backend/eval dataset directory (manifest.json + questions.jsonl,
e.g. a copy of rag_review/datasets/prod-2026-11-25 with eval_questions.jsonl as
questions.jsonl). In this review the data URLs pointed at an SSH tunnel to the
production PostgreSQL and Qdrant (read-only use).

Like backend/eval/runner.py's agent stage, but with a real workspace member as
the caller (the runner's "bomesh-benchmark" user id is not a UUID and makes
every search fail; see REPORT) and several trials per question. The retriever
is wrapped only to record what each search returned, so search recall can be
scored separately from answer citations. Nothing is persisted.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, ".")
from eval.__main__ import load_config  # noqa: E402
from eval.matching import matched_gold  # noqa: E402

from bomesh.agent.models import AgentContext  # noqa: E402
from bomesh.runtime import AppRuntime  # noqa: E402

DATASET, USER, TRIALS, OUT = Path(sys.argv[1]), sys.argv[2], int(sys.argv[3]), Path(sys.argv[4])
manifest = json.loads((DATASET / "manifest.json").read_text())
questions = [json.loads(line) for line in (DATASET / "questions.jsonl").open(encoding="utf-8") if line.strip()]


async def main() -> None:
    runtime = AppRuntime(load_config(trace=False))
    retriever = runtime.knowledge_retriever()
    original = retriever.search
    recorded: dict[str, list] = {}

    async def recording(queries, *, limit, ctx):
        evidence = await original(queries, limit=limit, ctx=ctx)
        recorded.setdefault(ctx.request_id, []).append(
            {"queries": list(queries), "evidence": [{"item_id": e.item_id, "title": e.title, "text": e.content} for e in evidence]}
        )
        return evidence

    retriever.search = recording  # type: ignore[method-assign]
    agent = runtime.agent()
    semaphore = asyncio.Semaphore(4)
    done = {(r["id"], r["trial"]) for r in map(json.loads, OUT.open()) } if OUT.exists() else set()

    async def one(question: dict, trial: int) -> dict | None:
        if (question["id"], trial) in done:
            return None
        async with semaphore:
            request_id = f"rr-{uuid4().hex}"
            context = AgentContext(
                user_id=USER,
                tenant_id=manifest["tenant_id"],
                collection_item_ids=tuple(manifest["collection_item_ids"]),
                conversation_id=f"rr-{uuid4().hex}",
                request_id=request_id,
                allowed_tool_names=("knowledge_search",),
            )
            started = time.perf_counter()
            first_text = None
            steps, failure = [], None
            async for event in agent.run(question["question"], context):
                if event.type == "response.output_text.delta" and first_text is None:
                    first_text = time.perf_counter() - started
                if event.type == "response.completed":
                    steps.append(event.response)
                elif event.type in ("response.failed", "response.incomplete"):
                    failure = event.type
            latency = time.perf_counter() - started
        calls = [{"name": c.name, "arguments": c.arguments} for s in steps for c in s.function_calls]
        searches = recorded.pop(request_id, [])
        quotes = [g["quote"] for g in question["gold"]]
        retrieved_gold = bool(quotes) and any(matched_gold(e["text"], quotes) for s in searches for e in s["evidence"])
        cited = [a for s in steps for a in s.output_annotations]
        usage = [getattr(s, "usage", None) for s in steps]
        return {
            "id": question["id"], "trial": trial, "type": question["type"], "failure": failure,
            "latency_s": round(latency, 2), "first_text_s": round(first_text, 2) if first_text else None,
            "model_steps": len(steps), "tool_calls": calls, "search_calls": len(searches),
            "queries": [s["queries"] for s in searches], "results": [len(s["evidence"]) for s in searches],
            "retrieved_gold": retrieved_gold, "citations": len(cited),
            "input_tokens": sum(getattr(u, "input_tokens", 0) or 0 for u in usage),
            "output_tokens": sum(getattr(u, "output_tokens", 0) or 0 for u in usage),
            "answer": steps[-1].final_answer_text.strip() if steps else "",
        }

    tasks = [one(q, t) for t in range(TRIALS) for q in questions]
    with OUT.open("a", encoding="utf-8") as handle:
        for future in asyncio.as_completed(tasks):
            row = await future
            if row is None:
                continue
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
            handle.flush()
            print(row["id"], row["trial"], row["search_calls"], row["retrieved_gold"], row["latency_s"], row["failure"] or "", flush=True)
    await runtime.aclose()


if __name__ == "__main__":
    asyncio.run(main())
