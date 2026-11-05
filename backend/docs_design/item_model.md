# Unified Item model

Status: **canonical Item-domain design, implemented by the backend.** This
document owns the Item domain decisions; `design.dbml`
is the schema, `openapi.yaml` the contract, `api_design.md` the method
catalogue, and `database_architecture.md` the database principles.

## 1. What existed before the rebuild (legacy)

The "Implemented" column is the legacy code before the rebuild and the evidence for the
refactor. The last two columns are legacy history: what the deleted legacy design
documents described and what the pre-review API draft proposed.

| Concern | Implemented (legacy code) | Legacy history: legacy design docs | Legacy history: pre-review API draft |
| --- | --- | --- | --- |
| Identity | One `items` table, `item_type` `collection`/`document`, adjacency list (`backend/bomesh/db/models/knowledge.py`) | same | `knowledgeBases` + `documents` as two API resources |
| Hierarchy | Trigger: collections only as roots, same tenant, live parent, no cycles, no document → collection (`models/triggers.py`); no move, no restore, no subtree delete | same | `UpdateDocument.knowledgeBase` (move) |
| Roots | Any parentless collection; per-member system collections `personal_uploads`, `conversation_artifacts` (now `services/knowledge_items/item_store.py`) | — | `KnowledgeBase.type PERSONAL` |
| Access | Collection-scoped `role_assignments`, inherited down until `inherit_access=false`, recursive CTE per request, no cache (`identity_access/authorization.py:76-216`) | same | `knowledgeBases:setIamPolicy`, `workspaceMembers` principal |
| Retrieval auth | Qdrant pre-filter `tenant_id` + `collection_item_id ∈ allowed` (`document_index/_qdrant.py:331-361`); the governing collection is frozen into the payload at index time (`item_ingestion.py:184,318`) | same | — |
| Content | `items.storage_key` + private `item_uploads` ledger; `artifact_revisions` used only by assistant artifacts (now `services/artifacts/artifact_store.py`) | same | `documents/{d}/revisions` |
| Review/publication | none | — | `Document.state` mixing `UPLOADING/PRIVATE/DRAFT/PUBLISHED/UNPUBLISHED/DELETED`; `contributions`; approval "starts one ingestion run" |
| Curation | none | — | `collections` (reading lists) + `collections/{c}/items` |
| Ingestion | `ingestion_runs` + `ingestion_run_items` snapshot by `INSERT … SELECT` under an advisory lock (now `services/ingestion/run_engine.py`) | same | `selector {documents, knowledgeBase}` |

UX (`apps/ux_preview/docs/KNOWLEDGE_HUB.md:22-33`, `DOCUMENT_LIFECYCLE.md`):
a document lives in exactly one knowledge base; collections (reading lists),
saved, recent, spaces, featured and topics *reference* it and never grant
access; review is separate from processing; no nested-folder UI exists yet.

## 2. Problems found

1. **Two API identities for one row.** The pre-review draft exposed root collections as
   `knowledgeBases` and their documents as `documents`, while the database,
   permissions (`collection.*`), ingestion and citations all key on one Item ID.
   Nested collections had no API resource at all.
2. **"Collection" meant two things.** The DB/legacy Collection is an access
   boundary; the draft/UX "collection" is a reading list that must grant nothing.
3. **One status for four concerns.** The draft `Document.state` merged upload,
   privacy, review and publication; the DB overloads `items.status` with
   `deleted`, so a restore cannot know the prior state.
4. **Approval implied ingestion** in the draft, against the inventory/processing split
   (`database_architecture.md`, "Knowledge inventory vs ingestion execution").
5. **Collection delete did not cascade**: live
   descendants of a deleted collection stayed reachable to tenant-wide roles,
   and their chunks stayed in Qdrant. *Fixed (§8 step 3).*
6. **Moving is unsafe with the current index.** The payload's frozen
   `collection_item_id` would keep a moved document visible to the old
   collection's readers.
7. **Root `inherit_access` defaults to true.** Harmless today, but a root moved
   under another collection would silently start inheriting.
8. **Artifacts are ingestible by accident.** Artifact Items have a
   `storage_key` and no upload row, so ingestion's candidate filter accepts
   them (`ingestion.py:946-950`). *Implemented defect.*
9. **Document revisions have no store.** `artifact_revisions` serves
   artifacts only, so document version history (UX Reader) had nowhere to live.

## 3. Final domain model

```text
Workspace (tenants)
 ├─ Item ─ COLLECTION (root)        UX "knowledge base"; access boundary
 │   ├─ Item ─ COLLECTION (nested)  inherits unless inheritAccess = false
 │   │   └─ Item ─ DOCUMENT
 │   ├─ Item ─ DOCUMENT
 │   │    ├─ revisions/{n}          immutable content (item_revisions)
 │   │    ├─ content, passages/{p}  derived reader view, citation targets
 │   │    └─ Item ─ DOCUMENT        CHILD / ATTACHMENT, source sync only
 │   └─ links/{document} ┄┄▶ DOCUMENT canonically elsewhere (item_links; no grant)
 ├─ Item ─ COLLECTION kind PERSONAL one per member ("My files"); owner-only
 ├─ (hidden) conversation_artifacts system collection → Assistant `artifacts`
 │
 ├─ Contribution ──item──▶ candidate DOCUMENT ──target──▶ COLLECTION
 ├─ ReadingList ── entries ──ref──▶ Item          (never grants access)
 ├─ Member ── savedItems / recentItems ──ref──▶ Item
 ├─ Source ──targetCollection──▶ COLLECTION; ExternalResource ──▶ DOCUMENT
 └─ IngestionRun ── tasks (snapshot) ──▶ DOCUMENT
```

| Resource | Owns | Lifecycle | Persistence |
| --- | --- | --- | --- |
| Item | identity, hierarchy, title, type facet | `ACTIVE` ⇄ `DELETED` (soft, 30-day retention, subtree cohort) | `items` |
| Item revision | immutable content version | append-only, tombstone | `item_revisions` (renamed `artifact_revisions`) |
| Upload ledger | idempotent upload of a revision's bytes | pending → available / failed; private | `item_uploads` |
| Contribution | review of one candidate document | `ANALYZING → IN_REVIEW ⇄ CHANGES_REQUESTED → APPROVED / REJECTED / WITHDRAWN` | `contributions` (new) |
| IAM policy | who holds which role on a collection | grant/revoke (tombstone) | `role_assignments` |
| Source / ExternalResource | provider scope and identity | unchanged | `ingestion_sources`, `external_resources` |
| Ingestion run / task | one processing execution over a snapshot | unchanged | `ingestion_runs`, `ingestion_run_items` |
| Citation / passage | chunk geometry for a document | replaced per indexing | `citations` |
| Reading list / entry | curated ordered references | soft delete | `reading_lists`, `reading_list_entries` (new) |
| Item link | shortcut of a Document inside another Collection | create / soft delete; follows the container's delete cohort | `item_links` (new) |
| Artifact | assistant output and its revisions | Assistant domain | Item row in a hidden system collection + `item_revisions` |

Document state is four independent fields, never collapsed:

| Field | Values | Source of truth | Changed by |
| --- | --- | --- | --- |
| `state` | `ACTIVE`, `DELETED` | `items.deleted_at` | Delete / Undelete |
| `document.contentState` | `PENDING`, `AVAILABLE`, `FAILED` | `items.status` | upload completion |
| `document.publicationState` | `PUBLISHED`, `UNPUBLISHED` | `items.publication_state` | Publish / Unpublish, contribution approval, source policy |
| `document.indexingState` | `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, `OUTDATED`, `UNSUPPORTED` | `items.index_status` + `processed_version` | ingestion runs only |

Review state lives on the Contribution, not the Item.

## 4. Decisions

**4.1 One API resource, `workspaces/{workspace}/items/{item}`.** `itemType`
selects exactly one facet (`collection` or `document`); common fields are
shared. Rejected: `documents` + `collections` as separate resources over one
table (two sources of truth, duplicated list/search/IAM/move code), and a
flat schema with every subtype column nullable. Names are flat (Drive-style,
`parentItem` is a field), so a move never renames an Item, its citations or
its references. The UX keeps its words: a root collection is a "knowledge
base", nested collections are folders, documents are documents.

**4.2 Canonical hierarchy plus item links (Option B, Documents only).** Every
Item keeps exactly one canonical parent; that parent alone defines
`parentItem`, `ancestors`, inherited access, subtree search, conversation
scope and ingestion `ancestor` selection. An *item link*
(`items/{collection}/links/{document}`, table `item_links`) additionally shows
a Document inside another Collection, like a Drive shortcut: same Item ID, no
copied object, no extra embeddings, no grant. Decisions:

- Targets are Documents only. Collection targets would allow navigation
  cycles and raise "does a linked subtree belong to this collection?" for
  search, scope and counts; no UX flow needs them.
- A link is shown only to callers who can read both the container and the
  target (invariant 3); otherwise it is absent, never "locked".
- Links are not hierarchy: they never change `ancestors`, `childCount`,
  `documentCount`, subtree filters or retrieval. Collections expose
  `linkCount`; clients list links with `ListItemLinks` next to `ListItems`.
- Lifecycle: moving the target keeps its links; moving it into a container
  that links it removes that link; deleting the container tombstones its links
  in the same cohort; a deleted target hides the link until undelete; links to
  a merged duplicate resolve to the merge target.
- Reading lists stay separate: they are audience-scoped (private, space,
  workspace), ordered and annotated, and live outside the tree; a link is
  governed by its container's access. Saved/recent items and space materials
  remain per-purpose references (`KNOWLEDGE_HUB.md:31,88`).

**4.3 No synthetic workspace root Item.** Root collections are the access
boundaries; a root Item would make every grant inherit from one place and adds
nothing the workspace scope does not already provide. Roots are listed with
`filter=parentItem=""`. Roots always store `inherit_access = false`.

**4.4 Personal collection stays a Collection** (`kind PERSONAL`, one per
member, owner grant only, not shareable, not deletable, not movable). It is
created with the membership; `Member.personalCollection` names it. Conversation
attachments live there with `purpose CONVERSATION_ATTACHMENT`. Tenant-wide
roles keep reading it, as today (`services/knowledge_items/item_store.py`).

**4.5 Artifacts stay an Assistant resource.** They already reuse the Item row
and revision table for storage and previews; exposing them through `items`
too would give one row two public resources. The items API, search and
ingestion exclude the `conversation_artifacts` system collection. Publishing
an artifact creates a new Document Item in a collection (`items.create`).

**4.6 Publication is a placement fact plus one flag.** A document is visible
to the readers of its governing collection when it is `PUBLISHED`; editors
also see `UNPUBLISHED` ones. A contributor's draft is a document in their
personal collection, so "private", "draft" and "in review" need no Item
state. `UNPUBLISHED` covers review-first sources and deliberate unpublishing.

**4.7 Contributions are a separate resource; approval never ingests.**
Approval moves the candidate into the target collection and publishes it, or
publishes a source candidate in place, or appends a revision to the replaced
document. Processing remains an explicit Ingestion Run (UI may offer
"approve and process" as two calls).

**4.8 One revision store for every Document.** `artifact_revisions` →
`item_revisions` (rename; same columns plus `contribution_id`,
`external_version`, `restored_from`). Upload creates revision 1; rollback and
approved revisions reuse stored objects, so a purge deletes an object only
when no revision of a non-purged Item still references its key.
`items.storage_key`, `mime_type`, `size_bytes` and `metadata.file_name` follow
the current revision (derived preview metadata is reset on change) so
ingestion reads every Document the same way; `items.indexed_revision_number`
names the revision the chunks, passages and citations belong to. Rejected: a
parallel `document_revisions` table (same shape, duplicate code).

**4.9 Moves are a custom method** (`:move`), not an Update of `parentItem`:
they need permission on two places and an index update. Crossing an access
boundary also needs `items.setIamPolicy` on the source boundary, so an editor
cannot widen or narrow who reads content. Source-managed items (including
source contribution candidates), candidates of open contributions and
conversation attachments cannot move. A document may move into the caller's
own personal collection (an owner taking content out); never into another
member's. A collection moved to the root becomes an access boundary.

**4.10 Retrieval: PostgreSQL decides, Qdrant pre-filters.** The payload keeps
`collection_item_id` (governing collection) and gains `published`. Search
pre-filters on `tenant_id`, `is_deleted = false` and
`collection_item_id ∈ readable` with `published = true OR collection_item_id ∈
editable` (both sets computed in PostgreSQL per request; `must_not published =
false`, so points without the key still match during the backfill), then
re-checks every hit in PostgreSQL (invariant 3) before any text reaches the
caller or the agent. Viewer, passage and citation reads authorize in
PostgreSQL and then fetch by `item_id`, never by the payload's collection, so
a lagging payload cannot hide content. A document move rewrites its chunks'
`collection_item_id` (no re-embedding); a collection move changes no payload
because governing collections inside the subtree do not change.
Move, publish, unpublish, delete and undelete set `items.payload_dirty_at` in
their transaction; the payload update runs after commit and a scheduled job
retries dirty rows, so the index converges durably without an outbox table.
Undelete un-tombstones the cohort's points (or sets `index_status pending`
if they were purged).

## 5. Database changes (`design.dbml`)

| # | Change | Legacy limitation | Alternatives considered | Data impact | API impact |
| --- | --- | --- | --- | --- | --- |
| 1 | `items.publication_state` (documents: `published`/`unpublished`) | no way to hide a document from readers without moving or deleting it | `metadata.published` (not constrainable, hot in every read); folding into `status` (mixes concerns) | existing documents become `published`; CHECK set exactly for documents | `document.publicationState`, `:publish`, `:unpublish` |
| 2 | `items.status` = content only (`pending`/`ready`/`failed`); deletion only `deleted_at` | `status = deleted` loses the prior state, so restore is impossible | `status_before_delete` column (legacy proposal; keeps the overload) | legacy deleted rows read as `ready` when `storage_key` is set, else `failed`; code reads `deleted_at`; tightened CHECK | `state`, `contentState` |
| 3 | subtree delete stamps one `deleted_at`; undelete restores that cohort | defect 5 | cohort table (unneeded: one transaction has one `now()`) | none; code change | `DeleteItem force`, `UndeleteItem` |
| 4 | roots `inherit_access = false`; `parent_relation` consistent with parent type; `embedded` dropped | defect 7; relation unchecked | leave as service-only rules | roots normalized; no `embedded` rows; CHECK + trigger | `parentRelation` readOnly |
| 5 | `artifact_revisions` → `item_revisions` + `contribution_id`, `external_version`, `restored_from` | problem 9 | new `document_revisions` table | table renamed; revision 1 for every document with `storage_key` (same key, no copy); per-version keys for future source syncs | `items/{item}/revisions`, `:rollback` |
| 6 | `contributions` (new) | no review workflow | `requests` (formerly `approval_requests`) with a new kind (different fields, lifecycle and visibility) | new table | Contribution resource |
| 7 | `ingestion_sources.publishing_policy` | no review-first sources | `config` JSON (connector-owned; this is core behaviour) | default `auto_publish` | `Source.publishingPolicy` |
| 8 | `reading_lists`, `reading_list_entries` (new) | no curation | Items of a new type (rejected, 4.2) | new tables | ReadingList resource |
| 9 | `role_assignments.all_members` | no "everyone in the workspace can view" | a synthetic group per tenant (membership sync burden) | new column, extended principal CHECK | `workspaceMembers` principal |
| 10 | partial index `items (tenant_id, parent_item_id) WHERE deleted_at IS NULL` | children/root listing scans tenant rows | none | new index | ListItems by `parentItem` |
| 11 | `items.indexed_revision_number` | content, passages and citations cannot say which revision they show once revisions exist | derive from `processed_version` (that is the configuration, not the content) | nullable; 1 for indexed documents | `document.indexedRevision`, `ItemContent.revision` |
| 12 | `items.payload_dirty_at` + partial index | a failed post-commit Qdrant update after a move/publish/delete is lost | outbox table; Temporal workflow start inside the transaction (not transactional) | nullable | none (consistency) |
| 13 | `saved_items`, `recent_items` (new) | draft `savedItems`/`recentItems` had no store | `users.preferences` JSON (unbounded, no FK, no per-item cleanup) | new tables | SavedItem, RecentItem |
| 14 | `contributions.external_version`; `ingestion_run_items.revision_number`, `error_class`; `ingestion_runs.trigger_type` `platform_retry`; `scope.item_ids` | review-first dedupe, mid-run revision changes, platform retry and error classes had no column | keep in JSON | nullable columns, extended value list | `Contribution.externalVersion`, `IngestionTask.revision`/`errorClass`, `trigger` |
| 15 | `item_links` (new) | a Document can appear only under its one canonical parent | second `parent_item_id` (breaks breadcrumbs, inheritance, moves); copies (duplicate objects and embeddings); reuse `reading_list_entries` (audience model, not in-tree) | new table; same-tenant/type trigger | ItemLink resource, `collection.linkCount` |
| 16 | `items.space_id` (promoted from `metadata.space_id`), FK to `spaces` | `collection.space` pointed at nothing; `Space.collections`, conversation `scope.spaces` and SPACE reading lists need an indexed reverse lookup | keep the key in `metadata` (no FK, no index, no same-tenant check) | nullable column, partial index, trigger (Collections only, same tenant) | `collection.space`, `Space.collections` |
| 17 | `topics`, `item_topics` (new); `metadata.topics` dropped | topic IDs sat in `metadata` with no topic table | `metadata.topics` array with a GIN index: no FK, MergeTopic rewrites every tagged document JSON, DeleteTopic "only when unused" and `documentCount` need a reverse scan, facets need an unnest per hit | new tables; a trigger keeps tags same-tenant and on Documents | Topic resource, `document.topics` filter and facet |
| 18 | `contribution_topics` (new); `suggestions` keeps only confidences and non-topic suggestions | suggested/proposed topics lived in `suggestions` JSON | keep them in JSON: `Topic.evidence`, `inReviewCount`, `:accept` and `:merge` retagging all look up by topic | new table | `ContributionSuggestions.topics`/`proposedTopics`, `Topic.evidence` |
| 19 | `artifacts`, `artifact_source_items`, `evidence_review_cells` (new), keyed by the Artifact's Item; `item_revisions.author` replaces `conversation_id`/`request_id` | Artifact kind, owner, space, audience, sources and evidence review had no store | everything in `items.metadata`: kind/owner/space/audience are filter and authorization inputs, sources need FKs and the audience check, cells are written concurrently and regenerated one by one; a non-Item artifact table (would duplicate revisions, objects and purge) | new tables; the Item row, revisions and objects stay as before | Artifact (Work kinds), `evidenceReview`, ArtifactRevision `author` |
| 20 | `code` on `reading_lists` (and the other client-ID resources, `database_architecture.md`) | `readingListId` had no column | use the uuid only (cannot honour client-chosen IDs) | new column, unique per tenant | `readingListId` |

Kept deliberately: `metadata` JSONB for sparse type-specific attributes
(collection: `description`, `discoverable`, `accepts_contributions`,
`system_kind`; document: `purpose`, `file_name`, `storage`, `archive`,
`source`, `preview`, `summary`, `language`, `owner_user_id`, `verification`,
`merged_into`; `verification` = `{state, verifier_user_id, verified_at,
next_review_at}`, `source` = the connector's source identity plus
`source_code` (the Source's API ID), `path`, `updated_at`), validated by the service and documented here; promote a key
to a column only when it becomes an authorization or hot filter input (as
`space_id` and topics did, rows 16–17). No uniqueness on `(parent, title)`
(same names are legitimate). Etag = `updated_at`. Persistence of the
non-Item API resources (spaces, requests, syncs, policies, saved searches,
operations, `requestId`) is justified in `database_architecture.md`, "API
resource persistence".

## 6. Authorization invariants

1. Tenant isolation: every Item, revision, contribution, reading-list entry
   and run task resolves to one tenant; same-tenant references are trigger-checked.
2. Effective permission on an Item = tenant-scope grants ∪ grants on its
   governing collection chain up to the first `inheritAccess = false`
   collection (`all_members` grants included). Only collections carry grants.
3. A document is visible iff ACTIVE, every ancestor ACTIVE, `items.get` holds
   there, and it is PUBLISHED or the caller holds `items.update` there. This
   is what "readable" means everywhere in the API (lists, search, facets,
   counts, ingestion tasks, attachments, artifact sources, references).
4. Contribution reviewers may GetItem, GetItemContent and download (`alt=media`)
   the candidate of an *open* contribution — nothing else: not list, search,
   attach, cite, copy or move it. `relatedItem` links (duplicate flags,
   quality issues) and `ancestors` (field and facet) are shown only for items
   the caller can read.
5. References (item links, reading lists, saved, recent, space materials, home, featured,
   citations in shares/artifacts) never grant access; every read re-checks 3
   and an unreadable referenced item answers exactly like an absent one.
6. A move that changes the governing boundary requires `items.setIamPolicy`
   on the source boundary as well as `items.create` on the destination. A
   subtree delete/undelete requires `items.delete`/`items.undelete` on every
   access boundary inside the cohort. DELETED items are visible only to
   `items.undelete` holders (grants resolve through the deleted cohort), and
   their content, passages and bytes are never served.
7. Search and the agent apply 3 in PostgreSQL to every hit before returning
   text; Qdrant filters are a performance pre-filter only. No cache: a grant,
   revoke, move, unpublish or delete is effective at the next request.
8. Signed URLs (`alt=media`, page assets, upload URIs) are issued only after
   the matching check, per request, short-lived.
9. Connector-ingested documents inherit from the source's target collection
   like any other document; provider ACLs are not imported.
10. Ingestion: explicit `items[]` are checked one by one (403); `ancestor`,
    `source` and `states` silently narrow to collections where the caller holds
    `ingestionRuns.create`; a selection without `items[]`/`ancestor` excludes
    personal collections; attachments, artifacts, unsupported and
    content-pending documents are never selected; tasks are listed only for
    items readable under 3.
11. A NEW_REVISION contribution targets the governing collection of the
    replaced document (server-set), so only that collection's reviewers can
    change its content.

## 7. Workflows

**Create a collection.** `CreateItem {itemType: COLLECTION, parentItem}` →
`items.create` on the parent (workspace for a root) → row with
`inherit_access` false for roots, true by default for nested → owner grant to
the creator for roots.

**Upload a document.** `CreateItem {itemType: DOCUMENT, parentItem, document
{fileName, mimeType, sizeBytes}, requestId}` → `items.create` on the
collection → Item (`contentState PENDING`, `publicationState PUBLISHED`,
`indexingState PENDING`) + `uploadUri` → client PUTs bytes to object storage →
`:completeUpload` validates size/type → `item_uploads.available`, `items.status
ready`, `item_revisions` #1. One-call variant: multipart
`/upload/api/v1/…/items`. Nothing is processed.

**Navigate.** Roots: `ListItems filter=parentItem=""` (+`showLocked`).
Children: `filter=parentItem="…/items/{c}"`, `orderBy=itemType,displayName`.
Breadcrumbs: `GetItem view=FULL` → `ancestors[]`. Subtree search:
`SearchItems filter=ancestors:"…/items/{c}"`.

**Move.** `:move {destinationParent, etag}` → checks (same workspace, live
COLLECTION destination or the workspace for a collection, not into own
subtree, not another member's personal collection, not source-managed, not a
candidate of an open contribution, not an attachment, `items.move` +
`items.create`, boundary rule) → update `parent_item_id` (trigger re-checks
cycles; a new root gets `inherit_access = false`), set `payload_dirty_at` →
after commit, payload `collection_item_id` update for moved documents and
their document children → audit event.

**Contribute and approve.** Member uploads to their personal collection →
`CreateContribution {item, targetCollection?, note}` (candidate ACTIVE and
AVAILABLE; `ANALYZING`, assistant suggestions and flags) → `IN_REVIEW`; while
open the candidate cannot move, be deleted or change content → reviewer
(`contributions.review` + `items.publish` on target) `:approve {etag,
targetCollection, documentType, topics, summary}` → in one transaction the
candidate moves through the Move routine and becomes `PUBLISHED` (or a
revision is appended) → contribution `APPROVED` → no run starts; the reviewer
or a schedule runs `CreateIngestionRun` when they choose. `:requestChanges`,
`:reject`, `:withdraw`, `:resubmit` change only the contribution.

**Publish / unpublish.** `:publish` / `:unpublish` flip
`publication_state` and set `payload_dirty_at`; the payload `published` flag
follows; index content is kept.

**Ingest.** `CreateIngestionRun {selector {items[], ancestor, source,
states[]}}` → invariant 10 → one `INSERT … SELECT` snapshot into
`ingestion_run_items` → Temporal processes; each task records the revision it
started from; on finish `index_status`, `processed_version` and
`indexed_revision_number` are written only if the item's current revision and
governing collection are unchanged (else `pending` + dirty payload); retries
are new runs over failed tasks.

**Search and retrieve.** `SearchItems` / agent retrieval → readable and
editable governing collections from PostgreSQL → Qdrant pre-filter (4.10,
optional subtree) → PostgreSQL re-check of hits (invariant 7) → passages with
citations (`items/{item}/passages/{chunk}`) of `indexed_revision_number`.

**Revise.** New content enters as a candidate document +
`CreateContribution {kind: NEW_REVISION, replacesItem}` (target = the
replaced document's governing collection); approval re-checks that the
document has not moved, appends `item_revisions` n+1 (object reused), moves
`storage_key`/`mime_type`/`size_bytes`/`file_name`, resets derived preview,
sets `index_status pending`, deletes the candidate. `:rollback` appends a
revision that reuses an older object; not on source-managed documents (the
source is the truth). Source syncs under `AUTO_PUBLISH` append a revision per
provider version (per-version object keys); under `REVIEW_FIRST` they create
one candidate + contribution per `(document, external_version)`.

**Link.** `CreateItemLink` on the container (`itemLinks.create`, target
readable, Document, not an attachment or open-contribution candidate, not
already a canonical child) → `item_links` row; `ListItemLinks` returns links
whose target the caller can read. `DeleteItemLink` tombstones the row.

**Merge.** `:merge {targetItem}` deletes the duplicate and records
`metadata.merged_into`; references and links resolve to the target at read
time (no rows move, so undelete only clears `merged_into`).

**Delete and restore.** `DeleteItem` (non-empty collection needs `force`;
foreign boundaries need their own `items.delete`) → one `deleted_at` on the
item and its live subtree, `payload_dirty_at` set; chunks are excluded at once
(re-check) and tombstoned in Qdrant; citations tombstoned. `:undelete` within
30 days restores the same cohort (parent must be live), un-tombstones its
points and citations (or sets `index_status pending` if purged). Purge after
`purgeTime` removes index points and objects no live revision references,
never the row.

## 8. Refactor sequence

The code moves from the legacy implementation to this design under the
schema-change policy of `database_architecture.md` ("Schema changes"): no
SQL migration files; `bomesh/db/models/` implements `design.dbml`. Existing
local data is not migrated: rebuild it with `make db-reset`, then re-sync
sources and re-ingest. A persistent environment that must keep its data needs
a one-off upgrade script, reviewed with the change and deleted after it runs.
The legacy routes are deleted; the contract is served under `/api/v1` on the
new schema.

1. **Schema (done).** `bomesh/db/models/` implements `design.dbml`: `publication_state`,
   content-only `status`, `indexed_revision_number`, `payload_dirty_at`,
   `all_members`, `publishing_policy`, the contribution/ingestion columns,
   `item_revisions` (replacing `artifact_revisions`), `contributions`,
   `reading_lists`, `reading_list_entries`, `item_links`, `saved_items`,
   `recent_items`, the partial indexes, the parent-relation trigger and the
   tightened CHECKs. Upload creates revision 1; membership creates the
   PERSONAL collection.
2. **Permissions and roles (done).** `bomesh/iam/catalog.py` replaced the
   legacy catalog (`bomesh.iam.sync` writes it); `bomesh/iam/authorizer.py`
   and `visibility.py` implement §6 including `all_members`. Legacy mapping:

   | Legacy code | Permissions | Held by |
   | --- | --- | --- |
   | `collection.read` | `items.get`, `items.list`, `items.search`, `tasks.list`, `tasks.get` | viewer, editor, owner, workspace admin |
   | `collection.update` | `items.create`, `items.update`, `items.move`, `items.publish`, `items.verify` | editor, owner, workspace admin |
   | `collection.delete` | `items.delete`, `items.undelete` | owner, workspace admin |
   | `collection.share` | `items.getIamPolicy`, `items.setIamPolicy`, `contributions.review` | owner, workspace admin |
   | `ingestion.run` | `ingestionRuns.create` | editor, owner, workspace admin |
   | `knowledge.manage` | `items.create` on the workspace (root collections) | workspace admin |
   | `knowledge.read` | `items.list`, `items.search`, `items.testIamPermissions`, `contributions.create`, `savedItems.*`, `recentItems.*`, `readingLists.get/list` | workspace member |

3. **Fix defects 5 and 8 (done)** (cascade delete with cohort stamp and the
   foreign-boundary check; exclude system collections from ingestion
   selection); switch viewer/citation fetches to `item_id`; add the
   PostgreSQL hit re-check and the `published` payload flag (the filter uses
   `must_not published=false`). `bomesh.services.knowledge_items` serves
   the Item part of the Knowledge interface; `reconcile_dirty_payloads` and
   `purge_deleted_items` run on the ingestion worker's maintenance schedules.
4. **Status and tree normalization** in code: read `deleted_at` for
   tombstones and resolve grants through deleted cohorts for undelete; stop
   writing `deleted`, `processing` or `unsupported` into `status`; write
   `parent_relation = contains` wherever the parent is a collection (fix
   `source_sync._parent_relation`); place conversation attachments in the
   owner's personal collection; create roots with `inherit_access = false`.
   An upgrade script for a persistent environment applies the same rules to
   existing rows: `deleted` → `ready` when `storage_key` is set, else
   `failed`; `processing`/`unsupported` → `ready`; documents `published`;
   revision 1 per document; personal collections for active members.
5. **Per-version source object keys (done).** `connector/originals.original_key`
   includes the provider version, so connector originals never overwrite an
   object an older revision or a review-first candidate still references.
6. **Serve the API (done)** under `/api/v1` (`openapi.yaml`): `items`, contributions,
   reading lists, saved/recent items, revisions, `:move`, item links.
7. **Cut clients over** (`apps/web`, mobile): the backend's legacy routes and
   the code that only served them are removed; the clients still call them.

Breaking for clients: one `items` resource replaces the legacy collection and
document resources; document status → `contentState`; processing state →
`indexingState`; the parent field → `parentItem`; uploads finish with
`:completeUpload`; search scopes use `filter ancestors:`.

## 9. Open decisions and risks

1. **UX wording.** The prototype calls reading lists "Collections" while the
   API's `COLLECTION` is the access boundary. Recommended: label reading lists
   "Reading lists" in `apps/ux_preview` before client work (not changed here).
2. **Tenant admins read personal collections** (current behaviour, kept).
   Confirm this is acceptable for "My files" privacy.
3. **No batch move/delete.** Bulk actions issue one call per item; add
   `items:batchMove` only if latency becomes a problem.
