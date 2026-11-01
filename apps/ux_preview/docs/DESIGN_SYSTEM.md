# BoMesh design system

HeroUI v3 is the only design authority. The prototype reproduces HeroUI's tokens, component anatomy and BEM class names in plain CSS so every element maps 1:1 to a documented component.

- Components: <https://heroui.com/en/docs/react/components>
- Theme: [Theme Builder — CRM, hue 139.21, base 0.02, Google Sans, radius M, field radius L](https://heroui.com/en/themes?template=crm&hue=139.20631987695046&fontFamily=google-sans&base=0.02)
- Living gallery: `ux-preview.html#/design` (rendered with the same builders as the product, so it cannot drift).

## Tokens — `styles/tokens.css`

Light and dark lightness values are the Theme Builder export; hover, soft and border variants use HeroUI's own `color-mix()` formulas from `themes/default/variables.css`. Components and pages use only these variables.

**Background is switchable.** The export's neutrals carry chroma 0.02 at the accent hue (Theme Builder "Base"). In `tokens.css` every neutral is `oklch(L calc(C × var(--tint)) var(--base-hue))`, and `<html data-bg>` selects a preset: Green (hue 139.21, the export — default), Neutral (tint 0, HeroUI default gray), Slate (250), Violet (292), Sand (75). Accent, status and evidence colors never change. Users switch it in Preferences or the account menu (`setBackground()`, persisted with the mode); presets live in `BACKGROUNDS` (store.js) and the matching `[data-bg]` rules — add a preset in both places. The picker is HeroUI's ColorSwatchPicker (`swatchPicker()`).

| Role | Tokens | Use |
| --- | --- | --- |
| Canvas | `--background`, `--foreground`, `--muted` | App background, body text, secondary text (tinted by the background preset) |
| Surfaces | `--surface`, `--surface-secondary`, `--surface-tertiary`, `--overlay` | Cards/lists/table bodies; table roots and quiet panels; skeletons; menus, dialogs, drawers, toasts |
| Controls | `--default`, `--default-hover`, `--field-background`, `--segment` | Tertiary buttons, chips, switch tracks; inputs; selected tab/segment |
| Accent | `--accent`, `--accent-soft`, `--accent-soft-foreground`, `--focus` | Primary action, current navigation, selection, focus ring |
| Status | `--success`, `--warning`, `--danger` (+ `-soft`, `-soft-foreground`) | Status chips, alerts, destructive actions |
| Lines | `--border`, `--separator` | Outline buttons, dividers, table rows |
| Elevation | `--surface-shadow`, `--overlay-shadow`, `--field-shadow` | Cards (light only; dark uses a 1 px border), overlays, fields |
| Evidence | `--evidence`, `--evidence-strong` | Citation markers and highlighted passages only (derived from warning; never reused for generic warnings) |

Radius scale is HeroUI's (`--radius` = 8 px): fields 12 px, cards/lists/table bodies 16 px, dialogs/drawers/toasts 24 px, buttons/chips/tabs pill.

Typography: Google Sans Flex (system fallback offline). Body 14/20, labels 13/18 medium, meta 12/16, section 15/22 semibold, page title 20/28 semibold, KPI 24/32 semibold tabular.

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
| Up next list — `X.upNext()` / `X.upNextList()` | Home, space overview | ListBox rows, Chip (due/overdue tone), one Button per row |
| Work item — `X.workItem()` | Work, Home Continue, space Work tab | ListBox row, kind icon tile, status Chip |
| Request row and status vocabulary — `X.requestItem()`, `STATUS.svc` | Requests, Home, space queue | Table/ListBox, Chip (needs reply = warning, overdue = danger) |
| Rule check card | New request | Card, check/warn/fail icons, citation markers |
| Stepper | New work | Numbered segments in the ToggleButtonGroup style |
| Evidence matrix | Literature review | Table with sticky first column, citation markers per cell, Drawer for evidence |
| Document editor | Draft | Surface card, ToggleButton toolbar, side rail with Tabs (Sources · Versions) |
| Follow-up chips | Chat answers (`m.next`) | Button `sm` secondary/tertiary |
| Knowledge header — `X.res.hubHeader(active)` | Discover, Browse, My library, Knowledge bases | Page header + Demo data Chip + primary Tabs as section navigation |
| Resource row / card / table row — `X.res.row`, `X.res.card`, `X.res.tableRow` | Every list of resources (Discover, Browse, Library, collections, bases, spaces, Related, search) | ListBox row: file icon, title with highlights, trust Chip, meta line (source glyph · type · base · updated), summary or snippet, topic links, Save toggle + ⋯ Dropdown |
| Trust chip — `X.res.trustChip` | Rows, Reader header, details | Chip: Verified (success, shield), Review due (warning, clock), Not verified (default, dashed circle); the tooltip says who and when |
| Facet rail | Browse | Disclosure groups of Checkboxes with counts, topic tree, "Show all", Saved views list; becomes a Drawer ≤ 1023 px |
| Metadata list — `X.res.details` | Reader About, Browse preview, duplicate compare | Description list: type, topics, spaces, owner, base, source path, trust, version, language, who can see it |
| Reader rail | Reader | Tabs (Ask · About · Related); Ask = suggestion Buttons, message bubbles, citation cards that highlight the page, input |
| Pickers — Add to collection, Link to spaces, Edit details topics | Dialogs | Bordered Checkbox list in a scroll area; inline "New collection" field |

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

## Files

```text
ux-preview.html           shell: stylesheets + ordered classic scripts (file:// safe)
styles/tokens.css         HeroUI theme tokens (light/dark)
styles/base.css           reset, typography, small utility set
styles/components.css     HeroUI components
styles/layout.css         app shell, page, split panels, auth, prototype bar
styles/pages/*.css        screen-specific composition only
scripts/core/*.js         util, icons, store, router, ui builders, overlays, shell, app loop, prototype bar
scripts/data/mock.js      mock data and lookups
scripts/features/*.js     one IIFE per product area, registering pages/actions/dialogs
```
