# Knowledge Studio: how knowledge gets in, gets processed and gets published

Knowledge Studio (Manage › Knowledge Studio, `/studio`) is the one place a workspace's knowledge is run. This document owns its concept: the information architecture of Manage and the Studio's sections — **Documents** (All · Review · Issues · Quality) and **Topics** (Topics · Suggestions) beside Collections and Sources — explicit processing, the order things are set up in, and how it behaves at scale (the 1,000-document flow and the 100,000-document first sync). The per-document lifecycle — contribute, review, publish, process, every state and label — is in [DOCUMENT_LIFECYCLE.md](DOCUMENT_LIFECYCLE.md). Reading and using published knowledge is in [KNOWLEDGE_HUB.md](KNOWLEDGE_HUB.md).

## The mental model

> Documents come in from **sources**, uploads and contributions and land in a **collection** (which decides who can read them). Each has two independent states: **publication** (may people see it?) and **processing** (has it been read, classified against the workspace's **topics** and indexed?). Uploading is not processing: an admin chooses what to process, and a document is **searchable** only when it is published **and** processed.

```mermaid
flowchart LR
  subgraph Setup["Set up once (in this order)"]
    KB["1 · Collections<br/>where documents live,<br/>who can read them"] --> MD["2 · Topics<br/>domains, topics, keywords,<br/>synonyms, guidance, examples"] --> SRC["3 · Sources<br/>what comes in, how often,<br/>how it's published"]
  end
  subgraph Docs["Documents — two independent states"]
    IN["Received<br/>(sync · upload · contribution)"] --> PUB{"Publication<br/>Review · source policy"}
    IN --> PROC{"Processing<br/>an explicit run"}
    PUB -->|approved| P1["Published"]
    PROC -->|read · classified · indexed| P2["Processed"]
    P1 --> LIVE["Searchable<br/>search · answers"]
    P2 --> LIVE
    PROC -.->|failed · changed at source| ISS["Issues<br/>(each with its fix)"]
  end
  SRC --> IN
  MD -.->|classified at processing| PROC
  PUB -.->|a reviewer changes a topic| COR["Topics → Suggestions"] -.->|an admin adds a keyword| MD
```

Processing happens only through an explicit **ingestion run**: the Process dialog over a selection, *Process it now* on approval in Review (on by default), a row's fix, or a source's sync (the sync is that source's explicit run). Approving never starts processing by itself. Classification happens **once per document, at processing time**: its type and summary also become the `<document_profile>` block `contextual_rag.md` puts before each passage, and its topics live in the index's metadata only — so changing the topics re-files documents without re-indexing them.

## Principles

1. **One place for knowledge.** Everything about knowledge — sources and the accounts they read with, collections, topics, review, the document registry — is one destination. People, the assistant, audit and settings are the rest of Manage.
2. **Set up in the order intake needs it: where → how it's filed → what comes in.** A source needs a destination (a collection), and its documents should not be processed before the topics exist, or they are classified against nothing.
3. **Access is configured, never inferred.** Each source lands in exactly one collection, and that collection's access rules decide who reads its documents. Processing classifies; it never decides who can see something.
4. **Names follow domain resources.** Sections and views are named after what they hold — Documents, Topics, Collections, Sources; Review, Issues, Quality, Suggestions — not after a workflow metaphor.
5. **Publication and processing are two axes.** Publishing answers *should people see this?*; processing answers *can search and the assistant use it?* Neither implies the other, and no single bar mixes them.
6. **Uploading is not processing.** Nothing is processed on upload. With 1,000 uploaded documents an admin filters, selects and processes them, and sees what it costs before starting.
7. **Every origin converges.** Source syncs, editors' uploads (*Add documents*) and members' contributions land in the same Documents.
8. **At scale, people decide batches, not documents.** A 100,000-file sync produces a handful of review decisions — one per reason — each with a sample; *Select all matching* processes a filter in one action.
9. **Corrections teach, admins decide.** A reviewer's topic change is recorded as a correction and shown in Topics → Suggestions; it changes the topics only when a workspace admin turns it into a keyword or an example.
10. **An account is a source's credential, not a destination.** It is created inside the Add source wizard, reused when adding the next source, and fixed by *Reconnect* on the rows of the sources that use it when it expires.
11. **One badge, one landing.** The sidebar badge counts what Knowledge Studio opens on: the decisions that keep documents from people (Review + Issues), else what's broken in sources, else access requests an owner decides.

## Information architecture

```text
Manage
├── Overview            what needs you across the workspace; the next unfinished setup step (the full guide only in an empty workspace)
├── Knowledge Studio    /studio — sections are sidebar sub-rows under this row
│     Documents · Collections · Topics · Sources
│       ├ Documents views: All · Review · Issues · Quality
│       ├ Topics views:    Topics (workspace admins) · Suggestions
│       └ Sources views:   Sources · Sync history · Accounts
│     └── one collection: /studio/collections/:id ─ Contents · Access · Sources · Settings
├── People · Assistant · Activity · Settings
```

| Section | Decides | Who sees it | Top-row action |
| --- | --- | --- | --- |
| Documents | Every document's publication and processing state; what to review, process, fix and keep healthy | Reviewers (owners of a collection; workspace admins own all) | Add documents |
| Collections | Where documents live and who can read them (the access boundary) | Owners and editors of a collection; workspace admins | New collection |
| Topics | The topics documents are classified under at processing time; what the assistant and reviewers suggest | Topics: workspace admins. Suggestions: everyone who works documents (proposals read-only for non-admins) | Import (Topics) |
| Sources | What comes in, from which account, how often, into which collection, under which publishing policy; sync history; accounts | Source admins (`source.manage`) | Add source |

There is no tab bar for sections. While you're in the Studio (`/studio?tab=…`, or a collection page `/studio/collections/:id`, which marks Collections) and the sidebar is expanded (also off-canvas on tablet/phone), the Manage → Knowledge Studio row shows its sections as sub-rows — only the ones the caller may use (`X.studioTabs`, built by `X.studioNav()` in `features/curation.js`). Sub-rows render only when a row has ≥ 2 sections (`navKids` in `core/shell.js`): someone with only Collections (Finx engineer) sees no sub-rows and a page titled "Collections". On the collapsed icon rail the row is a button opening a menu to its right (`MENUS['nav-sub']`) with the sections, their counts and the current one checked; Esc returns focus to the rail button. ⌘K's Go to finds sections too. A new Studio feature adds one sidebar row or one view of an existing section, not a tab: the sidebar scales vertically, a tab bar does not ([DESIGN_SYSTEM.md](DESIGN_SYSTEM.md#layout--styleslayoutcss)).

The top-row title is the section name with the *Demo data* chip and the section's one action; no "Knowledge Studio" crumb. A collection page keeps its trail Knowledge Studio › Collections › name; the Reader for a submission is trailed Documents › title. *Add documents* opens the contribute dialog; editors' uploads land in the same Documents. The page opens on what needs the caller: Documents if a decision waits, else Sources if something is broken, else the first section. The Studio page is a workbench, wider than reading pages (`.page--studio`, up to 1680 px) with a tight header: title and action, no description (the sidebar says where you are).

**Counts.** Each sub-row counts what waits on the caller: Documents the decisions that keep documents from people (submissions + open sync batches, each batch once, + issue documents; accent), Collections access requests the owner decides, Topics the suggestions (the same number as the Suggestions tab), Sources broken sources and accounts (failed syncs + expired accounts; danger). While sub-rows show, the parent row's single badge is hidden. Otherwise (collapsed group, other pages, rail) the one badge counts those decisions, else source problems, else access requests the owner decides.

## Documents

`/studio?tab=documents&view=all|review|issues|quality`. Four views as page tabs; the default is Review if it has items, else All. Review (accent) and Issues (danger) count what keeps documents from people, Quality counts quietly, All carries no count.

| View (`view=`) | What's in it | Decision |
| --- | --- | --- |
| All (`all`) | Every document in the collections the caller reviews, whatever its origin | Process · Publish · Unpublish · Archive, per row or in bulk |
| Review (`review`) | Submissions and what a sync held back (batches by reason) | One decision each; *Process it now* on approval |
| Issues (`issues`) | Documents that couldn't be processed (failed) or changed at the source (outdated) | Each row's fix; bulk *Process again* |
| Quality (`quality`) | Re-verification due · Missing details · Possible duplicates, as `part=reverify|details|duplicates` | Verify in bulk · fill in · compare and keep one |

### All

The registry. Filters, shown once they would split the list: search, Collection, Publication, Origin (`?src=contrib` for contributions), Type, Topic. Above the table, one row of **processing state pills** without counts (the backend doesn't count documents per state; a select on phones): All · Not processed · Processing · Processed · Failed · Outdated · Not supported (`?processing=`).

Columns: **Name** (collection › folder · origin: the source, the contributor, or the editor who uploaded it) · **Processing state** (a chip and one line — *Search can't find it*, *Reading, classifying, indexing…*, *Searchable · v2*, *Ready to publish*, the error, *The previous version answers*, *Download only*) · **Publication** · **Topics** (and who chose them: *Assistant*, *Suggested* for a submission, *Set by a person*; no confidence) · Updated · a row fix (*Process*, *Process again*, *Process the update*, *Publish*) and ⋯. There is no Visibility column: who can read a document is its collection's (or folder's) audience. Each first sync at scale adds one counted row (*Operations archive · First sync — 2,950 documents held for a decision · Counted, not listed*) with *Open sync*.

**Bulk bar.** Selecting rows shows "N selected"; with the whole page selected, *Select all matching* (no number) extends the selection to every document the filters match, and the bar then reads *All matching selected*. Actions: **Process** (opens the Process dialog) · Publish · Unpublish · Archive, each with Undo where it can be undone.

### Review

Submissions — member contributions, editors' uploads, review-first syncs — and what a sync held back (batches by reason, *Held back by a sync* first), one decision each. The workbench fills the screen under the tabs (no page scroll), in three panes that each scroll on their own: the **list** · the **document** (its first page at reading size, *Open full preview*) · the **inspector** (who sent it, where to and when; the note to reviewers and what was found as compact rows — possible duplicate with Compare and the *Publish as a new version* switch, personal data, new version, can't be searched; the **Classification** fields, label above control, with one provenance line; and the decision footer pinned at its bottom: "Publishes to {collection} · {audience}", Approve & publish, Request changes, Decline). Keyboard: J/K or ↓/↑ move through the list; on a submission Enter opens the full preview, **A** approves and publishes, **R** requests changes. Without room for a readable document pane (Studio page under 1140 px) an eye button in the inspector header opens the preview. Phones show the list, then the inspector full screen with Back and a floating decision bar. A **batch** uses the same list and inspector without a document pane: why they were held, who would see them, a five-title sample, and the batch's two decisions. Bulk approve has Undo.

**Process it now.** The decision bar carries a *Process it now* checkbox, **on by default** (not shown for images and archives). Approving with it on publishes the document and starts a processing run for it ("Processing it now."). Unchecked, the document is published but Not processed — toast: "Not processed yet: process it from All when you're ready."

**Teaching the topics.** When a reviewer changes the topics the assistant suggested, *Use my change to improve classification* appears under them (on by default). Approving records a **correction** (`recordCorrection`: document, title, from → to, who, when) and marks the topics as set by a person; Undo removes it. Corrections appear in Topics → Suggestions and never change the topics by themselves.

### Issues

Documents that couldn't be processed (failed: unreadable, password-protected, stopped partway) or that changed at the source since they were processed (outdated: answers use the previous version). Each row shows its fix — *Process again*, *Process the update*, Replace file (uploads), Open source (password-protected synced files) — and selected rows get one bulk **Process again**. Every row opens the document drawer.

### Quality

Keeping published knowledge healthy, as parts: **Re-verify** (expired or never verified; verify in bulk) · **Details** (missing owner or summary; fill in) · **Duplicates** (compare and keep one; merging repoints reading lists, saved lists and recents). The open part is `?part=`, else the first with items. Nothing here holds a document back.

### Processing a selection

**The Process dialog** asks for one decision and offers one optional input. It never publishes: people review, then publish.

- **Header:** "Process N documents" for checked rows, with a subtitle saying the AI reads each file and suggests topics, plus the estimate ("About X min for N pages; you can keep working"). For *Select all matching* (a filter, not a counted list) it reads "Process the matching documents", with no estimate.
- **Topics:** a segmented control, *All topics* | *Selected*, with one hint line under it ("The AI suggests from all 26 topics." / "…only from these 6 topics.").
  - *Selected* starts from the usual topics of the documents' collection (its listed topics, then those its documents carry most, at most eight), when the selection comes from a single collection.
  - *Use {collection}'s topics* adds them again in one click.
  - Chosen topics show as neutral chips, five at a time with "+N more". *Add topic…* also offers whole domains.
  - *Selected* with no topics shows an inline error when the person tries to process.
- **Context for the AI** (optional): a quiet *Add* link that opens a two-line field (e.g. "Scanned decisions and notices, 2015–2024").
- **Layout:** sections are separated by hairlines, with no nested boxes, step list or outcome summary. Footer: *Cancel* · **Process N documents** (**Process** for all matching).

Confirming starts one ingestion run with that classification context: `X.processRun(docs, { context: { topics, note } })` in `features/documents.js`.

- Only the chosen topics are candidates (`topicMatches(…, only)`), and the context is read with each title.
- Topics the assistant applied before are picked again within the context; topics a person chose stay.
- The context stays on each document (`classCtx`), so later topic changes re-check it within the same choices.
- The drawer's Processed step adds "among N topics chosen for its run · with context for the AI".
- The toast reads *Processing N documents · Show them*.

**The processing strip** sits above All and Issues while a run is in flight.

- It shows "Processing 1,000 documents · 400 processed · 40%" (failures counted too) and, for a run with a context, "Classifying against 6 topics you chose, with your context".
- It has a progress bar, **Show them** (All filtered to Processing) and **Stop** (`X.stopProcessRun`: what's done stays processed; the rest goes back to Not processed).
- A run left in flight by a reload picks up where it was.
- When the run ends, a toast reports the result; failures offer *See issues*.

**The document drawer** shows the document's progress as five steps — **Received · Reviewed · Published · Processed · Searchable** — each done, current, issue, skipped or to do, with one line (who and when; who approved, or "Not needed: {source} publishes automatically"; "Not processed yet: search and the assistant can't use it"). Publication and processing are independent, so either can be done while the other isn't; Searchable needs both. *Publish* and *Process* buttons sit on the step that needs them. Details: [DOCUMENT_LIFECYCLE.md](DOCUMENT_LIFECYCLE.md#publication-and-processing).

## Topics

`/studio?tab=topics&view=topics|suggestions`. The topics documents are classified under when they are processed.

- **Topics** (`view=topics`, workspace admins only): the domain → topic tree beside an editable detail, import/export and the classification prompt — described in [DOCUMENT_LIFECYCLE.md](DOCUMENT_LIFECYCLE.md#topics). Saving a topic, importing, or adding a keyword or example re-checks the processed documents the assistant tagged (`reclassifyPublished(before)`; people's choices stay); only documents whose result changes move. Toast: "Added "đối soát" to Reconciliation · 222 documents re-checked, 1 document changed topic. No re-indexing needed." with one Undo. There is **no classification threshold**: the assistant picks topics among the candidates and they're applied as assistant-applied; a document it gives none is listed in Suggestions. A topic's **Rules** are *Documents in* a collection (its whole subtree) or *Documents from* a source; a document a rule matches gets exactly the matching rules' topics without asking the model. **Show the classification prompt** (⋯) opens what processing sends the model, compiled from the topics as they are now: the rules checked first without a model call (documents in a collection / from a source → topic), then `document_profile.md` (instructions, `<taxonomy>`, the `<document>` slot, the JSON output schema with topic codes and no confidence), then the `<document_profile>` block; Copy prompt and a token estimate.

### Suggestions

`view=suggestions`, for everyone who works documents; the sidebar badge and the tab count are the same number. Four groups, all with Undo, none holding a document back:

- **Topics the assistant proposes** — Accept · Rename · Change domain · Merge into (adds the name as a synonym) · Dismiss; workspace admins decide, others see them read-only.
- **Keywords from reviewers' corrections** — one card per topic reviewers moved documents to: *Reviewers moved 3 documents to Reconciliation*, where the pipeline had filed them, and **Add as a keyword** chips for phrases two or more of their titles share (`correctionSuggestions()`: two-word phrases, single English words, acronyms; never a fragment of a stop phrase such as "giao dịch"). *Misled by "napas", a keyword of Payments & settlement* names the word that sent them astray. Also *Add as examples* · *Open topic* · *Dismiss*. One correction isn't a pattern: its card offers examples only.
- **Topics to confirm** — a first sync's topic groups (published with the topics the assistant applied, or without one): *Confirm topic* · *Move to another topic…*.
- **Without a topic** — processed documents the assistant gave no topic: *Add topic*.

## The 1,000-document flow

1. Documents → All → the **Not processed** pill.
2. Optionally narrow by Collection, Type or search (e.g. a year).
3. Select the page checkbox, then **Select all matching**.
4. **Process** → the dialog → *Process the matching documents* → **Process**.
5. The processing strip shows progress; keep working, *Show them* or *Stop*.
6. A toast reports the result; failures go to Issues (*See issues*).

Seeds: UTE has 1,000 digitised records in Phòng Đào tạo › "Văn bản số hóa 2015–2024"; Finx has 1,200 in Banking Operations › "Archive upload 2016–2025". Both are Unpublished and Not processed. Journeys (`core/proto.js`): *Choose which of 1,000 digitised records to process* (UTE admin) and *Choose which of 1,200 uploaded documents to process* (Finx admin).

## Addresses and old routes

Addresses: `/studio?tab=documents&view=all|review|issues|quality` (All adds `processing=`, the facets `kb`, `src`, `topic`, `q`; Review `sel=<submission or batch>`; Quality `part=reverify|details|duplicates`); `/studio?tab=topics&view=topics|suggestions` (Topics adds `node=<topic id>|__new` and `show=bare`).

Old routes redirect: `/sources` → `/studio?tab=sources` (`?tab=history` → `&view=history`), `/connections` → `/studio?tab=sources&view=accounts`, `/bases` → `/studio?tab=collections`, `/bases/:id` → `/studio/collections/:id` (query kept), `/documents` and `/knowledge-health` → `/studio`. Older Studio addresses are rewritten in place (`legacyOf` in `features/curation.js`):

| Old address | New address |
| --- | --- |
| `tab=flow&mode=needs&queue=publish`, `tab=review`, `stage=decide`, `life=review|changes` | `tab=documents&view=review` |
| `queue=problems|issues`, `life=attention`, `stage=issue` | `view=issues` |
| `tab=quality&seg=…`, `queue=upkeep|reverify|details|duplicates` | `view=quality&part=…` |
| `tab=taxonomy|master`, `mode=rules` | `tab=topics&view=topics` |
| `queue=classify|confirm`, `node=__learn` | `tab=topics&view=suggestions` |
| any other old flow, `all` or `library` address | `tab=documents&view=all` |

## Overview → Knowledge health

The Studio has no metrics tab. Overview shows one row of metrics for the collections the caller reviews — Waiting for review · Issues · Not processed · Topic suggestions · Quality · Verified (share) — each a link to its view. Knowledge health and Knowledge gaps have no description lines. Overview's *Needs attention* covers what isn't a Studio view: sources, accounts, access, office requests and the next unfinished setup step, so each count lives in one place.

## Collections

The section opens with its toolbar and cards (no intro paragraph). Collection cards show documents, folders, top topics and, when documents from other collections are linked in without copies (`kb.links`, the backend's `item_links`), *n linked*. Contributions land in the same Documents. A collection's page has page tabs **Contents** · Access · Sources · Settings (views of that one collection; editors who don't own it get Contents · Sources) and an **Access requests** section for owners; workspace admins get *Open access requests* → People → Access requests. Its one primary action is **Add documents** (into the folder on screen; they land in Documents like every contribution); ⋯ holds *Open in Documents* (reviewers: All filtered to it), *Open in Knowledge*, *Add source* and *Copy link*.

### Contents: where things live, and who reads them

A collection is the top of a tree: folders (the backend's nested collections) and documents, the same tree Home's map draws. Contents (`?tab=contents&folder=`) is that tree beside the open folder — the Topics tree + detail pattern — and is the only place the structure is changed:

- **Tree** (left, sticky; above the list under 900 px): the collection, then its folders with each one's kind icon (the workspace's level vocabulary, as on Home) and the documents under it. The path to the open folder is expanded; a lock marks a folder with its own access.
- **The open folder** (right): its path, name and ⋯ (Edit details · Move to… · Restrict / Manage access · Remove folder), its kind and counts, its description, then one **access line** saying who reads what's here and where that's decided — *Everyone in Finx Workspace* (top level, *Manage access*), *Same as the collection: …* (*Restrict access*), *Own access: Risk & Compliance · Other readers of Security & Compliance don't see it* (*Manage access*), or, under a restricted folder, *Only people added to Controls · set there*. **New folder** sits beside the name. One table lists its folders first, then its documents (status chip, updated; the row opens the document drawer); selected documents get one bulk *Move to…*. Search, shown once a folder holds more than 12 items, looks through the whole collection and says where each match lives.
- **Folder details** (New folder · Edit details): name (unique among its siblings), description (Home shows it when someone selects the folder) and, when editing, its **Kind** — a level label from the workspace's vocabulary when it isn't what its depth says. New folders take their depth's label.
- **Moving** documents and folders uses one destination tree (`X.move` in `features/documents.js`): the current collection first with its folders open, other collections you edit (their folders open once picked, or by searching), the current place disabled. Under the tree one line says who will see what moves — in the warning tone when that changes ("Who can see them changes: Everyone in Finx Workspace"). Folders move within their collection; documents move anywhere you edit. Undo on every move.
- **Removing a folder** never deletes documents: what's in it moves up a level, with Undo. A folder with its own access asks first, naming who will be able to read its contents afterwards.
- **Own access** (owners): *Restrict access* gives a folder its own people and groups with roles, starting from the collection's owners (and you), so whoever manages it keeps reading it. From then only they — and workspace admins — read the folder and everything under it; the collection's general access and its people don't reach inside, and a collection grant never overrides it. *Use the collection's access* undoes it. The collection's **Access** tab lists *Folders with their own access* under its people ("They reach every folder except the ones below").

Folder access is enforced where everything else is (`canReadFolder` in `core/catalog.js`, used by `readableResources`, `canOpenRes` and `curatedDocs`): Browse, search, the assistant, Home's map (a folder without readable documents isn't drawn) and Documents all leave a restricted folder out for people it doesn't name, exactly as if it weren't there. Every "who can see it" line — the document drawer, the reader's details, Review's *Publishes to*, the move dialog — names the folder that decides when one does ("Set on the folder Evidence 2026, not the collection").

**What moved and why**

| Before | Problem | Now |
| --- | --- | --- |
| Knowledge Studio, Collections, Sources and Connections were four sidebar items | One flow split across four places; an expired account showed on Sources (link) and Connections (fix); a collection's page repeated its sources and linked to the Studio for its documents | One sidebar item, Knowledge Studio. Collections and sources are its setup sections (sidebar sub-rows); the collection page lives under it |
| Connections page | Accounts were a destination nobody needs except to fix an expiry | Sources → Accounts view. The wizard signs in; a source row on an expired account carries Reconnect; Overview's item reconnects in place |
| Separate badges on Studio, Sources and Connections | Three counts for one area, two of them for the same root cause | One badge for the landing section; each section's sub-row counts its own work (Sources: failed syncs + expired accounts, danger) |
| No order | New admins didn't know to load topics before connecting a 100k-file drive | The setup guide: Create collections → Load your topics → Add sources → Check the first sync — in full only in an empty workspace, then one Needs attention row for the next step |
| Review, Documents and Taxonomy were three sections, then one pipeline page with a stage bar | Workflow names didn't match domain resources; one bar mixed publication and processing; uploads were processed implicitly, so 1,000 uploaded documents couldn't be chosen from | **Documents** (All · Review · Issues · Quality) and **Topics** (Topics · Suggestions), named after resources; publication and processing are two independent states; processing is an explicit run over a selection |
| A sticky tab bar Review · Documents │ Collections · Taxonomy · Sources | A tab bar doesn't scale as features are added, and repeated the sidebar's job | Sections are sidebar sub-rows of Knowledge Studio, each with its own count |
| Master data tab with a topic drawer | Topics were a list of keywords; nothing explained or tested classification | Topics: a tree beside an editable detail with synonyms, examples, guidance, rules and a test box ([DOCUMENT_LIFECYCLE.md](DOCUMENT_LIFECYCLE.md#topics)), plus the prompt; what corrections suggest is in Suggestions |
| Reviewers' topic changes were lost | The same misfiling repeated on every sync; admins guessed keywords | Corrections are recorded at approval and turned into keyword candidates in Topics → Suggestions |
| A collection page with Access · Sources · Settings and *View documents* | Its structure (the folders Home draws) couldn't be seen or changed anywhere; editors who don't own a collection got a page with only its sources; Home's *Edit structure* led to cards | Contents first: the folder tree and the open folder's folders and documents, folder create · edit · move · remove, document moves, folders with their own access. Home's inspector has *Edit in Studio* for the box you selected |
| Move to a collection only, with a flat list | Documents couldn't be filed into a folder; the dialog said access "follows the new collection" without saying what that meant | One destination tree (collection › folders) for documents and folders, with who will see what moves and a warning when it changes |

## The setup guide

The full four-step *Set up knowledge* checklist (`X.setupGuide()`, workspace admins) shows only on Overview of a workspace with nothing set up yet (the prototype's *Empty* state, where it is the whole Overview, every step to do). Once any step is done it is never a block on any page, Studio setup sections included, and there is no progress bar or "n of 4 done" line. Instead Overview → *Needs attention* shows one row for the next unfinished step (`X.setupNext`), with the step's action (New collection · Import topics · Add source · Open Sources). For the topics step the row is named by what's missing — "n topics without keywords · Documents aren't filed under a topic until it has words to recognise it by" — with **Add keywords** → `/studio?tab=topics&view=topics&show=bare` (Northwind: topics not loaded yet, so step 2 is next).

| Step | Done when | Why here |
| --- | --- | --- |
| 1 · Create collections | A shared collection exists | Every source and upload needs a destination, and the destination decides access. Make one per access boundary: a team, a function, the whole company (Everyone) |
| 2 · Load your topics | Imported once, or ≥ 80 % of topics have keywords | Documents are classified when they are processed; loading topics after a 100k sync means re-checking everything |
| 3 · Add sources | A source exists | Now each source has a collection to land in and topics to be filed under |
| 4 · Check the first sync | A source has synced | Look at what was held for review and what has topics to confirm, then let the schedule run |

## Configuring a source

The Add source wizard: **App → Account → Content → Destination**. Accounts are created here; Sources → Accounts lists them (Connect account; an account's ⋯ *Add source with this account*) and an expired one is fixed by *Reconnect* on the rows of the sources that use it, or the Overview item. An expired account no source uses shows in the views control label: "Accounts · n expired".

**Add source** is the one verb everywhere (Sources header, "No sources yet" empty states, a collection's Sources section, ⌘K). Once accounts are connected it is a menu: *Use a connected account* (each account → the wizard opens at Content with that account, and from a collection that collection, preselected) · *Connect another account…* (the wizard from the app). A collection never picks an existing source: a source is one connection + folders + **one** target collection, fixed at creation (`Source.targetCollection` is immutable, `backend/docs_design/api_design.md`), so it can't feed a second collection; what is reused is the account. In Content, folders or spaces another source already syncs are disabled with "In {collection}" (tooltip "{source} already syncs it"): their documents are already in that collection; to show a document elsewhere, link it rather than adding a second source.

| Setting | Options | Defaults and rules |
| --- | --- | --- |
| Account | An existing sign-in for the app, or sign in now | The account is saved for the next source; it's listed in Sources → Accounts |
| Content | Folders, spaces or pages in a tree | Select whole folders; the estimate updates live |
| Filters (disclosure on the Content step) | File types as chips (PDF, Word, Excel, PowerPoint, Email; Images & video off) · *Skip folders named* (default "Archive old, Personal", matched against any folder on the path) · *Only files changed since* (Any time / 2018 / 2020 / 2023) | Saved on the source as `{ types, exclude[], since }`, shown as one line under *What it syncs*, editable via *Change what's synced*. Estimate line: *About N files · M filtered out (reason n, …) · K to sync*; filters that leave nothing block Continue with an inline error. Above 10,000 files a *Large source* hint estimates the hours at 118 files/min, and the source starts with a first sync at scale |
| Collection | One collection (or create one) | One source → one collection. Content for different audiences = different sources |
| Schedule | Manual · daily · weekly, time, time zone | Daily at night by default |
| Publishing policy | Publish automatically · **Review only what's uncertain** · Review everything | Size-based default: *Review only what's uncertain* above 1,000 files to sync, *Review everything* otherwise; it follows the selection until the person picks one (*Suggested for a source this large/small*). Changing a source's policy later toasts with Undo |

**Publishing policies**

| Policy | Publishes | Holds for review | Use for |
| --- | --- | --- | --- |
| Publish automatically | Everything, after each sync | Nothing | Trusted systems an admin curates (policy library, LMS) |
| Review only what's uncertain | Clean, classified files; changed published files republish | New files with a risk flag — personal data, ≥ 0.55 similar to a published document (likely duplicate), a likely new version — as submissions; at scale grouped into batches by reason | Large or mixed sources; the default at scale |
| Review everything | Nothing until approved | Every new or changed file, one submission each | Small or untrusted feeds (a website, a shared inbox) |

Classification never holds a file back under any policy: a file the assistant gives no topic is published and listed in Topics → Suggestions. A sync processes what it brings in: the sync is that source's explicit ingestion run.

**The Sources list** has no alert banners above it. Each row carries its own fix as its one visible row action, in priority: first sync *Pause*/*Resume* · *Cancel* (syncing) · **Reconnect** (account expired) · **Retry** (failed) · *Resume* (paused) · **Process n** (synced documents waiting to be processed: a processing run over them, toast "Processing n documents from {source}"; runs never publish) · a quiet *Sync now* icon (healthy). There is no *Process all* bulk action. An expired account no source uses shows in the views control label ("Accounts · n expired").

## The 100,000-document walkthrough

Finx Workspace's demo seeds this case: the source **Operations archive** (SharePoint → Banking Operations, policy *Review only what's uncertain*) in its first sync.

### 1. Before the sync

1. **Collection** — *Banking Operations* exists, general access *Everyone*: when its documents publish, everyone in Finx can find them.
2. **Topics** — imported with keywords per topic (`OPS-03 Cards & disputes: chargeback, dispute, card scheme…`).
3. **Source** — the archive folders, filtered to PDF, Word, Excel, PowerPoint and email, skipping *Scans to sort* and *Personal*, changed since 2018. The wizard's estimate: about 100,240 files · 3,830 filtered out (2,900 images and videos, 930 not changed since 2018) · 96,410 to sync.

### 2. The first sync (backfill)

One ingestion run, counted per stage, never simulated file by file.

**Sources row.** The status cell shows a *First sync* chip, a progress bar and `read/total` (*62k/96k*); the row action is Pause, or *Resume* when paused. *Sync now* and *Cancel* are blocked meanwhile; disconnecting the account pauses it and reattaching resumes it. The collection's Sources section shows the same chip.

**Source drawer.** A *First sync* card: percent, files read, ETA, held for review, *View progress*. Next sync reads *After the first sync*; the footer is *Pause / Resume first sync*.

**Run drawer** (Sync history → the run): a progress card with throughput and ETA (remaining = found − filtered − read), then the pipeline:

```mermaid
flowchart LR
  F["Received<br/>100,240 found<br/>3,830 filtered out"] --> R["Read<br/>61,830 read<br/>410 couldn't be read"]
  R --> C["Classified<br/>61,420, once each"]
  C --> G{"Decision<br/>(policy)"}
  G -->|clean| I["Indexed<br/>processed by the sync"]
  I --> P["Live · 58,470<br/>searchable as read"]
  G -->|personal data · duplicate · new version| B["Held for a decision · 2,950<br/>in 3 batches<br/>processed by the sync, unpublished"]
  P --> T["Topics: 52,800 filed<br/>1,860 to confirm · 3,810 no topic"]
```

- **Issues by error class, each with its fix**: 120 password-protected (remove the password at the source), 210 scanned without text (OCR is a platform policy), 80 larger than 100 MB.
- **Classification split** as a stacked bar (filed under a topic · to confirm · no topic) with *Confirm topics* → `/studio?tab=topics&view=suggestions`.
- **Held for review**: the open batches by reason with *Open review* → `/studio?tab=documents&view=review`, plus a declined count once batches are declined. Both links close the drawer first.
- Footer: *Open source* · *Pause / Resume*; a paused run shows a *Paused* chip. Pause toggles run `paused`/`running` and source `paused`/`syncing`, with Undo.
- **Tick** (prototype): every 3 s, only while the Sources section or a source/run drawer is visible, about rate/20 files are added to read, classified, published and filed under a topic. Held batches and topics to confirm stay fixed so they keep matching the batches and topic groups. At the end the run completes, the source turns healthy and a toast says so.

Counters keep one invariant: **classified = published + review + declined**; topics (filed + to confirm + no topic) are counted for published files.

### 3. What people decide (minutes, not months)

**Documents → Review → Held back by a sync.** Each batch is one decision and counts once in the Documents sub-row, the sidebar badge, Knowledge health and the landing rule. Batches have no checkbox (each is already one decision); J/K moves through them. A batch's documents were processed by the sync (that source's ingestion run), so publishing a batch makes them searchable at once; batches have no *Process it now*.

**Batch detail** (the inspector, beside the batch queue): reason, count, source → collection, when it was held, why they were held, the audience (*Everyone in Finx Workspace would see them once published*), five sample titles, and a decision footer per reason:

| Batch | Decisions | Counter change on `run.backfill` (Undo reverses) |
| --- | --- | --- |
| 2,140 possible duplicates | *Keep the published ones* (declined) · *Publish them too* | Decline: review −n, declined +n · Approve: review −n, published +n, topics.filed +n |
| 610 with personal data | *Keep unpublished* · *Publish anyway…* (dialog naming who would see them; still has Undo) | as above |
| 200 possible new versions | *Publish as new versions* (replace current) · *Keep current versions* | Replace: review −n, published +n (no topic count, so published ends slightly above the topic sum) · Keep: declined |

**Topics → Suggestions → Topics to confirm** is for editors and admins of the group's collection; its count is every document in open groups, including no topic.

| Card | Shows | Actions | Counter change |
| --- | --- | --- | --- |
| Topic group (Cards & disputes 940, Reconciliation 520, Payments & settlement 400) | Topic, code, domain, count, matched keywords, sample disclosure | *Confirm topic* (secondary) · ⋯ → *Move to another topic…* (same domain first), *Edit topic keywords…* (admins) | topics.confirm −n, topics.filed +n |
| No topic (3,810) | The assistant's recurring themes with keywords (Merchant onboarding 1,240, Branch operations 980) | *Create topic & tag* (workspace admins): creates the topic under Banking Operations with the next free code and the keywords, or reuses one of that name; then *N still without a topic — add keywords in Topics* | topics.none −n, topics.filed +n |

Every decision writes an audit entry, toasts with Undo, opens the next entry and updates the same counters everywhere (Sources row, run drawer, Review and Suggestions, Knowledge health, and All's counted row for the sync). A topic created this way shows *Unused* in Topics, because usage counts real documents.

### 4. After the first sync

Scheduled syncs read only changes and process what they bring in. A changed file that is already published becomes a *new version* (held only under *Review everything*, or when flagged); a changed file that isn't re-synced shows Outdated in Issues. Quality and Suggestions keep the long tail healthy: re-verification, missing details, duplicates, topics to confirm — and reviewers' corrections keep the topics improving.

## Decisions and why

| Decision | Why |
| --- | --- |
| Collections, Sources and Connections fold into Knowledge Studio | They are steps of one flow. One place, one badge, no alert that points elsewhere for its fix |
| Setup is ordered Collections → Topics → Sources | That is the dependency order: destination and access first, filing scheme second, intake last |
| Accounts are a view of Sources | An account only matters as what a source signs in with; it is created in the wizard and fixed from its sources' rows |
| A third policy, *Review only what's uncertain* | Reviewing 100,000 files one by one is impossible; publishing them all unchecked leaks personal data and duplicates. Holding only risky files, in batches, is both safe and finishable |
| Classification never blocks publishing | A wrong topic misfiles a document; it doesn't expose it. Access comes from the collection, so filing can be fixed afterwards, in bulk |
| One source → one collection; the AI never places documents | Placement is access. Mixing audiences in one source would make the assistant an access-control system |
| **Documents** (All · Review · Issues · Quality) and **Topics** (Topics · Suggestions) instead of a pipeline page with modes and a stage bar | Names follow domain resources. A stage bar mixed two axes (publication and processing); two independent states, each with its own column and pills, say where a document is without implying an order |
| Review and Issues count; Quality and Suggestions don't block | Review and Issues keep documents from people; Quality and Suggestions never hold anything back. Batches sit with submissions in Review because both are publish decisions |
| Processing is explicit (the Process dialog, *Process it now*, a row's fix, a sync) | Nothing is processed on upload (`item_model.md`). With 1,000+ documents an admin chooses what to spend processing on, sees the estimate first and can stop |
| Classify once per document, at processing time (`document_profile.md`) | One model call per document, not per passage; its type and summary give every passage context (`<document_profile>` in `contextual_rag.md`) |
| Topics live in the index's metadata, never in passage text | Re-classifying after a rule change is a metadata update, not a re-index: the rules can improve every week at no indexing cost |
| *Process it now* on approval, on by default (reverses C1 "index before review") | Approval never starts processing by itself, as in the backend; the default keeps one-step publishing for the common case while leaving the choice visible |
| Corrections are suggestions, not rules | A reviewer's change fixes one document; a keyword changes thousands. Only workspace admins change the rules, with the effect stated and Undo |
| Batches by reason (Held back by a sync) and groups by topic (Topics to confirm) | Each answers one question with one decision; a sample makes the decision trustworthy |
| Folders are the collection's structure, managed in Contents | Collections and folders are one Item hierarchy (`item_model.md`); the tree people browse on Home is the tree editors manage, so there is no second "organisation" concept to keep in sync |
| A folder's own access replaces, never adds to, what's above it | That is the backend's `inheritAccess = false`. The UI states it where it's set and wherever access is shown, so nobody reads a collection grant as reaching into a restricted folder |
| Removing a folder keeps its documents | Deleting documents with a folder is irreversible and surprising; moving them up is what people expect, with Undo. Losing a folder's own access is the only risk, so that case asks first |

## Backend alignment and open decisions

- **Matches `backend/docs_design`:** Source → one target collection; `publishingPolicy` per source; nothing is processed on upload and ingestion runs are explicit, recording tasks per item with error classes; `indexingState` (PENDING / RUNNING / SUCCEEDED / FAILED / OUTDATED / UNSUPPORTED) is the processing state, independent of `publicationState`; approval never starts ingestion; topics are a two-level taxonomy; contextual chunk descriptions (`contextual_rag.md`) are generated per passage.
- **In the contract (`CreateIngestionRun`):** the Process dialog sends `selector {items[] | filter}` — *Select all matching* sends the ListItems filter the list shows — and `classification {topics[], note}` (empty topics = all); runs never publish; Stop is `:cancel` (what's done stays processed, the rest returns to PENDING); *Process again* is `:retry`, which keeps the classification; *Approve and process* is ApproveContribution, then CreateIngestionRun with the document in `items[]`. The CLASSIFYING step runs inside contextual retrieval (`BOMESH_CONTEXTUALIZATION_MODEL`, `document_profile.md`): rules first, else one model call that picks topics and writes a summary; **no threshold**, assistant-applied topics are `item_topics` rows without a creator (never in the index), people's topics are never replaced.
- **In the contract (Topics, `api_design.md` §5):** a topic's `keywords[]`, `synonyms[]`, `guidance`, `examples[]` (≤ 5 documents) and `rules[]` (`{collection}` subtree or `{source}`; a matching rule settles the topic without the model); `document.assistantTopics[]` (the *Assistant* label; the rest of `document.topics` is *Set by a person*); ListItems `NOT document.topics:*` (*Without a topic*) and `document.assistantTopics:"…"`; *Topics to confirm* → `topics/{topic}:confirmAssignments {filter}`; *Keywords from reviewers' corrections* → `topicCorrections` (List with `state`/`toTopics:`, `:dismiss`), recorded by ApproveContribution `recordCorrection` (the *Use my change to improve classification* checkbox) and by Edit details replacing the assistant's topics — phrase aggregation stays in the client; Import → `topics:import {rows[], mode MERGE|REPLACE, validateOnly}` (the client parses CSV/XLSX and exports from ListTopics); *Test classification* → `topics:testClassification` (unsaved changes as `topics[]`); *Show the classification prompt* → `topics:compileClassificationPrompt`.
- **Needs backend design** (the prototype doesn't change `backend/docs_design`):
  - **Classification output** beyond topics and summary: type, proposed topic and risk flags.
  - Rules beyond a collection subtree or a source (folder-path or file-type rules) are out of scope by decision: the preview and the contract have only these two kinds.
  - **No processing-state counts** (decided): the backend has no per-`indexingState` aggregation, so All's pills and *Select all matching* carry no numbers, and the Process dialog says "Process the matching documents" for an all-matching selection ("Process N documents" only for checked rows). The processing strip keeps the run's own counts, which the run exposes.
  - `publishingPolicy` gains `REVIEW_EXCEPTIONS` (*Review only what's uncertain*): publish unless a risk flag is raised; flagged files open SOURCE contributions.
  - Source filters (file types, excluded paths, modified-since) and a validate-only estimate (`sources:estimate` or `validateOnly` on CreateSource).
  - Run stage counters at scale (found, filtered by reason, read, classified, indexed, published, held, declined) and error classes with counts; pause/resume of a run.
  - Held batches: grouping open SOURCE contributions of one run by flag, with bulk approve/reject (`contributions:batchApprove`-style custom methods).
  - Moving a first sync's topic group to another topic in bulk; proposals derived from untagged clusters.
  - Contributor-confirmed metadata on `CreateContribution`: the chosen collection plus the confirmed type, topics and summary (`confirmed`, `kbBy: CONTRIBUTOR`), so review shows what the contributor confirmed rather than re-running suggestions.
  - Studio aggregation: counts per Documents view and Quality part and per Suggestions group, for the caller's collections — for the tabs, the badge and Overview → Knowledge health — one endpoint instead of client-side counting (not per processing state; see above).
  - Linked documents on a collection (`item_links`) surfaced as a per-collection count.
  - Folder fields the UI uses beyond the hierarchy: a folder's `description` and `level` (Kind) and its sibling `order` (already listed for Home); `inheritAccess = false` with its own IAM policy is in the design.
