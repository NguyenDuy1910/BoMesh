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

- **Knowledge first, then finish the work.** Every workspace lands on Home (Discover & Start): what the workspace holds, one click into finding (Knowledge), asking (AI Chat) or contributing, what needs you, what you were reading, what changed and a map of topics. Answers suggest the next step (start a request, draft a document, compare options).
- **Evidence in one click.** Citation marker → document preview at the highlighted passage → full document.
- **Fix it where you see it.** Every alert and inbox item carries its fix, or links to the one place the fix lives.
- **One shell.** One permission-aware sidebar for every persona, in three groups — **Workspace** (places), **Your work** (what you touched, organised and submitted) and **Manage** (only with a manage permission). Every row has one responsibility; the sidebar lists no conversations or projects inline (they live on AI Chat, Recent and Projects). Search (⌘K) opens from the sidebar's search row; the Inbox bell sits in the top row (CompactHeader), which also carries the page's trail, title and actions; on desktop the sidebar collapses to an icon rail. Anatomy: [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md#layout--styleslayoutcss).
- **One primary action per region.** Everything else is secondary, in a row menu, or in a drawer. Whole rows open their object.
- **Recoverable by default.** Reversible changes apply at once with Undo; only irreversible or high-risk actions confirm (typed confirmation only for workspace archive).
- **Honest proposals.** Pages without a backend contract carry one `Preview` chip.

The full action system and vocabulary are in [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md#rules).

## Information architecture

```text
Sign in · Create account · Choose workspace

CompactHeader ───────── menu (off-canvas only) · parent trail · title · chip · status │ page actions · Search icon (off-canvas only) · Inbox bell
Sidebar ─────────────── workspace switcher + toggle (desktop icon rail) · Search anything… (⌘K) · three groups (items marked * appear when the module is on) · account footer
WORKSPACE
├── Home ────────────── Intent cards (Find a document · Ask a question · Contribute knowledge) · Needs your attention · Continue reading · What's new · Explore knowledge · Start here / Recommended
├── Knowledge ────────── Browse (the organization's knowledge, /knowledge; inline filters, Views, Shared with you) · My library (Saved · My files · My collections) · Contribute
│                        └── Collection · Document preview · Reader (Ask · About · Related)
├── AI Chat ──────────── /chat: composer (scope "Search in", attach, starters before your first conversation) above the Conversations list (search and Project filter at 7+)
│                        └── Conversation (/chat/:id)
├── Work* ────────────── New (workflow → materials → options) · Evidence review · Draft (Draft → In review → Approved / Changes requested; Campus template adds study guide and quizzes)
└── Requests* ────────── My requests · Queue (Open / Closed) · New (service catalog → rule check → form) · Request thread
YOUR WORK (collapsible)
├── Recent ───────────── /recent: documents, conversations and work you touched — Today · This week · Earlier; filter All · Documents · Conversations · Work
├── Projects ─────────── /projects: your project folders (New project, ⋯ Rename · Delete with Undo)
│                        └── Project (/project/:id): composer with Project documents · Conversations
├── Spaces* ──────────── Space: Overview · Materials · Work · Questions/Requests · People · ⚙ Settings (own page)
└── My contributions ─── /contributions: what you submitted and where it is (filters, drawer with stepper, Revise)
MANAGE (with a manage permission; owners and editors of a base see Knowledge Studio; collapsible)
├── Overview ─────────── setup guide (while setup is unfinished) · Needs attention · Knowledge health · KPIs · knowledge gaps
├── Knowledge Studio ─── Review · Library │ Knowledge bases · Taxonomy · Sources (Sources · Sync history · Accounts)
│                        └── Knowledge base (/studio/bases/:id): Access · Sources · Settings
├── People ───────────── Members · Groups · Roles · Requests
├── Assistant
├── Activity ─────────── Changes · Sign-ins
└── Settings ─────────── General (Advanced: workspace ID, Request archive) · Workspace setup

Not in the sidebar: Inbox (/inbox, top-row bell) · Search results (/search)

Platform console (operators): Workspaces · Users · Connectors · Indexing · Usage · Audit log · System health
Prototype only: Design system (#/design)
```

Earlier changes: Inbox is a page (was a drawer); Knowledge bases, Sources and Connections folded into **Knowledge Studio** as its setup tabs (accounts are a view of Sources; `/sources`, `/connections`, `/bases` and `/bases/:id` redirect — see [KNOWLEDGE_STUDIO.md](KNOWLEDGE_STUDIO.md)); People & access is **People**; Assistant setup's two tabs are one form; workspace accent theming was removed (the background stays a personal choice); AI capabilities moved into System health; the review index, page-audit panel and lifecycle rails were removed. The Knowledge Hub replaced the knowledge-base card grid and the old document viewer. Uploading no longer publishes: contributions go through review in **Knowledge Studio** (which replaced Manage › Documents, itself the successor of Knowledge health and the per-base document inventory; `/documents` redirects to `/studio`) — see [DOCUMENT_LIFECYCLE.md](DOCUMENT_LIFECYCLE.md). Home became the core landing for every workspace and absorbed the Knowledge landing tab; `/knowledge` opens Browse and `/knowledge/browse` redirects there.

Sidebar redesign: the sidebar's former New chat row, inline Projects tree and inline Recent conversations, and the All conversations page (`/chats`) became **AI Chat** (`/chat`, composer + conversation list), **Recent** and **Projects** pages; My library's Recent and Contributions tabs became **Your work → Recent** and **My contributions**; Knowledge Studio's Documents tab is **Library**, Master data is **Taxonomy**, and the Quality tab folded into **Review** queues (metrics on Overview → Knowledge health). Every old address redirects ([SCREEN_INVENTORY.md](SCREEN_INVENTORY.md#redirects)).

Finx journeys (policy → request, evidence review, decision draft, office queue) are in [FINX_WORKSPACE.md](FINX_WORKSPACE.md); Home in [HOME.md](HOME.md). The journeys below work in both workspaces.

## Journeys

### 1. Sign in and ask
Sign in (email or username + password, or Google) → choose a workspace when you belong to several → Home → *Ask a question* (or **AI Chat** in the sidebar, or *Ask AI* in ⌘K) → type the question or pick a starter, optionally narrow the scope → the answer streams with work steps, inline citations and source chips → follow up in the same thread. The conversation appears at the top of AI Chat's **Conversations** list and in **Recent**; file it into a project from its ⋯ menu when it belongs to ongoing work.

### 1b. Organise AI work in projects
Your work → **Projects** → *New project* → name only → the project opens (trail Projects › name): one composer (*New chat in …*) with the **Project documents** pre-attached as removable chips (added from Knowledge, up to 10; never copied, access rules still apply; removing a chip leaves it out of that conversation only) and its **Conversations**. ⋯ renames or deletes a project (Undo restores; its conversations stay in AI Chat). Any conversation's ⋯ (AI Chat list, thread top row) moves it to a project, to a new project, or out of one. Project threads read Projects › project › title; other threads AI Chat › title. Starting from Home never asks for a project.

*Backend alignment:* projects are prototype-only. The API has no project resource and conversations carry no project; production needs a contract change (`openapi.yaml` + `api_design.md`) before clients build it.

### 2. Verify an answer
Citation marker or source chip → the document preview opens at the cited passage (highlighted, "Passage n of m" steps through the answer's citations, across documents) → *Open full document* → the Reader keeps the highlight and links back to the conversation. A locked document shows only the cited quote and *Request access*.

### 3. Work with files in a conversation
Attach files (validated: ≤ 5, ≤ 100 MB, blocked types refused) or add from knowledge → ask for a spreadsheet or a draft → the answer includes a file card → the file panel shows Preview (and Changes and History from version 2) → edit in place, or ask for changes in the thread composer while the "Editing {file}" chip is on (each is a new version) → restore any version (Undo) → download in the native format first (.xlsx/.docx, then CSV, PDF, Markdown).

### 4. Find, read and keep knowledge
Home (*Find a document* → Knowledge with the search field focused; an Explore knowledge card or topic → Knowledge filtered by that topic; What's new or a recommended document → preview; Continue reading → Reader, its ✦ → Reader with Ask open) or Knowledge → Browse: pick a topic pill or a collection shared with you, or combine the inline filters (Type, Updated, Trust, Owner, More filters for space, source, base, format and language); save the view from *Views* → a card or row opens the preview → *Open full document* → Reader: read the document's own pages, *Ask* about the document in place (answers cite passages that highlight on the page), check *About* (source path, trust, versions, who can see it) and *Related* → Save, Add to collection, or *Use in…* a workflow. Saved, recent and your collections land in My library. Restricted bases stay visible only as bases (*Some knowledge bases aren't shared with you*, or a base filter) → Request access (Viewer or Editor + reason) → Pending → an owner approves in Manage → Knowledge bases → Access, or a workspace admin in People → Requests (Inbox and Overview link there).

### 5. Curate and keep knowledge healthy
Collections: create from any resource or the library, then *Edit* to order and annotate items (autosaved with Undo), share with a space you run or (admins) everyone, and add resources from the catalog; the view numbers the reading order and marks what you've read; viewers who can't open an item see only a count. Admins choose *Feature on Home* from a document's ⋯ menu or manage them in Home's Featured documents drawer (featured documents lead *Start here* and feed *Recommended for you*). Resource owners edit details (title, type, topics, owner, language, summary), link resources to further spaces and mark them verified. Overview → **Knowledge health** counts what needs keeping right; each metric opens its Knowledge Studio **Review queue** (Topics to confirm, Re-verification due, Missing details, Possible duplicates — keep one, archive the other, references follow; Publishing problems for documents changed at the source). **Taxonomy** (workspace admins) holds the topics with their codes, keywords, synonyms, examples, guidance and rules, imports and exports them as a spreadsheet (every change checked before it applies) and decides the assistant's proposed topics.

### 6. Contribute, review and publish
Knowledge → **Contribute** → choose *Contribute to a knowledge base* (or *Upload to My files*) → drop files → Continue → **Analyzing** (the assistant reads each file against the workspace's taxonomy) → **Check the details**: per file an editable title, type, topics with their evidence, knowledge base with who will see it, summary, and personal-data / possible-duplicate warnings → Submit for review (toast with *Track*). The submission is **In review**, visible only to the contributor and that base's reviewers. The reviewer opens Manage › Knowledge Studio → **Review** → Submissions: preview, the **Classification** card ("Confirmed by the contributor. Check before you publish." when the contributor confirmed it; otherwise the assistant's suggestions with confidence), flags (Possible duplicate, new version, Personal data) → *Approve & publish* ("Publishes to {base} · {audience}"), *Request changes* or *Decline*. Approval publishes: Publishing → Published, and only then is it searchable and used by the assistant. A suggested new topic never holds publishing back. The contributor follows it in Your work → **My contributions** (stepper Submitted → Analyzed → In review → Approved → Published) and the Inbox, revises when asked, sees **Declined** with the reviewer's reason otherwise, and can submit new versions later. Synced files follow their source's publishing policy (Publish automatically · Review only what's uncertain · Review everything). Admins see every document's place in the **Library** (flow strip and registry table) and its **Progress** in the document drawer. Full journeys: [DOCUMENT_LIFECYCLE.md](DOCUMENT_LIFECYCLE.md#journeys).

### 7. Set up knowledge, connect and maintain a source
Knowledge Studio's setup tabs in order, led by the setup guide on Overview: **Knowledge bases** (one per access boundary) → **Taxonomy** (import topics with keywords and synonyms) → **Sources** → Connect source (App → Account (sign in here; skipped when there is exactly one) → Content with filters and a live estimate → Destination, schedule and **publishing policy**, defaulting by size) → the first sync. *Publish automatically* publishes everything; *Review only what's uncertain* publishes clean files and holds flagged ones (in batches at scale); *Review everything* sends every new and changed file to review. A 100k-file first sync shows its pipeline in the run drawer, and people decide a few items in Review → **Sync batches** and topic groups in Review → **Topics to confirm**. Partial syncs show *Synced with issues*; failures surface as one alert with the fix (Sync now, Retry failed); an expired account's alert carries *Reconnect* (also Overview), and Sources → Accounts lists accounts (test, disconnect). Full walkthrough: [KNOWLEDGE_STUDIO.md](KNOWLEDGE_STUDIO.md).

Sync and processing are distinct, as in `backend/docs_design` (a sync changes only the inventory; an ingestion run processes; a schedule means "sync, then process what changed").

### 8. Govern people and access
People → Add people (multi-email with per-address validation; unknown addresses get an email invite, Resend / Revoke) → change roles inline or in bulk with Undo → member drawer for role, groups and effective knowledge access (changes apply at once with Undo) → Groups (membership instant; name and description in an Edit details dialog) and Roles (plain-language permissions as instant switches; built-in roles read-only with *Duplicate to customise*) → Requests approve/deny (Viewer / Editor / Owner). Suspend is instant with Undo; removing a member confirms. Guards: you cannot change your own role, suspend yourself, or remove the last admin.

### 9. Shape the assistant
Assistant → instructions, answer style, capabilities, welcome message and starters for Everyone, plus own starters for a role or group (resolved group → role → Everyone) → the live preview shows the chat home and a sample answer (a Preview button below 1024 px) → Publish (inline validation; unsaved-changes bar with Discard) → members see the new chat home.

### 10. Run the workspace
Overview lists what needs attention outside the Review queues — sources, accounts, access and office requests — one item per problem with a task verb linking to where it is fixed; **Knowledge health** shows seven metrics, each opening its Review queue; KPIs link to their pages; knowledge gaps lead to Contribute. Activity investigates changes and sign-ins with filters, a detail drawer with a link to the related object, and CSV export. Settings edits the name and address (with a broken-links warning); General › Advanced holds *Request archive* (typed confirmation; cancellable until an operator acts).

### 11. Operate the platform
Workspaces (create with first admin → Setting up → Active; suspend/reactivate with Undo; archive requests: *Archive workspace* with typed confirmation or *Decline request* with a reason; *Restore workspace* within 30 days) · Users (memberships, platform admin, suspend) · Connectors (each card opens a drawer with *Available to workspaces*; demand) · **Indexing** (Workspaces · Jobs · Policies: per-workspace queue, throughput, failure rate and status; pause/resume; retry failed jobs; job drawer — job metadata only, never document names or content) · Usage (range, one-line summary, per-workspace share, export) · Audit log (platform-level events only; filters, drawer, export) · System health (service status, AI capabilities and their deployment settings, incidents, link to Indexing).

## Onboarding

First-run product tour on Home: starts once per person and workspace (and from the account menu → Help → Product tour, or Journeys) — the box, its scope, the first section, AI Chat in the sidebar and the sidebar's search row. One *Skip tour* control; a bottom sheet on phones. Starters come from the workspace's published assistant settings.

## Search

- Two words everywhere: **Search documents** (find) and **Ask AI** (cited answer). In ⌘K, Ask AI ranks first only when the text reads like a question. Home offers the same two intents as cards (*Find a document*, *Ask a question*) that open Knowledge and AI Chat.
- ⌘K (the sidebar's *Search anything…* row; a top-row search icon only while the sidebar is off-canvas): best-match pages (in sidebar order) and actions, then Search documents / Ask AI, conversations, documents, Browse for the query, collections, knowledge bases, people (admins), spaces, work and actions; "See all results" opens `/search`.
- `/search?q=` is an overview: the top results per type (documents, knowledge bases, collections, conversations, people) with "See all"; the full document set opens in Knowledge → Browse.
- Knowledge → Browse is the knowledge finder: accent-insensitive (Vietnamese titles match unaccented queries), stop words ignored, metadata outweighs body text, verified resources rank slightly higher.
- In-page search fields filter the table or list they sit above.

## States

Every app screen supports Live, Loading (skeleton), Empty (first use with its first action) and Error (retry) — forced from the prototype bar. Filtered collections have a no-results state with Clear. Unpermitted routes render a no-access state without revealing data. Mutations change data first, then toast; long-running work (sync, processing, streaming, provisioning) shows live progress.

## Responsive

Below 1024 px the sidebar becomes an off-canvas sheet and side panels overlay; below 760 px tables become card rows; below 680 px dialogs and popovers become bottom sheets, drawers full-height sheets, and toolbars fold into one Filters button. The prototype bar previews 834 px and 390 px using the same rules.
