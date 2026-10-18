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

## Conversation state

The server owns conversation history. `POST /agent/chat` carries only the new
message, `conversation_id`, scope and attachments; there is no `history`
field (api_contract.md). Before each turn `ChatService` loads, concurrently
and each in its own transaction, the Collection scope, the conversation's
referenced resources, this turn's attachments and its history, then stores the
user message (`ConversationService.start_turn`) and streams.

- **History is answered, active turns.** `ConversationService.history` reads
  `messages` with `status = 'active'` in sequence order, pairs each answer
  with its question and skips questions that never got an answer (stopped,
  failed, still streaming). It is bounded by `BOMESH_MAX_HISTORY_MESSAGES`
  and reaches the agent as `AgentContext.history`. A conversation id the
  server has never seen is a new conversation; one owned by someone else is
  `404`.
- **`replace_from_turn` replaces, never deletes.** It is the zero-based index
  of an active user turn (every accepted question counts, answered or not).
  History and referenced resources are read up to that turn; `start_turn`
  then, under the conversation row lock, marks that user message and every
  later message `superseded` (`superseded_at` set) and stores the new message
  after them. A value above the active user turn count is `422`; equal to it
  appends. Superseded messages stay for lineage (and the activity dashboard's
  question count) but never reach model context or `referenced_resources`.
- **A late answer stays out.** `finish_turn` names the question it answers;
  if a retry superseded that question while the answer streamed, the answer is
  stored superseded too.
- **The conversation id is on the stream.** Clients generate
  `conversation_id`; when one is omitted the server generates it, and every
  event carrying a `response` snapshot (first `response.created`) reports it
  as `response.metadata.conversation_id`.
- **Stateless provider.** OpenRouter rejects `store`/`previous_response_id`,
  so each model request resends the loaded history in full (shaped for
  prompt caching below); no provider-side conversation state exists.
- **Known limits.** Clients count turns from their local thread. The web
  client counts every earlier question, so a question whose request was
  rejected before its stream started (which the server never stored) shifts
  later indexes by one; Flutter skips questions whose answer never received a
  `response` snapshot. Retries made before server-owned history (when every
  retry appended a turn) also misalign old conversations. In the web client,
  picking an older answer variant and continuing still continues from the
  latest attempt: the server keeps only the newest attempt of a turn.

## Request shaping and caching

OpenRouter's Responses API is stateless: `store` and `previous_response_id`
are rejected, so every request replays the turn's full item history and the
agent never sends either. Latency and cost are instead bought back with
provider prompt caching, which only hits on a byte-identical request prefix.
The request is therefore shaped so the prefix only grows at the end:

```text
instructions   static per conversation: agent_base + <sandbox> guidance
               (when the Docker sandbox is available) + <observations> policy
tools          the conversation's tool surface, registration order
input          recent history (plain recency window)
               → developer <available_resources> message (this turn only)
               → current user message
               → this turn's calls / outputs, appended
```

- **Static instructions.** Nothing per turn (resource lists, ids, paths,
  timestamps) enters `instructions`. Resources relevant to this turn are a
  `developer` message placed immediately before the current user message.
- **Plain recency history.** The last `BOMESH_MAX_HISTORY_MESSAGES` messages
  within `BOMESH_MAX_HISTORY_CHARACTERS` are replayed in order. No lexical
  filtering: follow-ups ("what about it?") and mixed Vietnamese/English keep
  their context, and earlier turns stay a stable prefix.
- **Stable tools.** Reaching `max_tool_rounds` or `max_tool_calls` keeps the
  same `tools` array and sends `tool_choice: "none"`; the runtime still refuses
  any call made past the limit. The surface changes only when a conversation
  gains its first resource (resource tools are hidden without resources).
- **Append-only tool context.** Tool observations stay in the input until
  `BOMESH_AGENT_MAX_TOOL_CONTEXT_CHARACTERS` (default 60 000) is exceeded;
  only then are the oldest interactions evicted.
- **Cache routing.** Every agent request sends `prompt_cache_key` =
  conversation id (native Responses field); the OpenRouter transport also sends
  `session_id` = the same value for sticky provider routing.
- **Reasoning off.** Requests send `reasoning: {"effort": …}` from
  `BOMESH_AGENT_REASONING_EFFORT` (default `none`; `none|minimal|low|medium|high`;
  an empty value omits the field). Encrypted reasoning is never requested.
- **Observability.** Each `model.sample` generation records the response usage
  (input, cached, output, reasoning tokens), and the runtime logs one
  `agent_step_usage` line per step.

## Knowledge retrieval (`knowledge_search`)

One tool call is one information need. The model supplies one to three
focused queries; the backend answers them together:

```text
queries (1–3, normalized, deduplicated)
    ↓ embed each query concurrently (query-embedding LRU cache first)
Qdrant: one query_points request
    dense + BM25 prefetch per query, all fused by native RRF,
    tenant / Collection / tombstone / schema filter on every prefetch
    ↓ fused candidates (BOMESH_RETRIEVAL_CANDIDATE_COUNT)
Collection visibility re-check
    ↓
fused RRF order, top final_top_k        (default)
  or optional LLM rerank → relevance gate (BOMESH_RERANKING_ENABLED=true)
    ↓ selected chunks, strongest first (≤ final_top_k)
Evidence → bounded context → citable source references
```

- **Fused order by default.** Reranking is off unless
  `BOMESH_RERANKING_ENABLED=true`: the top `final_top_k` candidates of the
  fused RRF order become evidence, with no extra model call.
- **Optional relevance gate.** When enabled, the reranker returns only
  candidates that help answer at least one query. Candidates it leaves out are
  dropped; an empty selection makes the tool outcome `empty`, so the agent says
  nothing was found instead of citing unrelated documents.
- **Fail open on infrastructure, not on judgment.** If the reranker errors,
  returns an invalid answer, or exceeds its own deadline
  (`BOMESH_RERANK_TIMEOUT_SECONDS`, default 8 s, inside the tool budget), the
  fused retrieval order (top `final_top_k`) is used. A valid empty answer is a
  judgment, not a failure.
- **One tool deadline.** The whole retrieval shares the tool budget (25 s).
  Outcomes are `success`, `empty`, `timeout`, `retrieval_failure`, and
  `invalid_input`.
- **Query embedding cache.** Query-time vectors are kept in a bounded
  in-process LRU keyed by embedding model and whitespace-normalized query text
  (`BOMESH_QUERY_EMBEDDING_CACHE_SIZE`, default 512, `0` disables it), so a
  repeated or retried search skips the embedding round trip. Ingestion
  embeddings never use it.
- **Authorization first.** The access filter is applied inside Qdrant before
  any candidate exists and re-checked before ranking; the reranker and the
  agent only see permitted chunks.
- `KnowledgeQueryService` (`/knowledge` search API) uses the same retriever with
  a single query.

## Sandbox shell work (`run_shell`, `materialize_sandbox_resource`, `export_sandbox_file`)

Exact work over a file (finding a code in a spreadsheet, filtering rows,
totals, producing a file) is shell work: `read_resource` and search see only
part of a long file. The shell is a BoMesh-owned Docker container, one per
conversation, recorded in `sandbox_sessions` (`provider = 'docker'`). It works
the same with every model provider; no provider container or file API is used.

- **One function tool.** `run_shell` takes `commands` (1–5 strings) and
  `timeout_seconds` (integer or null, at most
  `BOMESH_SANDBOX_COMMAND_TIMEOUT_SECONDS`, default 60). The orchestrator runs
  each command in order with `docker exec … timeout <t> bash -lc <command>` as
  the `sandbox` user in `/home/sandbox`. Its `function_call_output` is JSON:
  `{"results": [{"exit_code", "timed_out", "stdout", "stderr"}…],
  "changed_files": [...]}`, `results` aligned with `commands` (the commands
  are not repeated), `changed_files` the home-relative regular files written
  during the batch (hidden paths excluded, at most 50). stdout/stderr keep
  their head and tail within `BOMESH_SANDBOX_MAX_OUTPUT_CHARACTERS` (default
  8 000 per call, split across commands) with a `…[N bytes truncated]…`
  marker; the JSON is shrunk further if it would exceed the per-tool result
  cap, so it always stays valid JSON.
- **The model knows the runtime before its first command.** The sandbox's
  guidance (home directory, Python 3.12 and the installed libraries, no
  internet, files persist for the conversation, export with
  `export_sandbox_file`, the command time limit) is placed in the
  instructions as `<sandbox>`. It is constant, so the instruction prefix stays
  cache-stable.
- **Image.** `deployment/sandbox/Dockerfile` (`python:3.12-slim` with pandas,
  numpy, openpyxl, xlsxwriter, matplotlib, python-docx, python-pptx, pypdf,
  reportlab, pillow, tabulate; user `sandbox`, uid 1000). Build it with
  `docker build -t bomesh-sandbox:latest deployment/sandbox`
  (`BOMESH_SANDBOX_IMAGE`).
- **Isolation and limits.** Every container runs `sleep infinity` under
  `--init` with `network_mode=none`, the non-root `sandbox` user,
  `cap_drop=ALL`, `no-new-privileges`, not privileged, memory
  (`BOMESH_SANDBOX_MEMORY`, default `1g`, no extra swap), CPU
  (`BOMESH_SANDBOX_CPUS`, default 1.0) and PID (`BOMESH_SANDBOX_PIDS_LIMIT`,
  default 256) limits, and label `bomesh.sandbox=1`. Disk usage is not capped
  by Docker on every storage driver.
- **Warm pool.** At app startup (FastAPI lifespan, in the background) the
  sandbox connects to Docker and keeps `BOMESH_SANDBOX_WARM_POOL_SIZE`
  (default 2) pristine containers running. A first `run_shell` claims one —
  renaming it `bomesh-sandbox-<sandbox session id>` and storing its id in
  `provider_state.container_id` (Docker labels cannot change on a running
  container, so the name and the row are the claim record) — and the pool is
  replenished asynchronously. Only an empty pool starts a container on the
  request path. A claimed container never returns to the pool: tenant data
  never reaches another conversation.
- **Reuse.** The same conversation gets the same container on every turn and
  across backend restarts: the bound id is checked (and a stopped container
  restarted), then the session's container name, and only then a new one is
  claimed. A container is used only by the session whose name it carries.
  A new container is rebuilt from the session's durable manifest (and the
  newest expired session's) by materializing every still-readable resource
  again; a container lost mid-request is rebuilt once and the batch rerun.
  Concurrent claims for one session bind compare-and-set on
  `provider_state.container_id`; the loser discards its container.
- **Idle reaper and restart reconciliation.** Every 60 s, active sessions
  whose `last_used_at` (touched on every request that uses the sandbox) is
  older than `BOMESH_SANDBOX_IDLE_TTL_SECONDS` (default 1800) are marked
  `expired` and their containers removed; any claimed container not bound to
  an active session is removed too. On startup, warm containers of a previous
  process are adopted when they match the current image/limits (else
  removed). On shutdown warm containers are removed; claimed ones stay for
  reuse within the TTL.
- **No Docker, no sandbox tools.** If Docker or the image is unavailable (or
  `BOMESH_SANDBOX_ENABLED=false`), a warning is logged and the sandbox tools
  are not offered; chat works unchanged. All Docker calls run on the
  sandbox's own thread pool, never on the event loop.
- **Preparing a file returns its shell path.** `materialize_sandbox_resource`
  copies an authorized Item into the home directory (`put_archive`, owned by
  the `sandbox` user) under its own file name (prefixed with the first 8
  characters of its resource id only when another resource already uses that
  name) and answers with `~/<name>`. A workbook (`.xlsx`, `.xlsm`) also
  arrives as one CSV per non-empty sheet, every cell kept.
- **Export by home-relative path.** `export_sandbox_file` accepts `x`, `~/x`
  or `/home/sandbox/x`; other absolute paths, `..` segments and control
  characters are refused before any Docker call. The file is read with
  `get_archive`, must be a regular file no larger than
  `BOMESH_ARTIFACT_MAX_CONTENT_BYTES`, and is recorded through
  `ArtifactService.record_generated`; its artifact joins the manifest.
- **Clients see what ran.** The `run_shell` `function_call` (its `commands`
  argument) and its `function_call_output` (the JSON above) are the one
  canonical shell record for the model, the web and the Flutter client; no
  container id or host path ever appears in them. The web chat folds a turn's
  work into one line above the answer — "Worked for 26s · Searched HR
  Policies · Ran 3 commands, 1 failed · Created 2 files" — that opens into a
  timeline of searches, reads and shell runs; each command shows its code on
  request, its output, and a failing command's last error line. An output
  that is not that JSON (a tool error) reads as one failed run with its
  message.
- **File cards survive a reload.** The answer text that follows an export
  carries a `bomesh:artifact` annotation per saved revision (agent
  `ArtifactProjection`, beside `CitationProjection`), so web and mobile
  rebuild the card from the stored turn, not only from live tool progress.
- **Exported files are cards, not links.** The export result tells the model
  the user already sees a download card, so the answer names the file
  instead of inventing a path.

## Flutter conversation client

Flutter consumes the existing `POST /api/v1/agent/chat` OpenResponses SSE stream;
it does not replace tool selection or the intelligent agent loop with a client
workflow. The message, attachment IDs, selected collection IDs and the
client-generated `conversation_id` are sent under the active bearer session;
history is not (the server owns it, see "Conversation state"). The server
remains the authority for visibility and grounded citations.

- SSE decoding supports fragmented UTF-8, multiline data, event sequencing,
  tool/reasoning activity, artifact revisions and terminal failures.
- Stop closes the client stream. Retry drops the answer and every later
  message and re-asks the question with `replace_from_turn` = its index among
  earlier questions the server accepted (a question counts once its answer
  received a `response` snapshot). "Edit question" only refills the composer;
  sending it appends a new turn. Incomplete responses restored after a restart
  are shown as interrupted rather than still running.
- Device-local conversations support search, title changes, pins and deletion.
  Storage is isolated by account and workspace; it is not cross-device
  conversation synchronization. Helpful/not-helpful ratings are also
  device-local.
- The composer keeps search scope (`collection_ids`) as its own visible chip,
  separate from attachments. Starting a chat from a knowledge base, document,
  passage or search result pre-fills scope, attachment or draft and never sends
  automatically.
- Existing documents are references, not disposable uploads. Removing a chat
  never deletes a referenced Knowledge document. Owned conversation uploads are
  removed only when no saved conversation still references them.
- Citations use evidence amber, are grouped by document, and open a source
  sheet that pages through cited passages; "Open at passage" uses the canonical
  document focus endpoint. Generated artifacts open Preview / Changes / History
  over real revisions: Changes compares full text, or original previews for
  binary files (no generated binary diff). Download is signed per request;
  saving to Knowledge publishes the latest revision.

## Web conversation client

The web chat (`/chat`, `/chat/[conversationId]`, `/chats`) uses the same SSE
stream and keeps its displayed conversations device-local, isolated by
account and workspace; the UI says so and never implies cross-device history.
The model context is the server's copy ("Conversation state"); the browser
never sends history.

- **An answer keeps streaming across pages.** The live answer belongs to the
  client chat runtime, not to the page, so moving between chats or to the chat
  list does not stop it. A turn saved while still streaming (the tab closed)
  is restored as interrupted.
- **Work line.** Built only from the turn's items and runtime facts: function
  calls the runtime started (a `run_shell` call with its output is a shell
  run), and the turn's start/finish time. On save the live runtime activity is
  settled into a small `workLog` (tool, outcome, result count) so a restored
  answer still says what ran. "Show how answers were found" off hides it.
- **Retry and variants.** Retry is a new request for the same question —
  again, with "more detail" / "shorter" appended to the sent text, or with no
  `collection_ids` ("Search all knowledge") — sent with `replace_from_turn` =
  the number of earlier questions in the thread, so the server supersedes the
  previous attempt. Earlier attempts stay on the message as variants (‹ 1/2 ›);
  feedback is per attempt and kept locally. Continuing after selecting an
  older variant still continues from the latest attempt on the server.
- **Editing a question** replaces its answer and drops every later message,
  after a confirmation when later messages exist; it and "Answer it now" (an
  unanswered question) send `replace_from_turn` the same way.
- **Partial access.** Cited documents of saved answers are re-checked
  (`GET /documents/{id}`); citations the reader can no longer open are
  dropped with a lock hint, and an answer built only from such documents is
  hidden behind a "you can't access this" call-out.
- **Sharing** a chat is proposed (`chat.share`, api_contract.md): the link
  carries a snapshot; recipients only see sources they can open.

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
