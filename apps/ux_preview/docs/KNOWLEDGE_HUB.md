# Knowledge Hub

The Knowledge Hub replaces the old *Knowledge base → Documents* drill-down. People find, read and use knowledge, whatever system it came from. It is a platform capability: UTE Campus is the main demo, and Northwind (Enterprise) runs the same code.

```text
Sources ──► one Resource catalog ──► Discover · Browse · Library ──► Reader ──► Ask · Save · Collect · Use in work
              (permission-filtered)       (many views, no copies)        (provenance, trust, related)
```

## What was wrong

| Before | Problem | Now |
| --- | --- | --- |
| Knowledge = a grid of knowledge-base cards; documents only inside a base | People had to know which container held something. There was no way to find by topic, type, course, owner, source or freshness. | **Browse** is one catalog filtered by ten dimensions, and the URL holds the state. A resource shows up in every view without being copied. |
| `/documents` (flat list), `/search` and the base tables were three overlapping finders | Duplicated capability with inconsistent results | Browse is the only knowledge finder. `/documents` redirects to it. Global search and ⌘K both use the same catalog search. |
| Readers saw Waiting, Processing and Failed | Pipeline states mean nothing to readers and make the product look broken | Readers see **trust**: Verified, Review due or Not verified, plus freshness. Only the base's editors see index status. |
| The viewer showed a page and a metadata panel; *Ask* left for chat | Reading context was lost. There was no provenance, version history or related material. | The **Reader** has Ask, About and Related beside the document. Answers cite passages that highlight in place. |
| Nothing personal | People couldn't keep what they found | **My library**: Saved, Recent, My files, Collections and Saved views |
| No curation across bases | Lecturers and offices couldn't hand people a reading list | **Collections**: ordered, annotated references, shared with a space or the workspace. They never grant access. |
| No governance | Stale policies, untagged files and duplicates were invisible | **Knowledge health** (Manage) handles review cycles, missing details, duplicates and topics |

## Concepts (one meaning each)

| Concept | Is | Isn't | Backend today |
| --- | --- | --- | --- |
| Source | Where content comes from: a connector source (Drive, SharePoint, Moodle, DSpace, website) or an upload | A place people browse | `ingestion_sources`, `external_resources` |
| Resource | One canonical document with metadata. It lives in exactly one knowledge base. | A copy per view | `items` (`item_type=document`) |
| Knowledge base | The governed home: ownership and the access boundary | A topic or folder people must navigate | `items` (`item_type=collection`, root) with role assignments |
| Space | The context people work in (course, research group, office, team, project). Resources link to many spaces. | An access grant; it only surfaces resources members can already read | Prototype only (Campus modules) |
| Topic | The workspace taxonomy: domain → topic | Free-form tags | Proposed: `items.metadata.topics` + a taxonomy table |
| Collection | A curated, ordered list of references with notes | A container. It grants nothing, and items you can't open appear only as a count. | Proposed: new `collections` + `collection_items` (must not be `items`) |
| Saved view | A stored Browse query | A copy of results | Proposed: per-user preference |
| Trust | Verification (by whom, when, next review) + freshness (changed at source) | Index status | Proposed: `items.metadata.verification`; *outdated* already exists (`processed_version`) |

The resource type ("Policy", "Lecture slides", "Thesis"…) maps to `items.document_type` (semantic, not provider identity). Format (PDF, Word…) comes from the MIME type.

## Information architecture

```text
Knowledge (one sidebar item) ─ section tabs:
├── Discover ───────── search box · type shortcuts · Jump back in · From your spaces (or Recently updated)
│                      · Browse by topic · Collections
├── Browse ─────────── facets: Saved views · Topic · Space · Type · Owner · Source · Knowledge base · Trust · Updated · Format · Language
│                      results: list / table / grid · sort · active-filter chips · Save view · Ask about these results
│                      preview panel (≥ 1200 px) → Reader
├── My library ─────── Saved · Recent · My files · Collections · Saved views
│    └── Collection ── ordered items with notes · Ask about this collection · Use in… · edit order and notes · add resources
└── Knowledge bases ── governed homes (access, sources, settings) · locked bases → Request access
     └── Knowledge base ─ Resources (readers) / inventory with processing (editors) · Sources · Access · Settings
Reader (/doc/:id) ──── document · outline · Ask | About | Related rail · Save · Add to collection · Use in…
Manage › Knowledge health ─ Review · Details · Duplicates · Topics
```

All routes and their purposes are listed in [SCREEN_INVENTORY.md](SCREEN_INVENTORY.md).

## Journeys

1. **Student — find, read, ask, keep.** Discover → search "withdraw" → Browse, with Academic Regulations highlighted → preview → open the Reader → *Ask*: "When does withdrawal close?" → cited passages highlight in the page → *Save* → it shows in My library → Saved.
2. **Student — explore by dimension.** Browse → Topic *Machine learning & AI* + Type *Thesis* → 11 theses from the Digital Library → *Save view* "Machine learning theses" → add two to the *Thesis ideas* collection.
3. **Student — revise from a course collection.** Discover → Collections → *IT4071 midterm prep* (the lecturer's notes on each item) → *Use in… Practice quiz* or *Study guide*, with the collection's resources preselected.
4. **Lecturer — curate.** Open *IT4071 midterm prep* → reorder, annotate, add a resource from the catalog. *Lab 2* (from another base) → *Link to spaces* → it appears in Database Systems materials for enrolled students, and access is unchanged.
5. **Researcher — read with AI beside the paper.** The Reader on a paper → *What's the method and main result?* → cited answer → *Related* shows co-topic papers and the lab's collection → *Use in… Literature review*.
6. **Admin / owner — keep knowledge healthy.** Manage → Knowledge health. *Review*: verify, reprocess or ask the owner. *Details*: tag untagged website notices. *Duplicates*: compare, keep the newer and archive the other (collections and saved lists repoint, with Undo). *Topics*: add *Internships*, which appears in Browse and Edit details at once.
7. **Enterprise member.** Same screens: Discover shows Recently updated instead of spaces, Browse by People/Sales/Product topics, Legal Contracts stays locked with Request access.

## Rules

- **Authorization first.** Every listing, count, facet, search, related list, collection and AI answer is computed from `readableResources()`/`catalogPool()`. Locked bases appear only as bases, never as resource titles.
- **One identity.** Views, collections, saved lists, spaces and topics reference `doc.id`. Merging a duplicate archives one and repoints references.
- **Trust over pipeline.** Readers see verification and freshness. Editors also see index status where they can fix it.
- **Demo data is labelled.** UTE has `ws.demo`. The *Demo data* chip sits in the Knowledge header and the Reader, and every UTE rendition carries a demo footer. No UTE record claims to be official policy. A UTE "Verified" means verified inside the demo.
- **Reusable.** Nothing checks for UTE. Spaces appear as a facet and as context only when the Spaces module is on. Topics, types and sources come from data and registries (`RESOURCE_KINDS`, `D.topics`, `APPS`).

## Code

| Layer | File | Owns |
| --- | --- | --- |
| Model | `scripts/core/catalog.js` | Resource kinds, topics, `res(doc)`, trust, access-aware pools, search (accent-insensitive, stop words, weighted fields), facets and URL state, saved/recent/views, collections, related, governance signals |
| Data | `scripts/data/knowledge.js` | Taxonomies, metadata, the UTE catalog (LMS syllabi, DSpace theses, SharePoint courseware, website notices incl. Vietnamese, lab papers), collections, saved/recent/views, duplicate seeds |
| Shared UI | `scripts/features/resources.js` + `styles/pages/resources.css` | Knowledge header and tabs, resource row/card/table, trust/type chips, details list, save, add to collection, edit details, link to spaces, verify, collection create/edit |
| Pages | `hub.js` (Discover, Browse), `library.js` (My library, Collection), `knowledge.js` (bases), `reader.js` (Reader), `governance.js` (Knowledge health), `documents.js` (renditions and document operations) | |

## Backend alignment and open decisions

The prototype doesn't change `backend/docs_design`. These need backend design before they can ship:

1. **Topics and verification:** extend `items.metadata` (topics, verification `{by, at, due}`, summary, language) or add a taxonomy table. The decision is whether topics are workspace-managed (as prototyped) or free-form.
2. **Collections:** a new resource that references `items`. It must not reuse the `items` collection type, which is an access boundary.
3. **Resource ↔ space links:** depend on Spaces becoming a backend concept.
4. **Saved resources, recent reads and saved views:** per-user state, which needs a home (preferences store or tables).
5. **Search facets:** `POST /api/v1/documents/search` needs facet counts and filters for type, topic, owner, source, trust, updated and language.
