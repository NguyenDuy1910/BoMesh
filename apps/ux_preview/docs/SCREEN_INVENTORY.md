# BoMesh screen inventory

Routes are hash routes (`ux-preview.html#/knowledge`). **Primary** is the one dominant action; secondary actions live in toolbars, row menus and drawers. Every list/table screen supports forced Loading, Empty and Error states via `gate()`.

## Sign-in and workspace selection — `features/auth.js`

| Route | Purpose | Primary | Also | Notes |
| --- | --- | --- | --- | --- |
| `/signin` | Authenticate | Sign in | Continue with Google, show password, Forgot password, Create account, demo fill-in | Email or username + password `demo`; generic error on failure; aside shows one grounded-answer example (hidden on phones) |
| `/signup` | Create an account | Create account | Sign in instead (prefills email) | Name, work email, password strength meter + rules, terms; duplicate-email error; new accounts land on "No workspace yet" |
| `/workspaces` | Choose the active workspace | Open workspace | Search (> 3), Platform console (operators), Sign out | Sorted by last opened |

## Member — `features/chat.js`, `chat-files.js`, `conversations.js`, `inbox.js`, `search.js`

| Route / surface | Purpose | Primary | Also | Notes |
| --- | --- | --- | --- | --- |
| `/chat` | Start a conversation | Send | Scope (knowledge bases you can read), attach, starters | Welcome and starters come from the published assistant settings |
| `/chat/:id` | Read and continue a grounded conversation | Send follow-up | Copy, retry (variants), feedback with reason, download answer, Share, rename, delete, Stop | Work steps (respect preference), inline citations, source chips; unreadable evidence replaces the answer with a no-access message |
| Citation panel | Verify a claim | Open document | Prev/next, copy citation | Side panel; overlays below 1024 px |
| File panel | Inspect and change a generated file | Ask for changes | Edit, Preview/Changes/History, restore, download | Every change is a new version |
| Share dialog | Share a conversation link | Copy link | Who can open | Recipients only open sources they can access |
| Product tour | First-run orientation | Next | Back, Skip | 4 anchored steps; Escape ends |
| `/chats` | Find a past conversation | New chat | Search, sort, rename, delete with Undo | Table → card rows on phones |
| `/inbox` | Act on what needs you | Item's inline action (Approve, Reconnect, Open) | All/Unread, Mark all read, dismiss with Undo, Notification settings | Items per persona; sidebar badge counts unread |
| `/search?q=` | Full search results across the workspace | Open result | Ask the assistant, tabs per type with counts, See all in Browse | Resources come from the catalog search (same ranking and permissions as Browse); also knowledge bases, collections, conversations, people (admins) |

## Knowledge — `features/resources.js` (shared), `hub.js`, `library.js`, `knowledge.js`, `reader.js`, `documents.js`; model `core/catalog.js`

Concept and IA: [KNOWLEDGE_HUB.md](KNOWLEDGE_HUB.md). Every Knowledge page shares one header (title, *Demo data* chip in demo workspaces, section tabs Discover · Browse · My library · Knowledge bases).

| Route / surface | Purpose | Primary | Also | Notes |
| --- | --- | --- | --- | --- |
| `/knowledge` (Discover) | Start finding knowledge | Search (large box → Browse) | Type shortcuts with counts, Jump back in (recent), From your spaces (Spaces on) or Recently updated, Browse by topic (domain → topic with counts), Collections, Upload, New collection | No metrics. Forced Empty offers Upload / Browse |
| `/knowledge/browse` | One catalog for search and filters | Open resource | Facets (Saved views, Topic tree, Space, Type, Owner, Source, Knowledge base, Trust, Updated, Format, Language) with disjunctive counts; list / table / grid; sort; removable filter chips; Save view; Ask about these results; preview panel | The URL is the state (`q, topic, space, kind, owner, src, kb, trust, upd, fmt, lang, saved, sort, view, sel`). Preview panel ≥ 1200 px; facets become a Filters drawer ≤ 1023 px. Accent-insensitive search with snippets. Locked bases appear only as a note linking to Knowledge bases |
| `/knowledge/library` | My knowledge | New collection | Tabs: Saved (search, sort, bulk add to collection / remove) · Recent (Today / This week / Earlier, clear with Undo) · My files (upload, process) · Collections (yours, shared with you) · Saved views (open, rename, delete with Undo) | Per user, per workspace |
| `/knowledge/collections/:id` | Use a curated reading list | Ask about this collection | Use in… (workflow with all items), Edit (name, description, sharing), Edit items (reorder, notes, remove with Undo, Add resources from the catalog), Copy link, Duplicate, Archive with Undo | Sharing: only me / a space I run / everyone (admins). Items the viewer can't open show only as a count |
| `/knowledge/bases` | Governed homes and access | Create knowledge base (managers) | Search, access filter, sort, Request access on locked bases | My files first; restricted bases visible but locked |
| Create knowledge base | Create a governed home | Create | Space (optional) | Duplicate-name validation; opens the empty base |
| Request access | Ask for Viewer/Editor | Send request | — | Reason required; card becomes Pending |
| `/knowledge/:id?tab=documents` (Resources) | One base's resources | Ask (Add files for editors) | Readers: resource list with search, sort, paging, Browse with filters. Editors: inventory table with status/type filters, bulk process/move/archive, processing alerts | Header shows owner unit, topics, access, space |
| `…?tab=sources` · `…?tab=access` · `…?tab=settings` | Sources feeding the base · who can see it · identity and archive | Connect source · Share · Save | Source drawer; general access, roles, requests; typed archive with Undo | Managers / owners only; last owner protected |
| Upload dialog | Add files to the inventory | Upload | Browse, drop, samples, destination | Documents arrive Waiting; toast offers Process now |
| Document drawer | Editors: inspect one file's processing | Open | Process/Reprocess, Replace file, download, archive | Failure reason with its fix |
| `/doc/:id` (Reader) | Read, understand and use a resource | Ask (in-place) | Save, Add to collection, Use in… (workflows), download, outline, rail tabs Ask · About · Related, ask/copy a selection, prev/next highlight | Trust and demo chips; banner only for Review due / changed at source / older version (`?v=`). Ask answers cite passages that highlight in the page; Continue in chat. About = type, topics, spaces, owner, base, source path, trust, version history, language, who can see it. Related = similar resources, collections that include it, conversations that cite it. `?q=&page=&from=` keeps chat citation deep links. Not-ready, no-access (Request access) and not-found states |
| Shared resource actions | Act on any resource anywhere | — | Save, Add to collection (pick or create), Ask about it, Use in…, Copy link, Download; editors: Edit details (title, type, topics, owner, language, summary), Link to spaces, Mark as verified, Archive | One row/card/table component and one ⋯ menu everywhere |

## Workspace admin — `features/overview.js`, `sources.js`, `connections.js`, `governance.js`, `people.js`, `assistant.js`, `activity.js`, `settings.js`

| Route / surface | Purpose | Primary | Also | Notes |
| --- | --- | --- | --- | --- |
| `/overview` | What needs me | Each attention item's fix | KPI cards (link to their pages), 30-day questions chart, knowledge gaps (Add files, dismiss with Undo) | "Everything is running" when nothing needs attention |
| `/sources?tab=sources` | Keep knowledge in sync | Connect source | Sync now, Pause/Resume, Edit schedule, Disconnect; alerts with Reconnect / Sync now / Process all | Sync registers documents as Waiting; processing is explicit (schedules sync then process) |
| Connect source wizard | Create a source | Continue → Connect | Back, request unavailable apps | App → Account → Content (tri-state tree) → Destination + schedule |
| Source drawer | Manage one source | Sync now / Process | Cancel, account switch, schedule form, recent syncs, disconnect | Shows waiting-to-process count |
| `/sources?tab=history` | Investigate syncs | Open run | Source/status filters | Run drawer: counts, steps, failures, Retry failed |
| `/connections` | Manage connected accounts | Connect account | Reconnect, Test connection, Disconnect | Secrets never shown; disconnect pauses dependent sources |
| Reconnect dialog | Restore an expired account | Sign in | Cancel | Dependent sources resume syncing |
| `/people?tab=members` | Manage membership | Add people | Search, role/status filters, inline role, bulk role/suspend | Self and last-admin guards with tips |
| Add people dialog | Add existing accounts | Add | Role, groups | Per-email validation: unknown account, already a member, invalid |
| Member drawer | One membership | Save | Groups, effective knowledge access, Suspend/Reactivate, Remove | Draft until saved |
| `/people?tab=groups` | Reusable groups | Create group | Group drawer: rename, members, shared bases, delete | — |
| `/people?tab=roles` | Capability bundles | Create role | Duplicate, delete, plain-language permission switches | Built-in roles read-only; unsaved bar |
| `/people?tab=requests` | Decide access requests | Approve | Deny, recently decided | Approve grants the share |
| `/assistant` | Configure and publish the assistant | Publish | Discard, starters add/remove/reorder | Live preview of chat home and a sample answer |
| `/activity?tab=changes` | Investigate changes | Export CSV | Search, window, area/person/outcome filters, event drawer with related link | — |
| `/activity?tab=signins` | Investigate sign-ins | Export CSV | Method/status filters | Rows open the member drawer |
| `/settings?tab=general` | Workspace identity | Save (savebar) | Copy workspace ID | Address validation and broken-links warning |
| `/settings?tab=danger` | Request archive | Archive workspace | Cancel request | Typed workspace code; `Preview` chip |
| `/knowledge-health` | Keep knowledge trustworthy (owners see their bases, admins all) | Row fix (Verify / Reprocess / Add topic / Compare) | Tabs Review (expired, changed at source, never verified; Ask owner to review; bulk verify) · Details (missing topic/owner/summary; Add topic, Suggest topics, bulk apply) · Duplicates (compare drawer, keep one and archive the other with references repointed, Not duplicates) · Topics (admins add/rename/archive unused topics and domains) | One summary sentence, no metric cards; nav badge = stale + duplicates; Overview links here when reviews are due |
| `/settings?tab=setup` | Configure the workspace for its domain | Template / module switches | Space types, AI workflows, reset to defaults | Changes apply to navigation immediately, with Undo; module routes show a "not on" page when off |

## Campus modules — `features/home.js`, `spaces.js`, `work.js`, `work-learning.js`, `work-research.js`, `requests.js` (module-gated; on in UTE Campus)

| Route / surface | Purpose | Primary | Also | Notes |
| --- | --- | --- | --- | --- |
| `/home` | Start the day | Ask (box with context select) | Workflow quick starts, Start a request, Up next with one action each, Continue, Needs you (staff) | Up next = events + unattempted quizzes + requests needing reply + queue items |
| `/spaces` | Find my courses, groups and offices | Create space (knowledge managers/admins) | Tabs Mine + one per space type; request to join (research); send a request (offices) | Courses are enrolment-driven |
| `/space/:id` | Work inside one context | Ask about this course/space (members); New (staff); New request (office visitors) | Ask the teaching team, tabs Overview · Materials · Work · Questions/Requests (staff) · People · Settings | Announcements, Up next, workflow cards, request catalog |
| `/work` | My AI-made work | New (workflow menu) | Search, type/space filters, Mine / Shared with me | Empty state explains each workflow |
| `/work/new` | Make something from materials | Generate | Stepper: workflow → materials (space docs, search, select all) → options + title | Prefill from `workflow`, `space`, `docs` |
| `/work/:id` quiz (staff) | Build and assess | Publish to the course | Edit/regenerate/remove/add questions; Results (per-question, hardest first, Explain in class) | Publish creates the course event and notifies students |
| `/work/:id` quiz (student) | Take and learn | Start quiz → Submit | Result with explanations and sources; Make a study guide on what I missed; Ask the teaching team | Practice quizzes give instant feedback |
| `/work/:id` study guide | Revise from the actual slides | Practice quiz from this | Regenerate, shorter/simpler with Undo, download | Every section cites its source |
| `/work/:id` literature review | Compare papers with evidence | Draft related work | Add paper, add criterion, synthesize, cell evidence drawer, export CSV | Sticky paper column; horizontal scroll |
| `/work/:id` draft | Write grounded documents | Mark ready for review | Formatting, autosave, Ask for changes, versions with restore, sources rail, download | Citations stay linked |
| `/requests` | Track and handle requests | New request | My requests; Queue (staff) with SLA, filters, assign | Needs-reply and overdue emphasis |
| `/requests/new` | Ask an office or teaching team | Send request | Catalog; rule check with citations against the student's record; form validation | Failing hard rules block sending and offer "Ask the office instead" |
| `/requests/:id` | Resolve one request | Reply (requester) / Approve · Ask for information · Decline · Answer (staff) | Withdraw, assign, add answer to course FAQ | FAQ answers become cited knowledge and close matching gaps |
| Ask the teaching team dialog | Escalate a course question | Send question | Includes what the assistant already found | Lands in the course's Questions queue |

## Platform operator — `features/platform.js` (every page carries a `Preview` chip)

| Route / surface | Purpose | Primary | Also | Notes |
| --- | --- | --- | --- | --- |
| `/p/workspaces` | Operate workspaces | Create workspace | KPIs, search, status filter, drawer (usage, admins, open, copy URL, suspend/reactivate) | New workspace: Setting up → Active |
| `/p/users` | Accounts across workspaces | Open user | Role/status filters, drawer (memberships, platform admin switch, suspend) | Cannot change your own account |
| `/p/connectors` | Connector availability | Configure / Enable | Demand list for unavailable connectors | Disabling confirms |
| `/p/usage` | Demand by workspace | Export CSV | 7/30/90 days, sortable table with share of total | — |
| `/p/audit` | Cross-workspace events | Export CSV | Search, window, workspace and outcome filters, event drawer | — |
| `/p/health` | Service health and impact | Refresh | Expandable service notes, AI capabilities (deployment setting names, read-only), incidents | Banner when degraded |

## Global surfaces — `scripts/core/`

| Surface | Purpose | Notes |
| --- | --- | --- |
| Sidebar | Navigation | Workspace switcher + search, member destinations, Manage (permission-filtered), Recent conversations, account button; off-canvas below 1024 px |
| Topbar | Location | Sidebar toggle, breadcrumbs, page-provided actions |
| Command palette (⌘K) | Search and act | Ask, conversations, resources (catalog search), Browse for the query, collections, knowledge bases, people, spaces, work, pages, actions (incl. New collection), See all results |
| Account menu / Preferences | Personal settings | Name, theme (light/dark/system), background (Green/Neutral/Slate/Violet/Sand), show work steps, email notifications |
| Toasts, confirm, tooltips | Feedback | Undo where reversible; typed confirmation where destructive |
| Prototype bar | Review controls (outside the product) | Persona, forced state, theme and background, device width, journeys, design system, reset |
| `/design` | Living design-system gallery | Rendered with the same builders as the product |

## Mock data

Northwind (Enterprise): two member workspaces (+6 platform-only), three personas, 15 members, 4 roles, 7 groups, 7 knowledge bases (one restricted and locked for members, one hidden), ~100 documents in every processing state with topics (People, Sales, Product, Finance, Legal, Engineering), verification, one duplicate, 2 collections, saved/recent/views for the member, 2 connected accounts (one expired), 4 sources, sync history, 3 pending access requests, audit events, sign-ins, 9 conversations (two fully grounded, one with a generated spreadsheet), knowledge gaps, platform users, connectors, AI capabilities and services.

UTE Campus (`data/ute.js`, `data/knowledge.js`, all fictional and marked *Demo data*): four personas (student, lecturer, researcher, Academic Affairs admin), 14 members, 5 roles, 5 groups, 12 knowledge bases, ~190 resources from six source systems (Google Drive regulations, Moodle LMS syllabi for 38 courses and IT3090 files, DSpace theses, SharePoint open courseware for two faculties, ute.edu.vn notices incl. Vietnamese, lab papers), a 6-domain / 23-topic taxonomy, verification with expired and changed-at-source items, 3 duplicate pairs, 5 collections, saved/recent/views per persona, 5 spaces (2 courses, 1 lab, 2 offices), 8 events, 5 works, 8 request types, 11 requests, 6 conversations, knowledge gaps.

Workspace-owned data is stored per workspace; changes persist in `localStorage` until reset.

## Acceptance per route

1. Direct hash navigation renders from `file://`.
2. Sidebar, breadcrumbs, palette and in-page links reach the same route.
3. Unpermitted routes show a no-access state without data.
4. Loading, Empty and Error can be forced; no-results can be cleared.
5. The primary action changes local data before its toast.
6. Overlays close with their close action and Escape; focus returns to the trigger.
7. Usable in light and dark at 1440, 1024, 834 and 390 px.
