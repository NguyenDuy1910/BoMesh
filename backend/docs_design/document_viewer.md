# Document viewer: whole-document renditions

Status: accepted design. Implementation follows this document.

## Problem

People must be able to read a whole knowledge document in BoMesh — from a
citation in chat and from the Library — not only the cited passage. Today only
PDFs have page images; Word, Excel, text and Markdown files show at most one
passage, and the Library's "Original" view has no real content at all.

## Decision

Ingestion already parses every document once into a canonical `DocumentItem`
whose `content` is a list of typed parts (`text`, `table`, `code`, `image`,
`link`, `structured`), each with the same `element_id` that citation spans
point at. That parse is the rendition. At ingestion time, BoMesh serializes
it into one **document rendition** — compact JSON, gzip-compressed — and stores
it beside the existing page previews. The browser downloads it directly from
object storage through a short-lived signed URL and renders it with React.

```text
ingestion: original file ── parse once (Docling) ──► DocumentItem.content
                                   │                       │
                                   │ PDFs only             │ every knowledge document
                                   ▼                       ▼
                       page images (WebP)        document rendition (JSON, gzip)
                                   └────── preview manifest (Item.metadata.preview) ──────┘
read:  GET /knowledge/documents/{id}[?chunk=] ── authorize ──► signed URLs (pages, rendition)
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

### Preview manifest (`Item.metadata.preview`, internal)

`PreviewManifest` gains an optional `rendition`
(`key`, `size_bytes`, `version`, `block_count`, `truncated`). It is additive:
manifests written before it remain valid and simply have no rendition.
`version` is derived from the source version and `DOCUMENT_RENDITION_VERSION`.
Page images and the rendition are independent: regenerating one keeps the
other when the source has not changed.

### API (public)

The existing `preview` object of `GET /knowledge/documents/{document_id}` and
of citation reads gains `rendition`:

```json
"rendition": {"url": "<signed GET>", "version": "…", "size_bytes": 81234,
              "block_count": 412, "truncated": false}
```

It is `null` when no rendition exists yet. No new endpoint is added; the
document is authorized exactly as before, and the URL expires like page URLs.
Object storage must allow cross-origin `GET` from the web origin (MinIO does by
default; an S3/R2 bucket needs a CORS rule).

## Producing renditions

- **Ingestion.** `ItemIngestionService` passes the canonical `DocumentItem` it
  just parsed to `KnowledgePreview.generate(document, content=item)` on both the
  upload and the connector path. There is no second parse.
- **Backfill.** `backend/script/backfill_document_renditions.py` writes
  renditions for documents indexed before this design: it re-parses the stored
  original (no embeddings, no model calls) and merges the manifest. It is
  idempotent and skips documents whose rendition is current.
- Rendition failure never fails ingestion; the viewer falls back to the cited
  passage.

## Reading (web)

- One shared document view renders a rendition for both the chat source panel
  and the Library's "Original" view; PDFs keep page images, with the text view
  available beside them.
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
