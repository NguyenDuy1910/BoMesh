# BoMesh screen inventory

Routes are hash routes (`ux-preview.html#/knowledge`). **Primary** is the one dominant action; secondary actions live in toolbars, row menus and drawers. Every list/table screen supports forced Loading, Empty and Error states via `gate()`.

## Sign-in and workspace selection — `features/auth.js`

| Route | Purpose | Primary | Also | Notes |
| --- | --- | --- | --- | --- |
| `/signin` | Authenticate | Sign in | Continue with Google, show password, Forgot password, Create account, demo fill-in | Email or username + password `demo`; generic error on failure; aside shows one grounded-answer example (hidden on phones). All auth pages have a language picker next to the logo |
| `/signup` | Create an account | Create account | Sign in instead (prefills email) | Name, work email, password strength meter + rules, terms; duplicate-email error; new accounts land on "No workspace yet" |
| `/workspaces` | Choose the active workspace | Open workspace | Search (> 3), Platform console (operators), Sign out | Sorted by last opened |

## Member — `features/home.js`, `chat.js`, `chat-files.js`, `conversations.js`, `projects.js`, `inbox.js`, `search.js`

| Route / surface | Purpose | Primary | Also | Notes |
| --- | --- | --- | --- | --- |
| `/home` | Intent-driven entry (core, every workspace; first sidebar item and the post-sign-in route) | The box: Find documents or Ask AI (Enter runs the highlighted one) | Suggestions while typing (matching documents, earlier questions) or on an empty box (recent questions, role questions); scope menu (workspace, a knowledge base, a space); suggested questions on a first visit; Pick up where you left off / Waiting for you (≤ 4: changes requested, reply needed, due soon, review queue, recent documents); Worth knowing (≤ 3 source-backed changes); Start here / Recommended for you (≤ 3, with reasons; Manage featured for admins); Explore by topic → Knowledge filtered | Design: [HOME.md](HOME.md). Sections without data are omitted. Skeleton while loading; forced Empty explains there is no published knowledge yet |
| `/chat` | Start a conversation | Send | Scope (knowledge bases you can read), attach, starters | Welcome and starters come from the published assistant settings |
| `/chat/:id` | Read and continue a grounded conversation | Send follow-up | Copy, retry (variants), feedback with reason, download answer, Share, rename, delete, Stop | Work steps (respect preference), inline citations, source chips; unreadable evidence replaces the answer with a no-access message |
| Citation panel | Verify a claim | Open document | Prev/next, copy citation | Side panel; overlays below 1024 px |
| File panel | Inspect and change a generated file | Ask for changes | Edit, Preview/Changes/History, restore, download | Every change is a new version |
| Share dialog | Share a conversation link | Copy link | Who can open | Recipients only open sources they can access |
| Product tour | First-run orientation | Next | Back, Skip | 4 anchored steps; Escape ends |
| Sidebar: Projects · Recent | Organise and continue AI work | Open a chat | + New project (name only); folder expand/collapse with its chats and *New chat*; ⋯ Rename / Delete project (chats return to Recent, Undo); conversation ⋯ Rename / Move to project / New project… / Remove from project / Delete | Each conversation appears once (its project or Recent); ⋯ shows on hover or focus, always on touch; the folder holding the open chat expands |
| `/project/:id` | Start and continue chats with shared context | Send (new chat in the project) | Knowledge references (add from Knowledge, remove with Undo, ≤ 10, attached to every new chat); chats with ⋯; Rename / Delete | No dashboard, tasks or files of its own: Knowledge stays the source of truth; references the caller can't open are never shown or attached |
| `/chats` | Find any past conversation | New chat | Search, sort, rename, move to project, delete with Undo | Not in the sidebar: *All* next to Recent and ⌘K open it. Table → card rows on phones |
| `/inbox` | Act on what needs you | Item's inline action (Approve, Reconnect, Open) | All/Unread, Mark all read, dismiss with Undo, Notification settings | Not in the sidebar (⌘K, links from Home and notifications); items per persona |
| `/search?q=` | Full search results across the workspace | Open result | Ask the assistant, tabs per type with counts, See all in Browse | Resources come from the catalog search (same ranking and permissions as Browse); also knowledge bases, collections, conversations, people (admins) |

## Knowledge — `features/resources.js` (shared), `hub.js`, `library.js`, `knowledge.js`, `reader.js`, `documents.js`; model `core/catalog.js`

Concept and IA: [KNOWLEDGE_HUB.md](KNOWLEDGE_HUB.md). Every Knowledge page shares one header (title, *Demo data* chip in demo workspaces, section tabs Browse · My library · Knowledge bases). Discovery (topics, collections, featured, recent) lives on Home.

| Route / surface | Purpose | Primary | Also | Notes |
| --- | --- | --- | --- | --- |
| `/knowledge` (Browse) | Discover and judge documents | Open a document (quick preview → Open) | One search field (Ask AI once there is a query); topic shortcuts (domains, then topics); Continue reading (landing); grid or list; sort; Filters drawer (Saved views, Topic tree, Space, Type, Owner, Source, Knowledge base, Trust, Updated, Format, Language, with disjunctive counts); removable chips; Save view; Ask about these (filtered, no query); quick preview drawer | The URL is the result set (`q, topic, space, kind, owner, src, kb, trust, upd, fmt, lang, saved, sort, view`); legacy `/knowledge/browse` redirects here. Cards preview each document's most useful section (the matching one when searching). Quick preview ≥ 760 px; phones open the Reader. Accent-insensitive search. Locked bases appear only as a note linking to Knowledge bases. See [KNOWLEDGE_HUB.md](KNOWLEDGE_HUB.md#browse-content-first) |
| `/knowledge/library` | My knowledge | New collection | Tabs: Saved (search, sort, bulk add to collection / remove) · Recent (Today / This week / Earlier, clear with Undo) · My files (upload, process) · Collections (yours, shared with you) · Saved views (open, rename, delete with Undo) | Per user, per workspace |
| `/knowledge/collections/:id` | Use a curated reading list | Ask about this collection | Use in… (workflow with all items), Edit (name, description, sharing), Edit items (reorder, notes, remove with Undo, Add resources from the catalog), Copy link, Duplicate, Archive with Undo | Sharing: only me / a space I run / everyone (admins). Items the viewer can't open show only as a count |
| `/knowledge/bases` | Governed homes and access | Create knowledge base (managers) | Search, access filter, sort, Request access on locked bases | My files first; restricted bases visible but locked |
| Create knowledge base | Create a governed home | Create | Space (optional) | Duplicate-name validation; opens the empty base |
| Request access | Ask for Viewer/Editor | Send request | — | Reason required; card becomes Pending |
| `/knowledge/:id?tab=documents` (Resources) | One base's resources | Ask (Contribute for contributors) | Resource list for every role with search, sort, paging, Browse with filters; for the base's reviewers one alert (in review · couldn't be published) with Manage in Documents | Header shows owner unit, topics, access, space. Review, publishing and the document inventory live in Manage → Documents |
| `…?tab=sources` · `…?tab=access` · `…?tab=settings` | Sources feeding the base · who can see it · identity and archive | Connect source · Share · Save | Source drawer; general access, roles, requests; typed archive with Undo | Managers / owners only; last owner protected |
| Contribute dialog | Share a document (or keep it private) | Submit for review | Drop / browse / samples with type and size validation, Share as knowledge vs Keep private in My files, knowledge base ("Let the assistant suggest" or a base), optional note; new-version mode with required "What changed?" | Upload progress, then Analyzing → In review; toast Track (or Review now for reviewers of that base). Nothing is published without review |
| `/knowledge/library?tab=contributions` | Track what I shared | Row's action (Revise · Withdraw · Open · Remove) | Filters All · Needs your action · In review · Published · Not approved, search; contribution drawer with lifecycle, timeline, the reviewer's messages, the assistant's suggestions, revise form (new file + what changed) | `?open=<id>` opens the drawer; Inbox notices for changes requested, not approved, approved, published |
| `/doc/:id` (Reader) | Read, understand and use a resource | Ask (in-place) | Save, Add to collection, Use in… (workflows), download, outline, rail tabs Ask · About · Related, ask/copy a selection, prev/next highlight | Trust and demo chips; banner only for Review due / changed at source / older version (`?v=`). Ask answers cite passages that highlight in the page; Continue in chat. About = type, topics, spaces, owner, base, source path, trust, version history, language, who can see it. Related = similar resources, collections that include it, conversations that cite it. `?q=&page=&from=` keeps chat citation deep links. Not-ready, no-access (Request access) and not-found states |
| Shared resource actions | Act on any resource anywhere | — | Save, Add to collection (pick or create), Ask about it, Use in…, Copy link, Download; editors: Edit details (title, type, topics, owner, language, summary), Link to spaces, Mark as verified, Archive; admins: Feature on Home / Remove from Home | One row/card component and one ⋯ menu everywhere |

## Workspace admin — `features/overview.js`, `curation.js`, `governance.js`, `sources.js`, `connections.js`, `people.js`, `assistant.js`, `activity.js`, `settings.js`

| Route / surface | Purpose | Primary | Also | Notes |
| --- | --- | --- | --- | --- |
| `/overview` | What needs me | Each attention item's fix | Documents waiting for review, documents that couldn't be published, re-verification due, syncs, access requests; KPI cards (link to their pages), 30-day questions chart, knowledge gaps (Contribute, dismiss with Undo) | "Everything is running" when nothing needs attention |
| `/sources?tab=sources` | Keep knowledge in sync | Connect source | Sync now, Pause/Resume, Edit schedule, publishing policy (Publish automatically / Send to review first), Disconnect; alerts with Reconnect / Sync now / Publish all waiting | Sync registers documents; trusted sources wait to publish, review-policy sources send new and changed files to the review queue |
| Connect source wizard | Create a source | Continue → Connect | Back, request unavailable apps | App → Account → Content (tri-state tree) → Destination + schedule + publishing policy (default Send to review first) |
| Source drawer | Manage one source | Sync now / Publish | Cancel, account switch, schedule form, publishing policy with Undo, recent syncs, disconnect | Shows waiting-to-publish count |
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
| `/documents?tab=review` | Decide on submissions (reviewers: owners of the target base; admins all) | Approve & publish | Queue (search; All · Flagged · New versions · From sources; base filter; select for bulk) + detail: note to reviewers, first-page preview, Open full preview, the assistant's type / topics / proposed topics / knowledge base (who will see it) / summary, flags (Compare duplicate, publish as new version, personal data, format); Request changes · Decline (message required, quick replies) | Auto-advance, Undo, J/K; bulk approve skips personal-data items; phones show list then full-screen detail |
| `/documents?tab=all` | Every curated document's lifecycle | Row fix (Publish now · Retry · Replace file · Publish again) | Filters lifecycle / base / source / type, search, sort, bulk Publish · Unpublish · Archive; drawer with timeline, details and actions by state | Alert when documents couldn't be published |
| `/documents?tab=quality` | Keep published knowledge trustworthy | Row fix (Verify · Republish · Add topic · Compare) | Segments: Due for re-verification · Missing details · Possible duplicates | Legacy `/knowledge-health` lands here |
| `/documents?tab=topics` | Own the taxonomy | Accept (proposed topic) | Proposed by the assistant (rename, choose domain, Accept / Merge into… / Dismiss, linked submissions); domains and topics with published and in-review counts; add, rename, archive unused | Admins only change topics; reviewers read-only |
| `/settings?tab=setup` | Configure the workspace for its domain | Template / module switches | Space types, AI workflows, reset to defaults | Changes apply to navigation immediately, with Undo; module routes show a "not on" page when off |

## Optional modules — `features/spaces.js`, `work.js`, `work-learning.js`, `work-research.js`, `requests.js` (module-gated; on in Finx Workspace)

| Route / surface | Purpose | Primary | Also | Notes |
| --- | --- | --- | --- | --- |
| `/spaces` | Find my teams, projects and offices | Create space (knowledge managers/admins) | Tabs Mine + one per space type; request to join; send a request (offices) | Space types come from the workspace (Finx: team, project, office) |
| `/space/:id` | Work inside one context | Ask about this space (members); New (staff); New request (office visitors) | Ask <space name> (escalate a question to the space's staff), tabs Overview · Materials · Work · Questions/Requests (staff) · People · Settings | Announcements, Up next, workflow cards, request catalog |
| `/work` | My AI-made work | New (workflow menu) | Search, type/space filters, Mine / Shared with me | Empty state explains each workflow |
| `/work/new` | Make something from materials | Generate | Stepper: workflow → materials (space docs, search, select all) → options + title | Prefill from `workflow`, `space`, `docs` |
| `/work/:id` evidence review | Compare options with evidence | Draft from this review | Add source, add criterion, synthesize, cell evidence drawer, export CSV | Sticky source column; horizontal scroll (Finx: event streaming platforms → Decision record) |
| `/work/:id` draft | Write grounded documents | Mark ready for review | Formatting, autosave, Ask for changes, versions with restore, sources rail, download | Citations stay linked |
| `/requests` | Track and handle requests | New request | My requests; Queue (staff) with SLA, filters, assign | Needs-reply and overdue emphasis |
| `/requests/new` | Ask an office or team | Send request | Catalog; rule check with policy citations against the requester's profile (e.g. `has` Secure coding training before production access); form validation | Failing hard rules block sending and offer "Ask the office instead" |
| `/requests/:id` | Resolve one request | Reply (requester) / Approve · Ask for information · Decline · Answer (staff) | Withdraw, assign, add answer to the space FAQ | FAQ answers become cited knowledge and close matching gaps |
| Ask <space> dialog | Escalate a question to a space's staff | Send question | Includes what the assistant already found | Lands in the space's Questions queue |

The Campus template additionally offers study guides and quizzes (`work-learning.js`); no demo workspace uses it.

## Platform operator — `features/platform.js` (every page carries a `Preview` chip)

| Route / surface | Purpose | Primary | Also | Notes |
| --- | --- | --- | --- | --- |
| `/p/workspaces` | Operate workspaces | Create workspace | KPIs, search, status filter, drawer (usage, admins, open, copy URL, suspend/reactivate) | New workspace: Setting up → Active |
| `/p/users` | Accounts across workspaces | Open user | Role/status filters, drawer (memberships, platform admin switch, suspend) | Cannot change your own account |
| `/p/connectors` | Connector availability | Configure / Enable | Demand list for unavailable connectors | Disabling confirms |
| `/p/indexing` | Indexing health without content access | Pause / Resume, Retry failed | Per-workspace queue, published 24 h, failure rate, median time, status; workspace drawer with error classes; errors by class; recent jobs (id, workspace, type, size, step, error class); platform policies (types, size, OCR, spreadsheets, review required (locked), retention) with savebar | Banner: job metadata only. Nav badge = degraded + paused workspaces |
| `/p/usage` | Demand by workspace | Export CSV | 7/30/90 days, sortable table with share of total | — |
| `/p/audit` | Cross-workspace events | Export CSV | Search, window, workspace and outcome filters, event drawer | — |
| `/p/health` | Service health and impact | Refresh | Expandable service notes, AI capabilities (deployment setting names, read-only), incidents | Banner when degraded |

## Global surfaces — `scripts/core/`

| Surface | Purpose | Notes |
| --- | --- | --- |
| Sidebar | Navigation | Workspace switcher + search, Home · Knowledge (· Work · Requests when on), Projects (folders) and Recent (chats in no project), Spaces when on, Manage (permission-filtered), account button; off-canvas below 1024 px. Inbox and All conversations are reached from ⌘K |
| Topbar | Location | Sidebar toggle, breadcrumbs, page-provided actions |
| Command palette (⌘K) | Search and act | Ask, conversations, resources (catalog search), Browse for the query, collections, knowledge bases, people, spaces, work, pages, actions (incl. New collection), See all results |
| Account menu / Preferences | Personal settings | Name, appearance (mode + current theme, opens the Appearance drawer), language (English / Tiếng Việt, applies at once), show work steps, email notifications; the account menu also lists Language |
| Appearance drawer | Personal theme for the whole app | Mode; gallery of 18 named themes; customize accent (18 swatches + custom hue), background tint, corner radius, font; Reset to BoMesh. Clear backdrop: the app re-themes live behind it |
| Toasts, confirm, tooltips | Feedback | Undo where reversible; typed confirmation where destructive |
| Prototype bar | Review controls (outside the product) | Persona, forced state, mode and quick themes, interface language (EN/VI), device width, journeys, design system, reset |
| `/design` | Living design-system gallery | Rendered with the same builders as the product |

## Mock data

Northwind (Enterprise): two member workspaces (+6 platform-only), three personas, 15 members, 4 roles, 7 groups, 7 knowledge bases (one restricted and locked for members, one hidden), ~100 documents in every processing state with topics (People, Sales, Product, Finance, Legal, Engineering), verification, one duplicate, 2 collections, saved/recent/views for the member, 2 connected accounts (one expired), 4 sources, sync history, 3 pending access requests, audit events, sign-ins, 9 conversations (two fully grounded, one with a generated spreadsheet), knowledge gaps, platform users, connectors, AI capabilities and services.

Finx Workspace (`data/finx.js`, `data/knowledge.js`, `data/contributions.js`, all fictional and marked *Demo data*; see [FINX_WORKSPACE.md](FINX_WORKSPACE.md)): four personas (Engineer, Lead, Analyst, Admin), 16 members, 4 roles, 6 groups, 9 knowledge bases (one restricted and locked, one personal), about 250 documents from Confluence, SharePoint, Google Drive and GitHub sources, a 6-domain / 27-topic taxonomy, verification with expired and changed-at-source items, 3 duplicate pairs, featured documents for Home, 5 collections, saved/recent/views per persona, 5 spaces (2 teams, 1 project, 2 offices), 8 events, 3 works (one evidence review, two drafts), 4 request types and 8 requests, 8 conversations, contribution queue seeds, knowledge gaps.

Workspace-owned data is stored per workspace; changes persist in `localStorage` until reset.

## Acceptance per route

1. Direct hash navigation renders from `file://`.
2. Sidebar, breadcrumbs, palette and in-page links reach the same route.
3. Unpermitted routes show a no-access state without data.
4. Loading, Empty and Error can be forced; no-results can be cleared.
5. The primary action changes local data before its toast.
6. Overlays close with their close action and Escape; focus returns to the trigger.
7. Usable in light and dark at 1440, 1024, 834 and 390 px.
