# BoMesh benchmark

Design and metric definitions: [`backend/docs_design/evaluation.md`](../docs_design/evaluation.md).

One flow over one **suite**: a folder of documents and questions about them.
`bench` uploads the folder through the API, processes it in one ingestion run,
measures it (time per phase, outputs, citation highlights), then scores the
questions (retrieval, permission leaks, optionally the agent). One report per run.

Requires the API (`--api-only` is enough), the ingestion worker (`make worker`),
PostgreSQL, Qdrant and the models in the root `.env`. Run from `backend/`:

```bash
# Ingest the suite into a fresh Collection (its previous one is deleted), measure it, score it
BOMESH_EVAL_PASSWORD=… uv run python -m eval bench --suite ute-mixed

# Score the last ingestion again without re-ingesting (retrieval settings, after a reindex)
uv run python -m eval bench --suite ute-mixed --reuse --variants fused,rerank --stages retrieval,leak,agent

# Draw new questions from the last ingestion (replaces questions.jsonl with --force)
uv run python -m eval generate --suite ute-mixed --questions 60 --multi-hop 10 --unanswerable 10
```

Reports go to `eval/runs/<suite>/<timestamp>/` (`summary.md`, `summary.json`,
`documents.jsonl`, `results.jsonl`). Both `runs/` and `suites/` are git-ignored.

## Suite layout

```text
eval/suites/<name>/
  files/            the documents, uploaded in name order
  questions.jsonl   {id, question, type, language, gold: [{file, quote}], reference_answer}
  suite.json        {"workspace": "<code>", "user": "<email>"} plus what bench and generate record
```

To start a suite, create `suite.json` with `workspace` and `user`, put the files
in `files/`, run `bench`, then `generate`. Prefer adding files to the existing
suite over starting another: one suite should cover every format.

## `bench` flags

- `--reuse`: skip ingestion; refused when the files changed since the last one.
- `--variants configured,fused,rerank,matches`: retrieval settings compared side by side (default `configured`, the `.env`; `matches` gives the agent its matches without surrounding chunks).
- `--stages retrieval,leak,agent`: default `retrieval,leak`.
- `--no-judge`: traditional metrics only (no LLM cost beyond embeddings and the reranker).
- `--candidates N`, `--top-k K`: override the retrieval settings for every variant.
- `--read-images`: describe pictures during ingestion (vision model).

`--trace` (Langfuse) is a global flag and goes before the command:
`uv run python -m eval --trace bench …`. `bench` exits non-zero when any
permission leak probe finds a result. Model answers are cached in `eval/cache/`
(git-ignored); delete it to re-ask.

## Classification

Scores the facet classifier on a labeled set and recommends per-scheme thresholds
(`auto`: precision ≥ 0.95, `review`: recall ≥ 0.9). Needs PostgreSQL (the
workspace's published taxonomy), Qdrant (kNN) and the `.env` models; not run in CI.

```bash
uv run python -m eval classify --suite example --workspace hcmute
uv run python -m eval classify --suite hcmute --workspace hcmute --concurrency 8
```

Suites are `eval/classification/<name>/labels.jsonl`, one sample per line:
`{id, title, text | path, collection?, labels: {scheme: [notation…]}, primary: {scheme: notation},
empty: [scheme…], metadata: {number, issue_date, effective_date, issuer, level, units, programs, cohorts}}`.
`--limit N` classifies the first N samples. Reports go to
`eval/runs/classification/<suite>/<timestamp>/`.
