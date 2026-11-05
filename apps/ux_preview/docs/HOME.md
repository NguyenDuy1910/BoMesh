# Home — the knowledge-first landing

Home is where every person lands in every workspace (`/home`, first sidebar item). Its job is to show what BoMesh knows before asking anyone to do anything: what knowledge exists, how to explore it, which trusted documents are worth opening, and where you left off.

It is **not** a dashboard (no KPI cards, no charts), a file manager (no inventory, no processing states) or a copy of Knowledge → Browse (no facets, no full lists).

```text
Home
├── Hero ─────────────── greeting · what this workspace knows · one input (scope · Search · Ask) · suggested questions
├── Explore knowledge ── Topics (domain cards) │ Knowledge bases │ Collections          → filtered Browse / base / collection
├── Featured knowledge ─ curated document cards with first-page thumbnails             → Reader
├── Recently published │ Recommended for you (with a reason)                           → Reader
└── Pick up where you left off ─ recent reads · conversations · my contributions · one review line · up to 3 Up next
```

## Sections and why they exist

| Section | What people see | Behaviour | Why this shape |
| --- | --- | --- | --- |
| **Hero** | "Good evening, Khoa"; "Search or ask across 227 published documents in 7 knowledge bases"; one input with a scope select (whole workspace, each readable base, my spaces); **Search** and primary **Ask**; 3–4 suggested questions | Ask starts a grounded, cited conversation (`chat-ask`), scoped if a base or space is chosen. Search opens Browse with the query and, if a base is chosen, its filter. Enter asks when the text reads like a question (ends with "?" or starts with how/what/when/why/who/can/do/is/does/which) and searches otherwise; the hint under the box says which. Suggested questions ask straight away and change by role | The numbers say what this workspace knows. People either look something up or ask about it, so both are first-class without a mode switch |
| **Explore knowledge** | Topic domains as cards: tinted icon, name, one-line description, document count, top topics as chips with counts. A small switch shows **Knowledge bases** instead (mark, owner, count, access; locked bases offer *Request access*) or **Collections** (featured and shared reading lists) | Card → Browse filtered to the domain; chip → Browse filtered to the topic; base → its page; collection → the collection | Answers "what's in here?" at a glance. The three dimensions are progressive disclosure: topics first, structure and curation one click away |
| **Featured knowledge** | Up to 8 document cards showing a real first-page thumbnail, type, title, topic, base, updated date and *Verified* | Card → Reader; Save toggles in place. Workspace admins curate the list with *Feature on Home* in any document's ⋯ menu, and a quiet *Manage* menu here removes items (Undo). A partly filled row is topped up with the most-opened verified documents; with nothing curated the section becomes *Popular and verified* | Shows trusted, useful content immediately. The thumbnails tell people what they'll get before they click |
| **Recently published** · **Recommended for you** | Two compact columns of rows | Recently published = ready, published, readable documents, newest approval first. Recommended comes from what you read (related documents), your spaces and your saved topics. It never repeats what you've read or what is already shown above, skips duplicates, and allows at most two per reason. Each row says why ("Because you read ADR-031", "From Payments Platform") | Keeps Home fresh and personal without a feed. The stated reasons make recommendations trustworthy |
| **Pick up where you left off** | Recently viewed documents, recent conversations, my contributions (changes requested first, with lifecycle chips), one line for reviewers ("5 documents waiting for your review · Review"), up to 3 Up next items when Spaces or Requests are on | Each row opens its target: Reader, conversation, contribution drawer, Documents → Review, event | Continuity matters, but it comes last and stays quiet so admin work never dominates Home |

## Document cards and thumbnails

- The thumbnail is the document's own first page: the Reader's rendition, scaled down inside a fixed 16:10 frame (2:1 on tablets), inert and hidden from assistive technology. Policies look like policies, spreadsheets show their grid, and slides look like slides.
- When there is no rendition (images, unsupported files), the card shows a tinted tile with the file-type badge, the type icon and the title. There are no stock images.
- The whole card is one link to the Reader (`.doc-card__link`). Save is a separate button. Hover lifts the border and shadow slightly; focus shows a ring.
- Exported as `X.docCard(d, {reason})` and `X.docThumb(d)` (`scripts/features/home.js`, styles in `home.css`) for reuse.

## Trust and permissions

Home only shows content from the catalog pools (`catalogPool()`, `featuredResources()`, `recentlyPublished()`). That means published, ready documents the person can open. Submissions, declined or unpublished documents and restricted bases never appear as titles. Locked bases appear in *Knowledge bases* only as bases, with *Request access*. Contributions appear only to their contributor.

## Roles and workspaces

Everything is computed from the active workspace's data and the active persona:

- Greeting and suggested questions follow the role (`D.assistant.roleStarters`).
- Recommendations follow reading history and spaces.
- My contributions appear only for contributors.
- The review line appears only for reviewers and admins.

Switching workspace or persona (prototype bar or account menu) redraws Home with that context. Northwind (no Spaces) has no "From your spaces" reasons and no Up next.

## States and responsiveness

- **States.** Loading skeletons match the layout. Forced Empty shows "Your workspace has no published knowledge yet" with *Contribute* and *Browse*. Error offers retry.
- **Breakpoints.** At ≤ 1023 px: topic cards go to two columns and featured cards to two per row. At ≤ 760 px, Recently published and Recommended stack. At ≤ 679 px: the input's controls wrap under the field, cards are single-column, and featured cards become a horizontal scroll-snap row. There's no horizontal page overflow at 834 or 390 px.

## Relationship to Knowledge

Home absorbed the old Knowledge → Discover page. Two discovery pages competed for the same job, so Discover was removed. Knowledge now opens on **Browse**, the full faceted catalog with list, table and grid views and saved views, alongside My library and Knowledge bases. Home links into Browse rather than reproducing it.
