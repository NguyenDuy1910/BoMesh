# BoMesh database architecture

**Status:** canonical target; the schema is implemented by
`backend/bomesh/db/models/` (the `/api/v1` API is served on it)  
**Canonical schema design:** [design.dbml](design.dbml)  
**Scope:** durable PostgreSQL state only

PostgreSQL owns domain state, authorization, lifecycle, lineage, and audit
records. S3/R2 owns raw bytes and immutable artifact objects. Qdrant owns
retrieval representation (chunks, embeddings, and BM25 fields). Neither object
storage nor Qdrant is a source of truth for domain state.

## Schema changes

There are no hand-written SQL migration files. `design.dbml` is the schema
design and the `backend/bomesh/db/models/` package implements it, including
the validation triggers (`models/triggers.py`), which are installed through
SQLAlchemy metadata.
Databases are created with `make db-reset` (`Base.metadata.create_all` plus
the system role sync). A data-preserving upgrade script is written only when a
persistent environment must keep its data; it is reviewed with the change and
deleted after it runs.

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
| Conversation | `conversation_id -> messages`, `-> conversation_shares` | `owner_user_id`; `created_by_session_id` records the creating user session |
| Knowledge | `item_id -> item_revisions`, `item_id -> citations`; `item_links`, `reading_list_entries`, `saved_items`, `recent_items`, `space_materials`, `artifact_source_items` reference Items; `item_topics -> topics` | `created_by_user_id`; `owner_user_id` on reading lists; `user_id` on saved/recent items and saved searches |
| Contribution | `contributions.item_id` (candidate) `-> target_item_id` (Collection); `contribution_topics` | contributor and reviewer user fields |
| Ingestion | `integration_connection_id -> ingestion_sources -> external_resources -> item_id`; `ingestion_sources -> ingestion_syncs`; `ingestion_runs -> ingestion_run_items -> item_id` | creator/owner fields only |
| Artifact | `artifacts.item_id` (its Item) `-> item_revisions`, `-> artifact_source_items`, `-> evidence_review_cells` | `owner_user_id` |
| Collaboration | `space_id -> space_materials`, `space_announcements`, `space_events`, `request_types`; `request_id -> request_messages` | requester, assignee, author fields |
| Authorization | `principal -> role -> scope` | `user_id`, `group_id` or `all_members` exclusive arc |
| Operations | `operations.user_id` (own-only) | `request_idempotency.user_id` scopes `requestId` |
| Memory | `tenant_id + user_id` | Both are domain keys, not convenience copies |

Messages, citations, and external resources do not carry redundant `user_id`
or `tenant_id`. They inherit security context through their owning resource.

### Tenant boundary

`tenant_id` identifies workspace/organization isolation. It remains on major
root resources where it materially supports authorization and access paths:

- `items` — canonical knowledge ownership
- `conversations` — chat isolation
- `integration_connections` — connector ownership
- `ingestion_sources` — scope of the client-chosen source ID (trigger-checked
  against its connection and target Collection)
- `spaces`, `topics`, `requests` — collaboration and taxonomy roots
- `memories` — tenant plus user memory scope
- `audit_logs` — tenant/platform audit partition

`access_sessions` carry no tenant. Child resources use their real parent
relationship: space children through `space_id`, syncs through
`ingestion_source_id`, artifacts through their Item. Intentional denormalized
tenant keys remain only where they protect a boundary or support a hot query:
`sandbox_sessions`, `item_uploads` and `saved_searches` are examples. Every
reference that crosses tables between tenant-owned rows is trigger-checked
for the same tenant.

### Identity and sessions

The model keeps three separate concepts:

1. `users`: durable human identity, including optional local credentials.
2. `auth_identities`: external provider subject mapping (`issuer + subject`).
3. `access_sessions`: revocable authentication context of one User.

Sessions carry no tenant and no "active workspace": every workspace is
explicit in the resource name, and each request is authorized against an
active `tenant_memberships` row plus `role_assignments` of that workspace.
Token rotation creates a child session that keeps the User and
authentication method; there is no tenant switch. Per-workspace activity
(`Member.lastActiveTime`) lives on `tenant_memberships.last_active_at`,
account activity on `users.last_active_at`. A conversation's `owner_user_id`
is required and equals the user of its `created_by_session_id`; the
conversation trigger checks the owner's active membership in the
conversation tenant instead of a session tenant. Messages remain attached
only to `conversation_id`. The retired guest session kind and the
`tenant_switch` transition are gone (the database is created empty).

### Item tree

`items` is the canonical resource model for `collection` and `document`
(`item_model.md`). Collections may contain collections or documents. Documents
cannot become roots, and a document cannot parent a collection. Parentage,
same-tenant ownership, `parent_relation` consistency and cycle checks are
enforced by database constraints/triggers and service validation. Roots
(UX "knowledge base") are access boundaries and always store
`inherit_access = false`; each member has one PERSONAL collection.

Document state is independent columns that clients never collapse:

- `status` is content availability only (`pending | ready | failed`;
  Collections `ready`). Deletion is only `deleted_at`: a subtree delete
  stamps one `deleted_at` on the Item and its live descendants, and undelete
  restores exactly that cohort.
- `publication_state` (`published | unpublished`, Documents only) decides
  whether readers without edit rights see the Document.
- `index_status` (`pending | processing | ready | failed | unsupported`) plus
  `processed_version` (the processing configuration the index was built with)
  and `indexed_revision_number` (the revision the chunks belong to).

The API maps these to `state`, `document.contentState`,
`document.publicationState` and `document.indexingState`, where `OUTDATED` is
`index_status = ready` with a `processed_version` that differs from
`processing_version()` of the current configuration (parser, chunker,
embedding model, index schema, contextualization model). The private
`item_uploads.status` is never exposed.

`item_revisions` is the one append-only content store for every Document
(and assistant artifacts); `items.storage_key`, `mime_type` and `size_bytes`
follow the current revision. Source syncs write per-version object keys.
`contributions` holds review of one candidate Document; approval moves or
publishes it, or appends a revision, in one transaction and never starts an
Ingestion Run. `item_links` shows a Document inside another Collection
without changing its canonical parent or granting access. `reading_lists`,
`reading_list_entries`, `saved_items`, `recent_items` and `space_materials`
are references outside the tree; every read re-checks access to the
referenced Item.

Move, publish, unpublish, delete and undelete set `items.payload_dirty_at` in
their transaction; the Qdrant payload update runs after commit and a
scheduled job retries dirty rows, so the index converges without an outbox
table.

### Knowledge inventory vs ingestion execution

```text
upload / archive upload / source sync  ->  Item (index_status = pending) + item_revisions
Ingestion Run (manual | api | schedule | platform_retry) -> ingestion_run_items -> processed index
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
error and run shown next to it. Each run item records the `revision_number`
it started from; a finish whose revision or governing Collection changed
meanwhile writes `pending` and marks the payload dirty. Temporal orchestrates
runs and keeps no state the product reads. The `conversation_artifacts`
system collection and conversation attachments are never selected.

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
reactivates the row and preserves its canonical Item ID. Every sync is one
`ingestion_syncs` row (trigger, state, counts, bounded failures, error); the
latest row is `Source.lastSync` and decides `FAILED`, and a partial unique
index allows one running sync per source. `Source.state` is otherwise
computed from `paused_at` and the connection state, so it cannot drift from
them. `schedule_cron`/`schedule_time_zone` hold the schedule and
`next_sync_at` drives the scheduler scan.
`ingestion_sources.publishing_policy` (`auto_publish | review_first`) decides
whether synced Documents are published directly or enter as contributions.

### Authorization

`tenant_memberships` answers only whether a user belongs to a tenant.
`role_assignments` answers who has which role at platform, tenant,
collection or space scope (`tenant_id`, `item_id`, `space_id`: at most one
set; none = platform). The principal is exactly one of `user_id`, `group_id`
or `all_members` (every active member of the Item's tenant, collection scope
only); space grants take user principals only, because a space member is a
person with a join time. Workspace access requires both an active membership
and tenant-scope role assignments; platform roles are a separate scope.
Tenants have no public visibility or baseline public role. `groups` are
principals, not a second authorization system. Only Collections carry item
grants; effective permission is tenant grants plus grants up the canonical
chain to the first `inherit_access = false` Collection, and for a space,
tenant grants plus that space's grants. Role scope, tenant ownership,
principal membership, and deleted-row behavior are validated by
constraints/triggers and the authorization service. `role_permissions` and
citations retain tombstones and reactivate stable identities instead of
creating duplicate rows.

Permissions are the catalog rows of `permissions`, named
`<collection>.<method>` exactly as `x-permission` (`items.get`,
`spaces.setIamPolicy`), with `scope_types` saying at which scopes a grant
confers them. Predefined roles are `roles` rows without a tenant, synced from
code with their `role_permissions`: `platformAdmin`, `platformOperator`
(platform); `workspaceAdmin`, `workspaceMember` (tenant); `collectionOwner`,
`collectionEditor`, `collectionViewer` (collection); `spaceLead`,
`spaceStaff`, `spaceMember` (space). Custom roles belong to one tenant, may be
bound at its tenant, collection or space scope, and are soft-deleted
(`deleted_at`). `User.platformRole`, `Member.roles`, `SpaceMember.roles`,
`Space.callerRole` and IAM policies (etag = hash of the live bindings) are
computed from `role_assignments`.

### Citations

```text
Document Item -> chunk_id -> page/section/span geometry
```

`citations` is provider-neutral canonical evidence. Qdrant stores retrieval
payloads; PostgreSQL stores durable navigation geometry. Citation lookup always
re-checks Item permission before returning a viewer target. Qdrant filters on
`tenant_id`, the governing `collection_item_id` and `published` are a
pre-filter only; PostgreSQL re-checks every hit, and viewer, passage and
citation reads fetch by `item_id`.

### Conversation and memory

`conversations -> messages` is the only message ownership path. Message order
uses `(conversation_id, sequence_number)`; message identity is UUID. Messages
are the server-owned conversation history the agent reads. A retry or edit
never deletes: it sets the replaced user message and every later message to
`status = 'superseded'` with `superseded_at`, and only `active` messages reach
model context or conversation references. Sequence numbers keep growing, so a
replacement is ordered after what it replaced. `generation_state` is the
outcome of one turn (`completed | interrupted | failed`); the owner's answer
feedback is four columns on the assistant message, because a conversation has
exactly one possible rater. Conversations are soft-deleted with `deleted_at`;
the `scope_*_ids` arrays are re-checked on every read and turn.

Memory intentionally carries both `tenant_id` and `user_id`: memory belongs to
a person inside a workspace. `conversation_id` and `source_message_id` are
optional provenance links. Expiry/status controls lifecycle; memory deletion is
a tombstone, not physical removal.

### API resource persistence

Every API resource in `openapi.yaml` has a home in `design.dbml`. Item-side
changes (`items.space_id`, topics, artifacts) are justified in
`item_model.md` §5 rows 16–20; the rest is justified here.

| Addition | Limitation it removes | Alternatives rejected |
| --- | --- | --- |
| `request_idempotency` | 35 methods take `requestId` (AIP-155) and had no store; `REQUEST_ID_REUSED` needs the original method, parent and body | a `request_id` column on every created table (no cover for custom methods or Operations, no cross-method reuse detection); keeping results in a cache (lost on restart, not transactional) |
| `operations` | `operations/{operation}` (create workspace, exports, artifact generation and revision) had no owner, progress, cancel or result | Temporal as the store (the product must not read Temporal state); the target resource alone (exports have no resource) |
| `saved_searches` | SavedSearch CRUD with `updateTime` ordering | `users.preferences` JSON (unbounded, no per-row times, not per workspace) |
| `ingestion_syncs` | `sources/{s}/syncs` history; `last_sync_*` kept only one outcome | keep `last_sync_*` beside a history table (two truths); `audit_logs` (no counts, failures or state) |
| `ingestion_policies` | `ingestionPolicies/default` is updatable with an etag | deployment environment only (not updatable through the API); `tenants.settings` (it is platform-wide) |
| `spaces`, `space_materials`, `space_announcements`, `space_events`, `request_types` | Collaboration resources had no store; each child has its own identity, times and delete | Items of a new type (spaces are not knowledge and do not inherit access); one JSON document per space (no per-row etag, filters or FKs) |
| `role_assignments.space_id`, `roles.scope_type` `space` | `spaceLead`/`spaceStaff`/`spaceMember` and space IAM policies | a `space_members` table (the API defines members as bindings: two truths that drift) |
| `requests`, `request_messages` (replace `approval_requests`) | five kinds with kind-specific decision resources, assignee, SLA due time, eligibility and internal messages | extending `approval_requests` (`target_id` string and `details` JSON cannot be foreign-keyed, indexed per decider or same-tenant checked; its lifecycle has no `needs_info`, `answered`, `closed`) |
| `knowledge_gap_decisions` (replaces `knowledge_gap_dismissals`) | `RESOLVED` by `:answer` was not storable | a second table for resolutions |
| per-recipient `notifications` only (`notification_reads` dropped) | dismiss and undelete of a broadcast notice are per member | broadcast rows plus a read table plus a dismissal table |
| `code` columns (see "ID policy") | client-chosen `{resource}Id` values had no column | using the uuid only (cannot honour client IDs) |
| `ingestion_sources.sync_checkpoint` (jsonb, nullable) | the API rewrite dropped the connector cursor, so every sync re-listed the whole Source and incremental providers (Google Drive's Changes API) never reported deletions: removed files stayed live | a full listing plus a `last_seen_at` sweep (one complete crawl per sync, and a crawl that misses a file through a transient error would tombstone it); a `source_checkpoints` table (one row per source with no identity or lifecycle of its own). Impact: one opaque, connector-owned cursor per source; written only when a sync finished without failures, cleared when `config` is replaced so the next sync re-scans |

Targeted columns, each a filter, authorization or lifecycle input:
`tenants.template`, `demo`, `ingestion_paused_at` and the `creating |
archived` states; `users.status` (`active | suspended`) and
`last_active_at`; `tenant_memberships.last_active_at` (sessions have no
tenant); `roles.description`, `deleted_at`; `permissions.title`,
`custom_roles_supported`; `conversations.code`, `pinned`,
`scope_collection_ids`/`scope_space_ids` (small, read whole, trigger-checked;
a join table would add a table without a reverse lookup) and `deleted_at`;
`messages.generation_state` and `feedback_*`; `ingestion_sources.tenant_id`,
`code`, `schedule_*`, `next_sync_at`, `paused_at`,
`external_resource_label`; `ingestion_runs.retry_of_run_id`;
`audit_logs.category`, `target_name`, `ip_address`;
`platform_connector_settings.display_name`, `description`. Workspace
settings stay in `tenants.settings` and the assistant in
`workspace_assistant_settings` (read whole with their owner, never filtered).

Removed as obsolete: `access_sessions.tenant_id`, `kind`,
`transition_reason`; `approval_requests`; `notification_reads`;
`knowledge_gap_dismissals`; `item_uploads.idempotency_key`;
`ingestion_sources.sync_mode`, `status`, `status_detail`, `last_sync_*`;
`integration_connections.owner_type`, `disconnected_at`;
`conversations.status`; `item_revisions.conversation_id`, `request_id`;
`roles.status`; `metadata.topics` and `metadata.space_id` on items.

`requestId` (AIP-155): the scope is the caller (`user_id`, null for the
public CreateUser/CreateSession) and the `requestId`; the row stores the
method, the parent resource name, an HMAC-SHA-256 fingerprint of the
canonical request and the result resource name, and expires after 24 hours.
It is written in the transaction of the write, so a failed request leaves
nothing and a retry executes again. A match returns the result re-read for
the caller; any mismatch is `REQUEST_ID_REUSED`. A CreateSession replay
returns the same session with a fresh token (`token_version` + 1), because
tokens are never stored.

Computed, never stored: `memberCount`, `childCount`, `documentCount`,
`linkCount`, `itemCount`/`hiddenItemCount`, `Topic.documentCount`/
`inReviewCount`/`evidence`, `Space.memberCount`/`callerRole`/`collections`,
`Source.state`/`lastSync`/`pendingDocumentCount`/`inReviewCount`,
`IngestionRun.counts`, `IngestionTask.phase`, `Connector.workspaceCount`/
`requestCount`/`authenticationType`, `Connection.authorizationUri`,
`User.platformRole`, `Member.roles`/`groups`, `Request.overdue`,
`Artifact.state`/`revision`/`hiddenSourceCount`, `Share.uri`,
`AuditEvent.description`, `KnowledgeGap` (except its decision),
`contributionReviewRequired`, every `purgeTime`, policy etags and singleton
etags (hash of the stored document).

## ID policy

All persisted entity IDs use PostgreSQL native `uuid`, never `varchar(36)`.

The legacy runtime generates UUIDv4 values (`uuid4()`/`gen_random_uuid()`).
UUIDv7 is the preferred direction for new major entities because it improves
index locality while remaining safe for distributed API/worker generation. Do
not silently rewrite existing IDs or mix multiple generators for one entity.

UUIDv7 adoption requires one shared generator at the composition boundary,
worker support, model defaults, and verification across PostgreSQL,
Temporal, object storage, and Qdrant. Until that work is scheduled, keep UUID
type and stable application-generated IDs; do not add string IDs or sequences
just to approximate UUIDv7.

Persisted derived identities keep their original namespace: upload,
personal/artifact collection and external-resource IDs are uuid5 values of
`bothesis:{kind}:…`, and connection credentials are AES-GCM sealed with
`bothesis:plugin-credential:{id}` as associated data, all derived from
`bomesh.identity.PERSISTED_IDENTITY_NAMESPACE` and pinned by
`tests/bomesh/test_persisted_identity.py`. `users.username` is optional and
unique on `lower(username)`.

API resource IDs: a resource whose Create accepts a client-chosen
`{resource}Id` (groups, roles, topics, reading lists, connections, sources,
conversations, spaces, request types) keeps it in an immutable `code`
column, unique within its parent; when the client omits it the server writes
`r` followed by the 32 hex digits of the row uuid, which matches every client
ID pattern. Workspace `tenants.code` is the mutable web address, not
the ID. Every other resource ID is the row uuid, or the referenced item or
member ID where the API says so (saved/recent items, reading-list entries,
tasks, links, memberships, space members).

Use domain-native types for non-entity values: `BIGINT` for message sequence,
`INT` for revisions/positions, `INTERVAL` for durations, and bounded strings
for permission, role, connector, and status codes.

## Index review

Indexes follow known access paths, not every foreign key:

- conversations by tenant/code and tenant/owner with recency
- items by tenant/status and parent; live children by
  `(tenant_id, parent_item_id) WHERE deleted_at IS NULL`; dirty payloads by
  `payload_dirty_at WHERE payload_dirty_at IS NOT NULL`
- item revisions by Item/revision number; contributions by target/status and
  contributor; item links by container and target; reading-list entries by
  list/position; saved/recent items and saved searches by user/recency;
  topics by tenant/state/kind, item and contribution tags by topic
- citations by Item/chunk and live lifecycle
- memories by tenant/user/status and expiry-related reads
- connections by tenant/connector/status and owner
- sources by tenant/code, connection and target collection; due schedules by
  `next_sync_at`; syncs by source/start time and one running per source
- external resources by source/provider identity and last-seen time
- ingestion runs by tenant/recency and tenant/status; run items by run/status,
  run/batch (the planner), and Item/recency (a Document's latest run)
- messages by conversation/sequence and conversation/status/sequence (active
  history); rated messages by rating/time (knowledge gaps)
- authorization grants by principal/scope/role and space/user
- spaces by tenant/code; space children by space and their list order
- requests by tenant/state, requester, assignee, decision resource
  (space, collection, connector) and open due time
- artifacts by owner, space/audience and conversation
- operations and idempotency rows by owner and by expiry
- audit logs by tenant/category/time, tenant/action/time, actor/session and
  target

Partial or composite uniqueness is used where lifecycle state allows a record
to be tombstoned and later recreated. Reuse existing indexes before adding a
new one for a speculative query.

## Deferred, justified work

1. Add UUIDv7 only with a shared generator; no blind rewrite.
2. Add cross-row database guards for any new denormalized tenant field before
   exposing a write path.
3. Replace remaining broad JSON/dict payloads only when a stable consumer
   contract exists; keep provider-specific state isolated.
4. Add focused PostgreSQL tests for tombstone reactivation, tenant mismatch,
   conversation ownership, and authorization scope invariants.

These are bounded follow-ups, not new tables or infrastructure layers.
