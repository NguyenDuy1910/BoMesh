# Document viewer: one preview engine, six representations

Status: target design. Methods and fields: `openapi.yaml` (Knowledge),
`api_design.md` §5. Background and measurements:
[`docs/universal-file-preview.md`](../../docs/universal-file-preview.md).

## Problem

People open a document to look at it: from Knowledge, My files, a review, a
citation in chat. Two rules follow from the business:

1. **Viewing never depends on processing.** Processing (an Ingestion Run)
   makes a document searchable, classified and citable; it never decides
   whether a person can see the file. An upload in My files, a contribution
   under review and a document whose run failed are all viewable.
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
representation) or a **producer**. Adding a format is adding a row.

| Representation | Formats | Producer |
| --- | --- | --- |
| PDF | pdf | as is |
| PDF | doc, docx, docm, dot, dotx, dotm, odt, ott, rtf, wpd, ppt, pptx, pptm, pps, ppsx, pot, potx, odp, otp, xls, ods, ots, vsd, vsdx, odg, pub | Gotenberg LibreOffice → PDF |
| PDF | html, htm, xhtml, mht, eml | Gotenberg Chromium → PDF (e-mail rendered to HTML first: headers, body, attachment names) |
| IMAGE | png, jpg, jpeg, gif, webp, avif, svg | as is |
| IMAGE | bmp, tif, tiff, ico | Pillow → WebP (≤ 4096 px on the long side) |
| TABLE | csv, tsv, xlsx, xlsm | CSV reader / openpyxl (read-only, values) |
| TEXT | md, markdown (MARKDOWN); txt, log, json, jsonl, yaml, yml, xml, toml, ini, cfg, conf, env, sql, graphql, proto, and source code (py, js, mjs, ts, tsx, jsx, java, kt, go, rs, c, h, cc, cpp, hpp, cs, rb, php, swift, scala, sh, bash, zsh, ps1, bat, r, lua, pl, dart, vue, svelte, css, scss, less, dockerfile, makefile), any other `text/*` (PLAIN) | decode (charset detection) → UTF-8; JSON pretty-printed |
| MEDIA | mp4, m4v, webm, ogv (VIDEO); mp3, m4a, aac, wav, oga, ogg, opus, flac (AUDIO) | as is |
| ARCHIVE | zip | entry list from the central directory |

`xls` and `ods` have no maintained reader without a native office library, so
they become PDF like the other legacy Office formats; `xlsx`, `xlsm`, `csv`
and `tsv` become a TABLE, which keeps a wide sheet usable where print
pagination would split it.

### Representation payloads and bounds

- **PDF** — the PDF itself.
- **IMAGE** — the picture itself (or its WebP).
- **TEXT** — UTF-8, at most 1 MiB; longer files keep the first 1 MiB (cut on
  a character boundary) with `truncated: true`. JSON that parses is
  pretty-printed (2 spaces).
- **TABLE** — `{"schema": 1, "sheets": [{"name", "rows": [[cell …] …],
  "totalRows", "totalColumns", "truncated"}]}`; cells are the displayed
  values as strings (dates ISO 8601, numbers as stored). Bounds: 50 sheets,
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
  notifies `bomesh_cover` when a document's content becomes available or its
  current content changes (upload, new revision, approval, rollback). The
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
- **Stored.** The representation object lives at
  `tenants/{tenant}/items/{item}/previews/rep-v1/{sha256(storage_key)}.{ext}`,
  immutable, `Cache-Control: private, max-age=31536000, immutable`. The
  revision records it in `item_revisions.exports.representation`
  (`version`, `source` = the `storage_key` it shows, `kind`, `key` — absent
  when the original is the representation —, `mime_type`, `size_bytes`,
  `text_format`, `language`, `media_type`, `truncated`); the record is written
  only if the revision still holds that `source` (a replaced file never gets a
  stale representation) and never changes the Item's `updateTime` or etag.
- **Failures.** A failure that is a property of the file is recorded as
  `item_revisions.exports.representation_failure` (`source`, `reason`:
  `UNREADABLE`, `CONVERSION_ERROR`, `TIMEOUT`, `EMPTY`, `TOO_LARGE`) and
  answered `UNAVAILABLE` (`TOO_LARGE`, else `CONVERSION_FAILED`) until the
  content changes. `FORMAT_NOT_SUPPORTED` is recorded too, so the sweep stops
  asking, but is ignored once the registry gains the format. An
  infrastructure failure (storage, database, Gotenberg unreachable or
  answering 503) records nothing: the next read or sweep tries again.
  Gotenberg's 400/413/422 are the file's; a 500 (LibreOffice failed) is tried
  once more and counts as the file's only while Gotenberg's `/health` reports
  it up.
- **Processing** does not produce anything for viewing; it reads the same
  original for its own parse.

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
- Passages (`GET …/items/{item}/passages[/{passage}]`, passage ID = chunk ID)
  are the citation targets, of `document.indexedRevision`: `pageNumber`,
  `boundingBoxes` (normalized 0–1, top-left origin) and `text`. They exist
  only for processed documents.
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

**Stored.** `items.metadata.cover` (a few hundred bytes): `version`, `source`
(the `storage_key` it shows), `kind`, and `key`/`width`/`height` of the image
or `title`/`lines`/`cells`. The image is
`previews/cover-v{version}/{sha256(storage_key)}.webp` under the Item's prefix,
immutable and stored with `Cache-Control: private, max-age=31536000,
immutable`. A cover whose `source` is not the Item's `storage_key` is ignored
by reads and produced again; a cover of an older producer `version` (1: drawn
from the original before representations existed) is shown until the sweep
produces it again. A revision change also drops it from the metadata (derived
metadata), and writing a cover never changes `updateTime` or `etag`.

**Read.** List, Search, GetItem and Home project `cover` from the loaded row:
no query, one presign per document with an image. Its URL is signed at the
start of a `BOMESH_PREVIEW_COVER_URL_SECONDS` window (default one hour) and
valid for two, so every list in the window returns the same URL and the
browser reuses its cached image.

**No page count is exposed.** It would have to be derived per document and it
is not a fact anyone acts on. A viewer with the file open numbers its own
pages.

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
- **Highlights.** Citations open
  `/doc/{item}?passage=<passage>&from=<conversation>`; each passage is
  resolved through `GetPassage`. On a PDF its `boundingBoxes` are drawn over
  the cited page when present; otherwise, and on TEXT and TABLE, the
  passage's text is found in the representation (the PDF text layer, the text,
  the grid's cells) and marked. `?q=` marks matches the same way. A passage
  that no longer resolves is reported, not guessed. `?page=` opens a page.
- **Performance.**
  - Each viewer is its own lazy chunk; pdf.js (and its worker) loads only when
    a PDF opens.
  - pdf.js reads in 1 MiB ranges and reads files under 4 MiB in one request;
    every page is a box of its exact size from the start, and only pages
    within two screens hold a canvas and a text layer, drawn at the device
    pixel ratio and released when far.
  - TEXT, TABLE and ARCHIVE payloads are bounded by the engine (1 MiB of
    text, 10,000 rows per sheet, 10,000 entries), so the client never streams
    or truncates; long grids render with CSS `content-visibility: auto` on
    row groups of 100.
  - Opening is cover-first: the Item's `cover` is page 1 the moment the view
    mounts, replaced when the first page is drawn.
  - Representation URLs are stable within their signing window and the
    objects immutable, so reopening a document is served from the browser
    cache.
