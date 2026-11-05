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
| Accent/background/density theming options | One personal theme re-themes the whole app (HeroUI Theme Builder dimensions): 18 named themes, accent swatches + custom hue, background tint (Base), radius, font, light/dark/system. Density stays removed; status and evidence colors stay fixed |
| Prototype bar overlapping the product | The bar owns a band below the product; overlays are contained by the app frame |
| Breakpoints based on the browser window | Container queries on the app frame, so the bar's tablet/phone previews exercise real rules |
| Uploads and syncs processed automatically in some flows | Aligned with `backend/docs_design`: syncs and uploads only change the inventory (Waiting); processing is explicit (Process); scheduled syncs sync then process |
| A knowledge chatbot can't help people finish the work that follows (decisions, reviews, paperwork) | Optional outcome modules — Spaces, Work, Requests — switched on per template or workspace, keeping one shell, one design system and one data model; code asks `hasModule()` rather than "is this workspace X?" |
| Workspace data was global; one demo company | Data is scoped per workspace behind the same `D` interface; personas belong to workspaces; the prototype bar switches workspace and persona |
| Answers ended the interaction | Answers carry next-step actions (start a request, draft a document, compare options, ask a space's staff); unanswerable questions become knowledge gaps and space questions whose answers become FAQ knowledge |
| Knowledge was a container drill-down (base cards → document table) with a separate flat Documents list and search page | One Knowledge Hub: Browse (one faceted catalog, URL state) · My library · Knowledge bases, plus the Reader; discovery lives on Home. See [KNOWLEDGE_HUB.md](KNOWLEDGE_HUB.md) |
| Readers saw Waiting/Processing/Failed; nothing said whether a document could be trusted | Readers see trust (Verified, Review due, Not verified) and freshness; publishing problems live in Manage → Documents |
| Uploading put a file straight into a knowledge base; anyone with edit rights effectively published it | Contribution, curation and publication are separate: Contribute → review (Manage → Documents) → Approve & publish. Only published content reaches search, the Reader and the assistant. See [DOCUMENT_LIFECYCLE.md](DOCUMENT_LIFECYCLE.md) |
| Curation was scattered across knowledge-base inventories, Knowledge health and Sources | One Documents page for reviewers: Review · All documents · Quality · Topics. Knowledge-base pages are about reading and access again |
| Platform admins had the same content access as workspace admins to see processing problems | Platform → Indexing shows job metadata only (ids, workspace, file type, step, error class) |
| Asking about a document left the document | The Reader keeps an Ask rail beside the page; answers cite passages that highlight in place; *Continue in chat* when needed |
| Realistic company records could be mistaken for real policy | Demo workspaces (`ws.demo`, e.g. Finx) carry a *Demo data* chip in the Knowledge header and the Reader |
| Enterprise opened on an empty chat; Knowledge opened on a separate landing tab | Home is the core, knowledge-first landing in every workspace: search/ask, explore, featured, recent and recommended, where you left off. Knowledge now opens on Browse. See [HOME.md](HOME.md) |

## Sign-in and workspace selection

| Route | For | Main action | Needs to see | Next | Changed |
| --- | --- | --- | --- | --- | --- |
| `/signin` | Returning user | Sign in | Credentials, Google, recovery | `/workspaces` or `/home` | Marketing panels and trust lists replaced by one grounded-answer example |
| `/signup` | New user | Create account | Fields and password rules | No-workspace state → ask an admin | Optional username removed; strength meter added |
| `/workspaces` | Multi-workspace user | Open workspace | Name, role, members, last opened | `/home` | Sorted by last opened |

## Member

| Route | For | Main action | Needs to see | Next | Changed |
| --- | --- | --- | --- | --- | --- |
| `/home` | Everyone, every workspace | Ask (Search → Browse beside it) | Search/ask with scope and suggested questions; topics, bases and collections; featured documents with thumbnails; recently published and recommended (with reasons); recent documents, conversations, contributions, review line, Up next | Chat, Browse (filtered), Reader, collection, request | Replaces New chat as the landing and the old Knowledge landing tab; no metrics. See [HOME.md](HOME.md) |
| `/chat` | Asking | Send | Composer, scope, ≤ 3 starters | Conversation | Disclaimer line and decoration removed |
| `/chat/:id` | Reading and verifying answers | Follow-up | Answer, citations, sources, work steps (optional) | Citation panel → document | Share and conversation menu moved to the topbar; "Files in this chat" panel dropped (file cards suffice) |
| `/chats` | Finding a conversation | New chat | Title, last line, updated | Conversation | Table with rename/delete + Undo |
| `/inbox` | Acting on notifications | Item's own action | Title, one-line context, time, unread | The item's page | Page instead of drawer; inline Approve/Deny/Reconnect |
| `/search` | Full results | Open result | Grouped results with snippets | Resource, base, collection, conversation | Resources come from the catalog search; *See all in Browse* |

## Knowledge

| Route | For | Main action | Needs to see | Next | Why this shape |
| --- | --- | --- | --- | --- | --- |
| `/knowledge` (Browse) | Finding the right resource among thousands | Open | Results with type, base, source, trust, freshness, summary or snippet; counts per facet | Preview → Reader; Save view; Ask about these results | One catalog replaces `/documents`, base tables, document search and the old landing tab (`/knowledge/browse` redirects). Disjunctive facets let people widen and narrow; the URL is shareable |
| `/knowledge/library` | Keeping what I found and what I shared | New collection (Contribute next to it) | Saved, recent, my contributions with their status and the latest reviewer message, my files, my collections, saved views | Reader, collection, contribution drawer, Browse | Personal state finally has a home; contributions sit here instead of a new nav item |
| Contribute dialog | Sharing a document | Submit for review | Drop zone, Share as knowledge / Keep private, knowledge base (assistant can suggest), optional note | Contributions, Review (reviewers) | One file and at most one choice; reviewers fix classification, not contributors |
| `/knowledge/collections/:id` | Using or curating a reading list | Ask about this collection | Ordered items with the curator's notes; who it's shared with | Reader, Use in… a workflow | References, not copies; never grants access, so curation can't leak restricted titles |
| `/knowledge/bases` | Understanding ownership and access | Create knowledge base | Owner, access, size, locked bases | Base, Request access | Bases stay as the governed home, one tab away instead of the front door |
| `/knowledge/:id` | Managing a base (editors) / reading one base (readers) | Ask (Add files for editors) | Readers: resources. Editors: inventory with processing, one alert for problems | Reader, drawer, sources, access | Index status is shown only to editors |
| `/doc/:id` | Reading and understanding | Ask (in place) | The page, cited passages, trust, provenance, versions, related resources | Save, collection, Use in…, Continue in chat | AI beside the page keeps reading context; trust replaces pipeline states; provenance and versions in About |

## Workspace admin

| Route | For | Main action | Needs to see | Next | Changed |
| --- | --- | --- | --- | --- | --- |
| `/overview` | "What needs me?" | Each attention item's fix | Attention list, 4 KPIs, 30-day trend, knowledge gaps | Sources, People, Knowledge | Greeting, setup checklist, health meter and recent-activity feed removed |
| `/sources` | Keeping knowledge in sync | Connect source | Source, destination, schedule, last sync, status; problems as alerts | Source drawer, wizard, history | Accounts tab moved to Connections; explicit Process restored |
| `/connections` | Account health | Connect account | Account, status, last check, dependent sources | Reconnect | New destination |
| `/people` | Membership and authorization | Add people | Person, role, groups, last active, status | Member/group/role drawers, requests | Renamed from People & access; authorization rail removed |
| `/assistant` | Configuring the assistant | Publish | Instructions, style, capabilities, chat home, live preview | Members' chat home | Two tabs merged into one form |
| `/activity` | Investigating | Export CSV | Time, person, action, target, outcome | Event drawer → related page | — |
| `/documents` | Curating and publishing (base owners; admins all) | Approve & publish (Review); each row's fix elsewhere | Review: queue + preview + the assistant's suggestions with confidence + flags. All documents: lifecycle per document with filters and bulk actions. Quality: re-verification, missing details, duplicates. Topics: taxonomy + proposed topics | Next item, Reader, Sources | New. Replaces Knowledge health and the per-base inventory; decisions auto-advance with Undo; J/K keyboard |
| `/p/indexing` | Operating indexing without content access | Pause/Resume or Retry | Per-workspace queue, throughput, failure rate, status; error classes; recent jobs; policies | System health, workspace drawer | New. No document names or content anywhere |
| `/settings` | Workspace identity and setup | Save | Name, address, ID; template, modules, space types, workflows; danger zone | Navigation reflects modules at once | Brand tab removed; Workspace setup added |

## Optional modules (on in Finx Workspace)

| Route | For | Main action | Needs to see | Next | Why this shape |
| --- | --- | --- | --- | --- | --- |
| `/spaces` | Finding contexts | Create space | My teams, projects, offices; join or request | Space | Space types come from the template/workspace (Finx: team, project, office) |
| `/space/:id` | Working in a team, project or office | Ask about this space | Announcements, Up next, materials, work, queue (staff) | Workflow, request, chat | One context instead of separate wiki, drive and email threads |
| `/work` + `/work/new` | Making reviews and drafts | Generate | Which workflow, which materials, two or three options | The new work | Workflows are short and grounded in chosen materials; no blank-page prompting |
| `/work/:id` (review, draft) | Lead comparing options / engineer writing a decision record | Draft from this review / Mark ready for review | Cited evidence per cell; sources and versions beside the text | Decision record or evidence summary, review | Evidence first, then writing; every claim stays traceable |
| `/requests` | Requester / office staff | New request / work the queue | Status, what needs my reply / SLA and assignee | Request thread | One queue replaces forms and email; staff see overdue first |
| `/requests/new` | Employee who needs access or approval | Send request | Whether the policy allows it (e.g. Secure coding training before production access), with the policy cited; only the fields needed | Thread | Rule check before sending removes back-and-forth and wrong submissions |
| `/requests/:id` | Both sides | Reply / Approve · Ask for info · Decline · Answer | Thread, details, recorded checks | Inbox notification; FAQ | Answers to space questions become knowledge for the next person |

The Campus template (study guides, quizzes) is available on the platform but has no demo workspace.

## Platform console

| Route | For | Main action | Needs to see | Next | Changed |
| --- | --- | --- | --- | --- | --- |
| `/p/workspaces` | Operating workspaces | Create workspace | Status, owner, size, demand | Workspace drawer | Provisioning rail and row menus removed |
| `/p/users` | Account administration | Open user | Workspaces, platform role, status | User drawer | — |
| `/p/connectors` | Connector availability | Configure / Enable | Status, adoption, demand | Configure drawer | OAuth secret editing removed |
| `/p/usage` | Demand | Export CSV | Totals with trend, per-workspace share | — | — |
| `/p/audit` | Cross-workspace investigation | Export CSV | Event list with filters | Event drawer | — |
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
