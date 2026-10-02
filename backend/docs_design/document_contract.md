# Document and Content API Contract

Status: target contract. This document is part of the contract-first gate;
router, service, storage, frontend, and test changes wait until this model is
accepted.

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
    -> Document
        -> Content
            -> Ingestion (when purpose requires indexing)
```

## Final endpoint contract

| Method | Path | Purpose | Authorization | Idempotency |
| --- | --- | --- | --- | --- |
| POST | `/api/v1/collections/{collection_id}/documents` | Create Document; accept direct multipart content or reserve presigned content upload | authenticated user + Collection write access | required `Idempotency-Key` |
| GET | `/api/v1/documents` | List permission-filtered Documents | workspace permission + Collection ACL | n/a |
| POST | `/api/v1/documents/search` | Search permission-filtered indexed Documents | workspace permission + Collection ACL | n/a |
| GET | `/api/v1/documents/{document_id}` | Read canonical Document metadata | Collection read access | n/a |
| PUT | `/api/v1/documents/{document_id}/content` | Validate reserved object, bind it as Document content, and start Ingestion when required | Document/Collection write access | method is idempotent |
| DELETE | `/api/v1/documents/{document_id}` | Remove Document from normal use | Document/Collection delete access | method is idempotent |

No `PATCH /documents/{document_id}` is added: current product has no distinct
Document metadata-edit use case.

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
knowledge-format Document whose content becomes available is ingested by the
same core (parse → chunk → contextualize → embed → index → cite), so retrieval
reads one representation however the Document entered.

Knowledge formats are text (`.txt .md .markdown .rst .csv .tsv .json .jsonl
.xml .yaml .yml .html .htm .log .sql`), Office (`.docx .pptx .xlsx`) and PDF.
Extraction uses no model: a PDF is read from its own text layer, so a scanned
PDF (no text layer) fails its Ingestion with "the file has no text to index",
and text inside pictures or screenshots is not indexed.
**Images are not knowledge in this phase.** An image (`.png .jpg .jpeg .gif
.webp .bmp .tif .tiff .avif`) is accepted only as a `conversation_attachment`,
for the model to look at in that conversation: it is stored and `available`,
but never ingested (internal `index_status` `unsupported`, `latest_ingestion`
null, retry `409`). As `knowledge`, or in any workspace Collection, it is
rejected with `422`. Sources and archives skip image files the same way.

## Who runs the ingestion

The destination Collection decides, and `DocumentService` records the choice
as the Ingestion's `mode`:

| Destination | Mode | Runner |
| --- | --- | --- |
| The caller's own system Collection (`My uploads`, conversation artifacts): chat attachments, the personal library | `direct` | the API process runs the core right after the bytes land. No workflow infrastructure; interrupted runs resume at API startup |
| A workspace Collection (Collection write access: workspace knowledge management) | `managed` | one Temporal ingestion, with durable retries, cancellation and the Activity monitor |

Connector Sources are always managed (`source.manage`). A normal member needs
no ingestion-management permission to upload for chat: their uploads land in
their own Collection and run directly.

For local development, `backend/main.py` starts the existing Compose services
and runs the managed-ingestion Temporal worker alongside the API. The worker
stops with the API; shared Compose infrastructure remains running. Deployed
API and worker processes remain independently deployable; no HTTP contract
depends on this local bootstrap.

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
    "created_at": "2026-09-21T00:00:00Z",
    "updated_at": "2026-09-21T00:00:00Z"
  },
  "upload": {
    "url": "https://temporary-upload-target.example",
    "method": "PUT",
    "headers": {"Content-Type": "application/pdf"},
    "expires_at": "2026-09-21T00:10:00Z"
  },
  "ingestion": null,
  "created": true
}
```

`created` is `false` when the same idempotency key replays an existing
Document; response shape stays unchanged.

For direct `knowledge` upload, `document.status` is `available`, `upload` is
null, and `latest_ingestion` is the created Ingestion. An image attachment has
none.

## Content finalization

After direct object-storage upload, client calls:

```text
PUT /api/v1/documents/{document_id}/content
```

No storage key, bucket, provider, ETag, workflow ID, or upload ID is accepted.
Server resolves the reserved storage location, checks object existence, size,
and content type, then makes content available. Repeating PUT after success
returns the same successful state.

Response is `DocumentContentResult` containing updated `document` and optional
`ingestion`. This endpoint does not upload raw bytes through API; direct raw
bytes use multipart Document creation.

## Lifecycle separation

`Document.status` describes canonical content availability only:

```text
pending_content | available | failed
```

These are public API states. Internal `items.status`, `items.index_status`, and
the private `item_uploads.status` may keep storage-oriented values; API mapping
belongs at the `backend/api` boundary and must not leak those values.

Deleted Documents are no longer returned to normal callers, so `deleted` is
not a readable public state. Search/index processing remains on the separate
`Ingestion` resource:

```text
pending | running | completed | failed | cancelled | timed_out
```

Document responses embed `latest_ingestion` (an `Ingestion`, or `null`) rather
than duplicating its state as `index_status`, `processing`, or `ready`. It is
the Document's own Ingestion: an upload records one when its bytes become
available and a new one on retry, on the Item (`metadata.ingestion`, with its
`mode`), and the core keeps it current as it runs, whichever runner runs it:
phases, counts, timestamps and a user-safe failure reason. It outlives the
ingestion runtime's retention. For a managed run its `id` is also the
execution `/ingestions` reports live. It is `null` for a Document a connector
wrote (its Source's Ingestion indexed it) and for content that never arrived.
Retrying goes through `POST /ingestions/{ingestion_id}/retry`, in the run's
original mode; a direct run cannot be cancelled (`409`).

State transitions are intentionally narrow:

```text
create (JSON reservation) -> pending_content
create (multipart content) -> available
PUT /content (validated object) -> available
content validation failure -> failed
failed -> available           (retry after valid object is present)
available -> available       (idempotent finalization)
```

`available` does not imply searchable: indexing is the Ingestion's job. The
agent can read an attachment's content before its Ingestion completes.

## Archives

A `.zip` may be created like any other file (multipart or presigned) into a
**workspace Collection**, as `knowledge`: expanding it is bulk ingestion, so it
is always managed. Into the caller's own Collection, or as a
`conversation_attachment`, it is rejected with `422`. The response is the
archive's own Document (`content_type` `application/zip`, internal
`document_type` `archive`). An archive is an upload record, not knowledge: it
is never canonicalized or indexed itself.

Its Ingestion expands it. Each accepted member becomes an ordinary `knowledge`
Document of the **same Collection** — its own Item, private upload record,
object and Ingestion — and is parsed, contextually chunked, embedded, indexed
and cited exactly like a file uploaded directly. Children are Collection
children, not Document children, because retrieval scopes every chunk by its
Document's Collection. Lineage is kept on the child as
`metadata.archive = {document_id, name, path}`; the archive records
`metadata.archive = {status, document_count, skipped_count, skipped[]}`.

Safety and limits (defaults): at most 5,000 entries inspected, 500 Documents
produced (the rest reported as skipped), 2 GiB expanded in total, 100 MiB per
member, and a 200:1 compression ratio for members over 1 MiB. Traversing or
absolute paths, symbolic links, encrypted and empty members, nested archives,
hidden files and unsupported formats are skipped with a reason; archiving
debris (`__MACOSX`, `.DS_Store`) is dropped silently. A bomb, an over-limit
expansion or an unreadable archive fails the archive's Ingestion and adds no
Documents. Member paths never choose a filesystem location.

Expansion is idempotent: a child's identity derives from the archive and the
member path, so a retried Ingestion resumes rather than duplicating.

A successful expansion removes the archive Document (tombstone): what it held
now lives in the Collection as ordinary Documents, so the archive no longer
appears in Document reads. The tombstoned row stays as the children's lineage
and keeps the skip report, and its Ingestion (phase `expanding`) stays visible
in `/ingestions`. A failed expansion keeps the archive Document with a failed
`latest_ingestion`, so the reason stays visible and retryable. Removing a child
is independent of the archive.

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
| `POST /documents/{document_id}/retry` | merge into Ingestion lifecycle | `POST /ingestions/{ingestion_id}/retry` |
| `GET /documents/{doc_id}` | rename identifier | `GET /documents/{document_id}` |
| `DELETE /documents/{doc_id}` | rename identifier | `DELETE /documents/{document_id}` |

## Implementation gate

Implementation must converge direct and presigned transports on one Document
creation pipeline, keep object storage inside `bothesis.storage`, keep
Document/content lifecycle in Item services, and keep indexing lifecycle in
`ItemIngestionService`. No compatibility upload routes or public `upload_id`
remain after callers migrate.
