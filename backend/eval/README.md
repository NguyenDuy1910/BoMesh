# BoMesh RAG benchmark

Design and metric definitions: [`backend/docs_design/evaluation.md`](../docs_design/evaluation.md).

Requires PostgreSQL and Qdrant running with an indexed workspace, plus
`OPENROUTER_API_KEY`, `OPENROUTER_MODEL` and `EMBEDDING_MODEL` in the root
`.env`. `BOMESH_RERANKER_MODEL` is optional; without it the reranker uses
`OPENROUTER_MODEL`. Run from `backend/`:

```bash
# 0. Optional: ingest a folder into a new Collection and measure processing
#    (written to eval/runs/ingest/<folder>/<timestamp>/; prints the tenant
#    and Collection for step 2)
uv run python -m eval ingest --folder <path> --limit 20 \
  --workspace hcmute --email <editor email>

# 1. Find a tenant and Collection with indexed Documents
uv run python -m eval collections

# 2. Draw a dataset from it (written to eval/datasets/<name>/)
uv run python -m eval generate --name ute-knowledge \
  --tenant <workspace-id> \
  --collection <collection-id> \
  --questions 60 --multi-hop 10 --unanswerable 10

# 3. Benchmark variants side by side (written to eval/runs/<dataset>/<timestamp>/)
uv run python -m eval run --dataset ute-knowledge --reader <reader email> \
  --variants fused,rerank --stages retrieval,leak,agent
```

`<workspace-id>` is the seeded workspace's ID, printed by `make seed` (IDs are
generated, so they change with every `make reset-all`). `--collection` may be repeated.
`--reader` is the user the final stage and the agent read as (the retriever
checks what that user may read).

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
