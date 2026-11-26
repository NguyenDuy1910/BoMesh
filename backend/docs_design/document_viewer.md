# Document viewer: one preview engine, citations marked on the Original

Status: target design. Methods and fields: `openapi.yaml` (Knowledge),
`api_design.md` §5. Background and measurements:
[`docs/universal-file-preview.md`](../../docs/universal-file-preview.md).

## Problem

People open a document to look at it: from Knowledge, My files, a review, a
citation in chat. Two rules follow from the business:

1. **Viewing never depends on processing.** Processing (an Ingestion Run)
   makes a document searchable, classified and citable; it never decides
   whether a person can see the file. An upload in My files, a contribution
   under review and a document whose run failed are all viewable. Only the
   marks of a citation (below), which processing locates, wait for it.
2. **The client must not grow a case per file format.** A workspace holds a
   hundred formats; every one handled in the browser is code to ship, test and
   keep fast on every device.

## Decision: representations (the Box Content Preview model)

The backend **preview engine** maps every supported format to one of six
**representations** and makes it once per revision; the client has exactly
one viewer per representation. This is how Box Content Preview shows 100+
formats: the server converts files into a few representation types and the
client picks a viewer by representation, loading each viewer's code only when
it is used.

| Representation | What the client receives | Viewer |
| --- | --- | --- |
| `PDF` | a PDF: the original, or the file converted to PDF | pdf.js, page by page over `Range` reads |
| `IMAGE` | a picture the browser shows as is | `<img>` |
| `TABLE` | gzip JSON `application/vnd.bomesh.table+json` | one grid |
| `TEXT` | UTF-8 text, `textFormat` MARKDOWN or PLAIN, `language` hint | Markdown renderer or monospaced text |
| `MEDIA` | a file the browser plays, `mediaType` VIDEO or AUDIO | `<video>` / `<audio>` |
| `ARCHIVE` | gzip JSON `application/vnd.bomesh.archive+json` | one entry list |

Anything else is `UNAVAILABLE FORMAT_NOT_SUPPORTED`; the original always
downloads.

Rejected alternatives:

- **A case per format in the client** (the previous design: pdf.js, an
  in-browser text/CSV/JSON pipeline and a Docling rendition for Office). Every
  format added client code; Office lost its layout (reflowed text, not the
  page).
- **Rasterize pages to images.** 2.34× the original's bytes on average,
  blurry past one zoom, no text selection or find, a 50-page ceiling.
- **Commercial client SDKs (Apryse WebViewer).** High fidelity, but licensed
  per add-on, multi-MB WebAssembly bundles, and still a server for most
  formats.
- **An online office suite (Collabora, OnlyOffice).** Built for editing,
  heavy to run for viewing, and a WOPI host to implement.
- **Parse in the browser (SheetJS, docx-preview).** Hundreds of KB per format
  and a second parse to keep fast on phones — exactly the client complexity
  this design removes.

## The engine (backend)

One package, `bomesh/services/previews/`, owns everything that turns a stored
file into something to look at: the format registry, the producers, the
stored manifests, the cover (thumbnail) and the read path. Knowledge items use
it through `GetItemPreview` and the Item's `document.cover`; nothing else
converts files for viewing.

### Format registry

One table maps an extension (then, when the extension is unknown, the MIME
type) to a representation and how to get it: **as is** (the original is the
representation) or a **producer**. Adding a format is adding a row. Each row
also names the Document file class (`items.item_type`, API `itemType`;
`item_model.md` §4.11), computed by the same table
(`bomesh/services/knowledge_items/file_types.py`). An unknown extension falls
back to the MIME family: `image/*`, `audio/*` and `video/*` to their class,
any other `text/*` to `plain_text`, anything else to `other`.

| Representation | Formats | Producer | File class |
| --- | --- | --- | --- |
| PDF | pdf | as is | `pdf` |
| PDF | doc, docx, docm, dot, dotx, dotm, odt, ott, rtf, wpd | Gotenberg LibreOffice → PDF | `word` |
| PDF | ppt, pptx, pptm, pps, ppsx, pot, potx, odp, otp | Gotenberg LibreOffice → PDF | `presentation` |
| PDF | ods, ots | Gotenberg LibreOffice → PDF | `spreadsheet` |
| PDF | vsd, vsdx, odg, pub | Gotenberg LibreOffice → PDF | `other` |
| PDF | html, htm, xhtml, mht | Gotenberg Chromium → PDF | `html` |
| PDF | eml | Gotenberg Chromium → PDF (e-mail rendered to HTML first: headers, body, attachment names) | `other` |
| IMAGE | png, jpg, jpeg, gif, webp, avif, svg | as is | `image` |
| IMAGE | bmp, tif, tiff, ico | Pillow → WebP (≤ 4096 px on the long side) | `image` |
| TABLE | csv, tsv, xlsx, xlsm | CSV reader / openpyxl (read-only, values as formatted) | `spreadsheet` |
| TABLE | xls | xlrd → xlsx (formats and merges kept), then as xlsx | `spreadsheet` |
| TEXT | md, markdown (MARKDOWN); rst (PLAIN) | decode (charset detection) → UTF-8 | `markdown` |
| TEXT | json, jsonl, yaml, yml, xml (PLAIN) | decode (charset detection) → UTF-8; JSON pretty-printed | `data` |
| TEXT | txt, log, toml, ini, cfg, conf, env, sql, graphql, proto, and source code (py, js, mjs, ts, tsx, jsx, java, kt, go, rs, c, h, cc, cpp, hpp, cs, rb, php, swift, scala, sh, bash, zsh, ps1, bat, r, lua, pl, dart, vue, svelte, css, scss, less, dockerfile, makefile), any other `text/*` (PLAIN) | decode (charset detection) → UTF-8 | `plain_text` |
| MEDIA | mp4, m4v, webm, ogv (VIDEO) | as is | `video` |
| MEDIA | mp3, m4a, aac, wav, oga, ogg, opus, flac (AUDIO) | as is | `audio` |
| ARCHIVE | zip | entry list from the central directory | `archive` |

`ods` has no maintained reader without a native office library, so it becomes
PDF like the other legacy Office formats; `xlsx`, `xlsm`, `xls`, `csv` and
`tsv` become a TABLE, which keeps a wide sheet usable where print pagination
would split it, and is the same workbook processing parses (`.xls` is
rewritten as `.xlsx` for both), so a citation's sheet range is exact.

### Representation payloads and bounds

- **PDF** — the PDF itself.
- **IMAGE** — the picture itself (or its WebP).
- **TEXT** — UTF-8, at most 1 MiB; longer files keep the first 1 MiB (cut on
  a character boundary) with `truncated: true`. JSON that parses is
  pretty-printed (2 spaces).
- **TABLE** — `{"schema": 2, "sheets": [{"name", "rows": [[cell …] …],
  "totalRows", "totalColumns", "truncated"}]}`; `rows[i][j]` is the sheet's
  cell at row `i + 1`, column `j + 1` (rows and columns are counted from A1,
  leading blank ones included), so a Highlight `cellRange` indexes it
  directly. Cells are the values as the sheet shows them (number and date
  formats applied, the same text processing reads). Bounds: 50 sheets,
  200 columns and 10,000 rows per sheet, 1,000,000 cells in all; past a bound
  the rest is dropped and `truncated` is set on the sheet and on the
  representation.
- **ARCHIVE** — `{"schema": 1, "entries": [{"path", "sizeBytes",
  "directory"}], "totalEntries", "truncated"}`, at most 10,000 entries, from
  the ZIP central directory only (nothing is extracted).
- **MEDIA** — the file itself.

Gzip JSON payloads are stored with `Content-Encoding: gzip`, so the browser
decompresses them.

### Producing

- **When.** On content arrival, like the cover: the `items` trigger already
  notifies `bomesh_cover` when a document's `current_revision_id` is set or
  changes (upload, new revision, approval, rollback). The
  worker's content-arrival job runs the engine for that item: the
  representation first, then the cover (a cover renders page 1 of a PDF
  representation when there is one, so Office files get real first-page
  covers). A read that finds the representation missing sends
  `pg_notify('bomesh_preview', '{item_id}:{revision_number}')` (older
  revisions, notifications lost while no worker ran) and answers PREPARING;
  every such read notifies again and the queue deduplicates. A start-up and
  ten-minute sweep (keyset by ID, one replica at a time) catches documents
  whose current revision has neither a representation nor a recorded failure.
- **Where.** In the ingestion worker, never in a request. Jobs are queued in
  memory (deduplicated, at most 1,000), run in the worker's document slots
  under the per-item advisory lock `item-preview`, with at most
  `BOMESH_PREVIEW_CONVERSIONS` (default 2) Gotenberg conversions at a time so
  conversions never starve processing.
- **Bounds.** Sources over 100 MiB are not converted (`TOO_LARGE`); a
  conversion stops after 120 s. TEXT reads only the first 1 MiB of the
  original (a `Range` read), TABLE streams rows and stops at its bounds,
  ARCHIVE reads the central directory.
- **Stored.** The representation object is
  `workspaces/{code}/files/{content_id}/preview-v1` (`database_architecture.md`
  "Object storage"; `content_id` of the revision it shows), immutable,
  `Cache-Control: private, max-age=31536000, immutable`, its MIME type as
  object metadata. The revision records it in
  `item_revisions.exports.representation` (`version`, `kind`, `stored` — false
  when the original is the representation —, `mime_type`, `size_bytes`,
  `text_format`, `language`, `media_type`, `truncated`); a manifest never holds
  a key or names the content it shows, because a revision's content never
  changes. Writing it never changes the Item's `updateTime` or etag. A
  revision that reuses a `content_id` (rollback, approval, artifact revert)
  starts with the exports of the revision it reuses, so the same bytes are
  never converted twice.
- **Failures.** A failure that is a property of the file is recorded as
  `item_revisions.exports.representation_failure` (`reason`:
  `UNREADABLE`, `CONVERSION_ERROR`, `TIMEOUT`, `EMPTY`, `TOO_LARGE`) and
  answered `UNAVAILABLE` (`TOO_LARGE`, else `CONVERSION_FAILED`) until the
  content changes. `FORMAT_NOT_SUPPORTED` is recorded too, so the sweep stops
  asking, but is ignored once the registry gains the format. An
  infrastructure failure (storage, database, Gotenberg unreachable or
  answering 503) records nothing: the next read or sweep tries again.
  Gotenberg's 400/413/422 are the file's; a 500 (LibreOffice failed) is tried
  once more and counts as the file's only while Gotenberg's `/health` reports
  it up.
- **Processing** reads the original for its own parse, except for the formats
  converted by LibreOffice that have no parser of their own (`.doc`, `.ppt`,
  OpenDocument …; `.xls` is read as a workbook; `document_contract.md` "Formats"). For those it
  parses the PDF representation. `PreviewEngine.pdf_key` produces the PDF
  first when it is missing, so the pages of their blocks are pages of the PDF
  the viewer draws.

### Gotenberg

A Gotenberg container (`gotenberg/gotenberg:8`, LibreOffice + Chromium behind
one HTTP API) runs beside the worker (`deployment/compose.yml`,
`BOMESH_GOTENBERG_URL`). It is internal only: it binds to the compose network
(loopback on a laptop), receives the file bytes in the request (never a URL),
and runs Chromium with JavaScript disabled and every network request except
its own temporary files denied (`--chromium-deny-list`), so a converted HTML
or e-mail file can neither run code nor reach anything; LibreOffice may fetch
nothing either (`--libreoffice-deny-list`), opens documents with macros
disabled, and starts with the container. Webhooks are off; its API timeout
(130 s) outlasts the engine's 120 s bound, so a slow file ends as the engine's
recorded `TIMEOUT`, never as a Gotenberg error. Converting a short DOCX takes
0.1–0.5 s warm (≈ 2–4 s for the first conversion after an idle period or a
container start).

### Read path

`GetItemPreview` reads the Item and the revision (one query), classifies the
format, and answers from the manifest: as-is representations are READY at
once with the original's signed URL; produced ones are READY with the
representation's signed URL, UNAVAILABLE with the recorded reason, or
PREPARING. URLs are signed at the start of a `BOMESH_PREVIEW_URL_SECONDS`
window (default 300) and valid for two, so repeated opens return the same URL
and the browser cache serves the immutable object. The read never converts and
never reads the search index.

## API (public)

- `GetItemPreview` (`GET …/items/{item}/preview`, singleton; `items.get`,
  reviewer exception; `?revision=` for an older revision) → `ItemPreview`:
  `state` (READY, PREPARING, UNAVAILABLE), `unavailableReason`
  (FORMAT_NOT_SUPPORTED, TOO_LARGE, CONVERSION_FAILED), `representation`
  (`kind`, `uri`, `mimeType`, `sizeBytes`, `expireTime`, and per kind
  `textFormat`, `language`, `mediaType`, `truncated`) and `original` (the
  file for download). Errors: a COLLECTION → `INVALID_ARGUMENT`; a DELETED
  item → `NOT_FOUND`; content not uploaded yet → `FAILED_PRECONDITION` reason
  `CONTENT_NOT_AVAILABLE`; an unknown `revision` → `NOT_FOUND`.
- `GetItemContent` (`GET …/items/{item}/content`) reads the processed
  document as blocks; it is the Content view's API, not the preview engine's
  (see "Content view: evidence, not the file").
- `GetItem ?alt=media` answers 302 to the signed original of the current
  revision.

Object storage must allow cross-origin `GET` with `Range` from the web origin
and expose `Content-Range`, `Accept-Ranges`, `Content-Length` and `ETag`:
`rustfs-init` applies that rule locally (`RUSTFS_CORS_ALLOWED_ORIGINS`); an
S3/R2 bucket needs the same.

## Cover on the Item

A list must show what a document looks like without reading each document's
content, so every Item carries `document.cover` and every Home entry `cover`
(`DocumentCover`): the shape of the current revision's first page (`kind`)
and either a small image of it (`imageUri`, `widthPixels`, `heightPixels`) or
its first text (`title`, `lines[]`, `cells[][]`). A grid of N documents costs
**one list call** and at most one signed URL per document, not N+1 preview
reads: `GetItemPreview` is for opening a document, not for drawing its card.
Absent means not produced yet or nothing to show; the client then draws the
format's typed tile. `imageUri` wins over the text when present.

The engine produces the cover in the same content-arrival job, after the
representation:

| Source | `kind` | Cover |
| --- | --- | --- |
| a PDF representation (PDF, and every format converted to PDF) | `PAGE` (`SLIDE` for presentations) | page 1 rendered (pypdfium2) to a WebP ≤ 480 px wide |
| PNG, JPEG, WebP, GIF and converted pictures | `IMAGE` | the picture scaled to ≤ 480 px wide |
| XLSX, CSV, TSV | `SHEET` | the first sheet's name and top-left 6 × 5 cells |
| TXT, Markdown, code | `TEXT` | the title (first `#` heading) and first lines |
| anything else, or no representation yet | — | none: the typed tile |

Lines share 480 characters, so a text cover stays well under 1 KB; an image
above 40 KB is encoded again at a lower quality. A cover is bounded: sources
over 50 MB get none, production stops after 30 s, only page 1 is read. A file
that cannot be read is recorded as `none` and not retried until its content
changes. Requests never produce covers.

**Stored.** `item_revisions.exports.cover` of the revision the Item shows (a
few hundred bytes): `version`, `kind`, and `stored`/`width`/`height` of the
image or `title`/`lines`/`cells`. The image is
`workspaces/{code}/files/{content_id}/thumbnail-v{version}`, immutable and stored with
`Cache-Control: private, max-age=31536000, immutable`. Because it lives on the
immutable revision, a new revision simply has no cover until it is produced
(no `source` to compare); a cover of an older producer `version` (1: drawn
from the original before representations existed) is shown until the sweep
produces it again. Writing a cover never changes `updateTime` or `etag`.

**Read.** List, Search, GetItem and Home project `cover` from the Item row
itself (the read-only `Item.cover` view of the current revision's
`exports.cover`): no extra query, one presign per document with an image. Its URL is signed at the
start of a `BOMESH_PREVIEW_COVER_URL_SECONDS` window (default one hour) and
valid for two, so every list in the window returns the same URL and the
browser reuses its cached image.

**No page count is exposed.** It would have to be derived per document and it
is not a fact anyone acts on. A viewer with the file open numbers its own
pages.

## Citations open in the Original

A citation, a search hit or a found-source card is evidence. It opens where a
person reads the document anyway — its Original preview — with the cited
passage marked: one rendering of a document, so what is cited is what the
file shows, in every format.

- **Highlights.** A `Citation` (and a `ContentReference`) carries
  `highlights`: the regions of the revision's representation its blocks
  occupy, in document order. A PDF representation gets one Highlight per page
  (`pageNumber`, one box per block, fractions of the page from its top-left
  corner); a TABLE representation gets one per block (`sheet`, `cellRange` in
  A1 notation). TEXT representations (Markdown, plain text, data) get none:
  the viewer marks `quote`, which is the text itself.
- **Located at indexing, never in the browser.** The chunker writes
  `highlights` beside `refs`, `quote` and `location`, from what processing
  already has:
  - *The parsed bytes are the shown bytes* (PDF documents; formats processed
    as their PDF representation): every block's Docling provenance (page and
    box) is the box on the shown page. A table chunk names only its rows: a
    ruled table read from a typed PDF keeps every cell's box, so the rows
    held are the union of their cells' boxes; a table without cell boxes has
    each row found by its cells' text inside the table's box and marked as a
    band, across the table, from its first line down to where the next row
    starts (a cell runs on below the words matched); a row not found falls
    back to the table's box.
  - *Spreadsheets* (xlsx, xlsm, xls, csv, tsv): Docling's table box is the
    table's place on the sheet, and the chunk knows which body rows it holds
    (one line per row, `table_text`), so the range is those rows across the
    table's columns; a text block (a title, a note) is its own cell. CSV and
    TSV are one sheet from A1.
  - *Formats parsed as themselves but shown as a PDF* (DOCX, PPTX, HTML …):
    Docling gives no page geometry for the LibreOffice/Chromium layout, so
    each block's text is found, in reading order, in the text layer of the
    stored PDF representation (letters, digits and marks only, so spacing,
    punctuation and list numbering do not matter; a glyph LibreOffice draws
    from a fallback font after the rest of its line, such as `ả` or `ị`, is
    read back in its place on the line); a block found gets its box,
    a block not found keeps its neighbour's page without a box. A table's rows
    are found the same way and marked as bands, as above.
  A Highlight is exact or absent, never a guess: a page without boxes opens
  the page, no Highlight shows the quote only.
- **Bound to the representation.** `highlights` index the representation of
  `REPRESENTATION_VERSION`; that version is part of the processing version
  (`database_architecture.md`, `item_index_states.processed_version`), so a new representation
  makes every document OUTDATED and the next run locates its blocks again
  (no parsing, the contexts are reused). A stored citation keeps the regions
  it was made with.
- **Opening a citation.** The `Citation` already carries `quote` and
  `location`, shown at once. The surface reads GetItemPreview of `revision`
  (`?revision=`), opens the PDF at the first Highlight's page and draws its
  boxes over the page, or scrolls the grid to the first `cellRange` of its
  `sheet` and tints those cells; the TEXT viewer marks `quote`. Several
  citations of one document step through their highlights in the same view.
  A citation of an older revision opens that revision's Original.

## Content view: artifact revisions

`GetItemContent` (`GET …/items/{item}/content`, singleton; `items.get`,
reviewer exception) returns a Structured Document (`document_contract.md`
"Structured Document") as BoMesh blocks, `ContentNode` — HEADING, PARAGRAPH
(`runs` with bold, italic, safe links), LIST / LIST_ITEM, TABLE (rows with
`rowSpan` / `colSpan`, at most 1,000 rows), CODE, FORMULA, PICTURE (a signed
picture URL) — a projection, never Docling's schema. A window is `pageSize`
blocks (default 40, at most 200) of the reading flow: `anchor` opens a window
around a block, page tokens step to the window before or after, `view:
OUTLINE` lists the headings.

- **Who reads it.** An artifact revision that is a binary document (PDF,
  Office) is shown this way: its snapshot's `structureVersion` (parsed on the
  revision's first read) is read with GetItemContent under the artifact's
  read rule, drawn by the DocumentRenderer, and compared block by block
  between revisions. Markdown and text revisions show their `text`; any other
  file is downloaded from `contentUri`. Knowledge documents are read in their
  Original.
- **Exactly one version.** `revision` and `version` pin a Structured
  Document; processing again with another parse profile adds a version and
  keeps the old one; `CONTENT_VERSION_UNAVAILABLE` only once that object is
  gone, `CONTENT_NOT_PROCESSED` before the first parse.
- **Cost.** One PostgreSQL read (authorization, revision,
  `exports.structure`) and at most one object read; the API keeps parsed
  views in a per-process LRU keyed by content and version (immutable, never
  invalidated). It never reads the index, downloads the original, parses or
  converts. Picture URLs follow the `BOMESH_PREVIEW_URL_SECONDS` signing
  window; the response is `Cache-Control: private, no-cache` with an `ETag`.
- **DocumentRenderer.** Headings, paragraphs with runs, lists, tables with
  merged cells, code, formulas and lazily loaded pictures. Content is
  untrusted: text is rendered as text, never as HTML; links keep only `http`,
  `https` and `mailto`; pictures a document only links to are never fetched.

## Reading (web)

- One document surface reads `GetItemPreview` and switches on
  `representation.kind` only: six viewers, each given a URL. It never looks
  at file names, MIME types or encodings, never parses CSV or decodes text
  encodings, and never reads `Range`s itself except through pdf.js.
- **Processing never hides the file.** Its state is a quiet note above the
  file (with the run action for editors); only Ask, search and citations wait
  for it.
- `PREPARING`: the cover as page 1 and "Preparing the preview…", polling every
  two seconds. `UNAVAILABLE`: why, and Download.
- **Marks.** `?q=` marks its matches in the representation (the PDF text
  layer, the text, the grid's cells); `?page=` opens a page. A citation's
  `highlights` are drawn over the PDF pages (boxes) or the grid (cell
  ranges); a TEXT representation marks the citation's `quote`.
- **Performance.**
  - Each viewer is its own lazy chunk; pdf.js (and its worker) loads only when
    a PDF opens.
  - pdf.js reads in 1 MiB ranges and reads files under 4 MiB in one request;
    every page is a box of its exact size from the start, and only pages
    within one screen of the view hold a canvas and a text layer, drawn one
    page at a time (the page in view first, yielding between pages, so no
    drawing blocks input for long) at the device pixel ratio capped at 2, and
    released when far.
  - TEXT, TABLE and ARCHIVE payloads are bounded by the engine (1 MiB of
    text, 10,000 rows per sheet, 10,000 entries), so the client never streams
    or truncates; long grids render with CSS `content-visibility: auto` on
    row groups of 100.
  - Opening is cover-first: the Item's `cover` is page 1 the moment the view
    mounts, replaced when the first page is drawn.
  - Representation URLs are stable within their signing window and the
    objects immutable, so reopening a document is served from the browser
    cache.
