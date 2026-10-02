# Enterprise Agent connector pipeline

This package owns source extraction, Docling conversion, normalized content,
source-aware chunking, provenance, ACL mapping, and checkpoint synchronization.
The `ItemIngestionService` coordinates persistence and lifecycle changes;
contextualization, embedding, private payload projection, and indexed-content
operations belong to `bothesis.document_index`.

## Canonical flow

Source adapters produce canonical items and semantic documents cross the index
boundary together with their connector-owned evidence chunks:

```text
raw source → Docling → DocumentItem + Chunk[]
                              ↓
              ItemIngestionService → ItemIndex → private Qdrant adapter
```

The `bothesis.services.preview` service may derive bounded WebP presentation
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
dropped. Scans, text inside pictures and table structure are not read: a PDF
with no text layer fails with "the file has no text to index". The former
remote-vision transcription is kept, commented out, at the end of
`processing/docling.py`.

`ConnectorPipeline` consumes `ItemChange` values and delegates Item writes and
tombstones to `ItemIngestionService`. The service persists Item lineage,
citations, previews, and lifecycle transitions around the single `ItemIndex`
boundary. Checkpoints advance only when the complete scope succeeds, and
derived point IDs are deterministic so retries are safe.

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

Uploads use the same Docling processor, canonical chunks,
`ItemIngestionService`, and `ItemIndex` as scheduled connectors; there is no
file connector. A user's own uploads run that core directly in the API; uploads
into workspace Collections run it through managed (Temporal) ingestion.
Uploads keep their lineage under their destination Collection and never create
an Integration Connection, Integration Credential, Ingestion Source, or
External Resource. Indexed files remain tenant- and collection-permission
filtered.
