# Connectors and indexing

The connector boundary turns external source data into canonical BoMesh
Items. It owns provider-specific behavior so retrieval and the agent operate on
one consistent source and evidence model.

## Current managed sources

| Source | Role |
| --- | --- |
| Managed files | Accepts uploaded files, stores original bytes in S3-compatible storage, and processes supported content through Docling. |
| Confluence | Discovers and normalizes page and attachment content, hierarchy, and source permissions. |

Additional providers belong behind the same connector protocol; provider types
must not leak into `knowledge` or `agent` behavior.

## Canonical hierarchy

Every source entity is an Item:

```text
CollectionItem
└── DocumentItem
    ├── DocumentItem
    └── FileItem
```

`parent_item_id` represents source containment. References between documents do
not modify that hierarchy. Binary-backed Items persist only object metadata and
a `storage_key`; they never store raw bytes in PostgreSQL.

## Two pipelines: adding and processing

Adding data and processing it are separate. A connector only adds: it never
parses, chunks or indexes.

```text
add (upload, archive upload, Source sync)
    connector discovery + normalization (sync only)
        ↓
    original bytes → object storage (storage_key)
        ↓
    Item registered or updated, processing state pending

process (Ingestion Run: manual, API, scheduled)
    stored original → Docling conversion → provenance-aware Chunk[]
        ↓
    structural context + optional semantic context
        ↓
    dense embedding + Qdrant BM25 document
        ↓
    deterministic Qdrant point replacement → ready (processed_version)
```

Because every Document has a stored original, processing reads uploads and
connector Documents the same way; provider identity travels on the Item
(`metadata.source`) for citations and links.

`contextual_text` is the retrieval representation. Structural context is always
available. Optional semantic contextualization adds a short chunk-specific
description through the configured model and falls back safely to structural
context when unavailable. The original `chunk_text` remains the evidence text.

Qdrant executes dense and BM25 searches for every query of a search in one
request and combines all candidates with native reciprocal-rank fusion. The
`knowledge` package applies tenant, source, tombstone, and principal filters
before one LLM rerank, which acts as a relevance gate, and evidence projection.
See `backend/docs_design/conversation_loop.md`.

## Access control

Connector credentials and reader permissions serve different purposes:

```text
encrypted ConnectorCredential → lets BoMesh read a provider
Item allowed/denied principals → lets a user retrieve source evidence
```

Connectors normalize source ACLs into principal tokens. The Item ACL is
projected into Qdrant for pre-retrieval filtering and is defensively checked
again before evidence reaches the agent.

## Ingestion semantics

Documents have two independent states:

```text
object storage write succeeds
    ↓
Item / ItemUpload resource is available ── direct, access-checked read
    ↓                                       (the agent reads attachments here)
processing state pending
    ↓ only an Ingestion Run
Docling → chunks → ItemIndex → ready (semantic retrieval)
```

`items.status` describes the durable resource lifecycle. Documents additionally
carry `items.index_status`, their one processing state, and
`items.processed_version`. A parsing or indexing failure therefore does not make
an already-stored original file unavailable, and a ready Document whose
processing configuration changed shows as outdated until a run re-processes it.

- An `integration_connections` row is reusable provider configuration and
  optional credentials, not canonical knowledge.
- An `ingestion_sources` row is one independently checkpointed external scope
  targeting a canonical Collection Item; it keeps its latest sync's outcome.
- An `external_resources` row preserves the unique
  `(ingestion_source_id, external_id) -> item_id` mapping plus provider version,
  ETag, source URL, and last-seen state. A sync moves a Document back to
  pending only when that version changed, so unchanged data is never
  reprocessed.
- `checkpoint` advances only after the complete sync succeeds.
- PostgreSQL keeps run history (`ingestion_runs`, `ingestion_run_items`) and the
  latest sync's outcome; Temporal only orchestrates (see [Temporal](temporal.md)).
- Re-processed Documents replace their deterministic Qdrant points. Deleted
  Items are tombstoned and their index content is removed at once; normal reads
  exclude tombstones.

The connector package's implementation notes are kept alongside the code in
[`backend/bomesh/connector/README.md`](../backend/bomesh/connector/README.md).
