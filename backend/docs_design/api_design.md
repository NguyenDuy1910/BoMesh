# BoMesh API — resource-oriented design

Status: canonical API design (base path `/api/v1`). This
document fixes the resource model, method set and rules; `openapi.yaml` is
the machine-readable contract with every field, error reason and
`x-permission`, and wins on those details. The Item domain (collections,
documents, shortcuts, contributions, revisions) is decided in `item_model.md`;
the schema is `design.dbml`.

Implementation status: the backend serves this contract and the web client
(`apps/web`) uses it. UX surfaces the contract does not cover yet are listed
in section 9.

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
| Pagination `pageSize` (default 50, max 1000, coerced) / `pageToken` → `nextPageToken`; optional `totalSize`. Filtering `filter` ([AIP-160](https://google.aip.dev/160) syntax): on a string field a value containing `*` (quoted or not) is a case-insensitive wildcard (`displayName = "*term*"` matches a substring; `!=` negates it and, like every `!=`, also matches an unset field; `%` and `_` are literal); `field:*` tests presence (a scalar is set; a repeated field has a value, where the method lists it, e.g. ListItems `NOT document.topics:*`). Ordering `orderBy` (`"updateTime desc"`). | 132, [158](https://google.aip.dev/158), 160 |
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
| Illegal state transition | `FAILED_PRECONDITION` | resource-specific: `INVALID_WORKSPACE_STATE` (workspace lifecycle), `INGESTION_ALREADY_PAUSED` / `INGESTION_NOT_PAUSED`, `MEMBER_NOT_ACTIVE` / `MEMBER_NOT_SUSPENDED`, `ROLE_DELETED` (update/delete of a deleted custom role), `KNOWLEDGE_GAP_NOT_OPEN` / `KNOWLEDGE_GAP_ALREADY_OPEN` (`:dismiss` / `:reopen`), `CONVERSATION_DELETED` (update, `:converse` or feedback of a deleted conversation) |
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
lists, counts, facets, Home, shared conversations, materials, artifacts and
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
| `workspaceMember` | workspace | Workspace, settings and assistant reads; members, groups, roles; `items.list`/`.search`/`.testIamPermissions` (reading itself comes from collection grants); contributions; topics; own library, conversations and artifacts; shares (`shares.*`: what a share may target is checked on the target); connector catalog; see/join/leave spaces, request types; create, list and withdraw own requests |
| `collectionViewer` | collection | `items.get`/`.list`/`.search`/`.testIamPermissions`, `itemShortcuts.get`/`.list`, `tasks.get`/`.list` |
| `collectionEditor` | collection | viewer + `items.create`/`.update`/`.move`/`.publish`/`.verify`, `itemShortcuts.create`/`.delete`, `ingestionRuns.create` |
| `collectionOwner` | collection | editor + `items.delete`/`.undelete`/`.getIamPolicy`/`.setIamPolicy`, `contributions.review`, request deciding (`COLLECTION_ACCESS`) |
| `spaceMember` | space | Read the space, its members, announcements, events, materials, request types; leave |
| `spaceStaff` | space | member + post announcements, events, materials; decide and answer the space's requests |
| `spaceLead` | space | staff + update/delete the space, its IAM policy, members and request types |
| `platformOperator` | platform | Accounts and workspaces (read), usage, pause/resume ingestion, ingestion runs/tasks (metadata), retry runs, audit metadata, connectors and ingestion policy (read), components, incidents |
| `platformAdmin` | platform | operator + account and workspace lifecycle (create, suspend, activate, archive), connector and ingestion-policy changes, deciding `CONNECTOR` requests; never workspace content |

Custom roles live at `workspaces/{workspace}/roles/{role}`.

**Performance observability.** Every response carries
`Server-Timing: app;dur=<ms>, db;dur=<ms>` (time to response start and the
request's cumulative PostgreSQL statement time; never counts, names or
statement text, so it reveals nothing beyond the response time). Browser
origins listed in `BOMESH_WEB_ORIGINS` receive `Timing-Allow-Origin` (echoed
origin, `Vary: Origin`), so Resource Timing phases and `serverTiming` of API
calls are readable from the web client; the same list is the CORS allowlist.
Unset means any origin (local development): identity is only the bearer
token, so no ambient credential is exposed.

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
    workspaces/{workspace}/shares/{share}        (share and invite URLs; shares:resolve, shares:accept)
  roles/{role}                                   (predefined, read-only)
  permissions/{permission}                       (catalog, read-only)

Knowledge
  workspaces/{workspace}/items/{item}            (COLLECTION or DOCUMENT)
    ◇ …/items/{item}/preview                     (documents; singleton: how to show the file)
    …/items/{item}/passages/{passage}
    …/items/{item}/revisions/{revision}
    …/items/{item}/shortcuts/{shortcut}          (collections: shortcuts to documents; shortcut ID = document ID)
  workspaces/{workspace}/contributions/{contribution}
  workspaces/{workspace}/topics/{topic}
  workspaces/{workspace}/topicCorrections/{topicCorrection}

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
  `items` mirrors the canonical `items` table: `itemKind` selects the
  `collection` or `document` facet and the output `itemType` classifies the
  Item within its kind (collection type or document file class). Names are flat under the workspace and
  `parentItem` is a field, like Drive files: moves and contribution approval
  never rename an Item, its citations or its references. A root collection is
  what the UX calls a knowledge base. Access is inherited from collections.
- **One concept, one resource.** Contribution review is `contributions`;
  every other ask-and-decide flow (collection access, joining a space,
  connector demand, office service requests, questions to a space) is
  `requests` with a `kind`. A Space shows Items only through its
  `materials`; "Featured on Home" is computed (popular readable documents);
  "Work" outputs are `artifacts` with a `kind`; sign-ins are `auditEvents` of
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
`branding {accentColor, mapBackground}`,
`spaceTypes [{key, displayName, icon, enabled}]`, `workflows [{key, enabled}]`
(`EVIDENCE_REVIEW`, `DRAFT`, `STUDY_GUIDE`, `QUIZ`), `defaultPublishingPolicy` (`AUTO_PUBLISH`, `REVIEW_FIRST`;
default for new sources), `reverificationDuration`, `etag`. Get (members) /
Update (`workspaces.updateSettings`).
Turning a module off keeps its data.

`branding.mapBackground` is the image behind the knowledge map on Home, the
same for every member: output-only `imageUri` (signed, short-lived),
`fileName`, `widthPixels`, `heightPixels`, `updateTime`, `updater` (member
name), and `strength` (0–100, default 25). The image is an object in document
storage referenced from `tenants.settings`; it is set with
**UploadMapBackground** `POST …/settings:uploadMapBackground` (multipart, one
`file`: JPEG, PNG or WebP ≤ 10 MB, else `INVALID_ARGUMENT`; clients rasterize
SVG and scale to ≤ 1920 px wide first; `workspaces.updateSettings`) → the
WorkspaceSettings. The replaced image is deleted after the change commits.
Update with `updateMask=branding.mapBackground` and no value removes it (and
deletes the image); `branding.mapBackground.strength` changes only the
strength. Both write an audit entry.

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

**Share** `…/shares/{share}` — the one way to hand someone a URL to something
(`database_architecture.md` "Resource shares"). `kind` (`SHARE`, `INVITE`),
`target` (resource name: `workspaces/{workspace}` for a workspace invite,
`…/items/{item}`, `…/spaces/{space}`, `…/conversations/{conversation}`),
`role` (INVITE: granted at the target), `audience` (SHARE: `WORKSPACE` active
members or `PEOPLE` = `recipients[]` (members); INVITE: `ANYONE` signed in),
`expireTime`, `maxUses` (INVITE), output `useCount`, `state` (`ACTIVE`,
`EXPIRED`, `EXHAUSTED`, `REVOKED`), `uri` (web path `/s/{share}` for a share,
always; `/s/{token}` for an invite, only in the CreateShare response: the
token is stored hashed, so a `requestId` replay returns the invite without
it), `creator`, `createTime`, `lastUseTime`.

A SHARE of an item or a space grants nothing: whoever opens it must be signed
in, in its audience and already able to read the target; otherwise the
landing page offers Request access. A SHARE of a conversation is what lets its
audience read the live conversation (read-only, re-filtered per reader, §7).
An INVITE grants its `role` at the target on accept, creating the workspace
membership first for a workspace invite.

| Method | HTTP | Permission / rule |
| --- | --- | --- |
| CreateShare | `POST …/shares` (`requestId`) | `shares.create`; SHARE: the caller can read the target (a conversation: its owner); INVITE: the target scope's `workspaces.setIamPolicy` / `spaces.setIamPolicy` / `items.setIamPolicy` (a live COLLECTION, never PERSONAL: `PERSONAL_COLLECTION`) and a role the caller could grant there (`ROLE_ESCALATION`); recipients must be active members (`NOT_WORKSPACE_MEMBER`) |
| GetShare / ListShares | `GET` / `GET` (filter `target`, `kind`, `state`) | `shares.get` / `shares.list`; the caller's own shares and every share of a target whose `setIamPolicy` the caller holds; others are absent |
| DeleteShare | `DELETE` → the Share, `REVOKED` (never undone; "reset link" = delete + create) | `shares.delete`; creator or holder of the target's `setIamPolicy` |
| ResolveShare | `POST /shares:resolve` `{token}` → `ShareResolution {share, kind, target, targetDisplayName, workspaceDisplayName, role, canOpen, canAccept, reason}` | self (signed in); unknown token → NOT_FOUND; names are returned only to someone who can open the target, except an invite's target and workspace names |
| AcceptShare | `POST /shares:accept` `{token}` (INVITE) → the resolution, target now openable | self; FAILED_PRECONDITION `REVOKED` / `EXPIRED` / `EXHAUSTED`, `MEMBER_SUSPENDED` (a suspended member), `NOT_WORKSPACE_MEMBER` (space or collection invite), `SHARE_CREATOR_NOT_ALLOWED` (the creator no longer holds the scope's `setIamPolicy` or could no longer grant the role); accepting again grants and uses nothing |

`reason` says why `canOpen` or `canAccept` is false: `REVOKED`, `EXPIRED`,
`EXHAUSTED`, `NOT_IN_AUDIENCE`, `NO_ACCESS` (Request access), `ALREADY_MEMBER`,
`NOT_WORKSPACE_MEMBER`, `MEMBER_SUSPENDED`, `SHARE_CREATOR_NOT_ALLOWED`.
Create, revoke and every accept are audited (category `PEOPLE`).

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
`createTime`. List/Get; List filters on `category`, `actor`, `outcome`, `action`
(e.g. Topics' "Last imported" line reads the last `action = "ImportTopics"`) and
`createTime`; `workspaces/-/auditEvents` lists across workspaces
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

**Item** `…/items/{item}` — `itemKind` (`COLLECTION`, `DOCUMENT`; required on
create, immutable), `itemType` (output, immutable: `STANDARD` or `PERSONAL` for
a collection; for a document its file class `PDF`, `WORD`, `PRESENTATION`,
`SPREADSHEET`, `MARKDOWN`, `HTML`, `PLAIN_TEXT`, `DATA`, `IMAGE`, `AUDIO`,
`VIDEO`, `ARCHIVE` or `OTHER`, derived from the validated MIME type and file
name; `item_model.md` §4.11), `displayName`, `parentItem` (empty for a root collection; set on
create, changed only by `:move`), `ancestors[]` (output, view `FULL`: breadcrumbs the
caller can read), `access` (output: `READER`, `EDITOR`, `OWNER`, `LOCKED`),
`state` (`ACTIVE`, `DELETED`), `creator`, times, `purgeTime`, `etag`, and
exactly one facet:

- `collection` — `owner` (output; `PERSONAL` = each member's "My files"
  only), `ownerSummary`, `description`, `inheritAccess` (nested
  only; roots are always boundaries), `discoverable` (roots), `acceptsContributions`,
  `childCount`, `documentCount` (output, readable published, subtree), `shortcutCount` (output, visible shortcuts).
- `document` — `fileName`, `mimeType`, `sizeBytes`, `purpose` (`KNOWLEDGE`,
  `CONVERSATION_ATTACHMENT`), `topics[]`, `assistantTopics[]`
  (output: the subset of `topics` the assistant applied), `summary`,
  `languageCode`, `owner` (member), and output `contentState` (`PENDING`,
  `AVAILABLE`, `FAILED`; derived: `AVAILABLE` once a current revision exists,
  `FAILED` when the upload failed, else `PENDING`), `publicationState` (`PUBLISHED`, `UNPUBLISHED`),
  `collectionKind` (`STANDARD` = the workspace's shared knowledge, `PERSONAL`
  = a member's My files, their private scope),
  `indexingState` (`PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, `OUTDATED`,
  `UNSUPPORTED`), `indexingError`, `lastIngestionRun`, `revision`,
  `verification`, `origin`, `qualityIssues[]` (editors), `cover`,
  `uploadUri` (`PENDING`, creator).

`cover` (`DocumentCover`) rides on every Item and Home entry, so a list
renders what a document's first page looks like without a content read: N
documents cost one list call and at most one signed URL each, not N+1 reads.
It is `kind` (`PAGE`, `SLIDE`, `SHEET`, `TEXT`, `IMAGE`) plus either a small
first-page `imageUri` (with its pixel size) or the first page's `title`,
`lines[]` or `cells[][]`. The ingestion worker produces it when the content
arrives; absent means not produced yet or nothing to show, and the client
draws the format's typed tile (`document_viewer.md` "Cover on the Item").

There is deliberately **no page count on the Item**. It is not an insight
anyone acts on, it exists only as a by-product of rasterizing a PDF, and
computing it for other formats would cost a read per document. A viewer that
has the content open numbers its own pages; nothing else needs the total.

Deletion, content, publication and indexing are four independent fields;
review state lives on the Contribution. A document is visible when it and its
ancestors are `ACTIVE`, the caller holds `items.get` on its governing
collection, and it is `PUBLISHED` (or the caller holds `items.update` there).

| Method | HTTP | Permission / rule |
| --- | --- | --- |
| CreateItem | `POST …/items` (`requestId`) → documents return `PENDING` + signed `uploadUri` and the `itemType` of the declared MIME type and file name; collections are `STANDARD`; `POST /upload/api/v1/workspaces/{workspace}/items` multipart for one-call upload | `items.create` on `parentItem` (on the workspace for a root collection). Documents only under collections; new documents are `PUBLISHED`; non-editors contribute instead |
| CompleteItemUpload | `POST …/items/{item}:completeUpload` (validates the stored object; content of another file class than `itemType` fails the upload: `contentState FAILED`, error code `ITEM_TYPE_MISMATCH`) | creator |
| GetItem | `GET …/items/{item}` (`view`), `?alt=media` → 302 to the signed original | `items.get` |
| ListItems | `GET …/items` — `filter` over `name` (batch read: `name = "…/items/a" OR name = "…/items/b"`; names the caller cannot read, or that do not exist, are simply absent, as GetItem would deny them), `parentItem` (`""` = roots), `ancestors:` (subtree), `itemKind`, `itemType`, `displayName`, `document.*` (MIME type, topics, assistant topics, owner, purpose, states, collection kind, origin, verification, quality issues); presence `field:*` on repeated fields (`NOT document.topics:*` = without a topic); `orderBy`; `showDeleted`; `showLocked` | `items.list` (visible items only) |
| SearchItems | `POST …/items:search` `{query, filter, facetSpecs[], orderBy, relatedItem, contentSearchSpec, pageSize, pageToken}` → documents with snippets/passages, permission-filtered facets (value facets, and `intervals` buckets for `updateTime`) | `items.search`. The one catalog and retrieval search; hits are re-authorized in PostgreSQL |
| UpdateItem | `PATCH` — `displayName`, collection settings, document metadata; `collection.inheritAccess` also needs `items.setIamPolicy` | `items.update` |
| DeleteItem / UndeleteItem | `DELETE` (`force` for a non-empty collection; the live subtree is deleted together) / `POST …:undelete` (restores that cohort and its search visibility; 30-day retention). DELETED items are shown only to `items.undelete` holders and never serve content | `items.delete` / `.undelete` on every access boundary in the cohort (`SUBTREE_HAS_FOREIGN_BOUNDARY`); personal collections cannot be deleted |
| MoveItem | `POST …:move` `{destinationParent, etag}` | `items.move` + `items.create` on the destination; crossing an access boundary also needs `items.setIamPolicy` on the source boundary; not for source-managed items, candidates of open contributions (`CONTRIBUTION_OPEN`), conversation attachments, personal collections, or into another member's personal collection |
| ImportCollections | `POST …/items/{item}:importCollections` `{rows[] {path[], description?}, validateOnly}` — creates the missing folders of a folder tree under this COLLECTION in one transaction (MERGE only: nothing existing is renamed, moved, re-described or deleted); each row names a folder by display names from `{item}` down (≤ 1000 rows, ≤ 8 segments of 1–512 characters), a segment matches a readable live child collection case- and whitespace-insensitive (an unreadable folder is absent), missing segments are created parents first like CreateItem folders (`inheritAccess` true) → `{created[] {item, path[], row}, unchangedCount, skippedRows[{row, reason}]}`; a row that cannot apply (bad name, too deep, listed twice, ambiguous name, under a skipped folder, no `items.create` there) is skipped with a fixed English reason and never applied half-way. The client parses the JSON file; no `requestId` (re-running is a no-op by matching) | `items.create` on `{item}`, plus `items.create` on an existing descendant with its own access a new folder goes under (else that row is skipped) |
| PublishItem / UnpublishItem | `POST …:publish` / `:unpublish` (documents; never starts processing) | `items.publish` |
| VerifyItem | `POST …:verify` | `items.verify` |
| MergeItem | `POST …:merge` `{targetItem}` — in one transaction every reference to this duplicate (shortcuts, saved and recent items, space materials, message attachments) is re-pointed to the target (deduplicated), the duplicate is deleted and the merge is audited; UndeleteItem restores only the duplicate | `items.delete` here + `items.update` on target |
| GetItemPreview | ◇ `GET …/items/{item}/preview` (`revision` optional) — how to show the document's own file, independent of processing, from the preview engine: `state` (READY, PREPARING, UNAVAILABLE), one `representation` of six kinds (PDF, IMAGE, TABLE, TEXT, MEDIA, ARCHIVE) the engine makes once per revision (worker, on content arrival or first read), and the `original` for download | `items.get` |
| GetPassage / ListPassages | `GET …/passages/{passage}` (citation target; always of `document.indexedRevision`) / `GET …/passages` | `items.get` |
| GetItemRevision / ListItemRevisions | `GET …/revisions[/{revision}]` — newest first; created by upload, approved new revisions, source versions and rollback | `items.get` |
| RollbackItem | `POST …/revisions/{revision}:rollback` (reuses the stored object; not for source-managed documents) | `items.publish` |
| Get/Set/TestItemIamPermissions | `POST …:getIamPolicy` etc. | `items.getIamPolicy` / `.setIamPolicy` on collections only; `workspaceMembers` may only hold `roles/collectionViewer`; personal collections cannot be shared |
| CreateItemShortcut / GetItemShortcut / ListItemShortcuts / DeleteItemShortcut | `POST …/items/{collection}/shortcuts` `{targetItem}` / `GET` / `GET` / `DELETE` (soft) | `itemShortcuts.create` / `.get` / `.list` / `.delete` on the container; target must be a readable DOCUMENT that does not already live there (`LINK_TARGET_NOT_DOCUMENT`, `LINK_TO_OWN_PARENT`, `LINK_TARGET_NOT_ALLOWED`); shortcuts whose target the caller cannot read are absent |

An item shortcut shows one canonical document inside another collection
(`item_model.md` §4.2): no copy, no grant, and no effect on `parentItem`,
`ancestors`, subtree filters, conversation scope, ingestion or counts other
than `shortcutCount`. Deleting the container removes its shortcuts in the same
cohort; a deleted target hides its shortcuts until undelete. (A URL handed to
people is a Share, §4.)

SearchItems facets follow Vertex AI Search `FacetSpec`: one response
carries every facet of a catalog view. Each facet counts the matching
documents the caller can see (the same visibility predicate as the results)
and, with `excludedFromFilter` (default), ignores its own filter clause
(disjunctive). `updateTime` is an interval facet: `intervals[]` of
`{minimum, maximum}` RFC 3339 bounds (inclusive, either open) return one
value each, in request order, with `interval` instead of `value`.

Topics are a two-level taxonomy (DOMAIN → TOPIC), and `document.topics`
is hierarchical in both the filter and the facet, like `ancestors:` for
collections: `document.topics:"…/topics/{domain}"` matches documents tagged
with the domain or with any topic under it, and the domain's facet value
counts those documents once. A TOPIC has no children, so it matches only
its own tags. Every consumer of the filter (Browse, saved searches, ListItems,
Manage) wants the domain's documents; agent retrieval does not filter by
topic.

Asking for access is `CreateRequest` with `kind: COLLECTION_ACCESS`.
Reviewers of an open contribution may `GetItem`, `GetItemPreview` and
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
| ApproveContribution | `POST …:approve` `{targetCollection, topics[], summary, recordCorrection}` — moves the candidate into the collection and publishes it (source candidates are published in place; `NEW_REVISION` appends a revision to `replacesItem`); `recordCorrection` records a TopicCorrection when `topics` differ from the suggested ones. A NEW_DOCUMENT candidate must be processed first (`indexingState` SUCCEEDED, OUTDATED or UNSUPPORTED, else `CANDIDATE_NOT_PROCESSED`): processing comes before review. A NEW_REVISION candidate of another file class than `replacesItem` → `ITEM_TYPE_MISMATCH` (also at create). **Never starts an ingestion run** | `contributions.review` and `items.publish` on the target collection |
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
(readable published, output), `inReviewCount` (reviewers only), and the
classification signals of a TOPIC: `keywords[]`, `synonyms[]`, `guidance`
(for the assistant), `examples[]` (≤ 5 readable documents; reads show the
visible ones) and `rules[]` (`{collection}` subtree or `{source}`). CLASSIFYING
(`document_contract.md` "Processing") checks the rules first: a document a
rule matches gets exactly the matching rules' topics and the model is not
called; otherwise the model reads every candidate with its signals and
example titles. There is no confidence threshold.

| Method | HTTP | Permission |
| --- | --- | --- |
| CreateTopic | `POST` (admins create `ACTIVE` topics; the assistant creates `PROPOSED` ones) | `topics.create` |
| GetTopic / ListTopics | `GET` — `filter` `state`, `kind`, `parentTopic` | `topics.get` / `topics.list`; `PROPOSED` and `REJECTED` topics only for `topics.accept` holders |
| UpdateTopic | `PATCH` | `topics.update` |
| DeleteTopic / UndeleteTopic | `DELETE` (only when unused) / `:undelete` | `topics.delete` |
| AcceptTopic | `POST …:accept` `{parentTopic, displayName?}` — tags the contributions that proposed it | `topics.accept` |
| RejectTopic | `POST …:reject` | `topics.accept` |
| MergeTopic | `POST …:merge` `{targetTopic}` — retags documents and contributions | `topics.update` |
| ConfirmTopicAssignments | `POST …/topics/{topic}:confirmAssignments` `{filter}` — the topic's assistant-applied assignments on the documents the ListItems `filter` matches become the caller's (one statement); returns `confirmedCount`. The filter silently narrows to visible documents whose governing collection grants the caller `items.update` | `items.update` (per governing collection) |
| ImportTopics | `POST …/topics:import` `{rows[] {domain, topic?, name?, description, keywords[], synonyms[], guidance}, mode (MERGE, REPLACE), validateOnly}` — rows name domains and topics by display name (a row without `topic` describes its domain; a missing domain is created; a topic matches by name within its domain, else is created with a server ID; `name` (resource name) from an export matches the topic itself so renames and moves apply) → `{created[], updated[], archived[], unchangedCount, skippedRows[{row, reason}]}` in one transaction, each change `{topic, kind, displayName, domain, row, changes[], previousDisplayName}` so clients show names, not IDs; absent row fields stay unchanged; REPLACE archives unused ACTIVE topics no row matched. Topic IDs are internal: clients show names, never IDs. The client parses CSV/XLSX and exports from ListTopics | `topics.update`, plus `topics.create` to create and `topics.delete` to archive |
| TestTopicClassification | `POST …/topics:testClassification` `{title, text, collection?, source?, topics[]?}` (`topics` = unsaved changes to existing topics) → `{results[] {topic, reason (RULE, ASSISTANT)}, summary}`: rule hits, else the model's picks, exactly as CLASSIFYING; nothing is stored | `topics.update` |
| CompileTopicClassificationPrompt | `GET …/topics:compileClassificationPrompt` → `{prompt, rules[], estimatedTokens}`: the `document_profile` prompt with every ACTIVE topic and placeholders — the prefix every document of a run shares (instructions, note, the taxonomy by domain with `T1..Tn` labels; prompt-cached), then one document's part (keyword matches, title, excerpt) (`document_contract.md` "Processing"); no model call | `topics.update` |

**TopicCorrection** `…/topicCorrections/{topicCorrection}` (output only) —
`item` and `itemDisplayName` (only when the caller can see the document),
`fromTopics[]` (the assistant's topics the person removed), `toTopics[]` (the
topics the person chose that the assistant had not), `actor`, `state`
(`OPEN`, `DISMISSED`: whether it was dismissed), `createTime`. Created by ApproveContribution with
`recordCorrection` when the approved topics differ from the suggested ones,
and by UpdateItem `document.topics` when it replaces assistant-applied topics.
Aggregating shared title phrases into keyword suggestions stays in the client.

| Method | HTTP | Permission |
| --- | --- | --- |
| GetTopicCorrection / ListTopicCorrections | `GET` — newest first; `filter` `state`, `toTopics:` | `topics.update` |
| DismissTopicCorrection | `POST …:dismiss` (`OPEN` → `DISMISSED`; idempotent) | `topics.update` |

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
  featured (popular readable documents), recently published,
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
A provider version of another file class than the document's `itemType` is not
appended (the current revision stays) and is reported in `failures[]`.

**IngestionRun** `…/ingestionRuns/{ingestionRun}` — the only way documents
are processed. `selector {items[] ≤ 1000, filter}`: explicit documents
and/or the AIP-160 document filter of ListItems (`ancestors:`,
`document.indexingState`, `itemType`, `document.topics:`,
`document.origin.source`, …); both set narrow each other, and the selection
is resolved once into tasks at creation. "Select all matching" in Documents
sends the filter the list shows, so there is one filter grammar.
`classification {topics[] ≤ 50, note ≤ 1000}` (optional, immutable): the
topics the run's CLASSIFYING step of contextual retrieval may assign (empty =
every ACTIVE topic; a DOMAIN = its ACTIVE topics, or itself when it has none) and a note it
reads with each document; the contextualization model picks the topics that
apply, without a confidence threshold. Assigned topics are assistant-applied
and never replace a person's (`document_contract.md` "Processing").
`readImages` (optional, immutable, default false): the configured vision
model reads the text inside every picture of the documents, placed with the
picture (`document_contract.md` "Formats"); slower and billed per distinct
picture, so it is chosen per run in the Process dialog. Without a configured
vision model it is `FAILED_PRECONDITION` reason `VISION_MODEL_UNAVAILABLE`.
`trigger`, `state`
(`QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLED`), `counts`, `error`,
`retryOf`, times. Create (`requestId`; "Process", re-process; a selector
matching nothing yields an empty run, immediately `SUCCEEDED` with zero
tasks), Get, List, `:cancel` (Stop: finished documents stay processed, the
rest return to `PENDING`), `:retry` (returns the new run over the failed and
cancelled tasks, with the same classification and `readImages`). A run never publishes;
"approve and process" is ApproveContribution, then CreateIngestionRun with
the target in `items[]`.
Permission is checked on each explicit document's governing collection; the
filter silently narrows to the collections where the caller holds
`ingestionRuns.create`, and an item it names that the caller cannot read is
`PERMISSION_DENIED`. Collections, attachments, artifacts, unsupported and
content-pending documents and documents held by another active run are never
selected; personal collections only when `items[]` or an item the filter
names selects them; unpublished documents may be processed and stay hidden
from retrieval. Tasks `…/ingestionRuns/{ingestionRun}/tasks/{task}` (task ID =
item ID): `item`, `state`, `phase` (`QUEUED`, `FETCHING`, `PARSING`, `OCR`,
`CLASSIFYING`, `CHUNKING`, `EMBEDDING`, `INDEXING`), `phases[]`, `error`,
`errorClass`, times; Get/List. Platform callers read
`workspaces/-/ingestionRuns/-/tasks` and
`workspaces/-/ingestionRuns:summarize` (per-workspace queue, throughput,
failure rate, error classes); their responses never include `item`,
`selector`, `classification`, file names or content. Retrying failed jobs
from the platform console is `CreateIngestionRun` with `selector.filter:
"document.indexingState = FAILED"` and `trigger: PLATFORM_RETRY`
(`ingestionRuns.create` granted by `platformOperator`).

**IngestionPolicy** `ingestionPolicies/default` — `allowedMimeTypes[]`,
`maxFileSizeBytes`, `ocrScannedPdfs`, `parseSpreadsheets`,
`contributionReviewRequired` (output, always true: member contributions are
always reviewed), `rejectedRetentionDuration`, `etag`. Get/List/Update
(`ingestionPolicies.update`, platform).

## 7. Assistant

**Conversation** `…/conversations/{conversation}` — owner-private unless
shared: a live Share targeting it (`kind: SHARE`, audience `WORKSPACE` or
`PEOPLE`) lets its audience read the live conversation read-only.
`displayName`, `owner`, `pinned`, `scope {collections[] (collection
subtrees), spaces[]}`, `lastMessageTime`, `lastAnswerSnippet` (output:
the first 300 characters of the latest COMPLETED answer, so lists show a
preview without a ListMessages call per row; never shown to a shared
reader), `outdatedSources[] {item, displayName, updateTime}` (output: the
readable documents its current answers cite that changed since — see
Living answers), `createTime`, `updateTime`, `deleteTime`. Create (client may
choose the ID with `conversationId`), Get (owner or shared reader; a
deleted conversation is NOT_FOUND to readers), List (own), Update
(`displayName`, `pinned`, `scope`), Delete/`:undelete` (owner).

| Method | HTTP | Rule |
| --- | --- | --- |
| ConverseConversation | `POST …/conversations/{conversation}:converse` `{message, attachments[] (readable document items; uploads are CreateItem with `purpose: CONVERSATION_ATTACHMENT` in the caller's personal collection), replaceFromMessage}` → `text/event-stream` (OpenResponses events) | owner; the server owns history |
| ListMessages / GetMessage | `GET …/messages[/{message}]` — `role`, `text`, `citations[]`, `artifacts[]`, `state` (`COMPLETED`, `INTERRUPTED`, `FAILED`), `feedback`, `available` (output; `false` only for a shared reader: the turn cites a source they cannot read now, so only `name`, `role`, `state`, `createTime` are set) | owner, or a shared reader (read-only; never `feedback`) |
| SubmitMessageFeedback | `POST …/messages/{message}:submitFeedback` `{rating: HELPFUL\|UNHELPFUL\|RATING_UNSPECIFIED (clears), reason, comment}` | owner; feeds knowledge gaps |

**Living answers.** A citation carries `outdated` and `updateTime`
(output, computed on every read, never stored): `outdated` is true when the
cited document's current revision was created after the citing message, so
the answer was written from an earlier version. A conversation lists those
documents in `outdatedSources` (its current answers only; superseded and
unreadable ones never count). Updating an answer is ConverseConversation
with `replaceFromMessage` = the answer's question: the new answer cites the
current revisions, so the flag clears. No column records the cited
revision — a revision time newer than the message is the whole rule.

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
(output), `collections[]` (output: the collections among its materials), `state` (`ACTIVE`, `DELETED`). CRUD
with soft delete; `:join` (open spaces), `:leave`; IAM
(`:getIamPolicy`/`:setIamPolicy`, roles `spaceLead`/`spaceStaff`/`spaceMember`).
Members `…/spaces/{space}/members/{member}` (`member` = workspace member name, required on create; `roles[]` output from IAM,
`joinTime`): Create/List/Get/Delete. Materials `…/materials/{material}`
(`item`: a DOCUMENT or STANDARD COLLECTION; `note`, `addedBy`; never changes access; unreadable materials
omitted; the only link between a space and an Item): Create/List/Get/Delete. Announcements (`title`, `body`, `pinned`,
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

## 9. UX coverage

| UX surface | Methods |
| --- | --- |
| Sign in, sign up, forgot password, choose workspace | CreateSession, CreateUser, SendPasswordReset, ResetPassword, ListWorkspaces, UpdateUserPreferences (`lastWorkspace`) |
| Open a link `/s/:token` (signed out: sign in or sign up, then back) | ResolveShare, AcceptShare (INVITE), then the target's Get; Request access when `reason = NO_ACCESS` |
| Home | GetMemberHome (greeting; `starterPrompts`; Getting started from `joinTime`, `counts.conversationCount`, `continue.recentItems`, `counts.savedItemCount` — hiding it is a per-browser preference, not stored; `recommended` with reasons, cards via BatchGetItems; `topicDomains`); ask → CreateConversation + Converse; search → SearchItems |
| Knowledge map `/knowledge/map` | ListItems (`itemKind = COLLECTION`, `showLocked`), SearchItems, WorkspaceSettings `branding.mapBackground` |
| New chat, sidebar Recent | ListConversations (`orderBy=lastMessageTime desc`; `outdatedSources` marks conversations to review), GetMemberHome (`starterPrompts`), ListRecentItems (ask about what you just read) |
| Living answers | ListMessages (`citations[].outdated`, `updateTime`); Update answer → Converse with `replaceFromMessage` = the answer's question |
| Browse | SearchItems (facets, snippets) over the workspace's public knowledge only: `document.collectionKind = STANDARD AND document.publicationState = PUBLISHED AND (document.indexingState = SUCCEEDED OR document.indexingState = OUTDATED)` — members' My files, unpublished documents and documents not yet processed never appear (a contribution shows up once approved and processed); ListItems (`parentItem=""` + `showLocked` for knowledge bases), ListSpaces, ListMembers |
| ⌘K, `/search` | SearchItems (facets, snippets) over everything the caller can read, My files included |
| Knowledge base / folder view, breadcrumbs, move | ListItems(`parentItem=…`), GetItem(`view=FULL` → `ancestors`), CreateItem (collection), MoveItem, DeleteItem/UndeleteItem |
| Reader, document preview | GetItem, GetItemPreview (the file through one of six representations, processed or not), GetPassage (citations by `boundingBoxes` on PDF pages, else by the passage text), ListItemRevisions, SearchItems(`relatedItem`), CreateSavedItem, UpdateRecentItem(`allowMissing`), Converse (attachments) |
| My library | List saved / recent / saved searches, ListContributions(`contributor=me`), ListItems(`parentItem=` the member's `personalCollection`) |
| Contribute, contributions, review | CreateItem (personal collection) → CreateContribution; Documents → Processing: CreateIngestionRun (`items[]` = the candidates; refreshes their suggestions); Documents → Review: Approve/RequestChanges/Reject (Withdraw/Resubmit by the contributor); a NEW_REVISION is processed after approval |
| Manage → Documents (all, quality, topics) | ListItems(`filter`), Publish/Unpublish/Verify/Merge/Delete/Undelete, CreateIngestionRun, Topics methods |
| Knowledge bases, access, request access, copy link | Item methods on root collections, Get/SetItemIamPolicy, CreateRequest(`COLLECTION_ACCESS`), CreateShare (SHARE of a document, collection or space; INVITE to a collection) |
| Inbox | ListNotifications, UpdateNotification, MarkNotificationsRead, DeleteNotification/Undelete, request and contribution methods |
| Chat, conversations, files, share, feedback | Conversation, ConverseConversation, Messages, SubmitMessageFeedback, conversations shared live through a Share (re-filtered for each reader on every read: a turn citing a source the reader cannot read is withheld, unreadable citations are marked unavailable), Artifacts and revisions, ExportArtifact, PublishArtifact |
| Sources, sync history, connections | Sources, Syncs (`sources/-/syncs`), Connections, CreateIngestionRun |
| People | Members, Groups/Memberships, Roles, Get/SetIamPolicy, AnalyzeWorkspaceIamPolicy, Requests, Shares (INVITE: role, expiry, max uses, copy, revoke, reset) |
| Assistant, settings, overview, activity, gaps | Assistant, WorkspaceSettings, WorkspaceOverview, AuditEvents (+summarize, export), KnowledgeGaps, ArchiveWorkspace |
| Spaces, Work, Requests | Spaces + children, Artifacts (Work kinds), RequestTypes, Requests (`validateOnly`) |
| Platform console | Workspaces (create/suspend/activate/pauseIngestion/summarizeUsage/exportUsage), Users, Connectors, `workspaces/-/ingestionRuns…`, IngestionPolicy, Components, Incidents, `workspaces/-/auditEvents`, `auditEvents` |

Implementation status — UX surfaces without contract support yet (open
design decisions; the web client shows them as unavailable or leaves the
detail out, and never fakes them in production):

- **Projects** (sidebar folders, `/project/{id}`): no resource. The web
  client defines the expected shape in `apps/web/src/modules/projects/types.ts`
  (per-user folders of conversations with ≤ 10 knowledge references) behind
  an adapter that is unavailable in production.
- **Conversation messages:** no stored `workLog` (see `conversation_loop.md`
  "Web conversation client"), follow-up suggestions or question attachments,
  so a reloaded answer loses its work line, chips and attachment chips.
  Superseded answers (retry, Update answer) are not listed, so "Previous
  answer" is reachable only in the session that replaced it.
- **Reader:** PERMISSION_DENIED on GetItem does not name the governing
  collection, so Request access cannot be offered; no method lists the
  conversations that cite an item.
- **Review and topics:** ApproveContribution cannot publish a submission as a
  new revision of an existing item; nothing creates `PROPOSED` topics.
- **Workspace admin:** AuditEvent carries no sign-in method or device;
  WorkspaceAssistant has no citations setting; a denied request cannot be
  reopened (no Undo).
- **Work and Requests:** Artifact does not store the draft type; UpdateArtifact
  cannot add `sourceItems`; no artifact copy; evidence-review synthesis is
  free text; quiz questions carry no difficulty or citation. Request messages
  carry no attachments, transitions or assignment history, approved requests
  refuse messages, request types have no icon and spaces no short code or
  opening hours.
- **Platform console:** operators cannot read the owner/admins of workspaces
  they do not belong to or a user's memberships; WorkspaceUsage has no daily
  series or 90-day window; IngestionRunSelector has no error-class filter;
  Component has no latency or uptime.

Implementation notes (not contract): route custom methods before the plain
`{id}` routes (IDs never contain `:`); keep Temporal, storage keys, vector IDs
and provider IDs out of every name and field.
