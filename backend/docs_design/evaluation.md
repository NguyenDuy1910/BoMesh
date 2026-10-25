# RAG evaluation benchmark

Status: implemented in `backend/eval`. Developer tool, not a product surface:
no API, schema or permission changes.

## Decision

The benchmark drives the real composition (`AppRuntime`) against an
already-indexed workspace. It never re-implements retrieval or the agent:

```text
dataset (questions + verbatim gold quotes)
   │
   ├─ fused stage   ItemIndex.search_item_content     dense + BM25 → RRF candidates
   ├─ final stage   ItemKnowledgeRetriever.search     visibility re-check, optional rerank gate
   ├─ leak stage    both of the above, gold Collection out of scope / unknown tenant
   └─ agent stage   Agent.run (documented loop, knowledge_search chosen by the model)
   │
traditional metrics (gold quote match)  +  LLM-judge metrics (OPENROUTER_MODEL)
   │
runs/<dataset>/<timestamp>/{results.jsonl, summary.json, summary.md}
```

- **Operator scope.** The harness runs below the API boundary with an
  operator-chosen tenant and Collection scope (`AgentContext`), as
  `KnowledgeQueryService` does after authorization. It authorizes no caller.
- **Models.** Generation, relevance and answer judging use the runtime's
  OpenRouter transport with no override, i.e. the configured
  `OPENROUTER_MODEL`. The agent and reranker use their configured models.
  Nothing pins another model.
- **Variants.** `configured` (`.env` as is), `fused` (reranking off) and
  `rerank` (reranking on) differ only in `RetrievalConfig`, replaced in the
  typed config. `--candidates` and `--top-k` override
  `BOMESH_RETRIEVAL_CANDIDATE_COUNT` / `BOMESH_FINAL_RETRIEVAL_TOP_K` for every
  variant. Variants run one after another, and each run's report shows them
  side by side.
- **Side effects.** None on the workspace: reads only. The sandbox is disabled
  and Langfuse tracing is off unless `--trace` is passed.

## Gold evidence

Gold evidence is `{item_id, title, quote}`, never a chunk id: both the chunk id
(`<item_id>:<chunk_index>`) and the Qdrant point id derive from the chunk
index, so any chunker change would invalidate id labels. A retrieved passage
carries gold quote *q* when the normalized (NFC, case-folded,
whitespace-collapsed) quote is a substring of it, or when at least 80% of the
quote's tokens appear in order (`SequenceMatcher` over word tokens). A passage
from a re-uploaded duplicate document that carries the quote counts as a hit.
`doc_hit@k` separately checks the gold `item_id`.

Generation (`python -m eval generate`) draws questions from the indexed chunks:

- single-passage questions, one per document, round-robin over MIME types:
  spreadsheet passages give `table` questions; prose passages rotate
  `factual`, `exact_code` (codes, dates, amounts; tests BM25) and
  `paraphrase` (no shared wording; tests dense retrieval). Every N-th question
  is in a second language (cross-lingual);
- `multi_hop` questions over two passages of two documents, with one quote
  for each;
- `unanswerable` questions, kept only when the relevance judge grades none of
  the top 10 fused candidates as answering them.

A quote must occur verbatim in the source passage (at least 8 words, 3 for
tables), or the draft is rejected. The manifest records the index processing
signature. A run warns when the current signature differs, because
re-chunked content may no longer carry the quotes.

## Metrics

Traditional metrics use the gold quote. `k` is `final_top_k` for the final
stage.

| Metric | Definition |
|---|---|
| Hit@k | any of the top k carries a gold quote |
| Recall@k | distinct gold quotes found in the top k / gold quote count |
| P@k | gold-carrying passages in the top k / k |
| MRR | 1 / rank of the first gold-carrying passage |
| nDCG@k | binary gain; ideal = max(gold count, gold-carrying passages found) |
| DocHit@k | a gold `item_id` in the top k |

Judge metrics grade every passage of the fused top 10 and the final list
0 (useless), 1 (related, or another period or program), or 2 (answers). Grades
are cached per (model, question, passage text).

| Metric | Definition |
|---|---|
| Judged P@k | passages graded 2 in the top k / k |
| Judged nDCG@k | graded gain; ideal = every grade judged for the question |
| Answer found@k | a passage graded 2 in the final top k (answerable questions) |
| Unanswerable empty | final evidence empty for unanswerable questions (the rerank gate) |
| False answer@k | a passage graded 2 for an unanswerable question |

Leak probes run for every answerable question, against both the index and
the retriever:

- `leak_collection`: scoped to the tenant's other Collections. A result
  outside that scope, or one that is the gold item, is a violation.
- `leak_tenant`: a random non-existent tenant. Any result is a violation.

Any violation makes the command exit non-zero.

Agent metrics, for one turn per question:

- **From the turn itself:** whether the agent searched, tool calls, citations,
  whether a cited passage carries the gold quote, tokens summed over all model
  steps, and latency.
- **From the answer judge:** correctness 0/1/2 against the reference answer,
  whether the answer is grounded in the cited passages, and whether it
  abstained. These give the false abstention rate on answerable questions and
  correct abstention on unanswerable ones.

`Rerank fallbacks` counts the retriever's "reranking failed" warnings during a
variant. A variant with fallbacks partly measured the fused order.

## Known limits

- Qdrant RRF ties and embedding noise reorder equal-score candidates between
  runs. Compare variants only on differences above that noise.
- Generated questions are drafted by the same model family that judges them.
  Review `questions.jsonl` before using a dataset as a regression baseline.
- Leak probes test the store and retriever filters, not caller authorization
  (`AuthorizationService`), which the API layer owns.
