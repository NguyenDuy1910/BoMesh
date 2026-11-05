# Document Items: creation, content and states

Status: target contract for DOCUMENT Items. Field-level contract:
`openapi.yaml` (Knowledge); method catalogue: `api_design.md` §5; domain
decisions: `item_model.md`.

## Model

A document is an Item with `itemType: DOCUMENT` whose `parentItem` is a
COLLECTION (a root collection, a nested collection, or the caller's PERSONAL
collection). Its bytes are immutable revisions (`item_revisions`); the reader
view (`GetItemContent`) and citation targets (`passages`) are derived by
processing.

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
  "itemType": "DOCUMENT",
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

The response is the Item with `document.contentState: PENDING`,
`publicationState: PUBLISHED`, `indexingState: PENDING` and an output
`uploadUri` (shown to the creator while `PENDING`). The client PUTs the bytes
to `uploadUri`, then calls `CompleteItemUpload`, which validates the stored
object (existence, size, MIME type) and sets `contentState` `AVAILABLE`, or
`FAILED` when the object does not validate. It accepts no storage key, bucket,
provider, ETag or workflow ID. An object not yet present is
`FAILED_PRECONDITION` reason `UPLOAD_INCOMPLETE`; calling it on an `AVAILABLE`
document returns it unchanged. Completion records `item_revisions` #1.

`CreateItemMedia` is the one-call upload: multipart with a `metadata` JSON
part (the Item) and a `file` part. The object is stored and validated in the
request, so the document is returned `AVAILABLE` with no `uploadUri`.

Both bindings call one creation use-case. `purpose` (`KNOWLEDGE`,
`CONVERSATION_ATTACHMENT`) is business intent, not transport choice, and does
not decide how content is processed: every knowledge-format document is
processed by the same core (parse → chunk → contextualize → embed → index →
cite) when an Ingestion Run includes it, so retrieval reads one
representation however the document entered.

New documents are `PUBLISHED` (an editor is adding them); contributors put
documents up for review with `CreateContribution` instead.

## Formats

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
parallel. The same parse also yields the document's whole-document
rendition, read by the document viewer; see `document_viewer.md`.

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
one either. A `CONVERSATION_ATTACHMENT` needs no run to be usable in chat:
the agent reads its stored original directly.

For local development, `backend/main.py` starts the existing Compose services
and runs the ingestion Temporal worker alongside the API. The worker stops
with the API; shared Compose infrastructure remains running. Deployed API and
worker processes remain independently deployable; no API contract depends on
this local bootstrap.

## States

Document state is four independent fields, never collapsed
(`item_model.md` §3):

| Field | Values | Source of truth | Changed by |
| --- | --- | --- | --- |
| `state` | `ACTIVE`, `DELETED` | `items.deleted_at` | DeleteItem / UndeleteItem |
| `document.contentState` | `PENDING`, `AVAILABLE`, `FAILED` | `items.status` | upload completion |
| `document.publicationState` | `PUBLISHED`, `UNPUBLISHED` | `items.publication_state` | PublishItem / UnpublishItem, contribution approval, source policy |
| `document.indexingState` | `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, `OUTDATED`, `UNSUPPORTED` | `items.index_status` + `processed_version` | ingestion runs only |

Internal `items.status`, `items.index_status` and `item_uploads.status` keep
storage-oriented values; mapping belongs at the `backend/api` boundary and
must not leak them.

`contentState` transitions are intentionally narrow:

```text
CreateItem                              -> PENDING
CreateItemMedia (validated object)      -> AVAILABLE
CompleteItemUpload (validated object)   -> AVAILABLE
CompleteItemUpload (invalid object)     -> FAILED
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
possible. `document.mimeType`, `sizeBytes` and `fileName` follow the current
revision, and a content change resets derived preview metadata and sets
`indexingState: PENDING`. `document.indexedRevision` names the revision that
passages and citations belong to. Revisions are read with
`ListItemRevisions` / `GetItemRevision`.

## Archives

A `.zip` may be created like any other file (`CreateItem` or
`CreateItemMedia`) into a **STANDARD collection**, as `KNOWLEDGE`. Into a
PERSONAL collection, or as a `CONVERSATION_ATTACHMENT`, it is rejected with
`INVALID_ARGUMENT` reason `FORMAT_NOT_ALLOWED`. The response is the archive's
own document (`mimeType` `application/zip`, `documentType` `archive`),
pending like any upload. An archive is an upload record, not knowledge: it is
never canonicalized or indexed itself.

An Ingestion Run that includes the archive expands it. Each accepted member
becomes an ordinary pending `KNOWLEDGE` document whose `parentItem` is the
**archive's collection** — its own Item, upload ledger row, revision and
object — and is appended to that same run as a task, so it is parsed,
contextually chunked, embedded, indexed and cited exactly like a file uploaded
directly. Members are collection children, not document children
(`parentRelation: CONTAINS`), because retrieval scopes every chunk by its
governing collection. Lineage is kept on the child as `metadata.archive =
{item, name, path}`; the archive records `metadata.archive = {status,
document_count, skipped_count, skipped[]}`.

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

A corpus that already sits in object storage (the UTE website mirror in R2,
written by `backend/script/ute_lib.py`) is loaded with
`backend/script/r2_to_collection.py`, a client of `CreateItem` rather than a
second ingestion path. It signs in, resolves or creates one root collection,
and creates one `KNOWLEDGE` document per supported object with
`CreateItemMedia` (all pending; one Ingestion Run then processes them); no
archive is built. The `requestId` is a UUID derived from the bucket and the
decoded, NFC-normalized object path, so a re-run replays existing documents
and resumes the rest, and a changed object under the same `requestId` is
`INVALID_ARGUMENT` reason `REQUEST_ID_REUSED`. Unsupported formats (`.doc`, `.xls`, `.rar`, images) and files above
the upload limit are skipped locally with a reason; the crawler's source URL
is kept only in the script's manifest, not on the document.

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
