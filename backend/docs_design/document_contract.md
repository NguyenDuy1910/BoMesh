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
search, the assistant and citations read — is derived by
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
a PDF, so their blocks carry the boxes of the pages people see. Formats parsed
as they are (DOCX, PPTX, XLSX, XLS, HTML, text) carry a `location` (heading
path, slide, sheet); where they are shown as a PDF, the preview's pages are
LibreOffice's or Chromium's layout, so a citation's highlights are found in
that PDF's text layer (`document_viewer.md` "Citations open in the
Original"). The worker makes that PDF when the content arrives. A run that
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
so its chunks are located by section. A table drawn with rules (the borders
Word, LibreOffice or a browser draw) is read as a table: its grid comes from
the rules, a border no rule draws merges the cells beside it (spanned headers,
section rows), each cell holds the characters inside it with its box, the
first row (and the rows its cells span) of a table of three or more columns
is its header, and a part continued on the next page with the same columns
keeps that header; so a table speaks row by row like a spreadsheet's and a
citation marks the rows it holds. A table without rules stays lines of text.
A scanned page (an
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
`CLASSIFYING` labels the document with the workspace's published taxonomy
(`api_design.md` §5 ConceptScheme, `item_model.md` "Taxonomy"): every
classification scheme (facet) at its published version — the university
template's domain, function, document type and audience — with the org-unit
and program authorities read for metadata. It runs when the workspace has a
published classification scheme; the run's `classification` narrows each
scheme's candidates to its concepts and the concepts under them, and adds its
note. The plan (schemes, live ConceptRules, short labels, matchers,
fingerprint) is built once per run. Per document, after chunking, the
deterministic steps come first and the model last:

1. **Metadata by rules.** From the title and the leading text (at most 4,000
   characters in chunk order: header, number, first heading):
   - the number as Decree 30/2020 prints it (`Số: 123/QĐ-ĐHCNKT-ĐT`); a
     number the model gives is kept only in that form (digits, `/`, a ký hiệu
     starting with a capital and carrying a `-`, as `25/TB-KĐĐT` or
     `12/2020/NĐ-CP`), never a course or form code (`DIGI330163`, `BM5`);
   - the issue date (`TP. Hồ Chí Minh, ngày 05 tháng 8 năm 2025`) and the
     effective date (`có hiệu lực (thi hành) (kể) từ ngày …`);
   - the issuer: header lines matched against the org-unit labels, and the
     number's suffix (`-ĐT`) against their alt labels;
   - the applicability: the sentence after a scope statement (`áp dụng
     cho/đối với …`, `phạm vi điều chỉnh/áp dụng …`, `đối tượng (áp dụng,
     tham dự, …) …`, or `cho/đối với/dành cho (tất cả) sinh viên (toàn)
     khoa/ngành/khóa …`; wrapped lines included, a blank line, list item,
     heading or line ending in `:` ends it) matched against program and
     org-unit labels, and cohorts (`K22`, `khóa 2022` → 2022). Such a
     statement is explicit, confidence 0.95 (at or above the 0.9 search
     ranking excludes by); a program or cohort in the title, or the model's
     `applies_to` (which may only restate the issuer), is 0.6;
   - superseded documents (`thay thế Quyết định số …`), resolved by document
     number among the workspace's live documents; a number not found yet is
     kept and resolved when a document with that number gets its profile.
2. **Patterns.** Concepts' `matchPatterns` (the document-type scheme's
   `QĐ`, `TB`, `KH`, `HD`… forms) are matched against the title, the number
   and the first heading. Exactly one matching concept settles the scheme
   (`source` RULE, the pattern as evidence). Several or none leave it to the
   model when the scheme's `llmPolicy` is `FALLBACK`: its shortlist is the
   matching concepts when two or more match, else any concept of the scheme.
3. **Rules.** A ConceptRule's condition holds when its concept is settled or
   is the extracted issuer, campus or an applicability unit or program, when
   its collection is one of the document's ancestors, or when its source
   registered the document. An `implies` rule settles its concept (`source`
   RULE, confidence 1.0), and settles the scheme once the scheme's minimum
   labels are reached (document type → function and audience). A `prior` rule
   adds its weight to the concept as a `prior` signal; a prior on a concept
   that cannot be assigned (a top concept) spreads to the assignable
   published concepts under it, the weight × 0.8 per level down (issuing unit
   → function, program → domain). A scheme whose `llmPolicy` is `NEVER` is
   labeled by patterns and rules only.
4. **Candidates.** Each unsettled scheme's concepts are scored from four
   sources, each 0..1: **lexical** (Aho-Corasick over the normalized
   preferred, alternative and hidden labels; longest non-overlapping match; a
   title hit counts three times; frequency), **card** (cosine between the
   embedding of the document's excerpt and the concept card's: labels,
   definition, scope note, examples), **kNN** (the tenant's nearest indexed
   chunks among documents with accepted labels of the scheme a person
   reviewed, the document itself excluded, grouped by document) and
   **prior**. The combined score keeps the top 12 as the scheme's shortlist,
   each with its score per source.
5. **One model call, only when a scheme is unsettled.** When every scheme in
   scope is settled by patterns and rules, the model is not called (and the
   document gets no summary or title suggestion). Otherwise one call to the
   contextualization model (`BOMESH_CONTEXTUALIZATION_MODEL`, reasoning off by
   default: `BOMESH_CONTEXTUALIZATION_REASONING_EFFORT`; contextualization
   must be enabled) reranks the shortlists, picks the fallback schemes, fills
   the metadata the rules did not find and writes the summary and title.
6. **Calibration and routing.** Each chosen label gets a confidence, a
   calibrated function of the model's certainty (`high`, `medium`, `low`),
   the agreement between candidate sources (how many scored the concept) and
   its rank in the shortlist; a rule or a single pattern match is 1.0. Model
   certainty alone never auto-accepts: a label no candidate source
   corroborates from the document itself (a lexical label hit, a card
   similarity among the scheme's top 3, a kNN vote; a prior does not count)
   is held 0.01 below the scheme's auto threshold, so it is at most
   `SUGGESTED` (`evidence.corroborated` false; re-routing after a threshold
   change keeps it there); a corroborated label may exceed it. Each
   scheme routes by its own thresholds (`autoThreshold`, `reviewThreshold`;
   0.9 and 0.5 when unset), chosen on a labeled set (`evaluation.md`
   "Classification"): at or above auto → `ACCEPTED`, at or above review →
   `SUGGESTED`, below → no label. Each scheme ends with an outcome:
   `ASSIGNED`; `EMPTY` when the model said none with high certainty and the
   scheme allows no label (minimum 0); `UNCERTAIN` when it said none
   otherwise or no label reached review; `FAILED` when the model did not
   answer.

The prompt has two parts:

- **The shared prefix**, identical for every document of the run: the
  instructions, the note and every published scheme the model may be asked
  (`llmPolicy` `ALWAYS` or `FALLBACK`). The instructions draw the domain
  boundary (professional or disciplinary knowledge, a program's curriculum
  and syllabi included; never the issuing unit; administrative documents
  about enrolment, grading, exams, thesis or graduation procedures, fees or
  schedules get `none`), say that a concept's scope note exclusions bind,
  that `none` is an answer and that concepts are never invented. Each scheme is a block with its
  cardinality (minimum..maximum, one primary) and one line per assignable
  concept: a short label (the scheme's letter and a number, `D12`), its path
  and name, definition, scope note, alternative labels and examples. Hidden
  labels and concept IDs never reach the model. The prefix is sent first with
  a `prompt_cache_key` derived from it (OpenRouter's sticky `session_id`), so
  the provider serves it from its prompt cache (see "Prompt caching" below).
  While a prefix is cold, the first call writes it alone and documents
  processed in parallel wait for it.
- **The document's part**: the settled labels as context; for each asked
  scheme its shortlist with the per-source scores (`D12 IT › AI — lexical
  0.82, card 0.71, knn 0.40, prior 0.60`), or "any label of" the scheme when
  it has none; the sections when section labels are asked; the metadata
  fields the rules did not find; the title and a bounded excerpt (metadata
  and leading chunks, ~12k characters).

The model answers, per asked scheme, a primary and secondary labels or
`none`, a certainty and a short evidence quote; the sections' labels; the
missing metadata; a one- or two-sentence summary and a title. It names
concepts only by short labels, and only those of the scheme's shortlist and
settled labels (any label of a scheme without a shortlist); a label outside
that set is dropped and logged, and the model can never create a concept
(new concepts come from people, through ConceptProposals). An unreadable
answer, or one whose labels were all dropped while no scheme said `none`, is
asked again once with the problem stated; the retry reuses the cached prefix.
Each call logs its input, cached and output tokens. Model metadata fills only
fields the rules left empty (an issuer by org-unit label). A document type
the model picks applies its `implies` rules as in step 3. The title is a clean
display name in the document's own
language: the title the document states (cover, first heading, subject
line), else its kind and subject; the file name given as the document title
is used only for what the content confirms, without its extension or copy
marks. A title that is missing, longer than 255 characters or empty after
trimming quotes, end punctuation and a file extension is dropped, never
asked again. The summary situates every chunk when the document has no
summary of its own. Summary and title are stored only as an open
NEW_DOCUMENT contribution's suggestions, which the reviewer accepts or edits
in ApproveContribution (`title` becomes the published document's
`displayName`; `fileName` never changes); a run never renames a document.
Concepts never enter the index payload or chunk text: filters, facets and
boosts read them from PostgreSQL. TestClassification runs this same step on a
sample, stores nothing, and returns the candidates and outcomes;
CompileClassificationPrompt shows both parts with placeholders
(`api_design.md` §5).

**Section labels.** A scheme with `sectionAssignments` is also labeled per
level-1 section (a handbook, a Q&A collection), in the same call, when no
`implies` rule settled it and the document has at least three level-1
sections: each section goes with its heading and first 600 characters, and
its labels are stored with the section's Structured Document ref
(`item_concepts.section_ref`).

**Concept cards.** A card's embedding is computed with the index's
embedding model once per published scheme version, on first use, and stored
at `workspaces/{code}/taxonomies/{scheme}/{version}/cards-{embedding_model}.json`
(cached in process); another embedding model writes its own file. Without an
embedder, candidates come from labels, rules and priors only.

**Writes.** When the index is recorded current (unchanged revision and
governing collection), the results replace the document's machine rows:
`item_concepts` (concept, primary, section, confidence, `source` RULE,
LEXICAL, KNN or LLM, state, scheme and classifier versions, evidence),
`item_classifications` (one outcome per scheme) and `document_profiles`
(issuer, campus, number, dates, applicability level and cohorts, with
`document_applicability` and `document_supersessions`). Rows a person decided
(`source` HUMAN, or reviewed) are never touched, and a concept a person
rejected on a document is never suggested to it again; while a scheme has a
person's accepted labels, machine labels for it are only `SUGGESTED`. At most
the scheme's maximum labels are `ACCEPTED` (the rest `SUGGESTED`), and a
scheme with a primary has exactly one accepted primary, the most confident.
Machine rows not chosen again are deleted. Profile fields a person set are
never overwritten. Readers see `document.concepts` (REJECTED omitted),
`document.issuance` and `document.applicability`;
ConfirmConceptAssignments, RejectConceptAssignments or a person's UpdateItem
`document.concepts` make the labels a person's.

Classification is best effort: a provider error or a second unreadable
answer is logged, the document is indexed, its rows are unchanged and each
asked scheme records outcome `FAILED`. It never changes `publicationState`
and is not part of the processing version: a taxonomy or classifier change
never makes documents `OUTDATED`.

**Classify-only runs.** A run with `classifyOnly` runs `CLASSIFYING` alone:
it reads the stored Structured Document (parsing only a content that has none
for the current profile) and its chunks, contextualizes and embeds nothing,
leaves the index and `indexingState` untouched, and writes the rows above.
Publishing a scheme (`api_design.md` §5) calls
`services/taxonomy/reclassify.schedule_reclassification`, which queues such
runs (`trigger` TAXONOMY, at most 1000 documents each) over exactly the documents a change needs the
model for: a split reranks among its replacements on the documents carrying
the deprecated concept (a person's label there gets `SUGGESTED` rows only), a
new narrower concept reranks among its parent and the parent's children on
the parent's documents, and a deprecation without replacement reruns the
scheme on documents left without any label of a scheme that requires one.
Other changes need no model: a merge remaps rows to the replacement; a
deprecation without replacement rejects the concept's machine rows
(`evidence.reason` `deprecated`); a threshold change re-routes machine rows by
their stored confidence (below review → rejected, `evidence.reason`
`below_threshold`); a ConceptRule change re-evaluates rule rows; renames,
definition edits and moves reclassify nothing.

**Classification reuse.** Every answer the model gives is stored with the
file, `workspaces/{code}/files/{content_id}/classification-v2/{key}.json`,
where the key is a hash of the model and its parameters, the taxonomy
fingerprint (the schemes' published versions, the active rules and the
classifier version), the prompt prefix (instructions, note, schemes) and the
document's part (settled labels, shortlists, sections, metadata asks, title,
excerpt). Processing the same file again — *Process again*, a retry, a
reindex, a classify-only run — with the same taxonomy, rules, note and model
reads that answer instead of calling the model; any change to them asks
anew. A stored answer that no longer reads is asked again and replaced;
reuse never fails processing.

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
  `texts/31`, `tables/0`, `groups/4` — plus a plain-text `quote`, a
  `location` label read from those blocks and the `highlights` the blocks
  occupy in the Original preview; a chunk never spans two sheets,
  names at most 64 blocks, a citation's bound, so a run of tiny blocks such
  as a sparse sheet's scattered cells is cut into several chunks, and a table
  speaks in its quote through its rows of "column = value"),
  classification and
  contextualization, the agent's `read_resource` (Markdown serialized on
  demand, pictures sent inline), GetItemContent (`document_viewer.md`
  "Content view: artifact revisions") and artifact revisions. A citation
  is a `CitationTarget`: block refs into one fingerprint of one revision, with
  their `quote`, `location` and `highlights` — never a chunk id or offset.
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
