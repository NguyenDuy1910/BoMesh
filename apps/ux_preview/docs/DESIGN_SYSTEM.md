# BoMesh design system

HeroUI v3 is the only design authority. The prototype reproduces HeroUI's tokens, component anatomy and BEM class names in plain CSS so every element maps 1:1 to a documented component.

- Components: <https://heroui.com/en/docs/react/components>
- Theme: [Theme Builder — CRM, hue 139.21, base 0.02, Google Sans, radius M, field radius L](https://heroui.com/en/themes?template=crm&hue=139.20631987695046&fontFamily=google-sans&base=0.02)
- Living gallery: `ux-preview.html#/design` (rendered with the same builders as the product, so it cannot drift).

## Tokens — `styles/tokens.css`

Light and dark lightness values are the Theme Builder export; hover, soft and border variants use HeroUI's own `color-mix()` formulas from `themes/default/variables.css`. Components and pages use only these variables.

**Themes change the whole interface.** Appearance is a personal setting with the Theme Builder's dimensions, and every one of them re-themes all screens at once:

| Dimension | Options | What it drives |
| --- | --- | --- |
| Mode | Light, Dark, System | `<html data-theme>` |
| Theme | 19 named looks: **BoMesh (default: Calm sage — sage accent on a near-neutral canvas)**, Fresh green (the original CRM export), HeroUI, Ocean, Sky, Forest, Lagoon, Midnight, Lavender, Plum, Orchid, Sakura, Rose, Crimson, Sunset, Amber, Lemon, Lime, Graphite | Bundles the four settings below; changing any of them makes the theme "Custom". A stored BoMesh look always follows the current default definition |
| Accent | 19 swatches (sage, green → graphite) + custom hue slider | `--accent`, `--accent-foreground`, `--focus`, accent soft tones: primary buttons, links, current navigation icon, selection, focus rings, charts |
| Background tint (Theme Builder "Base") | Neutral 0, Subtle 0.5×, Tinted 1× (export), Rich 1.8× | Every neutral — canvas, surfaces, fields, borders, text — at the accent hue |
| Radius | None, Small, Medium (export), Large, XL | `--radius` scale; fields get 1.5× |
| Font | Google Sans (export), Inter, Be Vietnam Pro, IBM Plex Sans, Manrope, System | `--font-sans`; Google fonts load on demand, system fallback offline |

Mechanics: `scripts/core/theme.js` holds the registries (`ACCENTS`, `BASES`, `RADII`, `FONTS`, `THEMES`) and `applyTheme()`, which writes the inputs (`--accent-l/c/h`, `--accent-fg`, `--accent-ink`, `--base-hue`, `--tint`, `--radius`, `--field-radius`, `--font-sans`) on `<html>`. `tokens.css` derives every color from them; its `:root` defaults are the BoMesh theme. Light accents (Amber, Yellow, Lime) use dark text on the accent and a darker soft foreground; Graphite flips to near-white in dark mode. Status (success, warning, danger) and evidence colors never change: they carry meaning, not brand. Workspace marks keep the workspace's own logo color. The look is persisted with the mode (`S.look`). Add a theme by adding a `THEMES` entry; add an accent in `ACCENTS`.

UI: the **Appearance** drawer (`features/appearance.js`, clear backdrop so the app re-themes live behind it) shows mode (Light · Dark · System), a gallery of theme cards (each drawn from its own colors via `themePreview()`), then Customize: accent (ColorSwatchPicker + hue slider), background tint, radius and font. Entry points: account menu (Appearance, with the current mode · theme), Preferences (Appearance row), command palette ("Switch to dark/light mode"), prototype bar (Mode + quick themes and "Theme and colors…", with Undo toast) and `#/design`.

| Role | Tokens | Use |
| --- | --- | --- |
| Canvas | `--background`, `--foreground`, `--muted` | App background, body text, secondary text (tinted at the accent hue by the background tint) |
| Surfaces | `--surface`, `--surface-secondary`, `--surface-tertiary`, `--overlay` | Cards/lists/table bodies; table roots and quiet panels; skeletons; menus, dialogs, drawers, toasts |
| Controls | `--default`, `--default-hover`, `--field-background`, `--segment` | Tertiary buttons, chips, switch tracks; inputs; selected tab/segment |
| Accent | `--accent`, `--accent-soft`, `--accent-soft-foreground`, `--focus` | Primary action, current navigation, selection, focus ring |
| Status | `--success`, `--warning`, `--danger` (+ `-soft`, `-soft-foreground`) | Status chips, alerts, destructive actions |
| Lines | `--border`, `--separator` | Outline buttons, dividers, table rows |
| Elevation | `--surface-shadow`, `--lift-shadow`, `--overlay-shadow`, `--field-shadow`, `--button-shadow`, `--card-border`, `--field-border`, `--focus-halo` | Calm elevation: every surface is a hairline (`--card-border`, `--field-border`) plus a low, soft shadow; clickable cards lift on hover (`--lift-shadow`); primary buttons carry a soft shadow; focused fields get an accent edge and a soft halo. Dark mode uses borders instead of shadows |
| Evidence | `--evidence`, `--evidence-strong` | Citation markers and cited passages only (derived from warning; never reused for generic warnings) |
| Highlight | `--highlight`, `--highlight-foreground` | Search-term matches in titles, snippets and the viewer (soft accent wash) |
| Type | `--text-2xs` … `--text-3xl` with `--leading-*` (11/14, 12/16, 13/19, 14/21, 16/24, 18/26, 22/30, 28/36) | Every font size and line height; weights 400/500/600 only |
| Spacing | `--space-1` … `--space-14` (4 px scale: 4, 8, 12, 16, 20, 24, 32, 40, 48, 56) | Gaps, paddings, page/section rhythm (32/40 px) |
| Controls | `--control-sm` 32, `--control-md` 36, `--control-lg` 44, `--touch-min` | Button/field heights; touch targets ≥ 40 px on coarse pointers |

Radius scale is HeroUI's (`--radius` = 8 px in the default theme): fields 12 px, cards/lists/table bodies 16 px, dialogs/drawers/toasts 24 px, buttons/chips/tabs pill. The theme's radius setting scales all of these.

Typography: Google Sans Flex by default (system fallback offline); the theme's font replaces `--font-sans` everywhere. Body 14/21, labels 13/19 medium, meta 12/16, card title 15/22 semibold, section 16/24 semibold, dialog/drawer title 18/26 semibold, page title 22/30 semibold (−1.5 % tracking), display 28/36, KPI 24/32 semibold tabular. Weights are 400/500/600. Headings tighten tracking slightly; body text never does.

Calm defaults: near-white canvas with white surfaces, hairlines instead of heavy borders, one accent used sparingly (primary action, current-page icon, selection, focus), neutral current-page highlight in the sidebar (raised white row), no gray slabs behind content and no cards nested inside cards. Card padding 20 px; tabs sit on a hairline separator.

## Components — `styles/components.css` + `scripts/core/ui.js`

Screens never hand-roll markup for these; they call the builder.

| HeroUI component | Builder | Notes |
| --- | --- | --- |
| Button | `btn(label, {v, size, icon, loading, menu, href})`, `iconBtn`, `linkBtn` | Variants `primary` (one per region, soft shadow), `secondary` (outlined white surface, dark text, accent icon), `tertiary` (soft gray, default), `ghost` (text; Cancel in dialogs), `outline`, `link` (`linkBtn`: quiet text action, icon after the label), `danger`, `danger-soft`; sizes sm 32 / md 36 / lg 44; press scales to 0.97; loading keeps width. Buttons inside alerts and list rows pass through `quietActions()`: primary/tertiary become `secondary`, every size becomes `sm` |
| Chip | `chip(label, {tone, variant})`, `status(kind, value)` | One status vocabulary (`STATUS` in ui.js). Healthy steady states are quiet (tertiary); action-required states are soft color + dot |
| Badge | `badge(n, {tone, label, dot})` | Count with one meaning per tone: `danger` = something is broken, `accent` = needs you, `default` = information. Renders nothing for 0; `dot` replaces the number (collapsed nav group). A badge counts exactly what its landing view shows |
| Card | `card()`, `statCard()` | Hairline + soft shadow; `card--action` lifts 1 px with `--lift-shadow` on hover. KPI card follows the CRM template: icon tile, label, value, meta |
| ListBox | `list()`, `item({act, href, trail, lines})` | Rows with lead icon/avatar, title, description, meta, trailing actions. With `act`/`href` the title is the real button/link stretched over the row, so trailing actions stay sibling controls (never nested). `lines: 2` lets the title wrap on phones (messages, notifications). Secondary trailing actions use `.reveal-on-hover`; `.item__trail` wraps under the content below 680 px |
| Table | `table()`, `sortHead`, `selCheck`, `bulkBar`, `pager` | HeroUI primary table (gray root, white body). `pager` renders only when there's more than one page. Selection swaps toolbars for the shared floating `bulkBar`. Below 760 px rows become cards (primary cell, actions, wrapped metadata) |
| Tabs | `tabs(items, active, base, {variant, act})` | `secondary` (underline) for page sections, `primary` (pill) for in-content filters; tabs are links so sections are deep-linkable. With `act` they are toggle buttons (`aria-pressed`) for in-content filtering. Narrow containers scroll the tabs with an edge fade and keep the current tab in view |
| ToggleButtonGroup | `seg({iconOnly})` | Mutually exclusive view options; `iconOnly` shows icons with the label as accessible name and tooltip |
| TextField / TextArea / Select | `field()` + `input()` / `textarea()` / `select()` | Visible label, description, inline `FieldError` with `aria-invalid` |
| Switch / Checkbox / RadioGroup | `switchCtl`, `switchRow`, `checkbox`, `choiceGroup` | Radio cards for consequential choices; options `[value, title, desc, icon]` — with an icon the card leads with a tinted icon tile instead of the dot, and 3+ columns render as tiles |
| Disclosure | `disclosure({ path, title, summary, icon, body })` | Progressive disclosure for optional or advanced settings and long pickers; the collapsed row shows the current choice (`summary`); state at `S.ui[path]`, toggled by `ui-toggle` |
| Option list | `<div class="option-list">` around `checkbox()` rows | Bordered, scrollable picker (max 220 px) with roomy hover rows; never more than a handful of bare checkboxes in a dialog |
| SearchField | `searchField({uiKey, bind, act, value, placeholder, id, size, autofocus, label, full, enter})`, `needsTools(n, uiKey, fields)` | The one search input. `uiKey` filters `S.ui[uiKey].q`; `bind`/`act` make it work in dialogs and pickers; a clear (×) button whenever non-empty, Escape clears. Sizes sm (toolbars) / md (dialogs) / lg (page search). Search, sort, filters and bulk selection render only when `needsTools` says the list needs them (7+ items, `TOOLS_MIN`) or one is in use |
| Popover | `PO[name](trigger) → { title, body, foot, width }`, trigger `data-popover="name"` + `aria-haspopup="dialog"` | Inline filters and small pickers. Stays open while you interact (checkboxes call `refreshLayer()`), closes on outside click/Esc and returns focus to the trigger. Below 680 px it renders as a bottom sheet with a Done button |
| Alert | `alertBox(tone, title, desc, actions)` | One alert per problem, with its fix as the action |
| EmptyState | `emptyState()`, `errorState()` | First use, no results, no access and failure have different copy and recovery |
| Skeleton / ProgressBar / Spinner | `skelRows`, `skelCards`, `progress`, `spinner` | Structure-preserving loading |
| Avatar / Kbd | `avatar(name, size)`, `kbd()` | Avatars use soft tones stable per name |
| Modal / Drawer / Dropdown / Toast / Tooltip | `M`, `DR`, `MENUS`, `toast()`, `data-tip` (overlays.js) | Modal: `{ title, icon, tone, desc, body, footStart, foot, size, after }` — a 40 px tinted icon tile names the action, `desc` says what happens next (aria-describedby), the footer is a quiet band with an optional hint on the left (`footStart`), ghost Cancel and a primary that repeats the title's verb; `after(dialogEl)` runs once the dialog is in the DOM. `confirmAction` adds an alert/help tile and keeps its primary enabled, validating on press. Sizes sm · md · lg · xl · `preview`. Backdrop blurs lightly. Modal becomes a bottom sheet and drawer a full-height sheet below 680 px. Dropdown (⋯) menus group items with `{ section }` headings, ≤ 8 items, destructive last after a separator. Toasts live in a persistent `#toasts` live region; Undo toasts stay 8 s and pause on hover/focus. Tooltips only via `data-tip` (never native `title`) |
| Breadcrumbs | `crumbs([...])` | Rendered in the topbar |

Domain marks: `fileIcon(type)` (soft tone per file family), `appIcon(key)` (connector brand glyph on a neutral tile), `wsMark(ws)`, `X.spaceMark(space)` (space color tile with the space-type icon), sidebar `.space-dot`, and `.cite` citation markers.

Text helpers: `isQuestion(q)` (does typed text read like a question — decides whether Ask AI or Search documents ranks first) and `bareName(n)` / `X.docTitle(doc)` (a document's display title without its file extension, used everywhere).

Workspace-level compositions (built from the components above; domain-neutral so any template reuses them):

| Composition | Where | HeroUI parts |
| --- | --- | --- |
| Up next list — `X.upNext()` / `X.upNextList()` | Home (Pick up where you left off, up to 3 when Spaces is on), space overview | ListBox rows, Chip (due/overdue tone), one Button per row |
| Work item — `X.workItem(w, {hideSpace, owner})` | Work list, space Work tab | ListBox row, kind icon tile, status Chip only for drafts (generated work has none) |
| Request row and status vocabulary — `X.requestItem()`, `X.requestStatus` (viewer-aware), `X.requestQueue(spaceId)` | Requests, space Requests/Questions tab | Table/ListBox, Chip (needs reply = warning, overdue = danger); queue segments Open / Closed; tab badge `X.requestQueueCount` counts actionable items only |
| Rule check card | New request | Card, check/warn/fail icons, citation markers; quotes open the document preview |
| Stepper | New work | Numbered segments in the ToggleButtonGroup style |
| Evidence review | Work kind | Table with sticky first column, citation markers per cell, evidence in a non-modal side panel (`WORK_KINDS[kind].panel`, `onCite`); up to 8 compared sources; card layout on phones |
| Document editor | Draft | Surface card, ToggleButton toolbar, side rail with Tabs (Sources · Versions); read-only outside Draft / Changes requested |
| Follow-up chips | Chat answers (`m.next`) | A labelled row of `sm` secondary Buttons |
| Home box, continue, insight and reading cards, topic shortcuts — `features/home.js` + `styles/pages/home.css` | Home | Search box as an ARIA combobox: Search documents / Ask AI options (Ask AI first only when `isQuestion`, Enter runs the first), matching documents (open the preview) and earlier questions, scope as a quiet menu inside the box (a scope chip on phones); "Waiting for you" and "Continue reading" rows; insight cards whose headline is a source's own change note, with kind · date above and document · version below; reading cards (title, purpose, reason); topic pills tinted by domain. See [HOME.md](HOME.md) |
| Document card — `X.res.card(d, {act, q, reason, hide})` | Knowledge Browse grid | Card for recognising a document without opening it: a content preview (the document's most useful section at a readable size, chosen from its own section titles — steps, decisions, findings, rules, endpoints — or the matching section when searching; spreadsheets and slides show their first page), or a tinted type tile when there is no rendition or the preview would repeat another card's on the page; format badge and length; title, one line on what it is for, type · topic (omitted when every card shares it), a quiet Verified mark or a Review due Chip. Save and ⋯ via `.reveal-on-hover`. Opens the document preview |
| Knowledge header — `X.res.hubHeader(active)` | Browse, My library | Page header + Demo data Chip + primary Tabs as section navigation (one tab per intent) |
| Resource row — `X.res.row(d, {pos, read, reveal, …})` | Every list of resources (Browse list, Library, collections, bases, spaces, Related, search) | ListBox row that opens the document preview: file icon, title with highlights, trust Chip, meta line (source glyph · type · base · updated), snippet or summary (never a generated filler line), topic links; Save toggle + ⋯ Dropdown via `.reveal-on-hover` (a saved bookmark stays visible). `pos` numbers ordered lists, `read` marks what you've read |
| Resource ⋯ menu | Rows, cards, Reader header | ≤ 8 entries, never repeating the surface (no Open/Save; no Ask inside the Reader). Sections reading · Use in · Manage (or a "Manage…" drill-in), Archive last. "Submit a new version…" only for uploads |
| Trust chip — `X.res.trustChip` | Rows, Reader header, preview header, details | Chip: Verified (success, shield), Review due (warning, clock), Not verified (default, dashed circle); the tooltip says who and when |
| Browse filters | Knowledge Browse | Inline filter Buttons, each a Popover of Checkboxes with counts: Type · Updated · Trust · Owner, then More filters (Space · Source · Knowledge base · Format · Language). Selected filters show as removable chips next to the result count; Clear all also clears the topic. Topic is pill shortcuts above the results. Phones get one Filters bottom sheet. Saved views live in a Views Dropdown (open a view, Save this view…, Rename…, Delete view) |
| Metadata list — `X.res.details` | Reader About, duplicate compare | Description list: type, topics, spaces, owner, base, source path, trust, version, language, who can see it |
| Document preview — `X.preview.open({id, q, page, quote, from, cites, i})`, action `doc-preview` (`features/preview.js`) | Browse cards and rows, every resource row, Home suggestions and reading cards, chat citations and source chips, work citations, request rule-check quotes | Modal (`size: 'preview'`, max 960 px, ~88vh; near-full-screen sheet below 680 px). Header: file icon, title, type · knowledge base · updated, trust chip only when Verified/Review due, close. Optional reading bar: "Cited passage · page N" with Passage n of m stepping (across documents) or "Matches for “q”" with match stepping. Body: the Reader's native rendering (`X.rdr.viewer`, no zoom bar) with the cited passage or matches highlighted. Footer: ghost "Ask about this document" (`/doc/:id?ask=1`) and primary "Open full document" (Reader with the same `q/page/from`). A locked document shows only the cited quote and Request access. No Save, ⋯, editing or sharing |
| Native document viewer — `X.docModel(d)` (documents.js) + `X.rdr.viewer` (reader.js) | Reader, document preview, review preview, card thumbnails | One rendition model (pages, outline, passages) shown in the file's own format (`X.docFormat`: pdf · docx · slide · sheet · markdown · web · text · email). The format sets the page chrome on the page itself (PDF running header and page number, Word "Page n of N", slide numbers, email header) and its typography; PDF, Word and slides stay white paper in dark mode (`--paper*` tokens) on a neutral desk (`--viewer-canvas`). Web-like formats are one continuous page. Never a separate text view. `X.rdr.markHits`/`needles`/`injectQuote` highlight terms and quotes |
| Reader rail | Reader | Closed by default; Tabs Ask · About · Related (`?ask=1` opens Ask); Ask = suggestion Buttons, message bubbles, citation cards that highlight the page, input |
| Pickers — Add to collection, Link to spaces, Edit details topics | Dialogs | Bordered Checkbox list in a scroll area; inline "New collection" field |
| Lifecycle chip — `lifeChip(d)` (core/lifecycle.js) | Contributions, Documents, Reader, KB pages | Chip with dot: In review / Analyzing (accent, live), Changes requested (warning), Declined and Couldn't publish (danger), Publishing (accent, live), Published (success, quiet), Waiting to publish / Unpublished (default); tooltip explains the next step |
| Contribute dialog | Knowledge header, ⌘K, bases, My files, "Submit a new version…" (uploads) | Modal: destination first as radio cards (Contribute to a knowledge base · Upload to My files), drop zone, sample chips, Select (knowledge base, "Let the assistant suggest"), title and description, per-file ProgressBar |
| Review split view | Manage → Documents → Review | Left ListBox queue with Checkboxes and filter chips; right detail: note quote, preview Card (rendition page), suggestion fields with confidence Badges, labelled risk Chips (Personal data, Possible duplicate), sticky decision bar (Request changes · Decline · Approve & publish) that the floating bulk bar replaces while submissions are selected |
| Timeline | Contribution drawer, document drawer | Vertical list of events with avatar/icon, actor, relative time and quoted reviewer message; the next expected step at the end |
| Proposed topic row | Documents → Topics (workspace admins) | Compact row: name, domain, linked submissions, Accept (secondary sm) · ⋯ Rename / Change domain / Merge into / Dismiss |

## Layout — `styles/layout.css`

HeroUI CRM shell: sidebar on the background (workspace header — static with one workspace, a switcher with several — navigation groups, account button), topbar (sidebar toggle · breadcrumbs from depth 2, "Manage ›" for admin pages · page actions · Search (⌘K) field · Inbox bell with unread badge), pages on the same background with surface cards. The account menu opens the profile: Preferences · Appearance · Language · Help (Shortcuts, Product tour) · Sign out.

- `.page` max 1200 px, 24/32 px padding; `.page--narrow` 800 px for forms.
- `pageHeader()` owns title, one optional line of purpose and the page's primary action. Section tabs sit directly under it. Filters live with the data they filter. Section-header actions and toolbars wrap under the content below 680 px.
- `.split` + `.split__panel` for side panels (files, document details, evidence); below 1024 px panels overlay.
- `.form-section` two-column settings rows; `.savebar` appears only when a multi-field form is dirty.

## Rules

These implement the product principles in [PRODUCT_DESIGN_RULES.md](../PRODUCT_DESIGN_RULES.md) (binding for every page and component).

1. **One primary per region** (page header, dialog footer, drawer footer, card); everything else is secondary, tertiary, ghost or in a menu. Buttons inside alerts and list rows are `secondary` size `sm` (decisions: Approve = secondary, Deny/Decline = ghost). Destructive = `danger-soft`.
2. **Rows**: the whole row or card is the click target and opens the object; it never also carries an Open/View/Review button. Secondary row actions (Save, ⋯, remove) use `.reveal-on-hover` — shown on hover/focus-within, always visible on touch (`@media (hover: none)`); a set state (a saved bookmark) stays visible.
3. **⋯ menus** never repeat an action visible on the same surface; ≤ 8 items; grouped with `{ section }` headings (reading · Use in · editor/admin); destructive last after a separator.
4. **Save model**: state flips, role changes, membership and toggles apply immediately with an Undo toast. Multi-field text forms use a savebar (Save / Discard) or dialog Save / Cancel, and Cancel truly discards. Never both in one surface.
5. **Confirmations** only for irreversible or high-risk actions (workspace archive request, removing your own access, removing a member, deleting what can't be undone or what others depend on) — confirmed actions have no Undo. Reversible deletes, archives, restores and pauses act immediately with Undo. Typed-name confirmation only for workspace archive.
6. **Enabled primaries**: primaries stay enabled and explain what's missing on press (inline FieldError / helper text). Disabled only when permission-blocked, with a `data-tip` saying why. Hide what the caller cannot do.
7. **Every status has a next step** visible to the person responsible; no dead ends.
8. **Never fake success**: every action changes coherent mock state and the UI reflects it; prototype-only simulations carry a Demo data / `Preview` chip (platform console, workspace archive).
9. Status is never color alone (chip label + dot/icon). No decorative gradients, illustrations or metric walls; numbers appear only where they lead to an action, and every count appears once.
10. Dialogs follow one pattern: icon tile + verb-first title + one-line description of what happens next; fields grouped top-down with smart defaults and inline validation that clears as you type; advanced or long options behind a `disclosure`; a quiet footer hint (`footStart`), ghost Cancel and a primary that repeats the verb, shows `loading`, and ends in a toast.
11. Progressive disclosure by default ([PRODUCT_DESIGN_RULES.md](../PRODUCT_DESIGN_RULES.md)): tools appear when the content needs them (list tools at 7+ items, pagination at 2+ pages, tabs only when they split something), side panels open on demand and one at a time, administration collapses in the sidebar until it's needed (a dot when collapsed).

## Vocabulary

One word per concept, everywhere:

| Concept | Words |
| --- | --- |
| Find vs answer | **Search documents** (→ Browse with `q`) · **Ask AI** (cited answer). Ask AI ranks first only for question-like text (`isQuestion`) |
| Ask about one document | **Ask about this document** → Reader with the Ask panel (`/doc/:id?ask=1`); the Reader's own button is **Ask** |
| Ask about several | **Ask about these** · **Ask about this collection** · **Ask AI** → new conversation |
| Chat | Object **Conversation**, action **New chat**, menu **Delete conversation** |
| Adding knowledge | **Contribute** (shared, goes to review) · **Upload** (My files only) |
| Review | **Approve & publish** · **Request changes** · **Decline**; state **Declined** |
| Changed at source | **Publish update** (synced documents) · **Replace file** (uploads only) |
| Knowledge base access | **Everyone** (anyone in the workspace can find it and ask about it) · **Restricted** (only the people and groups you add, plus space members) · **Private** (only its owners) |
| Roles | **Viewer** (search and read) · **Editor** (also add documents and edit details) · **Owner** (also review submissions, manage access and settings) |
| Requests | Status from `X.requestStatus`; queue segments **Open / Closed** |
| Work kind | **Evidence review** |
| Admin area | **People** |
| Appearance | **Mode** (Light · Dark · System) · **Theme** (named looks) |

## Responsive

Breakpoints are container queries on `#frame` (`@container app`), so the prototype's tablet (834 px) and phone (390 px) previews exercise the real rules.

| Width | Behavior |
| --- | --- |
| ≥ 1024 px | Persistent sidebar (collapsible from the topbar), side panels inline |
| < 1024 px | Sidebar off-canvas with backdrop; side panels overlay; form sections stack |
| < 760 px | Tables become card rows |
| < 680 px | 16 px gutters, compact headers, trailing actions and toolbars wrap under content, modals and popovers as bottom sheets, drawers as full-height sheets, single-column grids, no keyboard-only hints on touch |

## Accessibility

Landmarks and headings; visible 2 px accent focus ring with offset; labels on every control; `aria-current`, `aria-selected`, `aria-checked`, `aria-expanded`, `aria-invalid`, live toast region; focus trapped in dialogs and returned to the trigger; full keyboard support for menus (arrows/Home/End/Escape), palette, tabs and actionable rows; reduced-motion respected; status never conveyed by color alone.

## Language

Interface language is a personal setting: **English** (source) and **Tiếng Việt**. It changes menus, buttons, labels, messages, tooltips, placeholders, numbers, dates and relative times. **Content keeps the language it was written in**: documents, quotes, assistant answers, suggested questions, user input and workspace-authored names (topics, knowledge bases, spaces, collections, document titles, custom roles).

- Where: Preferences (Language), account menu (Language → list), sign-in/sign-up/workspace pages (picker next to the logo), command palette, prototype bar (EN/VI). Switching applies at once, with an Undo toast; persisted with the other preferences (`S.lang`); `<html lang>` follows.
- How: screens are written in English. `scripts/core/i18n.js` localizes every rendered node before paint (MutationObserver) from `scripts/i18n/vi.js`: exact strings, `{0}` patterns for runtime values (captured values are localized too), " · "-separated parts, and plural-suffix placeholders dropped. `util.js` formatters (`fmtNum`, `fmtDate`, `rel`, `relFuture`, `plural` + `I18N_VI_NOUNS`) use the interface locale.
- Content guard: nodes inside `[translate="no"]`, answers, user bubbles, document pages, citation quotes and suggested-question chips are never touched; a text node equal to a workspace record name is left as written unless it sits in chrome (sidebar, topbar, menus, tabs, page header, buttons).
- Adding copy: add the English string and its translation to `vi.js` (keep `{n}` placeholders). Patterns need real words around placeholders (≥ 3 letters, ≥ 8 when the string starts and ends with a placeholder) so they can't rewrite content.
- Glossary (fixed terms): Home Trang chủ · Inbox Hộp thư · Knowledge Tri thức · Knowledge base Kho tri thức · Browse Duyệt tìm · My library Thư viện của tôi · Collection Bộ sưu tập · Conversation Cuộc trò chuyện · Ask Hỏi · Document Tài liệu · Source Nguồn · Citation Trích dẫn · Topic Chủ đề · Workspace Không gian làm việc · Space Không gian · Request Yêu cầu · Contribute Đóng góp · Review Kiểm duyệt · Publish Xuất bản · Verified Đã xác minh · Archive Lưu trữ · Settings Cài đặt · Preferences Tùy chọn · Appearance Giao diện · Language Ngôn ngữ · Undo Hoàn tác. Product and vendor names, keys, codes, file names and people stay as written.

## Files

```text
ux-preview.html           shell: stylesheets + ordered classic scripts (file:// safe)
styles/tokens.css         HeroUI theme tokens (light/dark), derived from the theme inputs
styles/base.css           reset, typography, small utility set
styles/components.css     HeroUI components
styles/layout.css         app shell, page, split panels, auth, prototype bar
styles/pages/*.css        screen-specific composition only
scripts/core/*.js         util, icons, store, theme (appearance → CSS variables), i18n (interface language), router, ui builders, overlays, shell, app loop, prototype bar
scripts/i18n/vi.js        Vietnamese interface dictionary (strings, patterns, counter nouns)
scripts/data/mock.js      mock data and lookups
scripts/features/*.js     one IIFE per product area, registering pages/actions/dialogs
```
