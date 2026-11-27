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

PostgreSQL advisory-lock workflows use `advisory_lock_scope` as the first
intentional exception: it owns one autocommit connection for the lock lifetime,
performs no application transaction on that connection, and releases the lock
before releasing the connection. Atomic state changes still use
`transaction_scope` inside the lock.

The request `Authorizer` is the second exception. Inside an API endpoint
(`Authorizer.keep_connection`, held by the `Context` dependency until the
endpoint function returns) its permission and membership lookups share one
lazily opened autocommit connection: every lookup is one read statement with
its own snapshot, so it sees what was committed before it ran and never the
uncommitted writes of the request's own `transaction_scope`; no transaction,
snapshot or lock is held between lookups. Outside an endpoint each lookup runs
in its own `transaction_scope`.

### Relationship keys

`user_id` means **who**: owner, creator, requester, approver, actor, or
recipient. It is not a universal join key.

| Domain | Owning relationship | Intentional user reference |
|---|---|---|
| Conversation | `conversation_id -> messages`; `resource_shares.conversation_id` (its live shares) | `owner_user_id`; `created_by_session_id` records the creating user session |
| Knowledge | `item_id -> item_revisions`; `item_shortcuts`, `saved_items`, `recent_items`, `space_materials`, `message_items`, `message_citations`, `artifact_source_items`, `resource_shares` reference Items; `item_concepts -> concepts -> concept_schemes`; `document_profiles`, `document_applicability`, `document_supersessions` (1:1 / per Document) | `created_by_user_id`; `owner_user_id` on Documents; `user_id` on saved/recent items and saved searches |
| Contribution | `contributions.item_id` (candidate) `-> target_item_id` (Collection); suggested concepts are the candidate's `item_concepts` | contributor and reviewer user fields |
| Ingestion | `integration_connection_id -> ingestion_sources -> external_resources -> item_id`; `ingestion_sources -> ingestion_syncs`; `ingestion_runs -> ingestion_run_items -> item_id` | creator/owner fields only |
| Artifact | `artifacts.item_id` (its Item) `-> item_revisions`, `-> artifact_source_items`, `-> evidence_review_cells` | the Item's `owner_user_id` (no copy on `artifacts`) |
| Collaboration | `space_id -> space_materials`, `space_announcements`, `space_events`, `request_types`; `request_id -> request_messages` | requester, assignee, author fields |
| Authorization | `principal -> role -> scope` | `user_id`, `group_id` or `all_members` exclusive arc |
| Operations | `operations.user_id` (own-only) | `request_idempotency.user_id` scopes `requestId` |
| Memory | `tenant_id + user_id` | Both are domain keys, not convenience copies |

Messages, message citations, and external resources do not carry redundant `user_id`
or `tenant_id`. They inherit security context through their owning resource.

### Tenant boundary

`tenant_id` identifies workspace/organization isolation. It remains on major
root resources where it materially supports authorization and access paths:

- `items` — canonical knowledge ownership
- `conversations` — chat isolation
- `integration_connections` — connector ownership
- `ingestion_sources` — scope of the client-chosen source ID (trigger-checked
  against its connection and target Collection)
- `spaces`, `requests` — collaboration roots
- `concept_schemes`, `concepts`, `concept_rules`, `concept_proposals`,
  `member_affiliations` — taxonomy roots (`tenant_id` NULL = platform
  template; a template row references only template rows)
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

`items` is the canonical resource model for both item kinds
(`item_model.md`). `item_kind` (`collection | document`) is the structural
kind; `item_type` classifies an Item within its kind — a Collection is
`standard`, `personal` or `conversation_artifacts`, a Document carries the file
class of its content (`pdf`, `word`, `spreadsheet`, `image`, …; `item_model.md`
§4.11). Both are immutable (the tree trigger), and the revision and upload
triggers keep every revision and pending upload of a Document in its file
class. `(tenant_id, item_kind, item_type)` serves type filters, facets and the
system Collection lookups. Collections may contain collections or documents. Documents
cannot become roots, and a document cannot parent a collection. Parentage,
same-tenant ownership and cycle checks are
enforced by database constraints/triggers and service validation. Roots
(UX "knowledge base") are access boundaries and always store
`inherit_access = false`; each member has one PERSONAL collection.

Document state is independent facts that clients never collapse:

- Content availability is derived, never stored: `AVAILABLE` when
  `current_revision_id` is set, else `FAILED` when the `item_uploads` row is
  `failed`, else `PENDING`. An Artifact's state is derived the same way:
  `DELETED` when `deleted_at` is set, `GENERATING` while an unfinished
  `operations` row targets it, `FAILED` without a current revision, else
  `ACTIVE`. Deletion is only `deleted_at`: a subtree delete stamps one
  `deleted_at` on the Item and its live descendants, and undelete restores
  exactly that cohort.
- `is_published` (boolean, Documents only, null for Collections) decides
  whether readers without edit rights see the Document. One axis with two
  values is a boolean; an axis with more values (`index_status`) is
  one `varchar` with a CHECK, never one boolean per value.
- The indexing state is `item_index_states`, one row per Document created
  with it by the AFTER INSERT trigger `trg_items_index_state`:
  `index_status` (`pending | processing | ready | failed | unsupported`),
  `processed_version` (the processing configuration the index was built
  with), `indexed_revision_number` (the revision the chunks belong to) and
  `payload_dirty_at`. It is off `items` because an Ingestion Run writes it
  several times per Document per run and the payload sync clears it: on
  `items` every such write was a new row version that also moved
  `updated_at`, so processing changed `updateTime`, the etag ("Recently
  updated" order, ABORTED edits) and rewrote the wide row. `items` changes
  only with what people do. The ORM reads it through read-only `Item`
  attributes (correlated scalar subqueries on the primary key), so a page
  of Items stays one statement.

The API maps these to `state`, `document.contentState`,
`document.publicationState` and `document.indexingState`, where `OUTDATED` is
`index_status = ready` with a `processed_version` that differs from
`processing_version()` of the current configuration (parser, chunker,
embedding model, index schema, contextualization model, preview
representation version — citation highlights index the representation). The
private `item_uploads` ledger is never exposed: it holds what a pending upload
promised (`content_id`, `mime_type`, `size_bytes`, `file_name`) until
completion turns it into revision 1, its `status` and `error_code` (for
example `ITEM_TYPE_MISMATCH` when the validated content has another file class
than the Document), and, for a file extracted from a ZIP archive, its lineage
(`archive_item_id` + `archive_path`, set together; a partial index lists an
archive's members).

`item_revisions` is the one append-only content store for every Document
(and assistant artifacts): each revision holds its version's `content_id`,
`mime_type`, `size_bytes` and `file_name`, and `items.current_revision_id`
points at the one a Document shows (see "Current revision pointer"). Nothing
about content is copied onto `items`, and no table stores an object key: keys are derived ("Object
storage" below). The ORM reads what a Document shows (`content_id`,
`mime_type`, `size_bytes`, `file_name`: the current revision's, else the
pending upload's; and the revision's `exports.cover`) through read-only `Item`
attributes built like the index views, so a page of Items stays one
statement; the revision and upload rows themselves load only on request.
`contributions` holds review of one candidate Document; a NEW_DOCUMENT
candidate is processed (an explicit Ingestion Run) before it is decided, and
approval moves or publishes it, or appends a revision, in one transaction and
never starts an Ingestion Run. `item_shortcuts` shows a Document inside another Collection
without changing its canonical parent or granting access. `saved_items`,
`recent_items`, `space_materials` and `message_items` are references outside
the tree; every read re-checks access to the referenced Item. `space_materials`
is the only link between a Space and an Item (no Item names a Space).
MergeItem re-points every reference to the duplicate to the kept Document with
one set-based statement per reference table, deduplicated on that table's
unique key, soft-deletes the duplicate and writes one `audit_logs` row;
nothing resolves merges at read time.

Move, publish, unpublish, delete and undelete set `item_index_states.payload_dirty_at` in
their transaction; the Qdrant payload update runs after commit and a
scheduled job retries dirty rows, so the index converges without an outbox
table.

A Document's cover (`document_viewer.md` "Cover on the Item") is derived
metadata of its content, `item_revisions.exports.cover`, never a table or
column: it is produced once per content, read with the Item row (the read-only
`Item.cover` view of the current revision), and kept small (a few hundred bytes). Its producer is told
through the one non-validating trigger, `trg_items_cover` (AFTER INSERT/UPDATE
OF `current_revision_id`), which sends `pg_notify('bomesh_cover', item_id)`
when a Document's content becomes available or changes. A notification is
delivered on commit and only to a listening worker; the worker's sweep (a
keyset scan of the primary key for live Documents whose current revision has
no cover of the producer's version) is the durable catch-up, so no outbox or
queue table is needed and no index is added.

#### Current revision pointer

`items.current_revision_id` is stored although it is a function of
`item_revisions` (the newest live revision of the Item). It stays a column
because it is on the hot path and has a consumer that needs a row event:

- every Item read joins the current revision by primary key (file name, MIME
  type, size, cover); deriving it would add a `max(revision_number)` lookup
  over live revisions per row to every list and search page;
- `contentState` (and every filter on it) is `current_revision_id IS NOT
  NULL` on the row itself;
- the cover producer is told by `trg_items_cover` (AFTER INSERT/UPDATE OF
  `current_revision_id`), which needs the change to be an update of one row;
- the partial unique index on it keeps one Item per revision.

It is not hand-maintained data: the deferred constraint trigger
`trg_items_current_revision` (on `items`, and on `item_revisions` INSERT and
UPDATE OF `deleted_at`) checks at commit that it names the newest live
revision of the same Item and is set whenever a live revision exists, so a
write path that forgets to move it fails instead of drifting.

### Object storage

PostgreSQL never stores an object key, bucket or provider path. Every key is
a pure function of identities the rows already hold (`bomesh/storage/keys.py`
is the only place that formats one), so a key cannot drift from its row,
cannot be forged by a client, and changing the convention is a code change
plus an object copy, never a rewrite of stored strings.

One private bucket per deployment environment (`RUSTFS_BUCKET`, an S3 or R2
bucket); environments never share a bucket, so keys carry no environment.
A key reads as a path a person can follow in the storage console: **whose**
object it is (`workspaces/{code}` — the workspace's immutable `code`, its web
address, never the tenant UUID — or `platform`), **which part of the product**
it belongs to (`files`, `taxonomies`, `branding`, `exports`), then an **immutable
identity**. One file is one folder: its original and everything built from it.

| Key | Holds | Lifecycle |
| --- | --- | --- |
| `workspaces/{code}/files/{content_id}/original` | the bytes of a file: uploads, conversation images and attachments, source originals, archive members, artifacts | kept until no live revision references `content_id` (purge) |
| `workspaces/{code}/files/{content_id}/{product}-v{n}[/{part}]` | what producers build from that file: `preview-v1` (the representation the Original preview shows), `thumbnail-v2` (the cover), the Structured Document `structure-v1/{fingerprint}.json.gz` (one per parse profile; `document_contract.md` "Structured Document") and the images it references `images-v1/{sha256}.png` (named by content hash, shared by every fingerprint), the vision model's readings of scanned PDF pages `ocr-v1/{fingerprint}-p{first}-{last}.json` (the fingerprint names model, prompt and output bound, so processing the same file again reuses them), the classification answers `classification-v2/{key}.json` (the key names model, prompt, published scheme versions, concept rules, classifier version, note and the document's part; `document_contract.md` "Classification reuse") | rebuildable (a Structured Document a citation names is rebuilt only by the same parse profile); deleted with the file's folder |
| `workspaces/{code}/taxonomies/{scheme}/{version}/cards-{embedding_model}.json` | the concept-card embeddings of one published classification scheme version (labels, definition, scope note, examples), computed by the first classification that needs them (`document_contract.md` "Processing") | rebuildable; immutable per version and embedding model |
| `workspaces/{code}/branding/{kind}/{asset_id}` | workspace images that are not Documents: `logo`, `map-background` | deleted when replaced or removed |
| `workspaces/{code}/exports/{operation_id}.csv`, `platform/exports/{operation_id}.csv` | results of finished export Operations | deleted once `result_expires_at` has passed |

Expired exports are removed by the ingestion worker's hourly `export-purge`
pass, which lists the stored CSVs (every workspace's `exports/` and
`platform/exports/`) and deletes each whose operation has passed
`result_expires_at`, finished without it (failed after storing) or no longer
exists; a CSV of an export still running is kept. Being driven by what is
stored, it also cleans CSVs left from before it ran.

Rules:

- **The workspace `code` is immutable** (set on create, never in
  UpdateWorkspace's `updateMask`), so a key never moves. Loaded Items and
  Operations carry it as the read-only `workspace_code` (a correlated
  subquery, no extra statement); a caller that holds only the workspace ID
  reads it once (`services.kernel.workspaces.workspace_code`).
- **`content_id` is the identity of bytes, not of a revision.** A revision
  that shows existing bytes (rollback, an approved NEW_REVISION, an artifact
  revert, an artifact published as a Document) copies the `content_id` and
  the derived exports of the revision it reuses; objects are never copied. A
  purge deletes the folder `workspaces/{code}/files/{c}/` only when no live
  revision of a non-purged Item has `content_id = c`.
- **Where a `content_id` comes from.** Uploads and artifacts take a new random
  UUID; a presigned upload reserves it in `item_uploads.content_id` at
  CreateItem, so the client PUTs straight to its final key and completion only
  records the revision. Derived identities (uuid5 of `"{namespace}:{kind}:…"`,
  `bomesh/identity.py`) make a retry write the same object instead of leaking
  a new one: a source original is
  `source-content:{connection}:{external_id}:{provider version}` (an
  unversioned provider object gets a random UUID, so it never overwrites bytes
  an older revision shows), an archive member is
  `archive-content:{archive content}:{member path}`.
- **Immutable keys.** An `original` or branding key is written once; a
  product key changes only by bumping its product version. Objects are stored
  with `Cache-Control: private, max-age=31536000, immutable`.
- **No names in keys.** File names, titles and provider paths never appear in
  a key (no personal data, no encoding or traversal concerns, a rename never
  moves bytes). `Content-Type` is object metadata; the file name is sent per
  download as `Content-Disposition` on the signed URL.
- **Workspace isolation by prefix.** Every object of a workspace is under
  `workspaces/{code}/`; platform objects are under `platform/`. Clients only
  ever receive short-lived signed URLs, issued per request after the matching
  authorization check.

### Knowledge inventory vs ingestion execution

```text
upload / archive upload / source sync  ->  Item (+ item_index_states pending) + item_revisions
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

`item_index_states.index_status` stays the one source of truth for a Document's processing
state; run items are history, and the Document's latest run item supplies the
error and run shown next to it. Each run item records the `revision_number`
it started from; a finish whose revision or governing Collection changed
meanwhile writes `pending` and marks the payload dirty. The `conversation_artifacts`
system collection and conversation attachments are never selected.

PostgreSQL is the queue; no orchestration state lives anywhere else. The
ingestion worker (`python -m bomesh.services.ingestion.worker`: the API's
code, its own process and container, scaled on its own) claims a
`queued`/`running` run by taking the run's session-level advisory lock on one
dedicated connection; that connection must reach PostgreSQL directly, not
through transaction pooling. A worker that dies closes the connection, so
PostgreSQL frees the lock and the next worker to take it recovers the run:
tasks left `running` fail as `interrupted` (their Documents return to
`pending`), queued tasks are planned again, and the run resumes. A graceful
shutdown instead returns the tasks in flight to `queued`. A cancel is a
status write: a run no worker holds is settled at once, an owned one by its
worker within seconds. A worker that loses its lock connection stops its runs
at once, and every run write re-checks, in its own transaction and with the
run row locked, that the worker's connection still holds the run's lock, so a
stale worker never overwrites the one recovering the run. No lease or
heartbeat column is needed. A `running` `ingestion_syncs` row is claimed the
same way.

### Provider-neutral ingestion

```text
IntegrationConnection
  -> IngestionSource
      -> ExternalResource
          -> Item
```

Provider-specific identity stays in `connector_key`, provider ID columns, and
connector-owned JSON fields. Core tables do not use names such as `drive_file`
or `notion_page`. A connector Item carries its stored original (a revision
whose `content_id` is derived from the provider version) and provider identity (its `external_resources` row, with the connector's facts in `provider_data`), so processing reads
every Document the same way, whatever its origin.

`external_resources.(ingestion_source_id, external_id)` is the stable provider
identity. Tombstoning a resource does not free that identity; rediscovery
reactivates the row and preserves its canonical Item ID. Every sync is one
`ingestion_syncs` row (trigger, state, counts, bounded failures, error); the
latest row is `Source.lastSync` and decides `FAILED`, and a partial unique
index allows one running sync per source. `Source.state` is otherwise
computed from `paused_at` and the connection state, so it cannot drift from
them. `schedule_cron`/`schedule_time_zone` hold the schedule and
`next_sync_at` is its next firing: the worker scans due sources
(`FOR UPDATE SKIP LOCKED`), opens a `scheduled` sync and advances
`next_sync_at`, so missed firings fire once.
`ingestion_sources.publishing_policy` (`auto_publish | review_first`) decides
whether synced Documents are published directly or enter as contributions.

### Taxonomy

The faceted SKOS taxonomy (`item_model.md` 4.13)
keeps every rule a write could break in the database (`models/triggers.py`):

- same tenant everywhere, NULL-tenant templates included
  (`trg_concepts_references`, `trg_concept_schemes_template`: a fork names a
  template scheme or concept); proposals, rules, profiles, applicability,
  supersessions and affiliations check their references
  (`trg_<table>_references`); affiliations, applicability, issuer and campus
  name authority Concepts of the tenant;
- `notation` immutable and unique over every row of a scheme, deleted drafts
  included (I5); `color` only on a Concept without `broader` rows, checked at
  the concept write and at the broader insert (I9);
- `trg_concept_relations_graph`: same scheme, and a recursive walk up the
  `broader` rows rejects a cycle, through any parent (I3); `related` is stored
  once with source < target (CHECK);
- `trg_item_concepts_references` (I10): a Document of the Concept's tenant,
  `scheme_id` = the Concept's, a classification scheme, and on insert or
  re-point a published Concept that is not top when
  `assign_top_concepts = false`;
- `trg_item_concepts_cardinality`, a deferred constraint trigger (I11):
  accepted whole-document rows per (item, scheme) ≤ `max_labels` and exactly
  one `is_primary` when `has_primary` and any exist, checked at commit so a
  label swap may pass through an intermediate state.

`concept_closure` holds only the published graph and is rebuilt per scheme in
the publish transaction (`services/taxonomy/closure.py`); queries never walk
`concept_relations`. The view `cross_scheme_labels` (tenant, `normalized`,
scheme ids, concept ids: labels of published Concepts found in more than one
scheme) is created with the schema after the tables and dropped before them.

### Authorization

`tenant_memberships` answers only whether a user belongs to a tenant.
`role_assignments` answers who has which role at platform, tenant,
collection or space scope (`tenant_id`, `item_id`, `space_id`: at most one
set; none = platform). The principal is exactly one of `user_id`, `group_id`
or `all_members` (every active member of the Item's tenant, collection scope
only); space grants take user principals only, because a space member is a
person with a join time. Workspace access requires both an active membership
and tenant-scope role assignments; platform roles are a separate scope.
A public tenant (`tenants.visibility`) only lets a signed-in user create their
own membership with the predefined member role; there is no baseline public
role and no access without a membership. `groups` are
principals, not a second authorization system. Only Collections carry item
grants; effective permission is tenant grants plus grants up the canonical
chain to the first `inherit_access = false` Collection, and for a space,
tenant grants plus that space's grants. Role scope, tenant ownership,
principal membership, and deleted-row behavior are validated by
constraints/triggers and the authorization service. `role_permissions`
retain tombstones and reactivate stable identities instead of creating
duplicate rows.

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

### Citations and the index

```text
message_citations / CitationTarget JSON
  -> (item_id, revision_number, structure_version, refs)
  -> workspaces/{code}/files/{content_id}/structure-v1/{structure_version}.json.gz blocks
```

A citation names blocks of one immutable Structured Document of one revision
and copies their `quote`, `location` and `highlights`, so reading answers never
touches object storage and reprocessing never breaks a citation. PostgreSQL
holds identities and manifests only (`item_revisions.exports.structure`); no
table stores blocks or geometry. Every citation read re-checks Item
permission first.

Qdrant points (index schema 12) are internal retrieval units: point and chunk
ids derive from chunk positions and never leave the backend. Each payload
carries the retrieval fields (`chunk_text`, `contextual_text`,
`semantic_context`, `context_key`, `embedding_model`, `section_path`), the
access pre-filter fields (`tenant_id`, `collection_item_id`, `published`,
`is_deleted`) and the citation target of the chunk: `refs` (block refs, at
least one), `quote` (plain text, ≤280 characters), `location`, `page`,
`revision_number` and `structure_version`. A point without `refs`,
`revision_number` or `structure_version` is not read. Qdrant filters on
`tenant_id`, the governing `collection_item_id` and `published` are a
pre-filter only; PostgreSQL re-checks every hit, and viewer and content
reads fetch by `item_id`.

### Conversations

`conversations -> messages` is the only message ownership path. Message order
uses `(conversation_id, sequence_number)`; message identity is UUID. Messages
are the server-owned conversation history the agent reads. A retry or edit
never deletes: it sets `superseded_at` on the replaced user message and every
later message, and only active messages (`superseded_at IS NULL`) reach
model context or conversation references. Sequence numbers keep growing, so a
replacement is ordered after what it replaced. `generation_state` is the
outcome of one turn (`completed | interrupted | failed`); the owner's answer
feedback is four columns on the assistant message, because a conversation has
exactly one possible rater. Conversations are soft-deleted with `deleted_at`;
the `scope_*_ids` arrays are re-checked on every read and turn. There is no
memory store: the `memories` table was dropped (no writer, no reader).

### JSON columns

No table has a generic `metadata` column. A JSONB column exists only for a
document that is read and written whole by one owner, whose shape the owner
validates and this design names, and that no query filters, sorts,
authorizes or joins on. Anything a query touches is a typed column (an FK
when it names a row); anything that belongs to an external provider lives
with the provider's row, not with the canonical one.

| Column | Owner, shape | Why not columns |
| --- | --- | --- |
| `users.preferences`, `tenants.settings`, `workspace_assistant_settings.capabilities`/`starter_prompts` | the settings service, the API's settings message | read and written whole with their row; never filtered |
| `auth_identities.profile` | the identity provider's normalized profile | provider-shaped, informational |
| `integration_connections.config`, `ingestion_sources.config`/`sync_checkpoint` | the connector | provider-specific, opaque to the core |
| `external_resources.provider_data` | the connector: provider facts about one external object (labels, owners, provider path and kind, hierarchy, its cache) | provider-specific; the canonical Item never holds them |
| `item_revisions.exports` | the producers of derived products (representation, cover, Structured Document manifest, archive expansion summary) | manifests of products, read with their revision |
| `contributions.suggestions`/`flags`, `request_types.fields`/`rules`, `requests.fields`/`assistant_context`/`eligibility`, `artifacts.evidence_review`, `evidence_review_cells.citations`, `message_citations.highlights` | their service, typed in the API | small documents read whole with the row |
| `ingestion_runs.scope`/`configuration`, `ingestion_run_items.phases`, `ingestion_syncs.failures`, `operations.error`, `*.error` | the run, sync or operation | snapshots and google.rpc.Status, read whole |
| `conversations.state`, `sandbox_sessions.manifest`/`provider_state` | the assistant runtime | never exposed |
| `audit_logs.details` | the audit writer | append-only detail, never filtered |

Removed (`item_model.md` §5 row 27): `items.metadata` (every key became a
typed column or moved to `external_resources.provider_data` or
`item_revisions.exports`), `access_sessions.metadata` and `memories` (never
written), `external_resources.metadata` (its one key, `canonical_external_id`,
always equalled `external_id`; provider facts are `provider_data`),
`messages.metadata` (citations are `message_citations`; `request_id` had no
reader).

### Resource shares

`resource_shares` is the one table behind every URL the platform hands
out: sharing a document, collection, space or conversation, and inviting
people into a workspace, a space or a collection (API resource
`workspaces/{workspace}/shares/{share}`, web URL `/s/{token}`). Its columns
decide what a share does, never its caller:

- `kind = share` points at exactly one target (`item_id`, `space_id` or
  `conversation_id`). For knowledge and spaces it **grants nothing**: the
  person who opens it must be signed in and already able to read the target
  (`item_model.md` §6 invariant 5: references never grant access); otherwise
  it offers Request access. Its URL is `/s/{share id}`, so it can be copied
  again at any time. `audience` (`workspace`: active members; `people`:
  `recipient_user_ids`) decides who it resolves for. A conversation is not
  knowledge and is owner-private, so a live share is exactly what lets its
  audience read it: the **live** conversation (turns the owner adds later
  included), read-only, every turn and citation re-filtered for the reader;
  only the owner converses.
- `kind = invite` targets a scope that holds role grants (no target = the
  workspace; `space_id`; a Collection `item_id`) and carries the `role_id` it
  grants. Accepting it (any signed-in account, `audience = anyone`) creates
  the workspace membership if needed and the role assignment, so a person
  without an account signs up and lands in the workspace. Creating one is an
  IAM change: the creator needs the scope's `setIamPolicy` permission and may
  grant only roles whose permissions they hold (`ROLE_ESCALATION`); both are
  re-checked on every accept, so an invite stops working when its creator
  loses that right. The URL carries a secret token (`/s/{token}`, 32 random
  bytes); only its SHA-256 is stored (`token_hash`), it is shown once at
  creation, and "reset link" revokes and creates a new one.
- `expires_at`, `max_uses`/`use_count` (invites) and `revoked_at` bound a
  share; DeleteShare revokes (never undone). Accepting twice is a no-op that
  uses nothing. Every create, revoke and accept is audited.

`recipient_user_ids` is a uuid array (small, read whole, trigger-checked to
be active members of the tenant, GIN-indexed for "shared with me"), like
`conversations.scope_collection_ids`; a recipients table would add a table
without its own identity or lifecycle. `resource_shares` replaces
`conversation_shares` and `conversation_share_recipients`; there is no
conversation snapshot. The old `item_links` (a Document shown inside another
Collection) is renamed `item_shortcuts`, so "link" names no table.

### API resource persistence

Every API resource in `openapi.yaml` has a home in `design.dbml`. Item-side
changes (Space links through materials, artifacts, item kind and type,
merge, upload lineage, the faceted taxonomy) are justified in `item_model.md`
§5 rows 16–22, 29–34 and 39–49; the rest is justified here.

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
| `tenants.visibility` (`private \| public`) | a workspace could only be entered by admin invitation; public workspaces (a university open to applicants) need self-service joining and a public listing | an invite link shared publicly (it expires, is single-audience and cannot be listed); a `public` flag in `tenants.settings` (it filters ListWorkspaces, so it must be an indexed-capable column, and JSON settings are never filtered). Impact: one column; joining reuses `tenant_memberships` and `role_assignments` (`roles/workspaceMember`), so no new access path exists |

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
`platform_connector_settings.connector_name`, `description`. Workspace
settings stay in `tenants.settings` and the assistant in
`workspace_assistant_settings` (read whole with their owner, never filtered).

Removed as obsolete: `access_sessions.tenant_id`, `kind`,
`transition_reason`; `approval_requests`; `notification_reads`;
`knowledge_gap_dismissals`; `item_uploads.idempotency_key`;
`ingestion_sources.sync_mode`, `status`, `status_detail`, `last_sync_*`;
`integration_connections.owner_type`, `disconnected_at`;
`conversations.status`; `item_revisions.conversation_id`, `request_id`;
`roles.status`; `items.metadata` (every key a column, `item_model.md` §5
row 27); `access_sessions.metadata`; `memories`. With the Item
classification and merge cutover (`item_model.md` §5 rows 2, 8, 16, 29–34):
`items.status` (content state is derived), the free-form document type, the
special-Collection discriminator (now `item_type`), `space_id`, `merged_into_item_id` and `summary` (folded into `description`);
`items.archive_item_id`/`archive_path` (moved to `item_uploads`);
`tenants.settings.document_types`; the curated-list tables;
`topics`, `item_topics`, `contribution_topics`, `topic_corrections`,
`topic_correction_changes` and the topic keys of `contributions.suggestions`
(replaced by the faceted taxonomy, `item_model.md` 4.13); `messages.status`
(`superseded_at`); `groups.status` and `group_memberships.status`
(`deleted_at`); `artifacts.owner_user_id`, `created_at`, `updated_at` (the
Item's).

### Column names

A table's own name column is `<entity>_name`, never a generic `name`,
`display_name` or `title`, so joins read unambiguously: `users.login_name`
(optional local login) and `users.user_name`, `tenants.tenant_name`,
`roles.role_name`, `groups.group_name`, `concept_schemes.scheme_name`,
`concept_groups.group_name`, `concept_proposals.proposal_name`,
`items.item_name`, `saved_searches.saved_search_name`,
`integration_connections.integration_connection_name`,
`ingestion_sources.ingestion_source_name`,
`platform_connector_settings.connector_name`,
`conversations.conversation_name`, `spaces.space_name`,
`request_types.request_type_name`. The ORM attribute equals the column name.
API field names do not follow the columns: they stay `displayName` (or
`title` where the API says so). `permissions.title` is the catalogue title of a
permission, not an entity name, and keeps its name.

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
`shortcutCount`, `Document.contentState`, concept document counts, `Space.memberCount`/`callerRole`/`collections`,
`Source.state`/`lastSync`/`pendingDocumentCount`/`inReviewCount`,
`IngestionRun.counts`, `IngestionTask.phase`, `Connector.workspaceCount`/
`requestCount`/`authenticationType`, `Connection.authorizationUri`,
`User.platformRole`, `Member.roles`/`groups`, `Group.memberCount`,
`Request.overdue`,
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
object storage, and Qdrant. Until that work is scheduled, keep UUID
type and stable application-generated IDs; do not add string IDs or sequences
just to approximate UUIDv7.

Persisted derived identities keep their original namespace: upload,
personal/artifact collection and external-resource IDs are uuid5 values of
`bothesis:{kind}:…`, and connection credentials are AES-GCM sealed with
`bothesis:plugin-credential:{id}` as associated data, all derived from
`bomesh.identity.PERSISTED_IDENTITY_NAMESPACE` and pinned by
`tests/bomesh/test_persisted_identity.py`. `users.login_name` is optional and
unique on `lower(login_name)`.

API resource IDs: a resource whose Create accepts a client-chosen
`{resource}Id` (groups, roles, concept schemes, concepts (`notation`),
concept groups, concept rules, connections, sources,
conversations, spaces, request types) keeps it in an immutable `code`
column, unique within its parent; when the client omits it the server writes
`r` followed by the 32 hex digits of the row uuid, which matches every client
ID pattern. Workspace `tenants.code` is the immutable web address (and object-key prefix), not
the ID. Every other resource ID is the row uuid, or the referenced item or
member ID where the API says so (saved/recent items,
tasks, shortcuts, memberships, space members).

Use domain-native types for non-entity values: `BIGINT` for message sequence,
`INT` for revisions/positions, `INTERVAL` for durations, and bounded strings
for permission, role, connector, and status codes.

## Index review

Indexes follow known access paths, not every foreign key:

- conversations by tenant/code and tenant/owner with recency
- items by tenant/kind/type and parent; live children by
  `(tenant_id, parent_item_id) WHERE deleted_at IS NULL`; dirty payloads by
  `item_index_states (payload_dirty_at) WHERE payload_dirty_at IS NOT NULL`;
  documents per processing state by `item_index_states (index_status, item_id)`
  (`indexingState` filters probe one state's set instead of a subquery per row);
  live revisions by `item_revisions (created_at) WHERE deleted_at IS NULL` and
  content-less documents by `items (tenant_id, created_at) WHERE
  current_revision_id IS NULL AND item_kind = 'document'` (Home's recently
  published walks both newest first and stops at the section size)
- item revisions by Item/revision number; contributions by target/status and
  contributor; item shortcuts by container and target; saved/recent items and
  saved searches by user/recency; item uploads by owner/status and archive
  members by archive (partial);
  resource shares by creator, by target and by token hash, recipients by GIN;
  concepts by scheme/state and notation; labels by `normalized`; closure by
  descendant; item concepts by concept/state/item and the suggestions queue by
  scheme/state/time (one live label per (item, concept, section) and one
  accepted primary per (item, scheme), partial unique); classifications by
  scheme/outcome; profiles by issuer and issue date; applicability and
  affiliations by concept
- connections by tenant/connector/status and owner
- sources by tenant/code, connection and target collection; due schedules by
  `next_sync_at`; syncs by source/start time and one running per source
- external resources by source/provider identity and last-seen time
- ingestion runs by tenant/recency and tenant/status; run items by run/status,
  run/batch (the planner), and Item/recency (a Document's latest run)
- messages by conversation/sequence (history, active or not); rated messages by
  rating/time (knowledge gaps)
- authorization grants by principal/scope/role and space/user; group
  memberships by user
- spaces by tenant/code; space children by space and their list order
- requests by tenant/state, requester, assignee, decision resource
  (space, collection, connector) and open due time
- artifacts by space/audience and conversation; a member's artifacts through
  the Item owner index
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
