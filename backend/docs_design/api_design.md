# BoMesh API — resource-oriented design

Status: canonical API design (base path `/api/v1`). This
document fixes the resource model, method set and rules; `openapi.yaml` is
the machine-readable contract with every field, error reason and
`x-permission`, and wins on those details. The Item domain (collections,
documents, links, contributions, revisions) is decided in `item_model.md`;
the schema is `design.dbml`.

Implementation status: the backend serves this contract; the web and mobile
clients still call the removed legacy routes, which section 9 maps to their
replacements.

Source of truth for the design rules: Google API Improvement Proposals
([AIP-190 naming](https://google.aip.dev/190) and the AIPs it references).
Product scope: the UX in `apps/ux_preview` (Home, Knowledge Hub, document
lifecycle, Spaces, Work, Requests, Manage, Platform console).

## 1. Rules (AIP digest)

| Rule | AIP |
| --- | --- |
| The API is a resource hierarchy. Every resource has a `name` field holding its resource name (`workspaces/{workspace}/items/{item}`); names alternate collection identifiers and IDs; IDs are strings. References to other resources are resource-name strings, never embedded objects or bare IDs. | [121](https://google.aip.dev/121), [122](https://google.aip.dev/122) |
| Collection identifiers are plural, `camelCase` American English (`items`, `savedSearches`). A collection identifier appears at most once in a name. | 122, 190 |
| Five standard methods only: `Get` (GET), `List` (GET), `Create` (POST to the collection), `Update` (PATCH with `updateMask`), `Delete` (DELETE). No `PUT`. Every non-singleton resource has `List`. | [131](https://google.aip.dev/131)–[135](https://google.aip.dev/135) |
| Anything else is a custom method `POST {name}:verb` (side effects) or `GET {name}:verb` (read-only); verb is `camelCase`, no prepositions, never a standard verb (`get`, `list`, `create`, `update`, `delete`). Collection-level: `POST {parent}/collection:verb`. Stateless: `POST /v1/collection:verb`. | [136](https://google.aip.dev/136) |
| `state` is output only. Lifecycle changes are state-transition custom methods (`:publish`, `:approve`); an illegal transition is `FAILED_PRECONDITION` (400). State enum values are `UPPER_SNAKE`; prefer `ACTIVE`, past participles for resting states (`SUSPENDED`), present participles for transient ones (`RUNNING`). | [216](https://google.aip.dev/216), [126](https://google.aip.dev/126) |
| `Update` has no side effects. Side effects belong to custom methods. | 134 |
| Soft delete: `Delete` marks deleted and returns the resource with `deleteTime`/`purgeTime`; `POST {name}:undelete` restores (`ALREADY_EXISTS` 409 if not deleted); `List` hides deleted unless `showDeleted=true`; `Get` still returns them. | [164](https://google.aip.dev/164) |
| Singletons (`{parent}/settings`) have `Get`/`Update`, never `Create`/`Delete`. | [156](https://google.aip.dev/156) |
| Revisions are a `revisions` sub-collection; each revision holds a `snapshot`; `POST {revision}:rollback`. | [162](https://google.aip.dev/162) |
| `-` reads across parents in `List` (`workspaces/-/ingestionRuns/-/tasks`); responses use canonical names. | [159](https://google.aip.dev/159) |
| Pagination `pageSize` (default 50, max 1000, coerced) / `pageToken` → `nextPageToken`; optional `totalSize`. Filtering `filter` ([AIP-160](https://google.aip.dev/160) syntax), ordering `orderBy` (`"updateTime desc"`). | 132, [158](https://google.aip.dev/158), 160 |
| Partial responses: `view` enum (`BASIC`, `FULL`) where a resource has expensive parts. | [157](https://google.aip.dev/157) |
| Create may take a user-chosen ID (`?{resource}Id=`), `validateOnly`, and `requestId` (UUID; retrying with the same id returns the first result) for idempotency. | [133](https://google.aip.dev/133), [155](https://google.aip.dev/155), [163](https://google.aip.dev/163) |
| Optimistic concurrency: resources edited by several people carry `etag`; a stale `etag` on Update/Delete/transition is `ABORTED` (409). | [154](https://google.aip.dev/154) |
| Long work returns a `google.longrunning.Operation` (`operations/{operation}`), polled with `GET /v1/operations/{operation}`. Domain jobs that users browse as history (`ingestionRuns`, `syncs`) are resources with a `state` instead. | [151](https://google.aip.dev/151) |
| JSON uses the proto3 JSON mapping: `lowerCamelCase` field and query names, enums as strings, timestamps RFC 3339 (`createTime`), durations as `"3600s"`, `int64` as strings. Times end in `Time`, durations in `Duration`, sizes carry units (`sizeBytes`), URIs end in `Uri`, booleans have no `is` prefix, language is `languageCode` (BCP-47). | [140](https://google.aip.dev/140), [141](https://google.aip.dev/141), [142](https://google.aip.dev/142), [143](https://google.aip.dev/143) |
| Standard fields: `name`, `uid`, `displayName`, `createTime`, `updateTime`, `deleteTime`, `purgeTime`, `etag`, `state`. | [148](https://google.aip.dev/148) |
| Errors are `google.rpc.Status` in the HTTP envelope `{"error": {code, message, status, details}}`; every error carries `ErrorInfo {reason, domain: "bomesh.app", metadata}`. | [193](https://google.aip.dev/193) |
| Authorization is checked before existence: no permission → `PERMISSION_DENIED` 403 ("… denied on resource '…' (or it might not exist)"), whether or not the resource exists; `NOT_FOUND` 404 only when the caller may read the parent. | [211](https://google.aip.dev/211), 193 |
| Resource ID aliases: `users/me`, `workspaces/{workspace}/members/me`, `sessions/current`. Responses always carry canonical names. | 122 |

HTTP shape: base path `/api/v1`; a method path is `/api/v1/{name}` or
`/api/v1/{parent}/{collection}`. In OpenAPI each name segment is a path
parameter named after the resource (`/api/v1/workspaces/{workspace}/items/{item}:publish`).

Status code map: `INVALID_ARGUMENT`, `FAILED_PRECONDITION`, `OUT_OF_RANGE` →
400; `UNAUTHENTICATED` → 401; `PERMISSION_DENIED` → 403; `NOT_FOUND` → 404;
`ALREADY_EXISTS`, `ABORTED` → 409; `RESOURCE_EXHAUSTED` → 429; `INTERNAL` →
500; `UNAVAILABLE` → 503.

One error per rule, across the API:

| Situation | Error | `ErrorInfo.reason` |
| --- | --- | --- |
| Granting a role the caller does not hold on that resource (members, roles, IAM policies, approving requests) | `PERMISSION_DENIED` | `ROLE_ESCALATION` |
| A forbidden change to yourself (own role, suspension, removal) | `FAILED_PRECONDITION` | `SELF_MODIFICATION` |
| Removing the last workspace admin / space lead | `FAILED_PRECONDITION` | `LAST_ADMIN` / `LAST_SPACE_LEAD` |
| A referenced resource (body field, filter, attachment, scope) the caller cannot read | `PERMISSION_DENIED` (never a precondition error that would reveal existence) | — |
| Illegal state transition | `FAILED_PRECONDITION` | resource-specific: `INVALID_WORKSPACE_STATE` (workspace lifecycle), `INGESTION_ALREADY_PAUSED` / `INGESTION_NOT_PAUSED`, `MEMBER_NOT_ACTIVE` / `MEMBER_NOT_SUSPENDED`, `ROLE_DELETED` (update/delete of a deleted custom role), `KNOWLEDGE_GAP_NOT_OPEN` / `KNOWLEDGE_GAP_ALREADY_OPEN` (`:dismiss` / `:reopen`), `CONVERSATION_DELETED` (update, `:converse`, feedback or share of a deleted conversation) |
| Operating inside a workspace that is not `ACTIVE` (§4) | `FAILED_PRECONDITION` | `WORKSPACE_CREATING` / `WORKSPACE_SUSPENDED` / `WORKSPACE_ARCHIVED` (writes) |
| Adding a non-member user to a group (CreateMembership) or a policy binding | `FAILED_PRECONDITION` | `NOT_WORKSPACE_MEMBER` |
| Stale `etag` | `ABORTED` | `ETAG_MISMATCH` |
| Module switched off | `FAILED_PRECONDITION` | `MODULE_DISABLED` |

People are referenced by member name (`workspaces/{workspace}/members/{member}`)
everywhere inside a workspace; `users/{user}` appears only on account-level
fields (`Member.user`, `Session.user`, audit actors). Every method that
returns an `Operation` declares its result and metadata types in
`x-operation-info`. Every non-public method names its IAM permission in
`x-permission`; account-self methods (sessions, preferences, operations
polling) use `x-permission: none` with an `x-authorization` rule.

Content never crosses a permission boundary through a derived surface:
lists, counts, facets, Home, shares, reading lists, materials, artifacts and
audit events are computed for the caller. Platform callers (`platformAdmin`,
`platformOperator`) read cross-workspace data (`workspaces/-/…`) as metadata
only: no document names, titles, selectors, audit descriptions or targets.

Authorization model: Google-IAM style. A permission is
`{collection}.{method}` (`items.publish`, `items.setIamPolicy`);
a role is a set of permissions; roles are granted by IAM policies on
`workspaces`, COLLECTION `items` and `spaces`
(`:getIamPolicy`, `:setIamPolicy`, `:testIamPermissions`). Policies are
inherited downward (workspace → collection → nested collection until
`inheritAccess = false` → document; workspace → space).
Principals: `user:{userId}`, `group:{groupId}` (the Group resource ID, never its UUID), `workspaceMembers` (every
active member of the workspace). Each method states its permission in
`x-permission`.

`bomesh/iam/catalog.py` is the authoritative list of permissions (one per
`x-permission` value, with the scopes where a grant confers it) and of the
predefined roles; `tests/v1/iam` keeps it in step with `openapi.yaml`. A grant
at a scope confers only the role's permissions valid there; a workspace grant
also reaches every collection and space. Owner and self rules in
`x-authorization` still narrow what a holder may touch.

| Predefined role (`roles/…`) | Scope | Holds |
| --- | --- | --- |
| `workspaceAdmin` | workspace | Every permission grantable on a workspace (knowledge, taxonomy, sources, settings, people, audit) |
| `workspaceMember` | workspace | Workspace, settings and assistant reads; members, groups, roles; `items.list`/`.search`/`.testIamPermissions` (reading itself comes from collection grants); contributions; topics; reading lists; own library, conversations, shares and artifacts; connector catalog; see/join/leave spaces, request types; create, list and withdraw own requests |
| `collectionViewer` | collection | `items.get`/`.list`/`.search`/`.testIamPermissions`, `itemLinks.get`/`.list`, `tasks.get`/`.list` |
| `collectionEditor` | collection | viewer + `items.create`/`.update`/`.move`/`.publish`/`.verify`, `itemLinks.create`/`.delete`, `ingestionRuns.create` |
| `collectionOwner` | collection | editor + `items.delete`/`.undelete`/`.getIamPolicy`/`.setIamPolicy`, `contributions.review`, request deciding (`COLLECTION_ACCESS`) |
| `spaceMember` | space | Read the space, its members, announcements, events, materials, request types; leave |
| `spaceStaff` | space | member + post announcements, events, materials; decide and answer the space's requests |
| `spaceLead` | space | staff + update/delete the space, its IAM policy, members and request types |
| `platformOperator` | platform | Accounts and workspaces (read), usage, pause/resume ingestion, ingestion runs/tasks (metadata), retry runs, audit metadata, connectors and ingestion policy (read), components, incidents |
| `platformAdmin` | platform | operator + account and workspace lifecycle (create, suspend, activate, archive), connector and ingestion-policy changes, deciding `CONNECTOR` requests; never workspace content |

Custom roles live at `workspaces/{workspace}/roles/{role}`.

## 2. Interfaces and resource tree

Interfaces (OpenAPI tags) are `UpperCamelCase` nouns (AIP-190). The tree
lists every resource; `◇` marks a singleton.

```text
Identity
  users/{user}                                   alias users/me
    ◇ users/{user}/preferences
  sessions/{session}                             alias sessions/current

Workspaces
  workspaces/{workspace}
    ◇ workspaces/{workspace}/settings
    ◇ workspaces/{workspace}/assistant
    ◇ workspaces/{workspace}/overview
    workspaces/{workspace}/members/{member}      alias members/me (member ID = user ID)
      ◇ …/members/{member}/home
      …/members/{member}/savedItems/{savedItem}
      …/members/{member}/recentItems/{recentItem}
      …/members/{member}/savedSearches/{savedSearch}
      …/members/{member}/notifications/{notification}
    workspaces/{workspace}/groups/{group}
      …/groups/{group}/memberships/{membership}
    workspaces/{workspace}/roles/{role}          (custom roles)
    workspaces/{workspace}/auditEvents/{auditEvent}
    workspaces/{workspace}/knowledgeGaps/{knowledgeGap}
  roles/{role}                                   (predefined, read-only)
  permissions/{permission}                       (catalog, read-only)

Knowledge
  workspaces/{workspace}/items/{item}            (COLLECTION or DOCUMENT)
    ◇ …/items/{item}/content                     (documents)
    …/items/{item}/passages/{passage}
    …/items/{item}/revisions/{revision}
    …/items/{item}/links/{link}                  (collections: shortcuts to documents; link ID = document ID)
  workspaces/{workspace}/contributions/{contribution}
  workspaces/{workspace}/topics/{topic}
  workspaces/{workspace}/readingLists/{readingList}
    …/readingLists/{readingList}/entries/{entry}

Ingestion
  connectors/{connector}                         (platform catalog)
  workspaces/{workspace}/connections/{connection}
  workspaces/{workspace}/sources/{source}
    …/sources/{source}/syncs/{sync}
  workspaces/{workspace}/ingestionRuns/{ingestionRun}
    …/ingestionRuns/{ingestionRun}/tasks/{task}
  ingestionPolicies/{ingestionPolicy}            (platform; `default`)

Assistant
  workspaces/{workspace}/conversations/{conversation}
    …/conversations/{conversation}/messages/{message}
    …/conversations/{conversation}/shares/{share}
  workspaces/{workspace}/artifacts/{artifact}
    …/artifacts/{artifact}/revisions/{revision}

Collaboration (modules: answer FAILED_PRECONDITION reason MODULE_DISABLED when off)
  workspaces/{workspace}/spaces/{space}
    …/spaces/{space}/members/{member}
    …/spaces/{space}/materials/{material}
    …/spaces/{space}/announcements/{announcement}
    …/spaces/{space}/events/{event}
    …/spaces/{space}/requestTypes/{requestType}
  workspaces/{workspace}/requests/{request}
    …/requests/{request}/messages/{message}

Operations
  operations/{operation}
  components/{component}                         (service and AI-model health)
  incidents/{incident}
  auditEvents/{auditEvent}                       (platform-level events)
```

Design decisions:

- **The workspace is the tenant parent and is explicit in every name.** The
  session no longer carries an "active workspace"; the client remembers the
  last one in `users/{user}/preferences`. Multi-workspace clients and caches
  need no hidden state.
- **One Item identity for collections and documents** (`item_model.md`).
  `items` mirrors the canonical `items` table: `itemType` selects the
  `collection` or `document` facet. Names are flat under the workspace and
  `parentItem` is a field, like Drive files: moves and contribution approval
  never rename an Item, its citations or its references. A root collection is
  what the UX calls a knowledge base. Access is inherited from collections.
- **One concept, one resource.** Contribution review is `contributions`;
  every other ask-and-decide flow (collection access, joining a space,
  connector demand, office service requests, questions to a space) is
  `requests` with a `kind`. Curated lists are `readingLists` (never Items,
  never grant access); "Featured on Home" is `readingLists/featured`; "Work"
  outputs are `artifacts` with a `kind`; sign-ins are `auditEvents` of
  category `SIGN_IN`; AI capabilities are `components` of kind `AI_MODEL`.
- **Read models are output-only singletons** (`members/{member}/home`,
  `workspaces/{workspace}/overview`) or read-only custom methods
  (`:summarize`), never mutable resources.

## 3. Identity

**User** `users/{user}` — an account. Fields: `name`, `email`, `username`,
`displayName`, `state` (`ACTIVE`, `SUSPENDED`), `platformRole` (`NONE`,
`OPERATOR`, `ADMIN`), `lastActiveTime`, `createTime`, `updateTime`.

| Method | HTTP | Permission / auth |
| --- | --- | --- |
| CreateUser | `POST /users` | public (sign-up); `validateOnly` checks the email |
| GetUser | `GET /users/{user}` | self, or `users.get` (platform) |
| ListUsers | `GET /users` | `users.list` (platform); filter `state`, `platformRole`, `email` |
| UpdateUser | `PATCH /users/{user}` | self (`displayName`, `username`); `users.update` (platform) for `platformRole`; nobody changes their own `platformRole` |
| SuspendUser / ActivateUser | `POST /users/{user}:suspend` / `:activate` | `users.suspend` / `users.activate` (platform); never self |
| LookupUser | `GET /users:lookup?email=` | `members.create` in some workspace; exact email only; returns `name`, `email`, `displayName`, `state` |
| SendPasswordReset | `POST /users:sendPasswordReset` | public; same response whether or not the email exists |
| ResetPassword | `POST /users:resetPassword` | public; `{resetToken, newPassword}`; ends every session of the account |

**UserPreferences** ◇ `users/{user}/preferences` — `languageCode`,
`showWorkSteps`, `appearance {mode, theme, accentColor, backgroundTint,
cornerRadius, font}`, `emailNotifications {sourceFailures, accessRequests,
contributionUpdates, reviewQueue, requestUpdates, citedDocumentChanges,
weeklySummary}`, `lastWorkspace`. Get/Update, self only.

**Session** `sessions/{session}` — `name`, `user`, `authenticationMethod`
(`PASSWORD`, `GOOGLE`), `accessToken` (input-less, returned once on create),
`expireTime`, `createTime`, `lastSeenTime`, `state` (`ACTIVE`, `ENDED`).

| Method | HTTP | Auth |
| --- | --- | --- |
| CreateSession | `POST /sessions` | public; body `credential` = `{password: {email\|username, password}}` or `{google: {idToken}}` |
| GetSession | `GET /sessions/{session}` | own (`sessions/current`) |
| ListSessions | `GET /sessions` | own sessions |
| DeleteSession | `DELETE /sessions/{session}` → the Session in state `ENDED` (sign out) | own |

## 4. Workspaces, people, governance

**Workspace** `workspaces/{workspace}` — system ID. `displayName`, `code`
(unique web address, mutable, `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`),
`template` (`ENTERPRISE`, `CAMPUS`), `demo`, `state` (`CREATING`, `ACTIVE`,
`SUSPENDED`, `ARCHIVED`), `ingestionState` (`ACTIVE`, `PAUSED`),
`memberCount`, `etag`, times. State rules for every method inside a
workspace: `CREATING` → `FAILED_PRECONDITION` reason `WORKSPACE_CREATING`;
`SUSPENDED` → reason `WORKSPACE_SUSPENDED`; `ARCHIVED` is read-only (writes →
reason `WORKSPACE_ARCHIVED`). Get, Suspend, Activate and Archive of the
workspace itself are exempt.

| Method | HTTP | Permission |
| --- | --- | --- |
| CreateWorkspace | `POST /workspaces` (body: the Workspace, with input-only `initialAdminEmail`; `requestId`) → Operation (`CREATING` → `ACTIVE`) | `workspaces.create` (platform) |
| GetWorkspace / ListWorkspaces | `GET /workspaces/{workspace}` / `GET /workspaces` | member; platform sees all (`workspaces.list`) |
| UpdateWorkspace | `PATCH /workspaces/{workspace}` (`displayName`, `code`) | `workspaces.update` |
| ArchiveWorkspace | `POST …:archive` `{confirmationCode}` (must equal `code`) | `workspaces.archive` |
| SuspendWorkspace / ActivateWorkspace | `POST …:suspend` / `:activate` (also unarchives) | `workspaces.suspend` / `.activate` (platform) |
| PauseWorkspaceIngestion / ResumeWorkspaceIngestion | `POST …:pauseIngestion` / `:resumeIngestion` | `workspaces.pauseIngestion` (platform) |
| GetIamPolicy / SetIamPolicy / TestIamPermissions | `POST …:getIamPolicy` / `:setIamPolicy` / `:testIamPermissions` | `workspaces.getIamPolicy` / `.setIamPolicy` / any member |
| AnalyzeWorkspaceIamPolicy | `GET …:analyzeIamPolicy?principal=` → effective roles of a principal on every knowledge base and space | `workspaces.getIamPolicy` |
| SummarizeWorkspaceUsage | `GET /workspaces:summarizeUsage?window=` (per-workspace questions, active people, documents processed) | `workspaces.summarizeUsage` (platform) |
| ExportWorkspaceUsage | `POST /workspaces:exportUsage` → Operation with `downloadUri` (CSV) | same |

**WorkspaceSettings** ◇ `…/settings` — `modules {spaces, work, requests}`,
`spaceTypes [{key, displayName, icon, enabled}]`, `workflows [{key, enabled}]`
(`EVIDENCE_REVIEW`, `DRAFT`, `STUDY_GUIDE`, `QUIZ`), `documentTypes [{key,
displayName}]`, `defaultPublishingPolicy` (`AUTO_PUBLISH`, `REVIEW_FIRST`;
default for new sources), `reverificationDuration`, `etag`. Get (members) /
Update (`workspaces.updateSettings`).
Turning a module off keeps its data.

**Assistant** ◇ `…/assistant` — `instructions` (≤ 2000), `answerLength`
(`CONCISE`, `BALANCED`, `DETAILED`), `capabilities {webSearch, fileWork,
charts}`, `welcomeMessage`, `starterPrompts [{title, prompt, roles[]}]` (≤ 3
per role), `etag`. Get (members) / Update (`workspaces.updateAssistant`).

**WorkspaceOverview** ◇ `…/overview` — output only; Get with `timeZone`,
`window` (`P1D`, `P7D`, `P30D`). Attention items (`kind`: `CONTRIBUTIONS_WAITING`,
`PUBLISH_FAILED`, `REVERIFICATION_DUE`, `SOURCE_FAILING`,
`CONNECTION_EXPIRED`, `ACCESS_REQUESTS`, `DOCUMENTS_WAITING_TO_PUBLISH`, with
`count` and `target` resource), KPIs, daily usage series. Permission
`workspaces.getOverview`.

**Member** `…/members/{member}` — `user`, `displayName`, `email`, `state`
(`ACTIVE`, `SUSPENDED`), `roles[]` (output, from IAM), `groups[]` (output),
`joinTime`, `lastActiveTime`.

| Method | HTTP | Permission |
| --- | --- | --- |
| CreateMember | `POST …/members` `{user}` + `roles[]` (granted in the same call) | `members.create`; cannot grant beyond the caller's own roles |
| GetMember / ListMembers | `GET` | `members.get` / `members.list` (filter `state`, `roles`, `groups`) |
| DeleteMember | `DELETE` (ends membership; account untouched) | `members.delete`; not self; not the last admin |
| SuspendMember / ActivateMember | `POST …:suspend` / `:activate` | `members.suspend`; not self; not the last admin |

Role changes are `workspaces/{workspace}:setIamPolicy` (read-modify-write with
`etag`).

**Group** `…/groups/{group}` (`displayName`, `description`, `memberCount`,
`etag`) with CRUD; **Membership** `…/groups/{group}/memberships/{membership}`
(`member`) Create/List/Delete. Permission `groups.*`.

**Role** `…/roles/{role}` (custom) — `displayName`, `description`,
`includedPermissions[]`, `state` (`ACTIVE`, `DELETED`), `etag`; CRUD with soft
delete and `:undelete` (`roles.*`); a role cannot include permissions the
caller lacks. `roles/{role}` (predefined) and `permissions/{permission}` are
Get/List only.

**AuditEvent** `…/auditEvents/{auditEvent}` and `auditEvents/{auditEvent}`
(platform) — `actor` (user or `system`), `category` (`KNOWLEDGE`, `FILES`,
`SOURCES`, `PEOPLE`, `SETTINGS`, `SPACES`, `REQUESTS`, `SIGN_IN`), `action`,
`description` (fixed template: action and resource type, never titles), `target`, `outcome` (`SUCCEEDED`, `FAILED`), `ipAddress`,
`createTime`. List/Get; `workspaces/-/auditEvents` lists across workspaces
(platform). `GET …/auditEvents:summarize?window=&timeZone=` returns counts per
bucket (activity charts); workspace only, no `workspaces/-` form. `POST …/auditEvents:export` (`filter`) → Operation
with a CSV `downloadUri`. Permission `auditEvents.list` / `.export` / `.summarize`.

**KnowledgeGap** `…/knowledgeGaps/{knowledgeGap}` — `question`,
`askCount`, `lastAskTime`, `reason` (`NOT_COVERED`, `OUTDATED`,
`RATED_UNHELPFUL`), `suggestedCollection`, `state` (`OPEN`, `DISMISSED`,
`RESOLVED`). List (filter `state`, window via `filter="lastAskTime>…"`),
Get, `:dismiss`, `:reopen`. Permission `knowledgeGaps.*`.
Gaps are clustered from asked questions, not stored: a question is a signal
when its answer was rated unhelpful (`RATED_UNHELPFUL`), cited nothing
(`NOT_COVERED`) or cited a document past its review date (`OUTDATED`);
precedence `RATED_UNHELPFUL` > `OUTDATED` > `NOT_COVERED`. Signals group by
normalized question text (lower-case, alphanumerics only) and the gap ID is
derived from that key. Only dismiss/resolve decisions are stored; a resolved
gap that is asked again reads `OPEN`.

## 5. Knowledge

Rationale, alternatives, authorization invariants and workflows:
`item_model.md`. Field-level contract: `openapi.yaml` (Knowledge).

**Item** `…/items/{item}` — `itemType` (`COLLECTION`, `DOCUMENT`;
immutable), `displayName`, `parentItem` (empty for a root collection; set on
create, changed only by `:move`), `parentRelation` (output: `CONTAINS`,
`CHILD`, `ATTACHMENT`), `ancestors[]` (output, view `FULL`: breadcrumbs the
caller can read), `access` (output: `READER`, `EDITOR`, `OWNER`, `LOCKED`),
`state` (`ACTIVE`, `DELETED`), `creator`, times, `purgeTime`, `etag`, and
exactly one facet:

- `collection` — `kind` (`STANDARD`, `PERSONAL` = each member's "My files",
  output), `owner` (personal only), `description`, `inheritAccess` (nested
  only; roots are always boundaries), `discoverable` (roots), `acceptsContributions`,
  `space`, `childCount`, `documentCount` (output, readable published, subtree), `linkCount` (output, visible links).
- `document` — `fileName`, `mimeType`, `sizeBytes`, `purpose` (`KNOWLEDGE`,
  `CONVERSATION_ATTACHMENT`), `documentType`, `topics[]`, `summary`,
  `languageCode`, `owner` (member), and output `contentState` (`PENDING`,
  `AVAILABLE`, `FAILED`), `publicationState` (`PUBLISHED`, `UNPUBLISHED`),
  `indexingState` (`PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, `OUTDATED`,
  `UNSUPPORTED`), `indexingError`, `lastIngestionRun`, `revision`,
  `verification`, `origin`, `qualityIssues[]` (editors), `thumbnailUri`,
  `uploadUri` (`PENDING`, creator).

Deletion, content, publication and indexing are four independent fields;
review state lives on the Contribution. A document is visible when it and its
ancestors are `ACTIVE`, the caller holds `items.get` on its governing
collection, and it is `PUBLISHED` (or the caller holds `items.update` there).

| Method | HTTP | Permission / rule |
| --- | --- | --- |
| CreateItem | `POST …/items` (`requestId`) → documents return `PENDING` + signed `uploadUri`; `POST /upload/api/v1/workspaces/{workspace}/items` multipart for one-call upload | `items.create` on `parentItem` (on the workspace for a root collection). Documents only under collections; new documents are `PUBLISHED`; non-editors contribute instead |
| CompleteItemUpload | `POST …/items/{item}:completeUpload` (validates the stored object) | creator |
| GetItem | `GET …/items/{item}` (`view`), `?alt=media` → 302 to the signed original | `items.get` |
| ListItems | `GET …/items` — `filter` over `parentItem` (`""` = roots), `ancestors:` (subtree), `itemType`, `displayName`, `document.*` (type, topics, owner, purpose, states, origin, verification, quality issues); `orderBy`; `showDeleted`; `showLocked` | `items.list` (visible items only) |
| SearchItems | `POST …/items:search` `{query, filter, facetSpecs[], orderBy, relatedItem, contentSearchSpec, pageSize, pageToken}` → documents with snippets/passages, permission-filtered facets | `items.search`. The one catalog and retrieval search; hits are re-authorized in PostgreSQL |
| UpdateItem | `PATCH` — `displayName`, collection settings, document metadata; `collection.inheritAccess` also needs `items.setIamPolicy` | `items.update` |
| DeleteItem / UndeleteItem | `DELETE` (`force` for a non-empty collection; the live subtree is deleted together) / `POST …:undelete` (restores that cohort and its search visibility; 30-day retention). DELETED items are shown only to `items.undelete` holders and never serve content | `items.delete` / `.undelete` on every access boundary in the cohort (`SUBTREE_HAS_FOREIGN_BOUNDARY`); personal collections cannot be deleted |
| MoveItem | `POST …:move` `{destinationParent, etag}` | `items.move` + `items.create` on the destination; crossing an access boundary also needs `items.setIamPolicy` on the source boundary; not for source-managed items, candidates of open contributions (`CONTRIBUTION_OPEN`), conversation attachments, personal collections, or into another member's personal collection |
| PublishItem / UnpublishItem | `POST …:publish` / `:unpublish` (documents; never starts processing) | `items.publish` |
| VerifyItem | `POST …:verify` | `items.verify` |
| MergeItem | `POST …:merge` `{targetItem}` — this duplicate is deleted and records `mergedInto`; reading-list, saved and recent references resolve to the target at read time | `items.delete` here + `items.update` on target |
| GetItemContent | ◇ `GET …/items/{item}/content` (`revision` optional; a revision without a stored preview is `REVISION_NOT_RENDERED`) — reader representation | `items.get` |
| GetPassage / ListPassages | `GET …/passages/{passage}` (citation target; always of `document.indexedRevision`) / `GET …/passages` | `items.get` |
| GetItemRevision / ListItemRevisions | `GET …/revisions[/{revision}]` — newest first; created by upload, approved new revisions, source versions and rollback | `items.get` |
| RollbackItem | `POST …/revisions/{revision}:rollback` (reuses the stored object; not for source-managed documents) | `items.publish` |
| Get/Set/TestItemIamPermissions | `POST …:getIamPolicy` etc. | `items.getIamPolicy` / `.setIamPolicy` on collections only; `workspaceMembers` may only hold `roles/collectionViewer`; personal collections cannot be shared |
| CreateItemLink / GetItemLink / ListItemLinks / DeleteItemLink | `POST …/items/{collection}/links` `{targetItem}` / `GET` / `GET` / `DELETE` (soft) | `itemLinks.create` / `.get` / `.list` / `.delete` on the container; target must be a readable DOCUMENT that does not already live there (`LINK_TARGET_NOT_DOCUMENT`, `LINK_TO_OWN_PARENT`, `LINK_TARGET_NOT_ALLOWED`); links whose target the caller cannot read are absent |

An item link shows one canonical document inside another collection
(`item_model.md` §4.2): no copy, no grant, and no effect on `parentItem`,
`ancestors`, subtree filters, conversation scope, ingestion or counts other
than `linkCount`. Deleting the container removes its links in the same
cohort; a deleted target hides its links until undelete.

Asking for access is `CreateRequest` with `kind: COLLECTION_ACCESS`.
Reviewers of an open contribution may `GetItem`, `GetItemContent` and
download its candidate document — nothing else. NEW_REVISION contributions
always target the replaced document's governing collection; while a
contribution is open its candidate cannot move, be deleted or change content,
and approval requires the contribution `etag` the reviewer saw.

**Contribution** `…/contributions/{contribution}` — `kind`
(`NEW_DOCUMENT`, `NEW_REVISION`), `origin` (`MEMBER`, `SOURCE`), `item` (the
candidate document: in the contributor's personal collection, or unpublished
in a source's target collection), `targetCollection` (empty = let the
assistant suggest), `replacesItem` (`NEW_REVISION`), `contributor`, `source`,
`note`, `changeSummary`, `suggestions` (output), `flags[]` (output, with
`relatedItem`), `audienceSummary`, `state` (`ANALYZING`, `IN_REVIEW`,
`CHANGES_REQUESTED`, `APPROVED`, `REJECTED`, `WITHDRAWN`), `decision`,
`events[]` (view `FULL`), times, `etag`.

| Method | HTTP | Permission |
| --- | --- | --- |
| CreateContribution | `POST …/contributions` (`requestId`) — puts a personal document up for review without copying it | `contributions.create` |
| GetContribution / ListContributions | `GET` (`view`) / `GET` — `filter` `state`, `targetCollection`, `contributor = "workspaces/w/members/me"`, `flags`, `kind`, `origin` | contributor; reviewers (`contributions.review` on the target collection) |
| DeleteContribution | `DELETE` (`REJECTED`/`WITHDRAWN` only) | contributor |
| ApproveContribution | `POST …:approve` `{targetCollection, documentType, topics[], summary}` — moves the candidate into the collection and publishes it (source candidates are published in place; `NEW_REVISION` appends a revision to `replacesItem`). **Never starts an ingestion run** | `contributions.review` and `items.publish` on the target collection |
| RequestContributionChanges | `POST …:requestChanges` `{message}` | `contributions.review` |
| RejectContribution | `POST …:reject` `{message}` | `contributions.review` |
| WithdrawContribution | `POST …:withdraw` | contributor (`MEMBER` origin) |
| ResubmitContribution | `POST …:resubmit` `{item?, note?, changeSummary}` (back to `ANALYZING`) | contributor |

Sources with `publishingPolicy: REVIEW_FIRST` open `SOURCE` contributions for
new files and `NEW_REVISION` ones for changed published files; the published
revision keeps answering until approval.

**Topic** `…/topics/{topic}` — `displayName`, `description`, `kind`
(`DOMAIN`, `TOPIC`), `parentTopic` (topics only), `icon`, `color`, `state`
(`PROPOSED`, `ACTIVE`, `REJECTED`, `DELETED`), `evidence[]` (output:
contributions that proposed it, filtered to the caller), `documentCount`
(readable published, output), `inReviewCount` (reviewers only).

| Method | HTTP | Permission |
| --- | --- | --- |
| CreateTopic | `POST` (admins create `ACTIVE` topics; the assistant creates `PROPOSED` ones) | `topics.create` |
| GetTopic / ListTopics | `GET` — `filter` `state`, `kind`, `parentTopic` | `topics.get` / `topics.list`; `PROPOSED` and `REJECTED` topics only for `topics.accept` holders |
| UpdateTopic | `PATCH` | `topics.update` |
| DeleteTopic / UndeleteTopic | `DELETE` (only when unused) / `:undelete` | `topics.delete` |
| AcceptTopic | `POST …:accept` `{parentTopic, displayName?}` — tags the contributions that proposed it | `topics.accept` |
| RejectTopic | `POST …:reject` | `topics.accept` |
| MergeTopic | `POST …:merge` `{targetTopic}` — retags documents and contributions | `topics.update` |

**ReadingList** `…/readingLists/{readingList}` (curated, ordered references;
never an Item, never grants access) — `displayName`, `description`, `owner`,
`audience` (`PRIVATE`, `SPACE`, `WORKSPACE`), `space`, `type` (`STANDARD`,
`FEATURED` — the workspace's single `readingLists/featured`, shown on Home),
`itemCount` (readable), `hiddenItemCount`, `state`, `deleteTime`, `etag`.
CRUD with soft delete/undelete; `POST …:copy` (duplicate). Entries
`…/readingLists/{readingList}/entries/{entry}` (entry ID = item ID): `item`
(document or collection), `note`, `position`, `addedBy`, `createTime`;
Create/Get/List (ordered by `position`; unreadable items omitted and
counted)/Update/Delete. Visibility: `PRIVATE` → owner; `SPACE` → members of
that space; `WORKSPACE` → every member. `audience: WORKSPACE` and the
featured list need `readingLists.publish`; `SPACE` needs space lead or staff.

Contribution flags reveal a `DUPLICATE` and its `relatedItem` to the
contributor only when they can read it; `SearchItems.relatedItem` needs
`items.get` on that item.

**Member library** (self only; `members/me` alias):

- `savedItems/{savedItem}` (ID = item ID): `item`, `createTime`;
  Create/Get/List/Delete.
- `recentItems/{recentItem}` (ID = item ID): `item`, `viewTime`; Get/List;
  `PATCH …/recentItems/{recentItem}?allowMissing=true` records a view (the
  Reader calls it); `POST …/recentItems:clear` removes all; Delete removes one.
- `savedSearches/{savedSearch}`: `displayName`, `query`, `filter`, `orderBy`,
  `layout` (`LIST`, `TABLE`, `GRID`); CRUD.
- `notifications/{notification}`: `kind`, `title`, `body`, `target`
  (resource name), `read`, `createTime`, `deleteTime`; Get/List
  (`filter="read=false"`, `totalSize` = unread count)/Update (`read`)/Delete
  (dismiss, soft)/`:undelete`; `POST …/notifications:markRead` (`filter`)
  marks many. Created only for things the member may read.
- ◇ `home`: output only — counts, suggested questions (role-aware, from the
  assistant), topic domains with counts, root collections (incl. `LOCKED`),
  shared reading lists, featured (curated then popular), recently published,
  recommended (with `reason`), continue (recent items, own contributions,
  review queue count, up next). `Member.personalCollection` names "My files".

## 6. Ingestion

**Connector** `connectors/{connector}` (platform catalog) — `displayName`,
`description`, `authenticationType` (`OAUTH`, `API_TOKEN`, `NONE`),
`state` (`ACTIVE`, `DISABLED`, `UNSUPPORTED`), `oauthClient {clientId,
clientSecret (input only), secretConfigured}`, `workspaceCount`,
`requestCount`. Get/List (members see `ACTIVE` ones), Update
(`connectors.update`), `:enable` / `:disable` (`connectors.enable`).

**Connection** `…/connections/{connection}` — `connector`, `displayName`,
`owner` (member for a personal connection; empty = workspace-owned),
`account {displayName, resourceLabel}`, `state` (`AUTHORIZING`, `ACTIVE`,
`REAUTHORIZATION_REQUIRED`, `FAILED`), `authorizationUri` (output while
`AUTHORIZING`), `apiToken` (input only), `config` (map of strings; non-secret
connector settings such as the Confluence site URL; set on create, then
immutable — only `displayName` is updatable), `lastCheckTime`. A connection
created with an `apiToken` (and the `config` keys its connector accepts) is
`ACTIVE` at once, even for a connector whose catalog `authenticationType` is
`OAUTH`; without one an OAuth connector starts `AUTHORIZING`. CRUD;
`POST …:test` (only `ACTIVE` connections, else `FAILED_PRECONDITION`
`CONNECTION_NOT_ACTIVE`); `POST …:reauthorize` →
new `authorizationUri`; `GET …:browseResources?path=` lists what the account
can reach. Permission `connections.*` (workspace-owned) or owner.

The OAuth provider redirect target is `GET /oauth/callback?code=&state=`
(at the application root, `BOMESH_INTEGRATION_OAUTH_REDIRECT_URI` =
`<public base>/oauth/callback`): a protocol endpoint, not an API method. It
needs no bearer token — the sealed `state` (workspace, user, connection, PKCE
verifier) is the authority, and the user must still be an ACTIVE member allowed
to complete it. It answers with a page that posts `{source:
'bomesh.connection', status: 'connected' | 'error', nonce, connection}` to the
configured client origin; the connection becomes `ACTIVE`, and an account
already connected by the same owner completes that existing connection.

**Source** `…/sources/{source}` — `connection` and `targetCollection`
(immutable; a COLLECTION item), `externalResource {type, id, displayName}`
(immutable), `displayName`, `config` (Struct; replacing it re-scans),
`schedule {cron, timeZone}`, `publishingPolicy` (`AUTO_PUBLISH`,
`REVIEW_FIRST`), `state` (`ACTIVE`, `PAUSED`, `FAILED`,
`REAUTHORIZATION_REQUIRED`), `lastSync` (output summary),
`pendingDocumentCount`, `inReviewCount`, `etag`. Creating a source needs
`items.create` on the target collection (and `items.publish` for
`AUTO_PUBLISH`); a personal connection can only be used by its owner. CRUD
(Create starts the first sync; `validateOnly` stores nothing and returns the
would-be Source without `etag`, times or server-computed state); Delete
removes it from the API (Get is then `NOT_FOUND`, its schedule is removed,
its items stay); `:pause` / `:resume`. Permission `sources.*`.

**Sync** `…/sources/{source}/syncs/{sync}` — `trigger` (`MANUAL`,
`SCHEDULED`, `CREATION`), `state` (`RUNNING`, `SUCCEEDED`, `FAILED`),
`addedCount`, `updatedCount`, `removedCount`, `failedCount`, `failures[]`, `error`, `startTime`,
`endTime`. Create (sync now; `FAILED_PRECONDITION` while one runs or the
source is paused), Get, List; `sources/-/syncs` is the sync-history page. A
sync only registers, updates or removes document Items; it never processes them.

**IngestionRun** `…/ingestionRuns/{ingestionRun}` — the only way documents
are processed. `selector {items[] ≤ 1000, ancestor (a collection subtree),
source, states[]}` (set fields narrow each other; resolved once into tasks at
creation), `trigger`, `state` (`QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`,
`CANCELLED`), `counts`, `error`, `retryOf`, times. Create (`requestId`;
"Process", re-process; a selector matching nothing yields an empty run,
immediately `SUCCEEDED` with zero tasks), Get, List, `:cancel`, `:retry`
(returns the new run).
Permission is checked on each selected document's governing collection;
attachments, artifacts, unsupported and content-pending documents are never
selected; unpublished documents may be processed and stay hidden from
retrieval. Tasks `…/ingestionRuns/{ingestionRun}/tasks/{task}` (task ID =
item ID): `item`, `state`, `phase`, `phases[]`, `error`, `errorClass`, times;
Get/List. Platform callers read `workspaces/-/ingestionRuns/-/tasks` and
`workspaces/-/ingestionRuns:summarize` (per-workspace queue, throughput,
failure rate, error classes); their responses never include `item`, file
names or content. Retrying failed jobs from the platform console is
`CreateIngestionRun` with `selector.states: [FAILED]` and `trigger:
PLATFORM_RETRY` (`ingestionRuns.create` granted by `platformOperator`).

**IngestionPolicy** `ingestionPolicies/default` — `allowedMimeTypes[]`,
`maxFileSizeBytes`, `ocrScannedPdfs`, `parseSpreadsheets`,
`contributionReviewRequired` (output, always true: member contributions are
always reviewed), `rejectedRetentionDuration`, `etag`. Get/List/Update
(`ingestionPolicies.update`, platform).

## 7. Assistant

**Conversation** `…/conversations/{conversation}` — owner-private.
`displayName`, `owner`, `pinned`, `scope {collections[] (collection
subtrees), spaces[]}`, `lastMessageTime`, `createTime`,
`updateTime`, `deleteTime`. Create (client may choose the ID with
`conversationId`), Get, List (own), Update (`displayName`, `pinned`,
`scope`), Delete/`:undelete`.

| Method | HTTP | Rule |
| --- | --- | --- |
| ConverseConversation | `POST …/conversations/{conversation}:converse` `{message, attachments[] (readable document items; uploads are CreateItem with `purpose: CONVERSATION_ATTACHMENT` in the caller's personal collection), replaceFromMessage}` → `text/event-stream` (OpenResponses events) | owner; the server owns history |
| ListMessages / GetMessage | `GET …/messages[/{message}]` — `role`, `text`, `citations[]`, `artifacts[]`, `state` (`COMPLETED`, `INTERRUPTED`, `FAILED`), `feedback` | owner |
| SubmitMessageFeedback | `POST …/messages/{message}:submitFeedback` `{rating: HELPFUL\|UNHELPFUL\|RATING_UNSPECIFIED (clears), reason, comment}` | owner; feeds knowledge gaps |

**Share** `…/conversations/{conversation}/shares/{share}` — `audience`
(`WORKSPACE`, `PEOPLE`), `recipients[]` (members), `uri`, `snapshot`
(output, taken by the server from stored turns; re-filtered on every read:
turns and citations the reader cannot open now are withheld), `createTime`. Create (one live share per
conversation: creating revokes the previous), Get (owner or audience),
List (owner), Delete (revoke).

**Artifact** `…/artifacts/{artifact}` — every assistant-made file and Work
output; its own Assistant resource (stored on an Item row in a hidden system
collection that `items` never returns). `displayName`, `kind` (`FILE`, `DRAFT`, `EVIDENCE_REVIEW`,
`STUDY_GUIDE`, `QUIZ`), `mimeType`, `owner`, `conversation`, `space`,
`audience` (`PRIVATE`, `SPACE`), `sourceItems[]` (readable),
`hiddenSourceCount`, `evidenceReview {options[], criteria[], cells[]
{option, criterion, state, summary, citations[]}, synthesis}`, `state`
(`GENERATING`, `ACTIVE`, `FAILED`, `DELETED`), `revision`, times.

| Method | HTTP | Rule |
| --- | --- | --- |
| CreateArtifact | `POST …/artifacts` (body: the Artifact — `kind`, `sourceItems`, `space`, `audience`, input-only `generationInstructions`; `requestId`) → Operation → Artifact. `audience: SPACE` runs the audience check below | `artifacts.create`; module Work on for non-`FILE` kinds |
| GetArtifact / ListArtifacts | `GET` (`?alt=media` downloads the current revision) / `GET` — `filter` `kind`, `space`, `owner`, `conversation` | owner, or space members when `audience: SPACE` |
| UpdateArtifact | `PATCH` — `displayName`, `audience`, `space`, `evidenceReview.options`, `evidenceReview.criteria`; `audience: SPACE` is refused (`AUDIENCE_CANNOT_READ_SOURCES`) when the space's members cannot read every source. Reads (Get, Export) also withhold cells and text whose sources the reader cannot open now | owner |
| DeleteArtifact / UndeleteArtifact | `DELETE` / `:undelete` | owner |
| ReviseArtifact | `POST …:revise` `{instructions, cells?}` → Operation (assistant writes a new revision or regenerates cells) | owner |
| CommitArtifact | `POST …:commit` `{text, changeSummary}` — a person's edit becomes a new revision | owner; text kinds |
| ExportArtifact | `GET …:export?mimeType=&revision=` (CSV, PDF, Markdown, DOCX) | readers |
| PublishArtifact | `POST …:publish` `{collection}` → `{item}`: a new published document Item in that collection (a contributor publishes into their personal collection, then CreateContribution) | owner + `items.create` on the collection |
| Revisions | `GET …/revisions[/{revision}]` (`snapshot`, `author`: `ASSISTANT`\|`USER`, `changeSummary`), `POST …/revisions/{revision}:rollback`, `DELETE …/revisions/{revision}` (only the newest user revision, within 10 minutes) | owner |

Withholding is per reader and per part: a cell (or the synthesis) is withheld
when one of its citations is unreadable; text kinds derive from all sources
together, so one unreadable source withholds the whole text (Export renders
an "unavailable" placeholder, `alt=media` and binary exports are 403).
Generation and revision run the configured agent model behind the operation,
as a task of the API process; a cell without any passage from the sources is
`NOT_FOUND` without a model call. A stopped generation (CancelOperation,
shutdown, or a crash repaired by the startup reconciler of §8) leaves a new
artifact `FAILED`, a revised one `ACTIVE` again and its generating cells
`FAILED`. While an artifact is `GENERATING` nothing else writes it. Files the
agent writes during a turn record the documents the turn read or cited (those
the caller can read) as their `sourceItems`, so the SPACE audience check
covers them.

## 8. Collaboration and operations

**Space** `…/spaces/{space}` — `displayName`, `spaceType`, `description`,
`joinPolicy` (`OPEN`, `REQUEST`, `INVITE`), `memberCount`, `callerRole`
(output), `collections[]` (output: linked collections), `state` (`ACTIVE`, `DELETED`). CRUD
with soft delete; `:join` (open spaces), `:leave`; IAM
(`:getIamPolicy`/`:setIamPolicy`, roles `spaceLead`/`spaceStaff`/`spaceMember`).
Members `…/spaces/{space}/members/{member}` (`member` = workspace member name, required on create; `roles[]` output from IAM,
`joinTime`): Create/List/Get/Delete. Materials `…/materials/{material}`
(`document`, `note`, `addedBy`; never changes access; unreadable materials
omitted): Create/List/Get/Delete. Announcements (`title`, `body`, `pinned`,
`author`) and Events (`title`, `startTime`, `endTime`, `location`,
`description`): CRUD. RequestTypes `…/requestTypes/{requestType}` (soft delete + `:undelete`; requests keep their reference)
(`displayName`, `description`, `fields[] {key, displayName, type, required,
options[]}`, `rules[] {condition (CEL over requester profile and fields),
severity: BLOCK|WARN, message, policyCitation}`, `slaDuration`, `state`):
CRUD.

**Request** `…/requests/{request}` — `kind` (`SERVICE`, `QUESTION`,
`COLLECTION_ACCESS`, `SPACE_MEMBERSHIP`, `CONNECTOR`), `requestType`
(`SERVICE`), `space` (`SERVICE`, `QUESTION`, `SPACE_MEMBERSHIP`),
`collection` (`COLLECTION_ACCESS`), `target` (connector), `requestedRole`
(`COLLECTION_ACCESS`: `collectionViewer` or `collectionEditor`; `SPACE_MEMBERSHIP`: `spaceMember`; approvers may grant an
equal or lower role and never one they do not hold), `title`, `fields`
(Struct), `question`, `sourceMessage` (input: a conversation message the
requester owns), `assistantContext {answer, citations[]}` (output, built by
the server from `sourceMessage`, citations filtered per reader),
`requester`, `assignee`, `state` (`OPEN`, `NEEDS_INFO`, `APPROVED`,
`DENIED`, `ANSWERED`, `WITHDRAWN`, `CLOSED`), `dueTime`, `overdue`,
`eligibility {outcome: PASS|WARN|BLOCK, results[]}` (output), `faqItem`,
times.

| Method | HTTP | Rule |
| --- | --- | --- |
| CreateRequest | `POST …/requests` (`requestId`, `validateOnly` → returns `eligibility` without creating; a `BLOCK` result is `FAILED_PRECONDITION` reason `REQUEST_NOT_ELIGIBLE`) | members |
| GetRequest / ListRequests | `GET` / `GET` — `filter` `requester`, `assignee`, `state`, `space`, `kind`, `overdue`; `orderBy` | requester, or `requests.get` on the decision resource |
| UpdateRequest | `PATCH` — `assignee`, `title`, `fields` | deciders (assignee); requester (`title`, `fields` while `OPEN`/`NEEDS_INFO`) |
| ApproveRequest / DenyRequest | `POST …:approve` / `:deny` `{message}` — approving access or membership grants the role | deciders |
| SendBackRequest | `POST …:sendBack` `{message}` (→ `NEEDS_INFO`; a requester message returns it to `OPEN`) | deciders |
| AnswerRequest | `POST …:answer` `{answer, publishToCollection?}` (`QUESTION`/`SERVICE`; publishing creates a document Item like CreateItem, needs `items.create` there, and resolves matching knowledge gaps) | deciders |
| WithdrawRequest / CloseRequest | `POST …:withdraw` / `:close` | requester / deciders |
| Messages | `…/requests/{request}/messages/{message}` — `author`, `text`, `internal` (staff-only); Create/List/Get | requester and deciders (internal: deciders) |

Deciders are permission-based: `requests.get`, `.update`, `.approve`,
`.deny`, `.sendBack`, `.answer`, `.close` are checked on the request's
decision resource — the space (`SERVICE`, `QUESTION`, `SPACE_MEMBERSHIP`),
the target collection (`COLLECTION_ACCESS`) or the connector
(`CONNECTOR`) — and are included in `roles/spaceLead`, `roles/spaceStaff`,
`roles/collectionOwner` and `roles/platformAdmin`.

**Operation** `operations/{operation}` — `google.longrunning.Operation`:
Get, List (own), `:cancel`. `metadata` is exactly the method's typed
metadata message from `x-operation-info` (`CreateWorkspaceMetadata`,
`WorkspaceExportMetadata`, `ArtifactOperationMetadata`) plus `@type` (prefix
`type.googleapis.com/bomesh.v1.`); each carries `createTime` and
`progressPercent`, and the resource-creating ones name their resource
(`workspace`, `artifact`). ListOperations filters on `metadata.verb` and
`metadata.target` (the resource the method acts on; `auditEvents` for
ExportPlatformAuditEvents), which are filter-only paths. Methods that
complete within the request (CreateWorkspace, exports) return an already
`done` Operation, but clients must still handle the not-done case. A
cancelled operation ends with `error` CANCELLED; at startup, operations left
unfinished by a previous server process end with `error` UNAVAILABLE and
their owner repairs the resource (an artifact left GENERATING becomes
FAILED, a revision returns it to ACTIVE). **Component** `components/{component}` —
`displayName`, `kind` (`SERVICE`, `AI_MODEL`), `state` (`HEALTHY`,
`DEGRADED`, `DOWN`, `NOT_CONFIGURED`), `setting` (deployment variable name),
`model`, `checkTime`; Get/List (`components.list`, platform). **Incident**
`incidents/{incident}` — `component`, `state` (`ONGOING`, `RESOLVED`),
`errorCategory`, `startTime`, `endTime`; Get/List.

## 9. UX coverage and removed legacy routes

| UX surface | Methods |
| --- | --- |
| Sign in, sign up, forgot password, choose workspace | CreateSession, CreateUser, SendPasswordReset, ResetPassword, ListWorkspaces, UpdateUserPreferences (`lastWorkspace`) |
| Home | GetMemberHome; ask → CreateConversation + Converse; search → SearchItems |
| Browse, ⌘K, `/search` | SearchItems (facets, snippets), ListItems (`parentItem=""` + `showLocked` for knowledge bases), ListReadingLists, ListSpaces, ListMembers |
| Knowledge base / folder view, breadcrumbs, move | ListItems(`parentItem=…`), GetItem(`view=FULL` → `ancestors`), CreateItem (collection), MoveItem, DeleteItem/UndeleteItem |
| Reader | GetItem, GetItemContent, GetPassage, ListItemRevisions, SearchItems(`relatedItem`), CreateSavedItem, UpdateRecentItem(`allowMissing`), Converse (attachments) |
| My library | List saved / recent / saved searches, ListReadingLists, ListContributions(`contributor=me`), ListItems(`parentItem=` the member's `personalCollection`) |
| Contribute, contributions, review | CreateItem (personal collection) → CreateContribution; Approve/RequestChanges/Reject/Withdraw/Resubmit; then, separately, CreateIngestionRun |
| Manage → Documents (all, quality, topics) | ListItems(`filter`), Publish/Unpublish/Verify/Merge/Delete/Undelete, CreateIngestionRun, Topics methods |
| Knowledge bases, access, request access | Item methods on root collections, Get/SetItemIamPolicy, CreateRequest(`COLLECTION_ACCESS`) |
| Inbox | ListNotifications, UpdateNotification, MarkNotificationsRead, DeleteNotification/Undelete, request and contribution methods |
| Chat, conversations, files, share, feedback | Conversation, ConverseConversation, Messages, SubmitMessageFeedback, Shares (refused when the audience cannot read the cited sources), Artifacts and revisions, ExportArtifact, PublishArtifact |
| Sources, sync history, connections | Sources, Syncs (`sources/-/syncs`), Connections, CreateIngestionRun |
| People | Members, Groups/Memberships, Roles, Get/SetIamPolicy, AnalyzeWorkspaceIamPolicy, Requests |
| Assistant, settings, overview, activity, gaps | Assistant, WorkspaceSettings, WorkspaceOverview, AuditEvents (+summarize, export), KnowledgeGaps, ArchiveWorkspace |
| Spaces, Work, Requests | Spaces + children, Artifacts (Work kinds), RequestTypes, Requests (`validateOnly`) |
| Platform console | Workspaces (create/suspend/activate/pauseIngestion/summarizeUsage/exportUsage), Users, Connectors, `workspaces/-/ingestionRuns…`, IngestionPolicy, Components, Incidents, `workspaces/-/auditEvents`, `auditEvents` |

**Removed legacy route → replacement.** The legacy routes lived under the
same `/api/v1` prefix as this contract but are gone from the backend; the web
and mobile clients still call them, so this table stays for their migration.

| Removed legacy route | Replacement |
| --- | --- |
| `/auth/accounts`, `/auth/sessions`, `/auth/session` | `users`, `sessions`, `sessions/current`; no active workspace in the session |
| `/collections` (knowledge base), `PATCH`, its `/access/…`, `/collections/personal` | `items` (`itemType: COLLECTION`) + `:getIamPolicy`/`:setIamPolicy`; personal collection `kind: PERSONAL`, named by `Member.personalCollection` |
| `/collections/{id}/documents`, `/documents…`, `PUT …/content` | `items` (CreateItem with `parentItem`, `/upload`, `:completeUpload`, `?alt=media`) |
| `/documents/search` (`collection_ids`), `/knowledge/home`, `/knowledge/documents/{id}[/citations/{chunk}]` | `items:search` (`filter ancestors:`), `members/me/home`, `items/{i}/content`, `items/{i}/passages/{p}` |
| `/agent/chat` | `conversations/{c}:converse` |
| `/artifacts/{id}`, `…/revisions/{n}/content`, `/publish` | `artifacts`, `artifacts/{a}/revisions`, `:export`, `:publish` |
| `/connections…`, `/sources…`, `/sources/{id}/syncs`, `/schedule` | same resources; `:test`, `:reauthorize`, `:browseResources`, `:pause`/`:resume`; schedule is a field |
| `/ingestion-runs…` | `ingestionRuns`, `tasks` |
| `/workspaces…/overview`, `/activity` | `overview` singleton, `auditEvents:summarize` |
| `/users`, `/accounts?email=` | `members`, `users:lookup` |
| `/roles`, `/groups`, `/permissions` | `roles`, `groups` + `memberships`, `permissions` |
| `/approval-requests` | `requests` (`COLLECTION_ACCESS`, `CONNECTOR`) |
| `/audit-logs`, `/access-sessions` | `auditEvents` (`SIGN_IN` category) |
| `/platform/*` | `workspaces`, `users`, `connectors`, `workspaces/-/…`, `components`, `incidents`, `auditEvents`, `ingestionPolicies` |

Implementation notes (not contract): route custom methods before the plain
`{id}` routes (IDs never contain `:`); keep Temporal, storage keys, vector IDs
and provider IDs out of every name and field.
