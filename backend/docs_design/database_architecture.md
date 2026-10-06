# BoMesh database architecture

**Status:** reviewed against `backend/bomesh/db/models.py` and migrations  
**Canonical schema design:** [design.dbml](design.dbml)  
**Scope:** durable PostgreSQL state only

PostgreSQL owns domain state, authorization, lifecycle, lineage, and audit
records. S3/R2 owns raw bytes and immutable artifact objects. Qdrant owns
retrieval representation (chunks, embeddings, and BM25 fields). Neither object
storage nor Qdrant is a source of truth for domain state.

## Design decisions

### Database operation lifecycle

Every application database operation uses `bomesh.db.engine.transaction_scope`:

```text
transaction_scope(session_factory)
  -> create session and begin transaction
  -> perform one atomic database operation
  -> commit on success
     or rollback on failure
  -> close session and release connection
```

This rule applies to reads and writes. Services do not use bare
`session_factory()` sessions, manual commit/rollback blocks, or transactions
that span object storage, connector, index, model, or other long-running work.
External work runs between separate database operation scopes.
Internal `begin_nested()` calls are savepoints inside the current
`transaction_scope`, not alternate session lifecycles.

PostgreSQL advisory-lock workflows use `advisory_lock_scope` as the one
intentional exception: it owns one autocommit connection for the lock lifetime,
performs no application transaction on that connection, and releases the lock
before releasing the connection. Atomic state changes still use
`transaction_scope` inside the lock.

### Relationship keys

`user_id` means **who**: owner, creator, requester, approver, actor, or memory
subject. It is not a universal join key.

| Domain | Owning relationship | Intentional user reference |
|---|---|---|
| Conversation | `conversation_id -> messages` | `owner_user_id`; `created_by_session_id` records the creating user session |
| Knowledge | `item_id -> citations`, `item_id -> artifact_revisions` | `created_by_user_id` only |
| Ingestion | `integration_connection_id -> ingestion_sources -> external_resources -> item_id`; `ingestion_runs -> ingestion_run_items -> item_id` | creator/owner fields only |
| Authorization | `principal -> role -> scope` | `user_id` or `group_id` exclusive arc |
| Memory | `tenant_id + user_id` | Both are domain keys, not convenience copies |

Messages, citations, and external resources do not carry redundant `user_id`
or `tenant_id`. They inherit security context through their owning resource.

### Tenant boundary

`tenant_id` identifies workspace/organization isolation. It remains on major
root resources where it materially supports authorization and access paths:

- `access_sessions` — active authentication context
- `items` — canonical knowledge ownership
- `conversations` — chat isolation
- `integration_connections` — connector ownership
- `memories` — tenant plus user memory scope
- `audit_logs` — tenant/platform audit partition

Child resources use their real parent relationship. Intentional denormalized
tenant keys remain only where they protect a boundary or support a hot query:
`sandbox_sessions` and `item_uploads` are examples. They require service
validation against their parent resource.

### Identity and sessions

The model keeps three separate concepts:

1. `users`: durable human identity, including optional local credentials.
2. `auth_identities`: external provider subject mapping (`issuer + subject`).
3. `access_sessions`: revocable authentication context for one active tenant.

Every active session belongs to a User and to a tenant in which that User has
an active membership; there is no anonymous or public-tenant session. A
conversation's `owner_user_id` is required while it is active and equals the
user of its `created_by_session_id`. Messages remain attached only to
`conversation_id`.

`access_sessions.kind` keeps `guest` only as a retired historical value: those
rows are retained for lineage, check `access_session_guest_is_retired`
(`kind = 'user' OR status <> 'active'`) keeps them inactive, and the
validation trigger rejects any new non-user row.

### Item tree

`items` is the canonical resource model for `collection` and `document`.
Collections may contain collections or documents. Documents cannot become
roots, and a document cannot parent a collection. Parentage, same-tenant
ownership, and cycle checks are enforced by database constraints/triggers and
service validation.

`status` describes raw resource lifecycle. `index_status` is the Document's
one processing state (`pending | processing | ready | failed | unsupported`)
and `processed_version` names the processing configuration its current index
was built with. A document can be available while processing is pending or
failed; clients must not collapse these states.

The HTTP contract maps this storage model to public Document states
`pending_content | available | failed` and to a separate
`processing.state`: `pending | processing | ready | failed | outdated |
unsupported`, where `outdated` is `index_status = ready` with a
`processed_version` that differs from `processing_version()` of the current
configuration (parser, chunker, embedding model, index schema,
contextualization model). The private `item_uploads.status` is never exposed.

### Knowledge inventory vs ingestion execution

```text
upload / archive upload / source sync  ->  Item (index_status = pending)
Ingestion Run (manual | api | scheduled) -> ingestion_run_items -> processed index
```

Adding data changes only the inventory: an upload stores its bytes and
registers a pending Document; a Source sync stores originals and registers,
updates (back to pending when the provider version changed) or tombstones
Documents. Neither parses, contextualizes, embeds, indexes, or starts a
processing workflow.

Processing happens only in an Ingestion Run. `ingestion_runs` is execution
history; `ingestion_run_items` records each Document's participation (status,
phases with timings, user-safe error, chunk count). The Item keeps its single
identity across any number of runs: re-indexing after a model change is a new
run over the same Items, never a new upload. The run's Documents are fixed
when it is created (one `INSERT ... SELECT`), so uploads that arrive while it
executes wait for a later run. An archive is the one exception that grows a
run: processing it unpacks its members into new pending Documents, which are
appended to the same run.

`items.index_status` stays the one source of truth for a Document's processing
state; run items are history, and the Document's latest run item supplies the
error and run shown next to it. Temporal orchestrates runs and keeps no state
the product reads; `ingestion_run_items` replaces the former per-upload
`items.metadata.ingestion` record and Temporal-visibility listings.

### Provider-neutral ingestion

```text
IntegrationConnection
  -> IngestionSource
      -> ExternalResource
          -> Item
```

Provider-specific identity stays in `connector_key`, provider ID columns, and
connector-owned JSON fields. Core tables do not use names such as `drive_file`
or `notion_page`. A connector Item carries its stored original
(`storage_key`) and provider identity (`metadata.source`), so processing reads
every Document the same way, whatever its origin.

`external_resources.(ingestion_source_id, external_id)` is the stable provider
identity. Tombstoning a resource does not free that identity; rediscovery
reactivates the row and preserves its canonical Item ID. `ingestion_sources`
keeps the latest sync's outcome (`last_synced_at`, `last_sync_status`,
`last_sync_error`, `last_sync_summary`); there is no per-sync history table.

### Authorization

`tenant_memberships` answers only whether a user belongs to a tenant.
`role_assignments` answers who has which role at platform, tenant, or
collection scope. Workspace access requires both an active membership and
tenant-scope role assignments; platform roles are a separate scope. Tenants
have no public visibility or baseline public role. `groups` are principals,
not a second authorization system. Role scope, tenant ownership, principal
membership, and deleted-row behavior are validated by constraints/triggers and
the authorization service.

### Citations

```text
Document Item -> chunk_id -> page/section/span geometry
```

`citations` is provider-neutral canonical evidence. Qdrant stores retrieval
payloads; PostgreSQL stores durable navigation geometry. Citation lookup always
re-checks Item permission before returning a viewer target.

### Conversation and memory

`conversations -> messages` is the only message ownership path. Message order
uses `(conversation_id, sequence_number)`; message identity is UUID.

Memory intentionally carries both `tenant_id` and `user_id`: memory belongs to
a person inside a workspace. `conversation_id` and `source_message_id` are
optional provenance links. Expiry/status controls lifecycle; memory deletion is
a tombstone, not physical removal.

## ID policy

All persisted entity IDs use PostgreSQL native `uuid`, never `varchar(36)`.

Current runtime and historical migrations still generate UUIDv4 values
(`uuid4()`/`gen_random_uuid()`). UUIDv7 is the preferred direction for new
major entities because it improves index locality while remaining safe for
distributed API/worker generation. Do not silently rewrite existing IDs or mix
multiple generators in one migration.

UUIDv7 adoption requires one shared generator at the composition boundary,
worker support, migration defaults, and verification across PostgreSQL,
Temporal, object storage, and Qdrant. Until that work is scheduled, keep UUID
type and stable application-generated IDs; do not add string IDs or sequences
just to approximate UUIDv7.

Use domain-native types for non-entity values: `BIGINT` for message sequence,
`INT` for artifact revisions/positions, and bounded strings for permission,
role, connector, and status codes.

## Index review

Indexes follow known access paths, not every foreign key:

- conversations by tenant/owner or creator session and recency
- items by tenant/status and parent
- citations by Item/chunk and live lifecycle
- memories by tenant/user/status and expiry-related reads
- connections by tenant/connector/status and owner
- sources by connection/status and target collection
- external resources by source/provider identity and last-seen time
- ingestion runs by tenant/recency and tenant/status; run items by run/status,
  run/batch (the planner), and Item/recency (a Document's latest run)
- messages by conversation/sequence
- authorization grants by principal/scope/role
- audit logs by tenant/action/time and actor/session

Partial or composite uniqueness is used where lifecycle state allows a record
to be tombstoned and later recreated. Reuse existing indexes before adding a
new one for a speculative query.

## Reviewed corrections

- `users.username` uniqueness is case-insensitive and optional. SQLAlchemy
  metadata now matches migration `uq_users_username` on `lower(username)`.
- Local upload ownership is authenticated-user scoped; ownership always comes
  from the active User.
- Migration `backend/migrations/20261003_remove_guest_access.sql` removes
  anonymous and public-workspace access without hard deletes: it revokes every
  active guest session, tombstones guest-owned conversations
  (`status = 'deleted'`) and adds `conversation_owner_required`, tombstones the
  platform `guest` role with its role permissions and assignments, and drops
  tenant `visibility`, `public_access_role_id`, and their public-access
  check/trigger.
- Product rename BoThesis → BoMesh. Migration
  `backend/migrations/20261003_rename_bomesh.sql` renames the
  `bothesis_validate_*` trigger functions to `bomesh_validate_*` (triggers bind
  by function identity, so they keep firing). The deployment owns the rest:
  the database and its owning role are `bomesh` (an existing cluster renames
  them in place with `ALTER DATABASE … RENAME` / `ALTER ROLE … RENAME`, the
  bootstrap superuser through a temporary superuser), the object-storage
  bucket and the Qdrant collection are `bomesh` (MinIO copies with
  `mc mirror --preserve`; Qdrant has no rename, so it recovers a snapshot of the
  old collection under the new name), and stored document renditions carry
  `application/vnd.bomesh.document+json`. Earlier migrations keep their
  original `bothesis_*` names because they describe history.
- Persisted identities keep the original namespace through any rename.
  Upload, personal/artifact collection and external-resource IDs are uuid5
  values of `bothesis:{kind}:…`, and connection credentials are AES-GCM sealed
  with `bothesis:plugin-credential:{id}` as associated data; all are derived
  from `bomesh.identity.PERSISTED_IDENTITY_NAMESPACE`
  and pinned by `tests/bomesh/test_persisted_identity.py`. The rename first
  changed them, which gave every user a new, empty personal collection and left
  stored credentials undecryptable; restoring the namespace re-attached the
  original rows, and the one duplicate personal collection created meanwhile
  was tombstoned. Temporal queue, workflow and activity names did change: no
  schedule or running workflow referenced the old names.
- Migration `backend/migrations/20261004_ingestion_runs.sql` separates the
  inventory from processing: it creates `ingestion_runs` and
  `ingestion_run_items`, adds `items.processed_version` (backfilled from
  `metadata.processing` in the `processing_version()` format; a missing part
  leaves it NULL, which reads as outdated), returns Documents stuck in
  `processing` to `pending` and drops the superseded `metadata.ingestion`
  records, replaces `ingestion_sources.last_ingested_at/last_indexed_at` with
  the `last_sync_*` columns, renames `item.manage` to `knowledge.manage` in
  place (role rows and tombstones keep their history), and adds
  `ingestion.read`, `ingestion.run`, `ingestion.manage` to every role that
  could run or monitor ingestion before (`source.manage` tenant roles;
  `collection.update` roles get `ingestion.run`).
- `role_permissions` and citations retain tombstones and reactivate stable
  identities instead of creating duplicate rows.
- Design documentation stays under `backend/docs_design`; this document and
  `design.dbml` are the database design references.

## Deferred, justified work

1. Add UUIDv7 only with a shared generator and migration plan; no blind rewrite.
2. Add cross-row database guards for any new denormalized tenant field before
   exposing a write path.
3. Replace remaining broad JSON/dict payloads only when a stable consumer
   contract exists; keep provider-specific state isolated.
4. Add focused PostgreSQL tests for tombstone reactivation, tenant mismatch,
   conversation ownership, and authorization scope invariants.

These are bounded follow-ups, not new tables or infrastructure layers.
