# Knowledge Hub

The Knowledge Hub replaces the old *Knowledge base → Documents* drill-down. People find, read and use knowledge, whatever system it came from. It is a platform capability: Finx Workspace is the main demo ([FINX_WORKSPACE.md](FINX_WORKSPACE.md)), and Northwind runs the same code. Discovery starts on **Home** ([HOME.md](HOME.md)). The Knowledge section has two destinations, one per intent: **Browse** (find and read the organization's knowledge) and **My library** (what I kept and made: Saved · My files · My collections). What you touched lately and what you submitted are **Your work → Recent** and **Your work → My contributions** in the sidebar ([PRODUCT_FLOW.md](PRODUCT_FLOW.md#information-architecture)). Knowledge bases are an administrative concept: their owners and editors manage them in **Manage › Knowledge Studio → Knowledge bases**; readers meet a base only as a Browse filter.

```text
Sources ──► one Resource catalog ──► Home · Browse · Library ──► Preview ──► Reader ──► Ask · Save · Collect · Use in work
              (permission-filtered)       (many views, no copies)                  (provenance, trust, related)
```

## What was wrong

| Before | Problem | Now |
| --- | --- | --- |
| Knowledge = a grid of knowledge-base cards; documents only inside a base | People had to know which container held something. There was no way to find by topic, type, space, owner, source or freshness. | **Browse** is one catalog filtered by ten dimensions, and the URL holds the state. A resource shows up in every view without being copied. |
| A flat document list, `/search` and the base tables were three overlapping finders | Duplicated capability with inconsistent results | Browse is the only knowledge finder. The old list's address now redirects to the reviewers' **Knowledge Studio** (Manage › Knowledge Studio). Global search and ⌘K both use the same catalog search. |
| Readers saw Waiting, Processing and Failed | Pipeline states mean nothing to readers and make the product look broken | Readers see **trust**: Verified, Review due or Not verified, plus freshness. Only the base's editors see index status. |
| The viewer showed a page and a metadata panel; *Ask* left for chat | Reading context was lost. There was no provenance, version history or related material. | The **Reader** has Ask, About and Related beside the document. Answers cite passages that highlight in place. |
| Nothing personal | People couldn't keep what they found | **My library**: Saved, My files and the collections you made (recent reads → Your work → Recent; contributions → My contributions) |
| Browse · My library · Knowledge bases as three tabs | *Knowledge bases* exposed the access boundary as a place to read: a base's Resources tab repeated Browse filtered by base, its list repeated the Browse filter, and access, sources and settings sat beside reading. Continue reading repeated the old recent-reads tab, *Only documents I saved* repeated My library → Saved, and saved views were listed in both Browse and My library. | Two tabs. A base is a Browse filter (`kb=`); a filter on a locked base offers Request access, and *Some knowledge bases aren't shared with you* opens the restricted bases. Base management (access, sources, settings, create) moved to Manage › Knowledge Studio → Knowledge bases ([KNOWLEDGE_STUDIO.md](KNOWLEDGE_STUDIO.md)). Browse's landing shows the collections shared with you; saved views live only in Browse's Views menu (open, save, rename, delete). |
| No curation across bases | Leads and offices couldn't hand people a reading list | **Collections**: ordered, annotated references, shared with a space or the workspace. They never grant access. Admins also feature documents on Home. |
| No governance | Stale policies, untagged files and duplicates were invisible | **Manage › Knowledge Studio** sets up knowledge (bases, taxonomy, sources), classifies every document against the taxonomy, then handles review, publication and upkeep in Review queues (topics to confirm, re-verification, missing details, duplicates). See [KNOWLEDGE_STUDIO.md](KNOWLEDGE_STUDIO.md) and [DOCUMENT_LIFECYCLE.md](DOCUMENT_LIFECYCLE.md) |

## Concepts (one meaning each)

| Concept | Is | Isn't | Backend today |
| --- | --- | --- | --- |
| Source | Where content comes from: a connector source (Confluence, SharePoint, Google Drive, GitHub, website) or an upload | A place people browse | `ingestion_sources`, `external_resources` |
| Resource | One canonical document with metadata. It lives in exactly one knowledge base. | A copy per view | `items` (`item_type=document`) |
| Knowledge base | The governed home: ownership and the access boundary. Managed in Manage › Knowledge Studio → Knowledge bases | A place people navigate to read: readers see it as a Browse filter | `items` (`item_type=collection`, root) with role assignments |
| Space | The context people work in (team, project, office; the Campus template adds course and research group). Resources link to many spaces. | An access grant; it only surfaces resources members can already read | Prototype only (Spaces module) |
| Topic | The workspace's taxonomy: domain → topic, each with a code and signals the assistant classifies by (keywords, synonyms, rules, examples, guidance); readers browse the same topics as pills. Workspace admins manage it in Knowledge Studio → Taxonomy | Free-form tags, or a second "category" list beside topics | Proposed: `items.metadata.topics` + a taxonomy table with `code`, `keywords`, `synonyms` |
| Collection | A curated, ordered list of references with notes. Shared ones show in Browse; your own in My library | A container. It grants nothing, and items you can't open appear only as a count. | Proposed: new `collections` + `collection_items` (must not be `items`) |
| Saved view | A stored Browse query, kept in Browse's Views menu | A copy of results | Proposed: per-user preference |
| Trust | Verification (by whom, when, next review) + freshness (changed at source) | Index status | Proposed: `items.metadata.verification`; *outdated* already exists (`processed_version`) |

The resource type ("Policy", "Procedure", "Spec"…) maps to `items.document_type` (semantic, not provider identity). Format (PDF, Word…) comes from the MIME type.

## Information architecture

```text
Home (/home, core) ─── Discover & Start: intent cards (Find a document → Browse · Ask a question → AI Chat · Contribute) · Needs your attention
                       · Continue reading · What's new (source-backed changes) · Explore knowledge (domain cards) · Start here / Recommended for you  (see HOME.md)
Knowledge (one sidebar item) ─ one sticky section bar Browse │ Saved · My files · My collections, one tab per intent:
├── Browse (/knowledge) ─ the organization's knowledge: one search field (Ask AI appears beside it once there is a query)
│                      · topic pills (domains, then a domain's topics) · Shared with you (collections, landing only)
│                      · document grid (or list) · sort · inline filters Type · Updated · Trust · Owner · More filters
│                      (Space · Source · Knowledge base · Format · Language) · removable chips · Views (saved views)
│                      card or row → document preview → Open full document (Reader)
│                      a base is a filter (kb=); a locked one → Request access; "Some knowledge bases aren't shared with you" → dialog
├── My library ─────── Saved · My files · My collections   (Recent and My contributions are under Your work in the sidebar)
└── Collection (/knowledge/collections/:id) ─ numbered reading order with notes · Ask about this collection · Use in… · Edit mode (order, notes, add resources)
Document preview ───── shared modal from every document row, card and citation: native rendering, highlighted passage · Ask about this document · Open full document
Reader (/doc/:id) ──── document (no outline column) · Ask | About | Related rail (closed by default; ?ask=1 opens Ask) · Save · Add to collection · Use in… (submissions: preview banner, no Ask)
Manage › Knowledge Studio (/studio) ─ Review · Library │ Knowledge bases · Taxonomy · Sources  (see KNOWLEDGE_STUDIO.md)
     └── Knowledge base (/studio/bases/:id) ─ Access (owners) · Sources · Settings (owners) · View documents · what's waiting in review
```

All routes and their purposes are listed in [SCREEN_INVENTORY.md](SCREEN_INVENTORY.md).

## Browse: content first

People come to Knowledge to find and use information, not to manage files. So most of the page is documents, recognisable without opening them; everything else stays out of the way until someone asks for it.

```text
Knowledge · Demo data                                                      [Contribute]   ← top row
Browse │ Saved · My files · My collections                                                ← sticky section bar
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
- **Saved views are a menu, not part of the filter form.** *Views* opens a saved view, saves the current one (*Save this view…*), and renames or deletes the active one (Undo). The button shows the active view's name.
- **Search and Ask stay separate.** Typing always searches documents. *Ask AI* appears in the field once there is a query and turns it into a cited conversation over these results (without a query, filtered results offer *Ask about these*). One AI entry point at a time.
- **The landing is the organization's catalog.** With no query or filter the page shows the collections shared with you (curated reading lists, featured first; one swipeable row on phones) and all shared documents, newest first. Your files and saved documents are personal, so they live in My library (recent reads on Home and Your work → Recent); Browse doesn't repeat them. Featured, recommended and recently published stay on Home.
- **A knowledge base is a filter, not a destination.** Readers narrow by base in More filters (or follow a base link from a document's details, search or ⌘K). Filtering to a base you can't read shows who owns it and *Request access* (or that the request is pending), never an empty list.
- **Grid by default, list for dense scanning.** The table layout was removed: the list already scans densely and the table only repeated it.

**Document card** (`X.res.card`):
- **Preview** shows content, not chrome. Text documents show their most useful section at a readable size: steps in procedures and guides, decisions in notes, findings or recommendations in reports, rules and eligibility in policies, endpoints and limits in technical references; tables keep their columns. When searching, it shows the section that matches, from the matching line, with the words highlighted, unless the title already explains the match. Spreadsheets and slides show their first page. The section is chosen from the document's own section titles; nothing is generated or presented as an insight. Without a rendition, or when the preview would repeat another card's on the page, the card shows a tinted type tile.
- **Text**: the title (no file extension; the format badge shows it), one line on what the document is for (its summary, else its opening paragraph; never a generated "Guide in Product Documentation" line), then type · topic (or base). Topic and base are left out when every card shares it. Trust appears only when it matters: a quiet ✓ for Verified (the tooltip says who and when), a *Review due* chip; nothing for unverified or personal files.
- **Actions**: the whole card opens the document preview (Enter or Space too); Save and ⋯ appear on hover or keyboard focus (always on touch), and a saved document keeps its bookmark visible.

**Document preview** (`X.preview.open`, shared with every resource row, Home, chat and work citations): a centered modal (a near-full-screen sheet on phones) showing the document in its native rendering, with the matching words or the cited passage highlighted and scrolled into view. Header: title, type · knowledge base · updated, and a trust chip only when Verified or Review due. A reading bar steps through matches for the query, or through cited passages (*Passage n of m*, possibly across documents). Footer: *Ask about this document* (opens the Reader's Ask panel) and **Open full document** (the Reader at the same page and highlight). It has no Save, ⋯, editing or sharing — the row it came from already offers those. A locked document opened from a citation shows only the quoted passage and *Request access*.

**States.** Loading shows the search, pills and card skeletons. No results offers *Clear search*, *Clear filters* and *Ask AI*. Long titles clamp to two lines with the full name as a tooltip. A document without a summary or rendition still gets a typed tile and its type. When some bases are locked, *Some knowledge bases aren't shared with you* opens a dialog listing them with *Request access*; their documents never appear.

**Prototype data.** Northwind's product documentation (`d-prod-3`…`d-prod-14`) has authored renditions and summaries so its cards differ the way real documents do; the other generated documents use templates, so some previews look alike.

## Journeys

1. **Engineer — find, read, ask, keep.** Home → *How do I get production access?* → cited answer; or search "production access" → Browse with the Access Control Policy → preview → *Open full document* → Reader → *Ask* → cited passages highlight in the page → *Save* → it shows in My library → Saved.
2. **Engineer — explore by dimension.** Home → topic card *Banking Operations* → Browse filtered by that domain → Type *Procedure* → *Views* → *Save this view…*.
3. **Engineer — read with AI beside the decision.** The Reader on *ADR-031 — Idempotency keys for payment APIs* → ask about retries → cited answer → *Related* shows ADR-027 and the collections that include it → *Use in… Draft*.
4. **Lead — curate.** Open *Payments on-call kit* (shared with Payments Platform; readers find it in Browse's Shared with you) → *Edit* → reorder, annotate (autosaved with Undo), add a resource from the catalog → *Done*. Link a runbook from another base to a space → it appears in that space's materials for members who can read it; access is unchanged.
5. **Lead — look after a base.** Manage › Knowledge Studio → Knowledge bases → *Payments Platform* (the card shows its access request) → Access: approve the request, share with a group as Viewer → Sources → Settings. *Review N* in the base's alert opens its submissions in Knowledge Studio → Review → Submissions.
6. **Analyst — find a definition.** Browse → Topic *Metrics & definitions* → *Metric definitions — Active customers* → preview → *Ask about this document* → the Reader's Ask panel → ask what counts as active.
7. **Admin — keep knowledge healthy and visible.** *Feature on Home* from a document's ⋯ menu (or the Featured documents drawer on Home). Overview → Knowledge health → a metric opens its Knowledge Studio Review queue. *Topics to confirm*: confirm or move groups the assistant filed with low confidence. *Re-verification due* (expired or never verified): verify or ask the owner; documents changed at the source are fixed in *Publishing problems* with *Publish*. *Missing details*: tag untagged documents. *Possible duplicates*: compare, keep the newer and archive the other (collections and saved lists repoint, with Undo). *Taxonomy*: accept topics the assistant proposed (e.g. *Open banking*); it appears in Browse and Edit details at once.
8. **Northwind member.** Same screens without spaces: Home's continue section has no Up next, Browse by People/Sales/Product topics; Legal Contracts stays locked — *Some knowledge bases aren't shared with you* → Request access.

## Rules

- **Authorization first.** Every listing, count, facet, search, related list, collection and AI answer is computed from `readableResources()`/`catalogPool()` (Browse: `sharedPool()`, the same minus My files). Locked bases appear only as bases, never as resource titles.
- **One identity.** Views, collections, saved lists, spaces and topics reference `doc.id`. Merging a duplicate archives one and repoints references.
- **Trust over pipeline.** Readers see verification and freshness. Editors also see index status where they can fix it.
- **Demo data is labelled.** Demo workspaces (Finx) have `ws.demo`. The *Demo data* chip sits in the Knowledge header, the Reader and Knowledge Studio. No Finx record claims to be real policy; a Finx "Verified" means verified inside the demo.
- **Reusable.** Nothing checks for a specific workspace. Spaces appear as a facet and as context only when the Spaces module is on. Topics, types and sources come from data and registries (`RESOURCE_KINDS`, `D.topics`, `APPS`).

## Code

| Layer | File | Owns |
| --- | --- | --- |
| Model | `scripts/core/catalog.js` | Resource kinds, topics, `res(doc)`, trust, access-aware pools (`catalogPool`, `sharedPool`), where a base opens (`kbHref` for readers, `kbManageHref` and `managedKbs` for Manage), search (accent-insensitive, stop words, weighted fields), facets and URL state, saved/recent/views, collections, related, governance signals |
| Data | `scripts/data/knowledge.js` | Taxonomy (domains and topics with codes, keywords, synonyms, examples, guidance and rules, and icon, colour and description for Home; Finx import history), metadata, the Finx catalog (Confluence wiki, SharePoint policies and procedures, Google Drive product docs, GitHub payments docs, uploads; a few Vietnamese titles), featured documents, collections, saved/recent/views, duplicate seeds |
| Shared UI | `scripts/features/resources.js` + `styles/pages/resources.css` | Knowledge header and tabs, resource row, document card with content preview, trust/type chips, details list, save, add to collection, edit details, link to spaces, verify, collection create/edit |
| Pages | `home.js` (Home), `hub.js` (Browse, filters and Views), `library.js` (My library: Saved · My files · My collections; Collection; My contributions), `preview.js` (document preview), `knowledge.js` (Knowledge Studio → Knowledge bases and `/studio/bases/:id`, Request access, restricted bases), `reader.js` (Reader; exports `X.rdr.viewer`, `markHits`, `needles`, `injectQuote`), `contribute.js` (Contribute dialog), Manage › Knowledge Studio: `curation.js` (page, tabs, setup guide, Review workbench and queue chooser, Library with the flow strip, document drawer with Progress) + `governance.js` (To keep right queues, Topics to confirm) + `masterdata.js` (Taxonomy tree and topic detail, import/export; `styles/pages/taxonomy.css`) + `sources.js`/`connections.js` (Sources and its views), `documents.js` (renditions and document operations) | |

## Backend alignment and open decisions

The prototype doesn't change `backend/docs_design`. These need backend design before they can ship:

1. **Topics and verification:** extend `items.metadata` (topics, verification `{by, at, due}`, summary, language) or add a taxonomy table. Topics are the workspace-managed taxonomy with a unique `code`, `keywords[]`, `synonyms[]`, `rules[]`, `examples[]` and `guidance` (as prototyped); import, export and re-classification are listed in [DOCUMENT_LIFECYCLE.md](DOCUMENT_LIFECYCLE.md#backend-alignment-and-open-decisions).
2. **Collections:** a new resource that references `items`. It must not reuse the `items` collection type, which is an access boundary.
3. **Resource ↔ space links:** depend on Spaces becoming a backend concept.
4. **Saved resources, recent reads and saved views:** per-user state, which needs a home (preferences store or tables).
5. **Search facets:** `POST /api/v1/documents/search` needs facet counts and filters for type, topic, owner, source, trust, updated and language.
