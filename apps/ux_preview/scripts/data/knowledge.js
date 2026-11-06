'use strict';
/* Knowledge seeds: taxonomy, resource metadata (type, topics, spaces, owner,
   verification, versions, summaries), the larger Finx catalog, plus each
   persona's collections, saved resources, recent reads and saved views.
   Loaded after mock.js and finx.js; uses the same seedWorkspace() scope.
   All Finx records are fictional demo data (see ws.demo). */

(() => {
  const T = d => NOW + d * DAY, P = (d, h = 0) => NOW - d * DAY - h * HOUR;
  const V = (by, atDaysAgo, dueInDays) => ({ state: 'verified', by, at: P(atDaysAgo), due: dueInDays == null ? null : T(dueInDays) });
  /** Merge metadata into existing documents: { id: {…fields} }. */
  const meta = map => Object.entries(map).forEach(([id, o]) => { const d = D.docs.find(x => x.id === id); if (d) Object.assign(d, o); });
  const views = () => Math.round(5 + rnd() * 400);

  /* ═══════════════════════════ Northwind (Enterprise) ═══════════════════════════ */
  seedWorkspace('ws-northwind', () => {
    D.topics = [
      { id: 'd-people', name: 'People', icon: 'users', color: '#B4467A', desc: 'Policies, benefits, travel and onboarding.' }, { id: 't-travel', name: 'Travel & expenses', parent: 'd-people' }, { id: 't-leave', name: 'Leave & benefits', parent: 'd-people' }, { id: 't-conduct', name: 'Workplace & conduct', parent: 'd-people' }, { id: 't-onboarding', name: 'Onboarding', parent: 'd-people' },
      { id: 'd-sales', name: 'Sales', icon: 'target', color: '#C2620F', desc: 'Pricing, playbooks, competitive notes and customer stories.' }, { id: 't-pricing', name: 'Pricing & discounts', parent: 'd-sales' }, { id: 't-compete', name: 'Competitive', parent: 'd-sales' }, { id: 't-stories', name: 'Customer stories', parent: 'd-sales' }, { id: 't-salesproc', name: 'Sales process', parent: 'd-sales' },
      { id: 'd-product', name: 'Product', icon: 'cpu', color: '#2F6FB5', desc: 'Product docs, APIs, releases and admin setup.' }, { id: 't-api', name: 'API & integrations', parent: 'd-product' }, { id: 't-releases', name: 'Releases', parent: 'd-product' }, { id: 't-admin', name: 'Admin & setup', parent: 'd-product' }, { id: 't-security', name: 'Security & compliance', parent: 'd-product' },
      { id: 'd-finance', name: 'Finance', icon: 'chart', color: '#0E7C66', desc: 'Approval limits, purchasing and expense claims.' }, { id: 't-approvals', name: 'Approvals', parent: 'd-finance' }, { id: 't-procure', name: 'Procurement', parent: 'd-finance' },
      { id: 'd-legal', name: 'Legal', icon: 'key', color: '#6B4FBF', desc: 'Customer and vendor agreements.' }, { id: 't-custagr', name: 'Customer agreements', parent: 'd-legal' }, { id: 't-vendagr', name: 'Vendor agreements', parent: 'd-legal' },
      { id: 'd-eng', name: 'Engineering', icon: 'terminal', color: '#1F7A8C', desc: 'Runbooks, incidents and on-call.' }, { id: 't-incidents', name: 'Incidents & on-call', parent: 'd-eng' },
    ];
    const units = { 'kb-hr': 'People Ops', 'kb-sales': 'Sales Enablement', 'kb-product': 'Product', 'kb-fin': 'Finance', 'kb-legal': 'Legal', 'kb-eng': 'Engineering' };
    D.kbs.forEach(k => { if (units[k.id]) k.unit = units[k.id]; });
    D.docs.push(mkDoc('kb-sales', 'd-sales-dup', 'Enterprise Pricing Guide (copy).pdf', { source: 'src-sales', addedBy: 'Sales Enablement', updated: ago(40 * DAY) }));
    /* Topics by name — the same rules a tagging step would apply to synced files. */
    const RULES = [
      [/travel|expense|per diem|relocation/i, 't-travel'], [/leave|benefit|holiday|wellbeing|stipend/i, 't-leave'], [/conduct|security policy|remote|performance|equipment/i, 't-conduct'], [/onboard|handbook|contractor/i, 't-onboarding'],
      [/pricing|discount|roi|proposal|procurement questionnaire/i, 't-pricing'], [/battlecard|competitive|win-loss|industry brief/i, 't-compete'], [/case study|reference list/i, 't-stories'], [/script|playbook|objection|territory|value selling|email sequences|trade show|partner|handoff|pitch|security faq|renewal/i, 't-salesproc'],
      [/api|integration|webhook|rate limits|error codes|sandbox|import/i, 't-api'], [/release|changelog|roadmap|migration/i, 't-releases'], [/sso|admin|roles|billing|notifications|reporting|search syntax|audit log|mobile|glossary|architecture/i, 't-admin'], [/retention|accessibility|uptime|sla|security/i, 't-security'],
      [/approval|reimburse/i, 't-approvals'], [/purchase|vendor onboarding/i, 't-procure'],
      [/vendor —|cloudhost|payroll/i, 't-vendagr'], [/agreement|order form|nda|addendum|sow|terms/i, 't-custagr'], [/on-call|incident|runbook/i, 't-incidents'],
    ];
    D.docs.forEach(d => {
      if (d.kb === 'kb-mine') return;
      const t = RULES.filter(([re]) => re.test(d.name)).map(([, id]) => id);
      if (t.length) d.topics = [...new Set(t)].slice(0, 2);
      d.views = views();
      if (['kb-hr', 'kb-product'].includes(d.kb) && d.status === 'ready') d.verify = V(units[d.kb], 20 + Math.round(rnd() * 60), d.id === 'd-hr-conduct' ? -12 : 120 + Math.round(rnd() * 200));
      if (d.kb === 'kb-sales' && d.status === 'ready' && !/copy|win-loss|email sequences|trade show/i.test(d.name)) d.verify = V('Sales Enablement', 15 + Math.round(rnd() * 40), /pricing|discount/i.test(d.name) ? 75 : 160);
      if (d.kb === 'kb-fin') d.verify = V('Finance', 30, 150);
      if (d.kb === 'kb-legal') d.verify = V('Legal', 12 + Math.round(rnd() * 60));
    });
    D.docs.find(d => d.id === 'd-sales-dup').dupOf = 'd-sales-0';
    meta({
      'd-hr-travel': { kind: 'policy', topics: ['t-travel'], summary: 'How to plan business travel, what Northwind pays for (flights, hotels, per diem) and how to claim it back within 30 days.', version: 6, versions: [{ v: 6, at: ago(18 * DAY), by: 'People Ops', note: 'Per diem raised to USD 75 for international trips' }, { v: 5, at: ago(380 * DAY), by: 'People Ops', note: 'High-cost city list (Appendix B) added' }, { v: 4, at: ago(760 * DAY), by: 'People Ops', note: 'Booking moved to the travel tool' }], path: 'People Ops / Policies / Travel & Expense Policy', verify: V('People Ops', 18, 165) },
      'd-hr-handbook': { kind: 'handbook', topics: ['t-onboarding', 't-conduct'], summary: 'Everything about working at Northwind in one place: hours, leave, expenses and equipment, with links to the full policies.', version: 3 },
      'd-hr-parental': { kind: 'policy', topics: ['t-leave'], summary: '20 weeks fully paid leave for primary caregivers and 6 weeks for secondary caregivers from January 1, 2026.', version: 2, versions: [{ v: 2, at: ago(3 * HOUR), by: 'People Ops', note: 'Changed at the source — not reprocessed yet' }, { v: 1, at: ago(400 * DAY), by: 'People Ops', note: '2024 guidelines' }] },
      'd-fin-approvals': { kind: 'policy', topics: ['t-approvals'], summary: 'Who approves purchases and expense claims at each amount, from budget owner to CEO.' },
      'd-fin-reimb': { kind: 'sheet', topics: ['t-approvals'], summary: 'Q3 export of pending expense claims by employee, department and category.' },
      'd-prod-3': { summary: 'Create, list and cancel orders through the REST API, with the order object and its error responses.' },
      'd-prod-4': { summary: 'Get notified when orders are placed, paid or cancelled; verify signatures and handle retries.' },
      'd-prod-5': { summary: 'How long order records, audit logs and backups are kept, and how customer data deletion works.' },
      'd-prod-6': { summary: 'Connect Okta, Entra ID or Google Workspace so people sign in with SSO, then enforce it.' },
      'd-prod-9': { summary: 'Sync customers, orders and invoices with SAP S/4HANA every 15 minutes.' },
      'd-prod-11': { summary: 'Requests per minute for each plan and what to do when you get a 429.' },
      'd-prod-12': { summary: 'What each API error code means and what to check first.' },
      'd-prod-13': { summary: 'The services behind the Northwind platform and how they stay available.' },
      'd-prod-14': { summary: 'What the product team plans to ship from July to December.' },
    });
    D.collections = [
      { id: 'col-nw-newhire', name: 'New hire essentials', desc: 'Read these in your first week.', owner: 'u-an', share: 'workspace', featured: true, created: ago(40 * DAY), updated: ago(5 * DAY),
        items: [{ doc: 'd-hr-handbook', note: 'Start here.' }, { doc: 'd-hr-conduct' }, { doc: 'd-hr-travel', note: 'Before your first trip.' }, { doc: 'd-hr-security' }, { doc: 'd-hr-contractor', note: 'Only if you manage contractors.' }, { doc: 'd-hr-equip' }] },
      { id: 'col-nw-acme', name: 'Acme renewal prep', desc: 'For the Q4 renewal call.', owner: 'u-minh', share: 'private', created: ago(6 * DAY), updated: ago(1 * DAY),
        items: [{ doc: 'd-sales-0', note: 'Tiers on page 3.' }, { doc: 'd-sales-15' }, { doc: 'd-sales-1' }, { doc: 'd-sales-10' }, { doc: 'd-legal-0', note: 'Renewal terms — need access.' }] },
    ];
    D.saved = { 'u-minh': ['d-hr-travel', 'd-sales-0', 'd-sales-15'], 'u-linh': ['d-hr-parental'] };
    D.recent = { 'u-minh': [{ doc: 'd-hr-travel', at: ago(35 * MIN) }, { doc: 'd-sales-0', at: ago(26 * HOUR) }, { doc: 'd-hr-handbook', at: ago(2 * DAY) }, { doc: 'd-fin-approvals', at: ago(3 * DAY) }], 'u-linh': [{ doc: 'd-hr-parental', at: ago(2 * HOUR) }, { doc: 'd-hr-onboard', at: ago(3 * HOUR) }] };
    D.views = { 'u-minh': [{ id: 'vw-nw-1', name: 'Verified sales material', query: 'topic=d-sales&trust=verified', created: ago(9 * DAY) }] };
    D.dupDismissed = [];
    D.featured = ['d-hr-travel', 'd-sales-0', 'd-hr-handbook', 'd-fin-approvals', 'd-hr-parental', 'd-prod-6'];
  });

  /* ═══════════════════════════ Finx Workspace (Enterprise with spaces) ═══════════════════════════ */
  seedWorkspace('ws-finx', () => {
    D.topics = [
      { id: 'd-eng', name: 'Engineering & Architecture', icon: 'cpu', color: '#2F6FB5', desc: 'Architecture decisions, APIs, reliability and developer tooling.' },
      { id: 't-arch', name: 'Architecture decisions', parent: 'd-eng' }, { id: 't-api', name: 'APIs & integrations', parent: 'd-eng' }, { id: 't-reliability', name: 'Reliability & on-call', parent: 'd-eng' }, { id: 't-cloud', name: 'Cloud & infrastructure', parent: 'd-eng' }, { id: 't-devex', name: 'Developer tooling', parent: 'd-eng' },
      { id: 'd-data', name: 'Data Platform & Analytics', icon: 'database', color: '#6B4FBF', desc: 'Warehouse tables, metric definitions, models and data governance.' },
      { id: 't-dwh', name: 'Warehouse & pipelines', parent: 'd-data' }, { id: 't-metrics', name: 'Metrics & definitions', parent: 'd-data' }, { id: 't-models', name: 'Fraud & credit models', parent: 'd-data' }, { id: 't-datagov', name: 'Data governance', parent: 'd-data' },
      { id: 'd-ops', name: 'Banking Operations', icon: 'building', color: '#C2620F', desc: 'Cut-off times, settlement, reconciliation, disputes and KYC.' },
      { id: 't-payments', name: 'Payments & settlement', parent: 'd-ops' }, { id: 't-recon', name: 'Reconciliation', parent: 'd-ops' }, { id: 't-cards', name: 'Cards & disputes', parent: 'd-ops' }, { id: 't-kyc', name: 'KYC & onboarding', parent: 'd-ops' },
      { id: 'd-sec', name: 'Security & Compliance', icon: 'shield', color: '#A23B3B', desc: 'Security policies, PCI DSS, SBV regulations, privacy and incidents.' },
      { id: 't-infosec', name: 'Information security', parent: 'd-sec' }, { id: 't-pci', name: 'PCI DSS', parent: 'd-sec' }, { id: 't-regulatory', name: 'SBV regulations', parent: 'd-sec' }, { id: 't-privacy', name: 'Privacy & data protection', parent: 'd-sec' }, { id: 't-incident', name: 'Incident response', parent: 'd-sec' },
      { id: 'd-product', name: 'Product & Business', icon: 'target', color: '#0E7C66', desc: 'Roadmap, PRDs, pricing, customers and partners.' },
      { id: 't-roadmap', name: 'Roadmap & strategy', parent: 'd-product' }, { id: 't-pricing', name: 'Pricing & fees', parent: 'd-product' }, { id: 't-customers', name: 'Customers & market', parent: 'd-product' }, { id: 't-partners', name: 'Partners', parent: 'd-product' },
      { id: 'd-people', name: 'Internal Policies & Guidelines', icon: 'users', color: '#B4467A', desc: 'Leave, travel, conduct, hybrid work and onboarding.' },
      { id: 't-hr', name: 'Leave & benefits', parent: 'd-people' }, { id: 't-travel', name: 'Travel & expenses', parent: 'd-people' }, { id: 't-conduct', name: 'Code of conduct', parent: 'd-people' }, { id: 't-hybrid', name: 'Hybrid work', parent: 'd-people' }, { id: 't-onboarding', name: 'Onboarding', parent: 'd-people' },
    ];
    const UNIT = { 'kb-fx-eng': 'Platform Engineering', 'kb-fx-pay': 'Payments Platform', 'kb-fx-data': 'Data Platform', 'kb-fx-ops': 'Banking Operations', 'kb-fx-sec': 'Risk & Compliance', 'kb-fx-prod': 'Product', 'kb-fx-pol': 'People & Culture', 'kb-fx-lead': 'Finance' };
    const KB_TOPICS = { 'kb-fx-eng': ['t-arch'], 'kb-fx-pay': ['t-payments'], 'kb-fx-data': ['t-dwh'], 'kb-fx-ops': ['t-payments'], 'kb-fx-sec': ['t-infosec'], 'kb-fx-prod': ['t-roadmap'], 'kb-fx-pol': ['t-hr'], 'kb-fx-lead': ['t-roadmap'] };
    D.kbs.forEach(k => { if (UNIT[k.id]) Object.assign(k, { unit: UNIT[k.id], topics: KB_TOPICS[k.id] }); });
    const ARB = 'Architecture Review Board', GRC = 'Risk & Compliance', OPS = 'Banking Operations', PAY = 'Payments Platform', DATA = 'Data Platform', PPL = 'People & Culture';

    /* ── Key documents: type, topics, trust, versions, summaries ── */
    meta({
      'fx-sec-access': { kind: 'policy', topics: ['t-infosec', 't-pci'], version: 4, verify: V(GRC, 32, 150), views: 1840, contexts: ['sp-itsd'], path: 'Risk & Compliance / Published policies / Access Control Policy.pdf',
        summary: 'Who gets access to Finx systems and how: least privilege, just-in-time production access with a change ticket, Secure Coding training first, and quarterly access reviews.',
        versions: [{ v: 4, at: P(32), by: 'Võ Thị Lan', note: 'Standing production access removed; just-in-time access for up to 8 hours' }, { v: 3, at: P(400), by: 'Võ Thị Lan', note: 'Quarterly access reviews for every tier-1 system' }, { v: 2, at: P(760), by: GRC, note: 'MFA required for all administrative access' }] },
      'fx-sec-incident': { kind: 'policy', topics: ['t-incident', 't-regulatory'], version: 3, verify: V(GRC, 48, 130), views: 1210, contexts: ['sp-pay'], path: 'Risk & Compliance / Published policies / Incident Response Plan.pdf',
        summary: 'Severity levels, who declares and leads an incident, how to communicate, SBV notification when customer funds are affected, and postmortems.',
        versions: [{ v: 3, at: P(48), by: 'Võ Thị Lan', note: 'SBV notification within 24 hours when customer funds are affected' }, { v: 2, at: P(420), by: GRC, note: 'Sev 1 must be declared within 15 minutes' }] },
      'fx-sec-privacy': { kind: 'policy', topics: ['t-privacy', 't-datagov'], version: 2, verify: V(GRC, 61, 120), views: 690, path: 'Risk & Compliance / Published policies / Customer Data Protection Standard.pdf',
        summary: 'How customer personal data is protected: masking by default outside production, PII access requests, retention and Decree 13 obligations.' },
      'fx-sec-pci': { kind: 'sheet', topics: ['t-pci'], verify: V(GRC, 9, 80), views: 310, path: 'Risk & Compliance / Controls / PCI DSS v4.0 control matrix.xlsx', summary: 'Every PCI DSS v4.0 requirement mapped to Finx controls, owners and evidence for the 2026 assessment.' },
      'fx-sec-vendor': { kind: 'policy', topics: ['t-infosec', 't-partners'], verify: V(GRC, 95, -5), views: 240, contexts: ['sp-itsd'], summary: 'Risk assessment for vendors and SaaS tools, stricter for anything that stores customer or card data.' },
      'fx-sec-exception': { kind: 'procedure', topics: ['t-infosec'], verify: V(GRC, 140, 40), views: 120, summary: 'How to ask for a time-limited exception to a security or data policy and who signs it off.' },
      'fx-ops-cutoff': { kind: 'procedure', topics: ['t-payments', 't-recon'], version: 5, verify: V(OPS, 21, 70), views: 1320, path: 'Banking Operations / Procedures / Payment Cut-off Times & Settlement Windows.pdf',
        summary: 'Cut-off times for NAPAS 247, batch, card and QR settlement, and what happens to transfers submitted after them.',
        versions: [{ v: 5, at: P(21), by: 'Lâm Bảo Ngọc', note: 'Batch cut-off moved from 16:00 to 15:30' }, { v: 4, at: P(390), by: OPS, note: 'NAPAS 247 transfer limits updated' }] },
      'fx-ops-dispute': { kind: 'procedure', topics: ['t-cards'], version: 3, verify: V(OPS, 74, 100), views: 540, summary: 'Handling cardholder disputes and chargebacks: acknowledgement and resolution deadlines, evidence and scheme timelines.' },
      'fx-ops-recon': { kind: 'procedure', topics: ['t-recon'], verify: V(OPS, 11, 160), views: 610, summary: 'Daily matching of the ledger against NAPAS, acquirer and bank statement files, and how to clear breaks.' },
      'fx-eng-adr031': { kind: 'spec', topics: ['t-api', 't-payments'], owner: ARB, verify: V(ARB, 140, null), views: 980, contexts: ['sp-pay'], path: 'ENG / Architecture decisions / ADR-031',
        summary: 'Payment APIs require an Idempotency-Key header on every POST; the gateway replays the first response for 24 hours.' },
      'fx-eng-adr027': { kind: 'spec', topics: ['t-arch', 't-payments'], owner: ARB, verify: V(ARB, 205, null), views: 720, path: 'ENG / Architecture decisions / ADR-027',
        summary: 'The ledger updates balances only from payment events, never from direct writes. Supersedes ADR-008.' },
      'fx-eng-handbook': { kind: 'handbook', topics: ['t-devex', 't-onboarding'], version: 3, verify: V('Platform Engineering', 58, 120), views: 1150, path: 'ENG / Handbook / Engineering Handbook 2026',
        summary: 'How engineering works at Finx: teams, on-call, code review, releases, security and career growth.',
        versions: [{ v: 3, at: P(58), by: 'Lê Thu Hà', note: '2026 edition: just-in-time production access and new on-call rules' }, { v: 2, at: P(420), by: 'Platform Engineering', note: '2025 edition' }] },
      'fx-eng-eval-kafka': { kind: 'report', topics: ['t-arch', 't-cloud'], views: 86, summary: 'Load test, exactly-once semantics, operations effort, data residency and three-year cost of Confluent Cloud.' },
      'fx-eng-eval-pulsar': { kind: 'report', topics: ['t-arch', 't-cloud'], views: 71, summary: 'Load test, exactly-once semantics, operations effort, data residency and three-year cost of self-hosted Apache Pulsar.' },
      'fx-eng-eval-msk': { kind: 'report', topics: ['t-arch', 't-cloud'], views: 64, summary: 'Load test, exactly-once semantics, operations effort, data residency and three-year cost of Amazon MSK.' },
      'fx-pay-runbook': { kind: 'procedure', topics: ['t-reliability', 't-payments'], version: 7, verify: V(PAY, 16, 74), views: 860, path: 'finx/payments-docs / docs/runbooks/gateway-timeouts.md',
        summary: 'Detect payment gateway timeouts, fail over card authorization to the secondary acquirer and recover.',
        versions: [{ v: 7, at: P(16), by: 'Đặng Quốc Huy', note: 'Dashboard links updated after the failover drill' }, { v: 6, at: P(60), by: 'Lê Thu Hà', note: 'Failover threshold set to 2% for 5 minutes' }] },
      'fx-pay-api': { kind: 'spec', topics: ['t-api', 't-payments'], version: 3, verify: V(PAY, 27, 150), views: 770, path: 'finx/payments-docs / docs/api/v3/reference.md', summary: 'Endpoints, authentication, idempotency and errors for Payments API v3.' },
      'fx-pay-postmortem': { kind: 'report', topics: ['t-incident', 't-payments'], verify: V(PAY, 14, null), views: 430, path: 'finx/payments-docs / docs/postmortems/2026-10-14-qr-outage.md', summary: 'QR payments failed for 47 minutes on 14 October after the callback queue filled up: timeline, causes and actions.' },
      'fx-data-mau': { kind: 'spec', topics: ['t-metrics'], version: 2, verify: V(DATA, 44, 140), views: 910, path: 'DATA / Metrics / Active customers',
        summary: 'The official definition of monthly active customers: at least one customer-initiated financial transaction in the calendar month; logins don’t count.',
        versions: [{ v: 2, at: P(44), by: 'Phạm Quốc Bảo', note: 'Logins no longer count as activity' }, { v: 1, at: P(330), by: DATA, note: 'First definition' }] },
      'fx-data-dict': { kind: 'sheet', topics: ['t-dwh', 't-datagov'], verify: V(DATA, 6, 90), views: 640, summary: 'Every table and column in the core banking warehouse with owner, tier and masking.' },
      'fx-data-fraud': { kind: 'report', topics: ['t-models'], version: 2, verify: V(DATA, 8, 180), views: 280, summary: 'Fraud model v2: purpose, training data, performance against v1, monitoring and known limits.' },
      'fx-prod-roadmap': { kind: 'playbook', topics: ['t-roadmap'], verify: V('Product', 18, 60), views: 1060, path: 'Shared drives / Product / Published / Roadmap / Product roadmap H1 2027.pptx', summary: 'What Finx plans to ship in H1 2027: scheduled transfers, SME virtual cards, instant eKYC and cross-border QR.' },
      'fx-prod-pricing': { kind: 'policy', topics: ['t-pricing'], verify: V('Product', 25, 100), views: 690, summary: 'Customer and merchant fees from 1 January 2027, including transfer, card and QR fees.' },
      'fx-pol-hybrid': { kind: 'policy', topics: ['t-hybrid'], version: 2, verify: V(PPL, 90, 30), views: 1490, path: 'People & Culture / Policies / Hybrid Work Policy.pdf',
        summary: 'At least three office days a week, with Tuesday and Thursday as team days, and how to ask for an exception.',
        versions: [{ v: 2, at: P(90), by: 'Mai Khánh An', note: 'Three office days a week; Tuesday and Thursday are team days' }, { v: 1, at: P(500), by: PPL, note: 'Two office days a week' }] },
      'fx-pol-travel': { kind: 'policy', topics: ['t-travel'], verify: V(PPL, 120, -14), views: 820, summary: 'Booking business travel, per diems, what Finx pays for and claiming expenses within 30 days.' },
      'fx-pol-onboarding': { kind: 'guide', topics: ['t-onboarding'], verify: V(PPL, 40, 200), views: 1270, summary: 'Your first month at Finx: accounts, trainings, people to meet and where to find things.' },
      'fx-lead-budget': { kind: 'sheet', topics: ['t-roadmap'], views: 42, summary: 'FY2027 operating and capital budget by department, approved by the board.' },
    });

    /* ── The wider catalog: what each knowledge base holds after a few years of real use ──
       row = [name, kind, topics, summary?, opts?]; opts: id, upd (days ago), due (verification due in days; null = no expiry),
       verify:false, by, owner, vi, status, error, dupOf, dupReason, contexts, pages. */
    const SRC = { 'kb-fx-eng': ['src-fx-eng', 'Engineering wiki'], 'kb-fx-pay': ['src-fx-pay', 'payments-docs'], 'kb-fx-data': ['src-fx-data', 'Data space'], 'kb-fx-ops': ['src-fx-ops', 'Operations procedures'], 'kb-fx-sec': ['src-fx-sec', 'GRC policies'], 'kb-fx-prod': ['src-fx-prod', 'Product shared drive'], 'kb-fx-pol': ['src-fx-pol', 'People policies'], 'kb-fx-lead': ['upload', 'Lý Thanh Tùng'] };
    const PAGES = { xlsx: [1, 1], md: [2, 7], pdf: [4, 28], pptx: [10, 26], docx: [3, 12] };
    const seq = {};
    const gen = (kb, rows) => rows.forEach(([name, kind, topics, summary = '', o = {}]) => {
      const id = o.id || `${kb.slice(3)}-${String((seq[kb] = (seq[kb] || 0) + 1)).padStart(2, '0')}`;
      const h = hashOf(id), ext = name.split('.').pop(), [lo, hi] = PAGES[ext] || [2, 10];
      const upd = o.upd ?? 4 + (h % 260), [src, from] = SRC[kb];
      const d = mkDoc(kb, id, name, { source: src, addedBy: from, pages: o.pages || lo + (h % (hi - lo + 1)), updated: P(upd, h % 9), status: o.status, error: o.error });
      const due = o.due !== undefined ? o.due : h % 13 === 5 ? -(3 + (h % 40)) : 60 + (h % 300);
      const verified = o.verify !== false && (o.verify === true || h % 8 !== 3);
      Object.assign(d, { kind, topics: topics.split(' '), views: views(),
        ...(summary ? { summary } : {}), ...(o.vi ? { lang: 'vi' } : {}), ...(o.owner ? { owner: o.owner } : {}), ...(o.contexts ? { contexts: o.contexts } : {}),
        ...(verified ? { verify: V(o.by || o.owner || UNIT[kb], upd, due) } : {}), ...(o.dupOf ? { dupOf: o.dupOf, dupReason: o.dupReason } : {}) });
      D.docs.push(d);
    });

    /* Architecture decision records (Confluence). Older ones are superseded but kept for history. */
    const ADRS = [
      [1, 'Use PostgreSQL for transactional services', 't-arch t-cloud', 'PostgreSQL is the default database for services that move money; exceptions need an ADR.'],
      [2, 'Run services on Kubernetes', 't-cloud', 'Stateless services run on the shared Kubernetes platform in both data centers.'],
      [3, 'gRPC for internal service calls', 't-api', 'Internal synchronous calls use gRPC with protobuf contracts; REST stays at the edge.'],
      [4, 'Trunk-based development', 't-devex', 'Short-lived branches merged to main at least daily, behind feature flags when unfinished.'],
      [5, 'OpenAPI-first public APIs', 't-api', 'Public and partner APIs are designed in OpenAPI before code and reviewed by the API guild.'],
      [7, 'Secrets in HashiCorp Vault', 't-cloud t-infosec', 'Secrets live in Vault with short-lived credentials; never in repositories or images.'],
      [8, 'Synchronous ledger writes from the gateway', 't-arch', 'Superseded by ADR-027. Kept for history.', { verify: false }],
      [9, 'Structured logging with OpenTelemetry', 't-reliability', 'JSON logs, traces and metrics through OpenTelemetry; card numbers and personal data are never logged.'],
      [11, 'Feature flags with Unleash', 't-devex', 'Feature flags live in Unleash; flags older than 90 days are removed.'],
      [12, 'Transactional outbox for events', 't-arch', 'Services publish events through an outbox table so a commit and its event never diverge.', { id: 'fx-eng-adr012' }],
      [14, 'Money as integer minor units', 't-arch t-payments', 'Amounts are integers in the minor unit with an ISO 4217 currency code; never floats.'],
      [15, 'UTC timestamps everywhere', 't-arch', 'Store and exchange timestamps in UTC; convert to Asia/Ho_Chi_Minh only for display and cut-offs.'],
      [17, 'Service ownership and on-call', 't-reliability', 'Every production service has one owning team that carries its pager.'],
      [18, 'Shared database for ledger and accounts', 't-arch', 'Superseded by ADR-023. Kept for history.', { verify: false }],
      [19, 'Kafka topic naming', 't-arch', 'Topics are named domain.entity.event.v1; breaking changes get a new version.'],
      [21, 'Rate limiting at the API gateway', 't-api', 'Per-client rate limits at the gateway, answering 429 with Retry-After.'],
      [22, 'Mutual TLS between services', 't-infosec t-cloud', 'Service-to-service traffic uses mTLS with certificates from the internal CA.'],
      [23, 'Database per service', 't-arch', 'Services own their data; no shared schemas or cross-service joins.'],
      [24, 'Sagas for cross-service transfers', 't-arch t-payments', 'Multi-step transfers use orchestrated sagas with compensating actions.', { id: 'fx-eng-adr024' }],
      [25, 'Schema registry for events', 't-arch t-api', 'Event schemas are registered and checked for backward compatibility in CI.'],
      [26, 'Blue-green deploys for the payment gateway', 't-reliability', 'The gateway deploys blue-green with automatic rollback on error-rate alerts.'],
      [28, 'Read replicas for reporting queries', 't-arch t-dwh', 'Reporting reads go to replicas or the warehouse, never to the primary.'],
      [29, 'Card data tokenization service', 't-pci t-arch', 'Card numbers are tokenized at entry so only the vault service is in PCI scope.'],
      [30, 'Multi-AZ for core banking', 't-cloud t-reliability', 'Core banking runs active-passive across two availability zones with an RPO under one minute.'],
      [32, 'Retire SOAP adapters for partner banks', 't-api t-partners', 'Partner bank integrations move from SOAP to REST by Q2 2027.'],
      [33, 'Retry budgets for outbound calls', 't-reliability', 'Clients cap retries at 10% of requests and back off exponentially with jitter.'],
      [34, 'Consumer-driven contract tests', 't-devex t-api', 'Service contracts are verified with Pact in CI before deploy.'],
      [35, 'Terraform for all infrastructure', 't-cloud', 'Infrastructure changes go through Terraform and code review; no console changes.'],
      [36, 'Go for new payment services', 't-devex', 'New payment services are written in Go; existing Java services stay as they are.'],
      [37, 'Redis only as a cache', 't-arch', 'Redis holds rebuildable data only; nothing in Redis is a system of record.'],
      [38, 'Seven-day event retention', 't-arch', 'Topics keep events for 7 days; longer history comes from the warehouse.'],
      [39, 'Customer ID format', 't-arch t-kyc', 'Customer IDs are opaque 16-character strings; national ID numbers are never used as keys.'],
      [40, 'Data contracts with the data platform', 't-datagov t-dwh', 'Producers publish a data contract for every table the warehouse ingests.'],
      [41, 'Move batch jobs to Airflow', 't-arch t-dwh', 'Batch jobs leave the legacy scheduler for Airflow during CBM wave 2.'],
    ];
    gen('kb-fx-eng', ADRS.map(([n, title, topics, summary, o = {}]) => {
      const num = String(n).padStart(3, '0');
      return [`ADR-${num} — ${title}.md`, 'spec', topics, summary, { id: 'fx-eng-adr' + num, upd: 30 + (42 - n) * 14, due: null, owner: ARB, ...o }];
    }));
    gen('kb-fx-eng', [
      ['Code review guidelines.md', 'guide', 't-devex', 'Two approvals for payment services, one elsewhere; what reviewers check and how fast.'],
      ['Local development setup.md', 'guide', 't-devex t-onboarding', 'Laptop setup, the Docker Compose stack and test data for a first commit on day one.'],
      ['Hướng dẫn thiết lập môi trường phát triển.md', 'guide', 't-devex t-onboarding', 'Bản tiếng Việt của hướng dẫn cài đặt môi trường phát triển cho kỹ sư mới.', { vi: true }],
      ['CI/CD pipeline guide.md', 'guide', 't-devex', 'Pipeline stages, required checks and how a merge reaches production.'],
      ['On-call handbook.md', 'handbook', 't-reliability t-incident', 'Rotations, handover, paging rules and what to do in the first 15 minutes.', { id: 'fx-eng-oncall' }],
      ['Severity levels & escalation matrix.md', 'policy', 't-incident t-reliability', 'How to classify SEV1–SEV4 incidents and whom to page for each.', { id: 'fx-eng-sev' }],
      ['Service catalog.xlsx', 'sheet', 't-arch', 'Every production service with its owning team, tier, runbook and dashboards.'],
      ['Kubernetes deployment guide.md', 'guide', 't-cloud', 'Helm charts, resource limits and progressive rollouts on the shared cluster.'],
      ['Terraform module standards.md', 'spec', 't-cloud', 'Module layout, naming, tagging and review rules for Terraform.'],
      ['Observability standards.md', 'spec', 't-reliability', 'Required metrics, log fields, trace propagation and dashboard templates.'],
      ['SLO definitions — payment services.md', 'spec', 't-reliability t-payments', 'Availability and latency targets for the gateway, transfers and QR, with error budgets.'],
      ['Secure coding checklist.md', 'form', 't-infosec t-devex', 'Input validation, secrets, logging and dependency checks for every pull request.'],
      ['API design guidelines.md', 'guide', 't-api', 'Resource naming, pagination, errors, versioning and idempotency for Finx APIs.', { id: 'fx-eng-apiguide' }],
      ['API design guidelines — old wiki copy.md', 'guide', 't-api', '', { verify: false, upd: 410, dupOf: 'fx-eng-apiguide', dupReason: '93% the same text — copied from the old wiki' }],
      ['Error code catalogue — public APIs.md', 'spec', 't-api', 'Every public error code with its HTTP status, meaning and what the client should do.'],
      ['Load testing playbook.md', 'playbook', 't-reliability', 'Running k6 load tests against staging before peak sales such as 9.9 and 11.11.'],
      ['Disaster recovery plan — core banking.pdf', 'procedure', 't-reliability t-cloud', 'Failover steps, recovery targets and the yearly DR test for core banking.'],
      ['Architecture overview — Core Banking Modernization.pdf', 'spec', 't-arch', 'Target architecture for CBM: accounts, ledger and payments, and the strangler approach.', { id: 'fx-eng-cbmarch', upd: 35 }],
      ['CBM migration plan — wave 2.pptx', 'report', 't-arch', 'Scope, dates and rollback plan for moving the ledger read path off the legacy core.', { id: 'fx-eng-cbmplan', upd: 9 }],
      ['Engineering career ladder.pdf', 'guide', 't-devex t-onboarding', 'Levels from Engineer I to Principal and what each one expects.'],
      ['Dependency upgrade policy.md', 'policy', 't-devex t-infosec', 'Critical vulnerabilities patched within 14 days; libraries at most two major versions behind.'],
      ['Incident retrospective template.md', 'template', 't-incident t-reliability', 'The blameless postmortem template every engineering team uses.'],
      ['Tech radar — H2 2026.pdf', 'report', 't-arch t-devex', 'Technologies to adopt, trial, assess and hold, from the architecture guild.', { upd: 70 }],
      ['Hướng dẫn trực sự cố cho kỹ sư mới.md', 'guide', 't-reliability t-onboarding', 'Hướng dẫn nhanh cho kỹ sư mới tham gia lịch trực sự cố.', { vi: true }],
    ]);
    gen('kb-fx-pay', [
      ['Runbook — NAPAS 247 transfer failures.md', 'procedure', 't-payments t-reliability', 'Diagnose rejected and pending NAPAS transfers by response code, and when to call NAPAS.', { id: 'fx-pay-rb-napas' }],
      ['Runbook — QR payment callback delays.md', 'procedure', 't-payments t-reliability', 'Find stuck VietQR callbacks, replay them safely and tell affected merchants.', { id: 'fx-pay-rb-qr', upd: 13 }],
      ['Runbook — Settlement file not received.md', 'procedure', 't-payments t-recon', 'What to do when the daily NAPAS or acquirer settlement file is late or incomplete.'],
      ['Runbook — Acquirer certificate rotation.md', 'procedure', 't-payments t-infosec', 'Rotate TLS and signing certificates with each acquirer without downtime.'],
      ['Runbook — Refund queue backlog.md', 'procedure', 't-payments t-cards', 'Drain the refund queue, oldest first, without creating duplicate refunds.'],
      ['Runbook — 3-D Secure failures.md', 'procedure', 't-cards t-reliability', 'Spot issuer authentication outages and decide when to contact the card scheme.'],
      ['Runbook — Ledger consumer lag.md', 'procedure', 't-reliability', 'Scale or restart ledger consumers when lag on the payments topic grows.', { id: 'fx-pay-rb-ledger' }],
      ['Payments API v3 — Webhooks.md', 'spec', 't-api t-payments', 'Webhook events, signatures, retries and how merchants verify payloads.'],
      ['Payments API v3 — Error codes.md', 'spec', 't-api', 'Payment-specific error codes and how merchants should handle each one.'],
      ['Refunds API reference.md', 'spec', 't-api t-cards', 'Full and partial refunds, limits and when refunds settle.'],
      ['VietQR merchant API reference.md', 'spec', 't-api t-payments', 'Dynamic and static QR codes, payment notifications and reconciliation fields.'],
      ['Payouts API reference v2 (deprecated).md', 'spec', 't-api', 'Replaced by Payments API v3; kept for merchants still migrating.', { upd: 240, due: -60 }],
      ['Postmortem — NAPAS timeout spike, 2 Sep.md', 'report', 't-incident t-payments', 'Upstream latency at NAPAS caused 4% timeouts for 38 minutes, and retries doubled the load.', { upd: 55, due: null }],
      ['Postmortem — Duplicate refunds, 21 Aug.md', 'report', 't-incident t-cards', 'A retry without an idempotency key refunded 212 transactions twice; all amounts were recovered.', { upd: 68, due: null }],
      ['Postmortem — Acquirer certificate expiry, 3 Jul.md', 'report', 't-incident t-infosec', 'An expired certificate stopped card authorizations for 22 minutes.', { upd: 115, due: null }],
      ['Postmortem — Ledger lag during the 9.9 sale.md', 'report', 't-incident t-reliability', 'Balance reads competed with posting and ledger lag peaked at 11 minutes.', { upd: 48, due: null }],
      ['Design — Tokenization service v2.md', 'spec', 't-pci t-arch', 'Format-preserving tokens, key rotation and the smaller PCI scope.'],
      ['Design — Smart routing between acquirers.md', 'spec', 't-payments t-arch', 'Route card authorizations by BIN, cost and live success rate.'],
      ['Payment state machine.md', 'spec', 't-payments', 'States and allowed transitions of a payment, from created to settled or refunded.'],
      ['NAPAS settlement file format.md', 'spec', 't-payments t-recon', 'Field-by-field description of the NAPAS settlement file and its validation rules.'],
      ['Partner bank adapter guide.md', 'guide', 't-partners t-api', 'How to build and certify an adapter for a new partner bank.'],
      ['Merchant onboarding — technical checklist.md', 'form', 't-partners t-payments', 'API keys, webhooks, test cases and go-live checks for a new merchant.'],
      ['Payments on-call rota & escalation.md', 'reference', 't-reliability', 'Who is on call this quarter and how to reach acquirers and NAPAS out of hours.', { upd: 3 }],
      ['Chargeback API integration notes.md', 'notes', 't-cards t-api', '', { verify: false, upd: 6, status: 'processing' }],
    ]);
    gen('kb-fx-data', [
      ['Metric definitions — Transaction success rate.md', 'spec', 't-metrics', 'Successful over attempted payments, excluding customer cancellations and duplicates.'],
      ['Metric definitions — Payment volume (GMV).md', 'spec', 't-metrics', 'Gross value of settled payments in VND, by channel and merchant category.'],
      ['Metric definitions — Customer churn.md', 'spec', 't-metrics', 'A customer churns after 90 days without a customer-initiated financial transaction.'],
      ['Metric definitions — Fraud loss rate.md', 'spec', 't-metrics t-models', 'Confirmed fraud losses over payment volume, in basis points.', { id: 'fx-data-fraudloss' }],
      ['Metric definitions — Active customers (draft 2025).md', 'spec', 't-metrics', '', { verify: false, upd: 300, dupOf: 'fx-data-mau', dupReason: 'Same metric defined twice — an older draft' }],
      ['Table — dwh.fact_transactions.md', 'dataset', 't-dwh', 'One row per financial transaction with channel, amount, status and customer key.', { id: 'fx-data-txn' }],
      ['Table — dwh.dim_customer.md', 'dataset', 't-dwh t-privacy', 'Customer attributes with personal data masked; unmasked columns need a PII access request.'],
      ['Table — dwh.fact_card_auth.md', 'dataset', 't-dwh t-cards', 'Card authorization attempts with response codes and acquirer.'],
      ['Table — dwh.fact_settlement.md', 'dataset', 't-dwh t-recon', 'Settlement status per transaction from NAPAS and acquirer files.', { id: 'fx-data-settle', upd: 7 }],
      ['Table — mart.daily_kpis.md', 'dataset', 't-dwh t-metrics', 'Daily company KPIs behind the leadership dashboard.'],
      ['Dashboard guide — Payments health.md', 'guide', 't-metrics t-payments', 'What each tile on the payments health dashboard means and when to worry.'],
      ['Dashboard guide — Fraud monitoring.md', 'guide', 't-models', 'Alerts, rule hits and model scores on the fraud monitoring dashboard.', { id: 'fx-data-dashfraud' }],
      ['Dashboard guide — SBV regulatory reporting.md', 'guide', 't-regulatory t-metrics', 'How the monthly SBV payment statistics are produced and checked.'],
      ['dbt style guide.md', 'guide', 't-dwh', 'Naming, layering, tests and documentation rules for dbt models.', { id: 'fx-data-dbt', upd: 150 }],
      ['Data quality checks — standard.md', 'spec', 't-datagov t-dwh', 'Required freshness, volume and uniqueness tests for tier-1 tables.'],
      ['Airflow DAG conventions.md', 'guide', 't-dwh', 'DAG naming, retries, SLAs and alerting for pipelines.'],
      ['Data access tiers & masking.md', 'policy', 't-datagov t-privacy', 'Four data tiers, who can see each and how masking works in the warehouse.'],
      ['Data retention schedule.xlsx', 'sheet', 't-datagov t-regulatory', 'How long each data category is kept and the legal basis for it.'],
      ['Credit scoring model v3 — Model card.pdf', 'report', 't-models', 'Purpose, features, validation results and limits of the consumer credit score.'],
      ['Fraud model v1 — Model card (retired).pdf', 'report', 't-models', 'Retired in September 2026 and replaced by fraud model v2.', { id: 'fx-data-fraudv1', upd: 400, due: -120 }],
      ['Model risk management standard.pdf', 'policy', 't-models t-datagov', 'Validation, monitoring and approval rules for every model used in decisions.', { id: 'fx-data-mrm' }],
      ['Feature store guide.md', 'guide', 't-models t-dwh', 'How to register, version and serve features for models.'],
      ['Hướng dẫn lập báo cáo giao dịch hằng tháng.md', 'guide', 't-metrics t-regulatory', 'Các bước lập báo cáo thống kê giao dịch thanh toán hằng tháng gửi Ngân hàng Nhà nước.', { vi: true }],
      ['SBV monthly payment statistics — report spec.md', 'spec', 't-regulatory t-dwh', 'Tables, fields and validation rules for the monthly payment statistics sent to the SBV.'],
    ]);
    gen('kb-fx-ops', [
      ['SOP — Failed NAPAS transfer investigation.pdf', 'procedure', 't-payments', 'Trace a failed or pending interbank transfer and answer the customer.'],
      ['SOP — Chargeback evidence pack.pdf', 'procedure', 't-cards', 'What to collect for each Visa and Mastercard reason code before responding.'],
      ['SOP — Refund approval limits.pdf', 'procedure', 't-cards t-payments', 'Who can approve refunds at each amount and what needs a second approver.'],
      ['SOP — KYC document review.pdf', 'procedure', 't-kyc', 'Checks for chip ID cards (CCCD), selfies and proof of address.'],
      ['SOP — eKYC manual review queue.pdf', 'procedure', 't-kyc', 'Working the eKYC exceptions queue within the 4-hour target.'],
      ['SOP — Account closure.pdf', 'procedure', 't-kyc', 'Closing an account: balance payout, card cancellation and record retention.'],
      ['SOP — Suspicious transaction escalation.pdf', 'procedure', 't-kyc t-regulatory', 'When and how to escalate a suspicious transaction to the AML team.'],
      ['SOP — Card replacement & PIN reset.pdf', 'procedure', 't-cards', 'Replacing lost, stolen or damaged cards and resetting PINs safely.'],
      ['SOP — Merchant settlement exceptions.pdf', 'procedure', 't-recon t-payments', 'Handling short, late or duplicate merchant settlements.'],
      ['SOP — End-of-day balancing.pdf', 'procedure', 't-recon', 'Balancing nostro accounts against the ledger at the end of each business day.'],
      ['Quy trình đối soát giao dịch NAPAS.pdf', 'procedure', 't-recon', 'Quy trình đối soát giao dịch chuyển khoản liên ngân hàng NAPAS hằng ngày.', { vi: true }],
      ['Quy trình xử lý tra soát, khiếu nại thẻ.pdf', 'procedure', 't-cards', 'Quy trình tiếp nhận và xử lý tra soát, khiếu nại giao dịch thẻ.', { vi: true }],
      ['Settlement holiday calendar 2027.xlsx', 'calendar', 't-payments t-recon', 'Days without batch settlement in 2027, including the Lunar New Year break.', { upd: 20 }],
      ['Dispute reason codes — Visa & Mastercard.xlsx', 'sheet', 't-cards', 'Reason codes, time limits and required evidence by card scheme.'],
      ['KYC risk rating matrix.xlsx', 'sheet', 't-kyc', 'Risk scores by customer type, occupation and channel.'],
      ['Customer complaint handling procedure.pdf', 'procedure', 't-customers t-cards', 'Logging, routing and answering complaints within the regulatory deadlines.'],
      ['Operations escalation contacts.pdf', 'reference', 't-payments', 'Who to call at NAPAS, acquirers and partner banks, by issue.', { upd: 5 }],
      ['Daily operations checklist.docx', 'form', 't-recon', 'Morning and evening checks for the operations floor.'],
      ['Payment cut-off times (2025).pdf', 'procedure', 't-payments', '', { upd: 380, due: -200, dupOf: 'fx-ops-cutoff', dupReason: 'Older copy of the same cut-off table' }],
      ['Signed dispute forms — scanned 2019.pdf', 'form', 't-cards', '', { id: 'fx-ops-scan', verify: false, upd: 0, status: 'failed', error: 'This file has no readable text. It may be a scanned image.' }],
    ]);
    gen('kb-fx-sec', [
      ['Information Security Policy.pdf', 'policy', 't-infosec', 'The top-level security policy: roles, principles and the standards under it.', { verify: true }],
      ['Acceptable Use Policy.pdf', 'policy', 't-infosec t-conduct', 'What staff may and may not do with Finx systems, accounts and data.'],
      ['Password & Authentication Standard.pdf', 'policy', 't-infosec', 'Passphrase rules, MFA everywhere and hardware keys for administrators.'],
      ['Encryption & Key Management Standard.pdf', 'policy', 't-infosec t-pci', 'Approved algorithms, key lengths, HSM use and key rotation.'],
      ['Logging & Monitoring Standard.pdf', 'policy', 't-infosec', 'What must be logged, how long logs are kept and who reviews alerts.'],
      ['Vulnerability Management Standard.pdf', 'policy', 't-infosec', 'Scanning cadence and fix deadlines: critical within 14 days, high within 30.'],
      ['Data Classification Standard.pdf', 'policy', 't-privacy t-datagov', 'Public, internal, confidential and restricted data, with handling rules for each.'],
      ['Secure SDLC Standard.pdf', 'policy', 't-infosec', 'Security requirements from design to release, including threat modelling.'],
      ['Change Management Policy.pdf', 'policy', 't-infosec t-reliability', 'How production changes are requested, approved, tested and rolled back.'],
      ['Business Continuity Policy.pdf', 'policy', 't-incident t-reliability', 'Critical services, recovery targets and the yearly continuity test.'],
      ['Control — AC-04 Quarterly access review.md', 'procedure', 't-infosec t-pci', 'How system owners run and evidence the quarterly access review.', { id: 'fx-sec-ac04', upd: 15 }],
      ['Control — CM-02 Production change approval.md', 'procedure', 't-infosec', 'Evidence that every production change had an approved ticket.'],
      ['Control — LM-01 Centralised logging.md', 'procedure', 't-infosec t-pci', 'Log sources, retention and the daily review for in-scope systems.', { id: 'fx-sec-lm01' }],
      ['Control — VM-03 Critical patches within 14 days.md', 'procedure', 't-infosec', 'Tracking and evidencing critical patches across servers and laptops.'],
      ['Audit evidence — Q3 2026 access review sign-off.pdf', 'report', 't-pci t-infosec', 'Signed results of the Q3 access review for every tier-1 system.', { id: 'fx-sec-ev-q3', upd: 30, due: null }],
      ['Penetration test 2026 — summary.pdf', 'report', 't-infosec', 'Findings and fixes from the 2026 external penetration test.', { id: 'fx-sec-pentest', upd: 60, due: null }],
      ['PCI DSS v4.0 — Scope & cardholder data flows.pdf', 'reference', 't-pci', 'Which systems are in PCI scope and how card data moves through them.', { id: 'fx-sec-scope', upd: 25 }],
      ['PCI DSS — Report on Compliance 2026 (summary).pdf', 'report', 't-pci', 'Summary of the 2026 assessment: compliant, with two compensating controls.', { upd: 200, due: null }],
      ['PCI DSS — Requirement 8 implementation notes.md', 'notes', 't-pci', 'How Finx meets the identification and authentication requirements.'],
      ['SBV Circular 09/2020 — Information system security (summary).pdf', 'reference', 't-regulatory t-infosec', 'Plain-language summary of the SBV rules on information system security for banks.'],
      ['SBV Circular 18/2024 — Bank card operations (summary).pdf', 'reference', 't-regulatory t-cards', 'What the card circular requires for issuing, using and handling card disputes.'],
      ['SBV Circular 50/2024 — Online service safety (summary).pdf', 'reference', 't-regulatory', 'Requirements for authentication and fraud prevention in online banking.'],
      ['Decree 13/2023 — Personal data protection (summary).pdf', 'reference', 't-privacy t-regulatory', 'Consent, data subject rights and impact assessments under Decree 13.'],
      ['Tóm tắt Thông tư 09/2020/TT-NHNN về an toàn hệ thống thông tin.pdf', 'reference', 't-regulatory t-infosec', 'Tóm tắt các yêu cầu chính của Thông tư 09/2020/TT-NHNN.', { vi: true }],
      ['Nghị định 13/2023 — Hướng dẫn áp dụng nội bộ.pdf', 'guide', 't-privacy', 'Hướng dẫn áp dụng Nghị định 13/2023 về bảo vệ dữ liệu cá nhân tại Finx.', { vi: true }],
      ['AML obligations — summary of the 2022 law.pdf', 'reference', 't-regulatory t-kyc', 'Customer due diligence, reporting thresholds and record keeping.'],
      ['Regulatory reporting calendar 2027.xlsx', 'calendar', 't-regulatory', 'Every report Finx sends to the SBV in 2027, with owners and deadlines.', { upd: 12 }],
      ['Security incident report template.docx', 'template', 't-incident', 'The form used to record and report a security incident.'],
      ['Tabletop exercise — ransomware, Sep 2026.pdf', 'report', 't-incident', 'Findings from the September ransomware exercise and the follow-up actions.', { upd: 40, due: null }],
      ['Phishing simulation results — Q3 2026.pdf', 'report', 't-infosec', 'Click and report rates by department from the Q3 phishing simulation.', { upd: 33, due: null }],
    ]);
    gen('kb-fx-prod', [
      ['PRD — Scheduled transfers.docx', 'spec', 't-roadmap t-payments', 'Let customers schedule one-off and recurring transfers, including NAPAS 247.'],
      ['PRD — Split bill in QR payments.docx', 'spec', 't-roadmap t-payments', 'Split a QR payment between friends with one tap after paying.'],
      ['PRD — Virtual cards for SMEs.docx', 'spec', 't-roadmap t-cards', 'Instant virtual cards with spending limits for small business teams.'],
      ['PRD — Instant account opening with eKYC.docx', 'spec', 't-roadmap t-kyc', 'Open an account in under five minutes with chip ID reading and face match.'],
      ['PRD — Merchant dashboard v2.docx', 'spec', 't-roadmap t-partners', 'A new merchant dashboard for payments, refunds and settlement reports.', { upd: 10 }],
      ['Brief — Buy now, pay later pilot.pdf', 'playbook', 't-roadmap t-customers', 'A three-month BNPL pilot with two electronics retailers.'],
      ['Brief — Cross-border QR with Thailand and Cambodia.pdf', 'playbook', 't-partners t-payments', 'Let Finx customers pay by QR abroad through regional QR links.'],
      ['Market sizing — SME payments in Vietnam 2027.pptx', 'report', 't-customers', 'How many SMEs accept digital payments today and what they pay for it.'],
      ['Customer research — How Gen Z banks.pdf', 'report', 't-customers', 'Interviews and survey results on how 18–25-year-olds use banking apps.'],
      ['Competitive landscape — e-wallets and digital banks.pptx', 'report', 't-customers', 'How Finx compares with the main e-wallets and digital banks.'],
      ['Partner integration guide — Merchant acquiring.pdf', 'guide', 't-partners', 'How payment partners connect to Finx acquiring, from sandbox to go-live.'],
      ['Partner integration guide — Banking as a service.pdf', 'guide', 't-partners t-api', 'Accounts, cards and transfers for partners building on Finx.'],
      ['Partner onboarding checklist.xlsx', 'form', 't-partners', 'Commercial, legal and technical steps to onboard a partner.'],
      ['Merchant discount rates 2026.xlsx', 'sheet', 't-pricing', 'Card and QR merchant discount rates by merchant category for 2026.', { upd: 300, due: -30 }],
      ['Retail account fee schedule 2026.pdf', 'policy', 't-pricing', 'Fees for retail accounts in 2026; the 2027 schedule replaces it in January.', { upd: 310, due: -45 }],
      ['Biểu phí dịch vụ khách hàng cá nhân 2027.pdf', 'policy', 't-pricing', 'Biểu phí dịch vụ áp dụng cho khách hàng cá nhân từ ngày 01/01/2027.', { vi: true, upd: 25 }],
      ['Release notes — Finx app 6.4.md', 'announcement', 't-roadmap', 'Scheduled transfers beta, faster QR scanning and accessibility fixes.', { upd: 45, verify: false }],
      ['Release notes — Finx app 6.5.md', 'announcement', 't-roadmap', 'Split bill, card freeze from the home screen and Vietnamese voice search.', { upd: 8, verify: false }],
      ['Product principles.pdf', 'guide', 't-roadmap', 'Six principles every Finx product decision is checked against.'],
      ['OKRs — H2 2026 Product.xlsx', 'sheet', 't-roadmap', 'Product objectives and key results for H2 2026 with current status.'],
      ['Launch checklist.docx', 'form', 't-roadmap', 'Everything that must be true before a feature launches to every customer.'],
      ['Go-to-market — Virtual cards for SMEs.pptx', 'playbook', 't-customers t-partners', 'Positioning, pricing and launch plan for SME virtual cards.'],
    ]);
    gen('kb-fx-pol', [
      ['Annual Leave Policy.pdf', 'policy', 't-hr', 'Leave entitlement by years of service, carry-over and how to book leave.'],
      ['Sick Leave & Medical Insurance.pdf', 'policy', 't-hr', 'Paid sick days, social insurance and the private health plan.'],
      ['Parental Leave Policy.pdf', 'policy', 't-hr', 'Maternity and paternity leave beyond the Labour Code minimum.'],
      ['Public holidays 2027.pdf', 'calendar', 't-hr', 'Public holidays in 2027, including the Lunar New Year and National Day breaks.', { upd: 14 }],
      ['Code of Conduct.pdf', 'policy', 't-conduct', 'How we work with customers, partners and each other.', { id: 'fx-pol-conduct', verify: true }],
      ['Anti-bribery & Gifts Policy.pdf', 'policy', 't-conduct', 'Which gifts and hospitality you may give or accept, and how to declare them.'],
      ['Whistleblowing Procedure.pdf', 'procedure', 't-conduct', 'How to raise a concern confidentially and how it is handled.'],
      ['Home office equipment allowance.pdf', 'policy', 't-hybrid', 'What Finx pays for home office equipment and how to claim it.'],
      ['Laptops & mobile devices — IT acceptable use.pdf', 'policy', 't-hybrid t-conduct', 'Rules for company laptops and phones, including travel and loss.'],
      ['Bring your own device (BYOD) guideline.pdf', 'guide', 't-hybrid', 'When a personal phone may access company email and chat.'],
      ['Learning & development budget.pdf', 'policy', 't-hr', 'The yearly learning budget per person and how to use it.'],
      ['Performance review cycle 2026.pdf', 'guide', 't-hr', 'Timeline and steps for the 2026 mid-year and year-end reviews.'],
      ['Employee referral programme.pdf', 'policy', 't-hr', 'Referral bonuses by role level and when they are paid.'],
      ['Domestic per diem table 2026.xlsx', 'sheet', 't-travel', 'Daily allowances for business trips within Vietnam, by city.'],
      ['How to submit an expense claim.pdf', 'guide', 't-travel', 'Submitting receipts in the expense app and getting reimbursed.'],
      ['Quy định làm việc kết hợp (Hybrid).pdf', 'policy', 't-hybrid', 'Bản tiếng Việt của chính sách làm việc kết hợp.', { vi: true, upd: 90 }],
      ['Nội quy lao động.pdf', 'policy', 't-conduct', 'Nội quy lao động của Finx đã đăng ký với cơ quan quản lý lao động.', { vi: true }],
      ['First week checklist.docx', 'form', 't-onboarding', 'What to do in your first five days, day by day.'],
      ['IT accounts & access for new joiners.pdf', 'guide', 't-onboarding', 'Which accounts you get on day one and how to ask for more.', { id: 'fx-pol-itacc' }],
      ['Benefits overview 2026.pptx', 'guide', 't-hr', 'Every Finx benefit on one page: insurance, leave, learning and wellbeing.'],
      ['Office guide — Ho Chi Minh City HQ.pdf', 'guide', 't-hybrid', 'Floors, meeting rooms, parking and security at the Ho Chi Minh City office.'],
      ['Office guide — Hanoi.pdf', 'guide', 't-hybrid', 'Getting around the Hanoi office.'],
      ['Business travel booking — how to.pdf', 'procedure', 't-travel', 'Booking flights and hotels through the travel desk.'],
    ]);
    gen('kb-fx-lead', [
      ['Board pack — Q3 2026.pdf', 'report', 't-roadmap', 'Q3 results, risks and decisions for the board.', { verify: false, upd: 20 }],
      ['Headcount plan 2027.xlsx', 'sheet', 't-roadmap', 'Approved and planned roles by department for 2027.', { verify: false }],
      ['Leadership offsite notes — October 2026.docx', 'notes', 't-roadmap', 'Decisions and open questions from the October offsite.', { verify: false, upd: 16 }],
      ['Capital adequacy forecast 2027.xlsx', 'sheet', 't-regulatory', 'Projected capital ratios under base and stress scenarios.', { verify: false }],
      ['Strategic partnerships pipeline — confidential.pdf', 'report', 't-partners', 'Partnership discussions in progress and where each one stands.', { verify: false }],
    ]);
    D.docs.forEach(d => { if (d.views == null && !kbById(d.kb)?.personal) d.views = views(); });

    /* ── Collections, saved, recent, views ── */
    D.collections = [
      { id: 'col-fx-new', name: 'New joiner essentials', desc: 'Read these in your first two weeks.', owner: 'u-fx-an', share: 'workspace', featured: true, created: P(120), updated: P(4),
        items: [{ doc: 'fx-pol-onboarding', note: 'Start here.' }, { doc: 'fx-pol-itacc' }, { doc: 'fx-pol-hybrid', note: 'Tuesday and Thursday are team days.' }, { doc: 'fx-sec-access', note: 'Before you ask for any production access.' }, { doc: 'fx-eng-handbook', note: 'Engineers: chapters 2–4.' }, { doc: 'fx-pol-conduct' }, { doc: 'fx-pol-travel' }, { doc: 'fx-sec-privacy' }] },
      { id: 'col-fx-oncall', name: 'Payments on-call kit', desc: 'Open these when your pager goes off.', owner: 'u-fx-ha', share: 'space:sp-pay', featured: true, created: P(90), updated: P(2),
        items: [{ doc: 'fx-pay-runbook', note: 'Most common page.' }, { doc: 'fx-pay-rb-napas' }, { doc: 'fx-pay-rb-qr' }, { doc: 'fx-pay-rb-ledger' }, { doc: 'fx-eng-sev', note: 'Classify first, then page.' }, { doc: 'fx-sec-incident' }, { doc: 'fx-pay-postmortem', note: 'What went wrong last time.' }] },
      { id: 'col-fx-cbm', name: 'CBM architecture reading', desc: 'The decisions the ledger split builds on.', owner: 'u-fx-ha', share: 'space:sp-cbm', created: P(40), updated: P(3),
        items: [{ doc: 'fx-eng-cbmarch', note: 'Target architecture.' }, { doc: 'fx-eng-adr027' }, { doc: 'fx-eng-adr031' }, { doc: 'fx-eng-adr012' }, { doc: 'fx-eng-adr024' }, { doc: 'fx-eng-cbmplan' }, { doc: 'fx-eng-eval-kafka', note: 'Streaming options — see the evaluation in Work.' }] },
      { id: 'col-fx-pci', name: 'PCI DSS audit evidence', desc: 'What the assessor asks for first.', owner: 'u-fx-lan', share: 'space:sp-grc', created: P(20), updated: P(1),
        items: [{ doc: 'fx-sec-pci' }, { doc: 'fx-sec-scope' }, { doc: 'fx-sec-ev-q3' }, { doc: 'fx-sec-ac04' }, { doc: 'fx-sec-lm01' }, { doc: 'fx-sec-pentest' }, { doc: 'fx-lead-budget', note: 'Audit budget line — leadership only.' }] },
      { id: 'col-fx-fraud', name: 'Fraud model review pack', desc: 'For the v2 sign-off.', owner: 'u-fx-bao', share: 'private', created: P(10), updated: P(1),
        items: [{ doc: 'fx-data-fraud', note: 'Section 4 has the comparison with v1.' }, { doc: 'fx-data-fraudv1' }, { doc: 'fx-data-mrm' }, { doc: 'fx-data-fraudloss' }, { doc: 'fx-data-dashfraud' }, { doc: 'fx-sec-privacy' }] },
    ];
    D.saved = {
      'u-fx-khoa': ['fx-pay-runbook', 'fx-eng-adr031', 'fx-sec-access', 'fx-pay-api'],
      'u-fx-ha': ['fx-sec-incident', 'fx-eng-cbmarch', 'fx-pay-postmortem'],
      'u-fx-bao': ['fx-data-mau', 'fx-data-dict', 'fx-data-fraud'],
      'u-fx-lan': ['fx-sec-access', 'fx-sec-pci', 'fx-sec-vendor'],
    };
    D.recent = {
      'u-fx-khoa': [{ doc: 'fx-sec-access', at: P(0, 1) }, { doc: 'fx-pay-rb-qr', at: P(0, 5) }, { doc: 'fx-eng-adr031', at: P(2) }, { doc: 'fx-ops-cutoff', at: P(4) }, { doc: 'fx-pay-api', at: P(5) }],
      'u-fx-ha': [{ doc: 'fx-eng-eval-msk', at: P(0, 3) }, { doc: 'fx-pay-runbook', at: P(0, 6) }, { doc: 'fx-eng-cbmplan', at: P(1) }, { doc: 'fx-sec-incident', at: P(2) }],
      'u-fx-bao': [{ doc: 'fx-data-fraud', at: P(0, 2) }, { doc: 'fx-data-mau', at: P(0, 9) }, { doc: 'fx-data-settle', at: P(1) }, { doc: 'fx-sec-privacy', at: P(3) }],
      'u-fx-lan': [{ doc: 'fx-sec-pci', at: P(0, 1) }, { doc: 'fx-sec-incident', at: P(1, 2) }, { doc: 'fx-sec-vendor', at: P(2) }],
    };
    D.views = {
      'u-fx-khoa': [{ id: 'vw-fx-1', name: 'Payments runbooks', query: 'kb=kb-fx-pay&kind=procedure', created: P(20) }],
      'u-fx-ha': [{ id: 'vw-fx-2', name: 'Architecture decisions', query: 'topic=t-arch&kind=spec&sort=updated', created: P(30) }],
      'u-fx-bao': [{ id: 'vw-fx-3', name: 'Metric definitions', query: 'topic=t-metrics&kind=spec', created: P(15) }],
      'u-fx-lan': [{ id: 'vw-fx-4', name: 'Policies due for review', query: 'kind=policy&trust=review', created: P(25) }],
    };
    D.dupDismissed = [];
  });
})();
