# Document viewer: whole-document renditions

Status: target design. Methods and fields: `openapi.yaml` (Knowledge),
`api_design.md` §5.

> A proposal to decouple **file preview** from RAG ingestion and serve the
> original file to the browser instead of rendering page images is in
> [`docs/universal-file-preview.md`](../../docs/universal-file-preview.md).
> It measures the current WebP pipeline at **2.34× the original's bytes** (up
> to 6.36×) for output that cannot be zoomed, selected or searched, and would
> delete it: `alt=media` already serves the original with `Range` support and
> working CORS. This document's scope would narrow to the citation substrate
> (the rendition). Not implemented; this document still describes the built
> system.

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
read:  GetItemContent (?revision=) ── authorize ──► signed URLs (pages, rendition); no index read
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
  response's `revision` names the revision rendered. It carries signed
  `pageAssets` and `rendition` (`uri`, `version`, `sizeBytes`, `blockCount`,
  `truncated`; gzip JSON `application/vnd.bomesh.document+json`). It reads
  PostgreSQL and signs storage URLs only: opening or previewing a document
  never reads the search index (thousands of chunks for a long document);
  the document's text is its rendition. A revision without a stored
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
request after the `items.get` check, short-lived (a cover image's within an
aligned window, below). Object storage must allow
cross-origin `GET` from the web origin. Local RustFS sends no CORS headers
until a bucket rule exists; `rustfs-init` applies one
(`RUSTFS_CORS_ALLOWED_ORIGINS`). An S3/R2 bucket needs the same rule.

### Cover on the Item

A list must show what a document looks like without reading each document's
content, so every Item carries `document.cover` and every Home entry `cover`
(`DocumentCover`): the shape of the current revision's first page (`kind`)
and either a small image of it (`imageUri`, `widthPixels`, `heightPixels`) or
its first text (`title`, `lines[]`, `cells[][]`). A grid of N documents costs
**one list call** and at most one signed URL per document, not N+1 content
reads: `GetItemContent` stays for reading a document, not for drawing its
card. Absent means not produced yet or nothing to show; the client then draws
the format's typed tile. `imageUri` wins over the text when present.

| Format | `kind` | Cover |
| --- | --- | --- |
| PDF | `PAGE` | page 1 rendered (pypdfium2) to a WebP ≤ 480 px wide |
| PNG, JPEG, WebP, GIF | `IMAGE` | the picture scaled to ≤ 480 px wide (JPEG decoded at reduced scale) |
| PPTX | `SLIDE` | the package's raster `docProps/thumbnail`, else slide 1's title and text |
| DOCX | `PAGE` | the package's raster thumbnail, else the first heading and the paragraphs before the first page break |
| XLSX | `SHEET` | the package's raster thumbnail, else the first sheet's name and top-left 6 × 5 cells |
| CSV, TSV | `SHEET` | the first 6 × 5 cells |
| TXT, Markdown, HTML | `TEXT` | the title (first `#` heading, `<title>`/`<h1>`) and first lines |
| anything else | — | none: the typed tile |

Nothing whole is rasterized and no office suite renders a page: an OOXML
embedded thumbnail is used as is (EMF/WMF and blank template thumbnails are
ignored), otherwise the text the package already holds is read with streaming
XML and stops at the first page. Lines share 480 characters, so a text cover
stays well under 1 KB; an image above 40 KB is encoded again at a lower
quality.

**When.** A cover is produced when the content arrives, not when the document
is processed, so an unprocessed upload has one too. The `items` trigger
`trg_items_cover` sends `pg_notify('bomesh_cover', item_id)` when a
DOCUMENT's content becomes available or its current content changes (status
to `ready`, a new `storage_key`: upload, new revision, approval, rollback).
The ingestion worker LISTENs on its lock connection, queues the IDs in memory
(deduplicated, at most 1,000) and produces one cover at a time in one of its
document slots, so runs keep their throughput; a sweep at start and every ten
minutes (keyset by ID, pages of 200, one replica at a time) produces what the
notifications missed and backfills older documents. A cover is bounded:
originals over 50 MB get none, production stops after 30 s, only page 1 is
read. A file that cannot be read is recorded as `none` and not retried until
its content changes. Requests never produce covers.

**Stored.** `items.metadata.cover` (a few hundred bytes): `version`, `source`
(the `storage_key` it shows), `kind`, and `key`/`width`/`height` of the image
or `title`/`lines`/`cells`. The image is
`previews/cover-v1/{sha256(storage_key)}.webp` under the Item's prefix,
immutable and stored with `Cache-Control: private, max-age=31536000,
immutable`. A cover whose `source` is not the Item's `storage_key` is ignored
by reads and produced again; a revision change also drops it from the
metadata (derived metadata), and writing a cover never changes `updateTime`
or `etag`.

**Read.** List, Search, GetItem and Home project `cover` from the loaded row:
no query, one presign per document with an image. Its URL is signed at the
start of a `BOMESH_PREVIEW_COVER_URL_SECONDS` window (default one hour) and
valid for two, so every list in the window returns the same URL and the
browser reuses its cached image.

**No page count is exposed.** It would have to be derived per document, it is
not a fact anyone acts on, and it exists today only because rasterizing a PDF
happens to count pages on the way past. A viewer with the content open numbers
its own pages.

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
- Rendition failure never fails ingestion; the viewer then shows the page
  images when the revision has them, else offers the original.
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
  the chat source panel and the chat file panel, in the file's native format
  (PDF and Word pages, slides, a spreadsheet grid, web-like formats as one
  continuous page); there is no separate text view. PDFs keep page images.
- The full viewer is the web route `/doc/{item}`. It reads `GetItem`
  (name, parent collection, size, `indexingState`, `indexedRevision`),
  `GetItem` on the parent collection (name and the caller's `access`) and
  `GetItemContent` (page assets, rendition). A revision with page images
  shows them (the document's own pages, opened at `?page=` or the first cited
  page) and does not download the rendition; otherwise the rendition is laid
  out as one sheet per source page; with neither, the original is offered
  (`?alt=media`). There is no outline: the pages are the navigation, and a
  panel beside them would cost a rendition download for every PDF.
  Viewing an older revision passes
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
  `?q=` highlights matches with previous/next in a rendition (page images
  carry no text marks; a citation opens at its page); `?page=` opens a page.
- Performance:
  - The rendition is downloaded only when it is what the canvas shows (no
    page images), once per document version, and kept in an in-memory cache
    keyed by `item:version`; stepping between citations of one document never
    downloads it again, and concurrent requests share one fetch.
  - Opening is cover-first: the quick preview and `/doc/{item}` draw the
    Item's `cover` as the first page the moment they mount — its image
    (already in the browser cache from the list), else its text in the
    format's shape (a page with the title and first lines, a slide, the
    first sheet's cells) — with a sized blank after it while `GetItemContent`
    and the page images or the rendition load; a preview opened from a list
    draws from the listed Item while `GetItem` refreshes it, so `GetItem` and
    `GetItemContent` run in parallel. The real pages then replace the cover.
    Without a rendition (not processed, `FAILED_PRECONDITION`) the cover
    stays under the not-ready message.
  - Page images are windowed: every page is a box of its exact size
    (`widthPixels` × `heightPixels`), but only the pages two either side of
    those in view hold an `<img>`; scrolling away unmounts it. A 50-page PDF
    keeps 3–5 decoded pages instead of 50 (measured: 3 mounted, ≈ 38 MB of
    bitmaps at 1600 px, against 50 and ≈ 632 MB when every page stays mounted).
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
