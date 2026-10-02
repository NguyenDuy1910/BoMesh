# BoThesis API Contract

Status: target contract for the contract-first refactor. Authentication details
are locked in `auth_contract.md`; Document/content details are locked in
`document_contract.md`. Both are mirrored in the OpenAPI target.

This document is the source of truth for the next implementation phase. Code,
frontend callers, tests, and the checked-in OpenAPI snapshot must conform to
this contract. No compatibility aliases are part of this contract.

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
10. DELETE means lifecycle removal/tombstone. State changes use PATCH.
11. `Idempotency-Key` is required for upload creation and other retry-sensitive
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
the default with `security: []`. Protected operations document capability
metadata using `x-required-permissions`.
Document operations additionally use `x-required-collection-role` to state the
Collection ACL ceiling: `viewer` for reads/search and `editor` for creation,
content finalization, and deletion. The API must enforce both workspace
capability and Collection ACL.

Document capability names are explicit: `knowledge.documents.read`,
`knowledge.documents.search`, `knowledge.documents.create`,
`knowledge.documents.write`, and `knowledge.documents.delete`. Collection ACL
still applies as a second boundary; a workspace capability never grants access
to Collections the caller cannot see.

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
| POST | `/auth/accounts` | public/optional guest | Create local account and first session |
| POST | `/auth/sessions` | public/optional bearer | Authenticate and create one Session |
| GET | `/auth/session` | bearer | Read current authenticated Session/context |
| PATCH | `/auth/session` | bearer | Change active workspace on current Session |
| DELETE | `/auth/session` | bearer | Invalidate current Session |

`POST /auth/sessions` is a single resource operation. Its typed request
discriminator is `method` and currently supports `password`, `guest`, and
`google`. Adding an authentication provider adds a request variant, not another
top-level route.

`AuthSession` exposes `active_workspace_id` and `workspaces`. Internal
`active_tenant_id` and `tenants` are not public fields. Current identity is
always resolved from the bearer session; no caller identity fields are accepted
by `GET`, `PATCH`, or `DELETE /auth/session`.

Password login uses `method: "password"` with exactly one of `email` or
`username`, plus `password`. Account `email` remains the canonical credential
identifier; optional account `username` is also accepted for local sign-in.
Google login uses `method: "google"` with the verified provider credential.
Guest access uses `method: "guest"` and no credential fields. Workspace
switching uses `PATCH /auth/session` with `active_workspace_id` and requires
bearer authentication. All Session-creation variants return the same
`AuthSession` response.

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

`GET /knowledge/home` is intentionally not a Collection list. It is a read
projection and has no Collection mutation behavior.

### Collections and Collection ACL

| Method | Path | Auth | Permission |
| --- | --- | --- | --- |
| GET | `/collections` | bearer | `knowledge.collections.read` |
| POST | `/collections` | bearer | `knowledge.collections.create` |
| GET | `/collections/{collection_id}` | bearer | Collection ACL/read |
| PATCH | `/collections/{collection_id}` | bearer | `knowledge.collections.update` or ACL editor |
| DELETE | `/collections/{collection_id}` | bearer | `knowledge.collections.delete` or ACL owner |
| GET | `/collections/{collection_id}/access` | bearer | `knowledge.access.read`/share |
| PUT | `/collections/{collection_id}/access/{principal_type}/{principal_id}` | bearer | `knowledge.access.manage` |
| DELETE | `/collections/{collection_id}/access/{principal_type}/{principal_id}` | bearer | `knowledge.access.manage` |
| POST | `/collections/{collection_id}/documents` | bearer | Collection write ACL |
| PUT | `/collections/personal` | bearer | authenticated user |

`principal_type` is `user` or `group`. PUT body is `{ "role": "owner" |
"editor" | "viewer" }`; principal identity is in URL. Existing internal role
codes may remain `collection_owner`, `collection_editor`, and
`collection_viewer` behind transport mapping.

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
| GET | `/workspaces` | bearer | workspace membership/read or platform scope |
| GET | `/workspaces/{workspace_id}` | bearer | workspace read |
| PATCH | `/workspaces/{workspace_id}` | bearer | `iam.workspaces.manage` |
| GET | `/workspaces/{workspace_id}/overview` | bearer | workspace read |
| GET | `/users` | bearer | `iam.users.read` |
| POST | `/users` | bearer | `iam.users.manage` |
| GET | `/users/{user_id}` | bearer | `iam.users.read` |
| PATCH | `/users/{user_id}` | bearer | `iam.users.manage` |
| GET | `/roles` | bearer | `iam.roles.read` |
| POST | `/roles` | bearer | `iam.roles.manage` |
| GET | `/roles/{role_id}` | bearer | `iam.roles.read` |
| PATCH | `/roles/{role_id}` | bearer | `iam.roles.manage` |
| GET | `/groups` | bearer | `iam.groups.read` |
| POST | `/groups` | bearer | `iam.groups.manage` |
| GET | `/groups/{group_id}` | bearer | `iam.groups.read` |
| PATCH | `/groups/{group_id}` | bearer | `iam.groups.manage` |
| PUT | `/groups/{group_id}/members` | bearer | `iam.groups.manage` |
| DELETE | `/groups/{group_id}` | bearer | lifecycle removal |
| GET | `/permissions` | bearer | `iam.roles.read` |
| POST | `/approval-requests` | bearer | requester context |
| GET | `/approval-requests` | bearer | own/reviewable requests |
| GET | `/approval-requests/{approval_request_id}` | bearer | own/reviewable request |
| PATCH | `/approval-requests/{approval_request_id}` | bearer | requester/reviewer capability |
| GET | `/audit-logs` | bearer | `audit.read` |

Approval requester identity always comes from `AuthContext`; request body has
no `requester_user_id`.

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
