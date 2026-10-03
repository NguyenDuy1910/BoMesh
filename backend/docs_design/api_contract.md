# BoThesis API Contract

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
   `document_id`, `connection_id`, `source_id`, `ingestion_id`,
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
`user.manage`, `role.manage`, `group.manage`, `source.manage`, `item.manage`,
`knowledge.read`, `collection.read`, `collection.update`, `collection.share`,
`collection.delete`, `access.manage`, and `audit.read`. There are no
`iam.*`, `knowledge.documents.*`, or `knowledge.collections.*` capabilities.
Effective Collection permissions combine the caller's workspace grants with
direct and inherited user/group ACL grants. `item.manage` alone does not grant
Collection visibility. Document reads use `collection.read`; creation, content
finalization, and deletion use `collection.update` (ACL editor or equivalent).
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
| POST | `/collections` | bearer | `item.manage`; child also requires parent `collection.update` |
| GET | `/collections/{collection_id}` | bearer | effective `collection.read` |
| PATCH | `/collections/{collection_id}` | bearer | effective `collection.update` |
| DELETE | `/collections/{collection_id}` | bearer | effective `collection.delete` |
| GET | `/collections/{collection_id}/access` | bearer | effective `collection.share` |
| PUT | `/collections/{collection_id}/access/{principal_type}/{principal_id}` | bearer | effective `collection.share` |
| DELETE | `/collections/{collection_id}/access/{principal_type}/{principal_id}` | bearer | effective `collection.share` |
| POST | `/collections/{collection_id}/documents` | bearer | effective `collection.update`; signed-in user |
| PUT | `/collections/personal` | bearer | signed-in user with `knowledge.read` |

`principal_type` is `user` or `group`. PUT body is `{ "role": "owner" |
"editor" | "viewer" }`; principal identity is in URL. Existing internal role
codes may remain `collection_owner`, `collection_editor`, and
`collection_viewer` behind transport mapping.

`Collection.permissions` is the effective caller-specific permission list,
not the ACL role name or a global permission catalogue. Clients use it to
enable resource actions. Listing, reading, updating, and deleting Collections
do not additionally require `item.manage`; creation does, including children.
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
`pending_content|available|failed`. Index/search processing remains the
separate Ingestion lifecycle; there is no Document-level retry route.

Those are public API states. Internal Item and upload-ledger statuses may use
different storage-oriented values and must be mapped at the API boundary.

### Artifacts

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/artifacts/{artifact_id}` | bearer | Artifact and revisions |
| GET | `/artifacts/{artifact_id}/revisions/{revision}/content` | bearer | Revision content |
| POST | `/artifacts/{artifact_id}/publish` | bearer | Publish revision into Collection |

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
| GET | `/sources/{source_id}/status` | bearer | Source health projection |
| POST | `/sources/{source_id}/ingestions` | bearer | Start ingestion |
| GET | `/sources/{source_id}/ingestions` | bearer | Source ingestion list |
| GET | `/sources/{source_id}/ingestions/{ingestion_id}` | bearer | One source ingestion |
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
next ingestion rediscovers the scope. Schedules have their own resource.

### Ingestions

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/ingestions` | bearer | Managed Ingestions (documents and sources), newest first, live |
| GET | `/ingestions/summary` | bearer | Throughput, outcomes and durations for `1h`/`24h`/`7d` |
| GET | `/ingestions/{ingestion_id}` | bearer | Ingestion detail with live progress |
| GET | `/ingestions/{ingestion_id}/events` | bearer | Timeline: queued, attempts, phases, outcome |
| POST | `/ingestions/{ingestion_id}/retry` | bearer | Retry failed/cancelled/timed-out ingestion |
| POST | `/ingestions/{ingestion_id}/cancel` | bearer | Cancel pending/running ingestion |

One resource, two kinds, two runners, one core. A `document` Ingestion
processes one upload or expands one archive; a `source` Ingestion
synchronizes one Source. Every kind runs the same ingestion core
(`ItemIngestionService`), and `mode` says who ran it:

- `managed`: one Temporal `IngestionWorkflow` (Sources, and uploads into
  workspace Collections). Live state comes from Temporal through
  `TemporalWorkflowService` only (search attributes `TenantId`, `CollectionId`,
  `WorkflowCategory`, and a `title` memo). These are what `GET /ingestions`,
  the summary and the Activity monitor show.
- `direct`: a user's own upload (chat attachment, personal library) processed
  by the API process on arrival. It is read from the Document's Ingestion
  record; it is not listed by `GET /ingestions`, and it cannot be cancelled.

`IngestionService` owns the resource for both runners and routes retry to the
owning lifecycle (`DocumentService` for documents, in their original mode;
`IntegrationLifecycleService.ingest_source` for Sources).

Visibility follows the data a run touches. A document Ingestion is visible to
readers of its Collection, and retry/cancel need Collection update. A source
Ingestion needs `source.manage`. A run the caller may not see is `404`.

`progress.phase` is where the run is: documents go `queued · parsing ·
contextualizing · embedding · storing`, archives go `queued · downloading ·
expanding`, sources go `syncing`. Counts are chunks, accepted files, or items.
Live phase comes from the core's `PhaseRecorder`: a managed run heartbeats it
(about every 2s), and every document run also writes it to the Document's
Ingestion record, so finished phases, with durations, rebuild the timeline
either way. `error` carries only messages written for people; infrastructure
causes are logged, never returned.

An Ingestion is one target's execution chain, not one attempt: a retry, or
another manual sync of the same Source, is a new run under the same
`ingestion_id`. Reads address its latest run, and `GET /ingestions` lists each
Ingestion once, at that run, with `status` filters matched against it (a
superseded failure is not "failed"). Scheduled syncs are separate Ingestions.

Responses expose `ingestion_id`; the Temporal `workflow_id`, run id, event
types and payloads stay internal. Retrying reuses the same ingestion id. The
Web UI's Sync activity tab polls these endpoints (2s while anything runs, 15s
otherwise); there is no push channel.

### Workspace IAM and governance

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET | `/workspaces` | bearer | workspace membership or platform scope |
| GET | `/workspaces/{workspace_id}` | bearer | active workspace context |
| PATCH | `/workspaces/{workspace_id}` | bearer | `tenant.manage` |
| GET | `/workspaces/{workspace_id}/overview` | bearer | `tenant.read` |
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
not expose audit records through a weaker permission.

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
| `workflow_id` | `ingestion_id` | Temporal ID stays private |
| `doc_id` | `document_id` | route/path/schema rename |
| public `upload_id` | `document_id` | internal one-to-one upload ledger remains private |
| `item_id` for Collection | `collection_id` | Item remains internal aggregate |
| `item_id` for document viewer | `document_id` | indexed Item identity stays internal |
| `requester_user_id` | authenticated requester | remove from DTO |
| `/agent/collections` | `/collections` | remove duplicate route |
| `/knowledge/collections` | `/collections`, `/knowledge/home` | split resource/projection |
| `/admin/*` workspace resources | root resource paths | remove namespace |
| `/admin/platform/*` | `/platform/*` | platform-only permission |
| `/documents/{document_id}/retry` | `/ingestions/{ingestion_id}/retry` | one retry use-case |
| `/items/{item_id}/retry` | `/ingestions/{ingestion_id}/retry` | one retry use-case |
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
