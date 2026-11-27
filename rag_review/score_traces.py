"""Score agent traces against rag_review/questions.jsonl (search discipline).

Usage (cwd = repo root):
    python rag_review/score_traces.py                    # summary of the simulated (code-trace) verdicts
    python rag_review/score_traces.py traces.jsonl       # score real traces

A trace row is one agent turn, the shape `backend/eval/runner.py` writes for
the agent stage: {"id": "Q01", "answer": "...", "tool_calls": [{"name":
"knowledge_search", "arguments": {"queries": [...]}}]}. Follow-up questions
(group "followup") need the "history" turns replayed before the question;
the eval runner is single-turn, so produce those traces through the
conversation API (:converse) instead.

Checks per question (deterministic; answer-quality judgements stay with the
eval LLM judge):
  search      searched iff expect.search
  budget      knowledge_search calls <= expect.max_search_calls
  keep        every expect.keep token (casefolded) appears in some query
  clarify     expect.clarify -> the answer asks a question
  abstain     expect.abstain -> the answer says nothing was found / unavailable
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ABSTAIN = re.compile(
    r"không tìm thấy|không có (thông tin|tài liệu|dữ liệu)|chưa có (thông tin|tài liệu)|"
    r"không thể (tra cứu|truy cập)|no (matching|relevant)|not found|couldn't find",
    re.IGNORECASE,
)


def load(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def score(question: dict, trace: dict) -> list[tuple[str, bool]]:
    expect = question["expect"]
    searches = [c for c in trace.get("tool_calls", []) if c.get("name") == "knowledge_search"]
    queries = " ".join(
        q for c in searches for q in (c.get("arguments") or {}).get("queries", []) if isinstance(q, str)
    ).casefold()
    answer = trace.get("answer", "")
    checks = [
        ("search", bool(searches) == expect["search"]),
        ("budget", len(searches) <= expect["max_search_calls"]),
    ]
    if expect["search"] and expect["keep"]:
        checks.append(("keep", all(token.casefold() in queries for token in expect["keep"])))
    if expect["clarify"]:
        checks.append(("clarify", "?" in answer))
    if expect["abstain"]:
        checks.append(("abstain", bool(ABSTAIN.search(answer))))
    return checks


def main() -> int:
    questions = load(HERE / "questions.jsonl")
    if len(sys.argv) < 2:
        verdicts = Counter(q["sim"]["verdict"].split(" (")[0] for q in questions)
        print(f"{len(questions)} questions, simulated verdicts: {dict(verdicts)}")
        for q in questions:
            print(f"{q['id']} [{q['group']}] {q['sim']['verdict']}: {q['sim']['reason'][:110]}")
        return 0
    traces = {row["id"]: row for row in load(Path(sys.argv[1]))}
    failed = 0
    for q in questions:
        trace = traces.get(q["id"])
        if trace is None:
            print(f"{q['id']} MISSING")
            failed += 1
            continue
        checks = score(q, trace)
        bad = [name for name, ok in checks if not ok]
        failed += bool(bad)
        print(f"{q['id']} {'PASS' if not bad else 'FAIL ' + ','.join(bad)}")
    print(f"{len(questions) - failed}/{len(questions)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
