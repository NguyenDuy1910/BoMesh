# BoMesh UX prototype

Interactive, framework-free prototype of BoMesh — a context-aware AI workspace that answers from an organisation's own knowledge and helps people finish the work that follows — built on the HeroUI v3 design system. It is the canonical reference for BoMesh presentation and UX flows; API, authorization, persistence and agent contracts stay in `backend/docs_design`.

Two demo workspaces run on the same platform: **Northwind Group** (Enterprise template) and **Finx Workspace** (Enterprise template with Spaces, Work and Requests on — a fictional Vietnamese digital-banking and payments company; see `docs/FINX_WORKSPACE.md`). Every workspace lands on the knowledge-first **Home** (`docs/HOME.md`). The Campus template is available in Workspace setup but has no demo workspace.

## Open it

Open `ux-preview.html` directly in a browser (`file://`). No server, build, or dependencies. Data lives in memory and `localStorage`; use the prototype bar's reset button to restore the original data.

## Prototype bar (bottom of the screen, outside the product)

| Control | Purpose |
| --- | --- |
| Northwind · Finx | Switch the demo workspace (the persona follows) |
| Persona buttons | Northwind: Member · Admin · Operator. Finx: Engineer · Lead · Analyst · Admin · Operator |
| State | Force Live, Loading, Empty or Error on any app screen |
| Theme | Light / dark / system and quick themes; "Theme and colors…" opens the Appearance drawer (19 themes — default BoMesh · Calm sage — accent, background tint, radius, font) |
| EN / VI | Interface language (English / Tiếng Việt). Content stays in its own language |
| Desktop · Tablet · Phone | Render the app at 834 px or 390 px using the real responsive rules |
| Journeys | Start an end-to-end task for any persona (e.g. Northwind member: *Contribute a document and track it*, *Track my contributions*, *Pick up a recent conversation*; Northwind admin: *Finish setting up knowledge (bases → taxonomy → sources)*, *Import a taxonomy and reclassify submissions*, *Connect a source*; Finx engineer: *Pick up where you left off*, *Keep related chats in a project*; Finx admin: *Follow every document through the Studio flow*, *Keep policies verified and tagged*). Defined in `scripts/core/proto.js` | |
| Palette icon | Design-system gallery (`#/design`) |
| Reset | Restore the original demo data |

Demo sign-in (password `demo`): Northwind — `minh.pham@northwind.com`, `linh.tran@northwind.com`, `alex.rivera@northwind.com`; Finx — `khoa.tran@finx.vn`, `ha.le@finx.vn`, `bao.pham@finx.vn`, `lan.vo@finx.vn`.

## Product map

| Persona | Destinations |
| --- | --- |
| Northwind member | Workspace: Home · Knowledge (Browse · My library: Saved, My files, My collections; document preview · Reader · Contribute) · AI Chat (composer + conversations) · Your work: Recent · Projects · My contributions · sidebar search (⌘K) and Inbox bell |
| Finx engineer, lead, analyst | Workspace: Home · Knowledge · AI Chat · Work · Requests · Your work: Recent · Projects · Spaces (my teams, projects, offices) · My contributions · Search · Inbox |
| Owners and editors of a knowledge base (Finx engineer edits Payments Platform) | + Manage › Knowledge Studio → Knowledge bases (base page: Access · Sources · Settings) for the bases they look after |
| Reviewers (owners of a knowledge base: Finx lead and analyst, office staff) | + Manage › Knowledge Studio (Review queues · Library · Knowledge bases) for the bases they own; space staff also review teammates' drafts |
| Workspace admin | + Manage: Overview (Knowledge health) · Knowledge Studio (Review · Library │ Knowledge bases · Taxonomy · Sources with Sync history and Accounts) · People · Assistant · Activity · Settings (General with Request archive; Workspace setup: template, modules, space types, workflows) |
| Platform operator | Platform console: Workspaces · Users · Connectors · Indexing · Usage · Audit log · System health |

See `docs/HOME.md` (knowledge-first Home: sections, curation, decisions), `docs/KNOWLEDGE_STUDIO.md` (Manage IA, Studio tabs, Review queues, Library, Knowledge health, setup order, sources and publishing policies, the 100k first sync), `docs/DOCUMENT_LIFECYCLE.md` (contribute → curate → publish per document, taxonomy and classification, roles, permissions, journeys), `docs/KNOWLEDGE_HUB.md` (knowledge concept, IA, journeys, backend alignment), `docs/FINX_WORKSPACE.md` (Finx concept, personas and journeys), `docs/PRODUCT_FLOW.md` (platform, sidebar IA, journeys), `docs/SCREEN_INVENTORY.md` (every route and surface), `docs/PAGE_AUDIT.md` (per-page purpose and decisions) and `docs/DESIGN_SYSTEM.md` (tokens, components, rules).

## Code structure

```text
ux-preview.html        stylesheets + ordered classic <script> tags (file:// safe)
styles/                tokens → base → components (HeroUI) → layout (app shell, sidebar groups and icon rail, compact header, section bar) → pages/*
                       (e.g. pages/studio.css: Knowledge Studio flow strip, Progress stepper, classification evidence;
                       pages/curation.css: Review workbench and queue chooser; pages/taxonomy.css: Taxonomy tree + detail)
scripts/core/          util, icons, store (state + per-workspace persistence), theme (personal appearance:
                       accents, named themes, base tint, radius, font → CSS variables), i18n (interface language:
                       localizes rendered nodes from scripts/i18n/<lang>.js; content untouched), workspace (templates, modules,
                       space types, workflows, work-kind registry), catalog (resource model: kinds, topics, trust,
                       permission-filtered search and facets, library, collections, governance signals),
                       lifecycle (contribute → classify → review → publish: stages, flow-strip groups, permissions,
                       taxonomy classification (keywords, synonyms, rules, examples) with evidence (topicEvidence), auto-classification, re-classification,
                       proposed topics, decisions, access vocabulary), router (IA and old-address redirects), ui (component builders, searchField,
                       badge, isQuestion, bareName), overlays (modal, drawer, popover, menu, toast, palette, tooltip), shell (sidebar: Workspace / Your work /
                       Manage groups, per-person collapse, icon rail; topbar() compact header), app (render + events), proto (prototype bar, journeys)
scripts/data/          mock.js (scoped data store D, Northwind + platform records), finx.js (Finx Workspace),
                       knowledge.js (taxonomy: topics with codes, keywords, synonyms, examples, guidance, rules, import history; resource metadata,
                       Finx catalog, featured, collections, library seeds),
                       contributions.js (submissions in every lifecycle stage, source publishing policies)
scripts/features/      one IIFE per product area: registers P (pages), A (actions), M (modals),
                       DR (drawers), PO (popovers), MENUS, AFTER hooks and X (cross-module exports);
                       chat.js (AI Chat: composer + conversation list) + conversations.js; recent.js (/recent);
                       projects.js (/projects, /project/:id); library.js (My library, /contributions);
                       contribute.js (Contribute: Analyzing → Check the details); overview.js (Knowledge health);
                       preview.js is the shared document preview (X.preview.open); Knowledge Studio is
                       curation.js (page, tabs, setup guide, Review workbench and queues, Library, document drawer)
                       + governance.js (To keep right queues, Topics to confirm) + masterdata.js (Taxonomy tree,
                       topic detail, test box, proposals, import/export) + knowledge.js (Knowledge bases, /studio/bases/:id)
                       + sources.js / connections.js (Sources: sources, sync history, accounts, first sync)
```

Rendering is a small loop: state changes call `refresh()`, the current route's `P[page]` returns HTML built from `ui.js` builders, and delegated events dispatch `data-act` → `A[name]`. Overlays render from state into `#layer`, so a re-render never loses an open dialog.

## Extending

0. Read [PRODUCT_DESIGN_RULES.md](PRODUCT_DESIGN_RULES.md) first and run its UX review (primary intent, shortest journey, remove competing elements, simplest pattern) before designing or changing any page or component.
1. Check the HeroUI component docs first; compose existing builders in `scripts/core/ui.js`. Add a new builder (and its HeroUI-named CSS in `components.css`) only when HeroUI has the component and the prototype lacks it.
2. Use theme tokens only — no raw colors outside `tokens.css`.
3. New screen: add the route in `scripts/core/router.js` (with `module:` if it belongs to an optional module), navigation in `scripts/core/shell.js`, the renderer in a feature file, then document it in `docs/SCREEN_INVENTORY.md` and `docs/PAGE_AUDIT.md`. New domain behaviour goes through template configuration (`scripts/core/workspace.js`), never workspace-name checks.
4. Follow the action system in `docs/DESIGN_SYSTEM.md` (one primary per region, whole-row targets, reveal-on-hover secondary actions, instant + Undo for reversible changes, confirmation only when irreversible, canonical vocabulary); every visible control must perform a local mock action; mutations change data, then toast.
5. Wrap list/table data in `gate()` so Loading/Empty/Error states work; use `@container app` queries for responsive rules.
6. Verify in light and dark, at desktop, tablet and phone widths, opened from `file://`.
