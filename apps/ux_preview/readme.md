# BoMesh UX prototype

Interactive, framework-free prototype of BoMesh — a context-aware AI workspace that answers from an organisation's own knowledge and helps people finish the work that follows — built on the HeroUI v3 design system. It is the canonical reference for BoMesh presentation and UX flows; API, authorization, persistence and agent contracts stay in `backend/docs_design`.

Two demo workspaces run on the same platform: **Northwind Group** (Enterprise template) and **UTE Campus** (Campus template — courses, research groups and offices; see `docs/CAMPUS_WORKSPACE.md`).

## Open it

Open `ux-preview.html` directly in a browser (`file://`). No server, build, or dependencies. Data lives in memory and `localStorage`; use the prototype bar's reset button to restore the original data.

## Prototype bar (bottom of the screen, outside the product)

| Control | Purpose |
| --- | --- |
| Northwind · UTE Campus | Switch the demo workspace (the persona follows) |
| Persona buttons | Northwind: Member · Admin · Operator. UTE: Student · Lecturer · Researcher · Admin · Operator |
| State | Force Live, Loading, Empty or Error on any app screen |
| Theme | Light / dark / system and the background (Green, Neutral, Slate, Violet, Sand) |
| Desktop · Tablet · Phone | Render the app at 834 px or 390 px using the real responsive rules |
| Journeys | Start an end-to-end task for any persona |
| Palette icon | Design-system gallery (`#/design`) |
| Reset | Restore the original demo data |

Demo sign-in (password `demo`): Northwind — `minh.pham@northwind.com`, `linh.tran@northwind.com`, `alex.rivera@northwind.com`; UTE — `22110101@student.ute.edu.vn`, `hunglv@ute.edu.vn`, `hapt@ute.edu.vn`, `lanvt@ute.edu.vn`.

## Product map

| Persona | Destinations |
| --- | --- |
| Northwind member | New chat · Inbox · Knowledge (Discover · Browse · My library · Knowledge bases) · Conversations · Search (⌘K) · workspace switcher |
| UTE student, lecturer, researcher | Home · Inbox · Work · Requests · Knowledge · Conversations · Spaces (my courses, labs) · Search |
| Knowledge managers (lecturers, researchers, office staff) | + Manage › Knowledge health for the bases they look after |
| Workspace admin | + Overview · Sources · Connections · Knowledge health · People · Assistant · Activity · Settings (incl. Workspace setup: template, modules, space types, workflows) |
| Platform operator | Platform console: Workspaces · Users · Connectors · Usage · Audit log · System health |

See `docs/KNOWLEDGE_HUB.md` (knowledge concept, IA, journeys, backend alignment), `docs/CAMPUS_WORKSPACE.md` (UTE concept and journeys), `docs/PRODUCT_FLOW.md` (platform, IA, journeys), `docs/SCREEN_INVENTORY.md` (every route and surface), `docs/PAGE_AUDIT.md` (per-page purpose and decisions) and `docs/DESIGN_SYSTEM.md` (tokens, components, rules).

## Code structure

```text
ux-preview.html        stylesheets + ordered classic <script> tags (file:// safe)
styles/                tokens → base → components (HeroUI) → layout → pages/*
scripts/core/          util, icons, store (state + per-workspace persistence), workspace (templates, modules,
                       space types, workflows, work-kind registry), catalog (resource model: kinds, topics, trust,
                       permission-filtered search and facets, library, collections, governance signals),
                       router (IA), ui (component builders), overlays (modal, drawer, menu, toast, palette, tooltip),
                       shell, app (render + events), proto
scripts/data/          mock.js (scoped data store D, Northwind + platform records), ute.js (UTE Campus),
                       knowledge.js (taxonomies, resource metadata, UTE catalog, collections, library seeds)
scripts/features/      one IIFE per product area: registers P (pages), A (actions), M (modals),
                       DR (drawers), MENUS, AFTER hooks and X (cross-module exports)
```

Rendering is a small loop: state changes call `refresh()`, the current route's `P[page]` returns HTML built from `ui.js` builders, and delegated events dispatch `data-act` → `A[name]`. Overlays render from state into `#layer`, so a re-render never loses an open dialog.

## Extending

1. Check the HeroUI component docs first; compose existing builders in `scripts/core/ui.js`. Add a new builder (and its HeroUI-named CSS in `components.css`) only when HeroUI has the component and the prototype lacks it.
2. Use theme tokens only — no raw colors outside `tokens.css`.
3. New screen: add the route in `scripts/core/router.js` (with `module:` if it belongs to an optional module), navigation in `scripts/core/shell.js`, the renderer in a feature file, then document it in `docs/SCREEN_INVENTORY.md` and `docs/PAGE_AUDIT.md`. New domain behaviour goes through template configuration (`scripts/core/workspace.js`), never workspace-name checks.
4. One primary action per region; every visible control must perform a local mock action; mutations change data, then toast.
5. Wrap list/table data in `gate()` so Loading/Empty/Error states work; use `@container app` queries for responsive rules.
6. Verify in light and dark, at desktop, tablet and phone widths, opened from `file://`.
