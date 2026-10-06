
## Role and goal

You are refactoring the BoMesh web app (`web/`, Next.js 16 · React 19 ·
Tailwind 4 · lucide-react) so that its information architecture, design system,
pages and flows match the approved UX prototype:

```
docs/ux-review.html
```

The prototype is the **design specification**, not code to copy. It is one
plain-JS file with mock data. Rebuild its behaviour with the app's real React
modules, real API clients and real permissions.

Done means: every user journey and every action in the prototype can be walked
in the real app. Where the backend supports a feature, the UI calls the real
API. Where it does not yet, the **complete UI is still built** and runs on a
typed *pending-API adapter* (see “UI first, API pending” below) that the user
will later replace with a real endpoint. `backend/docs_design` records both
the implemented contract and the proposed contracts the UI already depends on.

## Non-negotiable rules (from `AGENTS.md`)

1. **Read before editing.** Before each phase, read the relevant files in
   `backend/docs_design/` (`api_contract.md`, `openapi.yaml`, `auth_contract.md`,
   `conversation_loop.md`, `document_contract.md`, `document_viewer.md`) and
   trace the current implementation and its callers.
2. **UI first, API pending (user decision).** Never drop, hide or simplify a
   prototype feature because its endpoint is missing. Build the full UI/UX now
   behind a pending-API adapter, following the contract below. Backend work for
   pending features happens **only when the user asks for it**. Do not stop to
   ask before building the UI. Data must never be faked against *real* records:
   pending adapters own their own local state and may only read real data
   (for example, to list real collections in a picker).
3. **Authorization stays server-side.** UI hides what a caller cannot do, but
   never replaces API permission checks. Use the existing session permission
   helpers (`web/src/lib/auth/session.ts`, `visibleRailItems`,
   `canAccessControlPlaneRoute`). Never hard-code role names.
4. **One canonical implementation per concept.** Delete what the new flow
   replaces: old rails, duplicate document lists, `NotBackedYet` pages, legacy
   aliases once redirects exist. Do not leave two versions of the same screen.
5. **Models.** Any LLM call in tests or scripts uses only the models configured
   in `.env`. Prefer fakes.
6. **Verification is per phase** (see each phase). Run the narrowest check that
   proves the change. Keep project-wide suites for the end of each phase.
7. **Docs stay in sync.** After each phase, update `backend/docs_design` if
   routes, contracts, lifecycle or architecture changed. Record the decisions in
   `docs/knowledge-management-ux-plan.md` (extend it; do not create a parallel
   UX doc).

## How to read the prototype efficiently

The file is about 700 KB. Do not read it top to bottom. Grep and read these
sections:

| What you need | Where in `docs/ux-review.html` |
| --- | --- |
| Design tokens (light + dark), every component class | first `<style>` block: `:root{`, `html[data-theme="dark"]`, `.btn`, `.input`, `.tbl`, `.badge`, `.tabs`, `.modal`, `.drawer`, `.menu`, `.toast`, `.state`, `.cite`, `.passage`, `mark.ev` |
| Accent themes, backgrounds, density | `Round 2 — themes` style block (`html[data-accent=…]`, `html[data-bg=…]`, `html[data-density=…]`) |
| Status vocabulary (plain-language labels and tones) | `const STATUS =` |
| Information architecture and navigation | `const MANAGE_NAV`, `const PLATFORM_NAV`, `function sidebar()`, `route(` calls |
| Per-page purpose, primary action, what changed | `Object.assign(NOTES,` and every `NOTES.*.changes.push` |
| End-to-end journeys | `const JOURNEYS` and every `JOURNEYS.splice` |
| Each page | `P.<pageName> =` (`chatHome`, `chatThread`, `chats`, `kbList`, `kbDetail`, `docViewer`, `overview`, `sources`, `access`, `assistant`, `activity`, `settings`, `pWorkspaces`, …) |
| Chat file work (attachments, secure workspace timeline, artifact panel) | `Round 3 — working with files` block: `wk_chipHtml`, `wk_workHtml`, `wk_cardsHtml`, `wk_filePanel`, `wk_historyHtml`, `wk_askHtml` |
| Copy rules applied everywhere | `docs/ux-review.html#/review` → “Key decisions”; the prototype's `CONTRACT`-style comments |

To see behaviour, open the file in a browser (Playwright is already a dev
dependency). Use the prototype bar at the bottom to switch role
(Member / Admin / Operator), force page states (Live / Loading / Empty / Error)
and switch to tablet width. Take reference screenshots of every page into
`/tmp/ux-ref/` (not into the repo) and compare against your implementation at
the end of each phase.

## Target information architecture

Replace the three disconnected rails (`WorkspaceRail`, `WorkspaceControlRail`,
`PlatformControlRail`) with **one product shell and one sidebar**. Sections
appear by permission.

```
Sidebar
├─ Workspace switcher (workspaces · Platform console for operators · settings)
├─ New chat                         → /chat
├─ Search ⌘K                        → command palette (one search)
├─ Knowledge                        → /knowledge
├─ Manage   (only items the caller is permitted to open)
│  ├─ Overview                      → /manage/overview        tenant.read + tenant.manage
│  ├─ Sources        (badge: needs attention)  → /manage/sources   source.manage | ingestion.read
│  ├─ People & access (badge: pending requests) → /manage/access   user.manage | role.manage | group.manage | access.manage
│  ├─ Assistant setup               → /manage/assistant       tenant.manage
│  ├─ Activity                      → /manage/activity        audit.read
│  └─ Settings                      → /manage/settings        tenant.manage
├─ Recent chats (scroll area) · View all → /chats
├─ Inbox (unread count)             → drawer                  [API pending: notifications.inbox]
└─ Account menu (profile & preferences, theme, shortcuts, product tour, sign out)

Platform console (same shell, sidebar swaps to platform items, chip “Console”)
├─ Workspaces → /platform/workspaces      (create / suspend: API pending)
├─ Users      → /platform/users           (admin toggle / suspend: API pending)
├─ Connectors → /platform/connectors      [API pending]
├─ AI capabilities → /platform/capabilities [API pending]
├─ Usage      → /platform/usage           [API pending]
├─ Audit log  → /platform/audit
└─ System health → /platform/health
```

Route mapping (add permanent redirects in `next.config.ts` or route handlers,
then delete the legacy alias table in
`modules/workspace-control/navigation.ts`):

| Current | New |
| --- | --- |
| `/app` | `/chat` (keep `?action=new`; `?action=search` opens the palette) |
| `/library` | `/knowledge/<personal collection id>` (“My files”) |
| `/workspace-control` | `/manage/overview` |
| `/workspace-control/knowledge` | `/knowledge` (management actions appear by permission) |
| `/workspace-control/ingestion?tab=sources|runs|schedules` | `/manage/sources?tab=sources|history` (schedules live on each source) |
| `/workspace-control/agent`, `/workspace-control/experience` | `/manage/assistant` |
| `/workspace-control/access?tab=…` | `/manage/access?tab=members|groups|roles|requests` |
| `/workspace-control/activity` | `/manage/activity?tab=changes|signins` |
| `/workspace-control/settings` | `/manage/settings` |
| `/workspace-control/platform[/*]` | `/platform/*` (“Tenants” → “Workspaces” everywhere in UI copy) |

Chats: `conversation_loop.md` says conversations are stored on the client and
are not synced across devices. Keep that storage. `/chat/[conversationId]` and
`/chats` read the same local store. Do not imply cross-device history.

## UI first, API pending — the adapter contract

Every operation the prototype needs but the API lacks follows this pattern, so
that wiring the real endpoint later changes **one function** and no component.

1. **Typed client function in the owning module's `api.ts`.** Use the exact
   signature, DTO names and error shape of the *proposed* endpoint (snake_case
   JSON, the same `ApiError` type real calls throw). Example:
   `createArtifactRevision(artifactId, { content, summary }): Promise<ArtifactRevision>`.
2. **The body delegates to the pending layer:**
   `return pendingApi("artifact.manual_revision", () => pendingArtifacts.createRevision(artifactId, body));`
3. **`web/src/lib/api/pending.ts`** owns:
   - `PENDING_FEATURES`: a registry of `{ key, title, proposedEndpoints[], module, docsAnchor }`. It is the single source of truth for what is not yet backed.
   - `pendingApi(key, fn)`: adds realistic latency (300–900 ms), can be told to fail through a dev-only switch so error states are testable, and logs `console.info("[pending-api]", key)` in development.
   - `isPendingFeatureEnabled(key)` and the hook `usePendingFeature(key)`, both read from typed config parsed once at the app boundary (`NEXT_PUBLIC_BOMESH_PENDING_FEATURES=all|none|<comma list>`; default `all` in development and preview). When a feature is disabled, its entry points are not rendered. No component reads `process.env` directly.
4. **Local implementations in `web/src/lib/api/pending/<feature>.ts`**:
   - deterministic seed data plus a `localStorage` store namespaced by account and workspace;
   - permission checks mirrored from the proposed contract, so the UI behaves the same way it will with the real API;
   - never writes to real endpoints;
   - never presents pending data as if it came from a real record.
5. **Visible but quiet marker.** Pages or sections that rely on a pending
   adapter show a small neutral `Preview` tag (tooltip: “Not connected to the
   server yet. Changes are kept in this browser.”). Control it with
   `NEXT_PUBLIC_BOMESH_PENDING_MARKER=on|off` (default `on`).
6. **Proposed contract written at the same time.** Add each pending endpoint
   to a section **“Proposed — UI built, API pending”** at the end of
   `backend/docs_design/api_contract.md`: method, path, permission, request and
   response, and which screen uses it. If it touches persistence, also add a
   proposed table note in `design.dbml` comments. Do not add these endpoints to
   `openapi.yaml` until the backend is implemented.
7. **Swap procedure (for later):** implement the endpoint, replace the
   adapter body with the real request, delete the local implementation and the
   registry entry, remove the `Preview` tag, then move the contract from
   “Proposed” into the endpoint map. Components and tests must not need
   changes.
8. **Tests target the client function**, not the adapter internals, so the
   same tests keep passing after the swap.

## Backend-support matrix (decide every feature from this)

**Backed** means a documented endpoint exists, so call it. **Partial** means
build with the real API where it exists and use pending adapters for the rest.
**API pending** means build the full UI now on the pending adapter named in the
last column, and write its proposed contract (rule 2). Re-check each row against
`api_contract.md` before you implement it; if an endpoint turns out to exist,
use it.

| Prototype feature | Status | Basis / pending adapter key → proposed contract |
| --- | --- | --- |
| Sign in (password, Google), create account, workspace picker, switch workspace | Backed | `/auth/sessions`, `/auth/accounts`, `PATCH /auth/session` |
| Forgot password | API pending | `auth.password_reset` → `POST /auth/password-resets`, `POST /auth/password-resets/{token}/complete`. Build the request + check-your-email + set-new-password screens |
| Chat streaming, knowledge-first search, citations, sources panel, stop/retry/edit | Backed | `POST /agent/chat` SSE, citation annotations |
| Attachments (upload) and referencing existing documents | Backed | `attachment_ids`, `collection_ids`, conversation uploads |
| Secure-workspace timeline (commands, output, failed runs) | Backed | `hosted_execution_result` items |
| File cards, revisions list, preview, download (original format), Save to knowledge | Backed | `/artifacts/{id}`, `/revisions/{n}/content`, `/publish` |
| Ask for changes to a file (agent makes a new revision) | Backed | Normal chat turn addressed to the artifact (current `editArtifact` pattern) |
| Edit a file by hand, restore a version | API pending | `artifact.manual_revision` → `POST /artifacts/{id}/revisions` `{ content, summary, restored_from? }` |
| Rename a file | API pending | `artifact.rename` → `PATCH /artifacts/{id}` `{ title }` |
| Download as other formats (CSV of a sheet, PDF, Markdown) | API pending | `artifact.export_formats` → `GET /artifacts/{id}/revisions/{n}/export?format=` |
| Answer variants (‹ 1/2 ›), retry modes (more detail / shorter) | Backed (client) | Kept in local conversation store; retry sends a new request |
| Share chat link | API pending | `chat.share` → `POST /conversations/{id}/shares` (requires server-side conversation snapshot; recipients only see sources they can read) |
| Knowledge list/detail, create, edit metadata, archive, ACL/share, request access, approve/deny | Backed | collections, collection ACL, approval requests |
| Document table: filters, sort, bulk reprocess/archive, details drawer, retry failed | Backed | documents + `POST /ingestion-runs` scoped to documents |
| Bulk “Move to” another knowledge base | API pending | `document.move` → `POST /documents/move` `{ document_ids, collection_id }` |
| Restore archived document (Undo after archive) | Partial | Archive is real; restore → `document.restore` → `POST /documents/{id}/restore` |
| Document viewer with highlighted cited passage | Backed | `document_viewer.md` focus endpoint |
| Select text in a document → Ask about this | Backed (client) | Prefills the composer, scoped to the document's collection |
| Sources: connect wizard (app → account → content → destination + schedule), reconnect, sync now, pause, schedule edit, disconnect | Backed | connections, sources, schedule, ingestion runs |
| Request a connector that isn't available | Backed | `approval_requests` type `plugin_installation` |
| Sync history and sync detail (failed documents, retry failed) | Backed | `/ingestion-runs`, run items |
| Overview: needs-attention list, usage numbers + 30-day chart, knowledge health, recent activity | Backed | `/workspaces/{id}/overview`, sources and requests state |
| Overview: knowledge gaps (unanswered questions, add documents, dismiss) | API pending | `analytics.knowledge_gaps` → `GET /workspaces/{id}/knowledge-gaps?window=`, `PATCH /workspaces/{id}/knowledge-gaps/{gap_id}` `{ dismissed }` |
| Members (add existing account, role, groups, suspend), groups, roles + permission editor, requests | Backed | `/users`, `/accounts?email=`, `/roles`, `/groups`, `/permissions`, `/approval-requests` |
| Assistant setup: instructions, answer length, capabilities, welcome message, starter prompts, live preview | API pending | `workspace.assistant_settings` → `GET`/`PATCH /workspaces/{id}/assistant-settings`. The chat home reads welcome and starters through the same client |
| Activity: changes + sign-ins, filters, event drawer, export CSV | Partial | Lists are real (`/audit-logs`, `/access-sessions`, `/workspaces/{id}/activity`); export → `audit.export` → `GET /audit-logs/export?format=csv` |
| Workspace settings: name, URL code | Backed | `PATCH /workspaces/{id}` |
| Workspace archive (typed confirm) | API pending | `workspace.archive` → `POST /workspaces/{id}/archive` |
| Workspace brand color | API pending | `workspace.branding` → `PATCH /workspaces/{id}` `{ settings: { branding: { accent } } }` |
| Personal appearance (theme, accent, background, density) and notification preferences | Backed (client) / API pending | Appearance via `useAccountPreferences`; email notification toggles → `account.notification_prefs` → `GET`/`PATCH /me/notification-preferences` |
| Inbox / notifications (unread, mark all read, deep links) | API pending | `notifications.inbox` → `GET /notifications`, `PATCH /notifications/{id}`, `POST /notifications/read-all`. Items derived from real state (failing sources, pending requests) may be computed client-side inside the adapter |
| Product tour (first run) | Backed (client) | Local “seen” flag |
| Platform: workspaces, users, audit, health (read-only views) | Backed | `/platform/*` GET endpoints |
| Platform: create workspace, suspend/reactivate workspace | API pending | `platform.workspace_admin` → `POST /platform/workspaces`, `PATCH /platform/workspaces/{id}` `{ status }` |
| Platform: make/remove platform admin, suspend account | API pending | `platform.user_admin` → `PATCH /platform/users/{id}` |
| Platform: connectors (availability toggle, OAuth client config, view requests) | API pending | `platform.connectors` → `GET /platform/connectors`, `PATCH /platform/connectors/{key}` |
| Platform: AI capabilities (status of each capability; model set by deployment config) | API pending | `platform.capabilities` → `GET /platform/capabilities` (read-only; never expose secrets; model names only to platform admins) |
| Platform: usage (window, totals, chart, per-workspace table) | API pending | `platform.usage` → `GET /platform/usage?window=` |

## Design system (applies to every phase)

Port the prototype's system into `web/src/app/tokens.css`. That file stays the
only place that declares colours. Then expose it through
`components/ui/design-system.ts` and the Tailwind theme.

- **Surfaces:** canvas → sheet → raised. The app canvas is behind a rounded,
  hairline **sheet** that holds page content; the sidebar sits on the canvas.
  Depth comes from the ramp plus one hairline, not from stacked shadows.
- **Primary:** one action colour (prototype indigo `#3B38C4`, dark `#6461F0`),
  used only for the primary action, selection and focus. Exactly one primary
  button per view.
- **Evidence (signature):** amber `--ev-*` tokens are reserved for citations,
  cited passages and source chips. Never use them for warnings.
- **Status:** ok / warn / err / info / neutral, each with text, bg and border.
  Always pair colour with a text label. Healthy steady states render quietly as
  a plain dot and text.
- **Accent themes:** indigo, teal, ocean, plum, graphite, each in light and dark.
  Only the primary family changes. Applied via `html[data-accent]`.
- **Backgrounds and density:** `html[data-bg="plain|soft|mesh"]`,
  `html[data-density="comfortable|compact"]`.
- **Type:** IBM Plex Sans for UI and reading, IBM Plex Mono for numbers, codes
  and citation numerals (load with `next/font/google`). Scale: 28/600 display,
  24/600 title, 15/600 section, 14 body, 15.5/1.7 chat reading, 12.5 meta.
- **Radius:** 6 (chips), 8 (controls), 10 (cards), 12 (sheet), 14–16 (dialogs).
  Control heights: 30 / 36 / 42.
- **Components to (re)build in `components/ui` and `components/patterns`**,
  each with every state (default, hover, active, focus-visible, disabled,
  loading):
  - Button: primary / secondary / ghost / danger / danger-ghost / link · sm/md/lg · icon-only with `aria-label`
  - Input, Textarea, Select, SearchInput, input with prefix
  - Checkbox (including indeterminate), Radio, Switch, Segmented control, Choice card
  - Badge / StatusBadge (driven by one `STATUS` vocabulary module), Tag
  - Tabs as deep links (`?tab=`), PageHeader (crumbs, title, one-line sub, actions)
  - DataTable: sortable headers, selection, bulk bar, pager, hover row actions, columns hidden at ≤1080 / ≤900 px
  - FilterChip, Toolbar
  - Dialog (sizes sm/md/lg/xl, guard while submitting), Drawer, ConfirmDialog (with typed confirmation), Menu (keyboard: arrows, Esc, Tab), Toast (with action / Undo), Tooltip
  - EmptyState, ErrorState (with Retry), Skeletons (rows, cards)
  - Callout (info/ok/warn/err/neutral), Progress, Meter + Legend, small Bars chart
  - Citation chip, Passage, `mark.ev` highlight, Evidence chip
- **Copy:** sentence case and active verbs; a toast repeats its button's verb.
  Never show “ingestion”, “tenant”, “chunk”, “embedding”, cron strings, IDs or
  permission codes to normal users. Say sync, workspace, “Daily at 02:00”, and
  write permissions as sentences.
- **Responsive:** the shell collapses to a 68 px icon rail at ≤1100 px, with
  tooltips and an overlay expand. Side panels overlay at tablet width. Also
  respect reduced motion, visible focus rings, 4.5:1 text contrast, and a
  minimum 12 px text size.

## Phases

Work in this order. Do not start a phase before the previous one passes its
checks. After each phase, report: code changed, docs changed, contract decisions,
verification performed, open decisions.

### Phase 0 — Inventory and safety net
1. Read the prototype sections listed above and the current
   `web/src/{app,components,modules,lib}`.
2. Write a short mapping table (prototype page → current component → target
   route and component → backend status). Add it to
   `docs/knowledge-management-ux-plan.md`.
3. Capture “before” screenshots of every current route with Playwright into
   `/tmp/ux-before/`.
4. Run `cd web && npm run typecheck && npm test` and record the baseline.

**Acceptance:** the mapping exists and the baseline is green, or pre-existing
failures are listed.

### Phase 1 — Design tokens and primitives
1. Rewrite `app/tokens.css` to the prototype tokens: light, dark, accents, bg,
   density. Keep the semantic token names that components already consume, or
   migrate every consumer in the same phase.
2. Rebuild the primitives listed in the design system section, and delete
   superseded variants and duplicate CSS in `workspace.css`,
   `control-plane.css`, `shell.css` and `patterns.css`.
3. Add a `/dev/design-system` route (development builds only) that renders every
   component in every state, equivalent to the prototype's `#/design`.
4. Build the pending-API layer (`lib/api/pending.ts`, `lib/api/pending/`,
   typed config parsing, `usePendingFeature`, the `Preview` tag component) and
   register every **API pending** row of the matrix. Create the
   “Proposed — UI built, API pending” section in `api_contract.md` with all
   proposed endpoints at once; later phases fill in the details.

**Verify:**
- `npm run typecheck`
- `node web/scripts/contrast.mjs`
- `node web/scripts/arbitrary-value-audit.mjs` (no raw hex or arbitrary values outside tokens)
- Screenshots of `/dev/design-system` in light and dark, and with each accent

### Phase 2 — One shell, one sidebar, routing, command palette
1. Build `ProductShell` with the sidebar from the target IA. Delete the three
   rails, `IdentityContextDock` and `ControlPlaneTopbar` duplication once nothing
   uses them.
2. Permission-driven items come from one nav definition (`lib/navigation.ts`).
   Attention badges come from real data: sources needing reconnect or failing,
   pending approval requests.
3. Workspace switcher menu: workspaces, Platform console (operators only),
   workspace settings, all workspaces.
4. Account menu: profile & preferences (theme, accent, background, density,
   “show how answers were found”), keyboard shortcuts, product tour, sign out.
5. One command palette (⌘K) that replaces `DocumentFinder`'s rail action and
   `ControlPlaneCommandPalette`. It searches chats, knowledge bases, documents
   (`/knowledge` search API), people (if permitted) and pages, offers actions,
   and can “Ask the assistant” with the query.
6. Routes and redirects from the mapping table. A no-access page replaces any
   leaked route for callers without permission.

**Verify:**
- Update `tests/navigation.test.mts` and `web/scripts/nav-contract.mjs` for the
  new nav, permission filtering and redirects.
- Playwright: shell at 1440 and 834 px, each persona (member / workspace admin /
  platform admin test accounts or mocked sessions), palette keyboard navigation.

### Phase 3 — Auth and workspace entry
Sign in (Google + password on one screen, inline validation, form-level error,
email retained), create account (password rules, “an admin must add you”), and
the workspace picker. The picker's empty state tells new accounts exactly what
to send their admin.

**Verify:** auth API tests still pass. Playwright: invalid email, wrong
password, single-workspace auto-enter, multi-workspace picker.

### Phase 4 — Chat (core experience)
Follow `P.chatHome`, `P.chatThread`, `P.chats` and the Round-3 file-work block.
- Home: welcome and starters read from `workspace.assistant_settings` (pending
  adapter, seeded with the prototype's defaults). The composer has a `+` menu (upload, add from knowledge),
  drag & drop, a scope chip (multi-select collections) and send/stop.
- Attachment chips with states: uploading %, reading, ready, failed with reason,
  referenced document (no access → locked). Enforce the limits from the backend
  config.
- Answer:
  1. A collapsed work line (“Worked for 26s · Searched … · Ran 3 commands, 1
     failed · Created 2 files”) that expands into a timeline. Command blocks
     show code and output from `hosted_execution_result`, with failures shown.
  2. Streamed markdown with amber citation chips.
  3. File cards.
  4. Source chips.
  5. Actions: copy, retry menu (try again / more detail / shorter / search all
     knowledge), feedback, sources, more (copy Markdown, save answer to My files).
  6. Answer variants pager kept locally.
- User message: copy, edit in place with confirmation when later messages will
  be dropped.
- Right panel, one at a time: **Sources** (per-document cards, focused passage,
  open document) · **File** (header with version menu, download, Save to
  knowledge; tabs Preview / Changes / History; spreadsheet grid with sheet tabs
  and cell value bar; document page view; diff with added/changed/removed;
  “Ask for changes” box with quick suggestions) · **Files in this chat**.
  Manual edit (contenteditable doc editor with toolbar, unsaved-changes
  guard, “Save as version N”, Undo), Restore, Rename and extra download
  formats are built on the `artifact.*` pending adapters. Share chat is built on
  `chat.share` (dialog: who can open, copy link, permission note).
- Partial access: drop unreadable citations, show the lock hint, and hide
  answers the caller cannot read at all (request-access call-out).
- States: thread skeleton, no-results answer with “Search all knowledge”,
  interrupted answer with Retry, file-work failure (“Nothing was saved”).
- `/chats`: search, date groups, rename and delete with confirm. Empty,
  no-match and error states.

**Verify:**
- Extend the existing tests in `web/tests/`: `assistant-turn`, `artifacts`,
  `citation-*`, `message-stream`, `conversation-history`. Add fixtures for
  `hosted_execution_result` with a failed command and for multi-revision
  artifacts.
- Playwright against a mocked SSE stream: stop, retry, edit, citation → panel →
  document, artifact preview/diff/publish.

### Phase 5 — Knowledge and documents
Merge Library into Knowledge.
- `/knowledge`: grid/list, search, access filter, sort, My files pinned, locked
  knowledge bases with Request access and a pending state, create dialog
  (name + description + who can see it), first-run and member empty states.
- `/knowledge/[id]`: tabs Documents / Sources / Access / Settings (by role).
  - Documents tab: filters (status, type), sort, pagination, failed-documents
    call-out with Retry all, bulk bar (reprocess, archive with Undo), row menu,
    details drawer.
  - Upload dialog with per-file progress, unsupported-file errors and live
    status updates (poll the ingestion run).
  - Access tab: general access, people & groups with roles, share dialog with
    keyboard people picker, pending requests approve/deny, last-owner guard.
  - Settings tab: name/description with dirty save; archive with typed confirm
    (tombstone).
- `/documents/[id]` viewer: outline, pages, info column, cited passage
  highlighted and scrolled into view (`?chunk=`), “Ask about this document”,
  select-to-ask. Not-ready, failed and no-access states.

**Verify:** API-level checks for create/archive/ACL through existing tests in
`tests/test_knowledge_workspace_api.py` where the API is touched. Playwright:
member read-only view, admin bulk archive + Undo, upload processing, request
access → admin approves → member sees content.

### Phase 6 — Sources
`/manage/sources` with tabs Sources / Sync history / Accounts.
- Attention call-out with Reconnect as the page primary.
- Sources table: status, progress, human-readable schedule, last sync, row menu.
- Source drawer: status call-out, what's synced, destination, inline schedule
  editor, account, recent syncs.
- Four-step connect wizard with guarded close: app (unavailable apps → request
  via `plugin_installation`), account (reuse, reconnect, Google sign-in wait,
  Confluence credentials with validation), content tree (search, partial
  checks), destination + schedule + review. The first sync starts on create.
- Sync detail drawer (steps, counts, failed documents, retry failed, cancel
  with `ingestion.manage`).
- Accounts tab (check connection, disconnect blocked while sources use the
  account).

**Verify:** `tests/test_db_services.py` and the ingestion API tests for any
touched endpoint, `web/tests/ingestion-runs.test.mts`, `sources.test.mts`.
Playwright: both connect paths, reconnect clears the sidebar badge.

### Phase 7 — Manage: overview, people & access, activity, settings
- **Overview:** greeting, a needs-attention list built from real data (one
  primary action), three usage numbers and a 30-day chart from `/overview`,
  knowledge health meter, recent activity. A new workspace gets a setup
  checklist built from real state (knowledge base exists, documents exist,
  more than one member).
- **People & access:**
  - Members: filters, inline role change (confirm when demoting yourself),
    bulk actions, member drawer.
  - Add member: validates against `/accounts?email=` and explains the
    “needs an account” case.
  - Groups (drawer, add people), roles (built-in locked with Duplicate; custom
    editable with a sticky save bar; delete blocked while assigned),
    requests (approve with Undo, deny with reason, recently decided).
- **Activity:** changes and sign-ins, window, filters, event drawer. Actions are
  shown in plain language, mapped from audit `action` codes in one translation
  module.
- **Settings:** name and URL code with validation and a link-breakage warning.
- **Assistant setup:** build the full page on `workspace.assistant_settings`:
  Behavior tab (instructions with counter, answer length, capability toggles,
  always-on knowledge search) and Home screen tab (welcome message, up to 3
  starters with reorder), a live preview column (modal at tablet width), and a
  sticky Discard/Save bar with validation. Delete the `NotBackedYet` pages.
- **Overview knowledge gaps** (`analytics.knowledge_gaps`), **Inbox drawer**
  (`notifications.inbox`), **brand color** card and **archive workspace** in
  Settings (`workspace.branding`, `workspace.archive`), **Export CSV** in
  Activity (`audit.export`): build each exactly as in the prototype.

**Verify:** existing IAM tests in `tests/`, a unit test for the
audit-action → sentence mapping (unknown codes fall back safely), Playwright
for add-member validation and request approval.

### Phase 8 — Platform console
Workspaces (search, filter, sort, drawer, create-workspace dialog with
URL-code validation, suspend/reactivate with confirm), Users (platform-admin
toggle that blocks self, suspend), Connectors (cards, availability toggle with
confirm, configure drawer, requests modal), AI capabilities (read-only status
rows, degraded call-out), Usage (window, three totals, chart, sortable table),
Audit log (with workspace column) and System health (banner, service rows,
uptime strip, incidents). All on `/platform/*` with platform permissions. Read
views use the real `/platform/*` endpoints; every action and the
Connectors / AI capabilities / Usage pages use their `platform.*` pending
adapters.

**Verify:** a platform-admin session sees the console; a workspace admin
without platform permission gets the no-access page; screenshots.

### Phase 9 — Polish and cross-cutting checks
1. Appearance preferences (accent, background, density, theme) persisted
   locally.
2. Product tour (five steps, skippable, reachable from the account menu).
3. Each list page renders loading, empty, no-results and error states (compare
   with the prototype's State switch).
4. Tablet (834 px) pass on every page. Keyboard-only pass: tab order, Esc closes
   the top layer, focus returns to the trigger.
5. Delete dead code: old rails, legacy aliases, `NotBackedYet`, duplicate
   document lists, unused CSS.
6. Pending-API audit: every key in `PENDING_FEATURES` has a client function, a
   local implementation, a `Preview` marker and a proposed contract in
   `api_contract.md`. No component imports `lib/api/pending/*` directly (only
   `api.ts` files do). Add a small script `web/scripts/pending-api-audit.mjs`
   that fails when these drift.
7. Run the full checks: `cd web && npm run typecheck && npm test && npm run build`,
   the `web/scripts/*-audit` and contract scripts, and backend `pytest` only for
   touched areas.
8. Capture “after” screenshots and compare them against `/tmp/ux-ref/`; list
   any intentional differences.

## Final report (after Phase 9)

```
Code changed        (by module)
Docs changed        (backend/docs_design files, docs/knowledge-management-ux-plan.md)
Contract decisions  (approved / proposed / rejected — one line each)
Verification        (commands run with results; Playwright flows walked; screenshots location)
Pending APIs        (key → client function → proposed endpoint → screens using it)
Remaining decisions
```
