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
| Engineer | Trần Minh Khoa, Backend Engineer · Payments Platform | khoa.tran@finx.vn | Home, Knowledge, Work, Requests, Payments / Data / CBM spaces; contributes; has Secure coding and Data privacy training |
| Lead | Lê Thu Hà, Engineering Manager · Payments Platform | ha.le@finx.vn | + reviews contributions to Engineering Handbook & Architecture and Payments Platform |
| Analyst | Phạm Quốc Bảo, Senior Data Analyst · Data Platform | bao.pham@finx.vn | + reviews Data Platform & Analytics; no Secure coding training, so production access is blocked |
| Admin | Võ Thị Lan, Knowledge & Compliance Lead | lan.vo@finx.vn | Everything: Manage, Documents (all bases), taxonomy, Featured on Home, Risk & Compliance queue |

Password `demo`. Platform operator Alex Rivera can also open Finx.

## Knowledge

| Knowledge base | Owner unit | Access | Source |
| --- | --- | --- | --- |
| Engineering Handbook & Architecture | Platform Engineering | Everyone | Confluence |
| Payments Platform | Payments Platform | Restricted (team) | GitHub (review before publishing) |
| Data Platform & Analytics | Data Platform | Everyone | Confluence |
| Banking Operations | Banking Operations | Everyone | SharePoint |
| Security & Compliance | Risk & Compliance | Everyone | SharePoint |
| Product & Business | Product | Everyone | Google Drive |
| Internal Policies & Guidelines | People & Culture | Everyone | SharePoint |
| Leadership & Finance | Finance | Restricted; locked for the Engineer, hidden from the Analyst | Uploads |

The six topic domains in the taxonomy are Engineering & Architecture, Data Platform & Analytics, Banking Operations, Security & Compliance, Product & Business, and Internal Policies & Guidelines. They hold 27 topics, such as Architecture decisions, Reliability & on-call, Metrics & definitions, Payments & settlement, PCI DSS, SBV regulations, Roadmap & strategy and Hybrid work.

There are about 250 documents. They include 34 ADRs, runbooks, API references, postmortems, data tables and metric definitions, operations procedures, control descriptions, SBV and PCI DSS summaries, product briefs, partner guides and HR/IT policies. Nine titles are in Vietnamese, some verifications have expired, and there are three duplicate pairs.

Key documents have written renditions; chats and request checks quote them word for word. Examples: Access Control Policy, Incident Response Plan, Customer Data Protection Standard, Payment Cut-off Times & Settlement Windows, ADR-031 Idempotency keys, ADR-027 Event-driven ledger updates, Runbook — Payment gateway timeouts, Metric definitions — Active customers, Product roadmap H1 2027 and Hybrid Work Policy.

Collections: New joiner essentials (everyone), Payments on-call kit (Payments Platform), CBM architecture reading (Core Banking Modernization), PCI DSS audit evidence (Risk & Compliance), Fraud model review pack (private).

The contribution queue has 9 items. Two of them propose new topics: *Open banking* and *AI governance*. Others include a new version of the chargeback procedure, a dbt style guide flagged as a duplicate, a complaint export flagged for personal data, and one GitHub file synced into review. The Engineer also has a changes-requested, a published and a declined contribution, and there's one approved file that couldn't be published because it is password-protected.

## Journeys

1. **Engineer, first minute.** Home shows what Finx knows ("227 published documents in 7 knowledge bases"), the six domains, featured trusted documents with real thumbnails, and where Khoa left off. Ask "How do I get production access?" and the cited answer quotes the Access Control Policy. *Request production access* opens the IT Service Desk request, which checks the Secure coding training and the 8-hour limit before sending.
2. **Engineer, on call.** Home → Featured *Runbook — Payment gateway timeouts* → Reader with Ask beside it → Payments on-call kit collection.
3. **Engineer, contributing.** Contribute a Kafka consumer retry guide; it goes into review. Fix the contribution the lead sent back with changes requested, then resubmit.
4. **Lead.** Reviews Payments and Engineering contributions in Manage → Documents. Compares Confluent Cloud, Pulsar and MSK in the *Event streaming platform — evaluation* review (every cell cited). Curates the on-call kit.
5. **Analyst.** Explores Data Platform & Analytics → Metrics & definitions. Asks how a monthly active customer is defined. A production access request is blocked because the training is missing, and the check says how to fix it. The PII access request goes to Risk & Compliance.
6. **Admin.**
   - Features documents on Home.
   - Publishes the chargeback procedure update as a new version.
   - Accepts or merges the proposed *Open banking* / *AI governance* topics.
   - Fixes the password-protected file.
   - Keeps policies verified, works the Risk & Compliance queue, and closes knowledge gaps from Overview.

Every journey is in the prototype bar under **Journeys** (Finx).

## Data files

- `scripts/data/finx.js`: people, workspace, bases, key documents, sources, spaces, events, work, requests, conversations, assistant.
- Finx sections of `scripts/data/knowledge.js`: taxonomy, metadata, catalog, collections, saved/recent/views, featured.
- Finx sections of `scripts/data/contributions.js`: lifecycle seeds.
- Renditions in `scripts/features/documents.js`; Finx chat answers in `chat.js`; review evidence in `work-research.js`.
