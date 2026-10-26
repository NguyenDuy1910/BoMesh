# BoMesh RAG benchmark

Design and metric definitions: `backend/docs_design/evaluation.md`.

Requires PostgreSQL and Qdrant running with an indexed workspace, plus
`OPENROUTER_API_KEY` / `OPENROUTER_MODEL` in the root `.env`. Run from
`backend/`:

```bash
# 1. Find a tenant and Collection with indexed Documents
uv run python -m eval collections

# 2. Draw a dataset from it (written to eval/datasets/<name>/)
uv run python -m eval generate --name ute-knowledge \
  --tenant 00000000-0000-0000-0000-000000000001 \
  --collection 8a2cca45-1491-40bc-9088-dabd16f7d8c7 \
  --questions 60 --multi-hop 10 --unanswerable 10

# 3. Benchmark variants side by side (written to eval/runs/<dataset>/<timestamp>/)
uv run python -m eval run --dataset ute-knowledge \
  --variants fused,rerank --stages retrieval,leak,agent
```

Useful `run` flags:

- `--no-judge`: traditional metrics only (no LLM cost beyond embeddings and
  the reranker).
- `--limit N`: only the first N questions.
- `--candidates N`, `--top-k K`: override the retrieval settings for every
  variant.
- `--trace`: send Langfuse traces.

`run` exits non-zero when any permission leak probe finds a result.

Review and edit `datasets/<name>/questions.jsonl` before trusting a dataset.
Each line is `{id, question, type, language, gold: [{item_id, title, quote}],
reference_answer}`. Model answers are cached in `eval/cache/` (git-ignored).
Delete that directory to re-ask.
