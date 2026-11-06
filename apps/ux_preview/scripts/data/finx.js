'use strict';
/* Finx Workspace — a Vietnamese digital-banking and payments company on the
   Enterprise template with Spaces, Work and Requests switched on.
   Same platform records as Northwind (knowledge, people, sources, chats) plus
   spaces (teams, projects, offices), events, work (evidence reviews, drafts)
   and requests (just-in-time access, PII access, SaaS tools, policy exceptions).
   Metadata and the larger catalog live in data/knowledge.js; contributions in
   data/contributions.js. All Finx records are fictional demo data. */

/* ═══════════════ Personas (demo people) ═══════════════ */
Object.assign(PERSONAS, {
  engineer: {
    id: 'u-fx-khoa', name: 'Trần Minh Khoa', email: 'khoa.tran@finx.vn', role: 'Backend Engineer · Payments Platform', label: 'Engineer',
    perms: ['tenant.read', 'knowledge.read', 'knowledge.contribute'], workspaces: ['ws-finx'],
    profile: { team: 'Payments Platform', level: 'Engineer II', trainings: ['Secure coding 2026', 'Data privacy 2026'], oncall: true, joined: '2024-03' },
  },
  lead: {
    id: 'u-fx-ha', name: 'Lê Thu Hà', email: 'ha.le@finx.vn', role: 'Engineering Manager · Payments Platform', label: 'Lead',
    perms: ['tenant.read', 'knowledge.read', 'knowledge.contribute', 'knowledge.manage', 'ingestion.read', 'ingestion.run'], workspaces: ['ws-finx'],
    profile: { team: 'Payments Platform', trainings: ['Secure coding 2026', 'Data privacy 2026'] },
  },
  analyst: {
    id: 'u-fx-bao', name: 'Phạm Quốc Bảo', email: 'bao.pham@finx.vn', role: 'Senior Data Analyst · Data Platform', label: 'Analyst',
    perms: ['tenant.read', 'knowledge.read', 'knowledge.contribute', 'knowledge.manage', 'ingestion.read', 'ingestion.run'], workspaces: ['ws-finx'],
    profile: { team: 'Data Platform', trainings: ['Data privacy 2026'] },
  },
  wsadmin: {
    id: 'u-fx-lan', name: 'Võ Thị Lan', email: 'lan.vo@finx.vn', role: 'Knowledge & Compliance Lead · Workspace admin', label: 'Admin',
    perms: ALL_TENANT, workspaces: ['ws-finx'],
    profile: { team: 'Risk & Compliance', trainings: ['Data privacy 2026', 'Secure coding 2026'] },
  },
});

/* ═══════════════ Workspace record (platform) ═══════════════ */
(() => {
  const finx = {
    id: 'ws-finx', name: 'Finx Workspace', code: 'finx', color: '#0B6E4F', members: 1840, docs: 9420, status: 'active', created: ago(220 * DAY), owner: 'Võ Thị Lan', questions30: 31840,
    template: 'enterprise', modules: { spaces: true, work: true, requests: true }, spaceTypes: ['team', 'project', 'office'], workflows: ['review', 'draft'],
    demo: 'Fictional records made for this prototype. Finx people, documents and policies are not real.',
  };
  D.workspaces.push(finx);
  D.pWorkspaces.splice(2, 0, finx);
})();

seedWorkspace('ws-finx', () => {
  const T = (d, h = 0) => NOW + d * DAY + h * HOUR;   // future
  const P = (d, h = 0) => NOW - d * DAY - h * HOUR;   // past
  const EOD = d => { const t = new Date(NOW); t.setHours(23, 59, 0, 0); return t.getTime() + d * DAY; };  // 23:59 in d days

  /* Exact passages the assistant, requests and work cite (the renditions contain them verbatim). */
  const Q = {
    accessJit: 'Production access is granted just in time for a maximum of 8 hours and requires an approved change ticket.',
    accessTraining: 'Engineers must complete the Secure Coding training before receiving any production access.',
    accessReview: 'System owners review every access right each quarter and revoke access that is no longer needed.',
    sev1: 'A Severity 1 incident must be declared in the #incident channel within 15 minutes of detection.',
    sbv: 'When customer funds are affected, Risk & Compliance notifies the State Bank of Vietnam within 24 hours.',
    masked: 'Customer personal data is masked by default in every non-production environment.',
    pii: 'Access to unmasked customer data requires an approved PII access request and the Data privacy training.',
    napas: 'NAPAS 247 interbank transfers settle in real time, 24 hours a day.',
    batch: 'Batch transfers submitted after 15:30 are settled on the next business day.',
    idemKey: 'Every POST to a payment API must carry an Idempotency-Key header.',
    idemReplay: 'The gateway stores the first response for 24 hours and replays it for any retry with the same key.',
    ledger: 'Ledger balances are updated only by consuming events from the payments topic, never by direct writes.',
    failover: 'If the timeout rate exceeds 2% for 5 minutes, fail over card authorization to the secondary acquirer.',
    mau: 'A monthly active customer has at least one customer-initiated financial transaction in the calendar month; logins alone do not count.',
    hybrid: 'Employees work from the office at least three days a week; Tuesday and Thursday are team days.',
    vendor: 'Any new software or SaaS tool that stores or processes customer data needs a vendor security assessment by Risk & Compliance before purchase.',
    exception: 'Policy exceptions are time-limited to at most 6 months and need written sign-off from the accountable risk owner.',
  };

  /* ═══════════════ People ═══════════════ */
  const KM_PERMS = ['tenant.read', 'knowledge.read', 'knowledge.contribute', 'knowledge.manage', 'source.manage', 'ingestion.read', 'ingestion.run'];
  D.roles = [
    { id: 'r-admin', name: 'Workspace admin', system: true, desc: 'Full control of this workspace.', perms: ALL_TENANT },
    { id: 'r-member', name: 'Member', system: true, desc: 'Ask questions, browse the knowledge they can access, contribute documents for review and send requests.', perms: ['tenant.read', 'knowledge.read', 'knowledge.contribute'] },
    { id: 'r-km', name: 'Knowledge owner', system: false, desc: 'Owns knowledge bases, reviews what is submitted to them and keeps their sources healthy.', perms: KM_PERMS },
    { id: 'r-auditor', name: 'Auditor', system: false, desc: 'Reviews activity and sign-ins for audits. Cannot change anything.', perms: ['tenant.read', 'knowledge.read', 'audit.read'] },
  ];
  D.groups = [
    { id: 'g-fx-eng', name: 'Engineering', desc: 'Every software, data and SRE engineer at Finx.' },
    { id: 'g-fx-pay', name: 'Payments Platform', desc: 'Payment gateway, cards, NAPAS transfers and QR payments.' },
    { id: 'g-fx-data', name: 'Data Platform', desc: 'Warehouse, pipelines, fraud and credit models, regulatory reporting.' },
    { id: 'g-fx-ops', name: 'Banking Operations', desc: 'Reconciliation, disputes, KYC and customer operations.' },
    { id: 'g-fx-grc', name: 'Risk & Compliance', desc: 'Information security, PCI DSS, SBV regulations and privacy.' },
    { id: 'g-fx-lead', name: 'Leadership', desc: 'Executive team and heads of department.' },
  ];
  D.members = [
    ['u-fx-lan', 'Võ Thị Lan', 'lan.vo', 'r-admin', ['g-fx-grc'], 5 * MIN, 210],
    ['u-fx-ha', 'Lê Thu Hà', 'ha.le', 'r-km', ['g-fx-eng', 'g-fx-pay'], 25 * MIN, 205],
    ['u-fx-bao', 'Phạm Quốc Bảo', 'bao.pham', 'r-km', ['g-fx-data'], 1 * HOUR, 190],
    ['u-fx-khoa', 'Trần Minh Khoa', 'khoa.tran', 'r-member', ['g-fx-eng', 'g-fx-pay'], 8 * MIN, 180],
    ['u-fx-nam', 'Nguyễn Hoàng Nam', 'nam.nguyen', 'r-km', ['g-fx-eng'], 40 * MIN, 215],
    ['u-fx-thao', 'Đỗ Phương Thảo', 'thao.do', 'r-km', [], 2 * HOUR, 170],
    ['u-fx-quan', 'Huỳnh Minh Quân', 'quan.huynh', 'r-km', [], 15 * MIN, 200],
    ['u-fx-ngoc', 'Lâm Bảo Ngọc', 'ngoc.lam', 'r-km', ['g-fx-ops'], 3 * HOUR, 195],
    ['u-fx-linh', 'Bùi Gia Linh', 'linh.bui', 'r-auditor', ['g-fx-grc'], 4 * HOUR, 160],
    ['u-fx-huy', 'Đặng Quốc Huy', 'huy.dang', 'r-member', ['g-fx-eng', 'g-fx-pay'], 50 * MIN, 150],
    ['u-fx-vy', 'Trần Thảo Vy', 'vy.tran', 'r-member', ['g-fx-eng', 'g-fx-pay'], 2 * HOUR, 120],
    ['u-fx-tuan', 'Phan Đăng Tuấn', 'tuan.phan', 'r-member', ['g-fx-eng', 'g-fx-data'], 6 * HOUR, 140],
    ['u-fx-an', 'Mai Khánh An', 'an.mai', 'r-km', [], 1 * DAY, 185],
    ['u-fx-minh', 'Hoàng Đức Minh', 'minh.hoang', 'r-member', ['g-fx-lead', 'g-fx-eng'], 9 * HOUR, 218],
    ['u-fx-tung', 'Lý Thanh Tùng', 'tung.ly', 'r-member', ['g-fx-lead'], 2 * DAY, 200],
    ['u-fx-son', 'Ngô Hoàng Sơn', 'son.ngo', 'r-member', ['g-fx-grc', 'g-fx-eng'], 19 * DAY, 130, 'suspended'],
  ].map(([id, name, mail, roleId, groups, last, joinedDays, status = 'active']) => ({ id, name, email: mail + '@finx.vn', roleId, groups, status, lastActive: ago(last), joined: ago(joinedDays * DAY) }));
  D.knownAccounts = ['duc.vo@finx.vn', 'trang.le@finx.vn', 'phuc.nguyen@finx.vn'];

  /* ═══════════════ Knowledge ═══════════════
     access = role each demo persona holds: owner|editor|viewer|none (visible, locked)|null (hidden). wsadmin owns everything. */
  const ALL = { engineer: 'viewer', lead: 'viewer', analyst: 'viewer' };
  D.kbs = [
    { id: 'kb-fx-mine', name: 'My files', personal: true, desc: 'Only you can see these. Use them in your own chats and work.', color: '#4F5865', general: 'private', shares: [], updated: P(1) },
    { id: 'kb-fx-eng', name: 'Engineering Handbook & Architecture', desc: 'Architecture decisions, engineering standards, platform guides and the handbook.', color: '#2F6FB5', general: 'workspace', access: { engineer: 'viewer', lead: 'owner', analyst: 'viewer' }, shares: [{ kind: 'user', id: 'u-fx-ha', role: 'owner' }, { kind: 'group', id: 'g-fx-eng', role: 'editor' }], updated: P(0, 3), space: 'sp-cbm' },
    { id: 'kb-fx-pay', name: 'Payments Platform', desc: 'Runbooks, API references, designs and postmortems for payments.', color: '#0B6E4F', general: 'restricted', access: { engineer: 'editor', lead: 'owner', analyst: 'viewer' }, shares: [{ kind: 'user', id: 'u-fx-ha', role: 'owner' }, { kind: 'group', id: 'g-fx-pay', role: 'editor' }, { kind: 'group', id: 'g-fx-data', role: 'viewer' }], updated: P(0, 6), space: 'sp-pay' },
    { id: 'kb-fx-data', name: 'Data Platform & Analytics', desc: 'Metric definitions, warehouse tables, dashboards and model cards.', color: '#6B4FBF', general: 'workspace', access: { engineer: 'viewer', lead: 'viewer', analyst: 'owner' }, shares: [{ kind: 'user', id: 'u-fx-bao', role: 'owner' }, { kind: 'group', id: 'g-fx-data', role: 'editor' }], updated: P(1, 2), space: 'sp-data' },
    { id: 'kb-fx-ops', name: 'Banking Operations', desc: 'Cut-off times, reconciliation, disputes and KYC procedures.', color: '#C2620F', general: 'workspace', access: { ...ALL }, shares: [{ kind: 'group', id: 'g-fx-ops', role: 'owner' }], updated: P(2) },
    { id: 'kb-fx-sec', name: 'Security & Compliance', desc: 'Security policies, PCI DSS controls, SBV regulations and incident response.', color: '#A23B3B', general: 'workspace', access: { ...ALL }, shares: [{ kind: 'group', id: 'g-fx-grc', role: 'owner' }], updated: P(0, 20), space: 'sp-grc' },
    { id: 'kb-fx-prod', name: 'Product & Business', desc: 'Roadmap, PRDs, pricing and partner integration guides.', color: '#0E7C66', general: 'workspace', access: { ...ALL }, shares: [{ kind: 'user', id: 'u-fx-thao', role: 'owner' }], updated: P(3) },
    { id: 'kb-fx-pol', name: 'Internal Policies & Guidelines', desc: 'Leave, travel, hybrid work, conduct and onboarding.', color: '#B4467A', general: 'workspace', access: { ...ALL }, shares: [{ kind: 'user', id: 'u-fx-an', role: 'owner' }], updated: P(5) },
    { id: 'kb-fx-lead', name: 'Leadership & Finance', desc: 'Budgets, board packs and plans for the leadership team.', color: '#4F5865', general: 'restricted', access: { engineer: 'none', lead: 'none', analyst: null }, shares: [{ kind: 'group', id: 'g-fx-lead', role: 'owner' }], updated: P(9) },
  ];
  const doc = (kb, id, name, o = {}) => mkDoc(kb, id, name, o);
  D.docs = [
    doc('kb-fx-mine', 'fx-me-1', 'My notes — QR callback retries.md', { addedBy: 'You', updated: P(3), pages: 2 }),
    doc('kb-fx-mine', 'fx-me-2', 'Interview prep — system design.md', { addedBy: 'You', updated: P(12), pages: 3 }),
    doc('kb-fx-mine', 'fx-me-3', 'Whiteboard — ledger split.png', { addedBy: 'You', updated: P(6), pages: 1, status: 'unsupported' }),

    doc('kb-fx-sec', 'fx-sec-access', 'Access Control Policy.pdf', { source: 'src-fx-sec', addedBy: 'GRC policies', pages: 6, size: 512e3, updated: P(32), passages: 58 }),
    doc('kb-fx-sec', 'fx-sec-incident', 'Incident Response Plan.pdf', { source: 'src-fx-sec', addedBy: 'GRC policies', pages: 5, size: 468e3, updated: P(48), passages: 47 }),
    doc('kb-fx-sec', 'fx-sec-privacy', 'Customer Data Protection Standard.pdf', { source: 'src-fx-sec', addedBy: 'GRC policies', pages: 4, size: 391e3, updated: P(61), passages: 36 }),
    doc('kb-fx-sec', 'fx-sec-pci', 'PCI DSS v4.0 control matrix.xlsx', { source: 'src-fx-sec', addedBy: 'GRC policies', pages: 1, size: 286e3, updated: P(9), passages: 140 }),
    doc('kb-fx-sec', 'fx-sec-vendor', 'Third-party & SaaS Risk Standard.pdf', { source: 'src-fx-sec', addedBy: 'GRC policies', pages: 4, updated: P(95) }),
    doc('kb-fx-sec', 'fx-sec-exception', 'Policy Exception Procedure.pdf', { source: 'src-fx-sec', addedBy: 'GRC policies', pages: 2, updated: P(140) }),

    doc('kb-fx-ops', 'fx-ops-cutoff', 'Payment Cut-off Times & Settlement Windows.pdf', { source: 'src-fx-ops', addedBy: 'Operations procedures', pages: 3, size: 244e3, updated: P(21), passages: 24 }),
    doc('kb-fx-ops', 'fx-ops-dispute', 'Card Dispute Handling Procedure.pdf', { source: 'src-fx-ops', addedBy: 'Operations procedures', pages: 4, size: 330e3, updated: P(74), passages: 33 }),
    doc('kb-fx-ops', 'fx-ops-recon', 'Daily Reconciliation Runbook.md', { source: 'src-fx-ops', addedBy: 'Operations procedures', pages: 2, size: 38e3, updated: P(11), passages: 18 }),

    doc('kb-fx-eng', 'fx-eng-adr031', 'ADR-031 — Idempotency keys for payment APIs.md', { source: 'src-fx-eng', addedBy: 'Engineering wiki', pages: 2, size: 22e3, updated: P(140), passages: 14 }),
    doc('kb-fx-eng', 'fx-eng-adr027', 'ADR-027 — Event-driven ledger updates.md', { source: 'src-fx-eng', addedBy: 'Engineering wiki', pages: 2, size: 19e3, updated: P(205), passages: 12 }),
    doc('kb-fx-eng', 'fx-eng-handbook', 'Engineering Handbook 2026.pdf', { source: 'src-fx-eng', addedBy: 'Engineering wiki', pages: 24, size: 2.6e6, updated: P(58), passages: 196 }),
    doc('kb-fx-eng', 'fx-eng-eval-kafka', 'Evaluation — Confluent Cloud (Kafka).pdf', { addedBy: 'Nguyễn Hoàng Nam', pages: 8, size: 1.1e6, updated: P(12), passages: 52 }),
    doc('kb-fx-eng', 'fx-eng-eval-pulsar', 'Evaluation — Apache Pulsar (self-hosted).pdf', { addedBy: 'Nguyễn Hoàng Nam', pages: 8, size: 980e3, updated: P(12), passages: 49 }),
    doc('kb-fx-eng', 'fx-eng-eval-msk', 'Evaluation — Amazon MSK.pdf', { addedBy: 'Đặng Quốc Huy', pages: 8, size: 1.04e6, updated: P(10), passages: 50 }),

    doc('kb-fx-pay', 'fx-pay-runbook', 'Runbook — Payment gateway timeouts.md', { source: 'src-fx-pay', addedBy: 'payments-docs', pages: 2, size: 26e3, updated: P(16), passages: 15 }),
    doc('kb-fx-pay', 'fx-pay-api', 'Payments API reference v3.md', { source: 'src-fx-pay', addedBy: 'payments-docs', pages: 3, size: 64e3, updated: P(27), passages: 41 }),
    doc('kb-fx-pay', 'fx-pay-postmortem', 'Postmortem — QR payments outage, 14 Oct.md', { source: 'src-fx-pay', addedBy: 'payments-docs', pages: 3, size: 31e3, updated: P(14), passages: 22 }),

    doc('kb-fx-data', 'fx-data-mau', 'Metric definitions — Active customers.md', { source: 'src-fx-data', addedBy: 'Data space', pages: 2, size: 17e3, updated: P(44), passages: 11 }),
    doc('kb-fx-data', 'fx-data-dict', 'Data dictionary — Core banking warehouse.xlsx', { source: 'src-fx-data', addedBy: 'Data space', pages: 1, size: 1.8e6, updated: P(6), passages: 320 }),
    doc('kb-fx-data', 'fx-data-fraud', 'Fraud model v2 — Model card.pdf', { addedBy: 'Phạm Quốc Bảo', pages: 4, size: 720e3, updated: P(8), passages: 34 }),

    doc('kb-fx-prod', 'fx-prod-roadmap', 'Product roadmap H1 2027.pptx', { source: 'src-fx-prod', addedBy: 'Product shared drive', pages: 7, size: 4.2e6, updated: P(18), passages: 38 }),
    doc('kb-fx-prod', 'fx-prod-pricing', 'Pricing & fee schedule 2027.pdf', { source: 'src-fx-prod', addedBy: 'Product shared drive', pages: 3, size: 410e3, updated: P(25), passages: 29 }),

    doc('kb-fx-pol', 'fx-pol-hybrid', 'Hybrid Work Policy.pdf', { source: 'src-fx-pol', addedBy: 'People policies', pages: 3, size: 280e3, updated: P(90), passages: 21 }),
    doc('kb-fx-pol', 'fx-pol-travel', 'Travel & Expense Policy.pdf', { source: 'src-fx-pol', addedBy: 'People policies', pages: 4, size: 350e3, updated: P(120), passages: 30 }),
    doc('kb-fx-pol', 'fx-pol-onboarding', 'New joiner guide.pdf', { source: 'src-fx-pol', addedBy: 'People policies', pages: 4, size: 1.3e6, updated: P(40), passages: 32 }),

    doc('kb-fx-lead', 'fx-lead-budget', 'FY2027 budget plan.xlsx', { addedBy: 'Lý Thanh Tùng', pages: 1, size: 2.2e6, updated: P(9), passages: 90 }),
  ];

  /* ═══════════════ Sources ═══════════════ */
  D.accounts = [
    { id: 'acc-fx-conf', app: 'confluence', label: 'finx.atlassian.net', user: 'kb-sync@finx.vn', status: 'connected', connected: P(200), checked: ago(7 * MIN) },
    { id: 'acc-fx-sp', app: 'sharepoint', label: 'finx.sharepoint.com', user: 'it-admin@finx.vn', status: 'connected', connected: P(190), checked: ago(18 * MIN) },
    { id: 'acc-fx-gd', app: 'gdrive', label: 'drive@finx.vn', user: 'drive@finx.vn', status: 'connected', connected: P(150), checked: ago(31 * MIN) },
    { id: 'acc-fx-gh', app: 'github', label: 'github.com/finx', user: 'finx-bomesh-bot', status: 'connected', connected: P(120), checked: ago(4 * MIN) },
  ];
  const sched = (freq, time = '02:00') => ({ freq, time, day: 'Mon', tz: 'Asia/Ho_Chi_Minh', on: true });
  const last = (d, h, added, updated, failed = 0) => ({ at: P(d, h), result: failed ? 'partial' : 'completed', added, updated, removed: 0, failed });
  D.sources = [
    { id: 'src-fx-eng', name: 'Engineering wiki', app: 'confluence', account: 'acc-fx-conf', kb: 'kb-fx-eng', status: 'healthy', scope: ['ENG / Architecture decisions', 'ENG / Handbook', 'ENG / Platform guides'], schedule: sched('daily', '01:00'), last: last(0, 3, 1, 4), next: T(0, 21), created: P(200), owner: 'Lê Thu Hà' },
    { id: 'src-fx-pay', name: 'payments-docs repository', app: 'github', account: 'acc-fx-gh', kb: 'kb-fx-pay', status: 'healthy', scope: ['finx/payments-docs · main · docs/'], schedule: sched('daily', '00:30'), last: last(0, 1, 1, 2), next: T(0, 23), created: P(120), owner: 'Lê Thu Hà' },
    { id: 'src-fx-data', name: 'Data space', app: 'confluence', account: 'acc-fx-conf', kb: 'kb-fx-data', status: 'healthy', scope: ['DATA / Metrics', 'DATA / Warehouse', 'DATA / Dashboards'], schedule: sched('daily', '01:30'), last: last(1, 2, 0, 3), next: T(0, 20), created: P(180), owner: 'Phạm Quốc Bảo' },
    { id: 'src-fx-ops', name: 'Operations procedures', app: 'sharepoint', account: 'acc-fx-sp', kb: 'kb-fx-ops', status: 'healthy', scope: ['Banking Operations / Procedures'], schedule: sched('daily', '03:00'), last: last(0, 22, 0, 2, 1), next: T(0, 2), created: P(185), owner: 'Lâm Bảo Ngọc' },
    { id: 'src-fx-sec', name: 'GRC policies', app: 'sharepoint', account: 'acc-fx-sp', kb: 'kb-fx-sec', status: 'healthy', scope: ['Risk & Compliance / Published policies', 'Risk & Compliance / Controls'], schedule: sched('daily', '02:30'), last: last(0, 20, 2, 1), next: T(0, 4), created: P(190), owner: 'Võ Thị Lan' },
    { id: 'src-fx-prod', name: 'Product shared drive', app: 'gdrive', account: 'acc-fx-gd', kb: 'kb-fx-prod', status: 'healthy', scope: ['Shared drives / Product / Published'], schedule: sched('weekly', '04:00'), last: last(3, 4, 2, 1), next: T(4), created: P(150), owner: 'Đỗ Phương Thảo' },
    { id: 'src-fx-pol', name: 'People policies', app: 'sharepoint', account: 'acc-fx-sp', kb: 'kb-fx-pol', status: 'healthy', scope: ['People & Culture / Policies'], schedule: sched('weekly', '05:00'), last: last(5, 5, 0, 1), next: T(2), created: P(170), owner: 'Mai Khánh An' },
  ];
  D.runs = [
    { id: 'run-fx-418', source: 'src-fx-pay', kb: 'kb-fx-pay', trigger: 'Scheduled', status: 'completed', started: P(0, 1), dur: 38e3, counts: { total: 3, ok: 3, failed: 0, skipped: 0 }, by: 'Schedule' },
    { id: 'run-fx-417', source: 'src-fx-eng', kb: 'kb-fx-eng', trigger: 'Scheduled', status: 'completed', started: P(0, 3), dur: 212e3, counts: { total: 5, ok: 5, failed: 0, skipped: 0 }, by: 'Schedule' },
    { id: 'run-fx-416', source: 'src-fx-sec', kb: 'kb-fx-sec', trigger: 'Scheduled', status: 'completed', started: P(0, 20), dur: 96e3, counts: { total: 3, ok: 3, failed: 0, skipped: 0 }, by: 'Schedule' },
    { id: 'run-fx-415', source: 'src-fx-ops', kb: 'kb-fx-ops', trigger: 'Scheduled', status: 'partial', started: P(0, 22), dur: 141e3, counts: { total: 3, ok: 2, failed: 1, skipped: 0 }, by: 'Schedule', failures: ['fx-ops-scan'] },
    { id: 'run-fx-414', source: 'src-fx-data', kb: 'kb-fx-data', trigger: 'Manual', status: 'completed', started: P(1, 2), dur: 77e3, counts: { total: 3, ok: 3, failed: 0, skipped: 0 }, by: 'Phạm Quốc Bảo' },
    { id: 'run-fx-413', source: 'src-fx-prod', kb: 'kb-fx-prod', trigger: 'Scheduled', status: 'completed', started: P(3, 4), dur: 305e3, counts: { total: 3, ok: 3, failed: 0, skipped: 0 }, by: 'Schedule' },
  ];

  /* Access requests (to knowledge bases) */
  D.requests = [
    { id: 'req-fx-1', user: 'u-fx-tuan', kb: 'kb-fx-pay', role: 'viewer', note: 'Building the settlement fact table and need the NAPAS settlement file format.', at: P(0, 4), status: 'pending' },
    { id: 'req-fx-2', user: 'u-fx-huy', kb: 'kb-fx-eng', role: 'editor', note: 'I own the MSK evaluation and want to keep the ADR drafts for CBM up to date.', at: P(1, 3), status: 'pending' },
    { id: 'req-fx-3', user: 'u-fx-thao', kb: 'kb-fx-lead', role: 'viewer', note: 'Need the FY2027 budget lines for the virtual cards launch plan.', at: P(2, 1), status: 'pending' },
  ];

  /* ═══════════════ Activity ═══════════════ */
  D.audit = [
    [1 * HOUR, 'system', 'Sync finished', 'Sources', 'payments-docs repository', 'success'],
    [3 * HOUR, 'u-fx-quan', 'Approved a request', 'Requests', 'Production access — Trần Minh Khoa', 'success'],
    [4 * HOUR, 'u-fx-ha', 'Created an evidence review', 'Work', 'Event streaming platform — evaluation', 'success'],
    [22 * HOUR, 'system', 'Sync finished with issues', 'Sources', 'Operations procedures', 'failure'],
    [26 * HOUR, 'u-fx-lan', 'Verified a document', 'Knowledge', 'Access Control Policy.pdf', 'success'],
    [2 * DAY, 'u-fx-bao', 'Published a document', 'Knowledge', 'Fraud model v2 — Model card.pdf', 'success'],
    [3 * DAY, 'u-fx-lan', 'Added request type', 'Requests', 'Access to unmasked customer data', 'success'],
    [5 * DAY, 'u-fx-lan', 'Suspended member', 'People', 'Ngô Hoàng Sơn', 'success'],
    [6 * DAY, 'u-fx-ha', 'Created space', 'Spaces', 'Core Banking Modernization', 'success'],
    [8 * DAY, 'u-fx-lan', 'Updated assistant instructions', 'Settings', 'Assistant', 'success'],
  ].map(([t, actor, action, type, target, outcome], i) => ({ id: 'ev-fx-' + (700 - i), at: ago(t), actor, action, type, target, outcome, ip: '10.40.' + (2 + i) + '.' + (14 + i * 3), device: i % 3 ? 'Chrome on macOS' : 'Edge on Windows' }));
  D.signins = [
    [5 * MIN, 'u-fx-lan', 'Microsoft', 'active', 'Edge on Windows'], [8 * MIN, 'u-fx-khoa', 'Microsoft', 'active', 'Chrome on macOS'],
    [15 * MIN, 'u-fx-quan', 'Microsoft', 'active', 'Edge on Windows'], [25 * MIN, 'u-fx-ha', 'Microsoft', 'active', 'Safari on iPhone'],
    [1 * HOUR, 'u-fx-bao', 'Microsoft', 'active', 'Chrome on macOS'], [19 * DAY, 'u-fx-son', 'Password', 'blocked', 'Chrome on Linux'],
  ].map(([t, user, method, st, device], i) => ({ id: 'si-fx-' + i, at: ago(t), user, method, status: st, device }));
  D.usage = { questions: Array.from({ length: 30 }, (_, i) => Math.round(1020 + 260 * Math.sin(i / 3.1) + i * 9 + (i % 7 > 4 ? -620 : 0))), active: 1312, activePrev: 1188, questions7: 7640, questions7Prev: 7010 };
  D.gaps = [
    { id: 'gfx1', q: 'Can we use our own laptop for production access?', n: 37, kb: 'kb-fx-sec', why: 'Access Control Policy doesn’t cover personal devices' },
    { id: 'gfx2', q: 'What is the FX settlement cut-off for USD?', n: 22, kb: 'kb-fx-ops', why: 'Cut-off times only cover VND transfers' },
    { id: 'gfx3', q: 'Do contractors need the Secure Coding training?', n: 18, kb: 'kb-fx-sec', why: 'The policy only mentions engineers' },
    { id: 'gfx4', q: 'Which acquirer is primary for Mastercard?', n: 11, kb: 'kb-fx-pay', why: 'No document covers it' },
  ];
  D.artifacts = {};

  /* ═══════════════ Assistant ═══════════════ */
  D.assistant = {
    instructions: 'You are the Finx Workspace assistant. Answer from the policies, runbooks, architecture decisions and data definitions the person can access, and cite every factual claim. Quote exact limits — cut-off times, durations, deadlines. For access or exceptions, point to the right request; never grant anything yourself. Reply in the language the person writes in (Vietnamese or English).',
    style: 'balanced', citations: true, caps: { search: true, analyze: true, files: true },
    welcome: 'What do you need to find or get done today?',
    starters: [
      { title: 'Get access', prompt: 'How do I get production access?' },
      { title: 'Check a cut-off', prompt: 'What is the cut-off for interbank transfers?' },
      { title: 'Workplace', prompt: 'How many office days are required?' },
    ],
    /* Starters for one role or group (keyed by its id); everyone else sees `starters`. A group list wins over a role list. */
    audienceStarters: {
      'r-member': [
        { title: 'Get access', prompt: 'How do I get production access?' },
        { title: 'Architecture', prompt: 'What does ADR-031 say about idempotency?' },
        { title: 'On call', prompt: 'What do I do when the payment gateway times out?' },
      ],
      'r-km': [
        { title: 'Incidents', prompt: 'When must we notify the SBV about an incident?' },
        { title: 'Decide', prompt: 'Compare the event streaming options on data residency and 3-year cost.' },
        { title: 'Access review', prompt: 'What do system owners have to do in the quarterly access review?' },
      ],
      'g-fx-data': [
        { title: 'Define a metric', prompt: 'How do we define a monthly active customer?' },
        { title: 'Data access', prompt: 'What do I need to query unmasked customer data?' },
        { title: 'Find a table', prompt: 'Which warehouse table has the settlement status of each transaction?' },
      ],
      'r-admin': [
        { title: 'Answer consistently', prompt: 'When must we notify the SBV about an incident?' },
        { title: 'Spot gaps', prompt: 'What did people ask about production access this week that we couldn’t answer?' },
        { title: 'Draft a notice', prompt: 'Draft a reminder about the quarterly access review deadline.' },
      ],
    },
  };

  /* ═══════════════ Spaces ═══════════════ */
  D.spaces = [
    {
      id: 'sp-pay', type: 'team', name: 'Payments Platform', code: 'PAY', term: '', color: '#0B6E4F',
      desc: 'Payment gateway, cards, NAPAS 247 transfers and QR payments.', schedule: 'Stand-up daily 09:30 · Floor 12, Bitexco', memberCount: 42, visibility: 'discoverable', kbs: ['kb-fx-pay'],
      members: [{ user: 'u-fx-ha', role: 'lead' }, { user: 'u-fx-khoa', role: 'member' }, { user: 'u-fx-huy', role: 'member' }, { user: 'u-fx-vy', role: 'member' }],
      announcements: [
        { id: 'an-pay-1', by: 'u-fx-ha', at: P(0, 5), title: 'Postmortem review on Thursday', text: 'We go through the 14 Oct QR outage actions on Thursday at 10:00. Owners, please update your action items before then.', pinned: true },
        { id: 'an-pay-2', by: 'u-fx-huy', at: P(4), title: 'Acquirer failover drill passed', text: 'Failover to the secondary acquirer took 3 min 40 s. The timeout runbook now links the new dashboards.' },
      ],
      created: P(200),
    },
    {
      id: 'sp-data', type: 'team', name: 'Data Platform', code: 'DATA', term: '', color: '#6B4FBF',
      desc: 'Warehouse, pipelines, fraud and credit models and regulatory reporting.', schedule: 'Planning every other Monday 14:00', memberCount: 28, visibility: 'discoverable', kbs: ['kb-fx-data'],
      members: [{ user: 'u-fx-bao', role: 'lead' }, { user: 'u-fx-tuan', role: 'member' }, { user: 'u-fx-khoa', role: 'member' }],
      announcements: [{ id: 'an-data-1', by: 'u-fx-bao', at: P(1, 4), title: 'Fraud model v2 sign-off', text: 'Validation results are in the model card. Comment in the document before Wednesday; sign-off is on Friday.', pinned: true }],
      created: P(180),
    },
    {
      id: 'sp-cbm', type: 'project', name: 'Core Banking Modernization', code: 'CBM', term: '', color: '#2F6FB5',
      desc: 'Moving accounts, ledger and payments off the legacy core, one wave at a time.', schedule: 'Steering committee monthly · Architecture sync Wed 15:00', memberCount: 64, visibility: 'discoverable', kbs: ['kb-fx-eng'],
      members: [{ user: 'u-fx-ha', role: 'owner' }, { user: 'u-fx-khoa', role: 'member' }, { user: 'u-fx-bao', role: 'member' }, { user: 'u-fx-nam', role: 'member' }],
      announcements: [
        { id: 'an-cbm-1', by: 'u-fx-ha', at: P(0, 8), title: 'Streaming platform decision on the 15th', text: 'The evaluation matrix is in Work. Add evidence by Friday; the steering committee decides on the 15th.', pinned: true },
        { id: 'an-cbm-2', by: 'u-fx-nam', at: P(3), title: 'Wave 2 cutover dates', text: 'The ledger read-path cutover is planned for the weekend of 28 November. The change freeze before Tết starts on 25 January.' },
      ],
      created: P(160),
    },
    {
      id: 'sp-itsd', type: 'office', name: 'IT Service Desk', code: 'ITSD', term: '', color: '#1F7A8C',
      desc: 'Production access, laptops, accounts and new software.', schedule: 'Mon–Fri 08:00–18:00 · Floor 9', memberCount: 9, visibility: 'open', kbs: [],
      members: [{ user: 'u-fx-quan', role: 'head' }, { user: 'u-fx-lan', role: 'staff' }],
      announcements: [{ id: 'an-itsd-1', by: 'u-fx-quan', at: P(2), title: 'Production access is now just in time', text: 'Standing production access was removed on 1 October. Send a Production access request with your change ticket; access ends automatically.', pinned: true }],
      created: P(210),
    },
    {
      id: 'sp-grc', type: 'office', name: 'Risk & Compliance', code: 'GRC', term: '', color: '#A23B3B',
      desc: 'Security policies, PCI DSS, SBV regulations, privacy and policy exceptions.', schedule: 'Mon–Fri 08:30–17:30 · Floor 10', memberCount: 7, visibility: 'open', kbs: ['kb-fx-sec'],
      members: [{ user: 'u-fx-lan', role: 'head' }, { user: 'u-fx-linh', role: 'staff' }],
      announcements: [
        { id: 'an-grc-1', by: 'u-fx-lan', at: P(1), title: 'Quarterly access review due', text: 'System owners: review every access right and revoke what is no longer needed by the end of next week.', pinned: true },
        { id: 'an-grc-2', by: 'u-fx-linh', at: P(5), title: 'PCI DSS fieldwork starts on the 18th', text: 'The assessor is on site for a week. Evidence requests come through this space.' },
      ],
      created: P(210),
    },
  ];

  /* ═══════════════ Events (what's due / coming up) — audience: all | members | staff ═══════════════ */
  D.events = [
    { id: 'evt-fx-1', space: 'sp-pay', kind: 'meeting', title: 'Postmortem review — QR payments outage', at: T(2, 2), audience: 'members', doc: 'fx-pay-postmortem' },
    { id: 'evt-fx-2', space: 'sp-data', kind: 'deadline', title: 'Fraud model v2 sign-off', at: T(4, 6), audience: 'members', doc: 'fx-data-fraud' },
    { id: 'evt-fx-3', space: 'sp-cbm', kind: 'deadline', title: 'ADR-042 draft for architecture review', at: T(6, 3), audience: 'members', work: 'w-draft-adr042' },
    { id: 'evt-fx-4', space: 'sp-grc', kind: 'deadline', title: 'Quarterly access review closes', at: EOD(11), audience: 'all', doc: 'fx-sec-access' },
    { id: 'evt-fx-5', space: 'sp-cbm', kind: 'meeting', title: 'CBM steering committee — streaming decision', at: T(13, 4), audience: 'members', work: 'w-review-stream' },
    { id: 'evt-fx-6', space: 'sp-grc', kind: 'meeting', title: 'PCI DSS audit fieldwork begins', at: T(16, 1), audience: 'all', doc: 'fx-sec-pci' },
    { id: 'evt-fx-7', space: 'sp-grc', kind: 'deadline', title: 'Complete Secure Coding training 2026', at: EOD(29), audience: 'all', requestType: 'rt-prod' },
    { id: 'evt-fx-8', space: 'sp-itsd', kind: 'deadline', title: 'Change freeze before Tết starts', at: T(84), audience: 'all' },
  ];

  /* ═══════════════ Work (artifacts made with AI workflows) ═══════════════ */
  const cite = (doc, page, quote) => ({ doc, page, quote });
  const cell = (text, doc, page, quote) => ({ text, cite: cite(doc, page, quote) });
  const K = 'fx-eng-eval-kafka', PU = 'fx-eng-eval-pulsar', MS = 'fx-eng-eval-msk';
  D.works = [
    {
      id: 'w-review-stream', kind: 'review', workflow: 'review', title: 'Event streaming platform — evaluation', space: 'sp-cbm', owner: 'u-fx-ha', status: 'ready', visibility: 'space',
      created: P(0, 4), updated: P(0, 4), sources: [K, PU, MS, 'fx-eng-adr027'],
      data: {
        papers: [K, PU, MS],
        criteria: [{ id: 'perf', label: 'Throughput at peak' }, { id: 'eos', label: 'Exactly-once support' }, { id: 'ops', label: 'Operations effort' }, { id: 'res', label: 'Data residency (Vietnam)' }, { id: 'cost', label: '3-year cost' }],
        cells: {
          [K]: {
            perf: cell('180k messages/s at p99 42 ms.', K, 3, 'In our load test Confluent Cloud sustained 180,000 messages per second at a p99 latency of 42 ms.'),
            eos: cell('Yes — idempotent producers and transactions.', K, 4, 'Idempotent producers and transactions give exactly-once delivery between Kafka topics out of the box.'),
            ops: cell('Low — the vendor runs brokers and upgrades.', K, 5, 'Brokers, upgrades and scaling are run by the vendor; our team only manages topics, ACLs and connectors.'),
            res: cell('No Vietnam region; nearest is Singapore.', K, 6, 'The nearest Confluent Cloud region is Singapore; no region is available in Vietnam.'),
            cost: cell('About USD 1.26M over 3 years.', K, 7, 'The estimated three-year cost is USD 1.26 million, including support and private networking.'),
          },
          [PU]: {
            perf: cell('150k messages/s at p99 55 ms.', PU, 3, 'On six bare-metal brokers in our Ho Chi Minh City data center, Pulsar sustained 150,000 messages per second at a p99 latency of 55 ms.'),
            eos: cell('Partial — transactions only in the Java client.', PU, 4, 'Exactly-once processing requires Pulsar transactions, which our client libraries support only for Java.'),
            ops: cell('High — about 2.5 engineers to operate.', PU, 5, 'Running Pulsar needs BookKeeper and ZooKeeper clusters; we estimate 2.5 full-time engineers to operate it.'),
            res: cell('Yes — stays in our own data centers.', PU, 6, 'All data stays in Finx\'s own data centers in Hanoi and Ho Chi Minh City.'),
            cost: cell('About USD 0.94M over 3 years, staff included.', PU, 7, 'Hardware, monitoring licences and staff time come to an estimated USD 0.94 million over three years.'),
          },
          [MS]: {
            perf: cell('160k messages/s at p99 48 ms.', MS, 3, 'A six-broker MSK cluster sustained 160,000 messages per second at a p99 latency of 48 ms.'),
            eos: cell('Yes — standard Kafka transactions.', MS, 4, 'MSK runs open-source Apache Kafka, so idempotent producers and transactions work as in any Kafka cluster.'),
            ops: cell('Medium — we still plan capacity and upgrades.', MS, 5, 'AWS patches brokers, but partition rebalancing, upgrades and capacity planning remain our responsibility.'),
            res: cell('No Vietnam region; nearest is Singapore.', MS, 6, 'AWS has no region in Vietnam; the nearest are Singapore and Jakarta.'),
            cost: cell('About USD 1.02M over 3 years.', MS, 7, 'The estimated three-year cost is USD 1.02 million with reserved brokers.'),
          },
        },
      },
    },
    {
      id: 'w-draft-adr042', kind: 'draft', workflow: 'draft', title: 'ADR-042 — Split the ledger service', space: 'sp-cbm', owner: 'u-fx-khoa', status: 'draft', visibility: 'space',
      created: P(3), updated: P(0, 20), sources: ['fx-eng-adr027', 'fx-eng-adr031'],
      data: {
        type: 'decision',
        html: '<h2>Context</h2><p>The ledger service handles both posting and balance queries. During the 9.9 sale, balance reads slowed down posting for every payment. Ledger balances already change only through events from the payments topic [1], so posting and reading can be separated without changing how money moves.</p><h2>Decision</h2><p>Split the ledger into a <b>posting service</b> that consumes payment events and a <b>balance query service</b> that serves reads from its own projection. Retries stay safe: every POST to a payment API carries an Idempotency-Key header [2], and the gateway replays the first response for 24 hours [3].</p><h2>Consequences</h2><ul><li>Balance reads become eventually consistent, typically within a second.</li><li>The posting service can scale independently during peak sales.</li><li>Reconciliation must compare the projection with posted events daily.</li></ul>',
        cites: [cite('fx-eng-adr027', 1, Q.ledger), cite('fx-eng-adr031', 1, Q.idemKey), cite('fx-eng-adr031', 2, Q.idemReplay)],
      },
    },
    {
      id: 'w-draft-pci', kind: 'draft', workflow: 'draft', title: 'PCI DSS readiness summary — Q4', space: 'sp-grc', owner: 'u-fx-lan', status: 'draft', visibility: 'space',
      created: P(5), updated: P(1, 2), sources: ['fx-sec-pci', 'fx-sec-access', 'fx-sec-incident'],
      data: {
        html: '<h2>Where we stand before fieldwork</h2><p>Access control is in good shape: production access is just in time, capped at 8 hours and tied to an approved change ticket [1], and system owners review every access right each quarter [2]. The Q4 review closes before the assessor arrives.</p><h2>Incident response</h2><p>The plan requires a Severity 1 incident to be declared within 15 minutes of detection [3]. The 14 Oct QR outage met this; the evidence pack links the timeline.</p><h2>Open items</h2><ul><li>Two vendor assessments still need sign-off.</li><li>Quarterly vulnerability scan evidence for October.</li></ul>',
        cites: [cite('fx-sec-access', 3, Q.accessJit), cite('fx-sec-access', 5, Q.accessReview), cite('fx-sec-incident', 2, Q.sev1)],
      },
    },
  ];

  /* ═══════════════ Requests: what people can ask service teams ═══════════════
     checks: rules the assistant verifies before submitting (with the policy it relies on). */
  D.requestTypes = [
    {
      id: 'rt-prod', space: 'sp-itsd', name: 'Production access (just in time)', icon: 'key', sla: 1, fee: null,
      desc: 'Temporary access to a production system for an approved change. It ends automatically.',
      fields: [
        { id: 'system', label: 'System', type: 'select', options: ['Payments gateway', 'Ledger service', 'Core banking DB (read-only)'], required: true },
        { id: 'duration', label: 'For how long', type: 'select', options: ['1 hour', '4 hours', '8 hours'], required: true },
        { id: 'ticket', label: 'Change ticket', type: 'text', required: true, placeholder: 'CHG-20950' },
        { id: 'reason', label: 'Reason', type: 'textarea', required: true, placeholder: 'What will you do in production?' },
      ],
      checks: [
        { id: 'training', rule: 'has', key: 'trainings', value: 'Secure coding 2026', label: 'Secure coding training completed', cite: cite('fx-sec-access', 3, Q.accessTraining) },
        { id: 'max', rule: 'info', label: 'Access ends automatically after at most 8 hours', cite: cite('fx-sec-access', 3, Q.accessJit) },
      ],
    },
    {
      id: 'rt-pii', space: 'sp-grc', name: 'Access to unmasked customer data', icon: 'lock', sla: 3, fee: null,
      desc: 'Time-limited access to customer personal data that is masked by default.',
      fields: [
        { id: 'dataset', label: 'Data', type: 'select', options: ['Core banking warehouse — customer tables', 'Card transactions (tokenized PAN)', 'KYC documents'], required: true },
        { id: 'duration', label: 'For how long', type: 'select', options: ['7 days', '30 days', '90 days'], required: true },
        { id: 'purpose', label: 'Why masked data isn’t enough', type: 'textarea', required: true },
      ],
      checks: [
        { id: 'privacy', rule: 'has', key: 'trainings', value: 'Data privacy 2026', label: 'Data privacy training completed', cite: cite('fx-sec-privacy', 3, Q.pii) },
        { id: 'masked', rule: 'info', label: 'Customer data stays masked everywhere else', cite: cite('fx-sec-privacy', 2, Q.masked) },
      ],
    },
    {
      id: 'rt-saas', space: 'sp-itsd', name: 'New software or SaaS tool', icon: 'layers', sla: 10, fee: null,
      desc: 'Ask for a new tool or subscription. Tools that touch customer data get a vendor security assessment.',
      fields: [
        { id: 'tool', label: 'Tool', type: 'text', required: true, placeholder: 'Name and website' },
        { id: 'data', label: 'Customer data involved', type: 'select', options: ['No customer data', 'Customer personal data', 'Card data'], required: true },
        { id: 'users', label: 'People who need it', type: 'number', required: true, min: 1, max: 500 },
        { id: 'reason', label: 'What it’s for', type: 'textarea', required: true },
      ],
      checks: [{ id: 'assess', rule: 'info', label: 'Vendor security assessment if customer data is involved', cite: cite('fx-sec-vendor', 2, Q.vendor) }],
    },
    {
      id: 'rt-exception', space: 'sp-grc', name: 'Policy exception', icon: 'shield', sla: 5, fee: null,
      desc: 'A time-limited exception to a security or data policy, signed off by the risk owner.',
      fields: [
        { id: 'policy', label: 'Policy', type: 'select', options: ['Access Control Policy', 'Customer Data Protection Standard', 'Third-party & SaaS Risk Standard', 'Hybrid Work Policy', 'Other'], required: true },
        { id: 'until', label: 'For how long', type: 'select', options: ['30 days', '90 days', '6 months'], required: true },
        { id: 'owner', label: 'Risk owner', type: 'text', required: true, placeholder: 'Head of the team that carries the risk' },
        { id: 'reason', label: 'What and why', type: 'textarea', required: true },
      ],
      checks: [{ id: 'limit', rule: 'info', label: 'At most 6 months, with the risk owner’s sign-off', cite: cite('fx-sec-exception', 1, Q.exception) }],
    },
    { id: 'rt-q-pay', space: 'sp-pay', name: 'Question for the team', icon: 'message', sla: 2, fee: null, question: true, desc: 'When the assistant can’t answer from the team’s documents, ask the people who can.', fields: [{ id: 'question', label: 'Question', type: 'textarea', required: true }], checks: [] },
    { id: 'rt-q-data', space: 'sp-data', name: 'Question for the team', icon: 'message', sla: 2, fee: null, question: true, desc: 'When the assistant can’t answer from the team’s documents, ask the people who can.', fields: [{ id: 'question', label: 'Question', type: 'textarea', required: true }], checks: [] },
  ];

  /* Request lifecycle: submitted → in_review → (needs_info ↔ in_review) → approved | declined → completed; or withdrawn. */
  const msg = (by, at, text, kind = 'message') => ({ id: uid('m'), by, at, text, kind });
  const sr = (id, type, requester, status, created, fields, thread, o = {}) => ({ id, type, space: D.requestTypes.find(t => t.id === type).space, requester, status, created, updated: thread.length ? thread[thread.length - 1].at : created, fields, thread, assignee: o.assignee || null, due: created + (D.requestTypes.find(t => t.id === type).sla) * DAY, ...o });
  D.svcRequests = [
    sr('SR-3112', 'rt-prod', 'u-fx-khoa', 'approved', P(0, 4), { system: 'Payments gateway', duration: '4 hours', ticket: 'CHG-20931', reason: 'Check QR callback retry settings — action item 3 from the 14 Oct postmortem.' },
      [msg('u-fx-khoa', P(0, 4), 'Submitted.', 'status'), msg('u-fx-quan', P(0, 3), 'Approved. Access is active until 15:00 today and ends automatically.', 'status')], { assignee: 'u-fx-quan' }),
    sr('SR-3108', 'rt-pii', 'u-fx-bao', 'needs_info', P(2, 2), { dataset: 'Core banking warehouse — customer tables', duration: '30 days', purpose: 'Validate fraud model v2 features against unmasked device and phone identifiers.' },
      [msg('u-fx-bao', P(2, 2), 'Submitted.', 'status'), msg('u-fx-linh', P(1, 5), 'Please explain why the masked identifiers aren’t enough and add the model validation ticket. You’ll also need the Data privacy training on file.', 'needs_info')], { assignee: 'u-fx-linh' }),
    sr('SR-3110', 'rt-saas', 'u-fx-thao', 'in_review', P(1, 6), { tool: 'Maze — maze.co', data: 'No customer data', users: 6, reason: 'Unmoderated usability tests for the merchant dashboard v2 prototype.' },
      [msg('u-fx-thao', P(1, 6), 'Submitted.', 'status'), msg('u-fx-quan', P(1, 1), 'Checking the licence options with Procurement.', 'status')], { assignee: 'u-fx-quan' }),
    sr('SR-3113', 'rt-prod', 'u-fx-tuan', 'submitted', P(0, 2), { system: 'Core banking DB (read-only)', duration: '8 hours', ticket: 'CHG-20950', reason: 'Compare settlement status in the core with the new warehouse fact table.' },
      [msg('u-fx-tuan', P(0, 2), 'Submitted.', 'status')]),
    sr('SR-3104', 'rt-prod', 'u-fx-huy', 'completed', P(6), { system: 'Ledger service', duration: '1 hour', ticket: 'CHG-20877', reason: 'Restart the stuck ledger consumer after the 9.9 sale lag.' },
      [msg('u-fx-huy', P(6), 'Submitted.', 'status'), msg('u-fx-quan', P(6, -1), 'Approved for 1 hour.', 'status'), msg('u-fx-quan', P(5, 22), 'Access ended automatically.', 'status')], { assignee: 'u-fx-quan' }),
    sr('SR-3099', 'rt-exception', 'u-fx-nam', 'declined', P(9), { policy: 'Access Control Policy', until: '30 days', owner: 'Hoàng Đức Minh', reason: 'Standing production access for two SREs during the CBM wave 2 cutover.' },
      [msg('u-fx-nam', P(9), 'Submitted.', 'status'), msg('u-fx-lan', P(8), 'Standing access can’t be approved under the policy. Use just-in-time access with the CBM change ticket — we can pre-approve 8-hour windows for the cutover nights.', 'status')], { assignee: 'u-fx-lan' }),
    sr('SR-3111', 'rt-q-pay', 'u-fx-vy', 'submitted', P(0, 7), { question: 'Does the 24-hour idempotency replay also apply to refund retries from the merchant portal?' },
      [msg('u-fx-vy', P(0, 7), 'Submitted.', 'status')], { aiTried: 'ADR-031 covers POSTs to payment APIs but doesn’t mention the merchant portal.' }),
    sr('SR-3102', 'rt-q-data', 'u-fx-khoa', 'completed', P(7), { question: 'Which warehouse table has the settlement status of each transaction?' },
      [msg('u-fx-khoa', P(7), 'Submitted.', 'status'), msg('u-fx-tuan', P(6, 20), 'Use dwh.fact_settlement — join on transaction_id. I added it to the data dictionary.', 'answer')], { assignee: 'u-fx-tuan', aiTried: 'The data dictionary lists two candidate tables but doesn’t say which is authoritative.' }),
  ];

  /* ═══════════════ Conversations ═══════════════ */
  D.convs = [
    { id: 'fx-c1', owner: 'u-fx-khoa', title: 'Getting production access', at: P(0, 1), scope: [], messages: [
      { id: 'fx-m1', role: 'user', text: 'How do I get production access?' },
      { id: 'fx-m2', role: 'assistant', activity: [{ kind: 'search', label: 'Searched Security & Compliance', detail: '2 searches · 3 relevant passages' }],
        text: 'Production access at Finx is **just in time**: you get it for one change, for **at most 8 hours**, and only with an **approved change ticket** [1].\n\nYou must have completed the **Secure Coding training** before any production access [2]. Your profile shows *Secure coding 2026* as completed, so you can ask for it.\n\n1. Get your change ticket approved.\n2. Send a *Production access* request to the IT Service Desk with the system, duration and ticket.\n3. Access ends on its own. System owners also review every access right each quarter [3].\n\nI can start the request for you.',
        citations: [
          { n: 1, doc: 'fx-sec-access', page: 3, quote: Q.accessJit },
          { n: 2, doc: 'fx-sec-access', page: 3, quote: Q.accessTraining },
          { n: 3, doc: 'fx-sec-access', page: 5, quote: Q.accessReview },
        ],
        next: [{ label: 'Request production access', act: 'rq-new', data: { type: 'rt-prod' } }] },
    ] },
    { id: 'fx-c2', owner: 'u-fx-ha', title: 'Payment gateway timeouts', at: P(0, 6), scope: ['kb-fx-pay'], space: 'sp-pay', messages: [
      { id: 'fx-m3', role: 'user', text: 'What do I do when the payment gateway times out?' },
      { id: 'fx-m4', role: 'assistant', activity: [{ kind: 'search', label: 'Searched Payments Platform and Security & Compliance', detail: '3 searches · 4 relevant passages' }],
        text: 'Follow **Runbook — Payment gateway timeouts**: if the timeout rate stays **above 2% for 5 minutes**, fail over card authorization to the **secondary acquirer** [1].\n\nIf customers can’t pay, declare a Severity 1 incident in **#incident within 15 minutes** of detection [2]. When customer funds are affected, Risk & Compliance must notify the State Bank of Vietnam **within 24 hours** [3], so bring them in early.',
        citations: [
          { n: 1, doc: 'fx-pay-runbook', page: 1, quote: Q.failover },
          { n: 2, doc: 'fx-sec-incident', page: 2, quote: Q.sev1 },
          { n: 3, doc: 'fx-sec-incident', page: 4, quote: Q.sbv },
        ],
        next: [{ label: 'Open the runbook', act: 'res-open', data: { id: 'fx-pay-runbook' } }] },
    ] },
    { id: 'fx-c3', owner: 'u-fx-bao', title: 'Monthly active customer definition', at: P(0, 9), scope: ['kb-fx-data'], space: 'sp-data', messages: [
      { id: 'fx-m5', role: 'user', text: 'How do we define a monthly active customer?' },
      { id: 'fx-m6', role: 'assistant', activity: [{ kind: 'search', label: 'Searched Data Platform & Analytics', detail: '1 search · 2 relevant passages' }],
        text: 'A **monthly active customer** has at least **one customer-initiated financial transaction** in the calendar month. **Logins alone don’t count** [1].\n\nSo a customer who only opened the app to check a balance in October isn’t active in October. Use this definition in every dashboard so the numbers match.',
        citations: [{ n: 1, doc: 'fx-data-mau', page: 1, quote: Q.mau }],
        next: [{ label: 'Find the warehouse table', act: 'chat-ask', data: { q: 'Which warehouse table should I use to count monthly active customers?', kb: 'kb-fx-data' } }] },
    ] },
    { id: 'fx-c4', owner: 'u-fx-lan', title: 'SBV notification after an incident', at: P(1, 2), scope: ['kb-fx-sec'], space: 'sp-grc', messages: [
      { id: 'fx-m7', role: 'user', text: 'When must we notify the SBV about an incident?' },
      { id: 'fx-m8', role: 'assistant', activity: [{ kind: 'search', label: 'Searched Security & Compliance', detail: '2 searches · 3 relevant passages' }],
        text: 'When **customer funds are affected**, Risk & Compliance notifies the **State Bank of Vietnam within 24 hours** [1].\n\nDeclaring early matters: a Severity 1 incident must be declared in **#incident within 15 minutes** of detection [2].\n\nI couldn’t find an SBV deadline for incidents that don’t affect customer funds. The Incident Response Plan may need a line on that.',
        citations: [
          { n: 1, doc: 'fx-sec-incident', page: 4, quote: Q.sbv },
          { n: 2, doc: 'fx-sec-incident', page: 2, quote: Q.sev1 },
        ] },
    ] },
    { id: 'fx-c5', owner: 'u-fx-khoa', title: 'ADR-031 and idempotency', at: P(2), scope: ['kb-fx-eng'], space: 'sp-cbm', messages: [
      { id: 'fx-m9', role: 'user', text: 'What does ADR-031 say about idempotency?' },
      { id: 'fx-m10', role: 'assistant', activity: [{ kind: 'search', label: 'Searched Engineering Handbook & Architecture', detail: '2 searches · 3 relevant passages' }],
        text: 'ADR-031 makes idempotency mandatory: **every POST to a payment API must carry an `Idempotency-Key` header** [1]. The gateway **stores the first response for 24 hours** and **replays it for any retry with the same key** [2], so a client that times out can retry without paying twice.\n\nIt works together with ADR-027: ledger balances change **only by consuming events from the payments topic**, never by direct writes [3].',
        citations: [
          { n: 1, doc: 'fx-eng-adr031', page: 1, quote: Q.idemKey },
          { n: 2, doc: 'fx-eng-adr031', page: 2, quote: Q.idemReplay },
          { n: 3, doc: 'fx-eng-adr027', page: 1, quote: Q.ledger },
        ],
        next: [{ label: 'Draft a decision record from these', act: 'work-start', data: { workflow: 'draft', space: 'sp-cbm', docs: 'fx-eng-adr031,fx-eng-adr027' } }] },
    ] },
    { id: 'fx-c6', owner: 'u-fx-khoa', title: 'Interbank transfer cut-off', at: P(4), scope: [], messages: [
      { id: 'fx-m11', role: 'user', text: 'What is the cut-off for interbank transfers?' },
      { id: 'fx-m12', role: 'assistant', activity: [{ kind: 'search', label: 'Searched Banking Operations', detail: '1 search · 2 relevant passages' }],
        text: 'It depends on how the transfer is sent:\n\n- **NAPAS 247** interbank transfers settle **in real time, 24 hours a day**, so there’s no cut-off [1].\n- **Batch transfers** submitted **after 15:30** settle on the **next business day** [2].',
        citations: [
          { n: 1, doc: 'fx-ops-cutoff', page: 1, quote: Q.napas },
          { n: 2, doc: 'fx-ops-cutoff', page: 2, quote: Q.batch },
        ] },
    ] },
    { id: 'fx-c7', owner: 'u-fx-ha', title: 'Team days for Payments Platform', at: P(6), scope: ['kb-fx-pol'], messages: [
      { id: 'fx-m13', role: 'user', text: 'How many office days are required?' },
      { id: 'fx-m14', role: 'assistant', activity: [{ kind: 'search', label: 'Searched Internal Policies & Guidelines', detail: '1 search · 1 relevant passage' }],
        text: 'Everyone works from the office **at least three days a week**, and **Tuesday and Thursday are team days** [1].',
        citations: [{ n: 1, doc: 'fx-pol-hybrid', page: 1, quote: Q.hybrid }] },
    ] },
    { id: 'fx-c8', owner: 'u-fx-bao', title: 'Unmasked data for model validation', at: P(3), scope: ['kb-fx-sec'], messages: [] },
  ];
  D.projects = [
    { id: 'fx-pj-api', owner: 'u-fx-khoa', name: 'Payments API v3 rollout', created: P(10), docs: ['fx-eng-adr031', 'fx-pay-api'] },
    { id: 'fx-pj-oncall', owner: 'u-fx-khoa', name: 'On-call onboarding', created: P(5), docs: ['fx-sec-access', 'fx-pay-runbook'] },
    { id: 'fx-pj-gw', owner: 'u-fx-ha', name: 'Gateway reliability', created: P(12), docs: ['fx-pay-runbook'] },
    { id: 'fx-pj-mau', owner: 'u-fx-bao', name: 'Active customers dashboard', created: P(8), docs: ['fx-data-mau'] },
  ];
  [['fx-c5', 'fx-pj-api'], ['fx-c1', 'fx-pj-oncall'], ['fx-c2', 'fx-pj-gw'], ['fx-c3', 'fx-pj-mau']].forEach(([c, p]) => { D.convs.find(x => x.id === c).project = p; });

  /* ═══════════════ Home: featured documents (admins curate) ═══════════════ */
  D.featured = ['fx-sec-access', 'fx-eng-adr031', 'fx-ops-cutoff', 'fx-data-mau', 'fx-pay-runbook', 'fx-prod-roadmap', 'fx-pol-hybrid', 'fx-sec-incident'];
});
