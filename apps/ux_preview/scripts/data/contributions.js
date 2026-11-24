'use strict';
/* Contribution seeds: submissions in every lifecycle stage for both workspaces, plus
   per-source publishing policy. Assistant suggestions (topics, proposed topics,
   flags) are not seeded — core/lifecycle.js computes them from the same rules it uses
   for new uploads. A new document's submission is processed before review: those with
   status 'ready' were (they're in Review, classified by processing); the rest wait in
   Documents → Processing. `classTitle` is the clean name processing wrote for a messy file
   name (aiOf's `title`); the others have none. Loaded after data/knowledge.js. Finx records are fictional demo data. */

(() => {
  const P = (d, h = 0) => NOW - d * DAY - h * HOUR;
  const ev = (at, by, kind, text = '') => ({ at, by, kind, text });
  /** A contributed document: stage, contributor, target base (and folder of the knowledge map) and its history. */
  function sub(kb, id, name, by, at, { stage = 'review', note = '', events = [], status = 'pending', versionOf, via, source, kind, topics, summary, views, folder, classTitle, ...o } = {}) {
    const d = mkDoc(kb, id, name, { addedBy: actorName(by) || 'Sync', updated: events.length ? events.at(-1).at : at, status, source: source || 'upload', ...o });
    Object.assign(d, Object.fromEntries(Object.entries({ kind, topics, summary, views, folder, classTitle }).filter(([, v]) => v !== undefined)));
    d.stage = stage;
    d.submission = { by, at, note, kbBy: 'contributor', ...(versionOf ? { versionOf } : {}), ...(via ? { via } : {}), events: [ev(at, by, 'submitted', note), ...events] };
    if (stage === 'published' && !o.passages) d.passages = 40;
    D.docs.push(d);
    return d;
  }

  seedWorkspace('ws-finx', () => {
    const HA = 'u-fx-ha', LAN = 'u-fx-lan', BAO = 'u-fx-bao', KHOA = 'u-fx-khoa';
    // In review — each base's owners see their part of the queue (Hà: engineering + payments, Bảo: data, Lan: everything).
    // Processed ones wait in Review; the others are processed first (Documents → Processing).
    sub('kb-fx-eng', 'fx-sub-1', 'Kafka consumer retry guide.md', KHOA, P(0, 5), { folder: 'f-fx-eng-rel', status: 'ready', note: 'How we retry and dead-letter failed messages in the payments consumers. Others keep asking in #eng-help.', pages: 4 });
    sub('kb-fx-pay', 'fx-sub-2', 'Runbook — Card authorization latency.md', 'u-fx-huy', P(1, 2), { folder: 'f-fx-pay-rb-gw', note: 'Written after last week’s page. Covers acquirer latency vs our own gateway latency.', pages: 3 });
    sub('kb-fx-data', 'fx-sub-3', 'dbt_style_guide_v2_FINAL (2).md', 'u-fx-tuan', P(0, 20), { folder: 'f-fx-data-pipes', status: 'ready', note: 'Updated naming for marts and the new test conventions.', pages: 5, classTitle: 'dbt style guide v2' });
    sub('kb-fx-ops', 'fx-sub-4', 'Chargeback procedure — 2027 update.pdf', 'u-fx-ngoc', P(0, 3), { folder: 'f-fx-ops-cb', versionOf: 'fx-ops-dispute', note: 'New scheme timelines from January 2027. Replaces the current dispute procedure.', pages: 5 });
    sub('kb-fx-ops', 'fx-sub-5', 'Customer complaint export — October.xlsx', 'u-fx-linh', P(2, 1), { folder: 'f-fx-ops-cards', status: 'ready', note: 'Raw customer export from the complaints tool, for the monthly SBV complaint report.', pages: 1 });
    sub('kb-fx-prod', 'fx-sub-6', 'Open banking partner API brief.pdf', 'u-fx-thao', P(1, 4), { folder: 'f-fx-prod-briefs', note: 'What partners will need from our open banking APIs in 2027.', pages: 8 });
    sub('kb-fx-sec', 'fx-sub-7', 'GenAI acceptable use guideline — draft.docx', 'u-fx-son', P(3, 2), { folder: 'f-fx-sec-pol-access', status: 'ready', note: 'Draft rules for using GenAI assistants with company data.', pages: 4 });
    sub('kb-fx-pay', 'fx-sub-8', 'Runbook — Payout reconciliation mismatches.md', null, P(0, 2), { folder: 'f-fx-pay-rb-settle', via: 'sync', source: 'src-fx-pay', status: 'ready', pages: 2, size: 14e3 });
    sub('kb-fx-pol', 'fx-sub-9', 'SRE on-call allowance guideline.pdf', 'u-fx-nam', P(1, 6), { folder: 'f-fx-pol-growth', note: 'Agreed with People & Culture last month; SREs keep asking where it is written down.', pages: 2 });
    // The engineer's own contributions in other stages.
    sub('kb-fx-eng', 'fx-sub-10', 'Local dev with Docker Compose — tips.md', KHOA, P(4), {
      stage: 'changes', pages: 3, folder: 'f-fx-eng-start',
      note: 'Shortcuts I use to run the payments stack locally.',
      events: [ev(P(2, 3), HA, 'changes', 'Thanks Khoa — useful. Please remove the staging database hostnames and the sample .env with real keys, then resubmit.')],
    });
    sub('kb-fx-pay', 'fx-sub-11', 'Payments API v3 — Postman collection guide.md', KHOA, P(21), {
      stage: 'published', status: 'ready', pages: 2, topics: ['t-api', 't-payments'], views: 188, folder: 'f-fx-pay-api-v3',
      summary: 'Import the Payments API v3 collection, set up sandbox keys and run the idempotency examples.',
      events: [ev(P(19), HA, 'approved', 'Great — linked it from the API reference.')],
    });
    sub('kb-fx-eng', 'fx-sub-12', 'Confluent Cloud pricing screenshots.zip', KHOA, P(12), {
      stage: 'rejected', pages: 1, folder: 'f-fx-eng-cbm-stream',
      events: [ev(P(11), HA, 'rejected', 'Vendor pricing under NDA can’t be shared workspace-wide. Add the numbers to the streaming evaluation in the CBM space instead.')],
    });
    sub('kb-fx-ops', 'fx-sub-13', 'Card scheme fee table 2027 (protected).xlsx', 'u-fx-ngoc', P(1, 8), {
      stage: 'published', status: 'failed', pages: 1, topics: ['t-cards', 't-pricing'], folder: 'f-fx-ops-cards',
      error: 'This spreadsheet is password-protected, so it can’t be read. Upload a copy without a password.',
      events: [ev(P(0, 6), LAN, 'approved')],
    });
    sub('kb-fx-data', 'fx-sub-14', 'Fraud features — data lineage.md', BAO, P(9), {
      stage: 'published', status: 'ready', pages: 3, topics: ['t-models', 't-datagov'], views: 64, folder: 'f-fx-data-fraud',
      summary: 'Where each fraud model v2 feature comes from, with table, refresh time and masking.',
      events: [ev(P(9), BAO, 'approved')],
    });
    // Sources decide how synced files publish: trusted systems directly, the repository docs through review, and the
    // 100k-file archive only what's uncertain (personal data, duplicates, new versions) — the policy built for scale.
    D.sources.forEach(s => { s.publish = s.id === 'src-fx-pay' ? 'review' : s.id === 'src-fx-archive' ? 'uncertain' : 'auto'; });
    D.topicProposals = [];
  });

  seedWorkspace('ws-northwind', () => {
    const MINH = 'u-minh';
    sub('kb-sales', 'd-sub-1', 'Acme QBR deck — Q3.pptx', MINH, P(0, 4), { folder: 'f-nw-sales-renew', note: 'Reusable structure for quarterly business reviews; customer names removed.', pages: 18 });
    sub('kb-hr', 'd-sub-2', 'Expense tips for new joiners.docx', MINH, P(5), {
      stage: 'changes', pages: 3, folder: 'f-nw-hr-travel',
      events: [ev(P(3), 'u-an', 'changes', 'Two tips contradict the Travel & Expense Policy (receipts are needed for anything over USD 25). Please align them with section 5 and resubmit.')],
    });
    sub('kb-product', 'd-sub-3', 'Customer onboarding FAQ.docx', MINH, P(30), {
      stage: 'published', status: 'ready', pages: 4, topics: ['t-admin'], views: 96, folder: 'f-nw-prod-use',
      summary: 'Answers to the twelve questions new customers ask most in their first month.',
      events: [ev(P(28), 'u-ben', 'approved')],
    });
    sub('kb-hr', 'd-sub-4', 'Remote work stipend FAQ.docx', 'u-chi', P(1), { folder: 'f-nw-hr-work', status: 'ready', note: 'Collected from questions in #people-help.', pages: 3 });
    sub('kb-sales', 'd-sub-5', 'Procurement questionnaire answers 2026.xlsx', 'u-priya', P(2), { folder: 'f-nw-sales-security', note: 'Updated answers after the SOC 2 renewal.', pages: 1 });
    sub('kb-product', 'd-sub-6', 'Sustainability report 2025.pdf', 'u-ben', P(0, 8), { folder: 'f-nw-prod-trust', note: 'Customers ask for it in RFPs.', pages: 22 });
    sub('kb-hr', 'd-sub-7', 'hybrid-work-guidelines_DRAFT_v3 (1).docx', 'u-tuan', P(0, 30), { folder: 'f-nw-hr-work', status: 'ready', note: 'Draft from the leadership offsite.', pages: 5, classTitle: 'Hybrid work guidelines (draft)' });
    D.sources.forEach(s => { s.publish = 'auto'; });
    D.topicProposals = [];
  });
})();
