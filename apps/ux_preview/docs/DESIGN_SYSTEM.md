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
| Theme | 18 named looks: BoMesh (default: the CRM export), HeroUI, Ocean, Sky, Forest, Lagoon, Midnight, Lavender, Plum, Orchid, Sakura, Rose, Crimson, Sunset, Amber, Lemon, Lime, Graphite | Bundles the four settings below; changing any of them makes the theme "Custom" |
| Accent | 18 swatches (green → graphite) + custom hue slider | `--accent`, `--accent-foreground`, `--focus`, accent soft tones: primary buttons, links, current navigation, selection, focus rings, charts |
| Background tint (Theme Builder "Base") | Neutral 0, Subtle 0.5×, Tinted 1× (export), Rich 1.8× | Every neutral — canvas, surfaces, fields, borders, text — at the accent hue |
| Radius | None, Small, Medium (export), Large, XL | `--radius` scale; fields get 1.5× |
| Font | Google Sans (export), Inter, Be Vietnam Pro, IBM Plex Sans, Manrope, System | `--font-sans`; Google fonts load on demand, system fallback offline |

Mechanics: `scripts/core/theme.js` holds the registries (`ACCENTS`, `BASES`, `RADII`, `FONTS`, `THEMES`) and `applyTheme()`, which writes the inputs (`--accent-l/c/h`, `--accent-fg`, `--accent-ink`, `--base-hue`, `--tint`, `--radius`, `--field-radius`, `--font-sans`) on `<html>`. `tokens.css` derives every color from them; its `:root` defaults are the BoMesh theme. Light accents (Amber, Yellow, Lime) use dark text on the accent and a darker soft foreground; Graphite flips to near-white in dark mode. Status (success, warning, danger) and evidence colors never change: they carry meaning, not brand. Workspace marks keep the workspace's own logo color. The look is persisted with the mode (`S.look`). Add a theme by adding a `THEMES` entry; add an accent in `ACCENTS`.

UI: the **Appearance** drawer (`features/appearance.js`, clear backdrop so the app re-themes live behind it) shows mode, a gallery of theme cards (each drawn from its own colors via `themePreview()`), then Customize: accent (ColorSwatchPicker + hue slider), background tint, radius and font. Entry points: account menu ("Theme and colors…"), Preferences (Appearance row), command palette, prototype bar (mode + quick themes, with Undo toast) and `#/design`.

| Role | Tokens | Use |
| --- | --- | --- |
| Canvas | `--background`, `--foreground`, `--muted` | App background, body text, secondary text (tinted at the accent hue by the background tint) |
| Surfaces | `--surface`, `--surface-secondary`, `--surface-tertiary`, `--overlay` | Cards/lists/table bodies; table roots and quiet panels; skeletons; menus, dialogs, drawers, toasts |
| Controls | `--default`, `--default-hover`, `--field-background`, `--segment` | Tertiary buttons, chips, switch tracks; inputs; selected tab/segment |
| Accent | `--accent`, `--accent-soft`, `--accent-soft-foreground`, `--focus` | Primary action, current navigation, selection, focus ring |
| Status | `--success`, `--warning`, `--danger` (+ `-soft`, `-soft-foreground`) | Status chips, alerts, destructive actions |
| Lines | `--border`, `--separator` | Outline buttons, dividers, table rows |
| Elevation | `--surface-shadow`, `--overlay-shadow`, `--field-shadow` | Cards (light only; dark uses a 1 px border), overlays, fields |
| Evidence | `--evidence`, `--evidence-strong` | Citation markers and highlighted passages only (derived from warning; never reused for generic warnings) |

Radius scale is HeroUI's (`--radius` = 8 px in the default theme): fields 12 px, cards/lists/table bodies 16 px, dialogs/drawers/toasts 24 px, buttons/chips/tabs pill. The theme's radius setting scales all of these.

Typography: Google Sans Flex by default (system fallback offline); the theme's font replaces `--font-sans` everywhere. Body 14/20, labels 13/18 medium, meta 12/16, section 15/22 semibold, page title 20/28 semibold, KPI 24/32 semibold tabular.

## Components — `styles/components.css` + `scripts/core/ui.js`

Screens never hand-roll markup for these; they call the builder.

| HeroUI component | Builder | Notes |
| --- | --- | --- |
| Button | `btn(label, {v, size, icon, loading, menu, href})`, `iconBtn`, `linkBtn` | Variants `primary` (one per region), `secondary`, `tertiary` (default), `ghost`, `outline`, `danger`, `danger-soft`; sizes sm 32 / md 36 / lg 40; press scales to 0.97; loading keeps width |
| Chip | `chip(label, {tone, variant})`, `status(kind, value)` | One status vocabulary (`STATUS` in ui.js). Healthy steady states are quiet (tertiary); action-required states are soft color + dot |
| Card | `card()`, `statCard()` | KPI card follows the CRM template: icon tile, label, value, meta |
| ListBox | `list()`, `item()` | Rows with lead icon/avatar, title, description, meta, trailing actions |
| Table | `table()`, `sortHead`, `selCheck`, `bulkBar`, `pager` | HeroUI primary table (gray root, white body). Below 760 px rows become cards (primary cell, actions, wrapped metadata) |
| Tabs | `tabs(items, active, base, {variant})` | `secondary` (underline) for page sections, `primary` (pill) for in-content filters; tabs are links so sections are deep-linkable |
| ToggleButtonGroup | `seg()` | Mutually exclusive view options |
| TextField / TextArea / Select | `field()` + `input()` / `textarea()` / `select()` | Visible label, description, inline `FieldError` with `aria-invalid` |
| Switch / Checkbox / RadioGroup | `switchCtl`, `switchRow`, `checkbox`, `choiceGroup` | Radio cards for consequential choices |
| SearchField | `searchField()` | With clear button; pairs with `filterButton()` dropdowns |
| Alert | `alertBox(tone, title, desc, actions)` | One alert per problem, with its fix as the action |
| EmptyState | `emptyState()`, `errorState()` | First use, no results, no access and failure have different copy and recovery |
| Skeleton / ProgressBar / Spinner | `skelRows`, `skelCards`, `progress`, `spinner` | Structure-preserving loading |
| Avatar / Kbd | `avatar(name, size)`, `kbd()` | Avatars use soft tones stable per name |
| Modal / Drawer / Dropdown / Toast / Tooltip | `M`, `DR`, `MENUS`, `toast()`, `data-tip` (overlays.js) | Modal becomes a bottom sheet and drawer a full-height sheet below 680 px |
| Breadcrumbs | `crumbs([...])` | Rendered in the topbar |

Domain marks: `fileIcon(type)` (soft tone per file family), `appIcon(key)` (connector brand glyph on a neutral tile), `wsMark(ws)`, `X.spaceMark(space)` (space color tile with the space-type icon), sidebar `.space-dot`, and `.cite` citation markers.

Workspace-level compositions (built from the components above; domain-neutral so any template reuses them):

| Composition | Where | HeroUI parts |
| --- | --- | --- |
| Up next list — `X.upNext()` / `X.upNextList()` | Home (Pick up where you left off, up to 3 when Spaces is on), space overview | ListBox rows, Chip (due/overdue tone), one Button per row |
| Work item — `X.workItem()` | Work, space Work tab | ListBox row, kind icon tile, status Chip |
| Request row and status vocabulary — `X.requestItem()`, `STATUS.svc` | Requests, space queue | Table/ListBox, Chip (needs reply = warning, overdue = danger) |
| Rule check card | New request | Card, check/warn/fail icons, citation markers |
| Stepper | New work | Numbered segments in the ToggleButtonGroup style |
| Evidence matrix | Evidence review | Table with sticky first column, citation markers per cell, Drawer for evidence |
| Document editor | Draft | Surface card, ToggleButton toolbar, side rail with Tabs (Sources · Versions) |
| Follow-up chips | Chat answers (`m.next`) | Button `sm` secondary/tertiary |
| Home hero, section header and cards — `features/home.js` + `styles/pages/home.css` | Home | Surface hero with search field, scope Select, Search (secondary) + Ask (primary) Buttons and suggested-question Buttons; section headers with a Tabs switcher (Topics · Knowledge bases · Collections); topic / base / collection Cards (icon tile, name, count, description); compact document rows (Recently published, Recommended with reason). See [HOME.md](HOME.md) |
| Document card and thumbnail — `X.docCard(d, {reason})`, `X.docThumb(d)` | Home Featured knowledge | Card whose link opens the Reader: decorative, inert scaled-down first page of the real rendition (slides keep their ratio), or a tinted type tile when no rendition is ready; type, title, topic and base, freshness, trust Chip; Save stays its own control |
| Knowledge header — `X.res.hubHeader(active)` | Browse, My library, Knowledge bases | Page header + Demo data Chip + primary Tabs as section navigation |
| Resource row / card / table row — `X.res.row`, `X.res.card`, `X.res.tableRow` | Every list of resources (Browse, Library, collections, bases, spaces, Related, search) | ListBox row: file icon, title with highlights, trust Chip, meta line (source glyph · type · base · updated), summary or snippet, topic links, Save toggle + ⋯ Dropdown |
| Trust chip — `X.res.trustChip` | Rows, Reader header, details | Chip: Verified (success, shield), Review due (warning, clock), Not verified (default, dashed circle); the tooltip says who and when |
| Facet rail | Browse | Disclosure groups of Checkboxes with counts, topic tree, "Show all", Saved views list; becomes a Drawer ≤ 1023 px |
| Metadata list — `X.res.details` | Reader About, Browse preview, duplicate compare | Description list: type, topics, spaces, owner, base, source path, trust, version, language, who can see it |
| Reader rail | Reader | Tabs (Ask · About · Related); Ask = suggestion Buttons, message bubbles, citation cards that highlight the page, input |
| Pickers — Add to collection, Link to spaces, Edit details topics | Dialogs | Bordered Checkbox list in a scroll area; inline "New collection" field |
| Lifecycle chip — `lifeChip(d)` (core/lifecycle.js) | Contributions, Documents, Reader, KB pages | Chip with dot: In review / Analyzing (accent, live), Changes requested (warning), Not approved and Couldn't publish (danger), Publishing (accent, live), Published (success, quiet), Waiting to publish / Unpublished (default); tooltip explains the next step |
| Contribute dialog | Knowledge header, ⌘K, bases, My files, "Submit a new version…" | Modal: drop zone, sample chips, radio cards (Share as knowledge · Keep private), Select (knowledge base, "Let the assistant suggest"), optional TextArea, per-file ProgressBar |
| Review split view | Manage → Documents → Review | Left ListBox queue with Checkboxes and filter chips; right detail: note quote, preview Card (rendition page), suggestion fields with confidence Badges, Alerts for flags, sticky decision bar (Request changes · Decline · Approve & publish) |
| Timeline | Contribution drawer, document drawer | Vertical list of events with avatar/icon, actor, relative time and quoted reviewer message; the next expected step at the end |
| Proposed topic card | Documents → Topics | Card with editable name, domain Select, linked submissions, Accept (primary) · Merge into… (Dropdown) · Dismiss |

## Layout — `styles/layout.css`

HeroUI CRM shell: sidebar on the background (workspace switcher + search, navigation groups, account button), topbar (sidebar toggle + breadcrumbs + contextual actions), pages on the same background with surface cards.

- `.page` max 1200 px, 24/32 px padding; `.page--narrow` 800 px for forms.
- `pageHeader()` owns title, one optional line of purpose and the page's primary action. Section tabs sit directly under it. Filters live with the data they filter.
- `.split` + `.split__panel` for side panels (citations, files, document details); below 1024 px panels overlay.
- `.form-section` two-column settings rows; `.savebar` appears only when a form is dirty.

## Rules

1. One primary button per region; everything else is tertiary, ghost or in a menu.
2. Every mutation changes local data first, then confirms with a toast; cheap reversals offer Undo; irreversible ones confirm (typed confirmation for workspace archive).
3. Hide what the caller cannot do; never show a disabled control without a tip explaining why.
4. Status is never color alone (chip label + dot/icon).
5. No decorative gradients, illustrations or metric walls; numbers appear only where they lead to an action.
6. Pages whose backend contract is still a proposal (platform console, workspace archive) carry one outline `Preview` chip in the header.

## Responsive

Breakpoints are container queries on `#frame` (`@container app`), so the prototype's tablet (834 px) and phone (390 px) previews exercise the real rules.

| Width | Behavior |
| --- | --- |
| ≥ 1024 px | Persistent sidebar (collapsible from the topbar), side panels inline |
| < 1024 px | Sidebar off-canvas with backdrop; side panels overlay; form sections stack |
| < 760 px | Tables become card rows |
| < 680 px | 16 px gutters, stacked headers/actions, modals as bottom sheets, drawers as full-height sheets, single-column grids |

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
