# `apps/web` implementation gaps

`apps/web` already implements the `/api/v1` contract end to end (routing,
auth, workspace context, knowledge, chat, ingestion, platform console — see
`backend/docs_design/api_design.md` §1 "Implementation status"). This file
tracks what is verified working, what the backend contract itself doesn't
support yet (so the web client can't either), and one visual-fidelity gap
against the current `apps/ux_preview` design found during a full
functional pass (2026-11-08) against a live local stack (PostgreSQL, Qdrant,
RustFS, Temporal, the FastAPI backend, and a real OpenRouter model).

Do not re-litigate items already called out in
`backend/docs_design/api_design.md` §9 ("UX coverage and removed legacy
routes") — this file only adds what that section doesn't already cover.

## Backend contract gaps (`apps/web` already degrades correctly)

These are backend design decisions, not web defects. `apps/web` shows them as
unavailable or omits the detail; it never fakes the data. Full list:
`backend/docs_design/api_design.md` §9. Summary of what a user notices:

| Area | What's missing | How `apps/web` handles it today |
| --- | --- | --- |
| Projects (sidebar folders) | No resource at all | "New project" stays disabled with the tooltip "Projects aren't available yet." |
| Conversation messages | No stored `workLog`, follow-up suggestions, or question attachments | A reloaded answer loses its work line and attachment chips; nothing is invented to replace them |
| Reader | `GetItem` `PERMISSION_DENIED` doesn't name the governing collection; no "which conversations cite this item" | Request-access can't be offered from the denial; not attempted |
| Review/topics | `ApproveContribution` can't publish as a new revision of an existing item; nothing creates `PROPOSED` topics | Submit-a-new-version and topic proposal flows are not built |
| Workspace admin | `AuditEvent` has no sign-in method/device; `WorkspaceAssistant` has no citations setting; denied requests have no Undo | Those controls are absent rather than stubbed |
| Work/Requests | Artifact has no draft-type field, no `sourceItems` append, no copy; request messages have no attachments/transitions/assignment history | Same — omitted, not mocked |
| Platform console | Can't read owner/admins of workspaces the operator isn't in; `WorkspaceUsage` has no daily series; no ingestion error-class filter; `Component` has no latency/uptime | Those columns/filters are absent |
| Sign-in throttling / password-reset email | No `429` throttling, no mail transport (`auth_contract.md`) | Password reset UI exists but sending silently has no backing transport in this environment |

No new backend endpoints were added to close any of these; per the task's
missing-API policy they stay documented here as future integration points.

## Visual-fidelity gap: Home redesign — now closed

**Home (`/home`) was running an older design than
`apps/ux_preview/docs/HOME.md`.** `apps/ux_preview/scripts/features/home.js`
and `HOME.md` describe a redesigned Home: three intent cards, a two-column
main/aside layout, a "Needs your attention" aside, and an "Explore
knowledge" domain-card section. `apps/web`'s `HomePage.tsx` still implemented
the previous design (one ask/find box, single column, "Explore by topic"
pill list) — it had never been updated after `ux_preview`'s Home redesign.

This had surfaced as a real bug, not just a cosmetic difference: once a
workspace has at least one document but nothing yet that any individual
section has content for, every section legitimately rendered `null` and the
page body was completely blank with no next step.

**Closed in this pass**: `src/modules/home/components/HomePage.tsx` and
`src/styles/pages/home.css` were rewritten to match `HOME.md` and
`ux_preview/scripts/features/home.js`/`styles/pages/home.css` exactly:

- Header: greeting + lede (`{n} documents you can read, across {k} topics`,
  computed from the Home read model's `counts`; the generic sentence when
  nothing is readable).
- Three intent cards (`home-starts`): *Find a document* (opens Knowledge
  Browse with the search field focused via a `?focus=1` arrival marker that
  `BrowsePage.tsx` consumes and strips), *Ask a question* (`/chat`),
  *Contribute knowledge* (`contributions.create` holders) or *Your library*
  (everyone else) — hidden on the empty-workspace state, matching
  `HOME.md`'s "nothing is typed on Home".
- Two-column body (`home-body`/`home-main`/`home-aside`, collapsing to one
  column with `home-body--single` when the aside has nothing): main column
  carries *Continue reading* (recent items, capped at 4, each with a
  hover/focus-revealed *Ask about this document* action), then *Start
  here*/*Recommended for you* and *Explore knowledge* (one card per topic
  domain — icon, document count, description, top 3 sub-topics, each linking
  into Browse filtered to that domain/topic) in first-visit vs. returning
  order; aside carries *Needs your attention* (changes-requested
  contributions, review queue, due/reply items) and *What's new* (version
  and announcement insights).
- Five-way visibility tracking (attention/continue/reading/explore/news)
  gates a single "You're caught up" empty state once every section has
  reported in with nothing to show, so the dead-blank-page bug from the
  previous pass stays fixed under the new layout too.
- Responsive rules ported 1:1 from `ux_preview` (`@container app` at 1023px
  and 679px): one interleaved column on tablets/phones, intent cards
  collapsing to a single bottom-sheet-style list at 679px.

Verified live against a real local stack (admin account, 2 published
documents, no topics tagged): header/lede, all three intent cards (Find →
focuses Knowledge's search input; Ask → `/chat`; Contribute → the Contribute
dialog) and Continue reading render with real data; Explore
knowledge/Attention/What's new/Recommended correctly stay hidden given this
dataset has no topics, no review queue and no unread recommendations (cross-
checked against the raw `GetMemberHome` response); zero console errors; zero
horizontal overflow at 834px and 390px; `npm run typecheck`, `npm test` (123
tests) and `npm run build` all pass clean.

The remaining `ux_preview` → `apps/web` parity gap not covered by this pass:
the admin *Manage featured documents* control (`ManageFeatured`, ported
unchanged from the previous `HomePage.tsx`) only supports removing a
featured document; `ux_preview`'s `DR['home-featured']` additionally has an
"Add documents" sub-view (search + checkboxes over published documents) that
`apps/web` has never implemented — admins can still feature a document from
its own `⋯` menu in Knowledge, so this isn't a dead end, just a narrower path
than the preview's drawer. Out of scope for this layout-parity pass.

## Other defect fixed in this pass

`ResourceMenu`'s "Manage in Documents" entry (`src/modules/knowledge/
components/ResourceActions.tsx`) was missing the `!r.isPersonal` guard every
other reviewer-only entry in the same menu uses. Personal "My files" items
are never reviewed (`item_model.md` — personal collection content bypasses
contribution review), so the entry showed for files reviewers could never
actually manage; its target page would always show "No documents yet."
Fixed by adding the same `!r.isPersonal` condition used by the sibling
`version` and `verify` entries.

## Theme system restored to parity with `ux_preview`, default changed (2026-11-08)

`apps/web`'s theme port (`src/lib/theme.ts`, `src/styles/tokens.css`) had
drifted from `apps/ux_preview/scripts/core/theme.js` and its `tokens.css`:

- The **`sage`** accent was missing from `ACCENTS` entirely, and the
  **`bomesh`** named theme pointed at `accent: "green", base: "default"`
  instead of `accent: "sage", base: "subtle"` — literally the values of a
  *different* HeroUI export template. `tokens.css`'s own header even says so
  ("Source: HeroUI Theme Builder export (template=crm, …)"), and its static
  `--accent-l/-c/-h`/`--base-hue`/`--tint` defaults were copied from that
  `crm` export (hue 139.21, tint 1), not from BoMesh's own "Calm sage"
  default (hue 156, tint 0.5). `ux_preview`'s own `tokens.css` is
  self-consistent (sage/subtle); only `apps/web` had the mismatch.
- The **`crm`** named theme ("Fresh green · HeroUI CRM green") was missing
  from the 19-theme list entirely, leaving `apps/web` with 18 options the
  user could pick from `ux_preview`'s 19.

Restored `sage` and `crm` in `apps/web` to match `ux_preview` exactly.

**Default theme changed** (requested): away from `bomesh`/`crm`'s green and
`heroui`'s blue, to **`midnight`** (indigo accent, subtle base, `md` radius,
IBM Plex Sans) — already one of the 19 presets, just not previously
defaulted to. Changed `DEFAULT_LOOK` in both `apps/ux_preview/scripts/core/
theme.js` and `apps/web/src/lib/theme.ts` together (and their respective
`tokens.css` pre-paint defaults), per `AGENTS.md`'s rule that a product-level
UI decision is represented in the UX preview, not only in the production
client. Anyone can still pick any of the 19 themes (including BoMesh/Calm
sage) from Settings → Appearance; this only changes what a new session opens
with.

Fixed two more `BoMesh`-specific hardcodes found while touching this code,
in both `apps/web` and `apps/ux_preview` (so the "Reset" action always names
whatever the real default is, not whichever theme used to be default): the
drawer's "Reset to BoMesh" button label/toast, and restored `ux_preview`'s
`isDefaultLook()` behavior of hiding that button entirely in `apps/web`
(it previously always showed, even at the default look).

## Visual-fidelity gaps found, not closed (CSS tokens exist in `ux_preview` only)

Found while auditing the theme system; out of scope for this pass (no
`apps/web` React wiring exists yet for the first one — adding the CSS alone
would be dead code):

- **~~Reader: no "native paper" look for PDF/DOCX/Slide renditions.~~ —
  PARTLY CLOSED 2026-11-08.** The deeper problem was not styling: `apps/web`
  rendered the JSON rendition (extracted text) for *every* document and used
  `pageAssets` only to count pages, so a PDF lost its own typography, figures
  and layout. `document_viewer.md` ("Reading (web)") is explicit: *in the
  file's native format … there is no separate text view. PDFs keep page
  images.* Ingestion already renders one WebP per PDF page (verified: a
  28-page lecture produced 28 `pageAssets`), and nothing consumed them. A
  page-image view was added, then **superseded 2026-11-16** by the
  processing-independent viewer (`document_viewer.md`): one
  `reader/components/DocumentSurface.tsx` reads `GetItemPreview` and draws the
  original — PDFs with pdf.js (`PdfView.tsx`, ranged reads, canvas + text
  layer per page near the view), pictures, text files (`TextView.tsx`), and
  the rendition only for DOCX/PPTX/XLSX/HTML. Still open: the `--paper*`
  tokens for non-PDF formats, so a DOCX or PPTX rendition keeps the app theme
  instead of looking print-like.
- **Browse still uses a Filters drawer instead of inline filter popovers.**
  `ux_preview/scripts/features/hub.js` renders a `cat-bar` of inline
  Type · Updated · Trust · Owner buttons opening `cat-pop` popovers with
  live result counts, removable `cat-chip` filter chips, and a saved-`Views`
  menu. `apps/web`'s `BrowsePage.tsx` keeps the older `FiltersDrawer.tsx`
  (a right-side sheet). Functionally equivalent, visually and
  interaction-wise not the current design. Next candidate after the reader.
- **Draft citations don't focus the sources rail.** `ux_preview`'s
  `work-research.js` `drCite` opens the draft's rail on the Sources tab and
  scrolls the cited source into view. `apps/web`'s `DraftView.tsx` has the
  rail but no inline-citation → rail wiring.
- **Focus ring uses a different mechanism than `ux_preview`'s token**, not a
  visible defect: `ux_preview` centralizes it as `--focus-halo`; `apps/web`
  uses HeroUI's `--ring-offset-width` system per component. Low priority —
  unify only if a real visual inconsistency between pages is found, not for
  naming purity alone.

## UX consistency pass (2026-11-08, second pass)

A class-level diff of every `ux_preview/styles/pages/*.css` against the whole
`apps/web` CSS corpus plus a per-surface behavioural audit. Most raw
"missing class" hits were false positives (HeroUI renders those internals, or
the rule lives in `components.css`/`workspace-admin.css`). The real
divergences found and closed:

### Closed: one shared document preview for every citation and document row

`ux_preview/scripts/features/preview.js` (`M['doc-preview']`) defines a single
quick-reading modal opened from six surfaces — Browse rows/cards, search
results, chat citations, work citations, request rule citations and resource
rows. `apps/web` had **four** different previews instead: a Browse
quick-preview drawer (`browse/QuickPreview.tsx`), a chat citation side panel
(`chat/components/CitationPanel.tsx`), a request `CitationDrawer` inside
`requests/components/RuleChecks.tsx`, and plain navigation straight to the
Reader everywhere else. This is exactly the inconsistency
`ux_preview/docs/PAGE_AUDIT.md` calls out ("four different previews" → "one
document preview modal for every document row, card and citation").

Added `src/modules/knowledge/preview/` (`store.ts`, `DocumentPreview.tsx`) and
`src/styles/pages/preview.css`, ported from `preview.js`/`preview.css`:

- Centred modal (960 px, `min(88vh, 1040px)`), a near-full-screen sheet below
  679 px where the secondary action collapses to its icon.
- Header: file icon, title, and essential metadata only — type · knowledge
  base · updated, with the trust chip only when it is Verified or Review due.
- A reading bar stating what is highlighted: `Cited passage · page n` with
  `Passage n of m` stepping across an answer's citations, or
  `Matches for "q"` with `n of m` stepping for a search.
- The document's own pages via the Reader's existing `useRendition` +
  `RenditionView` + `documentMarks`, with the focused mark scrolled to a
  third of the viewport.
- Exactly two actions: *Ask about this document* (secondary) and *Open full
  document* (primary). Per `preview.js` it deliberately has **no** Save,
  no `⋯` menu, no Add-to-collection and no editing — the row it was opened
  from already offers those, and the rest lives in the Reader. This drops
  Save/Add-to-collection from the old Browse drawer, which was a deviation
  from the design, not a feature.
- A citation whose document the caller can't read still shows the quoted
  passage (`pv-quote`), so the claim remains checkable.

`QuickPreview.tsx` and the request `CitationDrawer` were deleted;
`DocumentPreviewHost` is mounted once in `AppShell`.
`chat/components/SharedConversation.tsx` keeps `CitationPanel`: it is a public
page outside the workspace shell with no workspace API access, and renders
quotes straight from the shared-answer payload.

### Closed: smaller divergences

- **Search highlighting used the citation amber.** `.srch-hl` was painted with
  `--evidence`, the colour `ux_preview` reserves for cited passages. Added the
  `--highlight`/`--highlight-foreground` tokens (neutral accent tint) that
  `ux_preview/styles/tokens.css` defines for this and pointed `.srch-hl` at
  them, so "this is a search match" and "this is the cited passage" are no
  longer the same colour. (This also partly supersedes the
  "no search/suggestion term highlighting" item above: `apps/web` does mark
  matches via `.srch-hl`; it was the colour that was wrong.)
- **Interactive cards didn't lift on hover.** `ux_preview` raises
  `.card--action` with `--lift-shadow` + `translateY(-1px)`; `apps/web` only
  changed the background. Ported the `--lift-shadow` token (light and dark)
  and the hover rule, with `box-shadow` added to the transition. The global
  `prefers-reduced-motion` rule in `base.css` already neutralises the
  transform.
- **Inbox rows showed a redundant "Open" button.** `ux_preview`'s
  `inbox.js` `inlineAction` gives a button only to rows with an in-place
  decision (Approve/Deny, Reconnect); every other row opens by clicking the
  row itself and shows a quiet chevron (`.inbox-go`). `apps/web` rendered a
  `cta`/"Open" button on every row, duplicating the row's own click target.
  Removed those branches and added the chevron.
- **`reveal-on-hover` was a weaker local copy.** The Home-local rule only
  handled `.item` and hid *all* children. Replaced with `ux_preview`'s shared
  definition in `components.css`: covers `.item`, `.res-row`, `.table__row`
  and `.card`, keeps a toggled-on control (`.is-on`, `aria-pressed`,
  `aria-expanded`) visible so its state is never hidden, and only hides under
  `(hover: hover)`.


## IA consistency pass (2026-11-08, third pass)

Audited `apps/web`'s information architecture against the preview's own
`scripts/core/router.js`, `scripts/core/shell.js` and
`scripts/features/projects.js` (not just CSS). Four real divergences, all
closed:

- **The sidebar had no "New chat".** `projects.js` puts it in its own
  `.sidebar__group.side-new` as the first row above Projects — it is the tour's
  fourth step (`#side-new-chat`). `apps/web` only offered "New chat" *inside*
  an already-expanded project folder, so starting a conversation needed two
  clicks and a folder. Added to `SidebarConversations.tsx` with the preview's
  `side-new` rule. Sidebar order now matches the preview exactly: Home ·
  Knowledge · Work · Requests → New chat → Projects → Recent → Spaces → Manage.
- **Knowledge bases were on the wrong path.** The preview routes them at
  `/bases` and `/bases/:id`; `apps/web` had `/knowledge/bases` and, worse,
  `/knowledge/:id` — a catch-all directly under the reader-facing Knowledge hub,
  one segment away from `/knowledge/library` and `/knowledge/collections/:id`.
  Moved the route files to `app/(app)/bases/` and rewrote all 27 link sites
  (Command palette, Overview, Browse, Reader crumbs, About pane, Spaces,
  People, Curation, Ingestion, Inbox, Activity, Search, Artifacts) plus
  `tests/navigation.test.mts`. Verified no `/knowledge/<uuid>` link survives
  anywhere in the rendered app.
- **Home's lede was missing its second clause.** `lede()` reads
  `"{n} documents you can read, across {k} topics · {f} updated in the last 30
  days"`. `apps/web` stopped after the topics clause because `MemberHome.counts`
  has no "fresh" count. Added `useFreshCount()` — one `pageSize: 1` search
  filtered on `updateTime >= <30 days ago>`, read for its `totalSize`, exactly
  how `useCatalog` already counts its Updated windows. Real number from the
  API, not a client-side guess. Verified live: "2 documents you can read ·
  2 updated in the last 30 days".
- **Home rows didn't use the shared preview.** `home.js` opens
  `doc-preview` from the What's new rows and the Start here / Recommended rows
  (Continue reading deliberately navigates — you are resuming, not peeking).
  `apps/web` navigated to `/doc/` from all three. The two preview-opening
  surfaces now call `openDocumentPreview()`; Continue reading still navigates
  and gained the `· {kind}` half of its description that the preview shows.

Not changed, deliberately: `apps/web` keeps the section class
`home-sec--reading` where the preview switches between `--start` and `--rec`.
The two preview classes only carry a mobile `order`, which the single web class
already provides; splitting them would be churn with no visual effect.

## Environment blockers found this pass (not code defects)

Both predate this pass and were confirmed against a stashed (unmodified)
working tree, so they are not caused by any change here.

- **~~MinIO/RustFS serves no CORS policy~~ — RESOLVED 2026-11-08 by the RustFS
  cutover.** The stale MinIO container had been started on 2026-10-03 from a
  *different repository path* (`utex/BoThesis/deployment/compose.yml`) and held
  ports 9000/9001, so the RustFS service defined in this repo's
  `deployment/compose.yml` had never run — no image, no container, no volume.
  `make services` starts RustFS (and its `rustfs-init`, which creates the
  bucket and applies the CORS rule) only when `BOMESH_S3_ENDPOINT_URL` equals
  `LOCAL_S3_ENDPOINT`; `.env` pointed at a Tailscale IP, so both were skipped
  and the app talked to the legacy MinIO, which nobody had given a CORS rule.
  Fixed by pointing `BOMESH_S3_ENDPOINT_URL` and
  `BOMESH_S3_PUBLIC_ENDPOINT_URL` at `http://127.0.0.1:9000`, removing the
  stale containers and volumes, and rebuilding the stack. Verified end to end:
  a document uploaded through Contribute lands in the RustFS bucket under
  `tenants/{tenant}/items/{item}/revisions/{n}/original`, and the browser
  fetches its `document.json.gz` rendition from `127.0.0.1:9000` and renders
  it — in the Reader, in the shared document preview, and with search-match
  highlighting. Document rendering is therefore now verified in a browser for
  the first time.
- **`next dev` (Next 16.2.6 / Turbopack) serves pages that never hydrate.**
  The streamed Suspense buffer (`<div hidden id="S:0">`) is never swapped in
  (`$RC` is defined, the `B:0` template is still present, `self.__next_f`
  stays empty), so every page renders visually but is completely
  non-interactive — the whole app tree has a zero-size layout box. No
  compile error, no console error. `npm run build && npm run start` hydrates
  correctly, so all browser verification in this pass was done against the
  production server. Worth a separate look (Next/Turbopack version issue).

## Verified working end to end (live local stack, 2026-11-08)

- Sign-in (`admin@hcmute.edu.vn`), session restore on refresh, `next=`
  redirect to the originally requested protected route, and redirect-to-
  `/signin` for both an expired session and direct unauthenticated
  navigation (no refresh-token method exists by design —
  `auth_contract.md`).
- All primary and admin/platform routes (`/home`, `/knowledge`,
  `/knowledge/library`, `/knowledge/bases`, `/overview`, `/sources`,
  `/connections`, `/people`, `/assistant`, `/activity`, `/settings`,
  `/work`, `/requests`, `/spaces`, `/search`, `/chat`, `/chats`, `/inbox`,
  `/documents`, `/p/workspaces`, `/p/users`, `/p/connectors`, `/p/usage`,
  `/p/audit`, `/p/health`, `/p/indexing`) load with zero console errors and
  zero failed API calls.
- Chat: sent a real question, received a streamed, grounded answer from the
  configured `OPENROUTER_MODEL`; conversation persisted and reloaded
  correctly after a hard refresh.
- Contribute → Upload to My files: uploaded a Markdown file, it appeared in
  Knowledge → My library → My files, and the member Home read model
  (`members/{member}/home`) picked it up.
- Responsive: 1440 and 390 px widths render without horizontal overflow or
  console errors.

### Second pass (production build, `npm run start`)

- `/home`, `/knowledge`, `/knowledge/library`, `/documents`, `/requests`,
  `/work`, `/spaces`, `/people`, `/knowledge/bases`, `/settings`: all load
  with the right `h1` and **zero** console errors or warnings.
- Shared document preview from a **Browse card**: opens as a centred modal
  with the correct file icon, title, `type · updated` metadata and both
  footer actions.
- Shared document preview from a **chat citation**: opens on the right
  passage with the reading bar reading `Cited passage · page 2` /
  `Passage 1 of 3`; Next steps to `Passage 3 of 3` on page 7 and correctly
  disables itself at the end; Escape closes it. The old `.chat-cite` side
  panel no longer renders.
- Phone sheet at 390 × 844: the dialog fills 376 × 836, the secondary action
  collapses to its icon, no horizontal overflow.
- `--highlight` (neutral) and `--evidence` (amber) resolve to different
  colours at runtime; `--lift-shadow` resolves and `.card--action` carries
  `box-shadow` in its transition.
- `npm run typecheck`, `npm test` (123 pass) and `npm run build` (42 routes)
  all clean.
- **Not verifiable in a browser:** any actual rendition content, because of
  the MinIO CORS blocker above. The preview's no-rendition empty state was
  exercised instead (it matches the Reader's own failure for the same
  document).


## Not exercised in this pass

- The full contribute-to-shared-knowledge-base → review → publish pipeline:
  the seeded "Kho bài giảng nội bộ" collection's owner/editor accounts
  (`maint@hcmute.edu.vn`, `baohq@hcmute.edu.vn`) are separate from the admin
  account used for the rest of this pass, and the collection's seeded
  `acceptsContributions` is off (an owner must turn it on in Settings
  first). Upload-to-My-files and the chat/citation path were exercised
  instead.
- Flutter mobile app migration — explicitly out of scope: `apps/mobile`
  still targets the removed legacy routes per `AGENTS.md` and
  `api_design.md` §9, and is a separate migration effort.
