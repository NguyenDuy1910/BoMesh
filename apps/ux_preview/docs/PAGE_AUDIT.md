# BoMesh page audit

Each screen answers four questions: **what is it for**, **what is the main action**, **what does the user actually need to see**, and **what comes next**. The "Changed" column records what the HeroUI redesign added or removed against the previous prototype.

## Cross-product decisions

| Finding in the previous prototype | Decision |
| --- | --- |
| A custom visual system loosely inspired by HeroUI; components drifted per page | HeroUI v3 tokens (Theme Builder export) and HeroUI component anatomy/BEM names for every element; screens compose only `ui.js` builders |
| 6,000-line single script with monkey-patched layers | Core (state, router, builders, overlays, shell) + one isolated module per product area, loaded as ordered classic scripts so `file://` still works |
| Lifecycle rails, review notes, per-button `Preview` tags and explanatory paragraphs on most pages | Removed. Status chips + one alert carrying the fix replace rails; `Preview` is a single header chip on proposal-only pages |
| Inbox as a drawer, Connections hidden in a Sources tab, Documents only inside knowledge bases | Inbox and Connections are first-class destinations; knowledge is found through the Knowledge Hub (below) |
| Review index as the landing page; page-audit side panel | Opening the prototype lands in the product (`/chat`); review tooling is limited to the prototype bar |
| Accent/background/density theming options | Accent and density removed (the HeroUI accent is the brand); the background stays switchable as HeroUI "Base" presets (Green, Neutral, Slate, Violet, Sand) with light/dark/system |
| Prototype bar overlapping the product | The bar owns a band below the product; overlays are contained by the app frame |
| Breakpoints based on the browser window | Container queries on the app frame, so the bar's tablet/phone previews exercise real rules |
| Uploads and syncs processed automatically in some flows | Aligned with `backend/docs_design`: syncs and uploads only change the inventory (Waiting); processing is explicit (Process); scheduled syncs sync then process |
| A knowledge chatbot can't help people finish university work (studying, assessing, research, paperwork) | Campus template adds outcome modules — Home, Spaces, Work, Requests — while keeping one shell, one design system and one data model; code asks `hasModule()` rather than "is this UTE?" |
| Workspace data was global; one demo company | Data is scoped per workspace behind the same `D` interface; personas belong to workspaces; the prototype bar switches workspace and persona |
| Answers ended the interaction | Answers carry next-step actions (start a request, study guide, literature review, ask the teaching team); unanswerable questions become knowledge gaps and teaching-team questions whose answers become FAQ knowledge |
| Knowledge was a container drill-down (base cards → document table) with a separate flat Documents list and search page | One Knowledge Hub: Discover · Browse (one faceted catalog, URL state) · My library · Knowledge bases, plus the Reader. `/documents` redirects to Browse. See [KNOWLEDGE_HUB.md](KNOWLEDGE_HUB.md) |
| Readers saw Waiting/Processing/Failed; nothing said whether a document could be trusted | Readers see trust (Verified, Review due, Not verified) and freshness; index status only for the base's editors; governance lives in Manage → Knowledge health |
| Asking about a document left the document | The Reader keeps an Ask rail beside the page; answers cite passages that highlight in place; *Continue in chat* when needed |
| Realistic university records could be mistaken for real policy | UTE is marked as demo data in the Knowledge header and Reader, and every UTE rendition carries a demo footer |

## Sign-in and workspace selection

| Route | For | Main action | Needs to see | Next | Changed |
| --- | --- | --- | --- | --- | --- |
| `/signin` | Returning user | Sign in | Credentials, Google, recovery | `/workspaces` or `/chat` | Marketing panels and trust lists replaced by one grounded-answer example |
| `/signup` | New user | Create account | Fields and password rules | No-workspace state → ask an admin | Optional username removed; strength meter added |
| `/workspaces` | Multi-workspace user | Open workspace | Name, role, members, last opened | `/chat` | Sorted by last opened |

## Member

| Route | For | Main action | Needs to see | Next | Changed |
| --- | --- | --- | --- | --- | --- |
| `/chat` | Asking | Send | Composer, scope, ≤ 3 starters | Conversation | Disclaimer line and decoration removed |
| `/chat/:id` | Reading and verifying answers | Follow-up | Answer, citations, sources, work steps (optional) | Citation panel → document | Share and conversation menu moved to the topbar; "Files in this chat" panel dropped (file cards suffice) |
| `/chats` | Finding a conversation | New chat | Title, last line, updated | Conversation | Table with rename/delete + Undo |
| `/inbox` | Acting on notifications | Item's own action | Title, one-line context, time, unread | The item's page | Page instead of drawer; inline Approve/Deny/Reconnect |
| `/search` | Full results | Open result | Grouped results with snippets | Resource, base, collection, conversation | Resources come from the catalog search; *See all in Browse* |

## Knowledge

| Route | For | Main action | Needs to see | Next | Why this shape |
| --- | --- | --- | --- | --- | --- |
| `/knowledge` (Discover) | Starting to look | Search | What I was reading, what's new in my spaces, the topic map, curated collections | Browse, Reader, collection | Replaces the knowledge-base card grid: people search and explore by subject, not by container. No metrics |
| `/knowledge/browse` | Finding the right resource among thousands | Open | Results with type, base, source, trust, freshness, summary or snippet; counts per facet | Preview → Reader; Save view; Ask about these results | One catalog replaces `/documents`, base tables and document search. Disjunctive facets let people widen and narrow; the URL is shareable |
| `/knowledge/library` | Keeping what I found | New collection | Saved, recent, my uploads, my collections, saved views | Reader, collection, Browse | Personal state finally has a home |
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
| `/knowledge-health` | Keeping knowledge trustworthy | Each row's fix (Verify, Reprocess, Add topic, Compare) | What's stale, what's missing details, likely duplicates, the taxonomy | Reader, Edit details, Sources | New. Governance moved out of reader pages; one summary sentence instead of metric cards |
| `/settings` | Workspace identity and setup | Save | Name, address, ID; template, modules, space types, workflows; danger zone | Navigation reflects modules at once | Brand tab removed; Workspace setup added |

## Campus modules (UTE Campus)

| Route | For | Main action | Needs to see | Next | Why this shape |
| --- | --- | --- | --- | --- | --- |
| `/home` | Everyone | Ask | What's due (each with one action), where I left off, what needs me (staff) | Quiz, request, space, chat | Replaces a dashboard: no metrics, only the next thing to do |
| `/spaces` | Finding contexts | Create space | My courses, labs, offices; join or request | Space | Space types come from the template, so the same page lists Teams/Projects for Enterprise |
| `/space/:id` | Working in a course, lab or office | Ask about this space | Announcements, Up next, materials, work, queue (staff) | Workflow, request, chat | One context instead of separate LMS, drive and email threads |
| `/work` + `/work/new` | Making study guides, quizzes, reviews, drafts | Generate | Which workflow, which materials, two or three options | The new work | Workflows are short and grounded in chosen materials; no blank-page prompting |
| `/work/:id` (quiz) | Lecturer assessing / student learning | Publish / Start quiz | Questions with answer keys and sources / one question at a time, then explanations | Results → explain in class; missed → study guide | Closes the teach–assess–revise loop |
| `/work/:id` (review, draft) | Researcher | Draft related work / Mark ready for review | Cited evidence per cell; sources and versions beside the text | Proposal, PI review | Evidence first, then writing; every claim stays traceable |
| `/requests` | Requester / office and teaching staff | New request / work the queue | Status, what needs my reply / SLA and assignee | Request thread | One queue replaces paper forms and email; staff see overdue first |
| `/requests/new` | Student with paperwork | Send request | Whether the rules allow it, with the regulation cited; only the fields needed | Thread | Rule check before sending removes back-and-forth and wrong submissions |
| `/requests/:id` | Both sides | Reply / Approve · Ask for info · Decline · Answer | Thread, details, recorded checks | Inbox notification; FAQ | Answers to course questions become knowledge for the next student |

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
- UTE Campus: every campus route for Student, Lecturer, Researcher and Admin renders without errors; chat → "Start a withdrawal request" → rule check → send → office approves; quiz build → publish → take → results; review → draft; teaching-team question → answer → FAQ document; module toggles change navigation; per-workspace data survives a reload.
- Knowledge Hub (UTE and Northwind, every persona): all Knowledge routes with forced Empty/Loading/Error (0 problems, 0 console errors); all 36 prototype journeys open the right screen; Discover search → Browse → preview → Reader → in-place Ask with cited, highlighted passages → Save → Library; Add to a new collection; lecturer links a resource to another course and the student sees it in that course's materials; Knowledge health duplicates, review and topics; saved items, collections, views and recents survive a reload (real `localStorage`); 834 and 390 px without horizontal overflow; dark theme.
