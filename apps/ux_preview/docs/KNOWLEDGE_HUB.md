# Knowledge Hub

The Knowledge Hub replaces the old *Collection → Documents* drill-down. People find, read and use knowledge, whatever system it came from. It is a platform capability: Finx Workspace is the main demo ([FINX_WORKSPACE.md](FINX_WORKSPACE.md)), and Northwind runs the same code. Discovery starts on **Home** ([HOME.md](HOME.md)). The Knowledge section has two destinations, one per intent: **Browse** (find and read the organization's knowledge) and the personal sections **Saved · My files · My reading lists** (what I kept and made), shown as sidebar sub-rows under Knowledge; there is no tab bar. What you touched lately and what you submitted are **Your work → Recent** and **Your work → My contributions** in the sidebar ([PRODUCT_FLOW.md](PRODUCT_FLOW.md#information-architecture)). Collections are an administrative concept: their owners and editors manage them in **Manage › Knowledge Studio → Collections**; readers meet a collection only as a Browse filter.

```text
Sources ──► one Resource catalog ──► Home · Browse · Saved ──► Preview ──► Reader ──► Ask · Save · Collect · Use in work
              (permission-filtered)       (many views, no copies)                  (provenance, trust, related)
```

## What was wrong

| Before | Problem | Now |
| --- | --- | --- |
| Knowledge = a grid of reading list cards; documents only inside a collection | People had to know which container held something. There was no way to find by topic, type, space, owner, source or freshness. | **Browse** is one catalog filtered by ten dimensions, and the URL holds the state. A resource shows up in every view without being copied. |
| A flat document list, `/search` and the collection tables were three overlapping finders | Duplicated capability with inconsistent results | Browse is the only knowledge finder. The old list's address now redirects to the reviewers' **Knowledge Studio** (Manage › Knowledge Studio). Global search and ⌘K both use the same catalog search. |
| Readers saw Waiting, Processing and Failed | Pipeline states mean nothing to readers and make the product look broken | Readers see **trust**: Verified, Review due or Not verified, plus freshness. Only the collection's editors see index status. |
| The viewer showed a page and a metadata panel; *Ask* left for chat | Reading context was lost. There was no provenance, version history or related material. | The **Reader** has Ask, About and Related beside the document. Answers cite passages that highlight in place. |
| Nothing personal | People couldn't keep what they found | **Saved**, **My files** and **My reading lists** (the reading lists you made) (recent reads → Your work → Recent; contributions → My contributions) |
| Browse · library · Collections as three tabs | *Collections* exposed the access boundary as a place to read: a collection's Resources tab repeated Browse filtered by collection, its list repeated the Browse filter, and access, sources and settings sat beside reading. Continue reading repeated the old recent-reads tab, *Only documents I saved* repeated Saved, and saved views were listed in both Browse and the library. | Browse plus personal sections (sidebar sub-rows). A collection is a Browse filter (`kb=`); a filter on a locked collection offers Request access, and *Some collections aren't shared with you* opens the restricted collections. Collection management (access, sources, settings, create) moved to Manage › Knowledge Studio → Collections ([KNOWLEDGE_STUDIO.md](KNOWLEDGE_STUDIO.md)). Browse's landing shows the reading lists shared with you; saved views live only in Browse's Views menu (open, save, rename, delete). |
| No curation across collections | Leads and offices couldn't hand people a reading list | **Reading lists**: ordered, annotated references, shared with a space or the workspace. They never grant access. Admins also feature documents on Home. |
| No governance | Stale policies, untagged files and duplicates were invisible | **Manage › Knowledge Studio** sets up knowledge (collections, topics, sources) and runs every document in **Documents**: All (every document, filterable by Processing state, and a Quality filter for re-verification, missing details and duplicates), Processing (what isn't processed yet: submissions first, then what nobody processed, failed or changed at the source; select and Process, since nothing is processed on upload) and Review (processed submissions, new versions and what a sync held back; approving publishes only). **Topics** holds the topic tree and Suggestions (proposed topics, keywords from reviewers' corrections, topics to confirm, documents without a topic). See [KNOWLEDGE_STUDIO.md](KNOWLEDGE_STUDIO.md) and [DOCUMENT_LIFECYCLE.md](DOCUMENT_LIFECYCLE.md) |

## Concepts (one meaning each)

| Concept | Is | Isn't | Backend today |
| --- | --- | --- | --- |
| Source | Where content comes from: a connector source (Confluence, SharePoint, Google Drive, GitHub, website) or an upload | A place people browse | `ingestion_sources`, `external_resources` |
| Resource | One canonical document with metadata. It lives in exactly one collection. | A copy per view | `items` (`item_type=document`) |
| Collection | The governed home: ownership and the access boundary. Managed in Manage › Knowledge Studio → Collections | A place people navigate to read: readers see it as a Browse filter | `items` (`item_type=collection`, root) with role assignments |
| Space | The context people work in (team, project, office; the Campus template adds course and research group). Resources link to many spaces. | An access grant; it only surfaces resources members can already read | Prototype only (Spaces module) |
| Topic | The workspace's taxonomy: domain → topic, each known by its name (its ID is internal, never shown) with signals the assistant classifies by (keywords, synonyms, rules, examples, guidance); readers browse the same topics as pills. Workspace admins manage it in Knowledge Studio → Topics ([DOCUMENT_LIFECYCLE.md](DOCUMENT_LIFECYCLE.md#topics)) | Free-form tags, or a second "category" list beside topics | Proposed: `items.metadata.topics` + a taxonomy table with `keywords`, `synonyms` |
| Reading list | A curated, ordered list of references with notes. Shared ones show in Browse; your own in My reading lists | A container. It grants nothing, and items you can't open appear only as a count. | `reading_lists` + `reading_list_entries` (`backend/docs_design/item_model.md`; never `items`) |
| Saved view | A stored Browse query, kept in Browse's Views menu | A copy of results | Proposed: per-user preference |
| Trust | Verification (by whom, when, next review) + freshness (changed at source) | Index status | Proposed: `items.metadata.verification`; *outdated* already exists (`processed_version`) |

The resource type ("Policy", "Procedure", "Spec"…) maps to `items.document_type` (semantic, not provider identity). Format (PDF, Word…) comes from the MIME type.

## Information architecture

```text
Home (/home, core) ─── Knowledge Atlas: workspace › one territory per collection › folders › documents on one pan/zoom
                       canvas, ★ Read first leading its folder  (see HOME.md)
Knowledge (sidebar row = Browse; sub-rows Saved · My files · My reading lists while in Knowledge, no tab bar):
├── Browse (/knowledge) ─ the organization's knowledge: topic pills (domains, then a domain's topics) · Shared with you
│                      (reading lists, landing only) · one bar above the results: a compact search field, then inline
│                      filters Type · Updated · Trust · Owner · More filters (Space · Source · Collection · Format ·
│                      Language), Views (saved views) · sort · layout at its end · removable chips and Ask AI in the
│                      results header · document grid (or list)
│                      card or row → document preview → Open full document (Reader)
│                      a collection is a filter (kb=); a locked one → Request access; "Some collections aren't shared with you" → dialog
├── Saved · My files · My reading lists (/knowledge/library?tab=saved|files|lists) ─ own top-row title each   (Recent and My contributions are under Your work in the sidebar)
└── Reading list (/knowledge/lists/:id) ─ numbered reading order with notes · Ask about this reading list · Use in… · name, description and who can see it changed in place · Edit items (order, notes, add resources)
Document preview ───── shared modal from every document row, card and citation: native rendering, highlighted passage · Ask about this document · Open full document
Reader (/doc/:id) ──── document (no outline column) · click-to-edit title for editors · Ask | About | Related rail (closed by default; ?ask=1 opens Ask) · Save · Add to reading list · Use in… (submissions: preview banner, no Ask)
Manage › Knowledge Studio (/studio) ─ sidebar sub-rows Documents (All · Processing · Review) · Collections · Topics (All · Suggestions) · Sources  (see KNOWLEDGE_STUDIO.md)
     └── Collection (/studio/collections/:id) ─ click-to-edit name and description (owners) · Contents (folders and documents, each folder's click-to-edit name and description; folders with their own access) · Access (owners) · Sources (Add source) · what's in review · Access requests · ⋯ Archive collection (owners)
```

All routes and their purposes are listed in [SCREEN_INVENTORY.md](SCREEN_INVENTORY.md).

## Browse: content first

People come to Knowledge to find and use information, not to manage files. So most of the page is documents, recognisable without opening them; everything else stays out of the way until someone asks for it.

```text
Knowledge · Demo data                                                      [Contribute]   ← top row
[ Search 230 documents                                        ✕  ✦ Ask AI ]   ← Ask AI only with a query
(All) (Engineering & Architecture) (Data Platform…) (Banking Operations) …   ← topic pills
   (All Engineering) (Architecture decisions 20) (APIs 14) …                 ← only when a domain is chosen
Shared with you: up to 3 reading lists                        Show all n   ← landing only, only when there are some
[Type ▾] [Updated ▾] [Trust ▾] [Owner ▾] [More filters ▾]   [Views ▾]       ← each filter is a popover with counts
230 documents  [Type: Technical reference ×]  Clear all      [✦ Ask about these] [Sort ▾] [▦ ☰]
┌ preview ┐ ┌ preview ┐ ┌ preview ┐   three cards a row on desktop, one on phones
└ title, what it's for, type · topic, ✓ ┘ …
```

**Decisions.**
- **No permanent filter rail and no permanent preview panel.** Together they took about half the width. Topic is the one dimension people browse by, so it stays visible as pills. The most used facets (Type, Updated, Trust, Owner) are inline buttons, each opening a popover of checkboxes with live counts that stays open while you tick; the rest sit under *More filters* and appear only when they can still narrow the set. Selected filters show as removable chips beside the result count; *Clear all* clears the topic too. Phones get one *Filters* bottom sheet.
- **Saved views are a menu, not part of the filter form.** *Views* opens a saved view, saves the current one (*Save this view* — saved at once under a name made from the search and filters, with that name open for editing in the results heading) and deletes the active one (Undo). On a saved view the results heading is its name, click-to-edit to rename it (Undo) — no Rename or Save dialog, and the name shows once, not again on the Views button.
- **Search and Ask stay separate.** Search is a compact field at the start of the filter bar — one more way to narrow the same results, at the filter buttons' height and a fixed width, so typing never reflows the filters (it fills the bar beside Filters on phones). Typing always searches documents. *Ask AI* sits in the results header once there is a query and turns it into a cited conversation over these results (without a query, filtered results offer *Ask about these* there). One AI entry point at a time.
- **Browse is the workspace's public knowledge, nothing else.** It lists only documents in shared collections that are published and finished processing. An upload goes to My files — the member's private scope — and never appears here; to share it, the member contributes it, a reviewer approves it (it moves into a collection and is published) and processing runs; only then does it show up in Browse. Unpublished documents and documents still processing (or that failed or can't be processed) stay in Knowledge Studio. The landing shows the reading lists shared with you (curated reading lists, featured first; one swipeable row on phones) and those documents, newest first. Saved documents live in Saved (recent reads on Home and Your work → Recent); Browse doesn't repeat them. Featured, recommended and recently published stay on Home.
- **A collection is a filter, not a destination.** Readers narrow by collection in More filters (or follow a collection link from a document's details, search or ⌘K). Filtering to a collection you can't read shows who owns it and *Request access* (or that the request is pending), never an empty list.
- **Grid by default, list for dense scanning.** The table layout was removed: the list already scans densely and the table only repeated it.

**Document card** (`X.res.card`):
- **Cover** shows what the document's first page looks like, from the list's own data (`DocumentFacet.cover`) — a card never reads a document's content. The ingestion worker makes the cover as soon as the content arrives, so unprocessed documents have one too, and makes it again when the current version changes. One fixed 16:9 frame per card (nothing shifts while covers load), one shape per format: **PAGE** (PDF, Word) a portrait paper, top-aligned, fading at the bottom; **SLIDE** (decks) a 16:9 slide; **SHEET** (spreadsheets, CSV) a mini grid with column letters and row numbers; **TEXT** (Markdown, plain text, web pages) a paper with the first lines; **IMAGE** the picture itself, cropped to fill. The image (a small WebP: PDF page 1, the picture, or an Office file's embedded thumbnail) always wins over text; without one, the shape is drawn from the first page's title and lines or the first sheet's cells. While searching, a card without a cover image shows the matching passage the search returned, words highlighted. No cover (not made yet, or nothing to show, e.g. archives): a tinted typed tile with the format and kind. Never a page count. Images load lazily and decode off the main thread.
- **Text**: the title (no file extension; the format badge shows it), one line on what the document is for (its summary; never a generated "Guide in Product Documentation" line), then type · topic (or collection). Topic and collection are left out when every card shares it. Trust appears only when it matters: a quiet ✓ for Verified (the tooltip says who and when), a *Review due* chip; nothing for unverified or personal files.
- **Actions**: the whole card opens the document preview (Enter or Space too); Save and ⋯ appear on hover or keyboard focus (always on touch), and a saved document keeps its bookmark visible.

**Document preview** (`X.preview.open`, shared with every resource row, Home, chat and work citations): a centered modal (a near-full-screen sheet on phones) showing the document in its native rendering, with the matching words or the cited passage highlighted and scrolled into view. Header: title, type · collection · updated, and a trust chip only when Verified or Review due. A reading bar steps through matches for the query, or through cited passages (*Passage n of m*, possibly across documents). Footer: *Ask about this document* (opens the Reader's Ask panel) and **Open full document** (the Reader at the same page and highlight). It has no Save, ⋯, editing or sharing — the row it came from already offers those. A locked document opened from a citation shows only the quoted passage and *Request access*.

**Opening fast — and always.** Opening a document shows its own file, processed or not: processing only adds search, Ask and citations, and a quiet note above the file says when it hasn't happened yet (or failed), with *Process* for editors. The preview engine prepares one of six representations for every supported file when its content arrives — PDF pages (PDFs, and Word, slides, OpenDocument, RTF, web pages and e-mail converted to their printed pages), a picture, a table (spreadsheets and CSV), text (Markdown rendered, code monospaced), a media player, or a ZIP file's entry list — so the viewer looks the same whatever the format; a file opened the moment it was uploaded may show *Preparing the preview…* for a few seconds; anything else offers *Download*. The preview and the Reader show the cover the list already had as the first page at once — its image, else its text in the format's shape — with the next page a sized blank, while the file loads; the real pages replace it when they arrive (a document opened before is cached and opens directly). PDF pages are lazy: only pages within one screen of the view are drawn, one page at a time, the rest are blanks of their exact size, so a long document scrolls with bounded memory and the scrollbar and *Page n of N* stay right.

**States.** Loading shows the search, pills and card skeletons. No results offers *Clear search*, *Clear filters* and *Ask AI*. Long titles clamp to two lines with the full name as a tooltip. A document without a summary or cover still gets a typed tile and its type. When some collections are locked, *Some collections aren't shared with you* opens a dialog listing them with *Request access*; their documents never appear.

**Prototype data.** Northwind's product documentation (`d-prod-3`…`d-prod-14`) has authored renditions and summaries so its cards differ the way real documents do; the other generated documents use templates, so some covers look alike. A cover image is mocked by drawing the first page's own HTML small; PDFs, pictures and every other deck have one, Word files and workbooks don't.

## Journeys

1. **Engineer — find, read, ask, keep.** Home → *How do I get production access?* → cited answer; or search "production access" → Browse with the Access Control Policy → preview → *Open full document* → Reader → *Ask* → cited passages highlight in the page → *Save* → it shows in Knowledge → Saved.
2. **Engineer — explore by dimension.** Home → topic card *Banking Operations* → Browse filtered by that domain → Type *Procedure* → *Views* → *Save this view* → type its name in the results heading → Enter.
3. **Engineer — read with AI beside the decision.** The Reader on *ADR-031 — Idempotency keys for payment APIs* → ask about retries → cited answer → *Related* shows ADR-027 and the reading lists that include it → *Use in… Draft*.
4. **Lead — curate.** Open *Payments on-call kit* (shared with Payments Platform; readers find it in Browse's Shared with you) → click its name or description to change it in place, or the *Who can see it* chip to share it differently (each with Undo) → *Edit items* → reorder, annotate (autosaved with Undo), add a resource from the catalog → *Done*. Link a runbook from another collection to a space → it appears in that space's materials for members who can read it; access is unchanged.
5. **Lead — look after a collection.** Manage › Knowledge Studio → Collections → *Payments Platform* (the card shows its access request) → Access: approve the request, share with a group as Viewer → Sources → Settings. *Review N* in the collection's alert opens its submissions in Knowledge Studio → Documents → Review; the collection's ⋯ *Open in Documents* lists all its documents in Documents → All.
6. **Analyst — find a definition.** Browse → Topic *Metrics & definitions* → *Metric definitions — Active customers* → preview → *Ask about this document* → the Reader's Ask panel → ask what counts as active.
7. **Admin — keep knowledge healthy and visible.** *Mark as read first* from a document's ⋯ menu (it leads its folder on the Home map with a star); name the map's levels in Settings › Workspace setup. Overview → Knowledge health → a metric opens its view in Documents or Topics. *Topics → Suggestions*: confirm or move a first sync's topic groups, tag documents the assistant gave no topic, and accept topics the assistant proposed (e.g. *Open banking*); an accepted topic appears in Browse and Edit details at once. *Documents → All → Quality → Re-verification due* (expired or never verified): verify or ask the owner. *Documents → Processing*: documents changed at the source are fixed with *Process the update*. *Quality → Missing details*: add an owner or summary. *Quality → Possible duplicates*: compare, keep the newer and archive the other (reading lists and saved lists repoint, with Undo).
8. **Northwind member.** Same screens without spaces: Home's continue section has no Up next, Browse by People/Sales/Product topics; Legal Contracts stays locked — *Some collections aren't shared with you* → Request access.

## Rules

- **Authorization first.** Every listing, count, facet, search, related list, reading list and AI answer is computed from `readableResources()`/`catalogPool()` (Browse: `sharedPool()`, the same minus My files). Locked collections appear only as collections, never as resource titles.
- **One identity.** Views, reading lists, saved lists, spaces and topics reference `doc.id`. Merging a duplicate archives one and repoints references.
- **Trust over pipeline.** Readers see verification and freshness. Editors also see index status where they can fix it.
- **Demo data is labelled.** Demo workspaces (Finx) have `ws.demo`. The *Demo data* chip sits in the Knowledge header, the Reader and Knowledge Studio. No Finx record claims to be real policy; a Finx "Verified" means verified inside the demo.
- **Reusable.** Nothing checks for a specific workspace. Spaces appear as a facet and as context only when the Spaces module is on. Topics, types and sources come from data and registries (`RESOURCE_KINDS`, `D.topics`, `APPS`).

## Code

| Layer | File | Owns |
| --- | --- | --- |
| Model | `scripts/core/catalog.js` | Resource kinds, topics, `res(doc)`, trust, access-aware pools (`catalogPool`, `sharedPool`), where a collection opens (`kbHref` for readers, `kbManageHref` and `managedKbs` for Manage), search (accent-insensitive, stop words, weighted fields), facets and URL state, saved/recent/views, reading lists, related, governance signals |
| Data | `scripts/data/knowledge.js` | Topics (domains and topics with keywords, synonyms, examples, guidance and rules, and icon, colour and description; Finx import history), metadata, the Finx catalog (Confluence wiki, SharePoint policies and procedures, Google Drive product docs, GitHub payments docs, uploads; a few Vietnamese titles), read-first documents, reading lists, saved/recent/views, duplicate seeds |
| Shared UI | `scripts/features/resources.js` + `styles/pages/resources.css` | Knowledge top-row header (`hubHeader`) and sidebar sub-rows (`libraryNav`), resource row, document card with content preview, trust/type chips, details list, save, add to reading list, edit details, link to spaces, verify, reading list create/edit |
| Pages | `home.js` (Home), `hub.js` (Browse, filters and Views), `library.js` (Saved · My files · My reading lists; Reading list; My contributions), `preview.js` (document preview), `knowledge.js` (Knowledge Studio → Collections and `/studio/collections/:id`, Request access, restricted collections), `reader.js` (Reader; exports `X.rdr.viewer`, `markHits`, `needles`, `injectQuote`), `contribute.js` (Contribute dialog), Manage › Knowledge Studio: `curation.js` (page, sections and `X.studioNav()` sub-rows, setup guide, Documents: All with its Quality filter, Processing, Review workbench, the Process dialog and processing strip, document drawer with its steps) + `governance.js` (Topics → Suggestions, All's Quality lists) + `masterdata.js` (Topics tree and topic detail, prompt drawer, import/export; `styles/pages/taxonomy.css`) + `sources.js`/`connections.js` (Sources and its views), `documents.js` (renditions, document operations, processing runs `processRun`/`stopProcessRun`) | |

## Backend alignment and open decisions

The prototype doesn't change `backend/docs_design`. These need backend design before they can ship:

1. **Topics and verification:** extend `items.metadata` (topics, verification `{by, at, due}`, summary, language) or add a taxonomy table. Topics are the workspace-managed taxonomy, named by display name (IDs internal), with `keywords[]`, `synonyms[]`, `rules[]`, `examples[]` and `guidance` (as prototyped); import, export and re-classification are listed in [DOCUMENT_LIFECYCLE.md](DOCUMENT_LIFECYCLE.md#backend-alignment-and-open-decisions).
2. **Reading lists:** a new resource that references `items`. It must not reuse the `items` `COLLECTION` type, which is the access boundary (the UX's Collection).
3. **Resource ↔ space links:** depend on Spaces becoming a backend concept.
4. **Saved resources, recent reads and saved views:** per-user state, which needs a home (preferences store or tables).
5. **Search facets:** `POST /api/v1/documents/search` needs facet counts and filters for type, topic, owner, source, trust, updated and language.
