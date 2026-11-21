# Home — the Knowledge Atlas

Home is where every person lands in every workspace (`/home`, first sidebar item, the post-sign-in route). BoMesh is a platform: each workspace is an organisation with its own way of keeping documents. Home shows that whole structure on one canvas, the **Knowledge Atlas**: the workspace, every collection, every folder inside it and every document the person can read, drawn the way the organisation keeps them. A university reads Faculty › Academic department › Program group › Major › documents, with Administrative offices and their Forms beside them; a company reads Area › Section › Subsection › Folder. In a few seconds it answers:

1. **What does this workspace know, and how is it organised?** One tinted territory per collection; fit the atlas to see them all, named large.
2. **Where is the thing I need?** Open a branch, find a name, or go straight to a collection.
3. **Which document should I open?** Documents follow one standard order in every group and show what helps choose: verified, new.

| Page | Owns | Identity |
| --- | --- | --- |
| **Home** | The structure of the workspace's knowledge, and a path to every readable document in it | Map & orient |
| **Knowledge** | Searching inside documents, filtering, previewing and reading ([KNOWLEDGE_HUB.md](KNOWLEDGE_HUB.md)) | Find & explore |
| **AI Chat** | Asking, with grounded answers and citations | Ask & understand |
| **Your work** (Recent · Projects · My contributions) | What you touched, organised and submitted | Pick up & track |
| **Inbox** (top-row bell) · **Search** (sidebar search row, ⌘K) | What needs you · jump to anything | — |

Home has no greeting, intent cards or feeds: what needs you is in the Inbox, what you touched is in Recent.

```text
Home (page--canvas)
├── [W] Trường Đại học UTE                       [🖼 Map background] (tenant.manage) [✎ Edit structure] (knowledge.manage, top row)
│       117 documents you can read · 7 collections · 5 levels · 13 updated in the last 30 days
└── Atlas (fills the rest of the page)
    ┌ [⌕ Find in the map] 117 documents │ ☰ Hide documents · ⇕ Expand all · ⇳ Collapse all · Go to ▾ ┐            ┌ Inspector ┐
    │                                                                                                              │ (selected)│
    │  [WORKSPACE Trường Đại học UTE]                                                                              └───────────┘
    │   │
    │   ├─ lane 1 ─────────────────────────┬─ lane 2 ──────────────────────┬─ lane 3 ─────────
    │   │ ░ Khoa CNTT territory ░░░░░░░░░░ │ ░ Khoa Điện – Điện tử ░░░░░░ │ ░ Khoa Cơ khí ░░░
    │   │ [■ FACULTY Khoa CNTT 41 ⊖]─┬─[▤ 4 documents: 3 rows · +1 more]
    │   │                            ├─[⧉ ACADEMIC DEPARTMENT Bộ môn HTTT 21 ⊖]─┬─ [PDF] Giới thiệu …
    │   │                            │                                          └─ [≋ PROGRAM GROUP … 18 ③]   (folded)
    │   │                            └─[▣ FORMS Biểu mẫu Khoa CNTT 3 ⊖]─── [DOCX] Đơn xin …
    │   └─ ░ Phòng Đào tạo ░ …        ░ Phòng CTSV ░ …             ⋯ 🔒 Hồ sơ nhân sự (Restricted)
    └ Faculty › Academic department › … › Document · Also: Forms · ✓ New        [− 100% + │ ⤢ ↺] ┘
```

## The atlas

The tree is the canonical Item hierarchy (`backend/docs_design/item_model.md` §4.1–4.3): the workspace, root **collections** (access boundaries), nested collections (**folders**) and **documents**. Every Item has exactly one canonical parent, so every document appears once, where it lives. Item links and space materials are references and are not drawn.

### Visual language
- **Identity vs territory.** A node's icon and label say *what* it is (workspace = landmark, faculty = building, academic department = network, program group = layers, major = graduation cap, administrative office = briefcase, forms = clipboard, folder = folder; enterprise levels: area = library, section = layers, subsection = network). Its accent says *whose* it is: each root collection's colour (`kb.color`) tints its territory band, its connectors, its icon tiles and its root node. Colour never identifies a type.
- **Organisational nodes** (240 × 60): icon tile, uppercase level label, a two-line name, the document count of the subtree, and a handle on the right edge (− to fold, the number of hidden groups to open). The root collection fills its icon with its colour.
- **Documents** are lighter (264 × 38): file icon, title, marks (✓ verified · New = changed in 14 days). More than three in one place become a **cluster** card: *N documents*, the first three, *+N more* (all, in place; *Show fewer*). Search always draws every match one by one.
- **Connectors** are rounded orthogonal lines in the territory's colour, 1.25 px at any zoom; the hovered node's path and the selected node's path are drawn solid; everything outside a selection dims (never hides).
- **Territories** are faint tinted bands with a hairline in the collection's colour, its mark, description and *Open in Knowledge*. A collection you can see but not read is a dashed territory with a locked node (*Request access* in the inspector); nothing inside it is drawn.
- **Canvas**: a soft off-white surface with a dot grid that pans and scales with the view, optionally over the workspace's [map background](#map-background). The chrome floats on a blurred surface.

### Map background
Each workspace can show its own image behind the atlas, e.g. a campus illustration for Trường Đại học UTE. It is identity, not content.

**What everyone sees**
- The image is fixed behind the canvas (cover, centred). It never pans or zooms, so it never competes with the tree.
- A wash in the HeroUI theme's colours sits over the image: the page background (`--background`), tinted 10 % with the theme accent (`--accent`). The image therefore always matches the theme: it darkens in the dark theme and takes the accent's hue when a workspace or person changes it in Appearance.
- Photos are busy (leaves, windows, people), so lower strengths also blur and desaturate the image into a soft colour field. The place stays recognisable, but its detail never competes with nodes.
- **Strength** is a single value from 0 to 100 (default 25). The admin sets it with a slider; one CSS variable (`--s`) drives everything, continuously:

  | Strength | Wash | Blur | Saturation |
  |---|---|---|---|
  | 0 | 96 % | 8 px | 0.4 |
  | 25 (default) | 87 % | 6 px | 0.55 |
  | 100 | 60 % | 0 | 1 |

- The dialog preview and the Settings thumbnail scale the blur to their size (`--blur-k`).
- Checked with a real campus photo (3264 × 1836, trees in front of the main building) at 0, 25, 60 and 100, and with the teal accent: every node and connector stays readable.
- Over an image the canvas stops looking like a whiteboard (`.atlas.has-bg`):
  - the dot grid is not drawn;
  - territories become a translucent tinted veil (about half opacity, slightly stronger hairline) instead of an opaque board;
  - the image reads across the whole map.
  - Nodes, clusters and connectors stay on top, unchanged.
- Workspaces without an image keep the plain canvas.

**Who changes it, and where**
- Workspace admins (`tenant.manage`) change it from two places, both opening one dialog:
  - the **Map background** icon button in Home's header, next to *Edit structure*;
  - Settings → Workspace setup → **Map background** (thumbnail, file name, "Strength 25 %", who changed it and when).
- **The dialog shows the result before saving.** Its preview draws the image under its wash, plus the workspace and its first collections as nodes, so the admin sees exactly what people will read. Dragging the strength slider updates the preview live, with no re-render.
- **Adding an image:**
  - Empty: a dashed drop zone with *Choose image*.
  - Set: the file name and size, *Replace*, the **Strength** slider (HeroUI Slider: label and value "25 %", ends *Subtle* · *Vivid*, step 5) and *Remove* in the footer.
  - Accepted: JPG, PNG, WebP or SVG, up to 10 MB.
  - Photos are scaled to at most 1,920 px wide (JPEG, quality 0.75, about 400 KB) before they are stored.
  - An image under 1,200 px wide gets a soft warning that it may look soft on large screens.
  - Wrong type or size: an inline error; the current image stays.
- **Saving** applies to everyone in that workspace only, with Undo, and writes an audit entry ("Changed the Home map background").
- **Seed:** UTE ships with `assets/map-backgrounds/ute-campus.svg` (Subtle). The other demo workspaces have none.

### Layout
- A tidy left-to-right tree per territory (own layout code; a few hundred nodes lay out in about a millisecond, no graph library). A parent sits level with its first child, so every branch starts at its top and reads down; documents come first in a group, then folders. Uneven depths, documents at any level and long names are handled by fixed box sizes and per-subtree heights.
- Territories fill **lanes** under the workspace node (1st, 2nd, … then back to the first), as many as make the atlas about as wide as the canvas; the workspace's bus runs along the top and down each lane's spine. The lane count is kept per workspace and canvas shape, so opening and folding never moves a territory to another lane.
- **Folding**: folders from level 3 down start folded; *Expand all* opens everything, *Collapse all* folds every folder and fits the atlas. Folding a box keeps it exactly where it was on screen (the view shifts to compensate); nothing recentres.
- **Order inside a group**: overview-style titles first (Overview, Introduction, Giới thiệu, Tổng quan…), then the most opened (popular), then by title. No admin pick changes this order. Folders: curated order, then name.
- **Levels**: each workspace names its levels once (Settings › Workspace setup › *Knowledge map levels*; Campus = Faculty, Academic department, Program group, Major, Administrative office, Forms; Enterprise = Area, Section, Subsection, Folder). The first four name depths 1–4; a collection or folder may carry any other label of the list. The legend shows the levels in use as a path, and *Also:* the other labels.

### Semantic zoom
Box sizes never change, so nothing moves when the level changes.

| Zoom | Shows |
| --- | --- |
| Far (< 55 %) | Structure: each territory's name large across its top, node icons, one-line titles scaled up to stay legible, counts; documents as slim tinted bars, clusters as their count |
| Normal | Level labels, two-line names, counts, handles, clusters with three documents, marks |
| Near (≥ 135 %) | Adds each document's age under its title |

## Interaction

| Do | Result |
| --- | --- |
| Drag the canvas · scroll · Shift + scroll | Pan (vertical / horizontal) |
| ⌘/Ctrl + scroll · trackpad pinch · two-finger pinch | Zoom around the pointer (20–200 %) |
| Keyboard on the canvas | Arrows pan (Shift: further), + / − zoom, 0 = 100 %, 1 = fit, Esc clears the selection |
| Hover a node | Its path back to the workspace lights up |
| Select a box | Highlight with its path and subtree; the rest dims; the **inspector** opens (header: level, name, a quiet *Focus* icon that centres the box, ×; then path, counts, description, the first five documents here; one action, *Open in Knowledge* (secondary: its collection in Browse), and for its editors the link *Edit in Studio* → that collection's Contents on that folder). Folding stays on the box's own handle (no Expand/Collapse button repeating it). Select again, ×, Esc or a click on empty canvas closes it |
| A box's handle | Fold / open that branch only |
| A document (node, cluster row or inspector row) | The existing document preview (the Reader from there) |
| *+N more* | The cluster shows all its documents in place |
| Find in the map | Narrows to titles and folder names (word starts; marks typed are matched exactly — "đơn" finds *Đơn xin…* not *động*); Enter centres the first match; nothing found → *Search in Knowledge* |
| Hide documents | Only the levels (an org chart of the workspace's knowledge) |
| Go to ▾ | Fits that territory (opens it, clears the selection) |
| Zoom bar | − · level (click = 100 %) · + · Fit · Reset (view, folding and lanes) |

The view (pan and zoom) is kept per workspace; a first visit starts at 100 % (85 % on phones) at the top left.

## Trust and permissions

The atlas draws only from the published, readable, shared pool (`sharedPool()`): the same visibility rule as every other listing (`item_model.md` §6). Personal collections are never drawn. A discoverable root the caller cannot read appears as a locked territory with Request access; its folders, counts and documents are never shown. Hidden roots do not appear. A folder with its own access (Knowledge Studio → a collection → Contents) is not drawn for people it doesn't name, exactly as if it weren't there. Counts, levels and the meta line come from what the caller can read, so two people may see different atlases of the same workspace. Folding and clusters only change what is drawn: search and Knowledge still find every document. The structure itself — folders, their descriptions and kinds — is edited in Contents, the same tree.

## States and responsiveness

- **Loading**: the canvas with skeleton nodes. **Empty**: *Your workspace has no published knowledge yet* (Contribute when allowed, Browse knowledge). **Error**: Try again.
- **Layout**: Home is a canvas page (`.page--canvas`, [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) › PageLayout): the identity block, then the atlas fills the rest of the page; the page itself does not scroll.
- **≤ 1023 px**: the legend keeps only the levels.
- **≤ 679 px**: the atlas runs edge to edge; the toolbar spans the top (search, documents, expand, collapse); no legend; the inspector is a sheet over the bottom of the canvas; touch pans and pinches.
- Reduced motion: no glide on fit, focus or zoom buttons; no transitions on nodes or connectors.

## API

Built from `ListItems filter=itemType=COLLECTION` (roots and folders, with `parentItem`, `documentCount`, `childCount`; locked roots come back LOCKED without counts) and the documents of each opened collection (`ListItems filter=parentItem=…`, `orderBy`). Not in the contract yet (recorded for `backend/docs_design`): the workspace's level vocabulary (`Workspace.settings` *knowledge map levels*), a collection's level label and a folder's curated `order`.

The **map background** is `WorkspaceSettings.branding.mapBackground` (`api_design.md` §4, `openapi.yaml`): `strength` (0–100, default 25) plus output-only `imageUri` (signed, short-lived), `fileName`, `widthPixels`, `heightPixels`, `updateTime` and `updater`, read with GetWorkspaceSettings by every member. The image is set with `POST …/settings:uploadMapBackground` (multipart, one `file`: JPEG, PNG or WebP ≤ 10 MB; the client rasterizes SVG and scales to ≤ 1,920 px wide JPEG first); the strength with UpdateWorkspaceSettings `updateMask=branding.mapBackground.strength`; removing is `updateMask=branding.mapBackground` with no value. All need `workspaces.updateSettings`. The wash colours come from the client's theme, never from the server.

Loading: one `ListItems` read draws the whole structure, because box sizes come from the counts; each container's documents load only when its boxes come within a screen of the view (skeleton rows in place, so nothing moves when they arrive). Find in the map matches collection names on the client and documents through `SearchItems` (titles and content, permission-filtered; documents not yet indexed are not found).
