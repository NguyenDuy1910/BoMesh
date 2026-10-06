# BoMesh connectors and content processing

This package owns two separate things:

- **Source connectors** (`confluence`, `google_drive`, `pipeline.py`): discover
  what changed in a source, map hierarchy and ACLs, and store each changed
  original in object storage (`originals.py`). They never parse content.
- **Content processing** (`file`, `processing`): Docling conversion, normalized
  content, source-aware chunking and provenance, used only by an Ingestion Run.

Contextualization, embedding, private payload projection, and indexed-content
operations belong to `bomesh.document_index`.

## Canonical flow

A sync only changes the knowledge inventory; processing is an Ingestion Run:

```text
source → connector → stored original + DocumentItem (no content)
              ↓
   SourceSyncService → pending Document (items.storage_key)

Ingestion Run → stored original → Docling → DocumentItem + Chunk[]
              ↓
   ItemIngestionService → ItemIndex → private Qdrant adapter
```

The `bomesh.services.preview` service may derive bounded WebP presentation
assets from the same durable original during ingestion. Preview generation is
independent of Docling content extraction and never enters canonical chunks or
Qdrant payloads.

Images are not knowledge in this phase: no upload, archive member or source
attachment that is an image file is ingested (see `FinxFileExtensions`).
Pictures inside a document stay part of that document's content.

PDFs are read from their own text layer (`processing/pdf_text.py`, PDFium): no
model call and no page images, about a millisecond per page. Lines become
paragraphs and headings (by spacing and type size) with page and box
provenance for citations; running headers, footers and page numbers are
dropped. A scanned page (an image and fewer than 20 characters of text) is
transcribed by Docling's VLM pipeline with the configured vision model
(`BOMESH_DOCLING_MODEL` on OpenRouter, Markdown response, ~5 s/page) and
spliced in at its page number; without that model a fully scanned PDF fails
with "the file has no text to index". Text inside pictures of typed pages is
not read.

Spreadsheets go through Docling's xlsx backend. Leading rows whose only text
is one cell merged across columns (a sheet title, a notes line) are moved out
of the table as text, so the first real row is the column header the chunker
repeats ("row, column = value").

`ConnectorPipeline` consumes `ItemChange` values and hands Item registrations
and removals to a `ConnectorRegistrationSink`; `SourceSyncService`
(`bomesh.services.source_sync`) is that sink. A Document is registered with its
stored original and is `pending` when it is new or its version, etag or
original changed; an unchanged Document keeps its processing state, and a
version already registered is not downloaded again. A removed Document is
tombstoned with its index content and citations. One change that fails does
not stop the others; checkpoints advance only when the complete scope
succeeds, and registration is idempotent so retries are safe.

## Retrieval projection

The private index payload is a flat projection of `ContextualChunk`. It contains
canonical chunk text, contextual embedding text, a single section path, source
attribution, lightweight citation fields, flattened hierarchy, and
tenant/tombstone governance. Detailed citation spans and normalized visual
geometry live in PostgreSQL and are resolved by stable Item and chunk IDs only
when a user opens a citation.

The canonical `Item` store remains the source of truth for `AccessPolicy`, raw
object references, and provider metadata. Qdrant never receives those complete
objects or raw binary storage details. Retrieval applies tenant, tombstone,
collection scope, source, and hierarchy filters before evidence is returned.

## Uploads

Uploads and connector Documents share one processing core: an Ingestion Run
reads the stored original through the same Docling processor, canonical
chunks, `ItemIngestionService`, and `ItemIndex`; there is no file connector.
An upload only stores the original and registers a pending Document.
Uploads keep their lineage under their destination Collection and never create
an Integration Connection, Integration Credential, Ingestion Source, or
External Resource. Indexed files remain tenant- and collection-permission
filtered.
