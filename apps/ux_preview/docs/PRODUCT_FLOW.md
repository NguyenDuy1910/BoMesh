# BoMesh product flow

## Product

BoMesh is a context-aware AI workspace: people get answers they can trust from their organisation's own knowledge, then finish the work that follows — with permissions and citations throughout. Administrators keep knowledge connected and governed; platform operators run the deployment.

One platform serves different domains through **workspace templates**. A template switches optional **modules** on (Spaces, Work, Requests), defines the **space types** people organise around and the **AI workflows** offered. Admins can override modules, space types and workflows per workspace (Settings → Workspace setup). Home, Knowledge, Inbox and Conversations are core in every template; Home is the knowledge-first landing ([HOME.md](HOME.md)) and the **Knowledge Hub** is the same everywhere ([KNOWLEDGE_HUB.md](KNOWLEDGE_HUB.md)). The Campus template (courses, research groups, offices) is available on the platform but has no demo workspace. The prototype ships two workspaces:

| Workspace | Template | What it shows |
| --- | --- | --- |
| Northwind Group (+ Northwind Finance, sharing its demo data) | Enterprise | Ask company knowledge, govern sources and access |
| Finx Workspace | Enterprise, with Spaces (team, project, office), Work (review, draft) and Requests on | A digital-banking and payments company: engineering, data, operations and compliance knowledge, office requests with policy checks — see [FINX_WORKSPACE.md](FINX_WORKSPACE.md) |

Trust contract made visible in the UX:

1. Retrieval happens inside the active workspace.
2. Resource permissions apply before evidence reaches the assistant — an answer that would rely on unreadable knowledge says so instead.
3. Every grounded claim links to a citation, the passage and the whole document.
4. Source lineage, processing state and audit history stay visible to authorized people.
5. Workspace administration and platform operation are separate permission scopes.

All behavior is local mock data; nothing reaches a backend.

## Personas

| Persona | Job | Lands on | Permission boundary |
| --- | --- | --- | --- |
| Member (Northwind member, Finx Engineer Trần Minh Khoa) | Ask, verify, find and read knowledge; contribute; send requests | Home | Effective knowledge-base access + space role; can request access to discoverable restricted knowledge |
| Reviewer (Finx Lead Lê Thu Hà, Analyst Phạm Quốc Bảo) | Do the work above; review contributions to the bases they own; run reviews and drafts | Home | `knowledge.manage` on owned bases + space role (e.g. lead of a team) |
| Workspace admin (Northwind admin, Finx Admin Võ Thị Lan) | Keep knowledge useful, connected and governed; feature knowledge on Home; run office queues | Home | Workspace permissions (`tenant.manage`, `source.manage`, `user.manage`, `audit.read`, …) and per-knowledge-base roles |
| Platform operator | Operate workspaces, accounts, connectors and service health | Platform console | `platform.*` permissions only; workspace data still requires membership |

## Principles

- **Knowledge first, then finish the work.** Every workspace lands on Home: search or ask, explore topics, bases and collections, featured and recent knowledge, and where you left off. Answers suggest the next step (start a request, draft a document, compare options).
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
├── Home ────────────── Search/ask (scope, suggested questions) · Explore knowledge · Featured · Recently published · Recommended · Pick up where you left off
├── Chat (/chat) ──────── Conversation ── Citation panel · File panel · Share
├── Inbox
├── Work* ────────────── New (workflow → materials → options) · Evidence review · Draft (Campus template adds study guide and quizzes)
├── Requests* ────────── My requests · Queue · New (catalog → rule check → form) · Request thread
├── Knowledge ────────── Browse (catalog, /knowledge) · My library (Saved · Recent · Contributions · My files · Collections · Saved views) · Knowledge bases · Contribute
│                        └── Collection · Knowledge base (Resources · Sources · Access · Settings) · Reader (Ask · About · Related)
├── Conversations
├── Search (⌘K palette → full results page)
├── Spaces* ──────────── Space: Overview · Materials · Work · Questions/Requests · People · Settings
├── Manage (admins)
│   ├── Overview
│   ├── Sources ──────── Sources · Sync history
│   ├── Connections
│   ├── Documents ─────── Review · All documents · Quality · Topics (reviewers see the bases they own; admins all)
│   ├── People ───────── Members · Groups · Roles · Requests
│   ├── Assistant
│   ├── Activity ─────── Changes · Sign-ins
│   └── Settings ─────── General · Workspace setup · Danger zone
└── Recent conversations (when Spaces is off)

Platform console (operators): Workspaces · Users · Connectors · Usage · Audit log · System health
Prototype only: Design system (#/design)
```

Earlier changes: Inbox is a page (was a drawer); Connections left the Sources tabs; People & access is **People**; Assistant setup's two tabs are one form; workspace accent theming was removed (the background stays a personal choice); AI capabilities moved into System health; the review index, page-audit panel and lifecycle rails were removed. The Knowledge Hub replaced the knowledge-base card grid and the old document viewer. Uploading no longer publishes: contributions go through review (Manage → Documents, which replaced Knowledge health and the per-base document inventory) — see [DOCUMENT_LIFECYCLE.md](DOCUMENT_LIFECYCLE.md). Home became the core landing for every workspace (replacing New chat as Enterprise's first item) and absorbed the Knowledge landing tab; `/knowledge` opens Browse and `/knowledge/browse` redirects there.

Finx journeys (policy → request, evidence review, decision draft, office queue) are in [FINX_WORKSPACE.md](FINX_WORKSPACE.md); Home in [HOME.md](HOME.md). The journeys below work in both workspaces.

## Journeys

### 1. Sign in and ask
Sign in (email or username + password, or Google) → choose a workspace when you belong to several → Home → type in the hero and *Ask* (optionally narrowing the scope) or pick a suggested question, or start a chat from ⌘K → the answer streams with work steps, inline citations and source chips → follow up in the same thread. A new conversation appears in Conversations and under *Pick up where you left off*.

### 2. Verify an answer
Citation marker or source chip → side panel with the exact passage, document, knowledge base and page, previous/next citation, copy → Open document → the viewer scrolls to and highlights the passage, steps through matches, and links back to the conversation.

### 3. Work with files in a conversation
Attach files (validated: ≤ 5, ≤ 100 MB, blocked types refused) or add from knowledge → ask for a spreadsheet or a draft → the answer includes a file card → the file panel shows Preview, Changes and History → edit in place or ask for changes (each is a new version) → restore any version → download (CSV, Word, PDF, Markdown).

### 4. Find, read and keep knowledge
Home (search → Browse; topic card → Browse filtered by that topic; featured, recently published or recommended document → Reader) or Knowledge → Browse: combine topic, space, type, owner, source, base, trust, updated, format and language; counts update as you filter; save the view → preview → Reader: read with the outline, *Ask* about the document in place (answers cite passages that highlight on the page), check *About* (source path, trust, versions, who can see it) and *Related* → Save, Add to collection, or *Use in…* a workflow. Everything lands in My library. Restricted bases stay visible only as bases → Request access (role + reason) → Pending → the admin approves from Inbox, Overview or People.

### 5. Curate and keep knowledge healthy
Collections: create from any resource or the library, order and annotate items, share with a space you run or (admins) everyone, add resources from the catalog; viewers who can't open an item see only a count. Admins choose *Feature on Home* from a document's ⋯ menu (or Manage on Home's Featured section). Resource owners edit details (type, topics, owner, language, summary), link resources to further spaces and mark them verified. Manage → Documents → Quality shows what's due for re-verification or changed at the source, what's missing details and likely duplicates (keep one, archive the other, references follow); Topics manages the taxonomy and the assistant's proposed topics.

### 6. Contribute, review and publish
Knowledge → **Contribute** → drop files → *Share as knowledge* (or *Keep private in My files*) → knowledge base "Let the assistant suggest" or a chosen one → optional note → Submit. The submission is **In review**, visible only to the contributor and that base's reviewers. The reviewer opens Manage → Documents → **Review**: preview, the assistant's type/topic/base/summary suggestions with confidence, flags (duplicate, new version, personal data) → *Approve & publish*, *Request changes* or *Decline*. Approval publishes: Publishing → Published, and only then is it searchable and used by the assistant. The contributor follows it in My library → **Contributions** and the Inbox, revises when asked, and can submit new versions later. Synced files follow their source's policy (publish automatically or send to review). Full journeys: [DOCUMENT_LIFECYCLE.md](DOCUMENT_LIFECYCLE.md).

### 7. Connect and maintain a source
Sources → Connect source (App → Account → Content → Destination, schedule and **publishing policy**) → the first sync registers documents. With *Publish automatically* (trusted systems) they wait to publish → *Publish all waiting* (one alert per page, or in the source drawer); scheduled syncs sync and publish what changed. With *Send to review first* (untrusted feeds such as a public website) new and changed files enter the review queue, and a changed published file becomes a new-version submission while the current one keeps answering. Failures surface as one alert with the fix (Reconnect an expired account, Sync now, Retry failed) → Connections manages the accounts (reconnect, test, disconnect).

Sync and processing are distinct, as in `backend/docs_design` (a sync changes only the inventory; an ingestion run processes; a schedule means "sync, then process what changed").

### 8. Govern people and access
People → Add people (multi-email with per-address validation, role, groups) → change roles inline or in bulk with Undo → member drawer for role, groups and effective knowledge access → Groups and Roles (plain-language permissions; built-in roles read-only) → Requests approve/deny. Guards: you cannot change your own role, suspend yourself, or remove the last admin.

### 9. Shape the assistant
Assistant → instructions, answer style, capabilities, welcome message and up to three starters → the live preview shows the chat home and a sample answer → Publish (inline validation; unsaved-changes bar with Discard) → members see the new chat home.

### 10. Run the workspace
Overview lists what needs attention, each with its fix (documents waiting for review, documents that couldn't be published, syncs, access requests); KPIs link to their pages; knowledge gaps lead to Contribute. Activity investigates changes and sign-ins with filters, a detail drawer and CSV export. Settings edits the name and address (with a broken-links warning) and requests archive with typed confirmation.

### 11. Operate the platform
Workspaces (create with first admin → Setting up → Active; suspend/reactivate; open) · Users (memberships, platform admin, suspend) · Connectors (configure, enable/disable, demand) · **Indexing** (per-workspace queue, throughput, failure rate and status; pause/resume; retry failed jobs by workspace or error class; recent jobs; platform policies — job metadata only, never document names or content) · Usage (range, per-workspace share, export) · Audit log (filters, drawer, export) · System health (service status, AI capabilities and their deployment settings, incidents, link to Indexing).

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
