# Document lifecycle: contribute → review → publish · process

How a document becomes trusted knowledge in BoMesh. This extends the Knowledge Hub ([KNOWLEDGE_HUB.md](KNOWLEDGE_HUB.md)): the Hub is where people *use* published knowledge. This document owns the **per-document lifecycle** — contribute, review, publish, process, every state and label, the Review inspector's Classification fields, the drawer's steps and the workspace's topics. The Knowledge Studio as a whole (Manage IA, Documents with All · Review · Issues · Quality, Topics with Topics · Suggestions, the Process dialog, setup order, sources and their publishing policies, first sync at scale) is in [KNOWLEDGE_STUDIO.md](KNOWLEDGE_STUDIO.md).

## Principles

1. **Sharing is easy, publishing is deliberate.** Contributing takes a file, a destination (*Contribute to a collection* or *Upload to My files*) and a check of what the assistant read. Nothing anyone contributes reaches search, the Reader, reading lists or the assistant until a reviewer approves it.
2. **Three steps, three places.** Contribute in **Knowledge** and track in **Your work → My contributions** (contributors). Set up, review, publish and process in **Manage › Knowledge Studio** (collection owners, source admins and workspace admins). Operate indexing in the **Platform console → Indexing** (platform admins). No screen mixes two of these jobs.
3. **Publishing and processing are separate.** Publication decides who may see a document; processing (read → classify → index) decides whether search and the assistant can use it. Uploading processes nothing; processing happens only in an explicit run someone starts. A document is searchable only when it is published **and** processed.
4. **The assistant does the busywork; people decide.** When a document is contributed it suggests a type, topics (existing ones, or a proposed new one) with the evidence for each, the collection and a summary, and flags likely duplicates, new versions, personal data and unsearchable formats. The contributor confirms or edits before submitting; reviewers check and publish, and their topic changes are recorded as corrections that become suggestions. Only workspace admins change the topics.
5. **Plain words.** People see *In review, Changes requested, Declined, Approve & publish, Published, Unpublished*, and processing states *Not processed, Processing, Processed, Failed, Outdated, Not supported*. Terms like "embedding" appear only in the platform console.
6. **Access never widens by accident.** A submission is visible only to its contributor and the reviewers of its target collection. Approving publishes into that collection, so its access rules decide who can read it, and the review screen states who that will be. Platform admins see job metadata, never titles or content.

## Lifecycle

```mermaid
stateDiagram-v2
  [*] --> Analyzing: Contribute to a collection
  Analyzing --> Checking: suggestions ready
  Checking --> InReview: contributor confirms · Submit for review
  InReview --> ChangesRequested: reviewer requests changes
  ChangesRequested --> Analyzing: contributor resubmits (new file or note)
  InReview --> Declined: reviewer declines (reason)
  InReview --> Published: Approve & publish
  InReview --> PublishedAsVersion: approve as new version of an existing document
  Published --> Unpublished: reviewer unpublishes
  Unpublished --> Published: Publish again
  InReview --> Withdrawn: contributor withdraws
```

| Label people see | `stage` | Who sees it | Next step |
| --- | --- | --- | --- |
| Analyzing → Check the details (in the dialog, before submitting) | — | Contributor | Confirm or edit, then Submit for review |
| In review | `review` | Contributor, collection reviewers | Reviewer decides |
| Changes requested | `changes` | Contributor, reviewers | Contributor revises and resubmits |
| Declined | `rejected` | Contributor, reviewers | Contributor reads the reason and removes it (kept for the retention period) |
| Published | `published` | Everyone who can read the collection (searchable once processed) | Use it, or submit a new version |
| Published as new version | `merged` | Contributor | The original now shows the new version |
| Unpublished | `unpublished` | Reviewers | Publish again (Unpublish is immediate with Undo) |

Private files (**My files**, *Upload*) skip review: only their owner can use them. *Share as knowledge…* moves a private file into review for a collection without copying it.

Synced files follow their **source's publishing policy**: *Publish automatically* (trusted systems such as the regulations drive or the LMS; every sync publishes what it found), *Review only what's uncertain* (publishes clean files and holds only files flagged for personal data, a likely duplicate or a likely new version; the default above 1,000 files) or *Review everything* (untrusted or small feeds such as the university website; every new or changed file is a submission, and a changed published file becomes a *new-version* submission while the published copy keeps answering). Policies, their defaults and batches at scale: [KNOWLEDGE_STUDIO.md](KNOWLEDGE_STUDIO.md#configuring-a-source).

## Publication and processing

Every document has two independent states, as in the backend's Item (`backend/docs_design/item_model.md`):

| State | Backend field | Values people see | Changed by |
| --- | --- | --- | --- |
| Publication | `publicationState` (with the review stage) | In review · Changes requested · Published · Unpublished · Declined | Review decisions, a source's publishing policy, Publish / Unpublish |
| Processing | `indexingState` | Not processed · Processing · Processed · Failed · Outdated · Not supported | Explicit ingestion runs only |

Neither implies the other: a published document can be Not processed (people open it from its collection; search and the assistant can't use it), and a processed one can be Unpublished. **Searchable = published and processed.** Submissions aren't processed while they wait. Document status chips (`status('doc')`) use the processing words; the lifecycle chip shows *Not processed*, *Processing*, *Processing failed* or *Changed at the source* for a published document that isn't searchable yet.

### Processing states

| State (`indexingState`) | Meaning | Fix (in Documents) |
| --- | --- | --- |
| Not processed (`PENDING`) | Not read, classified or indexed yet; search and the assistant can't use it | *Process* |
| Processing (`RUNNING`) | Being read, classified against the topics and indexed | — (the processing strip offers Stop) |
| Processed (`SUCCEEDED`) | Read, classified and indexed; searchable once published | *Publish* if unpublished |
| Failed (`FAILED`) | Couldn't be read or indexed; listed in Issues | *Process again*, Replace file (uploads), Open source (password-protected synced files) |
| Outdated (`OUTDATED`) | Changed at the source since it was processed; answers use the previous version; listed in Issues | *Process the update* (re-reads from the source; never a file picker) |
| Not supported (`UNSUPPORTED`) | Images and archives; download only | — |

`PROCESSING` and `processingOf()` in `core/lifecycle.js` hold this vocabulary; `canProcess()` allows a run on published or unpublished documents that aren't running, aren't images or archives, and aren't submissions.

### What starts processing

Processing happens only through an explicit **ingestion run** (`X.processRun` in `features/documents.js`):

- **The Process dialog** over a selection in Documents → All (a page, or *Select all matching*): which topics the AI may suggest (*All topics* | *Selected*) and optional context for the AI, then *Process N documents* for checked rows, or *Process the matching documents* for *Select all matching* (a filter: no number, no time estimate). It never publishes. [Details](KNOWLEDGE_STUDIO.md#processing-a-selection).
- **Approve + optional process.** In Review the decision bar has *Process it now*, **on by default**: approving publishes the document and starts a run for it. Unchecked, it is published but Not processed ("Not processed yet: process it from All when you're ready"). Approval never processes by itself.
- **A row's fix**: *Process*, *Process again*, *Process the update*, from All, Issues or the document drawer.
- **A source's sync**: a sync is that source's explicit run, so it processes what it brings in (clean files under its policy; held files are processed when approved with *Process it now*).

Stopping a run (`X.stopProcessRun`) keeps what's done processed and returns the rest to Not processed.

| Origin | Classified (at processing) | Published |
| --- | --- | --- |
| Member contribution | The assistant's suggestions, confirmed or edited by the contributor; the reviewer checks them in the Review inspector | Documents → Review |
| Source sync, *Review everything* | The assistant's suggestions; the reviewer confirms | Documents → Review |
| Source sync, *Review only what's uncertain* | The pipeline applies its matches; a file with a risk flag is a submission like a contribution | Flagged files in Review (*Held back by a sync*, batches by reason, at first-sync scale); the rest by the policy |
| Source sync, *Publish automatically* | The assistant picks the topics among the candidates and applies them (marked *Assistant*); a document it gives no topic is listed in Topics → Suggestions. No confidence score, no threshold | By the policy: "Not needed: {source} publishes automatically" |
| Editor upload into a collection | The topics its editor gives; otherwise "No topic yet" with *Add topic* | By the editor: "Not needed: added by an editor of the collection" |

**Who sees it after publishing is the collection's audience.** The decision bar says "Publishes to {collection} · {audience}", e.g. "Everyone in Finx Workspace" for a collection whose general access is Everyone. Making a document public to the workspace means publishing it into such a collection; there is no separate visibility flag.

**Review → Classification.** The suggestions sit in one part of the Review inspector, *Classification*. Type, collection (who will see it) and summary carry badges (*Edited* once changed); topics carry no confidence (*New* for an accepted proposal, *Added* for a topic the reviewer added). When the contributor confirmed the details, the part reads "Confirmed by the contributor.", Type and Collection show *Chosen by the contributor* instead of a badge, and each topic's evidence starts "confirmed by the contributor". Under the topic chips, each topic says why it matched (`topicEvidence`): rule: documents in "Chargebacks" · matched "chargeback", "dispute" · synonym · like example "{document}" · the title names it · like "{similar document}" · common in this collection. A proposed new topic adds a quiet note ("You can publish without it.") with *Decide in Topics → Suggestions* for admins, "A workspace admin decides." for reviewers. When the reviewer changes the suggested topics, *Use my change to improve classification* (on by default) appears; approving then records a **correction** (`recordCorrection`) that admins see in Topics → Suggestions, and marks the topics *Set by a person*.

**Document drawer → steps.** Under the lifecycle chip and its one note (the error, or the reviewer's message), a vertical stepper shows **Received · Reviewed · Published · Processed · Searchable**, each done, current, issue, skipped or to do, with one line: who and when ("Contributed by …", "Synced from …", "Uploaded by …"); "Approved by …", "Changes requested by …" or "Not needed: {source} publishes automatically"; "Not processed yet: search and the assistant can't use it", the error, or "Changed at the source · answers use the previous version"; "Searchable · Everyone in …". Publish and Process buttons sit on the step that needs them; Searchable needs both. History is a collapsed disclosure; Details follow.

## Roles and permissions

| Capability | Contributor (`knowledge.contribute`) | Reviewer (Owner of the collection) | Workspace admin (`tenant.manage`, owns every collection) | Platform admin (`platform.*`) |
| --- | --- | --- | --- | --- |
| Read published knowledge | Collections they can read, minus folders with their own access that don't name them | Same | All | Only through workspace membership |
| Contribute, track, revise, withdraw | ✓ (to collections they can read that accept contributions) | ✓ | ✓ | — |
| See a submission | Their own | Submissions to collections they own | All | Never (job metadata only) |
| Open Documents (All · Review · Issues · Quality) | — | Collections they own | All | — |
| Approve & publish, request changes, decline | — | Collections they own | All | — |
| Choose the collection on approval | — | Among collections they own | Any | — |
| Process, process again, unpublish, retry, replace, archive | — | Collections they own | All | Retry jobs (no content) |
| Collections: contents (folders, moving documents), sources (Knowledge Studio → Collections) | — | Collections they own or edit | All | — |
| Collections: access, a folder's own access, settings | — | Collections they own | All | — |
| Topics: import, export, edit topics (codes, keywords, synonyms, examples, guidance, rules); accept, merge or dismiss proposed topics and correction keywords | — | — (sees Suggestions, proposals read-only; the inspector shows "A workspace admin decides"; no Topics view) | ✓ (Topics → Topics and Suggestions) | — |
| Sources, accounts, publishing policy (Knowledge Studio → Sources; `source.manage`) | — | — | ✓ | — |
| Indexing policies, pause/resume a workspace's indexing | — | — | — | ✓ |

Finx: engineers contribute; Lê Thu Hà (Lead) reviews the Payments Platform and Engineering Handbook collections; Phạm Quốc Bảo (Analyst) reviews Data Platform & Analytics; Võ Thị Lan (Admin) reviews everything and owns the topics. Northwind: members contribute; collection owners and the admin review.

## Classification

| Concept | Answers | Example | Who sets it |
| --- | --- | --- | --- |
| Type | What is this file? | Policy, Procedure, Spec, Template | The assistant suggests; the contributor confirms; the reviewer checks. Types are the platform registry, not a topic |
| Topic | What is it about? | Reliability & on-call, Metrics & definitions | Chosen from the workspace's topics. The assistant may *propose* a new topic; workspace admins decide it in Topics → Suggestions. Publishing never waits for that decision |
| Collection | Where does it live, and who can read it? | Payments Platform | The contributor chooses it in *Check the details* (pre-selected when contributing from a collection page, into the folder open there); the reviewer confirms |
| Folder | Where in the collection is it kept? | Runbooks › Gateway & cards | Editors, in the collection's Contents (move documents, make folders). A folder can have its own access, which then decides who reads it instead of the collection |
| Reading list | Which documents belong in a reading list? | Payments on-call kit | Anyone, after publication. It never grants access |

Classification runs **once per document, at processing time**, between reading and indexing (`document_profile.md`); a document that isn't processed isn't classified by the pipeline (a submission carries the assistant's suggestions until then). Its type and summary go into `contextual_rag.md` as a `<document_profile>` block before each passage; topics live only in the index's metadata, so re-classifying never needs re-indexing.

### Topics

The **topics** are the workspace's domain → topic tree — the same topics readers browse as pills — and the signals that recognise each. One set per workspace; only workspace admins see the view (`/studio?tab=topics&view=topics`, selection in `?node=`; older `tab=taxonomy|master` and `mode=rules` addresses are rewritten). Each domain and topic has a **code** (the spreadsheet key, unique per workspace: `OPS`, `OPS-03`; a blank code on a new topic gets the next free one) and a **name**; a topic adds the classification signals below.

- **Job:** the topic tree documents are filed under, and the words that recognise each topic.
- **Layout:** a one-line summary (domains · topics · keywords; last import) whose "n topics without keywords" is a toggle (`?show=bare`: narrows the tree to those topics and opens the first), Export, Template and *Show the classification prompt* under ⋯; a **tree** (topics without keywords or synonyms carry a hollow warning ring; search, collapsible domains with codes and counts, archived last; keyboard navigable) beside the **detail** of the selected node. Without `?node=`, the first domain opens. Phones show the tree first and open a topic full screen with Back.
- **Topic detail:** header (name, code, domain; ⋯ *Edit name, code and domain…*, Archive), then **Keywords & synonyms** ("Words in a title or note that mean a document belongs here.") · Description ("For people choosing a topic.") · Guidance for the assistant ("When to use it, and what belongs elsewhere.") · Rules, optional ("A matching source or folder settles the topic.") · Examples ("Two or three documents that clearly belong here.") · distribution over collections, and a **Test classification** box. Edits go through one save bar (Save · Discard); each topic keeps its own unsaved draft (marked with a dot in the tree), and an untouched draft follows imports and Undo.
- **Archive** applies at once with Undo; a topic still in use isn't disabled — a message says what to retag or move first.
- **No threshold:** classification has no confidence score and no auto-tag setting. The assistant picks a document's topics (at most two) among the candidates; a document it gives none is published without a topic and listed in Topics → Suggestions.
- **Show the classification prompt** (⋯): a drawer with the compiled `document_profile.md` prompt processing sends, the rules checked first, and the `<document_profile>` block; Copy prompt and a token estimate.
- **Suggestions** are not in the tree: topics the assistant proposes ("Accepting adds the topic and tags the documents that mention it."; Accept · Rename · Change domain · Merge into, which adds the proposal's name as a **synonym** of the target · Dismiss, with Undo), keywords from reviewers' corrections, topics to confirm and documents without a topic are in Topics → Suggestions ([details](KNOWLEDGE_STUDIO.md#suggestions)).
- **Re-classification:** saving, importing, or adding a keyword or example re-classifies every open submission's suggestions and re-checks the processed documents the pipeline tagged (people's choices stay); only those whose result changes move. Toast: "… n documents re-checked, n changed topic. No re-indexing needed.", with Undo.
- **Import** (one dialog, two steps): *Import topics* — a drop zone (CSV or Excel; columns `code, name, parent_code, description, keywords, synonyms, guidance`; only code and name required, missing columns are neither compared nor changed), a sample, Download template, and **Add and update** (default) or **Replace** (also archives topics missing from the file; topics in use are kept) → *Check the changes*: skipped rows with reasons, New, Updated (what changed), Archived, Kept, and effects (submissions classified again, published documents re-checked; proposals covered). Applying records the import and an audit event and toasts with Undo. Rules and examples live only in Studio.

### How classification works

Prototype rules, deterministic, in `core/lifecycle.js` (`topicMatches`). Keywords are one signal among several:

| Signal | Effect |
| --- | --- |
| Keywords and synonyms | Matched against the title and note; synonyms count the same as keywords. Distinctive name words count too; words shared by many topics count only with other evidence |
| Rules | Documents in a collection (its whole subtree, folders included) or documents from a connected source (uploads aren't a source, so no source rule matches them). A matching rule settles the topics: the document gets exactly the matching rules' topics and the model isn't asked |
| Examples | Example documents of the topic; a weaker signal when a new title looks like one |
| Similar documents and the collection | Similar published documents contribute their topics; the target collection's usual topics too; with nothing distinctive, the collection's dominant topic at low confidence |
| Guidance | Free text the assistant reads; not used by the matcher |

- Each suggested topic keeps its evidence (rule, keywords, synonyms, example, title, similar document, common in this collection), shown as readable phrases to the contributor and the reviewer. The Test classification box runs the same rules with unsaved changes (a title, plus an optional collection and source to check rules) and lists each matched topic labelled *Rule* or *Assistant* — no scores — saying whether the topic comes 1st, 2nd, 3rd or not at all.
- Documents from auto-publish sources are classified the same way when their sync processes them: the topics the assistant picks are applied as *assistant-applied* (labelled *Assistant*); people's topics are never replaced. A document it gives no topic is listed in Topics → Suggestions → *Without a topic*.
- Proposed topics come from recognisable themes (Open banking, AI governance, Internships, Sustainability, Hybrid work) that have no topic yet. A proposal collects every submission that raised it; admins decide it in Topics → Suggestions.
- Flags (risks render as labelled chips, the rest as small icons with tips):
  - *Possible duplicate*: ≥ 55 % title similarity to a published document.
  - *New version*: the contributor submitted it as one.
  - *Personal data*: CVs, salary documents, customer exports, card numbers, ID documents.
  - *Format*: images and archives can't be searched.

## Journeys

### Contributor
1. **Share.** Knowledge → *Contribute* (or ⌘K, a collection page, My contributions or the Studio's Documents *Add documents*) → *Contribute to a collection* is preselected (or *Upload to My files* to keep it private; that and *Submit a new version* stay one step) → drop files → Continue.
2. **Analyzing.** A visible step: "Reading the file and matching it against {workspace}'s topics…".
3. **Check the details.** Per file: an editable title (it becomes the file name, extension kept), type, topics as removable chips with their evidence plus *Add topic…*, the collection with "{who} will see it once published", a suggested summary ("{Type}: {title}. Covers A, B and C."), personal-data and possible-duplicate warnings, and a note for reviewers. Back keeps your edits. *Submit for review* stores what you confirmed with the submission. Toast: *Submitted for review · Open* → `/contributions?open=id` (a reviewer submitting gets *Review now*).
4. **Track.** Your work → **My contributions** (`/contributions`; header *Contribute*): every submission with its lifecycle label and its latest event in words ("Lê Thu Hà asked for changes · 2 days ago"), *Revise* when changes were requested. Filters: All · Needs your action · In review · Published · Declined (counts only where there are items). A row (or `?open=id`) opens the drawer: a stepper **Submitted → Analyzed → In review → Approved → Published** (no status chip), the reviewer's message as an alert, *What you confirmed*, and a collapsed History. An approved contribution says *Approved · not processed yet*, *being processed* or *processing failed*; its Published step reads "Published · waiting to be processed" until it is. A collapsed Your work group shows a dot when changes are requested; Home's *Needs your attention* shows it too.
5. **Revise.** Inbox → *Changes requested* → the contribution drawer shows the reviewer's message in its alert → attach a revised file and say what changed → *Resubmit*. It goes back to the reviewer, re-analysed. A declined contribution shows the reason the same way, with *Withdraw*.
6. **See it published.** Inbox → *Published* → open it in the Reader. Later, for uploads, ⋯ → *Submit a new version…* sends an update to review while the current version stays published.

### Reviewer (collection owner)
1. **Notice.** The sidebar badge on Manage › Knowledge Studio (Documents' decisions: submissions, batches held back by a sync, issues), an Inbox item and *Needs your attention* on Home say how many documents wait.
2. **Review.** Knowledge Studio → Documents → **Review** is a workbench (list · document · inspector); *Held back by a sync* batches come first, then *Submissions*:
   - Preview of the first page.
   - The contributor's note.
   - The **Classification** fields ("Confirmed by the contributor" when they confirmed it): type, topics with the evidence for each ("matched “chargeback”, “dispute”"), collection with who will see it, summary; a quiet note when it suggests a new topic ("You can publish without it"); labelled risk chips (*Personal data*, *Possible duplicate* with Compare) and other flags (publish as a new version). Changing the topics shows *Use my change to improve classification* (on by default), which records a correction on approval.
   - Decide: *Approve & publish* ("Publishes to {collection} · {audience}"), with *Process it now* (on by default) to process it in the same step — unchecked, it is published but Not processed; *Request changes* (message required, quick replies), or *Decline* (reason required). The next item opens automatically. Undo is always offered. Keyboard: J/K move, Enter opens, **A** approves & publishes, **R** requests changes.
   - Selecting several swaps the decision bar for the floating bulk bar; bulk approve accepts the suggestions, skips anything flagged as personal data and says so. First-sync batches are one decision each: [KNOWLEDGE_STUDIO.md](KNOWLEDGE_STUDIO.md#3-what-people-decide-minutes-not-months).
3. **Fix issues.** Documents → **Issues** lists what couldn't be processed or changed at the source (bulk *Process again*); each row shows its fix — *Process again*, Replace file (uploads), *Process the update* (synced documents changed at the source), or Open source (password-protected synced files). Every row opens the document drawer (chip, one note with the reason and fix, steps, History). Unpublish is immediate with Undo.
4. **Process what's waiting.** Documents → All → *Not processed* → select (or *Select all matching*) → **Process** → the dialog → the processing strip; [the 1,000-document flow](KNOWLEDGE_STUDIO.md#the-1000-document-flow).
5. **Quality.** Documents → **Quality** (`part=reverify|details|duplicates`): Re-verification due (expired or never verified) · Missing details (owner, summary) · Possible duplicates (merge keeps one and repoints reading lists, saved lists and recents). Published documents without a topic are in Topics → **Suggestions**.

### Workspace admin
Everything a reviewer does, across all collections, plus:
- **Import topics** (Northwind journey *Import topics and reclassify submissions*). Topics shows "Not imported yet" → *Import* → drop the spreadsheet (or *Try it with* the sample) → *Add and update* → *Check the changes*: skipped rows with reasons, new and updated topics, "n submissions in review will be classified again" → *Import n changes* → the toast offers Undo; the Review inspector now shows the new matches with their evidence.
- **Decide suggestions** in Topics → Suggestions (accept, rename, change domain, merge or dismiss proposals); in Topics edit a topic's description, keywords, synonyms, rules, examples and guidance and test it before saving; export the topics to edit them in a spreadsheet.
- **Teach classification from reviewers' corrections** (Finx journey of that name). Topics → Suggestions → *Keywords from reviewers' corrections*: "Reviewers moved 3 documents to Reconciliation", *Misled by "napas"* → press the "đối soát" chip → toast "… documents re-checked, 1 document changed topic. No re-indexing needed." with Undo; open the classification prompt to see what processing sends.
- **Choose what to process** (journeys *Choose which of 1,000 digitised records to process*, UTE, and *Choose which of 1,200 uploaded documents to process*, Finx): [KNOWLEDGE_STUDIO.md](KNOWLEDGE_STUDIO.md#the-1000-document-flow).
- **Set up and run sources:** collections → topics → sources in setup order (journey *Finish setting up knowledge*), publishing policies and the first sync at scale: [KNOWLEDGE_STUDIO.md](KNOWLEDGE_STUDIO.md).
- **Overview:** Knowledge health's metrics (Waiting for review · Issues · Not processed · Topic suggestions · Quality · Verified) each link to their view; Needs attention covers sources, accounts, access and requests ([KNOWLEDGE_STUDIO.md](KNOWLEDGE_STUDIO.md#overview--knowledge-health)).

### Platform admin
Platform console → **Indexing**:
- Tabs **Workspaces** (per-workspace queue, throughput, failure rate and status, with Pause/Resume and Retry failed; errors grouped by class) · **Jobs** (id, workspace, file type, size, step, error class: no titles, no content; a job drawer with Retry job) · **Policies**.
- Platform policies: allowed types, max size, OCR for scanned PDFs, spreadsheet parsing, retention of declined submissions. "Uploads need review" is locked on.

## Decisions and why

| Decision | Why |
| --- | --- |
| One **Knowledge Studio** replaces Manage › Documents (and before it Knowledge health and the per-collection inventory); it holds Documents, Collections, Topics and Sources ([why](KNOWLEDGE_STUDIO.md#decisions-and-why)) | Contributions, synced files and uploads land in one place, and reviewers and admins have one place to run them |
| Sections named after resources: **Documents** (All · Review · Issues · Quality) and **Topics** (Topics · Suggestions) ([why](KNOWLEDGE_STUDIO.md#decisions-and-why)) | Names follow domain resources; a workflow page with modes and a stage bar mixed publication and processing in one sequence |
| Publication and processing are two independent states, each with its own column; no stage bar | They change for different reasons and by different people; one bar implied an order that doesn't exist (a published document can be Not processed) |
| Processing is explicit: nothing is processed on upload | Matches the backend (`item_model.md`); with 1,000+ documents an admin chooses what to process, sees the estimate and can stop |
| C1 "index before review" is reversed: approval never processes by itself; *Process it now* is a separate, default-on step | Keeps the backend's two calls visible and avoids processing submissions that may be declined |
| Topics = the topics people browse, each with a code and several classification signals; no separate category concept | One concept, one word: the classification target is exactly what readers see as Browse pills, so a document is never filed under something nobody can browse. Codes key the spreadsheet; keywords, synonyms, rules and examples make classification explainable and testable |
| Reviewers' topic changes are recorded as corrections and suggested to admins, never applied automatically | The people closest to the documents improve the rules; admins stay in charge of what the rules say |
| The contributor checks the details before submitting | The person who knows the file confirms type, topics, collection and summary; reviewers check rather than fill in, and see what was confirmed |
| Audience is the collection's access ("Everyone in {workspace}"), not a new public flag | Access already lives on the collection. A second visibility switch could contradict it; the decision bar states the audience before publishing |
| Documents from auto-publish sources are classified by the assistant, without a threshold | They never pass a reviewer, yet must be findable by topic. The assistant picks topics among the candidates and they're applied as *Assistant* (people's topics stay); there's no confidence score to tune. What it gives no topic waits in Topics → Suggestions |
| Contributions are **My contributions** under Your work, not a Knowledge section | Tracking what you submitted is your work, like Recent and Projects; Saved, My files and My reading lists keep what you saved and own |
| The collection is chosen in *Check the details*, with the assistant's suggestion pre-filled and who will see it | Contributors needn't know the workspace structure, but they see the audience before submitting; reviewers confirm the placement |
| Approval publishes (no separate "Publish" step after approval) | Reviewers think "is this right and should people see it?", which is one decision. Processing is the separate, optional *Process it now* |
| New versions go through review while the current version stays published | Knowledge never disappears during an update; the reviewer approves the change, not the whole document again |
| Topic proposals collect evidence across submissions, need a workspace admin, and never hold publishing back | Prevents topic sprawl; admins see why a topic is wanted before creating it (Topics → Suggestions), and reviewers aren't blocked by a topics decision |
| Personal-data and duplicate flags never block, but bulk approve skips flagged items | Reviewers stay in control; bulk speed never publishes a transcript by accident |
| Platform admins see job metadata only | Operating infrastructure doesn't require reading confidential documents |

## Backend alignment and open decisions

- **Matches `backend/docs_design`:**
  - The Document is created before processing ("adding is not processing").
  - Nothing is processed on upload; ingestion runs are explicit (a selection, *Process it now*, a row's fix, a source's sync), and approval never starts ingestion: *Approve & publish* with *Process it now* is two calls.
  - `publicationState` and `indexingState` (PENDING / RUNNING / SUCCEEDED / FAILED / OUTDATED / UNSUPPORTED) are the Publication and Processing state columns; *OUTDATED* is Outdated in Issues.
  - Who can read a published document is the collection's role assignments (Everyone = `role_assignments.all_members`).
- **Needs backend design:**
  - A review stage on Items (`review | changes | rejected | published | unpublished`) and its events, which are distinct from `status`.
  - Submission visibility (contributor + collection owners) before publication.
  - Stored assistant suggestions, with per-topic evidence (`why`) on ContributionSuggestions.topics.
  - Topic proposals.
  - Topic `code` (unique per workspace) and `keywords[]` (classification hints) on the `topics` resource and table.
  - Topics import and export: a custom method (e.g. `topics:import`, `mode MERGE | REPLACE`) returning an Operation with a validate-only check step; import history (who, when, file, counts) as audit events or a small import record.
  - Classification output beyond topics, topics in index metadata (re-check, not re-index) and classification corrections: [KNOWLEDGE_STUDIO.md](KNOWLEDGE_STUDIO.md#backend-alignment-and-open-decisions). No classification threshold and no processing-state counts (both decided). Ingestion runs over a selection or filter with a classification context, Stop and approve + process are in the contract.
  - Auto-classification of documents from auto-publish sources at processing (assistant-applied topics, flagged as assistant-applied).
  - Topic `synonyms[]`, `rules[]`, `examples[]` and `guidance` ([KNOWLEDGE_STUDIO.md](KNOWLEDGE_STUDIO.md#backend-alignment-and-open-decisions)).
  - Contributor-confirmed metadata on CreateContribution (collection, type, topics, summary), returned to reviewers as confirmed.
  - Re-classification of open contributions when the topics change (refresh `contribution_topics` suggestions).
  - Per-source publishing policy with three values, including `REVIEW_EXCEPTIONS` ([KNOWLEDGE_STUDIO.md](KNOWLEDGE_STUDIO.md#backend-alignment-and-open-decisions)).
  - A platform indexing API that exposes job metadata without content.
