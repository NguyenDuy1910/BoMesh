# Knowledge Hub

The Knowledge Hub replaces the old *Knowledge base → Documents* drill-down. People find, read and use knowledge, whatever system it came from. It is a platform capability: Finx Workspace is the main demo ([FINX_WORKSPACE.md](FINX_WORKSPACE.md)), and Northwind runs the same code. Discovery — search/ask, topics, knowledge bases, collections, featured and recent knowledge — lives on **Home** ([HOME.md](HOME.md)); the Knowledge section is Browse · My library · Knowledge bases.

```text
Sources ──► one Resource catalog ──► Home · Browse · Library ──► Reader ──► Ask · Save · Collect · Use in work
              (permission-filtered)       (many views, no copies)        (provenance, trust, related)
```

## What was wrong

| Before | Problem | Now |
| --- | --- | --- |
| Knowledge = a grid of knowledge-base cards; documents only inside a base | People had to know which container held something. There was no way to find by topic, type, space, owner, source or freshness. | **Browse** is one catalog filtered by ten dimensions, and the URL holds the state. A resource shows up in every view without being copied. |
| `/documents` (flat list), `/search` and the base tables were three overlapping finders | Duplicated capability with inconsistent results | Browse is the only knowledge finder. `/documents` is now the reviewers' management page (Manage → Documents). Global search and ⌘K both use the same catalog search. |
| Readers saw Waiting, Processing and Failed | Pipeline states mean nothing to readers and make the product look broken | Readers see **trust**: Verified, Review due or Not verified, plus freshness. Only the base's editors see index status. |
| The viewer showed a page and a metadata panel; *Ask* left for chat | Reading context was lost. There was no provenance, version history or related material. | The **Reader** has Ask, About and Related beside the document. Answers cite passages that highlight in place. |
| Nothing personal | People couldn't keep what they found | **My library**: Saved, Recent, Contributions, My files, Collections and Saved views |
| No curation across bases | Leads and offices couldn't hand people a reading list | **Collections**: ordered, annotated references, shared with a space or the workspace. They never grant access. Admins also feature documents on Home. |
| No governance | Stale policies, untagged files and duplicates were invisible | **Manage → Documents** handles review and publication, quality (re-verification, missing details, duplicates) and topics. See [DOCUMENT_LIFECYCLE.md](DOCUMENT_LIFECYCLE.md) |

## Concepts (one meaning each)

| Concept | Is | Isn't | Backend today |
| --- | --- | --- | --- |
| Source | Where content comes from: a connector source (Confluence, SharePoint, Google Drive, GitHub, website) or an upload | A place people browse | `ingestion_sources`, `external_resources` |
| Resource | One canonical document with metadata. It lives in exactly one knowledge base. | A copy per view | `items` (`item_type=document`) |
| Knowledge base | The governed home: ownership and the access boundary | A topic or folder people must navigate | `items` (`item_type=collection`, root) with role assignments |
| Space | The context people work in (team, project, office; the Campus template adds course and research group). Resources link to many spaces. | An access grant; it only surfaces resources members can already read | Prototype only (Spaces module) |
| Topic | The workspace taxonomy: domain → topic | Free-form tags | Proposed: `items.metadata.topics` + a taxonomy table |
| Collection | A curated, ordered list of references with notes | A container. It grants nothing, and items you can't open appear only as a count. | Proposed: new `collections` + `collection_items` (must not be `items`) |
| Saved view | A stored Browse query | A copy of results | Proposed: per-user preference |
| Trust | Verification (by whom, when, next review) + freshness (changed at source) | Index status | Proposed: `items.metadata.verification`; *outdated* already exists (`processed_version`) |

The resource type ("Policy", "Procedure", "Spec"…) maps to `items.document_type` (semantic, not provider identity). Format (PDF, Word…) comes from the MIME type.

## Information architecture

```text
Home (/home, core) ─── search/ask with scope · suggested questions · Explore (Topics · Knowledge bases · Collections)
                       · Featured · Recently published · Recommended · Pick up where you left off  (see HOME.md)
Knowledge (one sidebar item) ─ section tabs:
├── Browse (/knowledge) ─ facets: Saved views · Topic · Space · Type · Owner · Source · Knowledge base · Trust · Updated · Format · Language
│                      results: list / table / grid · sort · active-filter chips · Save view · Ask about these results
│                      preview panel (≥ 1200 px) → Reader
├── My library ─────── Saved · Recent · Contributions · My files · Collections · Saved views
│    └── Collection ── ordered items with notes · Ask about this collection · Use in… · edit order and notes · add resources
└── Knowledge bases ── governed homes (access, sources, settings) · locked bases → Request access
     └── Knowledge base ─ Resources (published; reviewers see what's waiting and a link to Documents) · Sources · Access · Settings
Reader (/doc/:id) ──── document · outline · Ask | About | Related rail · Save · Add to collection · Use in… (submissions: preview banner, no Ask)
Manage › Documents ─── Review · All documents · Quality · Topics (see DOCUMENT_LIFECYCLE.md)
```

All routes and their purposes are listed in [SCREEN_INVENTORY.md](SCREEN_INVENTORY.md).

## Journeys

1. **Engineer — find, read, ask, keep.** Home → *How do I get production access?* → cited answer; or search "production access" → Browse with the Access Control Policy → preview → Reader → *Ask* → cited passages highlight in the page → *Save* → it shows in My library → Saved.
2. **Engineer — explore by dimension.** Home → topic card *Banking Operations* → Browse filtered by that domain → add Type *Procedure* → *Save view*.
3. **Engineer — read with AI beside the decision.** The Reader on *ADR-031 — Idempotency keys for payment APIs* → ask about retries → cited answer → *Related* shows ADR-027 and the collections that include it → *Use in… Draft*.
4. **Lead — curate.** Open *Payments on-call kit* (shared with Payments Platform) → reorder, annotate, add a resource from the catalog. Link a runbook from another base to a space → it appears in that space's materials for members who can read it; access is unchanged.
5. **Analyst — find a definition.** Browse → Topic *Metrics & definitions* → *Metric definitions — Active customers* → Reader → ask what counts as active.
6. **Admin — keep knowledge healthy and visible.** *Feature on Home* from a document's ⋯ menu. Manage → Documents → Quality. *Due for re-verification*: verify, republish or ask the owner. *Missing details*: tag untagged documents. *Duplicates*: compare, keep the newer and archive the other (collections and saved lists repoint, with Undo). *Topics*: accept topics the assistant proposed (e.g. *Open banking*); it appears in Browse and Edit details at once.
7. **Northwind member.** Same screens without spaces: Home's continue section has no Up next, Browse by People/Sales/Product topics, Legal Contracts stays locked with Request access.

## Rules

- **Authorization first.** Every listing, count, facet, search, related list, collection and AI answer is computed from `readableResources()`/`catalogPool()`. Locked bases appear only as bases, never as resource titles.
- **One identity.** Views, collections, saved lists, spaces and topics reference `doc.id`. Merging a duplicate archives one and repoints references.
- **Trust over pipeline.** Readers see verification and freshness. Editors also see index status where they can fix it.
- **Demo data is labelled.** Demo workspaces (Finx) have `ws.demo`. The *Demo data* chip sits in the Knowledge header, the Reader and Manage → Documents, and the first page of every rendition in a demo workspace carries "Demo document — fictional content for the BoMesh prototype." No Finx record claims to be real policy; a Finx "Verified" means verified inside the demo.
- **Reusable.** Nothing checks for a specific workspace. Spaces appear as a facet and as context only when the Spaces module is on. Topics, types and sources come from data and registries (`RESOURCE_KINDS`, `D.topics`, `APPS`).

## Code

| Layer | File | Owns |
| --- | --- | --- |
| Model | `scripts/core/catalog.js` | Resource kinds, topics, `res(doc)`, trust, access-aware pools, search (accent-insensitive, stop words, weighted fields), facets and URL state, saved/recent/views, collections, related, governance signals |
| Data | `scripts/data/knowledge.js` | Taxonomies (domains with icon, colour and description for Home), metadata, the Finx catalog (Confluence wiki, SharePoint policies and procedures, Google Drive product docs, GitHub payments docs, uploads; a few Vietnamese titles), featured documents, collections, saved/recent/views, duplicate seeds |
| Shared UI | `scripts/features/resources.js` + `styles/pages/resources.css` | Knowledge header and tabs, resource row/card/table, trust/type chips, details list, save, add to collection, edit details, link to spaces, verify, collection create/edit |
| Pages | `home.js` (Home), `hub.js` (Browse), `library.js` (My library, Collection, Contributions), `knowledge.js` (bases), `reader.js` (Reader), `contribute.js` (Contribute dialog), `curation.js` + `governance.js` (Manage → Documents), `documents.js` (renditions and document operations) | |

## Backend alignment and open decisions

The prototype doesn't change `backend/docs_design`. These need backend design before they can ship:

1. **Topics and verification:** extend `items.metadata` (topics, verification `{by, at, due}`, summary, language) or add a taxonomy table. The decision is whether topics are workspace-managed (as prototyped) or free-form.
2. **Collections:** a new resource that references `items`. It must not reuse the `items` collection type, which is an access boundary.
3. **Resource ↔ space links:** depend on Spaces becoming a backend concept.
4. **Saved resources, recent reads and saved views:** per-user state, which needs a home (preferences store or tables).
5. **Search facets:** `POST /api/v1/documents/search` needs facet counts and filters for type, topic, owner, source, trust, updated and language.
