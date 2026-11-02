'use strict';
/* Contribution seeds: submissions in every lifecycle stage for both workspaces, plus
   per-source publishing policy. Assistant suggestions (type, topics, proposed topics,
   flags) are not seeded — core/lifecycle.js computes them from the same rules it uses
   for new uploads. Loaded after data/knowledge.js. Finx records are fictional demo data. */

(() => {
  const P = (d, h = 0) => NOW - d * DAY - h * HOUR;
  const ev = (at, by, kind, text = '') => ({ at, by, kind, text });
  /** A contributed document: stage, contributor, target base and its history. */
  function sub(kb, id, name, by, at, { stage = 'review', note = '', events = [], status = 'pending', versionOf, via, source, kind, topics, summary, views, ...o } = {}) {
    const d = mkDoc(kb, id, name, { addedBy: actorName(by) || 'Sync', updated: events.length ? events.at(-1).at : at, status, source: source || 'upload', ...o });
    Object.assign(d, Object.fromEntries(Object.entries({ kind, topics, summary, views }).filter(([, v]) => v !== undefined)));
    d.stage = stage;
    d.submission = { by, at, note, kbBy: 'contributor', ...(versionOf ? { versionOf } : {}), ...(via ? { via } : {}), events: [ev(at, by, 'submitted', note), ...events] };
    if (stage === 'published' && !o.passages) d.passages = 40;
    D.docs.push(d);
    return d;
  }

  seedWorkspace('ws-finx', () => {
    const HA = 'u-fx-ha', LAN = 'u-fx-lan', BAO = 'u-fx-bao', KHOA = 'u-fx-khoa';
    // In review — each base's owners see their part of the queue (Hà: engineering + payments, Bảo: data, Lan: everything).
    sub('kb-fx-eng', 'fx-sub-1', 'Kafka consumer retry guide.md', KHOA, P(0, 5), { note: 'How we retry and dead-letter failed messages in the payments consumers. Others keep asking in #eng-help.', pages: 4 });
    sub('kb-fx-pay', 'fx-sub-2', 'Runbook — Card authorization latency.md', 'u-fx-huy', P(1, 2), { note: 'Written after last week’s page. Covers acquirer latency vs our own gateway latency.', pages: 3 });
    sub('kb-fx-data', 'fx-sub-3', 'dbt style guide v2.md', 'u-fx-tuan', P(0, 20), { note: 'Updated naming for marts and the new test conventions.', pages: 5 });
    sub('kb-fx-ops', 'fx-sub-4', 'Chargeback procedure — 2027 update.pdf', 'u-fx-ngoc', P(0, 3), { versionOf: 'fx-ops-dispute', note: 'New scheme timelines from January 2027. Replaces the current dispute procedure.', pages: 5 });
    sub('kb-fx-ops', 'fx-sub-5', 'Customer complaint export — October.xlsx', 'u-fx-linh', P(2, 1), { note: 'Raw customer export from the complaints tool, for the monthly SBV complaint report.', pages: 1 });
    sub('kb-fx-prod', 'fx-sub-6', 'Open banking partner API brief.pdf', 'u-fx-thao', P(1, 4), { note: 'What partners will need from our open banking APIs in 2027.', pages: 8 });
    sub('kb-fx-sec', 'fx-sub-7', 'GenAI acceptable use guideline — draft.docx', 'u-fx-son', P(3, 2), { note: 'Draft rules for using GenAI assistants with company data.', pages: 4 });
    sub('kb-fx-pay', 'fx-sub-8', 'Runbook — Payout reconciliation mismatches.md', null, P(0, 2), { via: 'sync', source: 'src-fx-pay', pages: 2, size: 14e3 });
    sub('kb-fx-pol', 'fx-sub-9', 'SRE on-call allowance guideline.pdf', 'u-fx-nam', P(1, 6), { note: 'Agreed with People & Culture last month; SREs keep asking where it is written down.', pages: 2 });
    // The engineer's own contributions in other stages.
    sub('kb-fx-eng', 'fx-sub-10', 'Local dev with Docker Compose — tips.md', KHOA, P(4), {
      stage: 'changes', pages: 3,
      note: 'Shortcuts I use to run the payments stack locally.',
      events: [ev(P(2, 3), HA, 'changes', 'Thanks Khoa — useful. Please remove the staging database hostnames and the sample .env with real keys, then resubmit.')],
    });
    sub('kb-fx-pay', 'fx-sub-11', 'Payments API v3 — Postman collection guide.md', KHOA, P(21), {
      stage: 'published', status: 'ready', pages: 2, topics: ['t-api', 't-payments'], kind: 'guide', views: 188,
      summary: 'Import the Payments API v3 collection, set up sandbox keys and run the idempotency examples.',
      events: [ev(P(19), HA, 'approved', 'Great — linked it from the API reference.')],
    });
    sub('kb-fx-eng', 'fx-sub-12', 'Confluent Cloud pricing screenshots.zip', KHOA, P(12), {
      stage: 'rejected', pages: 1,
      events: [ev(P(11), HA, 'rejected', 'Vendor pricing under NDA can’t be shared workspace-wide. Add the numbers to the streaming evaluation in the CBM space instead.')],
    });
    sub('kb-fx-ops', 'fx-sub-13', 'Card scheme fee table 2027 (protected).xlsx', 'u-fx-ngoc', P(1, 8), {
      stage: 'published', status: 'failed', pages: 1, kind: 'sheet', topics: ['t-cards', 't-pricing'],
      error: 'This spreadsheet is password-protected, so it can’t be read. Upload a copy without a password.',
      events: [ev(P(0, 6), LAN, 'approved')],
    });
    sub('kb-fx-data', 'fx-sub-14', 'Fraud features — data lineage.md', BAO, P(9), {
      stage: 'published', status: 'ready', pages: 3, topics: ['t-models', 't-datagov'], kind: 'spec', views: 64,
      summary: 'Where each fraud model v2 feature comes from, with table, refresh time and masking.',
      events: [ev(P(9), BAO, 'approved')],
    });
    // Sources decide whether synced files publish directly (trusted systems) or wait for review: repository docs go through review.
    D.sources.forEach(s => { s.publish = s.id === 'src-fx-pay' ? 'review' : 'auto'; });
    D.topicProposals = [];
  });

  seedWorkspace('ws-northwind', () => {
    const MINH = 'u-minh';
    sub('kb-sales', 'd-sub-1', 'Acme QBR deck — Q3.pptx', MINH, P(0, 4), { note: 'Reusable structure for quarterly business reviews; customer names removed.', pages: 18 });
    sub('kb-hr', 'd-sub-2', 'Expense tips for new joiners.docx', MINH, P(5), {
      stage: 'changes', pages: 3,
      events: [ev(P(3), 'u-an', 'changes', 'Two tips contradict the Travel & Expense Policy (receipts are needed for anything over USD 25). Please align them with section 5 and resubmit.')],
    });
    sub('kb-product', 'd-sub-3', 'Customer onboarding FAQ.docx', MINH, P(30), {
      stage: 'published', status: 'ready', pages: 4, topics: ['t-admin'], kind: 'faq', views: 96,
      summary: 'Answers to the twelve questions new customers ask most in their first month.',
      events: [ev(P(28), 'u-ben', 'approved')],
    });
    sub('kb-hr', 'd-sub-4', 'Remote work stipend FAQ.docx', 'u-chi', P(1), { note: 'Collected from questions in #people-help.', pages: 3 });
    sub('kb-sales', 'd-sub-5', 'Procurement questionnaire answers 2026.xlsx', 'u-priya', P(2), { note: 'Updated answers after the SOC 2 renewal.', pages: 1 });
    sub('kb-product', 'd-sub-6', 'Sustainability report 2025.pdf', 'u-ben', P(0, 8), { note: 'Customers ask for it in RFPs.', pages: 22 });
    sub('kb-hr', 'd-sub-7', 'Hybrid work guidelines — draft.docx', 'u-tuan', P(0, 30), { note: 'Draft from the leadership offsite.', pages: 5 });
    D.sources.forEach(s => { s.publish = 'auto'; });
    D.topicProposals = [];
  });
})();
