# BoMesh page audit

Each screen answers four questions: **what is it for**, **what is the main action**, **what does the user actually need to see**, and **what comes next**. The "Changed" column records what the HeroUI redesign added or removed against the previous prototype.

## Cross-product decisions

| Finding in the previous prototype | Decision |
| --- | --- |
| A custom visual system loosely inspired by HeroUI; components drifted per page | HeroUI v3 tokens (Theme Builder export) and HeroUI component anatomy/BEM names for every element; screens compose only `ui.js` builders |
| 6,000-line single script with monkey-patched layers | Core (state, router, builders, overlays, shell) + one isolated module per product area, loaded as ordered classic scripts so `file://` still works |
| Lifecycle rails, review notes, per-button `Preview` tags and explanatory paragraphs on most pages | Removed. Status chips + one alert carrying the fix replace rails; `Preview` is a single header chip on proposal-only pages |
| Inbox as a drawer, Connections hidden in a Sources tab, Documents only inside knowledge bases | Inbox and Connections are first-class destinations; knowledge is found through the Knowledge Hub (below) |
| Review index as the landing page; page-audit side panel | Opening the prototype lands in the product (`/home`); review tooling is limited to the prototype bar |
| Accent/background/density theming options | One personal theme re-themes the whole app (HeroUI Theme Builder dimensions): 19 named themes (default BoMesh · Calm sage), accent swatches + custom hue, background tint (Base), radius, font, light/dark/system. Density stays removed; status and evidence colors stay fixed |
| Prototype bar overlapping the product | The bar owns a band below the product; overlays are contained by the app frame |
| Breakpoints based on the browser window | Container queries on the app frame, so the bar's tablet/phone previews exercise real rules |
| Uploads and syncs processed automatically in some flows | Aligned with `backend/docs_design`: syncs and uploads only change the inventory (Waiting); processing is explicit (Process); scheduled syncs sync then process |
| A knowledge chatbot can't help people finish the work that follows (decisions, reviews, paperwork) | Optional outcome modules — Spaces, Work, Requests — switched on per template or workspace, keeping one shell, one design system and one data model; code asks `hasModule()` rather than "is this workspace X?" |
| Workspace data was global; one demo company | Data is scoped per workspace behind the same `D` interface; personas belong to workspaces; the prototype bar switches workspace and persona |
| Answers ended the interaction | Answers carry next-step actions (start a request, draft a document, compare options, ask a space's staff); unanswerable questions become knowledge gaps and space questions whose answers become FAQ knowledge |
| Knowledge was a container drill-down (base cards → document table) with a separate flat Documents list and search page | One Knowledge Hub with two destinations by intent: Browse (the organization's knowledge: one faceted catalog, URL state, collections shared with you) · My library (personal), plus the Reader. Knowledge bases are managed in Manage → Knowledge bases and are a Browse filter for readers. See [KNOWLEDGE_HUB.md](KNOWLEDGE_HUB.md) |
| Readers saw Waiting/Processing/Failed; nothing said whether a document could be trusted | Readers see trust (Verified, Review due, Not verified) and freshness; publishing problems live in Manage → Documents |
| Uploading put a file straight into a knowledge base; anyone with edit rights effectively published it | Contribution, curation and publication are separate: Contribute → review (Manage → Documents) → Approve & publish. Only published content reaches search, the Reader and the assistant. See [DOCUMENT_LIFECYCLE.md](DOCUMENT_LIFECYCLE.md) |
| Curation was scattered across knowledge-base inventories, Knowledge health and Sources | One Documents page for reviewers: Review · All documents · Quality · Topics. Knowledge-base pages are about reading and access again |
| Platform admins had the same content access as workspace admins to see processing problems | Platform → Indexing shows job metadata only (ids, workspace, file type, step, error class) |
| Asking about a document left the document | The Reader keeps an Ask rail beside the page; answers cite passages that highlight in place; *Continue in chat* when needed |
| Realistic company records could be mistaken for real policy | Demo workspaces (`ws.demo`, e.g. Finx) carry a *Demo data* chip in the Knowledge header and the Reader |
| Enterprise opened on an empty chat; Knowledge opened on a separate landing tab | Home is the core, knowledge-first landing in every workspace: search/ask, explore, featured, recent and recommended, where you left off. Knowledge now opens on Browse. See [HOME.md](HOME.md) |
| Each page invented its own button weights, confirm rules and save model; rows carried Open/Review buttons beside a clickable row; ⋯ menus repeated visible actions | One action system ([DESIGN_SYSTEM.md](DESIGN_SYSTEM.md#rules)): one primary per region; alert and row buttons secondary sm; whole rows open their object with secondary actions revealed on hover/focus; ⋯ ≤ 8 grouped items; reversible changes instant with Undo, confirmation only for irreversible or high-risk actions; primaries stay enabled and validate on press; one vocabulary (Search documents / Ask AI, Contribute, Declined, Publish update, Everyone · Restricted · Private, Viewer · Editor · Owner, Evidence review, People) |
| Documents opened in a Browse drawer, a chat citation panel, work and request citation drawers, or straight in the Reader — four different previews | One **document preview** modal for every document row, card and citation: native rendering, highlighted passage or matches, Ask about this document · Open full document |

## Sign-in and workspace selection

| Route | For | Main action | Needs to see | Next | Changed |
| --- | --- | --- | --- | --- | --- |
| `/signin` | Returning user | Sign in | Credentials, Google, recovery | `/workspaces` or `/home` | Marketing panels and trust lists replaced by one grounded-answer example |
| `/signup` | New user | Create account | Fields and password rules | No-workspace state → wait for an invite | Optional username removed; strength meter added |
| `/workspaces` | Multi-workspace user | Open workspace | Name, role, members, last opened | `/home` | Sorted by last opened |

## Member

| Route | For | Main action | Needs to see | Next | Changed |
| --- | --- | --- | --- | --- | --- |
| `/home` | Everyone, every workspace | Search documents / Ask AI (the question-like one first) | Search/ask with scope and suggested questions; Waiting for you; Continue reading; source-backed changes; featured and recommended documents (with reasons); topics | Chat, Browse (filtered), preview, Reader, request | Replaces New chat as the landing and the old Knowledge landing tab; no metrics; featured documents edited in a drawer. See [HOME.md](HOME.md) |
| `/chat` | Starting a conversation (sidebar New chat) | Send | Composer, "Search in" scope, one suggestion area (starters or the space's workflows) | Conversation | Starters fill the box instead of sending; one scope label "All of {workspace}" |
| `/chat/:id` | Reading and verifying answers | Follow-up | Answer, citations, quiet source chips, labelled next steps, work steps (optional) | Document preview at the cited passage → Reader | Citation side panel replaced by the shared preview; one Copy, one-click Retry, ⋯ Rewrite/Download; file changes asked in the thread composer; Share saved on the conversation |
| `/chats` | Finding a conversation | New chat | Title, last line, project/space/base context, updated | Conversation | Project filter and chip; one conversation ⋯ menu; Delete conversation with Undo |
| `/inbox` | Acting on notifications | Approve / Deny / Reconnect inline; other rows open their item | Needs you (by due date), then Updates; title, context, time, unread | The item's page | Topbar bell with unread badge; buttons only for decisions; no All/Unread filter |
| `/search` | Overview of a query across types | Open result | Top results per type with snippets | Browse (all documents), base, collection, conversation | Tabs and paging removed; documents' full set is Browse |

## Knowledge

| Route | For | Main action | Needs to see | Next | Why this shape |
| --- | --- | --- | --- | --- | --- |
| `/knowledge` (Browse) | Finding the right resource among thousands | Open (preview) | Results with type, base, source, trust, freshness, summary or snippet; counts per filter | Preview → Reader; Views; Ask about these results | One catalog replaces `/documents`, base tables, document search and the old landing tab (`/knowledge/browse` redirects). Inline filter popovers (Type · Updated · Trust · Owner · More filters) replace the Filters drawer; saved views in a Views menu; the quick-preview drawer gave way to the shared document preview |
| `/knowledge/library` | Keeping what I found and what I shared | Each tab's own action (Contribute · Upload · New collection), no header action | Saved, recent, my contributions with their status and the latest reviewer message, my files, my collections | Preview, Reader, collection, contribution drawer, Browse | Personal state has one home; shared collections and saved views stay in Browse, where they're used |
| Contribute dialog | Sharing a document | Submit for review | Destination first (Contribute to a knowledge base / Upload to My files), drop zone, knowledge base (assistant can suggest), title and description | Contributions, Review (reviewers) | One file and at most one choice; reviewers fix classification, not contributors |
| `/knowledge/collections/:id` | Using or curating a reading list | Ask about this collection (view) · Done (edit mode) | Numbered items with the curator's notes and read marks; who it's shared with | Preview, Reader, Use in… a workflow | References, not copies; never grants access, so curation can't leak restricted titles. Edit mode autosaves with Undo |
| `/doc/:id` | Reading and understanding | Ask (in place) | The page, cited passages, trust, provenance, versions, related resources | Save, collection, Use in…, Continue in chat | AI beside the page keeps reading context (`?ask=1` opens it); trust replaces pipeline states; provenance and versions in About; compact phone header that hides on scroll |

## Workspace admin

| Route | For | Main action | Needs to see | Next | Changed |
| --- | --- | --- | --- | --- | --- |
| `/overview` | "What needs me?" | Each attention item's task link | Attention list (one item per problem), 4 KPIs (Questions with a sparkline), knowledge gaps | Documents, Sources, Connections, People | Greeting, setup checklist, health meter, recent-activity feed, inline decisions and the 30-day disclosure removed |
| `/sources` | Keeping knowledge in sync | Connect source | Source, destination, schedule, last sync, status (incl. Synced with issues); problems as alerts | Source drawer, wizard, history, Connections | Accounts tab moved to Connections; Publish automatically publishes after every sync |
| `/connections` | Account health | Connect account | Account, status, last check, dependent sources | Reconnect | The one place an expired account is fixed and counted |
| `/people` | Membership and authorization | Add people (and invite) | Person, role, groups, last active, status chips | Member/group/role drawers, requests | Renamed from People & access; authorization rail removed; drawers apply changes immediately with Undo; built-in roles read-only |
| `/assistant` | Configuring the assistant | Publish | Instructions, style, capabilities, starters per audience, live preview | Members' chat home | Two tabs merged into one form; starters for Everyone plus roles and groups |
| `/activity` | Investigating | Export CSV | Time, person, action, target, outcome | Event drawer → related page | Sign-ins only in their tab; areas from the log; shared table with the platform audit log |
| `/documents` | Curating and publishing (base owners; admins all) | Approve & publish (Review); each row's fix elsewhere | Review: queue + preview + the assistant's suggestions with confidence + labelled risk chips. All documents: lifecycle per document with its fix, filters and bulk actions. Quality: re-verification, missing details, duplicates. Topics (admins): taxonomy + proposed topics | Next item, Reader, Sources | New. Replaces Knowledge health and the per-base inventory; decisions auto-advance with Undo; J/K keyboard; floating bulk bar |
| `/bases` | Looking after the bases I own or edit (owners, editors, `knowledge.manage`) | Create knowledge base; per base Share · Connect source · Save | Access (Everyone · Restricted · Private; Viewer · Editor · Owner), documents, pending access requests; per base Access · Sources · Settings | Manage → Documents (Review N / Fix publishing), People | Moved out of Knowledge: the access boundary is administration, not a place to read. Readers filter Browse by base and request access there; archive is immediate with Undo |
| `/p/indexing` | Operating indexing without content access | Pause/Resume or Retry | Workspaces (queue, throughput, failure rate, status, error classes) · Jobs (job drawer) · Policies | System health, workspace drawer | New. No document names or content anywhere |
| `/settings` | Workspace identity and setup | Save | Name, address; Advanced: ID and Request archive; template, modules, space types, workflows | Navigation reflects modules at once | Brand tab and Danger zone tab removed; Workspace setup added |

## Optional modules (on in Finx Workspace)

| Route | For | Main action | Needs to see | Next | Why this shape |
| --- | --- | --- | --- | --- | --- |
| `/spaces` | Finding contexts | Create space | My teams, projects, offices; join or request | Space | Space types come from the template/workspace (Finx: team, project, office) |
| `/space/:id` | Working in a team, project or office | Ask AI (Ask the team for people) | Announcements, Up next, materials, work, queue (staff) | Workflow, request, chat | One context instead of separate wiki, drive and email threads; Settings behind a gear; office staff land on the queue |
| `/work` + `/work/new` | Making reviews and drafts | Generate | Which workflow, which materials (up to 8 for an evidence review), two or three options | The new work | Workflows are short and grounded in chosen materials; no blank-page prompting |
| `/work/:id` (evidence review, draft) | Lead comparing options / engineer writing a decision record | Draft from this review / Send for review (author), Approve (reviewer) | Cited evidence per cell in a side panel; sources and versions beside the text | Decision record, review by space staff | Evidence first, then writing; every claim stays traceable; drafts go Draft → In review → Approved / Changes requested |
| `/requests` | Requester / office staff | New request / work the queue | Status, what needs my reply / SLA and assignee | Request thread | One queue (Open / Closed) shared with the space tab; staff see overdue first |
| `/requests/new` | Employee who needs access or approval | Send request | Whether the policy allows it (e.g. Secure coding training before production access), with the policy cited; only the fields needed | Thread | Rule check before sending removes back-and-forth and wrong submissions; questions go through the space's Ask dialog |
| `/requests/:id` | Both sides | Reply / Approve · Decline · Answer (staff Send, optionally asking for information) | Thread, details, recorded checks | Inbox notification; FAQ | Answers to space questions become knowledge for the next person |

The Campus template (study guides, quizzes) is available on the platform but has no demo workspace.

## Platform console

| Route | For | Main action | Needs to see | Next | Changed |
| --- | --- | --- | --- | --- | --- |
| `/p/workspaces` | Operating workspaces | Create workspace | Status, owner, size, demand; archive requests | Workspace drawer (Archive workspace / Decline request / Restore workspace) | Provisioning rail and row menus removed |
| `/p/users` | Account administration | Open user | Workspaces, last active, status chip by the name | User drawer | Status column removed |
| `/p/connectors` | Connector availability | Open a connector (drawer) | Status, adoption, demand | Drawer with *Available to workspaces* | OAuth secret editing and the Configure/Enable buttons removed |
| `/p/usage` | Demand | Export CSV | One-line summary, per-workspace share, daily chart | — | Stat cards removed |
| `/p/audit` | Platform-level investigation | Export CSV | Platform event list with filters | Event drawer | Workspace-internal events removed; same table as Activity |
| `/p/health` | Service impact | Refresh | Degraded banner, services, AI capabilities, incidents | — | AI capabilities page merged in; uptime strip removed |

## Verification

Checked in headless Chromium from `file://`:

- Every route for each persona renders without console errors, including forced Loading/Empty/Error states.
- Cross-module flows: Overview → Reconnect (Connections) clears the alert and resumes sync; Inbox Approve updates requests and the badge; Knowledge → Ask starts a scoped conversation; palette navigation; every Journey starts on the right screen with the right dialog.
- Sync → Waiting → Process → Ready; upload → Waiting → Process now.
- Light and dark themes; 1440, 834 and 390 px widths (off-canvas sidebar, overlay panels, card rows, bottom-sheet dialogs).
- Home and Finx (4 Finx personas + Northwind): all routes with forced Empty/Loading/Error; 41 prototype journeys open the right screen; topic card → filtered Browse; document card → Reader; suggested question → cited answer; Search → Browse; role and workspace switching; 834 and 390 px without horizontal overflow; dark theme; persistence with real `localStorage`; 0 console errors.
- Knowledge Hub (every persona): all Knowledge routes with forced Empty/Loading/Error; search → Browse → preview → Reader → in-place Ask with cited, highlighted passages → Save → Library; Add to a new collection; a lead links a resource to another space; saved items, collections, views and recents survive a reload.
- Document lifecycle (Finx Engineer/Lead/Analyst/Admin, Northwind member/admin/operator): every Knowledge, Documents, Reader and Indexing route renders with forced Empty/Loading/Error; the engineer contributes with the dialog → Analyzing → In review (absent from Browse) → the lead approves in Review → Publishing → Published → it appears in the engineer's Browse and Inbox; changes requested → revise → resubmit; new version merges into the original (version increments); proposed topic accepted; duplicate compare; bulk approve skips personal data; Undo restores; reviewers see only their bases; the indexing page contains no document titles; lifecycle changes survive a reload (real `localStorage`); review list/detail on a 390 px phone.
