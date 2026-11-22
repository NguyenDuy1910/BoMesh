# BoMesh RAG benchmark

Design and metric definitions: [`backend/docs_design/evaluation.md`](../docs_design/evaluation.md).

Requires PostgreSQL and Qdrant running with an indexed workspace, plus
`OPENROUTER_API_KEY`, `OPENROUTER_MODEL` and `EMBEDDING_MODEL` in the root
`.env`. `BOMESH_RERANKER_MODEL` is optional; without it the reranker uses
`OPENROUTER_MODEL`. Run from `backend/`:

```bash
# 1. Find a tenant and Collection with indexed Documents
uv run python -m eval collections

# 2. Draw a dataset from it (written to eval/datasets/<name>/)
uv run python -m eval generate --name ute-knowledge \
  --tenant 00000000-0000-0000-0000-000000000001 \
  --collection <collection-id> \
  --questions 60 --multi-hop 10 --unanswerable 10

# 3. Benchmark variants side by side (written to eval/runs/<dataset>/<timestamp>/)
uv run python -m eval run --dataset ute-knowledge \
  --variants fused,rerank --stages retrieval,leak,agent
```

The tenant above is the seeded dev tenant (`DEV_TENANT_ID` in the root
`Makefile`). `--collection` may be repeated.

Useful `run` flags:

- `--no-judge`: traditional metrics only (no LLM cost beyond embeddings and
  the reranker).
- `--limit N`: only the first N questions.
- `--candidates N`, `--top-k K`: override the retrieval settings for every
  variant.

`--trace` (sends Langfuse traces) is a global flag and goes before the
subcommand: `uv run python -m eval --trace run ...`.

`run` exits non-zero when any permission leak probe finds a result.

Review and edit `eval/datasets/<name>/questions.jsonl` before trusting a
dataset. Each line is `{id, question, type, language, gold: [{item_id, title,
quote}], reference_answer}`. Model answers are cached in `eval/cache/`
(git-ignored). Delete that directory to re-ask.
