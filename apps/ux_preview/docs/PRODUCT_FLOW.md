# BoMesh product flow

## Product

BoMesh is a context-aware AI workspace: people get answers they can trust from their organisation's own knowledge, then finish the work that follows — with permissions and citations throughout. Administrators keep knowledge connected and governed; platform operators run the deployment.

One platform serves different domains through **workspace templates**. A template switches **modules** on (Home, Spaces, Work, Requests), defines the **space types** people organise around and the **AI workflows** offered. Admins can override modules, space types and workflows per workspace (Settings → Workspace setup). Knowledge — the **Knowledge Hub** — is the same in every template; see [KNOWLEDGE_HUB.md](KNOWLEDGE_HUB.md). The prototype ships two workspaces:

| Workspace | Template | What it shows |
| --- | --- | --- |
| Northwind Group (+ Northwind Finance, sharing its demo data) | Enterprise | Ask company knowledge, govern sources and access |
| UTE Campus | Campus | Courses, research groups and offices: learning, research and student services — see [CAMPUS_WORKSPACE.md](CAMPUS_WORKSPACE.md) |

Trust contract made visible in the UX:

1. Retrieval happens inside the active workspace.
2. Resource permissions apply before evidence reaches the assistant — an answer that would rely on unreadable knowledge says so instead.
3. Every grounded claim links to a citation, the passage and the whole document.
4. Source lineage, processing state and audit history stay visible to authorized people.
5. Workspace administration and platform operation are separate permission scopes.

All behavior is local mock data; nothing reaches a backend.

## Personas

| Persona | Job | Home | Permission boundary |
| --- | --- | --- | --- |
| Member (Northwind) | Ask, verify, find and read knowledge | New chat | Effective knowledge-base access; can request access to discoverable restricted knowledge |
| Student, Lecturer, Researcher (UTE) | Study, teach, research; send requests | Home | Workspace role + space role (e.g. Lecturer of a course, PI of a lab) + knowledge access |
| Workspace admin (Northwind admin, UTE Academic Affairs head) | Keep knowledge useful, connected and governed; run office queues | Overview | Workspace permissions (`tenant.manage`, `source.manage`, `user.manage`, `audit.read`, …) and per-knowledge-base roles |
| Platform operator | Operate workspaces, accounts, connectors and service health | Platform console | `platform.*` permissions only; workspace data still requires membership |

## Principles

- **Ask first, then finish the work.** Enterprise lands on New chat; Campus lands on Home (ask box, what's due, where you left off). Answers suggest the next step (start a request, make a study guide, compare papers).
- **Evidence in one click.** Citation marker → passage panel → document with the passage highlighted.
- **Fix it where you see it.** Every alert and inbox item carries its fix (Reconnect, Process, Approve, Review).
- **One shell.** One permission-aware sidebar for every persona; the Manage group and platform console appear only when permitted.
- **One primary action per screen.** Everything else is secondary, in a row menu, or in a drawer.
- **Recoverable by default.** Reversible changes offer Undo; irreversible ones confirm (typed confirmation for workspace archive).
- **Honest proposals.** Pages without a backend contract carry one `Preview` chip.

## Information architecture

```text
Sign in · Create account · Choose workspace

Workspace (sidebar; items marked * appear when the module is on)
├── Home* ────────────── Ask · Quick starts · Up next · Continue · Needs you
├── New chat (Enterprise) ─ Conversation ── Citation panel · File panel · Share
├── Inbox
├── Work* ────────────── New (workflow → materials → options) · Quiz · Study guide · Literature review · Draft
├── Requests* ────────── My requests · Queue · New (catalog → rule check → form) · Request thread
├── Knowledge ────────── Discover · Browse (catalog) · My library (Saved · Recent · My files · Collections · Saved views) · Knowledge bases
│                        └── Collection · Knowledge base (Resources · Sources · Access · Settings) · Reader (Ask · About · Related)
├── Conversations
├── Search (⌘K palette → full results page)
├── Spaces* ──────────── Space: Overview · Materials · Work · Questions/Requests · People · Settings
├── Manage (admins)
│   ├── Overview
│   ├── Sources ──────── Sources · Sync history
│   ├── Connections
│   ├── Knowledge health ─ Review · Details · Duplicates · Topics (knowledge managers see their own bases)
│   ├── People ───────── Members · Groups · Roles · Requests
│   ├── Assistant
│   ├── Activity ─────── Changes · Sign-ins
│   └── Settings ─────── General · Workspace setup · Danger zone
└── Recent conversations (when Spaces is off)

Platform console (operators): Workspaces · Users · Connectors · Usage · Audit log · System health
Prototype only: Design system (#/design)
```

Earlier changes: Inbox is a page (was a drawer); Connections left the Sources tabs; People & access is **People**; Assistant setup's two tabs are one form; workspace accent theming was removed (the background stays a personal choice); AI capabilities moved into System health; the review index, page-audit panel and lifecycle rails were removed. The Knowledge Hub replaced the knowledge-base card grid, the flat Documents page (`/documents` now redirects to Browse) and the old document viewer.

Campus journeys (rule → request, study loop, ask the teaching team, assessment, evidence → draft, office queue) are in [CAMPUS_WORKSPACE.md](CAMPUS_WORKSPACE.md). The journeys below are the Enterprise ones; all of them also work in UTE Campus.

## Journeys

### 1. Sign in and ask
Sign in (email or username + password, or Google) → choose a workspace when you belong to several → New chat → type or pick a starter → optionally narrow the scope to specific knowledge bases → the answer streams with work steps, inline citations and source chips → follow up in the same thread. A new conversation appears at the top of Recent.

### 2. Verify an answer
Citation marker or source chip → side panel with the exact passage, document, knowledge base and page, previous/next citation, copy → Open document → the viewer scrolls to and highlights the passage, steps through matches, and links back to the conversation.

### 3. Work with files in a conversation
Attach files (validated: ≤ 5, ≤ 100 MB, blocked types refused) or add from knowledge → ask for a spreadsheet or a draft → the answer includes a file card → the file panel shows Preview, Changes and History → edit in place or ask for changes (each is a new version) → restore any version → download (CSV, Word, PDF, Markdown).

### 4. Find, read and keep knowledge
Knowledge → Discover (search, type shortcuts, recent, from your spaces, topics, collections) → Browse: combine topic, space, type, owner, source, base, trust, updated, format and language; counts update as you filter; save the view → preview → Reader: read with the outline, *Ask* about the document in place (answers cite passages that highlight on the page), check *About* (source path, trust, versions, who can see it) and *Related* → Save, Add to collection, or *Use in…* a workflow. Everything lands in My library. Restricted bases stay visible only as bases → Request access (role + reason) → Pending → the admin approves from Inbox, Overview or People.

### 5. Curate and keep knowledge healthy
Collections: create from any resource or the library, order and annotate items, share with a space you run or (admins) everyone, add resources from the catalog; viewers who can't open an item see only a count. Resource owners edit details (type, topics, owner, language, summary), link resources to further spaces and mark them verified. Knowledge health (Manage) shows what's due for review or changed at the source, what's missing details, likely duplicates (keep one, archive the other, references follow) and the topic taxonomy.

### 6. Add documents
Create knowledge base (name validated for duplicates) → Add files (drop, browse or samples) → files upload into the inventory as **Waiting** → **Process now** runs processing → Processing → Ready, or Failed with the reason and a fix (Replace file, Reprocess) in the document drawer → bulk reprocess, move or archive with Undo. Index status is shown only to the base's editors; readers see trust.

### 7. Connect and maintain a source
Sources → Connect source (App → Account → Content → Destination + schedule) → the first sync registers documents as **Waiting** → Process (one alert per page, or in the source drawer) → scheduled syncs sync and process what changed automatically → failures surface as one alert with the fix (Reconnect an expired account, Sync now, Retry failed) → Connections manages the accounts (reconnect, test, disconnect).

Sync and processing are distinct, as in `backend/docs_design` (a sync changes only the inventory; an ingestion run processes; a schedule means "sync, then process what changed").

### 8. Govern people and access
People → Add people (multi-email with per-address validation, role, groups) → change roles inline or in bulk with Undo → member drawer for role, groups and effective knowledge access → Groups and Roles (plain-language permissions; built-in roles read-only) → Requests approve/deny. Guards: you cannot change your own role, suspend yourself, or remove the last admin.

### 9. Shape the assistant
Assistant → instructions, answer style, capabilities, welcome message and up to three starters → the live preview shows the chat home and a sample answer → Publish (inline validation; unsaved-changes bar with Discard) → members see the new chat home.

### 10. Run the workspace
Overview lists what needs attention, each with its fix; KPIs link to their pages; knowledge gaps lead to Add files. Activity investigates changes and sign-ins with filters, a detail drawer and CSV export. Settings edits the name and address (with a broken-links warning) and requests archive with typed confirmation.

### 11. Operate the platform
Workspaces (create with first admin → Setting up → Active; suspend/reactivate; open) · Users (memberships, platform admin, suspend) · Connectors (configure, enable/disable, demand) · Usage (range, per-workspace share, export) · Audit log (filters, drawer, export) · System health (service status, AI capabilities and their deployment settings, incidents).

## Onboarding

First-run product tour (account menu → Product tour, or Journeys): four anchored steps — composer, scope, starters, search. Escape or Skip ends it. Starters come from the workspace's published assistant settings.

## Search

- ⌘K / sidebar search icon: Ask, chats, resources (catalog ranking), Browse for the query, collections, knowledge bases, people (admins), spaces, work, pages and actions; "See all results" opens `/search`.
- `/search?q=` groups resources (catalog search with snippets, *See all in Browse*), knowledge bases, collections, conversations and people with tab counts, plus an Ask card.
- Knowledge → Browse is the knowledge finder: accent-insensitive (Vietnamese titles match unaccented queries), stop words ignored, metadata outweighs body text, verified resources rank slightly higher.
- In-page search fields filter the table or list they sit above.

## States

Every app screen supports Live, Loading (skeleton), Empty (first use with its first action) and Error (retry) — forced from the prototype bar. Filtered collections have a no-results state with Clear. Unpermitted routes render a no-access state without revealing data. Mutations change data first, then toast; long-running work (sync, processing, streaming, provisioning) shows live progress.

## Responsive

Below 1024 px the sidebar becomes an off-canvas sheet and side panels overlay; below 760 px tables become card rows; below 680 px dialogs become bottom sheets and drawers full-height sheets. The prototype bar previews 834 px and 390 px using the same rules.
