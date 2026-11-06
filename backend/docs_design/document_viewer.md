# Document viewer: whole-document renditions

Status: target design. Methods and fields: `openapi.yaml` (Knowledge),
`api_design.md` §5.

## Problem

People must be able to read a whole knowledge document in BoMesh — from a
citation in chat and from Knowledge (the web Library) — not only the cited
passage. Today only PDFs have page images; Word, Excel, text and Markdown files
show at most one passage, and the Library's "Original" view has no real content at all.

## Decision

Processing (an Ingestion Run) already parses every document once into a
canonical `DocumentItem` whose `content` is a list of typed parts (`text`,
`table`, `code`, `image`, `link`, `structured`), each with the same
`element_id` that citation spans point at. That parse is the rendition. At
processing time, BoMesh serializes
it into one **document rendition** — compact JSON, gzip-compressed — and stores
it beside the existing page previews. The browser downloads it directly from
object storage through a short-lived signed URL and renders it with React.

```text
ingestion: original file ── parse once (Docling) ──► DocumentItem.content
                                   │                       │
                                   │ PDFs only             │ every knowledge document
                                   ▼                       ▼
                       page images (WebP)        document rendition (JSON, gzip)
                                   └──── preview manifest (item_revisions.exports.preview) ────┘
read:  GetItemContent (?revision=) ── authorize ──► elements + signed URLs (pages, rendition)
       GetPassage / ListPassages (indexedRevision) ──► citation geometry
browser: fetch rendition directly from storage ─► render blocks ─► highlight cited element/rows
```

Signed URLs are issued for the storage host as the client reaches it
(`BOMESH_S3_PUBLIC_ENDPOINT_URL`, defaulting to the backend's own
`BOMESH_S3_ENDPOINT_URL`): SigV4 signs the host, so a URL naming the backend's
loopback address works on the same machine and fails on a phone.

Rejected alternatives:

- **Convert Office files to PDF (LibreOffice) and reuse page images.** A large
  native dependency in every worker, seconds per file, and spreadsheets paginate
  badly (wide sheets split across pages). Page images also cannot be searched,
  copied, or highlighted by element.
- **Parse the original in the browser (SheetJS, docx-preview, pdf.js).** Several
  hundred KB of parser JavaScript, the whole original file downloaded and parsed
  on the client every time, and a second parse that can disagree with what the
  agent indexed and cites.
- **Serve the rendition through the API.** Puts megabytes of bytes on the API
  path. Storage already serves page images directly; the rendition uses the
  same signed-URL path.

## Contract

### Stored rendition (object storage, internal)

Key: `tenants/{tenant}/items/{item}/previews/{DOCUMENT_RENDITION_VERSION}/{source_version}/document.json.gz`,
stored with `Content-Type: application/vnd.bomesh.document+json`,
`Content-Encoding: gzip`, `Cache-Control: private, max-age=31536000, immutable`.
The key changes whenever the original or the renderer changes, so objects are
never rewritten in place.

```json
{
  "schema": 1,
  "truncated": false,
  "blocks": [
    {"id": "doc_heading_001", "kind": "heading", "level": 1, "text": "…", "page": null},
    {"id": "p001_para_004", "kind": "paragraph", "text": "…", "page": 1},
    {"id": "p002_table_001", "kind": "table", "caption": null,
     "columns": ["…"], "rows": [["…"]], "total_rows": 1840, "page": 2},
    {"id": "p001_code_002", "kind": "code", "text": "…", "language": "sql", "page": 1},
    {"id": "p003_image_001", "kind": "image", "text": "caption / OCR / description", "page": 3},
    {"id": "doc_para_009", "kind": "link", "text": "title", "url": "https://…", "page": null}
  ]
}
```

- `id` is the part's `element_id`, the same value as `CitationSpan.element_id`.
- `heading.level` is the depth of the heading's own section path (1–4).
- Structured (key/value, form) parts render as `paragraph` text.
- `page` is the source page; for a spreadsheet it is the sheet number.
- Bounds: at most 20,000 blocks, 20,000 rows per table and 1,000,000 cells per
  document, and 32 MiB uncompressed. Past a bound the rest is dropped,
  `truncated` is `true`, and readers are pointed at the original file.
- Gzip output is deterministic (`mtime=0`), so regenerating identical content
  produces identical bytes.

### Preview manifest (per revision, internal)

Each revision keeps its own manifest in `item_revisions.exports.preview`
(`item_model.md` §4.8); `Item.metadata.preview` mirrors the current
revision's manifest and is reset when the current revision changes. The
manifest holds page images and an optional `rendition` (`key`, `size_bytes`,
`version`, `block_count`, `truncated`). Manifests without a rendition remain
valid. `version` is derived from the source version and
`DOCUMENT_RENDITION_VERSION`. Page images and the rendition are independent:
regenerating one keeps the other when the source has not changed.

### API (public)

- `GetItemContent` (`GET …/items/{item}/content`, `items.get`) returns the
  reader representation of the current revision, or of `?revision=`; the
  response's `revision` names the revision rendered. It carries `elements`
  (kind, text, level, `pageNumber`, `elementId`, owning `passage`), signed
  `pageAssets` and `rendition` (`uri`, `version`, `sizeBytes`, `blockCount`,
  `truncated`; gzip JSON `application/vnd.bomesh.document+json`). A revision without a stored
  preview is `FAILED_PRECONDITION` reason `REVISION_NOT_RENDERED`; a document
  never rendered at all is `FAILED_PRECONDITION`; a COLLECTION is
  `INVALID_ARGUMENT`; a DELETED item is `NOT_FOUND`.
- Passages (`GET …/items/{item}/passages[/{passage}]`, passage ID = chunk ID)
  are the citation targets. They always belong to `document.indexedRevision`,
  which may differ from the current revision while a new one is not yet
  indexed.
- `GetItem ?alt=media` answers 302 to the signed original of the current
  revision (download, "open original", truncated renditions).

No other endpoint serves the rendition; all signed URLs are issued per
request after the `items.get` check, short-lived. Object storage must allow
cross-origin `GET` from the web origin. Local RustFS sends no CORS headers
until a bucket rule exists; `rustfs-init` applies one
(`RUSTFS_CORS_ALLOWED_ORIGINS`). An S3/R2 bucket needs the same rule.

## Producing renditions

- **Processing.** `ItemIngestionService.process_document` passes the
  canonical `DocumentItem` it just parsed from the stored original to
  `KnowledgePreview.generate(document, content=item)`, for uploads and
  connector documents alike, and stores the manifest on the revision it
  parsed. There is no second parse. A document that has never been processed
  has no rendition yet.
- **Backfill.** `backend/script/backfill_document_renditions.py` writes
  renditions for documents indexed before this design: it re-parses the stored
  original (no embeddings, no model calls) and merges the manifest. It is
  idempotent and skips documents whose rendition is current.
- Rendition failure never fails ingestion; the viewer falls back to the cited
  passage.
- **Conversation artifacts.** A file the agent produced is never ingested,
  so its revision is previewed on first view instead: `ArtifactService`
  parses the revision's original with the same `StoredFileContent` parser and
  writes the same rendition and page images through `KnowledgePreview`,
  keeping the manifest in `item_revisions.exports.preview`. Every
  revision except Markdown is previewed this way (a CSV becomes a table);
  images are shown as themselves. The chat's document panel renders it with
  `DocumentRenditionView`.

## Reading (web)

- One shared document view renders a rendition for the full document viewer,
  the chat source panel and the chat file panel; PDFs keep page images, with
  the text view available beside them.
- The full viewer is the web route `/doc/{item}`. It reads `GetItem`
  (name, parent collection, size, `indexingState`, `indexedRevision`),
  `GetItem` on the parent collection (name and the caller's `access`) and
  `GetItemContent` (elements, page assets, rendition), and lays the rendition
  out as one sheet per source page with an outline of its top two heading
  levels. A revision with no rendition is shown from `elements` (the indexed
  passages under their sections). Viewing an older revision passes
  `?v=<revision number>` (sent to the API as `revision`);
  `REVISION_NOT_RENDERED` shows the revision's metadata and a
  download through `?alt=media`.
- Citations open it as `/doc/{item}?passage=<passage>&from=<conversation>`, with one
  `passage` parameter per passage an answer cited in that document, in
  citation order. Every passage is resolved through `GetPassage`: its
  `elementIds` name the blocks to mark and its `boundingBoxes` the page
  geometry; the
  rendition is read for `indexedRevision` so evidence marks land on the text
  that was cited. Each cited block gets an evidence mark on exactly the quoted
  words when the span's element-local offsets fit the block's text (or the
  passage is found inside the block), the whole block otherwise, and the
  cited rows of a table. The viewer scrolls to the focused passage and steps
  through the others; a passage that no longer resolves (the document was
  reprocessed) is reported, not guessed.
- A document whose `indexingState` is not `SUCCEEDED` shows that state and
  re-reads `GetItem` until it is; a `FAILED` one shows `indexingError` and,
  with `ingestionRuns.create` on its collection, retries through
  `CreateIngestionRun` (`selector.items: [item]`). A document the caller
  cannot read (`PERMISSION_DENIED`) offers `CreateRequest` with `kind:
  COLLECTION_ACCESS`; an unknown one is `NOT_FOUND`.
- "Ask about this document" and "Ask about this" on a text selection ask in
  place, in the viewer's Ask rail (`Converse` with the document attached);
  "Continue in chat" opens that conversation at `/chat/{conversation}`.
  `?q=` highlights matches with previous/next; `?page=` opens a page.
- Performance:
  - The rendition is fetched once per document version and kept in an
    in-memory cache keyed by `item:version`; stepping between citations of one
    document never downloads it again, and concurrent requests share one fetch.
  - Long documents and large sheets render with CSS `content-visibility: auto`
    on blocks and on row groups (100 rows each), so the browser lays out only
    what is on screen without a virtualization library. Tables are CSS grids
    of row groups rather than `<table>`: containment does not apply to
    internal table boxes, so `content-visibility` on a `<tbody>` would skip
    nothing. Each table scrolls in its own box with a sticky header row and
    row-number column.
  - The cited element is highlighted by `element_id`. For a table, the cited
    rows are those whose cell values appear, as whole values, in the cited
    passage; the view scrolls to the first one.
  - Measured on the local UTE corpus: 97 documents backfilled in about 30 s;
    the largest stored rendition is 13 KB (gzip).
