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
