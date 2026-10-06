# Knowledge management UX architecture

## Product model

A Knowledge Base is a durable collection. It exists independently from the
ways content enters it. Source connections, ingestion sources, imports, and
schedules remain separate governed records so adding a future ingestion method
does not change collection creation.

```text
Knowledge Base
├── Items
├── Ingestion sources
├── Activity
└── Collection settings and access

Source connection ──bind/import──▶ Knowledge Base
Schedule ──runs a ingestion source──▶ Knowledge Base
```

## Audit of the previous experience

| Severity | Finding | User impact | Resolution |
| --- | --- | --- | --- |
| Critical | Creation required `Source → Scope → Access → Sync → Review`. | Users could not create the collection they intended to organize until they also designed a pipeline. | Replaced with one focused dialog containing only name and optional description. |
| Major | The setup sheet mixed collection, connector, permissions, and automation state. | Ownership of each setting and the meaning of “Create” were unclear. | Ingestion source, access, imports, and schedules are independent follow-up flows. |
| Major | A wide sheet and live summary devoted most of the viewport to information that did not help initial creation. | Slow scanning, weak hierarchy, and excessive empty space. | Compact dialog, autofocus, inline validation, Enter submission, loading state, and duplicate-submit protection. |
| Major | The detail page led with an ingestion lifecycle rather than the collection’s content workspace. | A new empty collection looked incomplete or broken instead of ready. | The collection opens directly to Items with an actionable empty state. |
| Major | Schedule data appeared in creation, list columns, and a local Sync tab. | Automation was presented as a mandatory Knowledge Base property. | Added a workspace-level Schedules destination; detail Activity only links to it. |
| Moderate | The list emphasized readiness metrics and refresh cadence. | Collections were harder to scan by ownership and content. | The list now prioritizes name, description, items, sources, owner, and updated time. |
| Moderate | Upload and manual creation entry points implied capabilities not supported by collection-scoped backend contracts. | A UI could falsely suggest content landed in the selected collection. | Actions explicitly identify the missing contract and never create fake records. |

## Information architecture

One product shell and one sidebar; sections appear by permission
(`web/src/lib/navigation.ts` is the single definition).

- New chat (`/chat`), Search ⌘K (command palette), Inbox (drawer), Knowledge
  (`/knowledge`, `/knowledge/<id>`, documents at `/documents/<id>`)
- Manage: Overview, Sources (sources, sync history, accounts), People & access
  (members, groups, roles, requests), Assistant setup, Activity, Settings
  (`/manage/*`)
- Recent chats (`/chats` for all), account menu
- Platform console (`/platform/*`, platform permissions only): Workspaces,
  Users, Connectors, AI capabilities, Usage, Audit log, System health

## Primary flows

### Create a Knowledge Base

1. Open **Knowledge**.
2. Select **Create knowledge base** (requires `knowledge.manage`).
3. Enter a required name, an optional description and who can see it.
4. Submit with the button or Enter.
5. The server creates the collection and owner grant.
6. A success toast is announced and the new knowledge base opens on **Documents**.
7. The user can add content now, leave, or return later.

### Connect a source after creation

1. Open **Manage → Sources** and choose **Connect a source**, or use
   **Connect a source** on a knowledge base's Sources tab, which carries that
   knowledge base as the destination (`/manage/sources?connect=1&collection=<id>`).
2. The four-step wizard asks for the app (unavailable apps can be requested),
   the account (reuse, reconnect or sign in), the content, then destination and
   schedule with a review. Closing mid-way asks before discarding.
3. Creating a source requests its first sync. Documents arrive Waiting; a
   separate ingestion run processes them for search and answers.

### Configure a schedule

Schedules live on each source (there is no separate Schedules destination):
open the source drawer (`/manage/sources?source=<id>&edit=schedule`), pick
manual, daily, weekly or hourly with a time and time zone, and save. The list
shows the schedule as a sentence ("Daily at 02:00"), never a cron string.

## UI state model

| Surface | State | Treatment |
| --- | --- | --- |
| Create dialog | Pristine | Create disabled; name autofocus. |
| Create dialog | Invalid | Inline name error after blur or attempted submit; focus returns to name. |
| Create dialog | Submitting | Button spinner, `aria-busy`, close guarded, duplicate submit ignored. |
| Create dialog | Failed | Inline actionable API error; entered values retained. |
| Create dialog | Succeeded | Success toast, modal closes, new Knowledge Base opens. |
| List | Loading | Structure-preserving row skeletons. |
| List | Empty | Explains collections and offers creation. |
| List | No results | Filter-specific copy and Clear filters action. |
| List | Partial data error | Collections remain openable; missing counts/owners are disclosed. |
| Detail Items | Empty | “Add your first knowledge” with Upload, Create item, and Connect source actions. |
| Ingestion source | Submitting | Selected connection and form remain stable; duplicate source submit blocked. |
| Ingestion source | First sync failed | Source remains created; failure is shown on its row with a retry sync action. |
| Schedules | Empty | Explains that ingestion source is a prerequisite, not Knowledge Base creation. |
| Destructive action | Confirming | Real confirmation dialog; archive uses the existing tombstone endpoint. |

## API and data-model compatibility

- `POST /api/v1/admin/collections` already accepted `title`, optional metadata,
  and no source or schedule. No creation-model migration was required.
- `PATCH /api/v1/admin/collections/{item_id}` is additive and updates the
  collection title and description while preserving unrelated metadata.
- `POST /api/v1/collections/{collection_id}/documents/upload` accepts one
  multipart file with an `Idempotency-Key`, enforces collection editor access,
  stores the raw object, and runs the document indexing pipeline without a
  connector or ingestion source.
- Collection list payloads now include metadata, access inheritance, and the
  creator user ID so description and owner filtering are grounded in server
  data.
- A connection is created through `/connections` or provider authorization.
  A source is created from that connection via
  `POST /connections/{connection_id}/sources`; its first sync is requested at
  creation, while processing remains a separate `POST /ingestion-runs`.
  Automation uses the separate `/sources/{source_id}/schedule` resource.
- Archive continues to call the existing Item delete boundary, which writes a
  lifecycle tombstone rather than physically deleting business data.

## Known backend dependencies

- Manual authored items need a collection-scoped create/index contract with
  explicit lineage and access inheritance. The UI does not simulate this.
- A source connection currently owns its provider scope. Per-source remote
  scope discovery remains dependent on connector discovery endpoints.
- No tenant storage or ingestion quota model currently exists. Collection
  uploads enforce the configured per-file upload and processing limits.

## Refactor to the approved prototype (`docs/ux-review.html`)

The prototype is the design specification; `docs/ux-refactor-plan.md` is the
execution brief. This section records the decisions taken while implementing
it. Where it conflicts with the earlier sections above (rails, "Ingestion",
separate Schedules destination), this section wins.

### Phase 0 — inventory

Baseline before any change: `npm run typecheck` green, `npm test` 104/104
passing. "Before" screenshots: `/tmp/ux-before/`; prototype references:
`/tmp/ux-ref/` (desktop 1440 and tablet 834, per persona).

| Prototype page | Current implementation | Target route → component | Backend |
| --- | --- | --- | --- |
| Shell: sidebar, switcher, account, palette, inbox, tour | `WorkspaceRail`, `WorkspaceControlRail`, `PlatformControlRail`, `IdentityContextDock`, `ControlPlaneShell`/`Topbar`, `ControlPlaneCommandPalette`, `DocumentFinder`, `AccountDialog`, `Workspace/PlatformContextMenu` | `ProductShell` + `Sidebar` + `CommandPalette` + `InboxDrawer` + `AccountMenu` + `ProductTour` (`components/shell`) | Backed; inbox = `notifications.inbox` pending |
| `signin` | `AuthForm` (`/auth/login`) | `/auth/login` | Backed |
| `signup` | `AuthForm` (`/auth/signup`) | `/auth/signup` | Backed |
| Forgot password (brief only) | — | `/auth/password-reset`, `/auth/password-reset/[token]` | `auth.password_reset` pending |
| `workspaces` | `WorkspaceDiscovery` (`/workspaces`) | `/workspaces` → workspace picker | Backed |
| `chatHome` | `ChatShell` (`/app`) | `/chat` | Backed; welcome/starters = `workspace.assistant_settings` pending |
| `chatThread` + Round 3 file work | `ChatShell`, `AssistantTurn`, `RightActivityPanel`, `ArtifactCard`, `ArtifactPreview`, `AnswerSources` | `/chat/[conversationId]` | Backed; `artifact.*`, `chat.share` pending |
| `chats` | `AppSidebar` recents, `ConversationActionsMenu` | `/chats` | Client store (not synced) |
| `kbList` | `KnowledgeScreen` (`/workspace-control/knowledge`), `LibraryScreen` (`/library`), `CollectionCards` | `/knowledge` | Backed |
| `kbDetail` | `KnowledgeScreen` detail, `DocumentsView`, `DocumentBulkBar`, `DocumentDetailsDrawer`, `CollectionAccess` | `/knowledge/[collectionId]?tab=documents|sources|access|settings` | Backed; `document.move`, `document.restore` pending |
| `docViewer` | `DocumentViewer`, `DocumentRenditionView`, `KnowledgeDocumentPreview` | `/documents/[documentId]?chunk=` | Backed |
| `overview` | `WorkspaceOverviewPage` | `/manage/overview` | Backed; gaps = `analytics.knowledge_gaps` pending |
| `sources` | `IngestionScreen`, `SourcesView`, `RunsView`, `SchedulesView`, `ConnectSourceFlow`, `RunDetailView`, `ConnectionDetailView` | `/manage/sources?tab=sources|history|accounts` | Backed |
| `access` | `AccessPage`, `GroupsPanel`, `RolesPanel` | `/manage/access?tab=members|groups|roles|requests` | Backed |
| `assistant` | `AgentsPoliciesPage`, `ExperiencePage` (`NotBackedYet`) | `/manage/assistant?tab=behavior|home` | `workspace.assistant_settings` pending |
| `activity` | `AuditPage`, `SessionLog` | `/manage/activity?tab=changes|signins` | Backed; export = `audit.export` pending |
| `settings` | `SettingsPage` | `/manage/settings` | Backed; `workspace.branding`, `workspace.archive` pending |
| `pWorkspaces` | `PlatformTenantsPage` | `/platform/workspaces` | Read backed; `platform.workspace_admin` pending |
| `pUsers` | `PlatformUsersPage` | `/platform/users` | Read backed; `platform.user_admin` pending |
| `pConnectors` | `PlatformIntegrationsPage` | `/platform/connectors` | `platform.connectors` pending |
| `pModels` | `PlatformModelsPage` (`NotBackedYet`) | `/platform/capabilities` | `platform.capabilities` pending |
| `pUsage` | `PlatformUsagePage` (`NotBackedYet`) | `/platform/usage` | `platform.usage` pending |
| `pAudit` | `PlatformAuditPage` | `/platform/audit` | Backed |
| `pHealth` | `SystemHealthPage` | `/platform/health` | Backed |
| `design` | — | `/dev/design-system` (development only) | n/a |

### Phase 1 — design tokens, primitives, pending-API layer

- **One token file.** `web/src/app/tokens.css` holds every colour (prototype
  values, light + dark, accents indigo/teal/ocean/plum/graphite). Existing
  semantic names were kept (`--surface-base` is the prototype "sheet",
  `--surface-inset` is "sunken"); duplicates (`--color-*`, `--action-primary-*`,
  `--elevation-*`, …) were removed and every consumer migrated. Evidence
  (`--evidence-*`) and status (`--status-*`) are deliberately not themeable.
- **Contrast over fidelity.** Where a prototype pair failed 4.5:1 the token
  moved, documented next to its value: dark teal/ocean/plum use ink text on the
  accent; dark danger fill is `#c0312b`. `web/scripts/contrast.mjs` checks 670
  pairs across themes and accents.
- **Appearance is per device.** `@/lib/appearance` + `useAccountPreferences`
  store theme, accent, background, density and reduced motion under
  `bomesh.appearance`; a pre-paint boot script is the single writer of the
  `html[data-*]` attributes.
- **Primitives** live in `components/ui` (controls, overlays, data, feedback)
  and `components/patterns` (citation chip, passage, evidence chip). Dropdown,
  StatusPill, Toggle and SearchField were deleted in favour of Menu,
  StatusBadge, Switch and SearchInput. Destructive confirmations use
  `ConfirmDialog` with optional typed confirmation; layered UI shares one
  modal-layer stack (Esc closes the top layer, focus returns to the trigger).
- **One status vocabulary.** `web/src/lib/status.ts` (ported from the
  prototype `STATUS`) is the only place a backend state becomes a label and
  tone; healthy steady states render quietly.
- **UI first, API pending.** `web/src/lib/api/pending.ts` registers the
  pending features (`PENDING_FEATURES`), adds latency and a development
  failure switch (`localStorage["bomesh.pending.fail"]`), and stores local state
  per account and workspace. Client functions with the proposed signatures sit
  in each owning module's `api.ts`; the proposed contracts are in
  `backend/docs_design/api_contract.md` → "Proposed — UI built, API pending"
  and `design.dbml` (commented). Configuration:
  `NEXT_PUBLIC_BOMESH_PENDING_FEATURES=all|none|<keys>` and
  `NEXT_PUBLIC_BOMESH_PENDING_MARKER=on|off`; surfaces backed by a pending
  adapter show a neutral `Preview` tag.

### Phases 2–8 — shell, entry, chat, knowledge, sources, manage, platform

Product routes live under `web/src/app/(product)/` inside one `ProductShell`
(sidebar on the canvas, content on a rounded sheet; 68px icon rail at
≤1100px). Legacy addresses redirect permanently (`web/src/lib/legacy-redirects.ts`,
tested in `tests/navigation.test.mts`). Decisions that shape later work:

- **Navigation.** Sidebar order follows the prototype: New chat, Inbox, Search
  ⌘K, Knowledge, Manage, Recent chats. Overview requires `tenant.read` and
  `tenant.manage`; pending-backed destinations (Assistant setup, platform
  Connectors, AI capabilities, Usage, Inbox) also require their pending
  feature. Pages gate themselves with `RequirePermission`; a denied address
  renders the shared no-access page.
- **Appearance.** The accent defaults to "Workspace brand" (falls back to
  indigo; the platform console is always indigo); a personal accent wins.
- **Entry.** Sign-in is email + password or Google on one screen; error copy
  comes from the HTTP status, never the API's operator `detail`. A new
  account starts in its personal workspace (backend behaviour), so the copy
  says an admin adds them to their team's workspace afterwards.
- **Chat.** Chats stay in this browser (`conversation_loop.md`); copy never
  implies cross-device history. Answers keep streaming across navigation.
  Retries append an instruction and become variants; editing a middle question
  drops later messages after confirmation. Partial access is re-checked per
  cited document; an unreadable collection cannot be named (API returns 404),
  so the full-hide call-out links to Knowledge. Deep links: `/chat?q=` (draft),
  `&send=1`, `&scope=<collection ids>`, `&doc=<document id>`.
- **Files.** Only Markdown and text files are edited by hand; other types are
  changed by asking. Hand edits, restores and Undo (proposed `DELETE` of the
  newest hand-made revision) run on `artifact.manual_revision`. Publishing
  always saves the server's newest revision.
- **Knowledge.** Collection ACL principals are users and groups only, so
  "Everyone in the workspace" is pending (`collection.general_access`); real
  collections read Restricted. Locked cards come only from real ids the caller
  has met (`collection.discovery`) — nothing is invented. Document archive holds
  the real `DELETE` for an 8 s Undo window. Knowledge-base archive has no
  restore API, so it offers no Undo.
- **Viewer.** `/documents/<id>?chunk=<a>&chunk=<b>` marks every cited passage
  and focuses the first; text view comes first whenever a rendition exists.
- **Sources.** One attention rule (`sourceAttention`) drives the page call-out,
  the Overview list and the sidebar badge. A source's account and resource are
  immutable in the API, so the drawer offers no "change what's synced". After a
  manual sync the open page starts an ingestion run so changes become
  searchable (backend only auto-processes scheduled syncs — open decision).
- **People & access.** The API refuses any change to your own access and the
  last admin's demotion, so your own row is locked with an explanation. Roles
  are disabled, not deleted (lifecycle). Removing a member is pending
  (`workspace.member_remove`). Approvals commit after a 6 s Undo window.
- **Manage.** The workspace web address is pending (`workspace.url_code`;
  `PATCH /workspaces/{id}` rejects `code`). Audit actions become sentences in
  one module (`modules/manage/activity/audit-actions.ts`); codes appear only
  under "Technical details". Activity filters run in the browser over 30 days
  because the API filters only by search.
- **Platform.** Read views use the real `/platform/*` endpoints; rows created
  or changed in this browser carry a Preview tag. System health history is
  derived only from real health reports this browser has read
  (`platform.health_history`).

### Phase 9 — cleanup

The three rails, the control-plane shell, `ChatShell`, Library, the old
ingestion and knowledge screens, `NotBackedYet` and `modules/workspace-control`
are deleted; shared helpers moved to `web/src/lib` (`format.ts`,
`api/upload.ts`, `hooks/useApiData.ts`). Global CSS shrank from seven files
(~9,300 lines) to `tokens.css`, `globals.css` and `shell.css` (~1,700 lines).
`npm run audit:pending` (`web/scripts/pending-api-audit.mjs`) fails when a
pending key lacks a client function, local implementation, `Preview` marker,
feature gate or proposed-contract anchor, or when a component imports a local
implementation directly.

### Open decisions (backend or product)

- Sharing needs a server-side conversation snapshot; until `chat.share` is
  implemented, `/s/<id>` opens only in the browser that created the link.
- Assistant settings (instructions, capabilities) are not sent with chat
  requests: `ChatRequest` has no such fields.
- A manual sync does not process what it finds; the Sources page starts the
  ingestion run while it is open. The backend should process after any sync.
- Citations do not carry `collection_id`, and unreadable documents return 404,
  so a partially hidden answer cannot request access to the exact knowledge
  base.
- The API refuses confirmed self-demotion; decide whether it should allow it.
- `/platform/workspaces` and `/platform/users` drop owner, counts, roles and
  memberships in their routers (documented drift in `api_contract.md`).
- Name limits differ (UI 60 characters, API 255); choose one product rule.
- The brief's backend matrix lists the workspace URL code as backed; it is
  pending (`workspace.url_code`) because `PATCH /workspaces/{id}` rejects
  `code`.
