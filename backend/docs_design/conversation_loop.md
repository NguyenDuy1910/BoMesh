# Conversation loop

## Knowledge-first turns

The product is a knowledge assistant, so the agent treats a message as a
question about the workspace's knowledge unless it clearly is not. A question,
topic, document title, name, code, date or bare phrase is searched before the
agent answers, and before it asks the user for files or data. Only greetings,
thanks, questions about the conversation itself, and tasks fully contained in
the message (translate, rewrite or calculate the given text) are answered
without searching. When nothing relevant is found the agent says so, then may
offer general knowledge clearly marked as not from the workspace's sources.

This stays model judgment inside the existing agent loop, not a forced
retrieval step: `agent_base` states the policy without naming tools, and the
`knowledge_search` tool description makes searching the default first action.

## Knowledge retrieval (`knowledge_search`)

One tool call is one information need. The model supplies one to three
focused queries; the backend answers them together:

```text
queries (1–3, normalized, deduplicated)
    ↓ embed each query concurrently
Qdrant: one query_points request
    dense + BM25 prefetch per query, all fused by native RRF,
    tenant / Collection / tombstone / schema filter on every prefetch
    ↓ fused candidates (BOTHESIS_RETRIEVAL_CANDIDATE_COUNT)
Collection visibility re-check
    ↓
one LLM rerank over every query  →  relevance gate
    ↓ selected chunks, strongest first (≤ final_top_k)
Evidence → bounded context → citable source references
```

- **Relevance gate.** The reranker returns only candidates that help answer
  at least one query. Candidates it leaves out are dropped; an empty selection
  makes the tool outcome `empty`, so the agent says nothing was found instead
  of citing unrelated documents.
- **Fail open on infrastructure, not on judgment.** If reranking is disabled,
  errors, or returns an invalid answer, the fused retrieval order (top
  `final_top_k`) is used. A valid empty answer is a judgment, not a failure.
- **One deadline.** The whole retrieval shares the tool budget (25 s). Outcomes
  are `success`, `empty`, `timeout`, `retrieval_failure`, and `invalid_input`.
- **Authorization first.** The access filter is applied inside Qdrant before
  any candidate exists and re-checked before reranking; the reranker and the
  agent only see permitted chunks.
- `KnowledgeQueryService` (`/knowledge` search API) uses the same retriever with
  a single query.

## Flutter conversation client

Flutter consumes the existing `POST /api/v1/agent/chat` OpenResponses SSE stream;
it does not replace tool selection or the intelligent agent loop with a client
workflow. Message history, attachment IDs and selected collection IDs are sent
under the active bearer session. The server remains the authority for visibility
and grounded citations.

- SSE decoding supports fragmented UTF-8, multiline data, event sequencing,
  tool/reasoning activity, artifact revisions and terminal failures.
- Stop closes the client stream. Retry/edit starts a new request with the
  intended history; incomplete responses restored after a restart are shown as
  interrupted rather than still running.
- Device-local conversations support search, title changes, pins and deletion.
  Storage is isolated by account and workspace; it is not cross-device
  conversation synchronization.
- Existing documents are references, not disposable uploads. Removing a chat
  never deletes a referenced library document. Owned conversation uploads are
  removed only when no saved conversation still references them.
- Citation taps open the canonical document preview/focus endpoint. Generated
  artifacts use signed downloads and the canonical revision/publish API.

## Citations in an answer

- **One number per document.** The model cites chunk-level references
  (`ref_N`, one per retrieved passage) so the backend knows the exact passage,
  but the reader-facing `[n]` is assigned per *document* on first use
  (`CitationReferences`). Several passages of one file are one source: they
  share its number, and a passage cited right after another of the same file
  adds no second visible marker — its annotation points at the marker already
  shown. Every annotation still carries its own `chunk_id`.
- **Clients group by document.** The sources list shows each cited document
  once and keeps its cited passages; the source panel opens at the clicked
  passage and steps through the others. Answers saved before per-document
  numbering (one number per passage) resolve each old number to its passage.
- **Files without page images.** Only PDFs get rendered page previews. For
  Office and text files the cited passage itself is the source view, not an
  error; spreadsheet passages ("row, column = value" statements) are shown
  as rows under their column heading, and a spreadsheet's page is named as
  its sheet.
