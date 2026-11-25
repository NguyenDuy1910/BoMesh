# Document Items: creation, content and states

Status: target contract for DOCUMENT Items. Field-level contract:
`openapi.yaml` (Knowledge); method catalogue: `api_design.md` §5; domain
decisions: `item_model.md`.

## Model

A document is an Item with `itemKind: DOCUMENT` whose `parentItem` is a
COLLECTION (a root collection, a nested collection, or the caller's PERSONAL
collection). Its output `itemType` is the file class of its content (`PDF`,
`WORD`, `PRESENTATION`, `SPREADSHEET`, `MARKDOWN`, `HTML`, `PLAIN_TEXT`,
`DATA`, `IMAGE`, `AUDIO`, `VIDEO`, `ARCHIVE`, `OTHER`; `item_model.md` §4.11),
fixed at creation and shared by every revision. Its bytes are immutable
revisions (`item_revisions`). Viewing
shows the revision's own file (`GetItemPreview`, document_viewer.md) as soon
as its content is AVAILABLE, processed or not; its Structured Document — what
search, the assistant, citations and the Content view read — is derived by
processing ("Structured Document").

```text
COLLECTION
    -> DOCUMENT Item (contentState PENDING on creation)
        -> revisions/{n} (stored original; revision 1 on upload)

IngestionRun (separate, explicit) -> processes DOCUMENT Items
```

The upload is not a public resource. `item_uploads` is a private one-to-one
ledger keyed by the Item: no public upload ID, no multipart parts, no abort
operation. The signed `uploadUri` is temporary transport state.

## Methods

| Method | HTTP | Permission / rule |
| --- | --- | --- |
| CreateItem | `POST /api/v1/workspaces/{workspace}/items` (`requestId`) | `items.create` on `parentItem` |
| CreateItemMedia | `POST /upload/api/v1/workspaces/{workspace}/items` (multipart) | same as CreateItem |
| CompleteItemUpload | `POST …/items/{item}:completeUpload` | creator |
| GetItem | `GET …/items/{item}`; `?alt=media` → 302 to the signed original of the current revision | `items.get` |
| ListItems / SearchItems | `GET …/items` (`filter` on `parentItem`, `ancestors:`, `document.*`) / `POST …/items:search` | `items.list` / `items.search`, visible items only |
| UpdateItem | `PATCH …/items/{item}` (document metadata) | `items.update` |
| DeleteItem / UndeleteItem | `DELETE …/items/{item}` / `POST …:undelete` | `items.delete` / `items.undelete` |

Permissions are resolved on the document's governing collection (workspace
grants plus direct or inherited user/group bindings). A document is visible
when it and its ancestors are `ACTIVE`, the caller holds `items.get` there,
and it is `PUBLISHED` (or the caller holds `items.update` there). Deleting an
ordinary knowledge document needs `items.delete`, not collection ownership or
upload ownership. A `CONVERSATION_ATTACHMENT` lives in its owner's PERSONAL
collection and stays owner-only; referencing an existing knowledge document
from chat does not change its purpose or placement.

## Creation

`CreateItem` reserves a document and returns a signed upload target:

```json
{
  "itemKind": "DOCUMENT",
  "parentItem": "workspaces/w/items/c",
  "displayName": "annual-report.pdf",
  "document": {
    "fileName": "annual-report.pdf",
    "mimeType": "application/pdf",
    "sizeBytes": 1024000,
    "purpose": "KNOWLEDGE"
  }
}
```

The response is the Item with `itemType: PDF` (the class of the declared
`mimeType` and `fileName`), `document.contentState: PENDING`,
`publicationState: PUBLISHED`, `indexingState: PENDING` and an output
`uploadUri` (shown to the creator while `PENDING`). The client PUTs the bytes
to `uploadUri`, then calls `CompleteItemUpload`, which validates the stored
object (existence, size, MIME type, file class) and makes `contentState`
`AVAILABLE`, or `FAILED` when the object does not validate; content whose
validated file class differs from the Item's `itemType` fails the upload with
error code `ITEM_TYPE_MISMATCH`. It accepts no storage key, bucket,
provider, ETag or workflow ID. An object not yet present is
`FAILED_PRECONDITION` reason `UPLOAD_INCOMPLETE`; calling it on an `AVAILABLE`
document returns it unchanged. Completion records `item_revisions` #1.

`CreateItem` reserves the content's identity (`item_uploads.content_id`) and
the `uploadUri` signs a PUT to its final key, `workspaces/{code}/files/{content_id}/original`
(`database_architecture.md` "Object storage"), so completion records the
revision without copying the object. The declared `fileName`, `mimeType` and
`sizeBytes` stay on the private upload ledger until then; nothing about the
content is stored on the Item. A key never contains the file name.

`CreateItemMedia` is the one-call upload: multipart with a `metadata` JSON
part (the Item) and a `file` part. The object is stored and validated in the
request, so the document is returned `AVAILABLE` with no `uploadUri`.

Both bindings call one creation use-case. `purpose` (`KNOWLEDGE`,
`CONVERSATION_ATTACHMENT`) is business intent, not transport choice, and does
not decide how content is processed: every knowledge-format document is
processed by the same core (parse → chunk → classify → contextualize → embed
→ index → cite) when an Ingestion Run includes it, so retrieval reads one
representation however the document entered.

New documents are `PUBLISHED` (an editor is adding them); contributors put
documents up for review with `CreateContribution` instead.

## Formats

Knowledge formats are text (`.txt .md .markdown .rst .csv .tsv .json .jsonl
.xml .yaml .yml .html .htm .log .sql`), Office (`.docx .pptx .xlsx`) and PDF,
parsed as they are, and Excel 97-2003 workbooks (`.xls`), rewritten as `.xlsx`
(values, number and date formats, merged cells) and parsed as workbooks.

Other legacy binary and OpenDocument office formats have no parser of their
own: `.doc .docm .dot .dotx .dotm .odt .ott .rtf .wpd`, `.ppt .pptm .pps .ppsx
.pot .potx .odp .otp`, `.ods .ots` and `.vsd .vsdx .odg .pub`. These are the
registry rows Gotenberg LibreOffice converts (`document_viewer.md`).
Processing parses their PDF representation, the same PDF the viewer shows, as
a PDF, so their blocks carry pages of the PDF people see and a citation can
open the Original preview at its page. Formats parsed as they are (DOCX,
PPTX, XLSX, XLS, HTML, text) carry a `location` (heading path, slide, sheet)
and no page: the preview's pages are LibreOffice's or Chromium's layout, not
the parse's. The worker makes that PDF when the content arrives. A run that
reaches the document first converts it then, and stores it once as the
representation.

A file whose conversion failed fails processing with "the file could not be
converted to PDF for processing (`reason`)", where `reason` is the recorded
representation failure. If Gotenberg is unreachable, the batch is retried like
any infrastructure failure. An OpenDocument spreadsheet read this way is read
as printed pages, not as a table.

A typed PDF is read from its own text layer (no model). A line set at least
1.25 times the size most of its text is set in (by characters, from PDFium's
font sizes) is a heading, and headings nest by size, the largest at level 1,
so its chunks are located by section. A scanned page (an
image and fewer than 20 characters of text) is transcribed by Docling's VLM
pipeline with the configured vision model (`BOMESH_DOCLING_MODEL` on
OpenRouter, Markdown response parsed by Docling) and placed at its page
number among the text-layer pages. Each run of consecutive scanned pages is
transcribed once per content and model: indexing stores the transcription as
a derived product of the content (`ocr-v1`, keyed by model, prompt,
output bound and page run), so processing the same content again — *Process
again*, a retry, a reindex — reuses it instead of calling the model; another
model or prompt transcribes anew, and an unreadable stored transcription is
transcribed again. Without that model a fully scanned PDF
fails with "the file has no text to index"; a transcription the model did not
finish fails with "the vision model could not read its scanned pages or
pictures". Text inside
pictures — of Office files, HTML and the typed pages of PDFs — is read only by
a run with `readImages` (the Process dialog's *Read text in images*): the same
vision model transcribes each distinct picture (identical pictures, such as a
logo on every slide, once; pictures under 32 px on a side are skipped), and
the text becomes the picture's description, so it is chunked, cited and
highlighted at the picture; a picture without text adds nothing. Rate limits
and upstream errors are retried with backoff; a picture the model still could
not read fails the document like a scanned page. Without `readImages` a document whose only
content is pictures fails with "the file has no text to index". Spreadsheets use Docling's xlsx
backend, then each sheet is shaped as a reader of it sees it (many are forms:
a letterhead, a title, a two-level header, numbered rows, notes): a table
inside another table's box is dropped (Docling reads a sparse matrix, such as
a survey sheet with a `1` under each chosen option, whole and again cell by
cell); a cell that is one symbol repeated (`¾¾¾`, `----`) or a formula error
(`#REF!`) is dropped; numbers and dates read as the workbook formats them
(`0.00`, `#,##0`, `0%`, `dd/mm/yyyy`); a block whose rows hold one value each
(notes) becomes text, and a short block of two-value rows above another table
(a letterhead) becomes text column by column; a table's leading banner rows
become text before it (one value: a title, a remark, even merged over several
rows; two values in a table at least four wide: a letterhead touching it);
its header band is the first remaining row and every row a header cell spans
into; and the first column of mostly non-numeric values (a name, not a row
number) is its row header. Every table is chunked as one line per row, named
by its row header (else its first cell, unless that is a number) with each
value named by every level of its column's header (`Khoa Xây dựng: Số lượng
SV tốt nghiệp = 132; … – Tuần 3 = 73`); empty values are left out and a long
table splits between rows. A row too long for one chunk (a respondent's
hundred answers) is cut between values, and every part starts with the row's
name and first value, so it still says whose values it holds. PDFium is not thread-safe: BoMesh and
Docling share one process-wide lock (Docling's `pypdfium2_lock`) for every
PDFium call; concurrent documents in a worker parse other formats in
parallel. Viewing never depends on this parse: the preview engine converts
the original on its own (`document_viewer.md`); the formats above are the one
place processing depends on the preview engine's output.

**Images are not knowledge in this phase.** An image (`.png .jpg .jpeg .gif
.webp .bmp .tif .tiff .avif`) is accepted only as a `CONVERSATION_ATTACHMENT`
in the caller's PERSONAL collection, for the model to look at in that
conversation: it is stored and `AVAILABLE`, but never processed
(`indexingState: UNSUPPORTED`). As `KNOWLEDGE`, or in any STANDARD
collection, it is rejected with `INVALID_ARGUMENT` reason
`FORMAT_NOT_ALLOWED`; the same reason rejects an attachment outside the
caller's PERSONAL collection. Sources and archives skip image files the same
way. When the agent looks at an image, the backend reads it from object
storage and sends it inline (`data:` URL, at most 20 MB). A storage URL is
never handed to the model provider: a private endpoint such as local RustFS
is unreachable from it, and a signed URL would give a third party a bearer
link to the object.

## Adding is not processing

Creating a document and completing its upload only add it to the inventory:
the bytes are stored and the Item reads back with `indexingState: PENDING`.
Nothing is parsed, contextualized, embedded or indexed, and no workflow
starts — uploading 100 files creates 100 pending documents and zero runs,
whichever collection they land in. Processing is a separate, explicit
`CreateIngestionRun` (`api_design.md` §6), started by a person, an API client
or a Source schedule; a person may start one right after uploading.
Publishing, approving a contribution or rolling back a revision never starts
one either: a submission is processed before it is reviewed, so the reviewer
decides on the assistant's classification (`item_model.md` 4.7). A `CONVERSATION_ATTACHMENT` needs no run to be usable in chat:
the agent reads it through its Structured Document, which the first read
parses and stores (never converting a legacy format in the request).

Runs and syncs execute in the ingestion worker
(`python -m bomesh.services.ingestion.worker`), a process of its own with the
API's code; PostgreSQL is its queue (`database_architecture.md`). For local
development, `backend/main.py` starts the existing Compose services and runs
the worker alongside the API; the worker stops with the API. Alternatively
`make worker` runs it as the `ingestion-worker` Compose container (the
backend image, the source mounted read-only, the root `.env` with its local
endpoints rewritten for the Compose network) and `main.py --api-only` runs
the API alone, so restarting the API never restarts the worker and reloads
its processing stack. Shared Compose infrastructure remains running. Deployed
API and worker processes remain independently deployable and scaled; no API
contract depends on this local bootstrap.

## Processing

A run task reports `FETCHING`, `PARSING` (parse and chunk), `CLASSIFYING`,
`CHUNKING` (contextual retrieval text per chunk), `EMBEDDING` and `INDEXING`.
`CLASSIFYING` belongs to contextual retrieval and uses the same configured
contextualization model (`BOMESH_CONTEXTUALIZATION_MODEL`, with reasoning off
by default: `BOMESH_CONTEXTUALIZATION_REASONING_EFFORT`); it runs only when
contextualization is enabled and the run has candidate topics. The run's
`classification` is resolved once into candidates (its topics, a DOMAIN
standing for its ACTIVE topics, or for itself when it has none; none = every
ACTIVE topic; a domain is never a candidate beside its own topics), each
with its classification signals (`keywords`, `synonyms`, `guidance`, the
titles of its `examples`, its `rules`), and the note. Rules are checked first:
when a candidate's rule matches the document (an ancestor collection, or the
source that registered it), the document gets exactly the matching
candidates and the model is not called, so it gets no summary or title
suggestion. Otherwise one model call classifies the document. Its prompt has
two parts:

- **The shared prefix**, identical for every document of the run: the
  instructions, the note and the taxonomy. The taxonomy is grouped by domain
  and sorted by name; each topic is one line with a short label (`T1..Tn`),
  its name, description and signals. Topic IDs never reach the model. The
  prefix is sent first with a `prompt_cache_key` derived from it
  (OpenRouter's sticky `session_id`), so the provider serves it from its
  prompt cache (see "Prompt caching" below). While a prefix is cold, the first
  call writes it alone and documents processed in parallel wait for it.
- **The document's part**: keyword matches, the title and a bounded excerpt
  (metadata and leading chunks, ~12k characters). Keyword matches are topics
  whose name, keywords or synonyms appear in the title, or appear twice or
  as two different terms in the text; they are hints, not answers.

The model returns every topic the document is substantially about, possibly
several and across domains (no cap, no confidence threshold, possibly none),
each as label, name and a short evidence phrase, plus a one- or two-sentence
summary and a title. The title is a clean display name in the document's own
language: the title the document states (cover, first heading, subject
line), else its kind and subject; the file name given as the document title
is used only for what the content confirms, without its extension or copy
marks. A title that is missing, longer than 255 characters or empty after
trimming quotes, end punctuation and a file extension is dropped, never
asked again. A label whose name disagrees resolves by the name or is dropped.
Topics outside the taxonomy are dropped. An unreadable answer, or one whose
topics are all invalid, is asked again once with the problem stated; the
retry reuses the cached prefix. Each call logs its input, cached and output
tokens. The summary situates every chunk when the document has no summary of
its own. Summary and title are stored only as an open NEW_DOCUMENT
contribution's suggestions, which the reviewer accepts or edits in
ApproveContribution (`title` becomes the published document's `displayName`;
`fileName` never changes); a run never renames a document. Topics never
enter the index payload or chunk text. TestTopicClassification runs this
same step on a sample (`api_design.md`
§5 Topic); CompileTopicClassificationPrompt shows both parts with
placeholders.

When the index is recorded current (unchanged revision and governing
collection), the chosen topics replace the document's assistant-applied
`item_topics` rows (`created_by_user_id` NULL); rows a person applied are
never touched, and a topic a person already applied stays theirs. Readers
see the assistant's rows as `document.assistantTopics`;
ConfirmTopicAssignments or a person's UpdateItem `document.topics` makes them
a person's (the latter, when it replaces them, records a TopicCorrection).
Classification is best effort: a provider error or an unreadable answer is
logged, the document is indexed without classification and its topics are
unchanged. It never changes `publicationState` and is not part of the
processing version.

**Classification reuse.** Every answer the model gives is stored with the
file, `workspaces/{code}/files/{content_id}/classification-v1/{key}.json`,
where the key is a hash of the model and its parameters, the prompt prefix
(instructions, note, taxonomy) and the document's part (keyword matches,
title, excerpt). Processing the same file again — *Process again*, a retry, a
reindex — with the same taxonomy, note and model reads that answer instead of
calling the model; any change to them asks anew. A stored answer that no
longer reads is asked again and replaced; reuse never fails processing.

**Contextual retrieval text.** Every chunk keeps its canonical text; what is
embedded and BM25-indexed is a short prefix (title, section, context) plus that
text. The context is written by the contextualization model per **window**:
consecutive chunks in document order, at most 24 and about 14,000 characters.
One prompt prefix holds the instructions, the window's overview (document kind,
the document's own summary, its section list and — for a window that does not
start the document — its opening) and the whole window; each call adds only
the chunk ids it asks for, eight at a time, and the model answers in JSON mode
with one context per id. The classification summary is not part of the
prefix: it changes from run to run and would defeat reuse. An id the model left
out or answered unusably (empty, overlong, starting with `Context:`-style
prefixes) is asked once more; after that, or when a call fails, the chunk keeps
its structural context (title, section, the document's summary). Chunks that
gain nothing from a model are not sent: a document of two chunks or fewer, and
the table chunks of a document that is at least 80% tables (spreadsheets,
rosters, schedules).

**Reuse.** Each written context is stored on its index point with a reuse
key — a hash of the model, the prompt version, the window and the chunk — and
each point records the embedding model of its vector. Processing a document
again (*Process again*, a retry, a reindex) reads its current points first: a
chunk whose key is unchanged keeps its context without a model call, and a
point whose contextual text and embedding model are unchanged keeps its vector
without an embedding call. A changed chunk changes its window's key, so that
window is written again. Scanned-page transcriptions are reused the same way
per content (see Formats).

**Embedding provider.** `EMBEDDING_MODEL` names the model in OpenRouter's
`vendor/model` form (`openai/text-embedding-3-small`); that name is the model
identity each point and `processing_version()` record.
`BOMESH_EMBEDDING_PROVIDER` (`openrouter`, the default, `openai` or `opencode`)
only chooses who serves it: OpenAI serves `openai/` models under their native id
and refuses any other vendor at startup; OpenCode serves every vendor under its
bare id (`text-embedding-3-small`), the prefix dropped only on the wire. Moving
the same model between providers
therefore keeps every stored vector reusable and every document current; a
different model makes documents outdated until processed again. Ingestion
and search always share the one configured embedder.

**Prompt caching.** Prompts are laid out for the provider's implicit prefix
cache: what several calls share (the taxonomy; a window) comes first and is
byte-identical, what differs comes last, the call carries a
`prompt_cache_key`, and a cold prefix is written by one call before the others
read it. No explicit cache marker is sent: through OpenRouter's Responses API a
per-block `cache_control` is not passed on, and for the configured Qwen model
an explicit write is billed at 1.25× input and was not read back by later
calls, while the implicit cache read the repeated prefix at 0.2× input (measured
November 2026). Each window logs its calls and its input, cached and output
tokens; each classification call logs its own.

### Structured Document

`PARSING` parses each content **once per parse profile** into a Structured
Document: the Docling JSON (`DoclingDocument`, docling-core schema) of what
the parser read. After the original, it is a document's one source of
content.

- **Parse profile and fingerprint.** The profile is everything that changes
  the parse and nothing else: the parser version (`PARSER_VERSION`: the
  Docling release and BoMesh's parse code), the docling-core schema version,
  `readImages` and the vision model. Its fingerprint (16 hex characters of a
  SHA-256) is the API's `structureVersion`. Chunking, contextualization and
  embedding stay outside it: they rebuild the index from the same Structured
  Document, so citations into it stay valid.
- **Storage.** One object per Structured Document,
  `workspaces/{code}/files/{content_id}/structure-v1/{fingerprint}.json.gz` (gzip
  JSON, `Content-Type: application/vnd.docling.document+json`, no
  `Content-Encoding`: only the backend reads it; `private, max-age=31536000,
  immutable`). No per-page or per-block objects and no other copy (Markdown,
  HTML, text, page images): readers serialize what they need from it.
- **Pictures by reference.** Bitmaps the parser extracts (pictures in DOCX,
  PPTX, XLSX) never stay base64 in the JSON: each is a PNG
  `workspaces/{code}/files/{content_id}/images-v1/{sha256}.png` (long side ≤ 4,096
  px; pictures under 32 px skipped; at most 500 pictures and 50 MB per
  document, past that a picture keeps no image) that the JSON names. Named by
  content hash, an identical picture (a logo on every slide) is one object,
  shared by every fingerprint of the content. Pictures an HTML page only links
  to are never fetched; PDF figures are not extracted.
- **Manifest.** Written in order: pictures, the JSON, then
  `item_revisions.exports.structure` (`StructureManifest`: `version`,
  `fingerprint`, `docling_schema`, `size_bytes`, `nodes`, `pictures`, `pages`)
  on every revision with that `content_id`, so a manifest only names objects
  that exist. Writes are deterministic (same bytes, same keys), so concurrent
  runs need no lock; writing the manifest never changes the Item's
  `updateTime` or etag. A revision that reuses a `content_id` (rollback,
  approval, artifact revert) starts with its manifest.
- **Reuse on reprocess.** A run whose profile fingerprint equals the
  manifest's, and whose object loads, reads the stored Structured Document —
  no original download, no parse, no Gotenberg — and only chunks,
  contextualizes and embeds again. A new profile (parser upgrade,
  `readImages`, another vision model) writes a new object beside the old one;
  old objects stay for the citations that name them and go with the content's
  folder (`files/{content_id}/`) at purge.
- **Who reads it.** Chunking (each chunk carries the block refs it covers —
  `texts/31`, `tables/0`, `groups/4` — plus a plain-text `quote` and a
  `location` label read from those blocks; a chunk never spans two sheets,
  names at most 64 blocks, a citation's bound, so a run of tiny blocks such
  as a sparse sheet's scattered cells is cut into several chunks, and a table
  speaks in its quote through its rows of "column = value"),
  classification and
  contextualization, the agent's `read_resource` (Markdown serialized on
  demand, pictures sent inline), GetItemContent (`document_viewer.md`
  "Content view: evidence, not the file") and artifact revisions. A citation
  is a `CitationTarget`: block refs into one fingerprint of one revision, with
  their `quote`, `location` and page — never a chunk id, offset or box.
- **Never parsed again.** Once a content has a Structured Document for the
  current profile, nothing reads the original for its content: not the
  agent, the viewer, citations or classification. The
  original is read only to parse, to download, by the Original preview and by
  the sandbox (exact computation needs the real file). Only
  `bomesh/document_structure` knows Docling's schema; the API exposes BoMesh's
  projection (`ContentNode`), never Docling JSON.

## States

Document state is four independent fields, never collapsed
(`item_model.md` §3):

| Field | Values | Source of truth | Changed by |
| --- | --- | --- | --- |
| `state` | `ACTIVE`, `DELETED` | `items.deleted_at` | DeleteItem / UndeleteItem |
| `document.contentState` | `PENDING`, `AVAILABLE`, `FAILED` | derived: `items.current_revision_id` set → `AVAILABLE`, else `item_uploads.status = failed` → `FAILED`, else `PENDING` | upload completion |
| `document.publicationState` | `PUBLISHED`, `UNPUBLISHED` | `items.is_published` | PublishItem / UnpublishItem, contribution approval, source policy |
| `document.indexingState` | `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, `OUTDATED`, `UNSUPPORTED` | `item_index_states.index_status` + `processed_version` | ingestion runs only |

Internal `item_index_states.index_status` and `item_uploads.status` keep
storage-oriented values; mapping belongs at the `backend/api` boundary and
must not leak them.

`contentState` transitions are intentionally narrow:

```text
CreateItem                              -> PENDING
CreateItemMedia (validated object)      -> AVAILABLE
CompleteItemUpload (validated object)   -> AVAILABLE
CompleteItemUpload (invalid object)     -> FAILED (also ITEM_TYPE_MISMATCH)
FAILED -> AVAILABLE                     (retry after a valid object is present)
AVAILABLE -> AVAILABLE                  (idempotent completion)
```

`AVAILABLE` does not imply searchable. A `SUCCEEDED` document whose index was
built with a different processing configuration than the current one is
`OUTDATED`. `indexingError` and `lastIngestionRun` come from the document's
latest run task: the user-safe reason it was not processed and the run to open
for detail. Processing, re-processing (any state, by naming the document in
`selector.items`) and retrying (`:retry`) are all new Ingestion Runs over the
same stored original — nothing is uploaded again.

Runs retry only what time can fix (storage, index, provider timeouts, rate
limits, 5xx). An embedding provider that refuses the request itself (HTTP
400/401/402/403/404/422: a bad or exhausted key, a forbidden or unknown model)
fails the document at once with "The embedding provider refused the request
(HTTP n) …" and stops its run (`FAILED`, the rest skipped), since every other
document would be refused too. The provider's own message, which can carry
account details, stays in the worker log. After an operator fixes the provider
configuration, retry the run.

A `DELETED` document is never returned to normal callers and never serves
content; only `items.undelete` holders see it (`showDeleted`). Tombstone
storage strategy remains internal.

## Revisions

Every document keeps its content in `item_revisions` (`item_model.md` §4.8).
Upload creates revision 1; approved `NEW_REVISION` contributions, source
versions and `RollbackItem` append revisions, reusing stored objects where
possible. Every revision keeps the Document's file class (`itemType`): a
NEW_REVISION contribution of another class is `FAILED_PRECONDITION` reason
`ITEM_TYPE_MISMATCH` (at create and approve), and a source version of another
class is not appended (the sync reports it). `document.mimeType`, `sizeBytes`
and `fileName` follow the current revision, and a content change resets derived preview metadata and sets
`indexingState: PENDING`. `document.indexedRevision` names the revision the
search index was built from; citations name their own revision. Revisions are
read with `ListItemRevisions` / `GetItemRevision`.

## Archives

A `.zip` may be created like any other file (`CreateItem` or
`CreateItemMedia`) into a **STANDARD collection**, as `KNOWLEDGE`. Into a
PERSONAL collection, or as a `CONVERSATION_ATTACHMENT`, it is rejected with
`INVALID_ARGUMENT` reason `FORMAT_NOT_ALLOWED`. The response is the archive's
own document (`mimeType` `application/zip`, `itemType` `ARCHIVE`),
pending like any upload. An archive is an upload record, not knowledge: it is
never parsed or indexed itself.

The web client's Contribute dialog never uploads an archive: contributions
are uploaded to the contributor's PERSONAL collection, where a `.zip` is not
allowed. It opens a dropped or picked ZIP (or folder) in the browser and
uploads each supported member as an ordinary file — flat, at most 100 per
send — so every member is its own document and contribution, reviewed like
any upload. Server-side expansion below serves clients that upload an archive
straight into a STANDARD collection.

An Ingestion Run that includes the archive expands it. Each accepted member
becomes an ordinary pending `KNOWLEDGE` document whose `parentItem` is the
**archive's collection** — its own Item, upload ledger row, revision and
object — and is appended to that same run as a task, so it is parsed,
contextually chunked, embedded, indexed and cited exactly like a file uploaded
directly. Members are collection children, not document children,
because retrieval scopes every chunk by its
governing collection. Lineage is kept on the child's upload ledger row
(`item_uploads.archive_item_id` and `archive_path`; its name is the path's
basename), not on the Item; the archive's revision records
`exports.archive = {status, expanded_at, document_count, skipped_count,
skipped[], error}`.

Safety and limits (defaults): at most 5,000 entries inspected, 500 documents
produced (the rest reported as skipped), 2 GiB expanded in total, 100 MiB per
member, and a 200:1 compression ratio for members over 1 MiB. Traversing or
absolute paths, symbolic links, encrypted and empty members, nested archives,
hidden files and unsupported formats are skipped with a reason; archiving
debris (`__MACOSX`, `.DS_Store`) is dropped silently. A bomb, an over-limit
expansion or an unreadable archive fails the archive's run task and adds no
documents. Member paths never choose a filesystem location.

Expansion is idempotent: a child's identity derives from the archive and the
member path, so a retried batch resumes rather than duplicating.

A successful expansion deletes the archive document (tombstone): what it held
now lives in the collection as ordinary documents. The tombstoned row stays as
the children's lineage and keeps the skip report. A failed expansion keeps
the archive `indexingState: FAILED` with the reason, so it stays visible and
can be processed again. Deleting a child is independent of the archive.

## Bulk loading a crawled corpus

The UTE website crawl (`backend/script/ute_crawler/`) is loaded through the
public API as member contributions, never through a second ingestion path:

1. `batches.py` splits the crawl's unique files into numbered batches of
   growing size. Each batch mirrors the shared collection's folder tree and
   keeps a manifest with the source URL and `sha256` of every file. Files the
   API would refuse (RAR, over the upload limit) and likely personal data are
   left out with a reason.
2. `import_batches.py` signs in as the importing member. For every file it calls
   `CreateItemMedia` into the member's PERSONAL collection, then
   `CreateContribution` `NEW_DOCUMENT`. The contribution's `targetCollection`
   is the batch folder and its `note` is the source URL. The script turns
   `acceptsContributions` on for each target folder it uses.
   `requestId`s are UUIDv5 of the workspace and the file's `sha256`, and a
   per-batch ledger records what reached the server, so a rerun resumes.
   ZIP archives cannot be contributed (`FORMAT_NOT_ALLOWED` in PERSONAL) and
   are reported for direct upload.

Processing and review stay manual (`item_model.md` §4.7):
an Ingestion Run over the candidates, then approval. The source URL lives only
in the contribution note and the batch manifest, not on the document.
Legacy Office files are processed through their PDF conversion (`.doc`,
`.ppt`) or as workbooks (`.xls`) ("Formats").

## Idempotency

`requestId` (UUID, AIP-155) scope is authenticated actor + workspace +
CreateItem. A retry with the same `requestId` and the same normalized request
returns the first result (the same Item); a `PENDING` document may carry a
refreshed `uploadUri`. Reusing a `requestId` with a different `parentItem`,
`fileName`, `mimeType`, `sizeBytes` or `purpose` is `INVALID_ARGUMENT` reason
`REQUEST_ID_REUSED` and never mutates the existing document. For
`CreateItemMedia`, the first file's normalized metadata and content binding
belong to that `requestId`; a different file under the same `requestId` is
`REQUEST_ID_REUSED` too.
`CompleteItemUpload` is idempotent by itself.

## Errors

Errors are `google.rpc.Status` with `ErrorInfo {reason, domain:
"bomesh.app"}` (`api_design.md` §1).

| Situation | Error | `ErrorInfo.reason` |
| --- | --- | --- |
| Not signed in | `UNAUTHENTICATED` | — |
| `parentItem` unreadable, or missing permission | `PERMISSION_DENIED` | — |
| `parentItem` is a DOCUMENT; missing `mimeType` | `INVALID_ARGUMENT` | — |
| Image outside an attachment, archive outside a STANDARD collection, attachment outside the caller's PERSONAL collection | `INVALID_ARGUMENT` | `FORMAT_NOT_ALLOWED` |
| File above the upload limit | `INVALID_ARGUMENT` | `FILE_TOO_LARGE` |
| `requestId` reused for a different request | `INVALID_ARGUMENT` | `REQUEST_ID_REUSED` |
| Completion before the object is stored | `FAILED_PRECONDITION` | `UPLOAD_INCOMPLETE` |
| Validated content of another file class than `itemType` | upload `FAILED` (`contentState: FAILED`) | `ITEM_TYPE_MISMATCH` (upload error code) |
| NEW_REVISION candidate of another file class than `replacesItem` | `FAILED_PRECONDITION` | `ITEM_TYPE_MISMATCH` |
| Content change while a contribution on the item is open | `FAILED_PRECONDITION` | `CONTRIBUTION_OPEN` |
| Stale `etag` | `ABORTED` | `ETAG_MISMATCH` |
| Unknown or deleted item | `NOT_FOUND` | — |
| Throttled | `RESOURCE_EXHAUSTED` | — |

## Implementation gate

Implementation must converge `CreateItem` and `CreateItemMedia` on one
document creation pipeline, keep object storage inside `bomesh.storage`, keep
content lifecycle in Item services, and keep processing in
`ItemIngestionService`, reached only through an Ingestion Run. No public
upload ID and no upload-triggered processing.
