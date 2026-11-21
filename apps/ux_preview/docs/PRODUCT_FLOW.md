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
| Member (Northwind member, Finx Engineer Trần Minh Khoa) | Ask, verify, find and read knowledge; contribute; send requests | Home | Effective collection access + space role; can request access to discoverable restricted knowledge |
| Reviewer (Finx Lead Lê Thu Hà, Analyst Phạm Quốc Bảo) | Do the work above; review contributions to the collections they own; run evidence reviews and drafts; review teammates' drafts | Home | Owner role on owned collections + space role (e.g. lead of a team) |
| Workspace admin (Northwind admin, Finx Admin Võ Thị Lan) | Keep knowledge useful, connected and governed; run office queues | Home | Workspace permissions (`tenant.manage`, `source.manage`, `user.manage`, `audit.read`, …) and per-collection roles |
| Platform operator | Operate workspaces, accounts, connectors and service health | Platform console | `platform.*` permissions only; workspace data still requires membership |

## Principles

- **Knowledge first, then finish the work.** Every workspace lands on Home, a knowledge map of every collection, folder and readable document drawn in the workspace's own levels ([HOME.md](HOME.md)). Answers suggest the next step (start a request, draft a document, compare options).
- **Evidence in one click.** Citation marker → document preview at the highlighted passage → full document.
- **Fix it where you see it.** Every alert and inbox item carries its fix, or links to the one place the fix lives.
- **One shell.** One permission-aware sidebar for every persona, in three groups — **Workspace** (places), **Your work** (what you touched, organised and submitted) and **Manage** (only with a manage permission). Every row has one responsibility; the sidebar lists no conversations or projects inline (they live on AI Chat, Recent and Projects). Search (⌘K) opens from the sidebar's search row; the Inbox bell sits in the top row (CompactHeader) and opens the Inbox as a popover, so reading notifications never leaves the page, which also carries the page's trail, title and actions; on desktop the sidebar collapses to an icon rail. Anatomy: [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md#layout--styleslayoutcss).
- **One primary action per region.** Everything else is secondary, in a row menu, or in a drawer. Whole rows open their object.
- **Recoverable by default.** Reversible changes apply at once with Undo; only irreversible or high-risk actions confirm (typed confirmation only for workspace archive).
- **Honest proposals.** Pages without a backend contract carry one `Preview` chip.

The full action system and vocabulary are in [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md#rules).

## Information architecture

```text
Sign in · Create account · Choose workspace

CompactHeader ───────── menu (off-canvas only) · parent trail · title · chip · status │ page actions · Search icon (off-canvas only) · Inbox bell (Inbox popover)
Sidebar ─────────────── workspace switcher + toggle (desktop icon rail) · Search anything… (⌘K) · three groups (items marked * appear when the module is on) · account footer
WORKSPACE
├── Home ────────────── Knowledge Atlas: workspace › collection territories › folders › documents on one pan/zoom canvas · Find in the map · Go to · inspector (overview titles, then most opened, lead each group)
├── Knowledge ────────── Browse (the organization's knowledge, /knowledge; inline filters, Views) · sub-rows Saved · My files (shown while in Knowledge) · Contribute
│                        └── Document preview · Reader (Ask · About · Related)
├── AI Chat ──────────── /chat: composer (scope "Search in", attach, starters before your first conversation) above the Conversations list (search and Project filter at 7+)
│                        └── Conversation (/chat/:id; read-only for people a share of it is for)
├── Work* ────────────── New (workflow → materials → options) · Evidence review · Draft (Draft → In review → Approved / Changes requested; Campus template adds study guide and quizzes)
└── Requests* ────────── My requests · Queue (Open / Closed) · New (service catalog → rule check → form) · Request thread
YOUR WORK (collapsible)
├── Recent ───────────── /recent: documents, conversations and work you touched — Today · This week · Earlier; filter All · Documents · Conversations · Work
├── Projects ─────────── /projects: your project folders (New project, ⋯ Rename… · Delete with Undo)
│                        └── Project (/project/:id): composer with Project documents · Conversations
├── Spaces* ──────────── Space: Overview · Materials · Work · Questions/Requests · People · ⚙ Settings (own page)
└── My contributions ─── /contributions: what you submitted and where it is (filters, drawer with stepper, Revise)
MANAGE (with a manage permission; owners and editors of a collection see Knowledge Studio; collapsible)
├── Overview ─────────── setup checklist (empty workspace only) · Needs attention (incl. the next setup step) · Knowledge health · KPIs · knowledge gaps
├── Knowledge Studio ─── sub-rows Documents (All · Processing · Review) · Collections · Topics (All · Suggestions) · Sources (All · Sync history · Accounts)
│                        └── Collection (/studio/collections/:id): page tabs Contents · Access · Sources (name and description edited in place; Archive in ⋯)
├── People ───────────── sub-rows Members · Groups · Roles · Access requests
├── Assistant
├── Activity ─────────── sub-rows Changes · Sign-ins
└── Settings ─────────── sub-rows General (Advanced: workspace ID, Request archive) · Workspace setup

Not in the sidebar: Inbox (popover from the top-row bell; no route) · Search results (/search)

Platform console (operators): Workspaces · Users · Connectors · Indexing (sub-rows By workspace · Jobs · Policies) · Usage · Audit log · System health
Prototype only: Design system (#/design)
```

An area's sections are sidebar sub-rows (shown while you're in the area with the sidebar expanded; a section menu from the icon rail; ⌘K finds them by name), each titled by its name; never page tabs. Page tabs are only for views of one thing: an entity (a space, a collection) or one list (Work: Mine · Shared with me; Requests: My requests · Queue).

Earlier changes: Inbox is a page (was a drawer); Collections, Sources and Connections folded into **Knowledge Studio** as its setup tabs (accounts are a view of Sources; `/sources`, `/connections`, `/bases` and `/bases/:id` redirect — see [KNOWLEDGE_STUDIO.md](KNOWLEDGE_STUDIO.md)); People & access is **People**; Assistant setup's two tabs are one form; workspace accent theming was removed (the background stays a personal choice); AI capabilities moved into System health; the review index, page-audit panel and lifecycle rails were removed. The Knowledge Hub replaced the collection card grid and the old document viewer. Uploading no longer publishes: contributions go through review in **Knowledge Studio** (which replaced Manage › Documents, itself the successor of Knowledge health and the per-collection document inventory; `/documents` redirects to `/studio`) — see [DOCUMENT_LIFECYCLE.md](DOCUMENT_LIFECYCLE.md). Home became the core landing for every workspace and absorbed the Knowledge landing tab; `/knowledge` opens Browse and `/knowledge/browse` redirects there.

Sidebar redesign: the sidebar's former New chat row, inline Projects tree and inline Recent conversations, and the All conversations page (`/chats`) became **AI Chat** (`/chat`, composer + conversation list), **Recent** and **Projects** pages; the former library's Recent and Contributions tabs became **Your work → Recent** and **My contributions**; Knowledge Studio's earlier sections (Review, Documents, Taxonomy, Master data, Quality, and the single pipeline section that followed them) became **Documents** and **Topics** (All · Suggestions), with metrics on Overview → Knowledge health; Documents' views All · Review · Issues · Quality then became **All · Processing · Review** (submissions are processed before they're reviewed; Issues folded into Processing, Quality into a filter in All). People, Activity, Settings and Indexing sections moved from page tabs to sidebar sub-rows. Every old address redirects ([SCREEN_INVENTORY.md](SCREEN_INVENTORY.md#redirects)).

Finx journeys (policy → request, evidence review, decision draft, office queue) are in [FINX_WORKSPACE.md](FINX_WORKSPACE.md); Home in [HOME.md](HOME.md). The journeys below work in both workspaces.

## Journeys

### 1. Sign in and ask
Sign in (email or username + password, or Google) → choose a workspace when you belong to several → Home → *Ask a question* (or **AI Chat** in the sidebar, or *Ask AI* in ⌘K) → type the question or pick a starter, optionally narrow the scope → the answer streams with work steps, inline citations and source chips → follow up in the same thread. The conversation appears at the top of AI Chat's **Conversations** list and in **Recent**; file it into a project from its ⋯ menu when it belongs to ongoing work.

**Forgot password.** Sign in → *Forgot password?* → `/password-reset` (the email carries over when one was typed; a username isn't) → *Send reset link* → "Check your email": the same answer whether or not an account uses the address (SendPasswordReset never says), the link works once for 30 minutes, *send it again* resends. The emailed link opens `/password-reset/:token` → new password (strength meter, same rule as sign-up: 8+ characters with letters and numbers) and confirmation, checked on save → ResetPassword ends every session of the account → Sign in, email filled in, password focused, with a *Password changed* notice. A used, expired or unknown link — also one that runs out while the form is open — shows *This link doesn’t work anymore* with **Send a new link** (sends straight away when the link said whose it was). The prototype sends no mail: the confirmation has a dashed *Prototype* box with *Open the link* and *Try an expired link*.

**Links someone was sent (`/s/…`).** Every URL BoMesh hands out is a share (`resource_shares`, `features/shares.js`). *Copy link* on a document, a collection or a space copies a share to the workspace (`/s/{share}`, made once and copied again after); it grants nothing, so whoever opens it without access gets *You don’t have access yet* with **Request access**, and the target stays unnamed. *Share* on a conversation shares the live conversation with everyone in the workspace or chosen people; they open it read-only at `/chat/:id`, re-filtered for them, and only the owner continues it. **Invite links** (People → Members, a space's People, a collection's Access → *Invite link*) grant a role: choose the role, how long it works and how many people can join, then copy the link — it is shown only once; *Reset link* makes a new one, *Revoke link* ends it. Opening any link signed out asks to sign in or create an account and returns to it; an invite then shows *Join {name}* with **Accept invite** and lands in the workspace, space or collection. A link that was turned off, expired, used up or whose creator can no longer invite says so.

**Scrolling.** Opening a conversation shows its latest turn. Sending a question — or retrying or editing one — glides it to the top of the thread, and its answer grows below it; the thread never scrolls by itself while the assistant works, so the reader controls the pace. Until the answer fills the view there is room under it, so the question can stay at the top.

While an answer is on its way, it reads as one consistent flow — *say, do, say, answer* — on a rail above the answer:

1. **A short note** says what the assistant will do ("I’ll look through Internal Policies for this."). Notes stream like the answer, word by word. They are the model's commentary — what it is doing and why — never its hidden reasoning or tool internals.
2. **The action** runs on a live row: two orbiting dots (no spinner) and a label in the accent gradient that names it (*Searching your knowledge* with the query, *Reading Hybrid Work Policy*, *Running code*…) only while it actually runs. Before the first note and between steps the row says *Thinking*.
3. **What it found shows at once.** A search lists its documents as slim rows in one quiet list that ease in one after another: the file type, the title, where it lives (collection) and how fresh on one line — with the answer's source numbers at its end once the answer cites it — and the matching passage with its page on the next. On narrow screens where and when move under the title. Three show; *Show more* reveals the rest. A row opens the preview at that passage. A read names its document as a link.
4. **Another note** says what the results mean and what comes next ("Hybrid Work Policy looks most relevant. I’ll read it before answering."). A further search adds its own note, action and documents.
5. **The answer** streams below. Once it cites a document, that document's row carries the same source numbers as the answer, so the flow and the citations point at each other.

A greeting or a question about the assistant needs no knowledge: a brief *Thinking*, then the answer, with no search claimed. Nothing found reads as a note ("Nothing in … covers this, so I won’t guess."). The answer and its flow stay in place when it finishes; the flow folds into one summary line ("Searched your knowledge · Read Hybrid Work Policy") only on request, and stored answers show it folded. With *Show how answers were found* off, only the live line shows while the assistant works.

The flow names what was done and found; it never shows counts or timings (documents, passages, collections searched, seconds). Names and the matching passage tell the reader more, and nothing has to be counted or aggregated to draw it.

### 1b. Organise AI work in projects
Your work → **Projects** → *New project* → name only → the project opens (trail Projects › name): one composer (*New chat in …*) with the **Project documents** pre-attached as removable chips (added from Knowledge, up to 10; never copied, access rules still apply; removing a chip leaves it out of that conversation only) and its **Conversations**. On the project page the name renames itself (click it; Enter or click away applies with Undo) and the trash icon beside it deletes the project (Undo restores; its conversations stay in AI Chat); a Projects row's ⋯ does both too. Any conversation's ⋯ (AI Chat list, project page, thread top row) moves it to a project, to a new project, or out of one; an open conversation renames from its title in the top row, a row from ⋯ Rename…. Threads read where they live: Projects › project › title, else Spaces › space › title, else AI Chat › title. Starting from Home never asks for a project.

*Backend alignment:* projects are prototype-only. The API has no project resource and conversations carry no project; production needs a contract change (`openapi.yaml` + `api_design.md`) before clients build it.

### 2. Verify an answer
Citation marker or source chip → the document preview opens at the cited passage (highlighted, "Passage n of m" steps through the answer's citations, across documents) → *Open full document* → the Reader keeps the highlight and links back to the conversation. A locked document shows only the cited quote and *Request access*.

### 3. Work with files in a conversation
Attach files (validated: ≤ 5, ≤ 100 MB, blocked types refused) or add from knowledge → ask for a spreadsheet or a draft → the answer includes a file card → the file panel shows Preview (and Changes and History from version 2) → edit in place, or ask for changes in the thread composer while the "Editing {file}" chip is on (each is a new version) → restore any version (Undo) → download in the native format first (.xlsx/.docx, then CSV, PDF, Markdown).

### 4. Find, read and keep knowledge
Home (open a branch or *Find in the map* → a document → preview; *Open in Knowledge* → Knowledge filtered by that collection) or Knowledge → Browse: pick a topic pill or combine the inline filters (Type — the file type —, Updated, Trust, Owner, More filters for space, source, collection and language); save the view from *Views* → a card or row opens the preview → *Open full document* → Reader: read the document's own pages, *Ask* about the document in place (answers cite passages that highlight on the page), check *About* (source path, trust, versions, who can see it) and *Related* → Save, or *Use in…* a workflow. Saved documents land in Saved, recent ones in Your work → Recent. Restricted collections stay visible only as collections (*Some collections aren't shared with you*, or a collection filter) → Request access (Viewer or Editor + reason) → Pending → an owner approves in the collection's Access requests section (Manage › Knowledge Studio → Collections), or a workspace admin in People → Access requests (Inbox and Overview link there with *Open access requests*).

### 5. Curate and keep knowledge healthy
Resource owners rename a document on its title in the Reader, edit details (title, topics, owner, language, summary; the file type is shown read-only), link resources to further spaces and mark them verified. Overview → **Knowledge health** counts what needs keeping right (Processing · Review · Topic suggestions · Quality · Verified); each metric opens its view: Documents → **Processing** for what isn't processed, couldn't be processed or changed at the source; Documents → **Review**; Documents → **All** filtered by **Quality** for Re-verification due, Missing details and Possible duplicates (keep one and archive the other: saved, recent, space materials, shortcuts and conversation references move to the kept document; Undo restores the duplicate only); Topics → **Suggestions** for the assistant's proposed topics, keywords from reviewers' corrections, topics to confirm and documents without a topic. **Topics → All** (workspace admins) holds the topics by name with their keywords, synonyms, examples, guidance and rules, imports and exports them as a spreadsheet matched by domain and topic names (every change checked before it applies) and shows the classification prompt (there is no classification threshold: the assistant picks topics directly); a change re-checks published documents without re-indexing.

### 6. Contribute, review and publish
Knowledge → **Contribute** → choose *Contribute to a collection* (or *Upload to My files*) → drop files → Continue → **Analyzing** (the assistant reads each file against the workspace's topics) → **Check the details**: per file an editable title, topics with their evidence, collection with who will see it, summary, and personal-data / possible-duplicate warnings → Submit for review (toast with *Open*; reviewers get *Process*). The submission is **In review**, visible only to the contributor and that collection's reviewers. The reviewer first processes it — Manage › Knowledge Studio → **Documents** → **Processing** (submissions first; select → **Process**): the assistant classifies it against the target collection and it moves to **Review** ("… is processed and ready for review · Review"). In Review: preview, the **Classification** card (✦ "Classified by the assistant when it was processed", with each topic's evidence), flags (Possible duplicate, new version, Personal data) → *Approve & publish* ("Publishes to {collection} · {audience}"), *Request changes* or *Decline* (keys **A** / **R**; *Use my change to improve classification* sends the reviewer's topic change to Topics → Suggestions). Approval publishes only: the processed document is searchable at once; an approved new version is **Not processed** until someone processes it from Processing. A document is searchable and used by the assistant only when it is published **and** processed. A suggested new topic never holds publishing back. The contributor follows it in Your work → **My contributions** (stepper Submitted → Analyzed → In review → Approved → Published) and the Inbox, revises when asked, sees **Declined** with the reviewer's reason otherwise (and can *Withdraw* it), and can submit new versions later. Synced files follow their source's publishing policy (Publish automatically · Review only what's uncertain · Review everything). Admins see every document in Documents → **All** (Processing state and Publication columns) and its steps (Received → Processed → Reviewed → Published → Searchable) in the document drawer. Full journeys: [DOCUMENT_LIFECYCLE.md](DOCUMENT_LIFECYCLE.md#journeys).

### 7. Set up knowledge, add and maintain a source
Knowledge Studio's setup sections in order, led from Overview (the full *Set up knowledge* checklist in an empty workspace, then one Needs attention row for the next unfinished step): **Collections** (one per access boundary) → **Topics** (import topics with keywords and synonyms) → **Sources** → Add source (App → Account (sign in here; skipped when there is exactly one; *Use a connected account* from the Add source menu opens straight at Content) → Content with filters and a live estimate (folders another source already syncs are disabled, "In {collection}") → Destination, schedule and **publishing policy**, defaulting by size) → the first sync. A source feeds exactly one collection, fixed at creation, so a collection's Sources section adds a new source with a reused account rather than attaching an existing one. *Publish automatically* publishes everything; *Review only what's uncertain* publishes clean files and holds flagged ones (in batches at scale); *Review everything* sends every new and changed file to review. A 100k-file first sync shows its progress in the run drawer, and people decide a few items in Documents → Review → **Held back by a sync** and topic groups in Topics → Suggestions → **Topics to confirm**. Partial syncs show *Synced with issues*; there are no alert banners: each source row carries its own fix (Pause/Resume, Cancel, *Reconnect* for an expired account (also Overview), *Retry*, Resume, *Process n*, else a quiet Sync now), and Sources → Accounts lists accounts (Connect account, test, disconnect, ⋯ Add source with this account). Full walkthrough: [KNOWLEDGE_STUDIO.md](KNOWLEDGE_STUDIO.md).

Sync and processing are distinct, as in `backend/docs_design` (a sync changes only the inventory; an ingestion run processes; a schedule means "sync, then process what changed"). Nothing is processed on upload: a source's sync is the explicit run for what it brings in, and everything else is processed only when someone asks.

**Process 1,000 uploaded documents** (UTE: Phòng Đào tạo › *Văn bản số hóa 2015–2024*; Finx: Banking Operations › *Archive upload 2016–2025*, 1,200): Documents → **Processing** → the *Not processed* pill → optionally narrow by Collection or search (e.g. a year) → select the page, then *Select all matching* → **Process** → the dialog *Process the matching documents* (which topics the AI may suggest: *All topics* or *Selected*, loaded from the collection's topics; optional context for the AI; nothing is published) → **Process** → the processing strip shows progress (*Show them*, *Stop*: what's done stays processed, the rest goes back to Not processed) → a toast reports the result; failures stay in Processing as **Failed** (*Show*, then *Process again*); reviewers then publish what's ready. Walkthrough: [KNOWLEDGE_STUDIO.md](KNOWLEDGE_STUDIO.md#the-1000-document-flow).

### 8. Govern people and access
People (sub-rows Members · Groups · Roles · Access requests) → Add people (multi-email with per-address validation; unknown addresses get an email invite, Resend / Revoke) → change roles inline or in bulk with Undo → member drawer for role, groups and effective knowledge access (changes apply at once with Undo) → Groups (New group; membership instant; the group's name and description are click-to-edit in its drawer header, applied at once with Undo; Delete is the header's icon, confirmed, with Undo) and Roles (New role; a custom role's name and description are click-to-edit on its page, Delete is one icon; plain-language permissions as instant switches; built-in roles read-only with *Duplicate to customise*, whose copy opens with its name ready to type over) → Access requests approve/deny (Viewer / Editor / Owner). Suspend is instant with Undo; removing a member confirms. Guards: you cannot change your own role, suspend yourself, or remove the last admin.

### 9. Shape the assistant
Assistant → instructions, answer style, capabilities, welcome message and starters for Everyone, plus own starters for a role or group (resolved group → role → Everyone) → the live preview shows the chat home and a sample answer (a Preview button below 1024 px) → Publish (inline validation; unsaved-changes bar with Discard) → members see the new chat home.

### 10. Run the workspace
Overview lists what needs attention outside Knowledge Studio's Documents and Topics views — sources, accounts, access, office requests and the next unfinished setup step — one item per problem with a task verb linking to where it is fixed; **Knowledge health** shows Processing · Review · Topic suggestions · Quality · Verified, each opening its view; KPIs link to their pages; knowledge gaps lead to Contribute. Activity investigates changes and sign-ins with filters, a detail drawer with a link to the related object, and CSV export. Settings edits the name and address (with a broken-links warning); General › Advanced holds *Request archive* (typed confirmation; cancellable until an operator acts).

### 11. Operate the platform
Workspaces (create with first admin → Setting up → Active; suspend/reactivate with Undo; archive requests: *Archive workspace* with typed confirmation or *Decline request* with a reason; *Restore workspace* within 30 days) · Users (memberships, platform admin, suspend) · Connectors (each card opens a drawer with *Available to workspaces*; demand) · **Indexing** (sidebar sub-rows By workspace · Jobs · Policies: per-workspace queue, throughput, failure rate and status; pause/resume; retry failed jobs; job drawer — job metadata only, never document names or content) · Usage (range, one-line summary, per-workspace share, export) · Audit log (platform-level events only; filters, drawer, export) · System health (service status, AI capabilities and their deployment settings, incidents, link to Indexing).

## Onboarding

First-run product tour on Home: starts once per person and workspace (and from the account menu → Help → Product tour, or Journeys) — the box, its scope, the first section, AI Chat in the sidebar and the sidebar's search row. One *Skip tour* control; a bottom sheet on phones. Starters come from the workspace's published assistant settings.

## Search

- Two words everywhere: **Search documents** (find) and **Ask AI** (cited answer). In ⌘K, Ask AI ranks first only when the text reads like a question. Home offers the same two intents as cards (*Find a document*, *Ask a question*) that open Knowledge and AI Chat.
- ⌘K (the sidebar's *Search anything…* row; a top-row search icon only while the sidebar is off-canvas): best-match pages (in sidebar order) and actions, then Search documents / Ask AI, conversations, documents, Browse for the query, collections, people (admins), spaces, work and actions; "See all results" opens `/search`.
- `/search?q=` is an overview: the top results per type (documents, collections, conversations, people) with "See all"; the full document set opens in Knowledge → Browse.
- Knowledge → Browse is the knowledge finder: accent-insensitive (Vietnamese titles match unaccented queries), stop words ignored, metadata outweighs body text, verified resources rank slightly higher.
- In-page search fields filter the table or list they sit above.

## States

Every app screen supports Live, Loading (skeleton), Empty (first use with its first action) and Error (retry) — forced from the prototype bar. Filtered lists have a no-results state with Clear. Unpermitted routes render a no-access state without revealing data. Mutations change data first, then toast; long-running work (sync, processing, streaming, provisioning) shows live progress.

## Responsive

Below 1024 px the sidebar becomes an off-canvas sheet and side panels overlay; below 760 px tables become card rows; below 680 px dialogs and popovers become bottom sheets, drawers full-height sheets, and toolbars fold into one Filters button. The prototype bar previews 834 px and 390 px using the same rules.
