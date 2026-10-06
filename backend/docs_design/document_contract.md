# Document and Content API Contract

Status: canonical implemented Document/content contract. Router, service,
storage, frontend, and OpenAPI representations share this lifecycle.

## Domain finding

Current implementation already creates the canonical Document before bytes are
uploaded. `item_uploads` is a one-to-one internal record keyed by `item_id`; it
has no independent upload ID, durable expiration, multipart parts, uploaded-byte
counter, abort operation, or multiple-upload lifecycle. Presigned URL expiry is
temporary transport state. Repeating Document creation with the same
`Idempotency-Key` returns the same Document and can issue fresh instructions.

Therefore `DocumentUpload` is not a public resource. Final model is:

```text
Collection
    -> Document (inventory; processing.state = pending on arrival)
        -> Content (stored original)

Ingestion Run (separate, explicit) -> processes Documents
```

## Final endpoint contract

| Method | Path | Purpose | Authorization | Idempotency |
| --- | --- | --- | --- | --- |
| POST | `/api/v1/collections/{collection_id}/documents` | Create Document; accept direct multipart content or reserve presigned content upload | authenticated user + Collection write access | required `Idempotency-Key` |
| GET | `/api/v1/documents` | List permission-filtered Documents | effective `collection.read` on destination Collections | n/a |
| POST | `/api/v1/documents/search` | Search permission-filtered indexed Documents | `knowledge.read` + effective `collection.read` | n/a |
| GET | `/api/v1/documents/{document_id}` | Read canonical Document metadata | Collection read access | n/a |
| PUT | `/api/v1/documents/{document_id}/content` | Validate reserved object and bind it as Document content (no processing) | Document/Collection write access | method is idempotent |
| DELETE | `/api/v1/documents/{document_id}` | Remove Document from normal use | signed-in user + effective `collection.update`; private attachment owner only | method is idempotent |

No `PATCH /documents/{document_id}` is added: current product has no distinct
Document metadata-edit use case.

Collection read/write checks use the caller's effective permissions (workspace
grants plus direct/inherited user or group ACL grants), not a separate
`knowledge.documents.*` namespace. Read uses `collection.read`; upload,
finalization, and deletion use `collection.update` (editor or equivalent).
Deleting an ordinary knowledge Document does not require `knowledge.manage`,
Collection ownership, or upload ownership. A `conversation_attachment` is
different: its private upload remains owner-only even when another caller has
Collection editor permissions. Referencing an existing knowledge Document
from chat does not change its purpose or ownership.

## Document creation

One endpoint accepts two transport representations.

Presigned reservation uses `application/json`:

```json
{
  "name": "annual-report.pdf",
  "content_type": "application/pdf",
  "size_bytes": 1024000,
  "purpose": "knowledge"
}
```

Direct upload uses `multipart/form-data`:

```text
file=<binary>
purpose=knowledge
```

`purpose` is `knowledge` or `conversation_attachment`. It is business intent,
not transport choice, and it does not decide how content is processed: every
knowledge-format Document is processed by the same core (parse → chunk →
contextualize → embed → index → cite) when an Ingestion Run includes it, so
retrieval reads one representation however the Document entered.

Knowledge formats are text (`.txt .md .markdown .rst .csv .tsv .json .jsonl
.xml .yaml .yml .html .htm .log .sql`), Office (`.docx .pptx .xlsx`) and PDF.
A typed PDF is read from its own text layer (no model). A scanned page (an
image and fewer than 20 characters of text) is transcribed by Docling's VLM
pipeline with the configured vision model (`BOMESH_DOCLING_MODEL` on
OpenRouter, Markdown response parsed by Docling) and placed at its page
number among the text-layer pages. Without that model a fully scanned PDF
fails with "the file has no text to index"; a transcription the model did not
finish fails with "the scanned pages could not be transcribed". Text inside
pictures of typed pages is not indexed. Spreadsheets use Docling's xlsx
backend; leading rows whose only text is one cell merged across columns (a
title, a notes line) become text before the table, so the first real row is
the column header chunks repeat. PDFium is not thread-safe: BoMesh and
Docling share one process-wide lock (Docling's `pypdfium2_lock`) for every
PDFium call; concurrent Activities in a worker parse other formats in
parallel.
The same parse also yields the document's whole-document rendition, read by
the document viewer; see `document_viewer.md`.
**Images are not knowledge in this phase.** An image (`.png .jpg .jpeg .gif
.webp .bmp .tif .tiff .avif`) is accepted only as a `conversation_attachment`,
for the model to look at in that conversation: it is stored and `available`,
but never processed (`processing.state` `unsupported`). As `knowledge`, or in
any workspace Collection, it is rejected with `422`. Sources and archives skip
image files the same way.
When the agent looks at an image, the backend reads it from object storage and
sends it inline (`data:` URL, at most 20 MB). A storage URL is never handed to
the model provider: a private endpoint such as local MinIO is unreachable from
it, and a signed URL would give a third party a bearer link to the object.

## Adding is not processing

Creating a Document and finalizing its content only add it to the inventory:
the bytes are stored and the Document reads back with `processing.state =
pending`. Nothing is parsed, contextualized, embedded or indexed, and no
workflow starts — uploading 100 files creates 100 pending Documents and zero
runs, whichever Collection they land in (workspace or the caller's own).
Processing is a separate, explicit Ingestion Run (`POST /api/v1/ingestion-runs`,
see `api_contract.md`), started by a person, an API client or a Source
schedule; a person may start one right after uploading. A
`conversation_attachment` needs no run to be usable in chat: the agent reads
its stored original directly.

For local development, `backend/main.py` starts the existing Compose services
and runs the ingestion Temporal worker alongside the API. The worker stops
with the API; shared Compose infrastructure remains running. Deployed API and
worker processes remain independently deployable; no HTTP contract depends on
this local bootstrap.

Both representations call one Document creation use-case. Direct upload stores
and validates bytes within the request. JSON creation returns temporary upload
instructions associated with the Document.

Response is `DocumentCreateResult`:

```json
{
  "document": {
    "id": "document-uuid",
    "collection_id": "collection-uuid",
    "name": "annual-report.pdf",
    "content_type": "application/pdf",
    "size_bytes": 1024000,
    "purpose": "knowledge",
    "status": "pending_content",
    "processing": {"state": "pending", "error": null, "run_id": null},
    "created_at": "2026-09-21T00:00:00Z",
    "updated_at": "2026-09-21T00:00:00Z"
  },
  "upload": {
    "url": "https://temporary-upload-target.example",
    "method": "PUT",
    "headers": {"Content-Type": "application/pdf"},
    "expires_at": "2026-09-21T00:10:00Z"
  },
  "created": true
}
```

`created` is `false` when the same idempotency key replays an existing
Document; response shape stays unchanged.

For direct `knowledge` upload, `document.status` is `available`, `upload` is
null, and `processing.state` is `pending`. An image attachment's is
`unsupported`.

## Content finalization

After direct object-storage upload, client calls:

```text
PUT /api/v1/documents/{document_id}/content
```

No storage key, bucket, provider, ETag, workflow ID, or upload ID is accepted.
Server resolves the reserved storage location, checks object existence, size,
and content type, then makes content available. Repeating PUT after success
returns the same successful state.

Response is `DocumentContentResult` containing the updated `document`. This
endpoint does not upload raw bytes through API; direct raw bytes use multipart
Document creation.

## Lifecycle separation

`Document.status` describes canonical content availability only:

```text
pending_content | available | failed
```

These are public API states. Internal `items.status`, `items.index_status`, and
the private `item_uploads.status` may keep storage-oriented values; API mapping
belongs at the `backend/api` boundary and must not leak those values.

Deleted Documents are no longer returned to normal callers, so `deleted` is
not a readable public state. Processing state is the separate
`Document.processing`:

```text
processing.state: pending | processing | ready | failed | outdated | unsupported
```

`processing` is `{state, error, run_id}`. `state` comes from the Item's one
processing state (`index_status`) and `processed_version`: a ready Document
whose index was built with a different processing configuration than the
current one is `outdated`. `error` and `run_id` come from the Document's latest
Ingestion Run item: the user-safe reason it was not processed and the run to
open for detail. Processing, re-processing (any state, by naming the Document)
and retrying are all new Ingestion Runs over the same stored original —
nothing is uploaded again.

Runs retry only what time can fix (storage, index, provider timeouts, rate
limits, 5xx). An embedding provider that refuses the request itself (HTTP
400/401/402/403/404/422: a bad or exhausted key, a forbidden or unknown model)
fails the Document at once with "The embedding provider refused the request
(HTTP n) …" and stops its run (`failed`, the rest `skipped`), since every other
Document would be refused too. The provider's own message, which can carry
account details, stays in the worker log. After an operator fixes the provider
configuration, retry the run.

State transitions are intentionally narrow:

```text
create (JSON reservation) -> pending_content
create (multipart content) -> available
PUT /content (validated object) -> available
content validation failure -> failed
failed -> available           (retry after valid object is present)
available -> available       (idempotent finalization)
```

`available` does not imply searchable: processing is an Ingestion Run's job.
The agent can read an attachment's content without any run.

## Archives

A `.zip` may be created like any other file (multipart or presigned) into a
**workspace Collection**, as `knowledge`. Into the caller's own Collection, or
as a `conversation_attachment`, it is rejected with `422`. The response is the
archive's own Document (`content_type` `application/zip`, internal
`document_type` `archive`), pending like any upload. An archive is an upload
record, not knowledge: it is never canonicalized or indexed itself.

An Ingestion Run that includes the archive expands it. Each accepted member
becomes an ordinary pending `knowledge` Document of the **same Collection** —
its own Item, private upload record and object — and is appended to that same
run, so it is parsed, contextually chunked, embedded, indexed and cited exactly
like a file uploaded directly. Children are Collection children, not Document
children, because retrieval scopes every chunk by its Document's Collection.
Lineage is kept on the child as `metadata.archive = {document_id, name,
path}`; the archive records `metadata.archive = {status, document_count,
skipped_count, skipped[]}`.

Safety and limits (defaults): at most 5,000 entries inspected, 500 Documents
produced (the rest reported as skipped), 2 GiB expanded in total, 100 MiB per
member, and a 200:1 compression ratio for members over 1 MiB. Traversing or
absolute paths, symbolic links, encrypted and empty members, nested archives,
hidden files and unsupported formats are skipped with a reason; archiving
debris (`__MACOSX`, `.DS_Store`) is dropped silently. A bomb, an over-limit
expansion or an unreadable archive fails the archive's run item and adds no
Documents. Member paths never choose a filesystem location.

Expansion is idempotent: a child's identity derives from the archive and the
member path, so a retried batch resumes rather than duplicating.

A successful expansion removes the archive Document (tombstone): what it held
now lives in the Collection as ordinary Documents. The tombstoned row stays as
the children's lineage and keeps the skip report. A failed expansion keeps the
archive Document `failed` with the reason, so it stays visible and can be
processed again. Removing a child is independent of the archive.

## Bulk loading a crawled corpus

A corpus that already sits in object storage (the UTE website mirror in R2,
written by `backend/script/ute_lib.py`) is loaded with
`backend/script/r2_to_collection.py`, a client of this contract rather than a
second ingestion path. It signs in, resolves or creates one workspace
Collection, and creates one multipart `knowledge` Document per supported
object (all pending; one Ingestion Run then processes them); no archive is built. The
`Idempotency-Key` is derived from the bucket and the decoded, NFC-normalized
object path, so a re-run replays existing Documents (`200`) and resumes the
rest, and a changed object surfaces as `409`. Unsupported formats (`.doc`,
`.xls`, `.rar`, images) and files above the upload limit are skipped locally
with a reason; the crawler's source URL is kept only in the script's manifest,
not on the Document.

## Idempotency

`Idempotency-Key` scope is authenticated actor + workspace + Document-creation
operation. Same key and same normalized request returns same Document. Pending
presigned flow may return refreshed temporary instructions. Reusing key with a
different Collection, name, content type, size, or purpose returns `409
IDEMPOTENCY_KEY_REUSED`. For multipart creation, the first file's normalized
metadata and content binding belong to that key; a different file under the
same key also returns `409` rather than mutating the existing Document.

## Status codes

| Operation | Success | Expected failures |
| --- | --- | --- |
| Create Document | `201` (new), `200` (idempotent replay) | `401`, `403`, `404`, `409`, `413`, `415`, `422`, `429` |
| Read Document | `200` | `401`, `403`, `404` |
| Finalize content | `200` | `401`, `403`, `404`, `409`, `422` |
| Delete Document | `204` | `401`, `403`, `404` |

DELETE response means Document is unavailable to normal callers. Tombstone
storage strategy remains internal.

## Before to after mapping

| Current/previous target | Decision | Final |
| --- | --- | --- |
| `POST /documents/uploads` | merge | `POST /collections/{collection_id}/documents` with JSON |
| `POST /document-uploads` | remove public Upload resource | `POST /collections/{collection_id}/documents` with JSON |
| `POST /document-uploads/{upload_id}/complete` | remove upload identity | `PUT /documents/{document_id}/content` |
| `POST /documents/{document_id}/complete` | rename/resource-orient | `PUT /documents/{document_id}/content` |
| `POST /collections/{collection_id}/documents/upload` | rename | `POST /collections/{collection_id}/documents` with multipart |
| `POST /documents/{document_id}/retry`, `POST /documents/{document_id}/ingestions` | processing is a run, not a Document action | `POST /ingestion-runs` (`document_ids`) or `POST /ingestion-runs/{ingestion_run_id}/retry` |
| `GET /documents/{doc_id}` | rename identifier | `GET /documents/{document_id}` |
| `DELETE /documents/{doc_id}` | rename identifier | `DELETE /documents/{document_id}` |

## Implementation gate

Implementation must converge direct and presigned transports on one Document
creation pipeline, keep object storage inside `bomesh.storage`, keep
Document/content lifecycle in Item services, and keep processing in
`ItemIngestionService`, reached only through an Ingestion Run. No
compatibility upload routes, public `upload_id`, or upload-triggered
processing remain.
