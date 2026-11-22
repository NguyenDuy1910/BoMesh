# BoMesh UX preview

Interactive, framework-free prototype of BoMesh — a context-aware AI workspace that answers from an organisation's own knowledge and helps people finish the work that follows — built on the HeroUI v3 design system.

It is the canonical UX source for `apps/web` (Next.js + HeroUI, Bun): screens, flows and vocabulary are designed here first. API, authorization, persistence and agent contracts live in `backend/docs_design`.

## Open it

Open `ux-preview.html` directly in a browser (`file://`). No server, build or dependencies. Data lives in memory and `localStorage`; the prototype bar's Reset restores the seed data. Routes are hash routes, e.g. `ux-preview.html#/knowledge`.

## Prototype bar

Shown at the bottom of the screen, outside the product.

| Control | Purpose |
| --- | --- |
| Northwind · Finx · UTE | Switch the demo workspace; the persona follows to its closest equivalent |
| Persona buttons | View as any persona of the current workspace (see below) |
| State | Force Live, Loading, Empty or Error on any app screen |
| Palette icon (after State) | Light / dark / system mode and named themes; opens the Appearance drawer (accent, base tint, radius, font) |
| EN / VI | Interface language (English / Tiếng Việt); content stays in its own language |
| Desktop · Tablet · Phone | Render at full width, 834 px or 390 px using the real responsive rules |
| Journeys | Start an end-to-end task for a persona |
| Palette icon (after Journeys) | Design-system gallery (`#/design`) |
| Reset | Restore the original demo data |
| Chevron | Hide the prototype controls |

## Demo workspaces and personas

| Workspace | Template | Personas |
| --- | --- | --- |
| Northwind Group | Enterprise | Member, Admin, Operator |
| Finx Workspace — fictional Vietnamese digital-banking company with Spaces, Work and Requests on ([docs/FINX_WORKSPACE.md](docs/FINX_WORKSPACE.md)) | Enterprise | Engineer, Lead, Analyst, Admin, Operator |
| Trường Đại học UTE — fictional Vietnamese university, content in Vietnamese (`scripts/data/campus.js`) | Campus | Student, New student, Lecturer, Admin, Operator |

The Operator is the platform operator and can open every workspace. Every persona lands on Home ([docs/HOME.md](docs/HOME.md)).

### Sign in

Password `demo` for every account (any persona email, or its local part as username):

- Northwind: `minh.pham@northwind.com` (Member), `linh.tran@northwind.com` (Admin), `alex.rivera@northwind.com` (Operator)
- Finx: `khoa.tran@finx.vn` (Engineer), `ha.le@finx.vn` (Lead), `bao.pham@finx.vn` (Analyst), `lan.vo@finx.vn` (Admin)
- UTE: `22110101@student.ute.edu.vn` (Student), `25110072@student.ute.edu.vn` (New student), `hunglv@ute.edu.vn` (Lecturer), `phuongttm@ute.edu.vn` (Admin)

### Journeys

Defined in `JOURNEYS` in `scripts/core/proto.js`. By persona:

- **Northwind member** — sign in and ask; verify an answer's source; request access; contribute a document, track it and revise it after review; pick up and share conversations; join a workspace from an invite link.
- **Northwind admin** — set up knowledge (collections → topics → sources); process, review and publish submissions; import topics and reclassify; merge a duplicate; manage sources and accounts; manage people, access requests and invite links; turn on Spaces.
- **Finx engineer, lead, analyst** — start from Home; ask, then file a request; read with AI beside the document; draft from earlier decisions; keep chats in a project; review contributions and manage collection access; compare options; find metric definitions.
- **Finx admin** — follow documents from upload to searchable; choose which uploads to process; fix failed processing; teach classification from corrections; approve proposed topics; work the review queue; configure the workspace.
- **UTE** — first week as a new student; find a form on the knowledge map; look after a department's materials; organise faculties, offices and forms; choose which digitised records to process.
- **Operator** — create a workspace; investigate degraded processing; check indexing health.

## Product map

| Persona | Destinations |
| --- | --- |
| Every member | Workspace: Home · Knowledge (Browse, Map, My library, document reader) · New chat · Work and Requests when the module is on. Your work: Projects · Spaces (module) · My contributions. Search (⌘K) and the Inbox in the header |
| Collection owners and editors | Manage › Knowledge Studio for the collections they look after |
| Workspace admin | Manage: Overview · Knowledge Studio (Documents, Collections, Topics, Sources) · People · Assistant · Activity · Settings |
| Operator | Platform console: Workspaces · Users · Connectors · Indexing · Usage · Audit log · System health |

An area's sections are sidebar sub-rows, never page tabs. The full route list is in `scripts/core/router.js` and [docs/SCREEN_INVENTORY.md](docs/SCREEN_INVENTORY.md).

## Docs

- [PRODUCT_DESIGN_RULES.md](PRODUCT_DESIGN_RULES.md) — UX rules and review checklist; read before any change.
- [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) — HeroUI v3 mapping, tokens, components, action system.
- [docs/PRODUCT_FLOW.md](docs/PRODUCT_FLOW.md) — product overview and core flows.
- [docs/SCREEN_INVENTORY.md](docs/SCREEN_INVENTORY.md) — every route, its primary action and states.
- [docs/PAGE_AUDIT.md](docs/PAGE_AUDIT.md) — per-screen purpose, main action, content and next step.
- [docs/HOME.md](docs/HOME.md) — Home, where everyone starts.
- [docs/KNOWLEDGE_HUB.md](docs/KNOWLEDGE_HUB.md) — finding, reading and using knowledge.
- [docs/KNOWLEDGE_MAP.md](docs/KNOWLEDGE_MAP.md) — the Knowledge Atlas (`/knowledge/map`).
- [docs/KNOWLEDGE_STUDIO.md](docs/KNOWLEDGE_STUDIO.md) — Manage › Knowledge Studio: intake, explicit processing, review, topics, sources.
- [docs/DOCUMENT_LIFECYCLE.md](docs/DOCUMENT_LIFECYCLE.md) — contribute → process → review → publish.
- [docs/FINX_WORKSPACE.md](docs/FINX_WORKSPACE.md) — the Finx demo workspace.

## Code structure

```text
ux-preview.html     stylesheets + ordered classic <script> tags (file:// safe)
assets/             static files referenced by seed data
styles/             tokens.css → base.css → components.css (HeroUI) → layout.css → pages/*.css
scripts/core/       util, icons, store (state + per-workspace persistence), theme, i18n,
                    workspace (templates, modules, space types, workflows), catalog (resource
                    model, permission-filtered search), lifecycle (publication and processing
                    states, classification), router (IA), ui (component builders),
                    overlays (modal, drawer, popover, menu, toast, palette), shell (sidebar,
                    header), app (render + events), proto (prototype bar, journeys)
scripts/data/       mock.js (Northwind + platform), finx.js, campus.js, knowledge.js,
                    contributions.js
scripts/i18n/       vi.js (Vietnamese interface strings)
scripts/features/   one IIFE per product area, e.g. home, chat + conversations, knowledge,
                    reader, preview, library, contribute, curation (Knowledge Studio),
                    governance, masterdata (topics), documents, sources + connections,
                    shares, people, settings, platform
```

Each feature file registers `P` (pages), `A` (actions), `M` (modals), `DR` (drawers), `PO` (popovers), `MENUS`, `AFTER` hooks and `X` (cross-module exports). State changes call `refresh()`; the current route's `P[page]` returns HTML built from `ui.js` builders; delegated events dispatch `data-act` → `A[name]`. Overlays render from state into `#layer`, so a re-render never loses an open dialog.

## Extending

1. Read [PRODUCT_DESIGN_RULES.md](PRODUCT_DESIGN_RULES.md) first and run its UX review before designing or changing any page or component.
2. Check the HeroUI component docs; compose existing builders in `scripts/core/ui.js`. Add a builder (with HeroUI-named CSS in `styles/components.css`) only when HeroUI has the component and the prototype lacks it.
3. Use theme tokens only — no raw colors outside `styles/tokens.css`.
4. New screen: add the route in `scripts/core/router.js` (with `module:` if it belongs to an optional module), navigation in `scripts/core/shell.js`, the renderer in a feature file, then document it in `docs/SCREEN_INVENTORY.md` and `docs/PAGE_AUDIT.md`. Domain differences go through template configuration in `scripts/core/workspace.js`, never workspace-name checks.
5. Follow the action system in `docs/DESIGN_SYSTEM.md`; every visible control performs a local mock action, and mutations change data, then toast.
6. Wrap list/table data in `gate()` so Loading/Empty/Error states work; use `@container app` queries for responsive rules.
7. Verify in light and dark, at desktop, tablet and phone widths, opened from `file://`.
