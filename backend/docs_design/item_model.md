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
| Curation | none | — | `collections` (curated lists) + `collections/{c}/items` |
| Ingestion | `ingestion_runs` + `ingestion_run_items` snapshot by `INSERT … SELECT` under an advisory lock (now `services/ingestion/run_engine.py`) | same | `selector {documents, knowledgeBase}` |

UX (`apps/ux_preview/docs/KNOWLEDGE_HUB.md:22-33`, `DOCUMENT_LIFECYCLE.md`):
a document lives in exactly one knowledge base; saved, recent, spaces,
featured and topics *reference* it and never grant access; review is separate from processing; no nested-folder UI exists yet.

## 2. Problems found

1. **Two API identities for one row.** The pre-review draft exposed root collections as
   `knowledgeBases` and their documents as `documents`, while the database,
   permissions (`collection.*`), ingestion and citations all key on one Item ID.
   Nested collections had no API resource at all.
2. **"Collection" meant two things.** The DB/legacy Collection is an access
   boundary; the draft/UX "collection" was a curated list that must grant
   nothing. Resolved: `COLLECTION` is only the container and access boundary;
   curated lists are not part of the model.
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
 │   │    └─ Item ─ DOCUMENT        nested under a Document, source sync only
 │   └─ shortcuts/{document} ┄┄▶ DOCUMENT canonically elsewhere (item_shortcuts; no grant)
 ├─ Item ─ COLLECTION type PERSONAL one per member ("My files"); owner-only
 ├─ (hidden) COLLECTION type conversation_artifacts → Assistant `artifacts`
 │
 ├─ Contribution ──item──▶ candidate DOCUMENT ──target──▶ COLLECTION
 ├─ Space ── materials ──ref──▶ Item              (never grants access)
 ├─ Member ── savedItems / recentItems ──ref──▶ Item
 ├─ Source ──targetCollection──▶ COLLECTION; ExternalResource ──▶ DOCUMENT
 └─ IngestionRun ── tasks (snapshot) ──▶ DOCUMENT
```

| Resource | Owns | Lifecycle | Persistence |
| --- | --- | --- | --- |
| Item | identity, kind and type, hierarchy, name, kind facet | `ACTIVE` ⇄ `DELETED` (soft, 30-day retention, subtree cohort) | `items` |
| Item revision | immutable content version | append-only, tombstone | `item_revisions` (renamed `artifact_revisions`) |
| Upload ledger | idempotent upload of a revision's bytes; archive-member lineage | pending → available / failed; private | `item_uploads` |
| Contribution | review of one candidate document | `ANALYZING → IN_REVIEW ⇄ CHANGES_REQUESTED → APPROVED / REJECTED / WITHDRAWN` | `contributions` (new) |
| IAM policy | who holds which role on a collection | grant/revoke (tombstone) | `role_assignments` |
| Source / ExternalResource | provider scope and identity | unchanged | `ingestion_sources`, `external_resources` |
| Ingestion run / task | one processing execution over a snapshot | unchanged | `ingestion_runs`, `ingestion_run_items` |
| Citation / passage | chunk geometry for a document | replaced per indexing | `citations` |
| Item shortcut | shortcut of a Document inside another Collection | create / soft delete; follows the container's delete cohort | `item_shortcuts` (new) |
| Artifact | assistant output and its revisions | Assistant domain | Item row in a hidden system collection + `item_revisions` |

Document state is four independent fields, never collapsed:

| Field | Values | Source of truth | Changed by |
| --- | --- | --- | --- |
| `state` | `ACTIVE`, `DELETED` | `items.deleted_at` | Delete / Undelete |
| `document.contentState` | `PENDING`, `AVAILABLE`, `FAILED` | derived: `items.current_revision_id` set → `AVAILABLE`, else `item_uploads.status = failed` → `FAILED`, else `PENDING` | upload completion |
| `document.publicationState` | `PUBLISHED`, `UNPUBLISHED` | `items.is_published` | Publish / Unpublish, contribution approval, source policy |
| `document.indexingState` | `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, `OUTDATED`, `UNSUPPORTED` | `item_index_states.index_status` + `processed_version` | ingestion runs only |

Review state lives on the Contribution, not the Item.

## 4. Decisions

**4.1 One API resource, `workspaces/{workspace}/items/{item}`.** `itemKind`
selects exactly one facet (`collection` or `document`); common fields are
shared. Rejected: `documents` + `collections` as separate resources over one
table (two sources of truth, duplicated list/search/IAM/move code), and a
flat schema with every subtype column nullable. Names are flat (Drive-style,
`parentItem` is a field), so a move never renames an Item, its citations or
its references. The UX keeps its words: a root collection is a "knowledge
base", nested collections are folders, documents are documents.

**4.2 Canonical hierarchy plus item shortcuts (Option B, Documents only).** Every
Item keeps exactly one canonical parent; that parent alone defines
`parentItem`, `ancestors`, inherited access, subtree search, conversation
scope and the `ancestors:` filter of ingestion selectors. An *item shortcut*
(`items/{collection}/shortcuts/{document}`, table `item_shortcuts`) additionally
shows a Document inside another Collection, like a Drive shortcut: same Item
ID, no copied object, no extra embeddings, no grant. It was called an item
link; a URL handed to people is a Share (`resource_shares`,
`database_architecture.md` "Resource shares"), which is never part of the tree.
Decisions:

- Targets are Documents only. Collection targets would allow navigation
  cycles and raise "does a subtree reached through a shortcut belong to this
  collection?" for search, scope and counts; no UX flow needs them.
- A shortcut is shown only to callers who can read both the container and the
  target (invariant 3); otherwise it is absent, never "locked".
- Shortcuts are not hierarchy: they never change `ancestors`, `childCount`,
  `documentCount`, subtree filters or retrieval. Collections expose
  `shortcutCount`; clients list shortcuts with `ListItemShortcuts` next to
  `ListItems`.
- Lifecycle: moving the target keeps its shortcuts; moving it into a
  container that has a shortcut to it removes that shortcut; deleting the
  container tombstones its shortcuts in the same cohort; a deleted target hides
  the shortcut until undelete; MergeItem re-points shortcuts to a duplicate
  onto the kept Document.
- Saved/recent items and space materials remain per-purpose references
  (`KNOWLEDGE_HUB.md:31,88`); a shortcut is governed by its container's access.

**4.3 No synthetic workspace root Item.** Root collections are the access
boundaries; a root Item would make every grant inherit from one place and adds
nothing the workspace scope does not already provide. Roots are listed with
`filter=parentItem=""`. Roots always store `inherit_access = false`.

**4.4 Personal collection stays a Collection** (`itemType PERSONAL`, one per
member, owner grant only, not shareable, not deletable, not movable). It is
created with the membership; `Member.personalCollection` names it. Conversation
attachments live there with `purpose CONVERSATION_ATTACHMENT`. Tenant-wide
roles keep reading it, as today (`services/knowledge_items/item_store.py`).

**4.5 Artifacts stay an Assistant resource.** They already reuse the Item row
and revision table for storage and previews; exposing them through `items`
too would give one row two public resources. The items API, search and
ingestion exclude the hidden Collection of `item_type`
`conversation_artifacts`. Publishing
an artifact creates a new Document Item in a collection (`items.create`).

**4.6 Publication is a placement fact plus one flag.** A document is visible
to the readers of its governing collection when it is `PUBLISHED`; editors
also see `UNPUBLISHED` ones. A contributor's draft is a document in their
personal collection, so "private", "draft" and "in review" need no Item
state. `UNPUBLISHED` covers review-first sources and deliberate unpublishing.
The output `document.collectionKind` (`PERSONAL` under a member's My files,
else `STANDARD`) is derived from placement, not stored, and filterable, so a
surface can tell the private scope from shared knowledge even for callers
who read both (tenant admins, §9.2). Browse, the workspace's public knowledge,
lists only `STANDARD`, `PUBLISHED` documents whose processing finished
(`indexingState` `SUCCEEDED` or `OUTDATED`): an upload stays in My files; a
contribution appears once it is approved (moved and published) and processed.

**4.7 Contributions are a separate resource; processing comes before review.**
A reviewer first processes a NEW_DOCUMENT candidate with an explicit Ingestion
Run (Documents → Processing; `contributions.review` on the deciding collection
is enough to name it in `items[]`). Its CLASSIFYING step matches rules against
the target collection, not the contributor's PERSONAL one, and replaces the
contribution's suggested topics and summary: the assistant classifies, the
reviewer decides. Approval requires that processing (`CANDIDATE_NOT_PROCESSED`
otherwise; unsupported formats pass) and still never ingests: it moves the
candidate into the target collection and publishes it, or publishes a source
candidate in place — the index stays current, only the payload follows — or
appends a revision to the replaced document (NEW_REVISION), which is processed
by a run after approval. Rejected: processing on approval (the reviewer would
decide without the classification); an automatic run on submit (cost for
every declined file, and the reviewer chooses what to process).

**4.8 One revision store for every Document.** `artifact_revisions` →
`item_revisions` (rename; same columns plus `contribution_id`,
`external_version`, `restored_from`). Upload creates revision 1; rollback and
approved revisions reuse stored bytes by copying the revision's `content_id`
(the identity the object key is derived from, `database_architecture.md`
"Object storage"), so a purge deletes an object only when no live revision of
a non-purged Item still has that `content_id`. A revision owns everything
about its version — `content_id`, `mime_type`, `size_bytes`, `file_name` and
the derived `exports` (representation, cover, artifact preview) — and
`items.current_revision_id` names the one the Document shows, so `items`
copies none of it and no row stores an object key. The pointer is not derived
data kept by hand: a deferred constraint trigger requires it to be the newest
live revision of the Item and to be set whenever one exists
(`database_architecture.md`, "Current revision pointer"). A pending upload's
promise (`content_id`, type, size, name) is the private `item_uploads` row until
completion turns it into revision 1; a file extracted from a ZIP archive keeps
its lineage there (`archive_item_id`, `archive_path`). `item_index_states.indexed_revision_number`
names the revision the chunks, passages and citations belong to. Rejected: a
parallel `document_revisions` table (same shape, duplicate code); copying
`storage_key`/`mime_type`/`size_bytes`/`file_name` onto `items` (four columns
kept equal by hand, and an object key string in two tables); content-addressed
keys (`sha256` of the bytes: a presigned upload would need a staging object
and a server-side copy, or a client-supplied checksum, before its key exists).

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
Move, publish, unpublish, delete and undelete set `item_index_states.payload_dirty_at` in
their transaction; the payload update runs after commit and a scheduled job
retries dirty rows, so the index converges durably without an outbox table.
Undelete un-tombstones the cohort's points (or sets `index_status pending`
if they were purged).

**4.11 Kind and type are two axes.** `items.item_kind` (API `itemKind`:
`COLLECTION` | `DOCUMENT`) is the structural kind: it decides containment,
content ownership and whether grants are allowed. `items.item_type` (API
`itemType`, output only, UPPER_SNAKE) classifies an Item within its kind. Both
are immutable (the tree trigger rejects a change).

- Collections: `standard` (every Collection a client creates), `personal`
  (a member's My files, server-created) and `conversation_artifacts` (the
  hidden Collection that holds artifacts; never exposed). A non-standard
  Collection is never discoverable and never accepts contributions.
- Documents: the platform file class of the content, derived from the
  validated MIME type and file name by one shared function (the full
  per-extension list is the Format registry in `document_viewer.md`):

  | `item_type` | Formats |
  | --- | --- |
  | `pdf` | `application/pdf` |
  | `word` | DOCX, DOC |
  | `presentation` | PPTX, PPT |
  | `spreadsheet` | XLSX, XLS, CSV, TSV |
  | `markdown` | MD, Markdown, RST |
  | `html` | HTML, HTM |
  | `plain_text` | TXT, LOG, SQL, any other `text/*` |
  | `data` | JSON, JSONL, XML, YAML |
  | `image` | `image/*` |
  | `audio` | `audio/*` |
  | `video` | `video/*` |
  | `archive` | ZIP |
  | `other` | anything else |

  Every revision and pending upload of a Document maps to the same class;
  the exact MIME type stays on the revision or upload. CreateItem derives the
  class from the declared MIME type and file name; completion re-derives it
  from the validated object and fails the upload (`contentState FAILED`, error
  code `ITEM_TYPE_MISMATCH`) when it differs. A NEW_REVISION contribution whose
  candidate has another class than the replaced Document fails at create and
  at approve (`FAILED_PRECONDITION`, reason `ITEM_TYPE_MISMATCH`); an artifact
  revision of another class is `INVALID_ARGUMENT` with the same reason; a
  source version of another class is not appended (the current revision stays)
  and the sync reports the resource as failed.

The type is never a business taxonomy, an Artifact kind, a document purpose or
a tenant setting: subject classification is topics. Rejected: a free-form
document type with a per-workspace list of allowed values (an unchecked
string beside topics, filtered and faceted like them, with no rule tying it to
content); a separate discriminator for special Collections (a second
discriminator the authorizer and triggers had to read beside the kind).

**4.12 Merge re-points references.** `:merge {targetItem}` keeps one Document
and retires a duplicate in one transaction: every reference to the duplicate
(`item_shortcuts`, `saved_items`, `recent_items`, `space_materials`,
`message_items`) is re-pointed to the kept Document — set-based, deduplicated on
each table's unique key, so a reference the kept Document already has wins —
the duplicate is soft-deleted and an `audit_logs` row (action `merge`, subject
the duplicate, details `{target}`) records the merge. Reads never resolve
merges, so there is no merge pointer column and no merged-from field. Undelete
restores only the duplicate; the moved references stay on the kept Document.
Historical rows (topic corrections, audit, notifications) keep naming the
duplicate. Rejected: a merge pointer on the duplicate resolved at read time
(every reference read follows a chain, and readability is checked on a
different Item than the one stored).

## 5. Database changes (`design.dbml`)

| # | Change | Legacy limitation | Alternatives considered | Data impact | API impact |
| --- | --- | --- | --- | --- | --- |
| 1 | `items.publication_state` (documents: `published`/`unpublished`) | no way to hide a document from readers without moving or deleting it | `metadata.published` (not constrainable, hot in every read); folding into `status` (mixes concerns) | existing documents become `published`; CHECK set exactly for documents | `document.publicationState`, `:publish`, `:unpublish` |
| 2 | `items.status` dropped; deletion only `deleted_at`; `contentState` derived from `current_revision_id` and `item_uploads.status` | `status = deleted` lost the prior state, and a content status kept equal by hand to the revision pointer and the upload ledger could disagree with both | `status_before_delete` column (legacy proposal; keeps the overload); a content-only `status` column (a third copy of the same fact) | column dropped | `state`, `contentState` (unchanged values) |
| 3 | subtree delete stamps one `deleted_at`; undelete restores that cohort | defect 5 | cohort table (unneeded: one transaction has one `now()`) | none; code change | `DeleteItem force`, `UndeleteItem` |
| 4 | roots `inherit_access = false`; `embedded` dropped; the parent relation follows from the parent's type (the stored relation column is dropped by row 28) | defect 7; relation unchecked | leave as service-only rules | roots normalized; no `embedded` rows; CHECK + trigger | none |
| 5 | `artifact_revisions` → `item_revisions` + `contribution_id`, `external_version`, `restored_from` | problem 9 | new `document_revisions` table | table renamed; revision 1 for every document with `storage_key` (same key, no copy); per-version keys for future source syncs | `items/{item}/revisions`, `:rollback` |
| 6 | `contributions` (new) | no review workflow | `requests` (formerly `approval_requests`) with a new kind (different fields, lifecycle and visibility) | new table | Contribution resource |
| 7 | `ingestion_sources.publishing_policy` | no review-first sources | `config` JSON (connector-owned; this is core behaviour) | default `auto_publish` | `Source.publishingPolicy` |
| 8 | no curated-list tables | curated lists added a second, audience-scoped reference model beside shortcuts, saved items and space materials | curated-list tables (dropped with the feature); Items of a new type (rejected, 4.2) | none | no curated-list resource; Home `featured` is popular documents only |
| 9 | `role_assignments.all_members` | no "everyone in the workspace can view" | a synthetic group per tenant (membership sync burden) | new column, extended principal CHECK | `workspaceMembers` principal |
| 10 | partial index `items (tenant_id, parent_item_id) WHERE deleted_at IS NULL` | children/root listing scans tenant rows | none | new index | ListItems by `parentItem` |
| 11 | `indexed_revision_number` (on `item_index_states` since #24) | passages and citations cannot say which revision they show once revisions exist | derive from `processed_version` (that is the configuration, not the content) | nullable; 1 for indexed documents | `document.indexedRevision`, `ItemPassage.revision` |
| 12 | `payload_dirty_at` + partial index (on `item_index_states` since #24) | a failed post-commit Qdrant update after a move/publish/delete is lost | outbox table; Temporal workflow start inside the transaction (not transactional) | nullable | none (consistency) |
| 13 | `saved_items`, `recent_items` (new) | draft `savedItems`/`recentItems` had no store | `users.preferences` JSON (unbounded, no FK, no per-item cleanup) | new tables | SavedItem, RecentItem |
| 14 | `contributions.external_version`; `ingestion_run_items.revision_number`, `error_class`; `ingestion_runs.trigger_type` `platform_retry`; `scope.item_ids` | review-first dedupe, mid-run revision changes, platform retry and error classes had no column | keep in JSON | nullable columns, extended value list | `Contribution.externalVersion`, `IngestionTask.revision`/`errorClass`, `trigger` |
| 15 | `item_shortcuts` (new; first named `item_links`) | a Document can appear only under its one canonical parent | second `parent_item_id` (breaks breadcrumbs, inheritance, moves); copies (duplicate objects and embeddings); reuse a curated-list table (audience model, not in-tree) | new table; same-tenant/type trigger | ItemShortcut resource, `collection.shortcutCount` |
| 16 | no `items.space_id`; Space ↔ Item only through `space_materials` | a Collection-to-Space column duplicated what a Collection material says, so "which Items belong to this space" had two answers | keep the column beside materials (two truths that drift) | none | `Space.collections` = its Collection materials; conversation `scope.spaces` resolves materials |
| 17 | `topics`, `item_topics` (new); `metadata.topics` dropped | topic IDs sat in `metadata` with no topic table | `metadata.topics` array with a GIN index: no FK, MergeTopic rewrites every tagged document JSON, DeleteTopic "only when unused" and `documentCount` need a reverse scan, facets need an unnest per hit | new tables; a trigger keeps tags same-tenant and on Documents | Topic resource, `document.topics` filter and facet |
| 18 | `contribution_topics` (new); `suggestions` keeps only confidences and non-topic suggestions | suggested/proposed topics lived in `suggestions` JSON | keep them in JSON: `Topic.evidence`, `inReviewCount`, `:accept` and `:merge` retagging all look up by topic | new table | `ContributionSuggestions.topics`/`proposedTopics`, `Topic.evidence` |
| 19 | `artifacts`, `artifact_source_items`, `evidence_review_cells` (new), keyed by the Artifact's Item; `item_revisions.author` replaces `conversation_id`/`request_id` | Artifact kind, owner, space, audience, sources and evidence review had no store | everything in `items.metadata`: kind/owner/space/audience are filter and authorization inputs, sources need FKs and the audience check, cells are written concurrently and regenerated one by one; a non-Item artifact table (would duplicate revisions, objects and purge) | new tables; the Item row, revisions and objects stay as before | Artifact (Work kinds), `evidenceReview`, ArtifactRevision `author` |
| 20 | `code` on the client-ID resources (`database_architecture.md`) | client-chosen `{resource}Id` values had no column | use the uuid only (cannot honour client-chosen IDs) | new column, unique per parent | `{resource}Id` on Create |
| 21 | `topics.keywords`, `synonyms`, `guidance`, `example_item_ids`, `rule_collection_ids`, `rule_source_codes` | CLASSIFYING read only a topic's name and description; admins had nowhere to say what recognises a topic | a `topic_signals` table (no identity or lifecycle of its own: always read and written whole with the topic); one `classification` JSONB (untyped; arrays of IDs lose their element type) | empty arrays / null for existing topics | Topic `keywords[]`, `synonyms[]`, `guidance`, `examples[]`, `rules[]`; ImportTopics |
| 22 | `topic_corrections` (new) | a reviewer's change of the assistant's topics was lost, so nothing could suggest keywords from it | audit log rows (not listable by topic, no state); a column on `item_topics` (a correction outlives the tag set it changed) | new table, same-tenant trigger on the item | TopicCorrection resource |
| 23 | `items.publication_state` (`published`/`unpublished`) → `items.is_published` boolean | a two-value axis stored as text: wider rows, string compares in every visibility predicate | keep the text values (room for a third value no design asks for) | one non-destructive upgrade (`published` → true); CHECK set exactly for documents | none (`document.publicationState` unchanged) |
| 24 | `item_index_states` (new): `index_status`, `processed_version`, `indexed_revision_number`, `payload_dirty_at` moved off `items` | every processing step and payload sync rewrote the `items` row and moved `updated_at`, so processing changed `updateTime` and the etag and churned the widest table | keep on `items` and stop bumping `updated_at` (the row is still rewritten several times per run); derive from `ingestion_run_items` (filters and facets on `indexingState` need a per-row latest-task lookup, and UNSUPPORTED / `processed_version` still need a home) | 1:1 rows created by the AFTER INSERT trigger `trg_items_index_state`; existing values copied; a trigger rejects rows of Collections | none (`document.indexingState`, `indexedRevision` unchanged) |
| 25 | `items.storage_key`, `mime_type`, `size_bytes` and `metadata.file_name`/`storage`/`preview`/`cover` dropped; `items.current_revision_id` (FK) added; `item_revisions.storage_key` → `content_id` (uuid) + `file_name`; cover moved to `item_revisions.exports.cover`; `item_uploads` gains `content_id`, `mime_type`, `size_bytes`, `file_name` | every content field existed twice (item and revision) and was kept equal by hand in five code paths; object keys were stored strings in three tables and two JSON documents (provider paths and file names inside keys); covers and representations had to compare a `source` key string to tell whether they were current | keep the copies and add CHECKs (still two writes per change); content-addressed keys (staging + copy for presigned uploads); store the key and only drop the copies (a stored key can still drift from its row) | `database_architecture.md` "Object storage": derived keys under `content/`, `derived/`, `assets/`, `exports/`; existing objects need a copy to the new keys (an upgrade script only for an environment that keeps data) | none (`document.mimeType`, `sizeBytes`, `fileName`, revisions unchanged) |
| 26 | `operations.result_object_key` dropped; `tenants.settings.branding.map_background.object_key` → `image_id` | object keys stored as strings | keep them | export and map image keys derived from the operation id and `image_id` | none |
| 27 | `items.metadata` dropped: `description`, `discoverable`, `accepts_contributions` (collections), `purpose`, `summary`, `language_code`, `owner_user_id`, `verification_state`, `verified_by_user_id`, `verified_at`, `next_review_at` (documents) added; the archive member lineage → `item_uploads.archive_item_id`/`archive_path`; `metadata.source`/connector keys → the Document's `external_resources` row (`external_resources.metadata` → `provider_data`; `canonical_external_id` dropped, it always equalled `external_id`); the archive expansion summary → `item_revisions.exports.archive`; `access_sessions.metadata` and `memories` dropped | the keys were authorization inputs (the special Collections in the ancestry CTE, PERSONAL, triggers), filters and facets (owner, language, verification, source) and references (the merge target, the archive) with no type, FK, CHECK or index; provider facts sat on the canonical Item; `owner_summary` was never written and `file_name` was forbidden yet written by file processing | keep the JSON with key CHECKs (still untyped, no FKs, every reader parses text); a promoted subset (two conventions) | one non-destructive upgrade per key; `owner_user_id`/verifier become FKs; CHECKs keep collection-only and document-only columns on their type, a trigger keeps archive sources same-tenant Documents | none (`collection.*`, `document.*`, `origin`, `verification` read the columns; `ownerSummary` stays empty) |
| 28 | `items.parent_relation` and `items.verification_state` dropped | the relation duplicated the parent's `item_type` (`contains` under a Collection, forced by the tree trigger) and nothing behaved differently for the source-sync `child`/`attachment` labels; the verification state was only `verified` or null, tied to `verified_at` by a CHECK | keep both behind CHECKs (two writes per change, nothing reads them); move the provider label to `external_resources.provider_data` (no reader; the connector's own metadata keeps it there already) | columns dropped; verified ⇔ `verified_at IS NOT NULL`; the tree trigger keeps only same-tenant live parents, no cycles and no Document → Collection | `Item.parentRelation` removed; `document.verification.state` unchanged (computed) |
| 29 | `items.item_type` (collection \| document) → `item_kind`; new `item_type` = classification scoped by kind (4.11); the special-Collection discriminator, the free-form document type column and its tenant settings list dropped | the structural kind was called a type, special Collections needed a second discriminator, and a free-form document type duplicated topics with nothing tying it to content | keep a second discriminator beside the kind; keep the document type with a tenant list | `(tenant_id, item_kind, item_type)` index; CHECKs on the collection types; immutability in the tree trigger; revision and upload triggers keep a Document's file class | `itemKind` (required on create), output-only `itemType`; the collection kind field, the document type field and its workspace list removed; filter/facet `itemType` |
| 30 | `items.merged_into_item_id` dropped; MergeItem re-points references (4.12) | read-time resolution followed chains on every reference read | keep the pointer | none | the merge pointer and merged-from fields removed |
| 31 | `items.archive_item_id`/`archive_path` → `item_uploads` | where uploaded bytes came from is a fact of the upload, not of the canonical Item | keep on `items` | CHECK both-or-neither; partial index on `archive_item_id` | none |
| 32 | `topic_corrections.from_topic_ids`/`to_topic_ids`/`state`/`updated_at` → `topic_correction_changes (topic_correction_id, topic_id, change_type)` + `dismissed_at` | UUID arrays had no FK and no index for "corrections that added or removed this Topic"; the state duplicated the dismiss time | GIN indexes on the arrays (still no FK or same-tenant check) | new child table (PK correction + topic; index `(topic_id, change_type, topic_correction_id)`); a deferred trigger requires at least one change | none (`fromTopics` = removed, `toTopics` = added; `state` from `dismissed_at`) |
| 33 | `messages.status`, `groups.status`, `group_memberships.status` dropped | each duplicated a timestamp (`superseded_at`, `deleted_at`) | keep them behind CHECKs | none | none |
| 34 | name columns renamed to `<entity>_name` (`users.login_name`, `users.user_name`, `tenants.tenant_name`, `items.item_name`, …); `items.summary` folded into `description`; `artifacts.owner_user_id`, `created_at`, `updated_at` dropped (the Item's) | `display_name`/`title` on every table read ambiguously in joins; two description columns on one row; artifact owner and times duplicated the Item's | keep the names | none | none (`displayName`, `title`, `summary` unchanged) |

No item column is a JSON document: every attribute is a typed column, the
provider facts of a synced Document live in `external_resources.provider_data`
and products of content in `item_revisions.exports`
(`database_architecture.md` "JSON columns"). A Document is verified when
`verified_at` is set, else UNVERIFIED; REVIEW_DUE is computed from
`next_review_at`. `document.origin` is the Document's `external_resources` row
(`source_url`, `provider_data.path`, `external_updated_at`) and its Source's
`code`. No uniqueness on `(parent, title)`
(same names are legitimate). Etag = `updated_at`. Persistence of the
non-Item API resources (spaces, requests, syncs, policies, saved searches,
operations, `requestId`) is justified in `database_architecture.md`, "API
resource persistence".

## 6. Authorization invariants

1. Tenant isolation: every Item, revision, contribution, reference and run
   task resolves to one tenant; same-tenant references are trigger-checked.
2. Effective permission on an Item = tenant-scope grants ∪ grants on its
   governing collection chain up to the first `inheritAccess = false`
   collection (`all_members` grants included). Only collections carry grants.
3. A document is visible iff ACTIVE, every ancestor ACTIVE, `items.get` holds
   there, and it is PUBLISHED or the caller holds `items.update` there. This
   is what "readable" means everywhere in the API (lists, search, facets,
   counts, ingestion tasks, attachments, artifact sources, references).
4. Contribution reviewers may GetItem, GetItemPreview and download (`alt=media`)
   the candidate of an *open* contribution — nothing else: not list, search,
   attach, cite, copy or move it. `relatedItem` links (duplicate flags,
   quality issues) and `ancestors` (field and facet) are shown only for items
   the caller can read.
5. References (item shortcuts, saved, recent, space materials, home, featured,
   shares, citations in shared conversations and artifacts) never grant access; every read re-checks 3
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
10. Ingestion: explicit `items[]` are checked one by one (403); the selector
    `filter` silently narrows to collections where the caller holds
    `ingestionRuns.create`, and an item it names must be readable (403);
    personal collections are selected only by `items[]` or an item the filter
    names; the candidate of an open NEW_DOCUMENT contribution may also be named
    in `items[]` by holders of `contributions.review` on its deciding
    collection; attachments, artifacts, unsupported and content-pending documents
    are never selected; tasks are listed only for items readable under 3.
11. A NEW_REVISION contribution targets the governing collection of the
    replaced document (server-set), so only that collection's reviewers can
    change its content.

## 7. Workflows

**Create a collection.** `CreateItem {itemKind: COLLECTION, parentItem}` →
`items.create` on the parent (workspace for a root) → row with
`inherit_access` false for roots, true by default for nested → owner grant to
the creator for roots. The row's `item_type` is `standard`.

**Upload a document.** `CreateItem {itemKind: DOCUMENT, parentItem, document
{fileName, mimeType, sizeBytes}, requestId}` → `items.create` on the
collection → Item (`item_type` = the file class of the declared MIME type and
name; `contentState PENDING`, `publicationState PUBLISHED`, `indexingState
PENDING`) + `uploadUri` → client PUTs bytes to object storage →
`:completeUpload` validates size, type and file class → `item_uploads.available`,
`item_revisions` #1 and `current_revision_id` (`contentState AVAILABLE`), or
`item_uploads.failed` (`contentState FAILED`; `ITEM_TYPE_MISMATCH` when the
class differs). One-call variant: multipart
`/upload/api/v1/…/items`. Nothing is processed.

**Navigate.** Roots: `ListItems filter=parentItem=""` (+`showLocked`).
Children: `filter=parentItem="…/items/{c}"`, `orderBy=itemKind,displayName`.
Breadcrumbs: `GetItem view=FULL` → `ancestors[]`. Subtree search:
`SearchItems filter=ancestors:"…/items/{c}"`.

**Move.** `:move {destinationParent, etag}` → checks (same workspace, live
COLLECTION destination or the workspace for a collection, not into own
subtree, not another member's personal collection, not source-managed, not a
candidate of an open contribution, not an attachment, `items.move` +
`items.create`, boundary rule) → update `parent_item_id` (trigger re-checks
cycles; a new root gets `inherit_access = false`), set `item_index_states.payload_dirty_at` →
after commit, payload `collection_item_id` update for moved documents and
their document children → audit event.

**Contribute and approve.** Member uploads to their personal collection →
`CreateContribution {item, targetCollection?, note}` (candidate ACTIVE and
AVAILABLE; `ANALYZING`, rule suggestions and flags) → `IN_REVIEW`; while
open the candidate cannot move, be deleted or change content → reviewer
processes it: `CreateIngestionRun {items: [candidate]}` (CLASSIFYING rules
against the target collection; on a current index the chosen topics and
summary replace the contribution's suggestions) → reviewer
(`contributions.review` + `items.publish` on target; NEW_DOCUMENT candidate
processed, else `CANDIDATE_NOT_PROCESSED`) `:approve {etag,
targetCollection, topics, summary}` → in one transaction the
candidate moves through the Move routine and becomes `PUBLISHED` (or a
revision is appended) → contribution `APPROVED` → no run starts: a moved
candidate keeps its current index (payload re-synced); an appended revision is
processed by a later `CreateIngestionRun`. `:requestChanges`,
`:reject`, `:withdraw`, `:resubmit` change only the contribution.

**Publish / unpublish.** `:publish` / `:unpublish` flip
`is_published` and set `payload_dirty_at`; the payload `published` flag
follows; index content is kept.

**Ingest.** `CreateIngestionRun {selector {items[], filter},
classification}` → invariant 10 → one `INSERT … SELECT` snapshot into
`ingestion_run_items` (the filter is the ListItems filter compiled once) →
an ingestion worker claims the QUEUED run (advisory lock; recovered and resumed
by another worker if it dies) and processes it; each task records the revision it started from; on
finish `item_index_states` (`index_status`, `processed_version`, `indexed_revision_number`) and the
CLASSIFYING step's assistant-applied `item_topics` (`document_contract.md`
"Processing") are written only if the item's current revision and governing
collection are unchanged (else `pending` + dirty payload); retries are new runs
over failed and cancelled tasks with the same classification. Runs never change
`is_published` and never write the `items` row.

**Search and retrieve.** `SearchItems` / agent retrieval → readable and
editable governing collections from PostgreSQL → Qdrant pre-filter (4.10,
optional subtree) → PostgreSQL re-check of hits (invariant 7) → passages with
citations (`items/{item}/passages/{chunk}`) of `indexed_revision_number`.

**Revise.** New content enters as a candidate document +
`CreateContribution {kind: NEW_REVISION, replacesItem}` (target = the
replaced document's governing collection; a candidate of another file class
is `ITEM_TYPE_MISMATCH` at create and approve); approval re-checks that the
document has not moved, appends `item_revisions` n+1 with the candidate's
`content_id` (bytes reused, never copied) and points `current_revision_id` at
it, sets `index_status pending`, deletes the candidate. `:rollback` appends a
revision that reuses an older `content_id`; not on source-managed documents (the
source is the truth). Source syncs under `AUTO_PUBLISH` append a revision per
provider version (a `content_id` derived from the provider version; a version
of another file class is not appended and the sync reports it); under
`REVIEW_FIRST` they create one candidate + contribution per
`(document, external_version)`.

**Shortcut.** `CreateItemShortcut` on the container (`itemShortcuts.create`,
target readable, Document, not an attachment or open-contribution candidate,
not already a canonical child) → `item_shortcuts` row; `ListItemShortcuts`
returns shortcuts whose target the caller can read. `DeleteItemShortcut`
tombstones the row.

**Merge.** `:merge {targetItem}` → in one transaction, set-based `UPDATE`s
re-point the duplicate's shortcuts, saved and recent items, space materials and
message attachments to the target (rows the target already has win), the
duplicate is soft-deleted and an `audit_logs` row records the merge (4.12).
Undelete restores only the duplicate.

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
The contract is served under `/api/v1` on the new schema.

1. **Schema (done).** `bomesh/db/models/` implements `design.dbml`:
   `item_kind`/`item_type`, `is_published`, `item_index_states`,
   `all_members`, `publishing_policy`, the contribution/ingestion columns,
   `item_revisions` (replacing `artifact_revisions`), the guarded
   `current_revision_id`, `contributions`, `item_shortcuts`, `saved_items`,
   `recent_items`, `topic_correction_changes`, the partial indexes, the tree,
   revision and upload triggers and the tightened CHECKs. Upload creates revision 1; membership creates the
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
   | `knowledge.read` | `items.list`, `items.search`, `items.testIamPermissions`, `contributions.create`, `savedItems.*`, `recentItems.*` | workspace member |

3. **Fix defects 5 and 8 (done)** (cascade delete with cohort stamp and the
   foreign-boundary check; exclude system collections from ingestion
   selection); switch viewer/citation fetches to `item_id`; add the
   PostgreSQL hit re-check and the `published` payload flag (the filter uses
   `must_not published=false`). `bomesh.services.knowledge_items` serves
   the Item part of the Knowledge interface; `reconcile_dirty_payloads` and
   `purge_deleted_items` run on the ingestion worker's maintenance schedules.
4. **Status and tree normalization (done)** in code: tombstones are
   `deleted_at` and grants resolve through deleted cohorts for undelete;
   `contentState` is derived (no status column); conversation attachments live
   in the owner's personal collection; roots are created with
   `inherit_access = false`.
5. **Derived object keys (done).** No row stores an object key: content is
   `content/{tenant}/{content_id}`, a source original's `content_id` is derived
   from its provider version, so a new version never overwrites bytes an older
   revision or a review-first candidate still shows (`database_architecture.md`
   "Object storage").
6. **Serve the API (done)** under `/api/v1` (`openapi.yaml`): `items`, contributions,
   saved/recent items, revisions, `:move`, item shortcuts.
7. **Cut the client over (done):** `apps/web` calls only the `/api/v1`
   contract; the backend serves no other routes.

Breaking for clients: one `items` resource replaces the legacy collection and
document resources; document status → `contentState`; processing state →
`indexingState`; the parent field → `parentItem`; uploads finish with
`:completeUpload`; search scopes use `filter ancestors:`.

## 9. Open decisions and risks

1. **Tenant admins read personal collections** (current behaviour, kept).
   Confirm this is acceptable for "My files" privacy.
2. **No batch move/delete.** Bulk actions issue one call per item; add
   `items:batchMove` only if latency becomes a problem.
