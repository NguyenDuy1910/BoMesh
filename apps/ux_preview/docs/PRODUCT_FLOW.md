# BoMesh product flow

## Product

BoMesh is a context-aware AI workspace: people get answers they can trust from their organisation's own knowledge, then finish the work that follows — with permissions and citations throughout. Administrators keep knowledge connected and governed; platform operators run the deployment.

One platform serves different domains through **workspace templates**. A template switches optional **modules** on (Spaces, Work, Requests), defines the **space types** people organise around and the **AI workflows** offered. Admins can override modules, space types and workflows per workspace (Settings → Workspace setup). Home, Knowledge and Projects are core in every template: **Home helps people start** ([HOME.md](HOME.md)), **Knowledge helps them discover** ([KNOWLEDGE_HUB.md](KNOWLEDGE_HUB.md)) and **Projects help them organise and continue** AI work (below). The Campus template (courses, research groups, offices) is available on the platform but has no demo workspace. The prototype ships two workspaces:

| Workspace | Template | What it shows |
| --- | --- | --- |
| Northwind Group (+ Northwind Finance, sharing its demo data) | Enterprise | Ask company knowledge, govern sources and access |
| Finx Workspace | Enterprise, with Spaces (team, project, office), Work (evidence review, draft) and Requests on | A digital-banking and payments company: engineering, data, operations and compliance knowledge, office requests with policy checks — see [FINX_WORKSPACE.md](FINX_WORKSPACE.md) |

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
| Reviewer (Finx Lead Lê Thu Hà, Analyst Phạm Quốc Bảo) | Do the work above; review contributions to the bases they own; run evidence reviews and drafts; review teammates' drafts | Home | Owner role on owned bases + space role (e.g. lead of a team) |
| Workspace admin (Northwind admin, Finx Admin Võ Thị Lan) | Keep knowledge useful, connected and governed; feature knowledge on Home; run office queues | Home | Workspace permissions (`tenant.manage`, `source.manage`, `user.manage`, `audit.read`, …) and per-knowledge-base roles |
| Platform operator | Operate workspaces, accounts, connectors and service health | Platform console | `platform.*` permissions only; workspace data still requires membership |

## Principles

- **Knowledge first, then finish the work.** Every workspace lands on Home: search documents or ask AI, explore topics, what's waiting for you, what you were reading and featured knowledge. Answers suggest the next step (start a request, draft a document, compare options).
- **Evidence in one click.** Citation marker → document preview at the highlighted passage → full document.
- **Fix it where you see it.** Every alert and inbox item carries its fix, or links to the one place the fix lives.
- **One shell.** One permission-aware sidebar for every persona; the Manage group and platform console appear only when permitted. Search (⌘K) and the Inbox bell sit in the topbar.
- **One primary action per region.** Everything else is secondary, in a row menu, or in a drawer. Whole rows open their object.
- **Recoverable by default.** Reversible changes apply at once with Undo; only irreversible or high-risk actions confirm (typed confirmation only for workspace archive).
- **Honest proposals.** Pages without a backend contract carry one `Preview` chip.

The full action system and vocabulary are in [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md#rules).

## Information architecture

```text
Sign in · Create account · Choose workspace

Topbar ──────────────── breadcrumbs (depth ≥ 2) · page actions · Search (⌘K) · Inbox bell
Workspace (sidebar; items marked * appear when the module is on)
├── Home ────────────── Search documents / Ask AI (one box, scope, suggestions) · Waiting for you · Continue reading · Worth knowing · Start here / Recommended · Explore by topic
├── Knowledge ────────── Browse (the organization's knowledge, /knowledge; inline filters, Views, Shared with you) · My library (Saved · Recent · Contributions · My files · My collections) · Contribute
│                        └── Collection · Document preview · Reader (Ask · About · Related)
├── Work* ────────────── New (workflow → materials → options) · Evidence review · Draft (Draft → In review → Approved / Changes requested; Campus template adds study guide and quizzes)
├── Requests* ────────── My requests · Queue (Open / Closed) · New (service catalog → rule check → form) · Request thread
├── New chat ─────────── /chat (scope "Search in", attach, starters)
├── Projects ─────────── + New project · project rows (link to the project; chevron → its conversations) · ⋯ Rename · Delete
│                        └── Project (/project/:id): composer with Project documents · Conversations
├── Recent ───────────── conversations in no project (⋯ Rename · Move to project · Delete conversation) · All → /chats
├── Spaces* ──────────── Space: Overview · Materials · Work · Questions/Requests · People · ⚙ Settings (own page)
└── Manage (admins; owners and editors of a base see Knowledge bases)
    ├── Overview
    ├── Sources ──────── Sources · Sync history
    ├── Connections
    ├── Documents ─────── Review · All documents · Quality · Topics (admins) (reviewers see the bases they own; admins all)
    ├── Knowledge bases ─ the bases you own or edit · Create · Base: Access · Sources · Settings
    ├── People ───────── Members · Groups · Roles · Requests
    ├── Assistant
    ├── Activity ─────── Changes · Sign-ins
    └── Settings ─────── General (Advanced: workspace ID, Request archive) · Workspace setup

Not in the sidebar: Conversation (/chat/:id) · All conversations (/chats) · Inbox (/inbox, topbar bell) · Search results (/search)

Platform console (operators): Workspaces · Users · Connectors · Indexing · Usage · Audit log · System health
Prototype only: Design system (#/design)
```

Earlier changes: Inbox is a page (was a drawer); Connections left the Sources tabs; People & access is **People**; Assistant setup's two tabs are one form; workspace accent theming was removed (the background stays a personal choice); AI capabilities moved into System health; the review index, page-audit panel and lifecycle rails were removed. The Knowledge Hub replaced the knowledge-base card grid and the old document viewer. Uploading no longer publishes: contributions go through review (Manage → Documents, which replaced Knowledge health and the per-base document inventory) — see [DOCUMENT_LIFECYCLE.md](DOCUMENT_LIFECYCLE.md). Home became the core landing for every workspace (replacing New chat as Enterprise's first item) and absorbed the Knowledge landing tab; `/knowledge` opens Browse and `/knowledge/browse` redirects there.

Finx journeys (policy → request, evidence review, decision draft, office queue) are in [FINX_WORKSPACE.md](FINX_WORKSPACE.md); Home in [HOME.md](HOME.md). The journeys below work in both workspaces.

## Journeys

### 1. Sign in and ask
Sign in (email or username + password, or Google) → choose a workspace when you belong to several → Home → type in the box and *Ask AI* (it ranks first when the text reads like a question; optionally narrow the scope) or pick a suggested question, or start from **New chat** in the sidebar → the answer streams with work steps, inline citations and source chips → follow up in the same thread. A new conversation appears in the sidebar's **Recent**; file it into a project from its ⋯ menu when it belongs to ongoing work.

### 1b. Organise AI work in projects
Sidebar → **Projects +** → name only → the project opens: one composer (*New chat in …*) with the **Project documents** pre-attached as removable chips (added from Knowledge, up to 10; never copied, access rules still apply; removing a chip leaves it out of that conversation only) and its **Conversations**. A project row links to its page; its chevron expands its conversations in the sidebar. ⋯ renames or deletes a project (its conversations move back to Recent, Undo restores). Any conversation's ⋯ (sidebar, thread topbar, All conversations) moves it to a project, to a new project, or back to Recent. A conversation appears once: in its project or in Recent. Starting from Home never asks for a project.

*Backend alignment:* projects are prototype-only. The API has no project resource and conversations carry no project; production needs a contract change (`openapi.yaml` + `api_design.md`) before clients build it.

### 2. Verify an answer
Citation marker or source chip → the document preview opens at the cited passage (highlighted, "Passage n of m" steps through the answer's citations, across documents) → *Open full document* → the Reader keeps the highlight and links back to the conversation. A locked document shows only the cited quote and *Request access*.

### 3. Work with files in a conversation
Attach files (validated: ≤ 5, ≤ 100 MB, blocked types refused) or add from knowledge → ask for a spreadsheet or a draft → the answer includes a file card → the file panel shows Preview (and Changes and History from version 2) → edit in place, or ask for changes in the thread composer while the "Editing {file}" chip is on (each is a new version) → restore any version (Undo) → download in the native format first (.xlsx/.docx, then CSV, PDF, Markdown).

### 4. Find, read and keep knowledge
Home (type in the box → *Search documents* opens Knowledge with the query, *Ask AI* starts a cited answer, a suggested document opens the preview; a topic shortcut → Knowledge filtered by that topic; Worth knowing or a recommended document → preview; Continue reading → Reader) or Knowledge → Browse: pick a topic pill or a collection shared with you, or combine the inline filters (Type, Updated, Trust, Owner, More filters for space, source, base, format and language); save the view from *Views* → a card or row opens the preview → *Open full document* → Reader: read with the outline, *Ask* about the document in place (answers cite passages that highlight on the page), check *About* (source path, trust, versions, who can see it) and *Related* → Save, Add to collection, or *Use in…* a workflow. Saved, recent and your collections land in My library. Restricted bases stay visible only as bases (*Some knowledge bases aren't shared with you*, or a base filter) → Request access (Viewer or Editor + reason) → Pending → an owner approves in Manage → Knowledge bases → Access, or a workspace admin in People → Requests (Inbox and Overview link there).

### 5. Curate and keep knowledge healthy
Collections: create from any resource or the library, then *Edit* to order and annotate items (autosaved with Undo), share with a space you run or (admins) everyone, and add resources from the catalog; the view numbers the reading order and marks what you've read; viewers who can't open an item see only a count. Admins choose *Feature on Home* from a document's ⋯ menu or manage them in Home's Featured documents drawer (featured documents lead *Start here* and feed *Recommended for you*). Resource owners edit details (title, type, topics, owner, language, summary), link resources to further spaces and mark them verified. Manage → Documents → Quality shows what's due for re-verification, what's missing details and likely duplicates (keep one, archive the other, references follow); documents changed at the source are fixed in All documents (*Publish update*); Topics (workspace admins) manages the taxonomy and decides the assistant's proposed topics.

### 6. Contribute, review and publish
Knowledge → **Contribute** → choose *Contribute to a knowledge base* (or *Upload to My files*) → drop files → knowledge base "Let the assistant suggest" or a chosen one → title and description → Submit. The submission is **In review**, visible only to the contributor and that base's reviewers. The reviewer opens Manage → Documents → **Review**: preview, the assistant's type/topic/base/summary suggestions with confidence, flags (Possible duplicate, new version, Personal data) → *Approve & publish*, *Request changes* or *Decline*. Approval publishes: Publishing → Published, and only then is it searchable and used by the assistant. A suggested new topic never holds publishing back. The contributor follows it in My library → **Contributions** and the Inbox, revises when asked, sees **Declined** with the reviewer's reason otherwise, and can submit new versions later. Synced files follow their source's policy (publish automatically or send to review). Full journeys: [DOCUMENT_LIFECYCLE.md](DOCUMENT_LIFECYCLE.md).

### 7. Connect and maintain a source
Sources → Connect source (App → Account, skipped when there is exactly one → Content → Destination, schedule and **publishing policy**) → the first sync registers documents. With *Publish automatically* (trusted systems) every sync — first, scheduled or manual — publishes what it found. With *Send to review first* (untrusted feeds such as a public website) new and changed files enter the review queue, and a changed published file becomes a new-version submission while the current one keeps answering. Partial syncs show *Synced with issues* with the files that couldn't be read. Failures surface as one alert with the fix (Sync now, Retry failed); an expired account links to **Connections**, the one place it is reconnected (also test, disconnect).

Sync and processing are distinct, as in `backend/docs_design` (a sync changes only the inventory; an ingestion run processes; a schedule means "sync, then process what changed").

### 8. Govern people and access
People → Add people (multi-email with per-address validation; unknown addresses get an email invite, Resend / Revoke) → change roles inline or in bulk with Undo → member drawer for role, groups and effective knowledge access (changes apply at once with Undo) → Groups (membership instant; name and description in an Edit details dialog) and Roles (plain-language permissions as instant switches; built-in roles read-only with *Duplicate to customise*) → Requests approve/deny (Viewer / Editor / Owner). Suspend is instant with Undo; removing a member confirms. Guards: you cannot change your own role, suspend yourself, or remove the last admin.

### 9. Shape the assistant
Assistant → instructions, answer style, capabilities, welcome message and starters for Everyone, plus own starters for a role or group (resolved group → role → Everyone) → the live preview shows the chat home and a sample answer (a Preview button below 1024 px) → Publish (inline validation; unsaved-changes bar with Discard) → members see the new chat home.

### 10. Run the workspace
Overview lists what needs attention, one item per problem with a task verb linking to where it is fixed (review submissions, fix publishing, publish updates, reconnect, open requests); KPIs link to their pages; knowledge gaps lead to Contribute. Activity investigates changes and sign-ins with filters, a detail drawer with a link to the related object, and CSV export. Settings edits the name and address (with a broken-links warning); General › Advanced holds *Request archive* (typed confirmation; cancellable until an operator acts).

### 11. Operate the platform
Workspaces (create with first admin → Setting up → Active; suspend/reactivate with Undo; archive requests: *Archive workspace* with typed confirmation or *Decline request* with a reason; *Restore workspace* within 30 days) · Users (memberships, platform admin, suspend) · Connectors (each card opens a drawer with *Available to workspaces*; demand) · **Indexing** (Workspaces · Jobs · Policies: per-workspace queue, throughput, failure rate and status; pause/resume; retry failed jobs; job drawer — job metadata only, never document names or content) · Usage (range, one-line summary, per-workspace share, export) · Audit log (platform-level events only; filters, drawer, export) · System health (service status, AI capabilities and their deployment settings, incidents, link to Indexing).

## Onboarding

First-run product tour on Home: starts once per person and workspace (and from the account menu → Help → Product tour, or Journeys) — the box, its scope, the first section, New chat and Search. One *Skip tour* control; a bottom sheet on phones. Starters come from the workspace's published assistant settings.

## Search

- Two words everywhere: **Search documents** (find) and **Ask AI** (cited answer). In the Home box and ⌘K, Ask AI ranks first only when the text reads like a question.
- ⌘K (topbar Search): best-match pages and actions, then Search documents / Ask AI, conversations, documents, Browse for the query, collections, knowledge bases, people (admins), spaces, work and actions; "See all results" opens `/search`.
- `/search?q=` is an overview: the top results per type (documents, knowledge bases, collections, conversations, people) with "See all"; the full document set opens in Knowledge → Browse.
- Knowledge → Browse is the knowledge finder: accent-insensitive (Vietnamese titles match unaccented queries), stop words ignored, metadata outweighs body text, verified resources rank slightly higher.
- In-page search fields filter the table or list they sit above.

## States

Every app screen supports Live, Loading (skeleton), Empty (first use with its first action) and Error (retry) — forced from the prototype bar. Filtered collections have a no-results state with Clear. Unpermitted routes render a no-access state without revealing data. Mutations change data first, then toast; long-running work (sync, processing, streaming, provisioning) shows live progress.

## Responsive

Below 1024 px the sidebar becomes an off-canvas sheet and side panels overlay; below 760 px tables become card rows; below 680 px dialogs and popovers become bottom sheets, drawers full-height sheets, and toolbars fold into one Filters button. The prototype bar previews 834 px and 390 px using the same rules.
