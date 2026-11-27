# Finx Workspace

The demo workspace that shows BoMesh as a company's central knowledge platform. Finx is a fictional Vietnamese digital-banking and payments technology company with about 1,800 people. It runs a payments gateway (cards, NAPAS 247 interbank transfers, QR), a core-banking modernization program, a data platform (fraud and credit models, regulatory reporting) and banking operations (settlement, reconciliation, disputes, KYC). It is regulated by the State Bank of Vietnam and PCI DSS certified.

**BoMesh** is the product; **Finx Workspace** is one workspace in it. Every Finx person, document and policy is fictional, and the product marks it *Demo data* (`ws.demo`). It replaced the earlier UTE Campus demo; the Campus template remains available in Settings → Workspace setup without demo data.

## Configuration

| Setting | Value | Why |
| --- | --- | --- |
| Template | Enterprise | Company knowledge with governed sources and access |
| Modules | Spaces, Work, Requests on | Teams and programs work in spaces; reviews and drafts are AI workflows; IT and compliance run service queues |
| Space types | Team, Project, Office | Payments Platform and Data Platform (teams), Core Banking Modernization (project), IT Service Desk and Risk & Compliance (offices) |
| Workflows | Evidence review, Draft a document | Compare vendors and options with cited evidence; draft decision records and summaries from sources |

## People (prototype bar → Finx)

| Persona | Person | Signs in as | Sees |
| --- | --- | --- | --- |
| Engineer | Trần Minh Khoa, Backend Engineer · Payments Platform | khoa.tran@finx.vn | Workspace: Home, Knowledge, New chat, Work, Requests · Your work: Recent, Projects, Spaces (Payments / Data / CBM), My contributions · Manage: Knowledge Studio → Collections as an editor of Payments Platform (only section, so no sub-rows; the page is titled "Collections"); contributes; has Secure coding and Data privacy training |
| Lead | Lê Thu Hà, Engineering Manager · Payments Platform | ha.le@finx.vn | + Manage › Knowledge Studio (Documents: All · Processing · Review; Collections; Classification → Suggestions) for Engineering Handbook & Architecture and Payments Platform |
| Analyst | Phạm Quốc Bảo, Senior Data Analyst · Data Platform | bao.pham@finx.vn | + Manage › Knowledge Studio (Documents: All · Processing · Review; Collections; Classification → Suggestions) for Data Platform & Analytics; no Secure coding training, so production access is blocked |
| Admin | Võ Thị Lan, Knowledge & Compliance Lead | lan.vo@finx.vn | Everything: Manage (Overview · Knowledge Studio 14 · People · Assistant · Activity · Settings), every Studio section and view including Classification (the *Subject* scheme), Risk & Compliance queue |

Password `demo`. Platform operator Alex Rivera can also open Finx.

## Knowledge

| Collection | Owner unit | Access | Source |
| --- | --- | --- | --- |
| Engineering Handbook & Architecture | Platform Engineering | Everyone | Confluence |
| Payments Platform | Payments Platform | Restricted (team) | GitHub (review before publishing) |
| Data Platform & Analytics | Data Platform | Everyone | Confluence |
| Banking Operations | Banking Operations | Everyone | SharePoint |
| Security & Compliance | Risk & Compliance | Everyone | SharePoint |
| Product & Business | Product | Everyone | Google Drive |
| Internal Policies & Guidelines | People & Culture | Everyone | SharePoint |
| Leadership & Finance | Finance | Restricted; locked for the Engineer, hidden from the Analyst | Uploads |

Finx classifies by one scheme, *Subject*. Its six top concepts are Engineering & Architecture, Data Platform & Analytics, Banking Operations, Security & Compliance, Product & Business, and Internal Policies & Guidelines. They hold 27 narrower concepts, such as Architecture decisions, Reliability & on-call, Metrics & definitions, Payments & settlement, PCI DSS, SBV regulations, Roadmap & strategy and Hybrid work. Every concept has labels; ten also have a definition, alternative labels and examples, and four have rules (Cards & disputes: documents in "Chargebacks"; PCI DSS: documents in "PCI DSS assessment"; Architecture decisions: documents in "Architecture decisions"; incidents: documents in "Postmortems"). Lan last imported them from `finx-master-data-2026-10.xlsx`.

There are about 250 documents. They include 34 ADRs, runbooks, API references, postmortems, data tables and metric definitions, operations procedures, control descriptions, SBV and PCI DSS summaries, product briefs, partner guides and HR/IT policies. Nine titles are in Vietnamese, some verifications have expired, and there are three duplicate pairs. Beside them, Banking Operations › *Archive upload 2016–2025* holds a bulk upload of 1,200 scanned operations records (daily reconciliation reports, settlement statements, chargeback case files…), all Unpublished and Not processed, so the admin chooses which to process.

Key documents have written text, parsed like every document into blocks; chats and request checks quote them word for word, so each citation points at real blocks. Examples: Access Control Policy, Incident Response Plan, Customer Data Protection Standard, Payment Cut-off Times & Settlement Windows, ADR-031 Idempotency keys, ADR-027 Event-driven ledger updates, Runbook — Payment gateway timeouts, Metric definitions — Active customers, Product roadmap H1 2027 and Hybrid Work Policy.

The contribution queue has 9 items. They include a new version of the chargeback procedure, a dbt style guide flagged as a duplicate, a complaint export flagged for personal data, and one GitHub file synced into review. The Engineer also has a changes-requested, a published and a declined contribution, and there's one approved file that couldn't be published because it is password-protected.

## Journeys

1. **Engineer, first minute.** The product tour walks Home once (the Ask box, Picked for you, Explore by domain, New chat and its Recent list, Search). Home offers the engineer's starters, picks documents with the reason (a starter's answer, a subject they read, most read) and lays out the six Subject top concepts with their largest narrower concepts; Knowledge › Map draws the collections as a tree. New chat → "How do I get production access?" and the cited answer quotes the Access Control Policy; a citation opens the document preview on the policy's Original with the cited passage boxed on its page. *Request production access* opens the IT Service Desk request, which checks the Secure coding training and the 8-hour limit before sending.
2. **Engineer, on call.** Search "gateway timeouts" → *Runbook — Payment gateway timeouts* in the preview → *Open full document* → Reader with Ask beside it → *Save* it, so it is in Knowledge → Saved for the next shift.
3. **Engineer, contributing.** Contribute a Kafka consumer retry guide to a collection: Analyzing, then Check the details (concepts with evidence, Payments Platform and who will see it, summary) → Submit for review. Track it in Your work → My contributions (stepper). Fix the contribution the lead sent back with changes requested, then resubmit; the declined one shows the reviewer's reason.
4. **Lead.** Processes new Payments and Engineering contributions in Knowledge Studio → Documents → Processing (submissions first), then reviews them in Review, where the Classification card shows what the assistant classified while processing (and what the contributor confirmed) and why each concept matched; when she moves a concept, the change is recorded as a correction, and repeated corrections surface as a label proposal in Classification → Suggestions → Learned from edits; approving publishes the already-processed document. Compares Confluent Cloud, Pulsar and MSK in the *Event streaming platform — evaluation* evidence review (every cell cited, evidence in a side panel), drafts a decision record from it and approves teammates' drafts sent for review. Curates the on-call kit on its page (name, description and who can see it in place; *Edit items* for order and notes) and decides access requests to Payments Platform in the collection's Access requests section.
5. **Analyst.** Explores Data Platform & Analytics → Metrics & definitions. Asks how a monthly active customer is defined (*Ask about this document* → the Reader's Ask panel). A production access request is blocked because the training is missing, and the check says how to fix it. The PII access request goes to Risk & Compliance.
6. **Admin.**
   - Publishes the chargeback procedure update as a new version.
   - Accepts the proposed *Merchant onboarding* / *Branch operations* concepts (clustered from the first sync's unclassified pool) in Classification → Suggestions → New concept proposals (each becomes a Draft in the Subject tree), or rejects them; *Publish (k changes)* makes them usable.
   - Follows every document from upload to searchable: Documents → All (Processing state and Publication columns), then a document's steps (Received · Processed · Reviewed · Published · Searchable) in its drawer.
   - Chooses which of the 1,200 uploaded documents to process: Documents → Processing → *Not processed*, narrows by Collection or a year, *Select all matching*, **Process** → the Process dialog (*Process the matching documents*) → the processing strip (Show them, Stop); failures stay in Processing as Failed.
   - Teaches classification from reviewers' corrections: three seeded corrections moved Vietnamese reconciliation files from *Payments & settlement* to *Reconciliation*. Classification → **Suggestions** → *Learned from edits* offers the label *đối soát* for *Reconciliation*; accepting it and publishing the scheme classifies the affected documents again and re-files *Bảng đối soát quyết toán NAPAS tháng 10.xlsx* under Reconciliation (the publish dialog's impact: M documents classified again, no re-indexing). *See how the assistant classifies* sits in the Subject scheme's ⋯.
   - Fixes the password-protected file (Open source, then sync again).
   - Starts from Overview → Knowledge health, whose metrics open their views: processes the updates of documents changed at the source (Documents → Processing), keeps policies verified (Documents → All → Quality → Re-verification due), works the Risk & Compliance queue (the space opens on it) and its request types, and closes knowledge gaps from Overview.
   - Watches the 100,000-file first sync of **Operations archive** (SharePoint → Banking Operations, *Review only what's uncertain*): Knowledge Studio → Sources shows *First sync 61k/96k*; the run drawer (`run-fx-419`) shows what it read, classified and indexed, its issues and classification split, and Documents → All shows the sync as one counted row. She decides the three batches (2,140 duplicates, 610 personal data, 200 new versions) in Documents → Review → *Held back by a sync* and the labels awaiting review in Classification → Suggestions → *Labels awaiting review*. Full walkthrough: [KNOWLEDGE_STUDIO.md](KNOWLEDGE_STUDIO.md#the-100000-document-walkthrough).

   Who sees it: only the Admin. Sources needs `source.manage`, and the batches and assignment groups belong to Banking Operations, which Lan owns (workspace admins own every collection); the Lead and Analyst see neither, and the Lead's badge counts only her own collections' decisions.

Every journey is in the prototype bar under **Journeys** (Finx).

## Data files

- `scripts/data/finx.js`: people, workspace, collections, key documents, sources, spaces, events, work, requests, conversations, assistant.
- Finx sections of `scripts/data/knowledge.js`: the Subject scheme and its concepts (labels, definitions, examples and rules; one import), metadata, catalog, the 1,200-document *Archive upload 2016–2025* (`seedBulkUpload`), saved/recent/views and reviewers' corrections (`D.reviewCorrections`, which become label proposals in Classification → Suggestions → Learned from edits).
- Finx sections of `scripts/data/contributions.js`: lifecycle seeds.
- Document text and its Structured Document mock (blocks, chunks and where each is in the Original) in `scripts/features/documents.js`; citations in `content.js`; Finx chat answers in `chat.js`; review evidence in `work-research.js`.
