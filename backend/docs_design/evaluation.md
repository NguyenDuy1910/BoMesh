# RAG evaluation benchmark

Status: implemented in `backend/eval`. Developer tool, not a product surface:
no API, schema or permission changes.

## Decision

One benchmark flow over one **suite**: a local folder of documents plus
questions with verbatim gold quotes. `python -m eval bench --suite <name>`
ingests the folder through the public API, measures ingestion and citation
highlights, then scores the questions against the real composition
(`AppRuntime`). It never re-implements ingestion, retrieval or the agent:

```text
suite (files/ + questions.jsonl + suite.json)
   │
   ├─ ingestion     public API upload + one ingestion run (or --reuse the last Collection)
   ├─ highlights    citation marks read back from the Original preview
   ├─ fused stage   ItemIndex.search_item_content     dense + BM25 → RRF candidates
   ├─ final stage   ItemKnowledgeRetriever.search     visibility re-check, optional rerank gate
   ├─ leak stage    both of the above, gold Collection out of scope / unknown tenant
   └─ agent stage   Agent.run (documented loop, knowledge_search chosen by the model)
   │
traditional metrics (gold quote match)  +  LLM-judge metrics (OPENROUTER_MODEL)
   │
runs/<suite>/<timestamp>/{summary.md, summary.json, documents.jsonl, results.jsonl}
```

- **Suites.** `eval/suites/<name>/` holds `files/` (the corpus, uploaded in
  name order), `questions.jsonl` and `suite.json` (the workspace code and the
  user who ingests and reads, the Collection of the last ingestion with the
  files' SHA-256 and the processing signature, and how the questions were
  generated). Suites are git-ignored: their files and quotes are workspace
  data. One suite covers every supported format, scans included, so one run
  measures the whole pipeline; add files to it rather than starting another.
- **One live Collection per suite.** A fresh `bench` deletes the suite's
  previous Collection (`force`) before uploading into a new one. `--reuse`
  skips ingestion and scores the last Collection, refused when the files
  changed since. Gold names files, so the same questions score every
  ingestion.

- **Operator scope and reader.** The harness runs below the API boundary with
  an operator-chosen tenant and Collection scope (`AgentContext`), as
  `KnowledgeQueryService` does after authorization. The fused stage, leak
  probes and dataset generation query the index directly over the published
  points of that scope. The final stage and the agent act as a real user
  (the suite's `user`), because the retriever resolves what its caller may
  read in PostgreSQL.
- **Models.** Generation, relevance and answer judging use the runtime's
  OpenRouter transport with no override, i.e. the configured
  `OPENROUTER_MODEL`. The agent and reranker use their configured models.
  Nothing pins another model.
- **Variants.** `configured` (`.env` as is), `fused` (reranking off),
  `rerank` (reranking on) and `matches` (no surrounding chunks,
  `context_chunks = 0`) differ only in `RetrievalConfig`, replaced in the
  typed config. `--candidates` and `--top-k` override
  `BOMESH_RETRIEVAL_CANDIDATE_COUNT` / `BOMESH_FINAL_RETRIEVAL_TOP_K` for every
  variant. Variants run one after another, and each run's report shows them
  side by side. The final stage scores what the agent reads of a match: its
  passage, the match with its surrounding chunks (`conversation_loop.md`
  "Context around every match").
- **Side effects.** Only ingestion writes (below); scoring reads. The sandbox
  is disabled and Langfuse tracing is off unless `--trace` is passed.

## Ingestion and highlights

Ingestion writes through the public API as an editor's upload does: it signs
in as the suite's user (password from `BOMESH_EVAL_PASSWORD`, else prompted),
creates a new Collection, uploads the files in name order (CreateItem, the
signed upload URL, CompleteItemUpload) and processes them in one explicit
ingestion run, executed by whichever ingestion worker runs (`make worker` keeps
one warm, so startup is not measured). Per document it records:

- **Time:** upload, queue wait, task time and each phase's time, from the
  run's tasks;
- **Outputs:** task state and error class, Structured Document nodes
  (GetItemContent), chunks in the index, and every object stored under the
  file's folder, by kind (`original`, `preview-v1`, `structure-v1`, …).

The summary adds documents per minute, the measured parallelism (task time
over run time), phase shares and per-file-type means.

**Citation highlights** are measured on every run, `--reuse` included: of
each document's chunks, how many are marked in the Original preview by boxes
or cell ranges, by a page only, or not at all; and, read back from the
representation people see (the text inside each box of the PDF, or the cells
of each sheet range), the share of a marked chunk's value words its regions
hold — "well marked" at 80% or more (`document_viewer.md` "Citations open in
the Original"). Marks on scanned pages are counted apart.

## Gold evidence

Gold evidence is `{file, quote}`, never an item or chunk id: items change with
every ingestion, and both the chunk id (`<item_id>:<chunk_index>`) and the
Qdrant point id derive from the chunk index, so any chunker change would
invalidate id labels. A run binds each file to its item in the suite's last
Collection. A retrieved passage carries gold quote *q* when the normalized
(NFC, case-folded, whitespace-collapsed) quote is a substring of it, or when
at least 80% of the quote's tokens appear in order (`SequenceMatcher` over
word tokens). A passage from a re-uploaded duplicate document that carries the
quote counts as a hit. `doc_hit@k` separately checks the gold file's item.

Generation (`python -m eval generate --suite <name>`) draws the suite's
questions from the chunks of its last ingestion:

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
tables), or the draft is rejected. `suite.json` records the index processing
signature the questions were drawn under. A run warns when the current
signature differs, because re-chunked content may no longer carry the quotes.

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
  steps, and latency. A cited passage is the indexed chunk with the cited
  blocks, quote and highlights: blocks alone are shared by every row of a
  table.
- **From the answer judge:** correctness 0/1/2 against the reference answer,
  whether the answer is grounded in the cited passages, and whether it
  abstained. These give the false abstention rate on answerable questions and
  correct abstention on unanswerable ones. On an unanswerable question an
  answer that says so but offers the organization's rules or figures anyway
  (a "common" table in their place) scores 1, not 2.
- **Grounding:** the judge also flags an off-topic citation (a cited passage
  that only shares words or a topic with the question) and unsourced
  specifics (rules, figures, deadlines or procedures the question asks about
  with no supporting citation, whatever their label); `Unanswerable cited` is
  the share of unanswerable questions answered with any citation. A suite
  should hold near-miss unanswerable questions: ones whose topic the corpus
  touches without answering.

`Rerank fallbacks` counts the retriever's "reranking failed" warnings during a
variant. A variant with fallbacks partly measured the fused order.

## Known limits

- Qdrant RRF ties and embedding noise reorder equal-score candidates between
  runs. Compare variants only on differences above that noise.
- Generated questions are drafted by the same model family that judges them.
  Review `questions.jsonl` before using a dataset as a regression baseline.
- Leak probes test the store and retriever filters, not caller authorization
  (`AuthorizationService`), which the API layer owns.

## Classification

A second, separate flow scores the facet classifier (`document_contract.md`
"Processing", CLASSIFYING) on a labeled set and calibrates each scheme's
thresholds. It runs only by hand with the models in the root `.env` (the
contextualization model, `EMBEDDING_MODEL` for concept cards and kNN), never in
CI; unit tests cover only its pure metrics.

```text
eval/classification/<suite>/labels.jsonl  +  --workspace <code> (its published taxonomy and rules)
   │
   ├─ parse + chunk     each sample like an upload (text as Markdown, or a file by path)
   ├─ classify          load_plan → document_input → prepare (rules, patterns, metadata,
   │                    lexical/card/kNN candidates) → the configured model when a scheme
   │                    is unsettled → decide (calibration, routing)
   └─ score             per scheme, metadata, calibration
   │
runs/classification/<suite>/<timestamp>/{summary.md, summary.json, documents.jsonl, results.jsonl}
```

`python -m eval classify --suite <name> --workspace <code>` reads the
workspace's published schemes and rules and writes nothing to the database or
the index. Model answers are cached in `eval/cache/` under the processing
reuse key, so a rerun with the same taxonomy, rules and model asks nothing.

**Labeled set.** One JSON object per line:

```json
{"id": "tb-78", "title": "…", "text": "…", "collection": "<collection item id>",
 "labels": {"document-type": ["thong-bao"], "function": ["dt-dang-ky"], "audience": ["sinh-vien"]},
 "primary": {"document-type": "thong-bao"},
 "empty": ["domain"],
 "metadata": {"number": "78/TB-ĐHCNKT-ĐT", "issue_date": "2025-07-12",
              "effective_date": "2025-07-12", "issuer": "phong-dao-tao", "level": "cohort",
              "units": [], "programs": [], "cohorts": [2022]}}
```

`text` or `path` (a file relative to the suite folder, parsed as an upload
is) gives the content; `collection` (optional) places the sample for
collection rules. Labels are concept notations by scheme code; a scheme is
judged on a sample only when it appears in `labels` or `empty` (judged, no
label). Metadata names the issuer, units and programs by org-unit and program
notations, dates as `YYYY-MM-DD`, cohorts as years. `example/` holds three
samples for a smoke run.

Implementation status: the HCM-UTE calibration set (~300 documents labeled by
curators on all four schemes plus metadata, `hcmute/`) does not exist yet, so
the thresholds seeded per scheme and the defaults used when a scheme's are
unset (`services/taxonomy/classification/calibration.py`: auto 0.9, review
0.5) are uncalibrated.

**Metrics.**

| Metric | Definition |
|---|---|
| Precision / recall at accepted | per scheme, micro over samples: ACCEPTED document and section labels against the gold labels |
| Precision / recall at suggested | the same over ACCEPTED and SUGGESTED labels (what reaches a reviewer) |
| Outcomes | per scheme, samples ending ASSIGNED / EMPTY / UNCERTAIN / FAILED |
| Empty | gold-empty samples that came out EMPTY, and labeled ones that came out EMPTY (false empty) |
| Primary | samples whose accepted primary equals the gold primary |
| Metadata accuracy | per field, of the samples whose gold has it: extracted value equal (strings NFC, case-folded, whitespace-collapsed; lists as sets) |

**Threshold calibration.** Routing (`decide`) runs a second time on the same
answer, without another model call, with every review threshold near zero, so
each label the classifier chose keeps its confidence. Per scheme, the report
tabulates precision, recall and labels kept for thresholds 0.30 to 0.95 by
0.05, and 0.99. The recommended `autoThreshold` is the lowest threshold whose
precision is at least 0.95; `reviewThreshold` is the highest whose recall is
at least 0.9, never above `auto`. A scheme whose table reaches neither target
reports none. Meeting these on the HCM-UTE set is the condition for deploying
the thresholds (see "Classification" above).

**Limits.** kNN reads the workspace's person-reviewed labels: run against a
workspace whose reviewed documents are not the suite's own samples, or kNN
reports the gold. Section labels count as labels of the document. Samples
that fail to parse are reported apart and excluded from every metric.
