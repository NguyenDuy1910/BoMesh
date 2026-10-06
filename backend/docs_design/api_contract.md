# BoMesh API Contract

Status: canonical implemented API contract. Authentication details are locked
in `auth_contract.md`; Document/content details are locked in
`document_contract.md`. Both are mirrored in the checked-in OpenAPI contract.

Code, frontend callers, and the checked-in OpenAPI snapshot use this contract.
No compatibility aliases are part of this contract.

Base URL: `/api/v1` for product APIs. `/health` remains unversioned liveness.

## Contract rules

1. URL paths identify domain resources. Caller role never creates a second
   resource namespace.
2. Public API uses `workspace` terminology. Persistence may continue using
   `tenant_id` internally until a migration is justified.
3. Resource IDs use the full domain name and UUID format where durable IDs are
   UUIDs: `workspace_id`, `user_id`, `role_id`, `group_id`, `collection_id`,
   `document_id`, `connection_id`, `source_id`, `ingestion_run_id`,
   `approval_request_id`, and `artifact_id`.
4. Temporal workflow IDs, storage keys, vector IDs, and provider IDs are
   internal implementation details. They never become public primary IDs.
5. JSON fields use `snake_case`; URL resources use plural nouns and kebab-case
   for compound nouns.
6. Every normal success response has a concrete schema. Paginated responses
   use `{items, page, page_size, total}`.
7. Pagination query fields are `page`, `page_size`, `search`, `sort`, and
   `direction`; `page >= 1`, `1 <= page_size <= 100`, and direction is `asc` or
   `desc`.
8. Authenticated identity comes from access-session context. Request bodies
   never supply caller `user_id`, `workspace_id`, roles, or permissions.
9. Workspace permission, platform permission, and Collection ACL remain
   separate authorization scopes.
10. Strict multi-tenancy: every caller is an authenticated User. A User
   reaches a workspace only through an active membership plus role
   assignments in that workspace; platform permissions never grant workspace
   data access. There is no anonymous or public-workspace access.
11. DELETE means lifecycle removal/tombstone. State changes use PATCH.
12. `Idempotency-Key` is required for upload creation and other retry-sensitive
   non-idempotent writes.

## Authentication and security

OpenAPI defines this default security scheme:

```yaml
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
security:
  - bearerAuth: []
```

Account creation and session creation override the default with `security: []`.
Current-session read/logout require bearer authentication. Health also overrides
the default with `security: []`. Protected operations document workspace
capabilities using `x-required-permissions` and effective resource permissions
using `x-required-collection-permission`. Conditional ownership/reviewer rules
are documented separately; they are not unconditional workspace requirements.

Runtime workspace permissions are `tenant.read`, `tenant.manage`,
`user.manage`, `role.manage`, `group.manage`, `knowledge.read`,
`knowledge.manage`, `collection.read`, `collection.update`,
`collection.share`, `collection.delete`, `source.manage`, `ingestion.read`,
`ingestion.run`, `ingestion.manage`, `access.manage`, and `audit.read`. There
are no `iam.*`, `item.*`, `knowledge.documents.*`, or `knowledge.collections.*`
capabilities, and no `graph.*` capability until a knowledge graph exists.

Knowledge and Ingestion are separate capability families:

| Family | Permission | Scope | Grants |
| --- | --- | --- | --- |
| Knowledge | `knowledge.read` | tenant | search and chat over permitted knowledge |
| Knowledge | `knowledge.manage` | tenant | create workspace Collections |
| Knowledge | `collection.read/update/share/delete` | tenant or Collection | read, add/remove content, share, delete a Collection |
| Ingestion | `source.manage` | tenant | connections, sources, sync, schedules |
| Ingestion | `ingestion.run` | tenant or Collection | start processing for a Collection's Documents |
| Ingestion | `ingestion.read` | tenant | see every run in the workspace (others see runs they started) |
| Ingestion | `ingestion.manage` | tenant | cancel any run |

Effective Collection permissions combine the caller's workspace grants with
direct and inherited user/group ACL grants, so a scoped grant such as
`collection.read` or `ingestion.run` on one Collection is a Collection-role
assignment, not a separate mechanism. `knowledge.manage` alone does not grant
Collection visibility. Document reads use `collection.read`; creation, content
finalization, and deletion use `collection.update` (ACL editor or equivalent).
The system Collection roles are owner (`read, update, share, delete,
ingestion.run`), editor (`read, update, ingestion.run`) and viewer (`read`).
Search also requires `knowledge.read`. Private conversation attachments remain
owner-only, including deletion; Collection editor access does not override this.

Error body is stable across API failures:

```json
{
  "code": "COLLECTION_ACCESS_DENIED",
  "message": "You do not have access to this collection.",
  "request_id": "uuid",
  "details": {}
}
```

Documented status classes: `400`, `401`, `403`, `404`, `409`, `413`, `415`,
`422`, `429`, and `500`.

Authentication failures use stable codes: `INVALID_CREDENTIALS`,
`SESSION_EXPIRED`, `ACCOUNT_ALREADY_EXISTS`, `ACCOUNT_DISABLED`, and
`TOO_MANY_ATTEMPTS`. Password and external-provider login failures use the
same generic `INVALID_CREDENTIALS` message so callers cannot enumerate
accounts. `DELETE /auth/session` is idempotent at transport level once the
current Session has been resolved.

## Final endpoint map

All paths below are relative to `/api/v1`.

### Authentication

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/auth/accounts` | public | Create local account and first session |
| POST | `/auth/sessions` | public | Authenticate and create one Session |
| GET | `/auth/session` | bearer | Read current authenticated Session/context |
| PATCH | `/auth/session` | bearer | Change active workspace on current Session |
| DELETE | `/auth/session` | bearer | Invalidate current Session |

`POST /auth/sessions` is a single resource operation. Its typed request
discriminator is `method` and supports only `password` and `google`; any other
method returns `422 VALIDATION_ERROR`. Adding an authentication provider adds a
request variant, not another top-level route. Account and session creation are
fully public and accept no optional bearer.

`AuthSession` and `CurrentSession` expose a required `user_id`,
`active_workspace_id`, and `workspaces` (real memberships only); there is no
`session_kind` field. Internal `active_tenant_id` and `tenants` are not public
fields. Current identity is always resolved from the bearer session; no caller
identity fields are accepted by `GET`, `PATCH`, or `DELETE /auth/session`.

Password login uses `method: "password"` with exactly one of `email` or
`username`, plus `password`. Account `email` remains the canonical credential
identifier; optional account `username` is also accepted for local sign-in.
Google login uses `method: "google"` with the verified provider credential.
Workspace switching uses `PATCH /auth/session` with `active_workspace_id`,
requires bearer authentication, and returns `403` when the User has no active
membership in the target workspace. All Session-creation variants return the
same `AuthSession` response.

No password-reset or password-change route is part of this contract yet: the
current product has no implemented password recovery/change use case. Add
`/me/password` or password-reset resources only when that lifecycle is built.

### Agent and knowledge projections

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/agent/chat` | bearer | Grounded SSE chat turn |
| GET | `/knowledge/home` | bearer | UI projection: collections, recent documents, personal collection |
| GET | `/knowledge/documents/{document_id}` | bearer | Permission-checked document viewer |
| GET | `/knowledge/documents/{document_id}/citations/{chunk_id}` | bearer | Permission-checked document citation resolution |

`ChatRequest` contains only `message`, `conversation_id`, `history`,
`collection_ids`, and `attachment_ids`.

`attachment_ids` names Documents for this turn by id: a file uploaded into the
conversation, or any existing Document the caller can read (for example one
picked from document search, "Ask about this"). Each id is authorized like any
Document read; referencing never copies the Document or changes its owner.
Clients delete only Documents they uploaded as `conversation_attachment`; a
referenced Document is never removed with the conversation.

`GET /knowledge/documents/{document_id}` returns the document's `elements`, its
renderable `preview` (signed URLs, resolved per read), and, when `?chunk=` names
a passage, `focus` (`chunk_id`, `chunk_text`, `citation`) plus a signed
`document_url`. Citations and document search open the viewer at that passage.

`GET /knowledge/home` is intentionally not a Collection list. It is a read
projection and has no Collection mutation behavior.

### Collections and Collection ACL

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET | `/collections` | bearer | filter by effective `collection.read` |
| POST | `/collections` | bearer | `knowledge.manage`; child also requires parent `collection.update` |
| GET | `/collections/{collection_id}` | bearer | effective `collection.read` |
| PATCH | `/collections/{collection_id}` | bearer | effective `collection.update` |
| DELETE | `/collections/{collection_id}` | bearer | effective `collection.delete` |
| GET | `/collections/{collection_id}/access` | bearer | effective `collection.share` |
| PUT | `/collections/{collection_id}/access/{principal_type}/{principal_id}` | bearer | effective `collection.share` |
| DELETE | `/collections/{collection_id}/access/{principal_type}/{principal_id}` | bearer | effective `collection.share` |
| POST | `/collections/{collection_id}/documents` | bearer | effective `collection.update`; signed-in user |
| PUT | `/collections/personal` | bearer | signed-in user with `knowledge.read` |

`principal_type` is `user` or `group`. PUT body is `{ "role": "owner" |
"editor" | "viewer" }`; principal identity is in URL. Internal role codes stay
`collection_owner`, `collection_editor`, and `collection_viewer`; both the
list and the PUT response map them to `owner|editor|viewer`. Each
`CollectionAccess` also carries a read-only `principal_name` (group display
name, else user display name or email; `null` if the principal is gone) so
clients can say who holds a role without a directory lookup.

`Collection.permissions` is the effective caller-specific permission list,
not the ACL role name or a global permission catalogue. Clients use it to
enable resource actions. Listing, reading, updating, and deleting Collections
do not additionally require `knowledge.manage`; creation does, including children.
An inaccessible Collection is hidden as `404`; a readable Collection with an
insufficient mutation permission returns `403`.

### Documents and content

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/documents` | bearer | Permission-filtered document collection |
| GET | `/documents/{document_id}` | bearer | Document metadata and lifecycle |
| PUT | `/documents/{document_id}/content` | bearer | Validate reserved content and make it available |
| DELETE | `/documents/{document_id}` | bearer | Delete document from normal use |
| POST | `/documents/search` | bearer | Permission-filtered semantic search |

`POST /collections/{collection_id}/documents` is the only Document creation
operation. It accepts `multipart/form-data` for direct upload and
`application/json` for presigned upload reservation. Both paths create the
Document first and return `DocumentCreateResult`; no public Upload resource or
`upload_id` exists.

`PUT /documents/{document_id}/content` finalizes a presigned object by checking
server-owned storage metadata. Document status is limited to
`pending_content|available|failed`.

Those are public API states. Internal Item and upload-ledger statuses may use
different storage-oriented values and must be mapped at the API boundary.

Adding a Document only adds it to the inventory. Neither creation transport
nor content finalization parses, indexes, or starts any processing: the
Document reads back with `processing.state = pending`. An archive is one
pending Document until a run processes it, which unpacks its members into new
pending Documents of the same Collection and processes them in that run.
Archives are accepted only into workspace Collections (not personal uploads
or conversation attachments). A conversation attachment is read by the agent
directly from its stored original, so it needs no run to be usable in chat.

Every `Document` carries `processing = {state, error, run_id}`:

- `state` is `pending | processing | ready | failed | outdated | unsupported`.
  `outdated` is a ready Document whose index was built with a processing
  configuration (parser, chunker, embedding model, index schema,
  contextualization model) that has since changed; `unsupported` content
  (for example an image attached to a conversation) is kept but never
  processed.
- `error` and `run_id` come from the Document's latest Ingestion Run item:
  the reason, written for people, that it could not be processed, and the run
  to open for detail.

Processing, re-processing and retrying are all `POST /ingestion-runs`; there
is no Document-level processing route.

### Artifacts

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/artifacts/{artifact_id}` | bearer | Artifact and revisions |
| GET | `/artifacts/{artifact_id}/revisions/{revision}/content` | bearer | Revision content |
| POST | `/artifacts/{artifact_id}/publish` | bearer | Publish revision into Collection |

`ArtifactContent.content` is a text revision's text. Every revision that is
not Markdown (Word, Excel, PDF, CSV, image) also returns `preview`, the same
object the Knowledge document viewer returns (`original`, page `assets`,
`rendition`; see document_viewer.md), so clients render it with the shared
document view. Each revision is previewed on its first read by the Knowledge
parse and preview pipeline and its manifest is kept in
`artifact_revisions.exports.preview`; later reads only re-sign URLs. A
Markdown revision's `preview` is `null`.

A file saved during a chat turn is announced twice: live, as the export
tool's `artifact` progress, and durably, as a zero-width `bomesh:artifact`
annotation (`artifact`: id, title, file_name, mime_type, revision,
size_bytes, updated_at) at the end of the first answer text that follows it,
once per revision. Clients rebuild a restored conversation's file cards from
the annotation, as they rebuild citations.

### Connections and sources

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/connections/providers` | bearer | Connector capabilities |
| GET | `/connections` | bearer | Authorized connections |
| POST | `/connections` | bearer | Create credential-backed connection |
| POST | `/connections/authorizations` | bearer | Start provider authorization |
| GET | `/connections/{connection_id}` | bearer | Connection detail |
| PATCH | `/connections/{connection_id}` | bearer | Partial update or state change |
| DELETE | `/connections/{connection_id}` | bearer | Lifecycle removal |
| POST | `/connections/{connection_id}/validate` | bearer | Validate provider grant |
| GET | `/connections/{connection_id}/resources` | bearer | Reachable provider resources |
| POST | `/connections/{connection_id}/sources` | bearer | Create source from provider resource |
| GET | `/sources` | bearer | Authorized ingestion sources |
| GET | `/sources/{source_id}` | bearer | Source detail |
| PATCH | `/sources/{source_id}` | bearer | Partial source update |
| DELETE | `/sources/{source_id}` | bearer | Lifecycle removal |
| POST | `/sources/{source_id}/syncs` | bearer | Sync now: register what changed |
| GET | `/sources/{source_id}/schedule` | bearer | Schedule state |
| PUT | `/sources/{source_id}/schedule` | bearer | Replace/upsert schedule |
| PATCH | `/sources/{source_id}/schedule` | bearer | Change schedule fields, including `enabled` |
| DELETE | `/sources/{source_id}/schedule` | bearer | Remove schedule |

There are no `/schedule/pause` or `/schedule/resume` commands. Pause/resume is
`PATCH` with `{ "enabled": false|true }`.

A `Connection` states whose account it uses through `account: {label,
resource_label}`, whether its contents can be listed through `browsable`, and
its health facts `status_detail`, `connected_at` and `last_checked_at`. The
provider's own account and resource ids stay private (rule 4).

`GET /connections/{connection_id}/resources` answers for every browsable
connection. A provider sign-in is asked through its provider; a credential the
connector can browse with (a connector declaring `resource_discovery`, e.g. a
Confluence API token) is listed through the connector. Confluence lists spaces,
then a space's top-level pages, then a page's children; pages are identified as
`page:<id>`, and a selected page becomes a source covering that page and its
subtree.

Personal Connections are owned and managed by their caller; workspace-owned
Connections require `source.manage`. Source visibility follows its Connection.
A Source's `connection_id`, destination `collection_id`, `resource_type`, and
`external_resource_id` are selected at creation and cannot be patched. To
change that binding, create a new Source. `PATCH /sources/{source_id}` accepts
`display_name`, `status`, and `config`; supplying `config` replaces the entire
connector scope/configuration, not a merge, and resets the checkpoint so the
next sync rediscovers the scope. Schedules have their own resource.

A sync changes only the inventory. It discovers what changed at the provider,
stores each new or changed original in object storage (key
`tenants/{tenant}/sources/{connection}/{provider}/{external_id}/{file_name}`),
registers or updates its Document (back to `pending` when the provider
version, ETag or stored original changed; an unchanged Document keeps its
state and is not downloaded again, so unchanged data is never reprocessed),
and tombstones Documents removed at the source (their index content and
citations are removed at once, so deleted data stops being retrievable). It
never parses or indexes. Creating a Source starts its first sync; if that
cannot start, the Source is still created and its sync reads as failed. `POST
/sources/{source_id}/syncs` starts one and returns `202` with the Source. It
follows the rule of every other Source change (`source.manage` for a
workspace Connection, the owner for a personal one); a sync already running,
or a paused, disabled or reconnect-required Source, is `409` with the reason.

`Source.sync` is the latest sync: `{status: running|succeeded|failed,
last_synced_at, error, added, updated, removed, failed}`, `null` before the
first one. `failed` means the sync itself stopped (connection, sign-in,
provider error); Documents that could not be fetched leave it `succeeded` with
`failed > 0`, a user-safe `error`, and the checkpoint unadvanced so the next
sync tries them again. `Source.pending_documents` counts the Source's
Documents that are pending or outdated. A schedule means "sync, then process
what changed": each firing syncs the Source and, if anything is pending or
outdated, creates one `scheduled` Ingestion Run for exactly those Documents.

### Ingestion runs

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| POST | `/ingestion-runs` | bearer | `ingestion.run` on every selected Document's Collection |
| GET | `/ingestion-runs` | bearer | `ingestion.read` for every run; otherwise runs the caller created |
| GET | `/ingestion-runs/{ingestion_run_id}` | bearer | as list |
| GET | `/ingestion-runs/{ingestion_run_id}/items` | bearer | as list; items in unreadable Collections are omitted |
| POST | `/ingestion-runs/{ingestion_run_id}/cancel` | bearer | creator or `ingestion.manage` |
| POST | `/ingestion-runs/{ingestion_run_id}/retry` | bearer | `ingestion.run` on the retried Documents |

An Ingestion Run is the only way Documents are processed (parsed,
contextualized, chunked, embedded, indexed). Manual (`trigger: manual`, a
person in a BoMesh client), API (`trigger: api`, the default) and scheduled
triggers all go through `IngestionRunService.create_run`; there is no
upload-, source- or retry-specific processing path. One run is one Temporal
workflow over many Documents: 100 selected Documents are one run, never 100
workflows.

`IngestionRunCreate` selects Documents. `document_ids` (≤ 1000) names them
explicitly, in any state, which is how a re-index is asked for; otherwise the
run takes the Documents under `collection_id` (its whole subtree), of
`source_id`, or of the whole workspace (personal Collections excluded), whose
state is in `states` (`pending | failed | outdated | ready`, default `pending`
and `outdated`). At least one selector is required (`422`). Only Documents
the caller may process count: an unreadable named Document is `404`, a
readable one without `ingestion.run` is `403`. Documents already queued or
running in another run are left out; if nothing remains the answer is `409`
with the reason "Nothing to process: …" (errors use the API's shared error
body). The selection is snapshotted when the run is created, so Documents
added while it runs wait for a later run; an archive in the run is the one
exception, since its unpacked members join the run (so `counts.total` can
grow). `POST` answers `202` with the run, or `503` "Processing could not be
started. Try again in a moment." when the workflow cannot start (the run is
then recorded as failed).

`IngestionRun` is `{id, status, trigger, scope, counts, error, created_by,
configuration, created_at, started_at, finished_at, updated_at}`:

- `status`: `queued | running | completed | failed | cancelled`. A run that
  processed every Document is `completed` even when some of them failed;
  `failed` means the run itself stopped (for example the model provider
  refused the account's key or credit), with the reason in `error`; its
  unprocessed Documents are `skipped`.
- `counts`: `{total, queued, running, succeeded, failed, skipped, cancelled}`.
- `scope`: `{selected_documents, collection_id, source_id, states,
  retry_of_run_id}` as asked.
- `configuration`: the processing configuration fixed at creation
  (`processing_version`, models, batching limits) — technical detail.

`GET /ingestion-runs/{ingestion_run_id}/items` pages
`{document_id, name, collection_id, status, phase, error, chunk_count, phases,
started_at, finished_at}`, running and failed first. `status` is `queued |
running | succeeded | failed | skipped | cancelled`; `phases` are `parsing ·
contextualizing · embedding · storing` (archives: `downloading · expanding`)
with timings. `error` carries only messages written for people;
infrastructure causes are logged, never returned.

`cancel` stops a queued or running run (`409` once finished). It answers
`202` with the run already `cancelled` and its queued Documents `cancelled`;
Documents in flight stop at their next step and return to `pending`, and
`finished_at` is set when they have. `retry` creates a new `manual` run over
the failed, cancelled and skipped Documents of a run (`scope.retry_of_run_id`
set; `409` "Nothing to retry: …" when there are none) — nothing is uploaded
again.

Execution: the workflow plans the snapshot into batches packed by size
(bounded by `BOMESH_INGESTION_BATCH_MAX_ITEMS` and
`BOMESH_INGESTION_BATCH_MAX_BYTES`), runs at most
`BOMESH_INGESTION_RUN_PARALLELISM` batch activities at once, records every
Document's status and phases in PostgreSQL as it goes, retries a failed batch
without redoing its finished Documents (after the last attempt, that batch's
unfinished Documents fail with "Processing was interrupted before it
finished." and the run goes on), and continues as new when its history
grows. One Document's failure never fails the others. Postgres is the only
store of run state; Temporal ids stay internal and nothing reads Temporal
visibility. A run whose workflow was lost (terminated, never dispatched) is
reconciled to `failed` at startup or when read. Clients poll run detail
(about every 2s while it runs); there is no push channel.

### Workspace IAM and governance

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET | `/workspaces` | bearer | workspace membership or platform scope |
| GET | `/workspaces/{workspace_id}` | bearer | active workspace context |
| PATCH | `/workspaces/{workspace_id}` | bearer | `tenant.manage` |
| GET | `/workspaces/{workspace_id}/overview?tz=` | bearer | `tenant.read` |
| GET | `/workspaces/{workspace_id}/activity?window=&tz=` | bearer | `audit.read` |
| GET | `/users` | bearer | `user.manage` |
| POST | `/users` | bearer | `user.manage` |
| GET | `/accounts?email=` | bearer | `user.manage` |
| GET | `/users/{user_id}` | bearer | `user.manage` |
| PATCH | `/users/{user_id}` | bearer | `user.manage` |
| GET | `/roles` | bearer | `role.manage` |
| POST | `/roles` | bearer | `role.manage` |
| GET | `/roles/{role_id}` | bearer | `role.manage` |
| PATCH | `/roles/{role_id}` | bearer | `role.manage` |
| GET | `/groups` | bearer | `group.manage` |
| POST | `/groups` | bearer | `group.manage` |
| GET | `/groups/{group_id}` | bearer | `group.manage` |
| PATCH | `/groups/{group_id}` | bearer | `group.manage` |
| PUT | `/groups/{group_id}/members` | bearer | `group.manage` |
| DELETE | `/groups/{group_id}` | bearer | `group.manage` |
| GET | `/permissions` | bearer | `role.manage` |
| POST | `/approval-requests` | bearer | requester context |
| GET | `/approval-requests` | bearer | own/reviewable requests |
| GET | `/approval-requests/{approval_request_id}` | bearer | own/reviewable request |
| PATCH | `/approval-requests/{approval_request_id}` | bearer | requester/reviewer capability |
| GET | `/audit-logs` | bearer | `audit.read` |
| GET | `/access-sessions` | bearer | `audit.read` |

Approval requester identity always comes from `AuthContext`; request body has
no `requester_user_id`.

Requesters may list/read their own requests and cancel a pending request
without reviewer permissions. Reviewers may read and decide `resource_access`
requests with `access.manage`, or `plugin_installation` requests with
`source.manage`; approval/denial always requires the matching reviewer
permission, even for one's own request. Plugin request creation also requires
`source.manage`. Only pending requests can transition; a completed decision
cannot be changed. `ApprovalRequest.requester` is `{id, email, display_name}`,
not a workspace `User` and has no `status`. `requested_role` is nullable
`{id, code, display_name}`; decision metadata is `decision_note`,
`decided_by_user_id`, `decided_at`, and `updated_at`.

`Role` includes `tenant_id` (nullable for global definitions), `scope_type`,
`is_system`, and `member_count`. Workspace role routes expose tenant-scoped
roles; system roles cannot be edited. Permission replacement cannot exceed
the caller's own grants; `/permissions` lists assignable tenant permissions.
Supplying `RoleUpdate.permission_codes` replaces that role's permission set;
omitting it preserves the set.

Roles and groups are created by name: `code` is optional on `RoleCreate` and
`GroupCreate` and, when omitted, the server derives a unique internal code from
the name (accents folded, `-2`, `-3`… on collision). Codes stay internal
identifiers; clients for people never show or ask for them, and describe a
role by what its permissions allow rather than by permission codes.
`GET /roles` never lists a retired (inactive) built-in role; a disabled custom
role stays listed so it can be enabled again, but is not offered for
assignment.

`Group.members` contains `{id, email, display_name, joined_at}` on detail reads;
list/mutation responses may use the default empty list, so load group detail
before editing membership. `member_count` remains the actual active count.
`PUT /groups/{group_id}/members` replaces the complete set (`[]` removes all).
For `GroupUpdate`, an omitted `description` preserves it; explicit `null`
clears it. Supplied `UserUpdate.role_ids` and `group_ids` likewise replace the
workspace assignment sets, while omitted fields preserve them.

Workspace overview requires `tenant.read`, not `audit.read`. Its
`recent_activity` is empty when the caller lacks `audit.read`; overview does
not expose audit records through a weaker permission. Its `knowledge` and
`usage` blocks are aggregate counts only (no identities, no audit rows), so
`tenant.read` suffices for them:

- `knowledge` = `{collections, documents, ready, processing, pending, failed,
  outdated}` over non-deleted Items (`status <> 'deleted'`, `deleted_at`
  null), with Document counts by `processing.state` (as on `Document`);
  `unsupported` Documents count only in `documents`.
- `usage` = `{timezone, buckets, totals, previous}`: 30 daily buckets of
  `{start, active_users, questions, sign_ins}` (oldest first, zero-filled);
  `totals` covers the last 7 local days — the same span as the `7d` activity
  window — and `previous` the equally long span immediately before it.

Overview's optional `tz` (IANA name, default `UTC`; unknown is `422`) is the
wall clock that cuts the usage days.

A workspace never creates identities. `POST /users` adds an existing account
(found by exact email) as a member: an unknown email is `404` and the person
signs up first; an active or suspended member is `409`; a removed member is
readmitted with exactly the roles given. `GET /accounts?email=` resolves one
whole address to `{id, email, display_name, status, workspace_membership}` so
the console can confirm who is being added; fragments never match, so a
workspace administrator cannot browse other workspaces' people.

Suspension (`PATCH /users/{user_id}` `status: suspended|active`) is a
membership state of this workspace only. It never disables the account, its
sign-in, or its other workspaces; account-wide disabling is a platform concern.

Guard rules (all `409`, enforced in the identity services): a caller can never
change their own workspace access — `PATCH /users/{own id}` with `role_ids`,
`group_ids` or `status` is refused; the last active workspace administrator
cannot be suspended or lose the administrator role; a caller cannot change the
permissions of, or disable, a role they hold; and a custom role cannot be
disabled while active members hold it (reassign them first). Granting a role
(`POST /users`, `UserUpdate.role_ids`) or writing a role's permissions cannot
exceed the caller's own permissions (`422`). There is no member removal or role
deletion endpoint: suspension and role disabling are the reversible
equivalents. The web console (Manage → People & access) mirrors these rules —
your own row and roles you hold are shown read-only with the reason, abilities
you lack cannot be switched on, and "Disable role" explains how many members
still hold the role — and still relies on the server's answer.

Approval decisions are final (`pending` is never re-entered), so the web
console's Undo after Approve holds the `PATCH` for a few seconds and sends it
only when the Undo window closes (or when the reviewer leaves the page).

#### Workspace activity

`GET /workspaces/{workspace_id}/activity` (`audit.read`) reports the caller's
active workspace; another workspace's id is `404`, as for overview.
`window` is `24h` (24 hourly buckets), `7d` (7 daily), or `30d` (30 daily),
default `7d`; `tz` is an IANA name, default `UTC`, unknown is `422`. Buckets
are cut on the `tz` wall clock (`date_trunc` over `ts AT TIME ZONE tz`), every
bucket in the window is emitted oldest first and zero-filled, and each `start`
carries the zone's offset. The window runs from `start` (the oldest bucket's
start) to `generated_at`; `previous` covers the equally long span immediately
before `start`.

All counts are scoped to the workspace and to timestamps inside the span:

| Count | Source |
| --- | --- |
| `sign_ins` | `access_sessions` of kind `user` created in the span; a `tenant_switch` child counts (it enters this workspace) |
| `questions` | `messages` with role `user` in the workspace's conversations, attributed to the conversation owner |
| `conversations` | `conversations` created in the span |
| `changes` / `failed_changes` | `audit_logs` in the span / those with `outcome <> 'success'` |
| `active_users` | distinct users over: session users whose `created_at` or `last_seen_at` is in the span, question authors, audit actors |

`live_sessions` counts sessions stored `active` whose `expires_at` and
`idle_expires_at` (when set) are still in the future. `sign_in_methods` groups
the window's sign-ins by `authentication_method`, count descending.
`top_changes` is the 8 most frequent audit actions with their failed count.
`people` is the 10 most active users — ordered by `questions + sign_ins +
changes` descending, then `last_active_at` descending — where
`last_active_at` is the latest of that user's presence timestamps above.

#### Access sessions

`GET /access-sessions` (`audit.read`) pages the active workspace's `user`
sessions newest first (`created_at` desc, then `id`), filtered by optional
`status` (`active` | `ended`), `user_id`, and `search` (case-insensitive on the
user's email or display name). Each `AccessSessionRecord` is `{id, user {id,
email, display_name}, authentication_method, entry, status, started_at,
last_seen_at, ended_at, end_reason, expires_at, current}`:

- `entry` is `sign_in` for a fresh session and `workspace_switch` for a
  `tenant_switch` child.
- `status` is effective: a row still stored `active` whose absolute or idle
  expiry has passed is `expired`, with `ended_at` the expiry that lapsed and
  `end_reason` `session_expired`. `status=active` returns effectively active
  rows; `status=ended` returns all others.
- `current` marks the caller's own session.

Token versions, session metadata, and identity-provider subjects are never
returned.

### Platform scope

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/platform/overview` | `platform.tenant.read` |
| GET | `/platform/workspaces` | `platform.tenant.read` |
| GET | `/platform/users` | `platform.user.read` |
| GET | `/platform/audit-logs` | `platform.audit.read` |
| GET | `/platform/health` | `platform.health.read` |

No `/admin/platform/*`, `/admin/*`, `/admin/spaces`, or `/admin/collections`
routes exist in final contract.

## Lifecycle and ID mapping

| Legacy concept | Final public concept | Internal compatibility |
| --- | --- | --- |
| `tenant_id` | `workspace_id` | DB/service field may remain `tenant_id` |
| `active_tenant_id` | `active_workspace_id` | token claim mapped at API boundary |
| `tenants` | `workspaces` | auth response only |
| `integration_connection_id` | `connection_id` | service method migration required |
| `workflow_id`, `ingestion_id` | `ingestion_run_id` | Temporal ID stays private; one run spans many Documents |
| `doc_id` | `document_id` | route/path/schema rename |
| public `upload_id` | `document_id` | internal one-to-one upload ledger remains private |
| `item_id` for Collection | `collection_id` | Item remains internal aggregate |
| `item_id` for document viewer | `document_id` | indexed Item identity stays internal |
| `requester_user_id` | authenticated requester | remove from DTO |
| `/agent/collections` | `/collections` | remove duplicate route |
| `/knowledge/collections` | `/collections`, `/knowledge/home` | split resource/projection |
| `/admin/*` workspace resources | root resource paths | remove namespace |
| `/admin/platform/*` | `/platform/*` | platform-only permission |
| `/documents/{document_id}/retry`, `/ingestions/{ingestion_id}/retry` | `POST /ingestion-runs` or `POST /ingestion-runs/{ingestion_run_id}/retry` | one processing entry point |
| `/items/{item_id}/retry`, `POST /documents/{document_id}/ingestions` | `POST /ingestion-runs` with `document_ids` | one processing entry point |
| `POST /sources/{source_id}/ingestions` | `POST /sources/{source_id}/syncs` (inventory) + `POST /ingestion-runs` (processing) | sync and processing are separate |
| `/document-uploads` | `/collections/{collection_id}/documents` | upload is Document creation transport |
| `/documents/{document_id}/complete` | `PUT /documents/{document_id}/content` | finalize Document content |
| `/schedule/pause`, `/schedule/resume` | `PATCH .../schedule` | state update |

## Contract-first implementation gate

Before changing application code:

1. `endpoint_inventory.md` covers every current registered route.
2. Target OpenAPI paths and schemas are reviewed against this document.
3. Every final route has one owning service/use-case and permission rule.
4. Every frontend caller has a migration mapping.
5. Then migrate routers, DTOs, services, authorization, clients, tests, and
   generated OpenAPI in one breaking-refactor pass.

## Proposed — UI built, API pending

Status: proposed, not implemented. Nothing in this section is in
`openapi.yaml` or the endpoint map above, and no backend route serves it. The
WebUI already ships these screens against typed client functions whose bodies
call `pendingApi(<key>, …)` (`web/src/lib/api/pending.ts`); a local
implementation in `web/src/lib/api/pending/<feature>.ts` answers with the
shapes below, mirrors the permission rules below, keeps its state in the
browser (`localStorage` namespaced `bomesh.pending.<key>.<account>.<workspace>`)
and never writes to a real endpoint. Each subsection's anchor equals
`PENDING_FEATURES[key].docsAnchor`. Builds choose which pending features they
render with `NEXT_PUBLIC_BOMESH_PENDING_FEATURES=all|none|<comma list>`
(unset means `all`, so production deployments set it explicitly) and the
neutral Preview marker with `NEXT_PUBLIC_BOMESH_PENDING_MARKER=on|off`.

All proposed endpoints follow the contract rules above: `/api/v1` base,
bearer authentication unless marked public, `snake_case` JSON, the stable
error body (`code`, `message`, `request_id`, `details`), identity from the
access session (never from the body), and `404` for resources the caller
cannot see.

Swap procedure when a backend lands (docs/ux-refactor-plan.md §7): implement
the endpoint with the shapes below, replace the client function body with the
real request, delete the local implementation and its `PENDING_FEATURES`
entry, remove the Preview marker, then move the contract from this section
into the endpoint map (and `openapi.yaml`). Components and tests must not
change; helpers marked "part of `<key>`" (local overlays) are deleted with the
local implementation.

### <a id="proposed-auth-password-reset"></a>Password reset — `auth.password_reset`

Lets a person who forgot their password set a new one from an emailed link.
This is the recovery lifecycle that "Authentication" above says is not built yet.

| Method | Path | Auth |
| --- | --- | --- |
| POST | `/auth/password-resets` | public (`security: []`) |
| POST | `/auth/password-resets/{token}/complete` | public (`security: []`) |

Request `POST /auth/password-resets`:

```json
{ "email": "linh@example.com" }
```

Response `202` — identical whether or not an account uses the address, so the
endpoint cannot be used to discover accounts. When an active account exists,
the server emails a single-use link `/auth/password-reset/{token}`:

```json
{ "status": "accepted", "expires_in_minutes": 30 }
```

Request `POST /auth/password-resets/{token}/complete`:

```json
{ "password": "a-new-password" }
```

Response `200`:

```json
{ "status": "completed" }
```

Completing sets the password hash, consumes the token, and ends every active
Session of the account (`access_sessions` → revoked); no new Session is
returned, the person signs in with the new password.

Errors: `422 VALIDATION_ERROR` (malformed email; password outside 8–128
characters, as `AccountCreate`), `404 PASSWORD_RESET_INVALID` for an unknown,
expired or already used token (one message for all three), `429
TOO_MANY_ATTEMPTS` per email and per client.

Screens: `/auth/login` ("Forgot password?"), `/auth/password-reset` (request
and "check your email"), `/auth/password-reset/[token]` (set a new password).

Local implementation: `lib/api/pending/password-reset.ts`. No email is sent;
the link is written to the browser console (`[pending-api] auth.password_reset
link: …`). Tokens live in a browser-wide store; no real password changes.

Persistence (proposed): `password_reset_tokens` (see `design.dbml`).

### <a id="proposed-artifact-manual-revision"></a>Edit an artifact by hand, restore a version — `artifact.manual_revision`

Appends a revision written by a person (an edit in the file panel, or a
restore of an earlier revision) instead of by the agent.

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| POST | `/artifacts/{artifact_id}/revisions` | bearer | artifact owner (the owner of its conversation) |
| DELETE | `/artifacts/{artifact_id}/revisions/{revision}` | bearer | artifact owner |

Request (`Idempotency-Key` required):

```json
{ "content": "# Plan\n\nEdited by hand", "summary": "Fixed the intro", "restored_from": null }
```

- `summary` is required (1–200 characters).
- `content` is the full new text of a text artifact (Markdown, plain text,
  CSV, JSON, other `text/*`). It may be omitted only when `restored_from` is
  set; the server then copies that revision's stored object byte for byte
  (this is how binary revisions are restored).
- `restored_from` names an existing revision of the same artifact; it is kept
  as provenance on the new revision.

Response `201` — the new `ArtifactRevision` (as in `ArtifactDetail.revisions`,
plus `restored_from`); the artifact's current revision becomes it:

```json
{ "revision": 4, "summary": "Restored version 2", "size_bytes": 1840, "created_at": "2026-10-05T09:12:00Z", "download_url": "https://…", "restored_from": 2 }
```

Errors: `404` artifact not visible or `restored_from` unknown, `403` readable
but not owned, `415 UNSUPPORTED_MEDIA_TYPE` `content` sent for a binary
artifact, `413` content above the artifact size limit, `422
VALIDATION_ERROR` (summary missing/too long, neither `content` nor
`restored_from`), `409 IDEMPOTENCY_KEY_REUSED`.

`ArtifactRevision.restored_from` (nullable) and `ArtifactRevision.author`
(`assistant` | `user`) are added to every revision read, so the version list
can say "By the assistant", "Edited by you" or "Restored by you".

`DELETE /artifacts/{artifact_id}/revisions/{revision}` is the Undo toast after
an edit or restore: it removes the artifact's current revision when a person
made it (`author: user`) less than 10 minutes ago, and the previous revision
becomes current again. Response `204`. Errors: `404` not visible or unknown
revision, `403` not owned, `409 CONFLICT` not the current revision, made by
the agent, or older than 10 minutes (history is otherwise never rewritten).

Screens: the chat file panel (`/chat/[conversationId]`): Edit → "Save as
version N" (Undo), version list and old-version banner → Restore (Undo).
Only text artifacts (Markdown, plain text) offer Edit; every kind offers
Restore.

Local implementation: `lib/api/pending/artifacts.ts`. Reads the real artifact
to number the revision (next after the highest real or local one); keeps
hand-made revisions with their content in the browser, keyed by artifact id.
`applyLocalArtifactChanges(detail)` and `listLocalArtifactRevisions(id)` (part
of this key, exported from `modules/chat/api.ts`) merge them into real reads;
a local revision whose number the server later uses moves after the real ones.
`deleteArtifactRevision(id, revision)` (same key) drops the newest local
revision within the same 10-minute window. A local revision cannot be saved
to knowledge: publishing still saves the server's newest revision, and the
publish dialog says so.

Persistence (proposed): `artifact_revisions.restored_from`; `author` is derived
from the existing `request_id` / `created_by_user_id` (see `design.dbml`).

### <a id="proposed-artifact-rename"></a>Rename an artifact — `artifact.rename`

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| PATCH | `/artifacts/{artifact_id}` | bearer | artifact owner |

Request:

```json
{ "title": "Q3 plan" }
```

Response `200` — the full `ArtifactDetail` with the new `title` (`file_name`
and revisions are unchanged; the title is a display name, not a new revision).

Errors: `404` not visible, `403` not owned, `422 VALIDATION_ERROR` (empty
after trimming, more than 200 characters).

Screens: the chat file panel header and file card menu (Rename).

Local implementation: `lib/api/pending/artifacts.ts`; requires a reachable API
(it returns the real detail with the local title applied). Persistence: the
artifact Item's existing `items.title`; no schema change.

### <a id="proposed-artifact-export-formats"></a>Download an artifact in another format — `artifact.export_formats`

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET | `/artifacts/{artifact_id}/revisions/{revision}/export?format=csv\|pdf\|md` | bearer | read the artifact (as `GET /artifacts/{artifact_id}`) |

Response `200` — the converted file as the body (`text/csv; charset=utf-8`
with a byte-order mark, `application/pdf`, or `text/markdown; charset=utf-8`)
and `Content-Disposition: attachment; filename="<title>.<ext>"`.

- `csv`: a CSV revision as stored; otherwise the revision's tables (Markdown
  tables, or every sheet of a spreadsheet) one after another, separated by a
  blank row.
- `md`: Markdown/plain text as stored; CSV as a Markdown table; other text in
  a code fence; binary files from the revision's rendition (headings, text,
  tables, links).
- `pdf`: the server renders the original revision with its layout.

Errors: `404` not visible or unknown revision, `415 UNSUPPORTED_MEDIA_TYPE`
the revision cannot be converted to that format, `422 VALIDATION_ERROR`
unknown `format` or no table to export as CSV.

Screens: the chat file panel and file card download menu (Download as CSV /
PDF / Markdown).

Local implementation: `lib/api/pending/artifacts.ts` + `artifact-export.ts`
convert in the browser from the revision content (or its preview rendition)
and return a real file Blob. Honest limits of the local version: the PDF is a
valid text-only PDF (Helvetica, A4) — letters outside Latin-1 lose their
accents (Vietnamese "Hóa đơn" → "Hoa don") and layout/images are not kept;
truncated previews are refused with `422` rather than exported partially.
Persistence: derived files may be cached in `artifact_revisions.exports`; no
schema change.

### <a id="proposed-chat-share"></a>Share a conversation — `chat.share`

Conversations are device-local (conversation_loop.md: "Device-local
conversations … not cross-device"), so the server has no copy to share. A
share therefore uploads a **snapshot** of the conversation that the server
stores and serves read-only at `/s/{share_id}`.

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| POST | `/conversations/{conversation_id}/shares` | bearer | conversation owner (the creating account in the active workspace) |
| GET | `/conversations/{conversation_id}/shares` | bearer | conversation owner — active links |
| DELETE | `/conversations/{conversation_id}/shares/{share_id}` | bearer | conversation owner |
| GET | `/conversation-shares/{share_id}` | bearer | workspace member (`workspace` audience) or a listed user (`people`) |

Request `POST …/shares`:

```json
{
  "audience": "people",
  "emails": ["an.nguyen@northwind.com"],
  "snapshot": {
    "title": "Q3 travel policy",
    "messages": [
      { "role": "user", "content": "What is the per diem?" },
      { "role": "assistant", "content": "It is 60 EUR a day [1].",
        "sources": [{ "number": 1, "document_id": "4d2a…", "chunk_id": "4d2a…:12", "title": "Travel policy.pdf" }] }
    ]
  }
}
```

- `audience`: `workspace` (any member of the conversation's workspace) or
  `people` (`emails`, one or more members of that workspace; required). People
  are named by email because member ids need the member directory
  (`user.manage`), which most members don't hold; the server resolves each
  address to a member and rejects addresses that aren't members.
- `snapshot.messages`: 1–500 non-empty messages; `sources` are the Documents
  each answer cites, one per `[n]` marker, with the passage to open at.

Response `201` (`ConversationShare`; `GET …/shares` returns `{items}` of it):

```json
{
  "id": "5eaf…", "conversation_id": "c1", "audience": "people", "emails": ["an.nguyen@northwind.com"],
  "url": "/s/5eaf…", "message_count": 2, "created_at": "2026-10-05T09:12:00Z",
  "created_by": { "id": "…", "display_name": "Linh Tran" }, "revoked_at": null
}
```

`DELETE` → `204`, idempotent for an already revoked share.

`GET /conversation-shares/{share_id}` → `200` `SharedConversation`:

```json
{
  "id": "5eaf…", "title": "Q3 travel policy", "audience": "people",
  "created_at": "2026-10-05T09:12:00Z", "created_by": { "id": "…", "display_name": "Linh Tran" },
  "messages": [
    { "role": "user", "content": "What is the per diem?", "sources": [] },
    { "role": "assistant", "content": "It is 60 EUR a day [1].", "sources": [
      { "number": 1, "available": true, "document_id": "4d2a…", "chunk_id": "4d2a…:12", "title": "Travel policy.pdf" }
    ] }
  ]
}
```

Sources are **filtered per recipient**: a cited Document the recipient cannot
read (`collection.read`) is returned as `{ "number": 1, "available": false }`,
never its id, title or text. Revoked shares, unknown ids and callers outside
the audience all get `404`, so ids can't be probed. The owner can always read
their own share.

Errors: `404` unknown share/conversation, `403` not the owner, `422
VALIDATION_ERROR` (audience, empty or oversize snapshot, `people` without
emails, an address that is not a member of the workspace).

Screens: chat thread header and answer "More" menu → Share dialog
(`/chat/[conversationId]`): who can open (everyone in the workspace / people
by email), "Create and copy link", "Turn off link" (DELETE); creating a new
link turns the previous one off, so one link is live per chat. Recipient view
`/s/[shareId]`: the read-only snapshot with only the sources the reader can
open, and "Continue in a new chat" (copies the snapshot into a chat of their
own).

Local implementation: `lib/api/pending/conversation-shares.ts`; shares and
snapshots stay in the owner's browser store (the namespace is the ownership
check), so a link opens only in that browser; the recipient read searches
this browser's share stores, applies the audience rule and re-reads each
cited Document as the caller.

Persistence (proposed): `conversation_shares` (see `design.dbml`).

### <a id="proposed-document-move"></a>Move documents to another knowledge base — `document.move`

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| POST | `/documents/move` | bearer | effective `collection.update` on each source Collection and on the target |

Request:

```json
{ "document_ids": ["d1", "d2"], "collection_id": "c-target" }
```

Response `200` — per-document outcome; a partial move is a success:

```json
{ "moved": ["d1"], "failed": [{ "document_id": "d2", "reason": "forbidden" }] }
```

`reason` is `not_found` (not visible), `forbidden` (no `collection.update` on
its Collection) or `already_in_collection`. A moved Document keeps its id,
content, citations and processing state; its Item gets the new
`parent_item_id`, and ACL inheritance follows the new Collection. Moving does
not start an Ingestion Run; the search index is updated with the new
Collection scope. Conversation attachments and archive children follow their
own rules (attachments cannot be moved).

Errors: `404` target not visible, `403` no `collection.update` on the target,
`422 VALIDATION_ERROR` (empty list, more than 100 ids).

Screens: `/knowledge/[collectionId]` document table, bulk bar → Move to.

Local implementation: `lib/api/pending/documents.ts` reads the real target
Collection, Documents and source Collections to decide each outcome, and
keeps the moves in the browser; `listLocalDocumentMoves()` (part of this key,
exported from `modules/knowledge/api.ts`) lets the lists apply them.
Persistence: `items.parent_item_id`; no schema change.

### <a id="proposed-document-restore"></a>Restore a deleted document — `document.restore`

`DELETE /documents/{document_id}` tombstones the Item (`items.status =
deleted`, `deleted_at` set). Restore reverses that tombstone.

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| POST | `/documents/{document_id}/restore` | bearer | effective `collection.update` on the Document's Collection |

Request: no body. Response `200` — the `Document`, as `GET
/documents/{document_id}` returns it, with its pre-deletion `status` and
`processing`. Restoring a live Document is a no-op that returns it.

Restore is allowed while the Collection is live and within the retention
window (proposed 30 days; after it the tombstone is purged). Citations and
index entries tombstoned with the Document are reactivated; when that cannot
be done the Document reads back `processing.state = pending` for a new run.

Errors: `404` unknown, purged, or its Collection deleted; `403` no
`collection.update`; `409` the name is now taken by another live Document in
the Collection.

Screens: `/knowledge/[collectionId]` and `/documents/[documentId]` — the Undo
in the toast after Archive.

Local implementation: `lib/api/pending/documents.ts`. It cannot undo a delete
the server already applied: it returns a Document that is still live and
answers `404` otherwise. While this key is pending, the Undo must defer the
real `DELETE` until its toast closes: the Knowledge document table hides the
archived rows at once, holds the `DELETE` for the 8-second Undo window
(`modules/knowledge/archive-queue.ts`), and sends any held delete when the
page is hidden. When the key is disabled the `DELETE` is sent at once and no
Undo is offered.

Persistence (proposed): restore lifecycle on `items` (see `design.dbml`).

### <a id="proposed-collection-general-access"></a>Open a knowledge base to the whole workspace — `collection.general_access`

Collection ACL principals are only `user` and `group`, so "everyone in the
workspace can view" has no grant today; a Collection is readable only by the
people and groups it is shared with and by workspace roles that cover every
Collection. This adds the workspace itself as a principal on the existing ACL
routes.

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| PUT | `/collections/{collection_id}/access/workspace/{workspace_id}` | bearer | effective `collection.share` |
| DELETE | `/collections/{collection_id}/access/workspace/{workspace_id}` | bearer | effective `collection.share` |

- `principal_type` gains `workspace`; `principal_id` must be the caller's
  active workspace id (`404` otherwise). PUT body `{ "role": "viewer" }` —
  only `viewer` is accepted for the workspace principal (`422` otherwise), so
  editing and sharing always stay with named people and groups.
- Effect: every active member of the workspace has the `collection_viewer`
  permissions on that Collection and its subtree (same inheritance as other
  grants), including members who join later. Suspended members do not.
- `GET /collections/{id}/access` lists the grant as `{ principal_type:
  "workspace", principal_id, principal_name: "<workspace name>", role:
  "viewer" }`.
- `Collection` (every read, including `/knowledge/home`) gains read-only
  `general_access: "workspace" | "restricted"`, so readers without
  `collection.share` can see who else can open it.
- A personal Collection ("My files", `system_kind` `personal_uploads` or
  `conversation_artifacts`) cannot be opened to the workspace: `422`.

Errors: `404` Collection or workspace not visible, `403` no
`collection.share`, `422` personal Collection or a role other than `viewer`.

Client function: `setCollectionGeneralAccess(collectionId, { general_access:
"workspace" | "restricted" })` → `{ collection_id, general_access, updated_at }`
(PUT for `workspace`, DELETE for `restricted`).

Screens: `/knowledge` (access badge Everyone / Restricted / Only you, Access
filter), Create knowledge base dialog ("Who can see it"),
`/knowledge/[collectionId]` header access chip and Access tab "General access".

Local implementation: `lib/api/pending/collections.ts` checks the real
Collection's `collection.share` and refuses the caller's personal Collection;
the setting is kept per workspace in this browser and changes nothing about
who the server lets read the Collection. `localCollectionGeneralAccess()`
(part of this key) supplies `general_access` until reads carry it; a
Collection without a local entry reads as `restricted`, which is what the
server holds today.

Persistence (proposed): `role_assignments` row with the tenant as principal
(see `design.dbml`); no new table.

### <a id="proposed-collection-discovery"></a>Knowledge bases a member can ask to join — `collection.discovery`

`GET /collections` and `/knowledge/home` list only readable Collections, so a
member cannot see that a knowledge base exists to request access to it. This
lists Collections the caller can see but not read: their name and who owns
them, never their documents.

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET | `/collections?visibility=discoverable` | bearer | `knowledge.read` |

Response `200`:

```json
{
  "items": [
    { "id": "c-legal", "title": "Legal Contracts", "description": "Executed customer and vendor agreements.",
      "general_access": "restricted", "owner_label": "Owned by Legal" }
  ],
  "total": 1
}
```

- Which Collections are discoverable is a server rule to settle with the
  backend (proposed: non-personal top-level Collections of the workspace,
  excluding ones the caller can already read; a Collection may later opt out).
- `owner_label` names the owners in plain words ("Owned by Legal", "Owned by
  Linh Tran and 2 more"); `null` when there is no owner grant.
- Requesting access stays `POST /approval-requests` `{ request_type:
  "resource_access", target_id, details: { role: "collection_viewer" |
  "collection_editor" }, reason }`.

Screens: `/knowledge` locked cards and list rows (Request access, or "Access
requested" with the pending status), `/knowledge/[collectionId]` locked state.

Local implementation: `lib/api/pending/collections.ts` never invents
Collections. It lists only real Collection ids the caller has already met but
cannot read: addresses that answered `404` on the knowledge base page
(`rememberUnreadableCollection`, part of this key) and the targets of the
caller's own `resource_access` requests that are pending or were denied.
Titles are unknown locally, so they read "Restricted knowledge base"; ids that
turn out not to exist (`404` on the access request) are forgotten.

Persistence: none (a read projection).

### <a id="proposed-workspace-assistant-settings"></a>Assistant settings — `workspace.assistant_settings`

How the workspace's assistant answers and what people see on a new chat.
The chat home reads the welcome message and starters through the same `GET`.

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET | `/workspaces/{workspace_id}/assistant-settings` | bearer | any active member (another workspace is `404`) |
| PATCH | `/workspaces/{workspace_id}/assistant-settings` | bearer | `tenant.manage` |

Response (`AssistantSettings`, both methods):

```json
{
  "instructions": "You are Northwind’s internal assistant. …",
  "answer_length": "balanced",
  "capabilities": { "web_search": false, "file_work": true, "charts": true },
  "knowledge_search_always_on": true,
  "welcome_message": "What can I help you find?",
  "starter_prompts": [{ "title": "Find a policy", "prompt": "What does our travel policy say about per diem?" }],
  "updated_at": "2026-10-05T09:12:00Z",
  "updated_by": { "id": "…", "display_name": "Linh Tran" }
}
```

Defaults before the first save (`updated_at`/`updated_by` null): the
instructions above addressed to the workspace name, `balanced`, file work and
charts on, web search off, the welcome message above, and three starters
(Find a policy, Summarize a document, Prepare for a customer).

PATCH request: any subset of `instructions`, `answer_length`
(`concise|balanced|detailed`), `capabilities` (partial booleans merge),
`welcome_message`, `starter_prompts` (replaces the list). Strings are trimmed.

Validation (`422 VALIDATION_ERROR`): `instructions` ≤ 2,000 characters;
`welcome_message` 1–60; `starter_prompts` ≤ 3, each `title` 1–40 and `prompt`
1–160; `knowledge_search_always_on` cannot be set to `false`. Other errors:
`401`, `403` without `tenant.manage`, `404` not a member.

The agent reads these settings at the start of each turn (instructions and
answer length shape the system prompt; capabilities gate tools); model choice
stays deployment configuration.

Screens: `/manage/assistant` (Behavior and Home screen tabs, live preview);
`/chat` home (welcome and starters).

Local implementation: `lib/api/pending/assistant-settings.ts`, one
workspace-wide store per workspace; limits exported as `ASSISTANT_LIMITS` from
`modules/manage/assistant/api.ts`.

Persistence (proposed): `workspace_assistant_settings` (see `design.dbml`).

### <a id="proposed-workspace-archive"></a>Archive a workspace — `workspace.archive`

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| POST | `/workspaces/{workspace_id}/archive` | bearer | `tenant.manage` in that workspace |

Request — the person types the workspace URL code to confirm:

```json
{ "confirm_code": "northwind" }
```

Response `200`:

```json
{ "workspace_id": "…", "status": "archived", "archived_at": "2026-10-05T09:12:00Z", "archived_by": { "id": "…", "display_name": "Linh Tran" } }
```

Archiving sets `tenants.status = archived`: members can no longer switch into
it (`PATCH /auth/session` → `403`), its sources stop syncing and schedules are
paused, and its data is retained. Reactivation is a platform action
(`platform.workspace_admin`).

Errors: `403` without `tenant.manage`, `404` not a member, `409` already
archived, `422 VALIDATION_ERROR` `confirm_code` does not match the code.

Reading the state: `GET /workspaces/{workspace_id}` returns `status:
"archived"` with `archived_at` and `archived_by` while the archive is in
effect (client `getWorkspaceArchive`, which returns the same
`WorkspaceArchive` shape, or `null` for an active workspace).

Screens: `/manage/settings` danger zone (typed-confirmation dialog; after the
request the card says when and by whom it was requested).

Local implementation: `lib/api/pending/workspace-settings.ts` records the
archive in a workspace-wide browser store only; the real workspace stays
active. The code to type is the workspace's current web address (including a
pending `workspace.url_code` change). Persistence: `tenants.status` gains
`archived`.

### <a id="proposed-workspace-branding"></a>Workspace accent color — `workspace.branding`

Stored in `Workspace.settings.branding`; no new route.

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET | `/workspaces/{workspace_id}` | bearer | active workspace context — reads `settings.branding` |
| PATCH | `/workspaces/{workspace_id}` | bearer | `tenant.manage` |

PATCH request:

```json
{ "settings": { "branding": { "accent": "teal" } } }
```

`settings.branding` in the `Workspace` response (the client functions return
this object):

```json
{ "accent": "teal", "updated_at": "2026-10-05T09:12:00Z" }
```

`accent` is one of `indigo | teal | ocean | plum | graphite` (the WebUI's
`html[data-accent]` palette); default `indigo` with `updated_at` null. Only
the action colour changes; status and evidence colours never do. A person's
own accent preference overrides it on their device.

Errors: `403` without `tenant.manage`, `422 VALIDATION_ERROR` unknown accent.

Screens: `/manage/settings` (Brand card with a live preview); the product
shell applies it for every member whose accent preference is "Workspace
brand" (the default). Clients re-read it after a save.

Local implementation: `lib/api/pending/workspace-settings.ts`, a
workspace-wide browser store. Persistence: `tenants.settings.branding`
(see `design.dbml`).

### <a id="proposed-workspace-url-code"></a>Change the workspace web address — `workspace.url_code`

`WorkspaceUpdate` today accepts only `name` and `settings`; an unknown
`code` field is rejected (`422`). This proposes making `code` writable on the
same route; no new route.

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET | `/workspaces/{workspace_id}` | bearer | active workspace context — reads `code` |
| PATCH | `/workspaces/{workspace_id}` | bearer | `tenant.manage` |

PATCH request (may be combined with `name`):

```json
{ "code": "northwind-group" }
```

Response: the updated `Workspace`. The client functions
(`getWorkspaceCode`, `updateWorkspaceCode`) return `{ "code": "…",
"updated_at": "…" }`, `updated_at` null while the workspace keeps the address
it was created with.

Rules: the address rule of workspace creation (`platform.workspace_admin`):
3–32 lowercase letters, numbers or hyphens, starting and ending with a letter
or number, unique across every workspace. Sending the current code is a
no-op. An address created before this rule stays valid until it is changed.
Saved links that contain the old address stop resolving, so the screen warns
before saving; the server keeps no redirect from the old address.

Errors: `403` without `tenant.manage`, `404` not a member, `409` the address
is used by another workspace, `422 VALIDATION_ERROR` malformed address.
Writes an audit event `tenant.updated` with `changed_fields: ["code"]`.

Screens: `/manage/settings` General card ("Web address", with the
link-breakage warning and a Preview tag while pending). The workspace archive
confirmation asks for this address.

Local implementation: `lib/api/pending/workspace-settings.ts` keeps the new
address in a workspace-wide browser store; the real workspace keeps its code,
so only this browser's Settings and archive confirmation use it. Uniqueness is
checked against the caller's own workspaces only. Persistence: the existing
unique `tenants.code` column; no schema change.

### <a id="proposed-account-notification-prefs"></a>Notification preferences — `account.notification_prefs`

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET | `/me/notification-preferences` | bearer | self |
| PATCH | `/me/notification-preferences` | bearer | self |

Response (`NotificationPreferences`):

```json
{
  "email": { "source_sync_failures": true, "access_requests": true, "cited_document_changes": true, "weekly_summary": true },
  "updated_at": null
}
```

PATCH request — partial booleans merge:

```json
{ "email": { "weekly_summary": false } }
```

Preferences belong to the account and apply in every workspace. Emails are
only sent where the person qualifies: `source_sync_failures` needs
`source.manage`, `access_requests` needs to own or review the knowledge base
(`access.manage` / `collection.share`); the WebUI shows those two toggles
only to people who hold the permission.

Errors: `401`, `422 VALIDATION_ERROR` (unknown key, non-boolean).

Screens: account menu → Profile & preferences dialog (Email notifications).

Local implementation: `lib/api/pending/notification-preferences.ts`, a
per-account browser store. Persistence: `users.preferences.notifications`
(see `design.dbml`).

### <a id="proposed-analytics-knowledge-gaps"></a>Knowledge gaps — `analytics.knowledge_gaps`

Frequent questions in the active workspace that knowledge could not answer
well, so an administrator can add the missing documents or dismiss the gap.

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/workspaces/{workspace_id}/knowledge-gaps?window=7d\|30d&include_dismissed=` | `tenant.manage` |
| PATCH | `/workspaces/{workspace_id}/knowledge-gaps/{gap_id}` | `tenant.manage` |

Like overview, only the caller's active workspace answers; another
workspace id is `404`. `window` defaults to `7d`; anything else is `422`.
Dismissed gaps are omitted unless `include_dismissed=true`.

```json
{
  "window": "7d",
  "generated_at": "2026-10-05T09:00:00Z",
  "items": [
    {
      "id": "uuid",
      "question": "What is the notice period for contractors?",
      "times_asked": 23,
      "last_asked_at": "2026-10-05T06:00:00Z",
      "reason": "not_covered",
      "suggested_collection_id": "uuid",
      "suggested_collection_title": "HR Policies",
      "dismissed": false,
      "dismissed_at": null
    }
  ]
}
```

- `reason` is `not_covered | outdated | rated_unhelpful`; clients word it.
- `times_asked` counts askings inside the window; items are ordered by it,
  descending.
- `suggested_collection_*` names a Collection the caller can read, or both
  are `null`. The server never suggests a Collection the caller cannot see.
- PATCH body `{ "dismissed": true|false }` returns the updated gap. A
  dismissal is workspace-wide and reversible (Undo sends `false`).
- Errors: `401`, `403` without `tenant.manage`, `404` unknown gap or
  workspace, `422` invalid window or body.
- Screens: Manage → Overview "Knowledge gaps" (Add documents opens the
  suggested knowledge base; Dismiss with Undo).
- Local implementation (`pending/knowledge-gaps.ts`): five fixed seed
  questions (one only in `30d`); dismissals stored per account and
  workspace; the suggestion is chosen among the caller's real Collections
  (`GET /collections`) by topic words in the title, else `null`.

### <a id="proposed-audit-export"></a>Export activity — `audit.export`

The workspace's audit trail as a CSV file, filtered exactly like the
Activity list.

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/audit-logs/export?format=csv&window=24h\|7d\|30d&actor=&area=&outcome=success\|failure&search=` | `audit.read` |

- `window` is required. `actor` is a user id, or `system` for events with no
  person behind them. `area` is one of `knowledge` (collection and document
  actions), `files` (artifacts), `sources` (ingestion sources, connections
  and connector requests), `people` (members, groups, roles, access
  requests) or `settings` (workspace). `outcome=failure` is every outcome
  other than `success`. `search` is the Activity list's free text: a
  case-insensitive match on the person's name or email, the plain-language
  action and the target, as the list shows them.
- Response `200 text/csv; charset=utf-8` with
  `Content-Disposition: attachment`, UTF-8 with a byte-order mark, CRLF line
  ends, newest first. Columns: `Time` (ISO 8601), `Actor` (display name, else
  email, else `BoMesh`), `Action` (the plain-language sentence the Activity
  page shows), `Target` (resource type and, when recorded, its name or
  email), `Outcome` (`Succeeded`/`Failed`), `IP address` (when recorded;
  blank today because audit rows do not carry one).
- Cells are RFC 4180 quoted; a value starting with `=`, `+`, `-`, `@`, tab or
  CR gets a leading `'` so spreadsheet apps never run it as a formula.
- At most 10,000 rows; the server may stream.
- Errors: `401`, `403` without `audit.read`, `422` unknown format or window.
- Screens: Manage → Activity, "Export CSV".
- Local implementation (`pending/audit-export.ts`): pages through the real
  `GET /audit-logs` (`page_size=100`, newest first) until the window start
  with the Activity list's own reader (`modules/manage/activity/activity-log.ts`),
  applies the list's filter (`auditEventMatches` in
  `modules/manage/activity/audit-actions.ts`, the one action → sentence
  translation) and returns the same file as a `Blob` named
  `activity-<workspace code>-<YYYY-MM-DD>.csv` by the screen.

### <a id="proposed-notifications-inbox"></a>Notifications — `notifications.inbox`

The signed-in person's inbox in the active workspace: what changed that they
should look at, each linked to where it is resolved.

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/notifications?unread_only=` | self |
| PATCH | `/notifications/{notification_id}` | self (own notification) |
| POST | `/notifications/read-all` | self |

```json
{
  "items": [
    {
      "id": "uuid",
      "kind": "source_failed",
      "title": "Ops folder stopped syncing",
      "body": "The account's access was revoked.",
      "created_at": "2026-10-05T07:00:00Z",
      "read": false,
      "href": "/manage/sources?source=uuid"
    }
  ],
  "unread_count": 4
}
```

- `kind`: `product_notice | source_failed | connection_reconnect |
  access_request | access_request_pending | access_request_approved |
  access_request_denied`. Newest first. `unread_count` covers the whole
  inbox whatever the filter.
- A notification is only created for something its recipient may read:
  source and account items go to holders of `source.manage`; `access_request`
  to reviewers of that request type (`access.manage` for `resource_access`,
  `source.manage` for `plugin_installation`); `access_request_*` to the
  requester.
- `href` is an app route: `/manage/sources?source={source_id}`,
  `/manage/sources?tab=accounts&connection={connection_id}`,
  `/manage/access?tab=requests`, `/knowledge/{collection_id}`,
  `/manage/overview`.
- PATCH body `{ "read": true|false }` returns the notification; read-all
  returns `{ "updated": n }`.
- Errors: `401`, `404` unknown or someone else's notification, `422`.
- Screens: the sidebar Inbox drawer (All/Unread, Mark all read, deep links).
- Local implementation (`pending/notifications.ts`): three seeded product
  notices (one only for `tenant.manage`), plus items derived from real reads
  the caller is already allowed: `GET /connections` and `GET /sources` (with
  `source.manage`) and `GET /approval-requests`. A failed read is skipped.
  Only read state is stored, per account and workspace.

### <a id="proposed-platform-workspace-admin"></a>Create and suspend workspaces — `platform.workspace_admin`

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/platform/workspaces` | `platform.tenant.manage` (proposed) |
| PATCH | `/platform/workspaces/{workspace_id}` | `platform.tenant.manage` (proposed) |

Request bodies:

```json
{ "name": "Litware Labs", "code": "litware-labs", "owner_email": "sam@litware.com" }
```

```json
{ "status": "suspended" }
```

- `code` is the web address: `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$` (3–32
  characters), unique across every workspace (`409` names the workspace that
  holds it). `name` is 2–255 characters. `owner_email` becomes the first
  admin (membership plus the workspace admin role); an email without an
  account is accepted and the person is added when they sign up.
- Both return `201`/`200` with the `WorkspaceHealth` row (`id, code, name,
  status, settings, created_at, updated_at, owner, member_count,
  connection_count`). Proposed addition: `GET /platform/workspaces` returns
  the same row. Today the service computes `owner`, `member_count` and
  `connection_count`, but the router maps rows through `workspace_payload`
  (OpenAPI `Workspace`), so only `id, code, name, status, settings` reach
  the client; the console shows `—` for what is missing.
- `status` is `active | suspended`. Suspension blocks sign-in to that
  workspace for every member; nothing is deleted.
- New platform permission `platform.tenant.manage`, granted to the platform
  admin role. Until a session holds it, the WebUI shows these actions to
  holders of `platform.tenant.read`; the server must enforce the new code.
- Errors: `401`, `403`, `404` unknown workspace, `409` code taken, `422`.
- Screens: Platform → Workspaces (Create workspace dialog,
  Suspend/Reactivate with confirm, drawer).
- Local implementation (`pending/platform-workspaces.ts`): reads the real
  `GET /platform/workspaces`; created workspaces live only in the browser and
  carry `source: "local"`; status changes are stored as overrides keyed by
  the real workspace id, merged by `listPlatformWorkspaces`, and flag the row
  `changed_locally: true`. Both fields are client-side annotations of the
  pending layer (not part of the proposed response); the console marks those
  rows with the Preview tag and "Created/Changed in this browser". With the
  feature turned off, `listPlatformWorkspaces` reads the real list only.

### <a id="proposed-platform-user-admin"></a>Manage platform users — `platform.user_admin`

| Method | Path | Permission |
| --- | --- | --- |
| PATCH | `/platform/users/{user_id}` | `platform.user.manage` (proposed) |

```json
{ "is_platform_admin": true, "status": "suspended" }
```

- Either field, or both. `is_platform_admin` grants or revokes the platform
  admin role assignment; `status` (`active | suspended`) is account-wide
  (`users.status`), unlike workspace membership suspension.
- The caller can never change their own row: `403` "You can't change your own
  platform role or account status."
- Response: the `GET /platform/users` row plus `is_platform_admin: boolean`.
  Proposed addition: `GET /platform/users` returns `is_platform_admin` on
  every row. The service already reads each account's `platform_roles` and
  workspace `memberships`, but the router maps rows through `user_payload`
  (OpenAPI `User`), so the client receives `roles: []` and `groups: []`; the
  console therefore shows neither workspace counts nor last activity.
- New platform permission `platform.user.manage`; until a session holds it
  the WebUI mirrors it with `platform.user.read`.
- Errors: `401`, `403` (no permission, or self), `404`, `422`.
- Screens: Platform → Users (row menu and drawer: Make/Remove platform admin,
  Suspend/Reactivate account).
- Local implementation (`pending/platform-users.ts`): reads the real
  `GET /platform/users` and merges overrides keyed by user id;
  `is_platform_admin` is `null` (unknown) for rows nobody changed here,
  except the caller's own row, which the session answers. Overridden rows
  carry the client-side flag `changed_locally: true`, shown as the Preview
  tag and "Changed in this browser"; the console words `null` as "Not
  reported yet" and offers both Make and Remove platform admin for it.

### <a id="proposed-platform-connectors"></a>Connector availability — `platform.connectors`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/platform/connectors` | `platform.tenant.read` |
| PATCH | `/platform/connectors/{connector_key}` | `platform.connector.manage` (proposed) |

```json
[
  {
    "key": "google_drive",
    "name": "Google Drive",
    "description": "Files and shared drives",
    "built_in": false,
    "supported": true,
    "available": true,
    "authentication": "oauth",
    "workspace_count": 5,
    "request_count": 0,
    "oauth_client": {
      "client_id": "1234-abc.apps.googleusercontent.com",
      "has_secret": true,
      "deployment_configured": true,
      "updated_at": "2026-09-01T10:00:00Z",
      "updated_by": "Alex Rivera"
    }
  }
]
```

PATCH body: `{ "available": false }` and/or
`{ "oauth_client": { "client_id": "…", "client_secret": "…" } }`.

- `supported` means the deployment's connector registry has an adapter;
  unsupported connectors cannot be made available (`409`) and only collect
  `plugin_installation` requests (`request_count`). The built-in file upload
  is always available (`409` on change).
- Turning a connector off stops new connections and syncs; existing
  documents stay searchable.
- `client_secret` is write-only: stored encrypted, never returned in any
  response or log. Responses carry only `has_secret`. Omitting it keeps the
  current secret. `deployment_configured` says the deployment's environment
  already provides the client.
- Errors: `401`, `403`, `404` unknown key, `409`, `422` (malformed client id,
  secret shorter than 16 characters, OAuth settings on a non-OAuth
  connector).
- Screens: Platform → Connectors (cards, availability toggle with confirm,
  Configure drawer).
- Local implementation (`pending/platform-connectors.ts`): rows from the
  connector catalogue plus file upload; `supported`, `authentication` and
  `deployment_configured` from the real `GET /connections/providers` when
  readable; counts seeded; the secret is validated and discarded, only
  `has_secret` is stored.

### <a id="proposed-platform-capabilities"></a>AI capabilities — `platform.capabilities`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/platform/capabilities` | `platform.tenant.read` |

```json
[
  {
    "key": "chat",
    "name": "Answers and reasoning",
    "description": "Writes answers and decides when to search knowledge.",
    "status": "operational",
    "setting": "OPENROUTER_MODEL",
    "model": "provider/model-name",
    "checked_at": "2026-10-05T09:00:00Z"
  }
]
```

- Read-only. Keys: `chat` (`OPENROUTER_MODEL`), `embeddings`
  (`EMBEDDING_MODEL`), `vision_parsing` (`BOMESH_DOCLING_MODEL`),
  `contextualization` (`BOMESH_CONTEXTUALIZATION_MODEL`). `setting` is the
  deployment variable name; models change only in deployment configuration.
- `status`: `operational | degraded | down | not_configured | not_checked`.
- Never returns secrets, keys, base URLs or any other configuration value;
  `model` is the model identifier only, for platform callers.
- Screens: Platform → AI capabilities (status rows, degraded call-out).
- Local implementation (`pending/platform-capabilities.ts`): fixed rows;
  `chat` and `embeddings` take status and model from the real
  `GET /platform/health` services `openai_chat` and `openrouter_embeddings`
  when the caller holds `platform.health.read`; the rest are `not_checked`.
  The browser never reads deployment values.

### <a id="proposed-platform-usage"></a>Platform usage — `platform.usage`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/platform/usage?window=7d\|30d\|90d` | `platform.tenant.read` |

```json
{
  "window": "30d",
  "start": "2026-09-06",
  "generated_at": "2026-10-05T09:00:00Z",
  "totals": { "questions": 41230, "active_people": 610, "documents_processed": 1880 },
  "previous": { "questions": 38900, "active_people": 590, "documents_processed": 1650 },
  "daily": [{ "date": "2026-09-06", "questions": 1210 }],
  "workspaces": [
    { "workspace_id": "uuid", "name": "Northwind", "questions": 30410, "active_people": 350, "documents_processed": 900 }
  ]
}
```

- Aggregates only: no identities, no message content. `questions` counts
  user messages, `active_people` distinct active users, `documents_processed`
  documents that finished processing in the window. `daily` is oldest first
  and zero-filled (UTC days); `previous` is the equally long span before
  `start`. `workspaces` is ordered by questions, descending.
- Errors: `401`, `403`, `422` unknown window.
- Screens: Platform → Usage (window, three totals with change, chart,
  sortable per-workspace table).
- Local implementation (`pending/platform-usage.ts`): rows are the real
  workspaces from `GET /platform/workspaces`; their numbers are seeded from
  each workspace id and member count (suspended workspaces show none);
  totals and the daily series are sums of the rows. If the workspace list
  cannot be read, every figure is zero.

### <a id="proposed-platform-health-history"></a>Health history — `platform.health_history`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/platform/health/history?days=30` | `platform.health.read` |

```json
{
  "days": 30,
  "start": "2026-09-06",
  "generated_at": "2026-10-05T09:00:00Z",
  "services": [
    {
      "name": "openai_chat",
      "checks": 2880,
      "uptime_percent": 99.93,
      "daily": [{ "date": "2026-09-06", "status": "healthy", "checks": 96 }]
    }
  ],
  "incidents": [
    {
      "id": "uuid",
      "service": "openai_chat",
      "status": "unhealthy",
      "error_category": "timeout",
      "started_at": "2026-09-27T08:15:00Z",
      "resolved_at": "2026-09-27T08:53:00Z"
    }
  ]
}
```

- The server keeps the result of every periodic `GET /platform/health`
  probe (service name, status, `error_category`, time); nothing else, and
  never a raw error message. `days` is 1–90 (default 30); `daily` has one
  entry per UTC day, oldest first, `status` `healthy | issues | no_data`
  (`no_data`: no probe ran that day). `uptime_percent` is healthy probes over
  probed ones (`not_configured` is a setting, not an outage, and is not
  counted); `null` when the service was never probed in the window.
- An incident is a run of failing probes for one service, opened by the
  first `unhealthy`/`degraded` result and closed (`resolved_at`) by the next
  healthy one; `resolved_at` is `null` while it lasts. `status` is the worst
  seen. Newest first.
- Errors: `401`, `403`, `422` out-of-range `days`.
- Screens: Platform → System health ("Last 30 days" strip and Uptime
  columns; Recent incidents).
- Local implementation (`pending/platform-health-history.ts`): keeps the
  REAL `GET /platform/health` reports this browser reads (each time System
  health opens or refreshes; `getPlatformHealth` records them while the
  feature is on), up to 90 days and 2,000 checks per account, and derives
  the same response from them. Days nobody checked from this browser are
  `no_data`; nothing is seeded.
- Persistence: proposed table `platform_health_checks` (`design.dbml`).

### <a id="proposed-platform-audit-export"></a>Export the platform audit log — `platform.audit_export`

Every recorded event across workspaces and the platform as a CSV file,
filtered exactly like Platform → Audit log.

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/platform/audit-logs/export?format=csv&window=24h\|7d\|30d\|90d&search=&workspace_id=&area=&outcome=success\|failure` | `platform.audit.read` |

- `window` is required. `search` is the same server search as
  `GET /platform/audit-logs` (action, resource id, person's name or email,
  workspace name). `workspace_id` is a workspace id, or `platform` for
  events that belong to no workspace. `area` and `outcome` mean what they
  mean for `audit.export` (`outcome=failure` is every outcome other than
  `success`).
- Response `200 text/csv; charset=utf-8` with `Content-Disposition:
  attachment`, the same file rules as `audit.export` (byte-order mark, CRLF,
  RFC 4180 quoting, formula neutralising, newest first, at most 10,000 rows).
  Columns: `Time`, `Workspace` (its name, `Platform` for platform events,
  `Deleted workspace` when it no longer has a name), `Actor`, `Action`,
  `Target`, `Outcome`, `IP address`.
- Errors: `401`, `403` without `platform.audit.read`, `422` unknown format
  or window.
- Screens: Platform → Audit log, "Export CSV" (file
  `platform-audit-<YYYY-MM-DD>.csv`).
- Local implementation (`pending/platform-audit-export.ts`): pages through
  the real `GET /platform/audit-logs` (`page_size=100`) until the window
  start with the shared reader (`readSince`), applies the page's own filter
  (`platformAuditMatches` in `modules/platform/audit-filter.ts`) and writes
  rows with `audit.export`'s row and file helpers (`auditCsvRow`,
  `csvBlob`), adding the Workspace column. Nothing is stored.

### <a id="proposed-workspace-member-remove"></a>Remove a member from the workspace — `workspace.member_remove`

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| DELETE | `/users/{user_id}` | bearer | `user.manage` |

Ends one person's membership of the active workspace. It is a lifecycle
change, not a physical delete: the membership is tombstoned
(`tenant_memberships.deleted_at` set, status `inactive`), its workspace role
and group assignments end, and the account, its sign-in and its other
workspaces are untouched. `POST /users` with the same email readmits the
person with exactly the roles given (already implemented). Suspension
(`PATCH /users/{id}` `status`) stays the reversible "pause".

Response `200`:

```json
{
  "user_id": "uuid",
  "email": "minh.pham@northwind.com",
  "display_name": "Minh Pham",
  "removed_at": "2026-10-06T09:12:00Z",
  "removed_by": "uuid"
}
```

- Guard rules, as for `PATCH /users/{id}`: `409` when the caller removes
  themselves ("an administrator cannot change their own workspace access")
  and `409` when it would remove the last active workspace administrator.
- Errors: `401`, `403` without `user.manage`, `404` when the person is not a
  member (or was already removed), `409` as above.
- Audit: `member.removed` with `{email}`.
- Screens: Manage → People & access → member row menu "Remove from
  workspace" and the member drawer's Remove (confirm dialog; disabled for
  yourself), Undo in the result toast.
- Local implementation (`pending/member-remove.ts`): reads the REAL
  `/users` list, applies the guard rules (the last-admin check reads what
  roles allow from `/roles` when the caller may), and records the removal in
  this browser for the workspace (`bomesh.pending.workspace.member_remove.shared.<workspace>`).
  Removed members are hidden from the members list only in this browser; a
  Preview-tagged notice says they can still open the workspace, with Restore.
  Undo/Restore clears the local record (the server equivalent is `POST /users`).
- Persistence: none new — `tenant_memberships.deleted_at` and `status`
  already exist.
