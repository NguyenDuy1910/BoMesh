'use strict';
/* Mock data (D). Platform records are global; everything a workspace owns
   (knowledge, people, sources, chats, spaces, work, requests…) lives in that
   workspace's own store. D is a transparent view of the active workspace, so
   feature modules read and write D.kbs, D.members… without knowing which
   workspace is open. Seeds: this file (Northwind, platform) and data/finx.js. */

/* ═══════════════════════════ Data scopes ═══════════════════════════ */
const WS_DATA_KEYS = new Set(['roles', 'groups', 'members', 'knownAccounts', 'kbs', 'docs', 'accounts', 'sources', 'runs', 'requests', 'audit', 'signins', 'usage', 'convs', 'assistant', 'gaps', 'artifacts',
  'spaces', 'events', 'works', 'requestTypes', 'svcRequests', 'topics', 'collections', 'views', 'saved', 'recent', 'dupDismissed', 'topicProposals', 'featured', 'projects']);
const DB = { global: {}, ws: {} };
let DATA_SEEDING = null;            // workspace being seeded by a data file
const activeWsId = () => DATA_SEEDING || (typeof S !== 'undefined' && S.ws) || 'ws-northwind';
/** The store of a workspace. Workspaces without their own data (e.g. Northwind Finance) share Northwind's demo data. */
function wsData(id = activeWsId()) { return DB.ws[id] || DB.ws['ws-northwind']; }
/** Run fn with D pointing at workspace id's store (used by seed files). */
function seedWorkspace(id, fn) { DB.ws[id] ??= {}; const prev = DATA_SEEDING; DATA_SEEDING = id; try { fn(); } finally { DATA_SEEDING = prev; } }
const scopeOf = k => (WS_DATA_KEYS.has(k) ? wsData() : DB.global);
const D = new Proxy({}, {
  get: (_, k) => scopeOf(k)[k],
  set: (_, k, v) => { scopeOf(k)[k] = v; return true; },
  has: (_, k) => k in scopeOf(k),
  deleteProperty: (_, k) => delete scopeOf(k)[k],
});

/* ═══════════════════════════ Personas & permissions ═══════════════════════════ */
const ALL_TENANT = ['tenant.read', 'tenant.manage', 'user.manage', 'role.manage', 'group.manage', 'knowledge.read', 'knowledge.contribute', 'knowledge.manage', 'source.manage', 'ingestion.read', 'ingestion.run', 'ingestion.manage', 'access.manage', 'audit.read'];
const PLATFORM_PERMS = ['platform.tenant.read', 'platform.user.read', 'platform.audit.read', 'platform.health.read'];
/** Demo people. `workspaces` = memberships; Finx personas are added by data/finx.js. */
const PERSONAS = {
  member: { id: 'u-minh', name: 'Minh Pham', email: 'minh.pham@northwind.com', role: 'Member', label: 'Member', perms: ['tenant.read', 'knowledge.read', 'knowledge.contribute'], workspaces: ['ws-northwind', 'ws-nwfin'] },
  admin: { id: 'u-linh', name: 'Linh Tran', email: 'linh.tran@northwind.com', role: 'Workspace admin', label: 'Admin', perms: ALL_TENANT, workspaces: ['ws-northwind', 'ws-nwfin'] },
  operator: { id: 'u-alex', name: 'Alex Rivera', email: 'alex.rivera@northwind.com', role: 'Platform admin', label: 'Operator', perms: [...ALL_TENANT, ...PLATFORM_PERMS], workspaces: ['ws-northwind', 'ws-nwfin', 'ws-finx'] },
};

/* ═══════════════════════════ Mock data ═══════════════════════════ */
DATA_SEEDING = 'ws-northwind'; DB.ws['ws-northwind'] = {};
D.workspaces = [
  { id: 'ws-northwind', name: 'Northwind Group', code: 'northwind', color: '#36A92D', members: 214, docs: 2481, status: 'active', created: ago(410 * DAY), owner: 'Linh Tran', questions30: 18420, template: 'enterprise' },
  { id: 'ws-nwfin', name: 'Northwind Finance', code: 'northwind-finance', color: '#147D3F', members: 38, docs: 412, status: 'active', created: ago(180 * DAY), owner: 'Mai Hoang', questions30: 2210, template: 'enterprise' },
];
/* Permissions in product language. Codes stay internal (tooltip only). */
D.permCatalog = [
  { group: 'Workspace', items: [['tenant.read', 'View the workspace overview'], ['tenant.manage', 'Change workspace settings and assistant setup']] },
  { group: 'People', items: [['user.manage', 'Add, suspend and remove members'], ['group.manage', 'Create and manage groups'], ['role.manage', 'Create and edit roles'], ['access.manage', 'Approve or deny access requests']] },
  { group: 'Knowledge', items: [['knowledge.read', 'Ask questions and browse knowledge'], ['knowledge.contribute', 'Contribute documents for review'], ['knowledge.manage', 'Create knowledge bases; review and publish what is submitted to bases they own']] },
  { group: 'Sources', items: [['source.manage', 'Connect and manage sources and schedules'], ['ingestion.read', 'View sync history'], ['ingestion.run', 'Start syncs and reprocess documents'], ['ingestion.manage', 'Cancel any running sync']] },
  { group: 'Activity', items: [['audit.read', 'View the activity log and sign-ins']] },
];
D.roles = [
  { id: 'r-admin', name: 'Workspace admin', system: true, desc: 'Full control of this workspace.', perms: ALL_TENANT },
  { id: 'r-member', name: 'Member', system: true, desc: 'Ask questions, browse the knowledge they can access and contribute documents for review.', perms: ['tenant.read', 'knowledge.read', 'knowledge.contribute'] },
  { id: 'r-km', name: 'Knowledge manager', system: false, desc: 'Owns knowledge bases, reviews what is submitted to them and manages the sources that feed them.', perms: ['tenant.read', 'knowledge.read', 'knowledge.contribute', 'knowledge.manage', 'source.manage', 'ingestion.read', 'ingestion.run'] },
  { id: 'r-auditor', name: 'Auditor', system: false, desc: 'Reviews activity and sign-ins. Cannot change anything.', perms: ['tenant.read', 'knowledge.read', 'audit.read'] },
];
D.groups = [
  { id: 'g-peopleops', name: 'People Ops', desc: 'HR, recruiting and benefits.' },
  { id: 'g-sales', name: 'Sales', desc: 'Account executives and sales engineering.' },
  { id: 'g-eng', name: 'Engineering', desc: 'Platform, product and infrastructure engineering.' },
  { id: 'g-product', name: 'Product', desc: 'Product management and design.' },
  { id: 'g-legal', name: 'Legal', desc: 'Contracts and compliance.' },
  { id: 'g-finance', name: 'Finance', desc: 'Accounting, procurement and FP&A.' },
  { id: 'g-leaders', name: 'Leadership', desc: 'Executive team.' },
];
D.members = [
  ['u-linh', 'Linh Tran', 'r-admin', ['g-leaders'], 'active', 2 * MIN, 410],
  ['u-tuan', 'Tuan Le', 'r-admin', ['g-eng'], 'active', 3 * HOUR, 402],
  ['u-an', 'An Nguyen', 'r-km', ['g-peopleops'], 'active', 25 * MIN, 380],
  ['u-ben', 'Ben Walker', 'r-km', ['g-product'], 'active', 5 * HOUR, 300],
  ['u-james', 'James Carter', 'r-auditor', ['g-finance'], 'active', 2 * DAY, 220],
  ['u-minh', 'Minh Pham', 'r-member', ['g-sales'], 'active', 8 * MIN, 190],
  ['u-david', 'David Kim', 'r-member', ['g-eng'], 'active', 1 * HOUR, 260],
  ['u-sara', 'Sara Lopez', 'r-member', ['g-legal'], 'active', 6 * HOUR, 150],
  ['u-mai', 'Mai Hoang', 'r-member', ['g-finance', 'g-leaders'], 'active', 30 * HOUR, 330],
  ['u-priya', 'Priya Shah', 'r-member', ['g-product'], 'active', 4 * HOUR, 120],
  ['u-lan', 'Lan Do', 'r-member', ['g-sales'], 'active', 3 * DAY, 90],
  ['u-omar', 'Omar Haddad', 'r-member', ['g-eng'], 'active', 50 * MIN, 75],
  ['u-chi', 'Chi Bui', 'r-member', ['g-peopleops'], 'active', 9 * DAY, 60],
  ['u-hoa', 'Hoa Vu', 'r-member', ['g-sales'], 'suspended', 40 * DAY, 200],
  ['u-alex', 'Alex Rivera', 'r-admin', ['g-eng'], 'active', 1 * DAY, 405],
].map(([id, name, roleId, groups, status, last, joinedDays]) => ({ id, name, email: name.toLowerCase().replace(' ', '.') + '@northwind.com', roleId, groups, status, lastActive: ago(last), joined: ago(joinedDays * DAY) }));
/* Accounts that exist on the platform but are not members yet (adding requires an existing account). */
D.knownAccounts = ['kevin.ng@northwind.com', 'rosa.diaz@northwind.com', 'nam.tran@northwind.com', 'grace.lee@northwind.com'];

/* Knowledge bases. memberRole = what the Member persona holds: owner|editor|viewer|none (visible, locked)|null (hidden). */
D.kbs = [
  { id: 'kb-mine', name: 'My files', personal: true, desc: 'Only you can see these. Use them in your own chats.', color: '#4F5865', memberRole: 'owner', general: 'private', shares: [], updated: ago(2 * DAY) },
  { id: 'kb-hr', name: 'HR Policies', desc: 'Employee handbook, leave, travel and benefits policies.', color: '#B4467A', memberRole: 'viewer', general: 'workspace', shares: [{ kind: 'group', id: 'g-peopleops', role: 'owner' }, { kind: 'user', id: 'u-an', role: 'editor' }], updated: ago(2 * HOUR) },
  { id: 'kb-sales', name: 'Sales Playbooks', desc: 'Pitch decks, pricing guidance, competitive notes and objection handling.', color: '#C2620F', memberRole: 'viewer', general: 'workspace', shares: [{ kind: 'group', id: 'g-sales', role: 'editor' }, { kind: 'user', id: 'u-linh', role: 'owner' }], updated: ago(26 * HOUR) },
  { id: 'kb-product', name: 'Product Documentation', desc: 'Specs, release notes and API reference for every Northwind product.', color: '#2F6FB5', memberRole: 'viewer', general: 'workspace', shares: [{ kind: 'group', id: 'g-product', role: 'owner' }, { kind: 'group', id: 'g-eng', role: 'editor' }], updated: ago(6 * MIN) },
  { id: 'kb-fin', name: 'Finance & Procurement', desc: 'Purchasing rules, approval limits and vendor onboarding.', color: '#0E7C66', memberRole: null, general: 'restricted', shares: [{ kind: 'group', id: 'g-finance', role: 'owner' }, { kind: 'group', id: 'g-leaders', role: 'viewer' }], updated: ago(4 * DAY) },
  { id: 'kb-legal', name: 'Legal Contracts', desc: 'Executed customer and vendor agreements.', color: '#6B4FBF', memberRole: 'none', general: 'restricted', shares: [{ kind: 'group', id: 'g-legal', role: 'owner' }], updated: ago(12 * DAY) },
  { id: 'kb-eng', name: 'Engineering Runbooks', desc: 'On-call procedures and incident playbooks.', color: '#1F7A8C', memberRole: 'viewer', general: 'workspace', shares: [{ kind: 'group', id: 'g-eng', role: 'owner' }], updated: ago(20 * MIN) },
];
function mkDoc(kb, id, name, o = {}) {
  const type = name.split('.').pop().toLowerCase();
  return { id, kb, name, type, size: o.size || Math.round(40e3 + rnd() * 3.2e6), status: o.status || 'ready', source: o.source || 'upload', updated: o.updated || ago(Math.round(rnd() * 40 * DAY)), addedBy: o.addedBy || 'An Nguyen', pages: o.pages || Math.max(1, Math.round(rnd() * 40)), error: o.error || '', passages: o.passages || Math.round(20 + rnd() * 300) };
}
D.docs = [
  mkDoc('kb-mine', 'd-me-1', 'Q3 account plan — Acme.docx', { addedBy: 'You', updated: ago(2 * DAY) }),
  mkDoc('kb-mine', 'd-me-2', 'Pipeline export Sept.xlsx', { addedBy: 'You', updated: ago(3 * DAY) }),
  mkDoc('kb-mine', 'd-me-3', 'Customer interview notes.md', { addedBy: 'You', updated: ago(9 * DAY) }),
  mkDoc('kb-mine', 'd-me-4', 'Whiteboard photo.png', { addedBy: 'You', status: 'unsupported', updated: ago(10 * DAY) }),
  mkDoc('kb-hr', 'd-hr-travel', 'Travel & Expense Policy.pdf', { source: 'src-hr', pages: 12, updated: ago(18 * DAY), size: 842e3, passages: 64 }),
  mkDoc('kb-hr', 'd-hr-handbook', 'Employee Handbook 2026.pdf', { source: 'src-hr', pages: 48, updated: ago(30 * DAY), size: 3.4e6, passages: 312 }),
  mkDoc('kb-hr', 'd-hr-remote', 'Remote Work Policy.docx', { source: 'src-hr', pages: 6, updated: ago(45 * DAY) }),
  mkDoc('kb-hr', 'd-hr-parental', 'Parental Leave Guidelines.pdf', { source: 'src-hr', status: 'outdated', updated: ago(3 * HOUR) }),
  mkDoc('kb-hr', 'd-hr-benefits', 'Benefits Overview FY26.pptx', { source: 'src-hr', status: 'processing', updated: ago(12 * MIN) }),
  mkDoc('kb-hr', 'd-hr-onboard', 'Onboarding Checklist.xlsx', { source: 'src-hr', status: 'failed', error: 'This file is password-protected. Remove the password in Confluence, then sync again.', updated: ago(2 * HOUR) }),
  mkDoc('kb-hr', 'd-hr-conduct', 'Code of Conduct.pdf', { source: 'src-hr', updated: ago(60 * DAY) }),
  mkDoc('kb-hr', 'd-hr-holiday', 'Holiday Calendar 2026.csv', { source: 'src-hr', status: 'pending', updated: ago(8 * MIN) }),
  mkDoc('kb-hr', 'd-hr-security', 'Information Security Policy.pdf', { source: 'src-hr', updated: ago(70 * DAY) }),
  mkDoc('kb-hr', 'd-hr-perf', 'Performance Review Guide.docx', { source: 'src-hr', updated: ago(22 * DAY) }),
  mkDoc('kb-hr', 'd-hr-equip', 'Equipment & Stipend Policy.pdf', { source: 'src-hr', updated: ago(15 * DAY) }),
  mkDoc('kb-hr', 'd-hr-contractor', 'Contractor Onboarding.md', { addedBy: 'Chi Bui', updated: ago(5 * DAY) }),
  mkDoc('kb-hr', 'd-hr-wellbeing', 'Wellbeing Program.pdf', { source: 'src-hr', updated: ago(33 * DAY) }),
  mkDoc('kb-hr', 'd-hr-relocation', 'Relocation Assistance.pdf', { source: 'src-hr', status: 'failed', error: 'This file has no readable text. It may be a scanned image.', updated: ago(2 * HOUR) }),
  mkDoc('kb-fin', 'd-fin-approvals', 'Approval Limits Matrix.xlsx', { addedBy: 'Mai Hoang' }),
  mkDoc('kb-fin', 'd-fin-po', 'Purchase Order Process.pdf', { addedBy: 'Mai Hoang' }),
  mkDoc('kb-fin', 'd-fin-vendor', 'Vendor Onboarding Checklist.docx', { addedBy: 'James Carter' }),
  mkDoc('kb-fin', 'd-fin-reimb', 'Pending reimbursements Q3.xlsx', { addedBy: 'Mai Hoang', updated: ago(3 * DAY) }),
];
(function genDocs() {
  const sales = ['Enterprise Pricing Guide', 'Competitive Battlecard — Contoso', 'Discovery Call Script', 'Objection Handling', 'Mid-market Pitch Deck', 'ROI Calculator', 'Case Study — Fabrikam', 'Case Study — Tailspin', 'Renewal Playbook', 'Partner Program Overview', 'Security FAQ for Prospects', 'Procurement Questionnaire Answers', 'Demo Script v4', 'Territory Plan Template', 'Win-Loss Analysis Q2', 'Discount Approval Guidelines', 'Proposal Template', 'Customer Reference List', 'Onboarding Handoff Guide', 'Industry Brief — Healthcare', 'Industry Brief — Manufacturing', 'Value Selling Framework', 'Email Sequences', 'Trade Show Kit'];
  const ext = ['pdf', 'pptx', 'docx', 'xlsx', 'pdf', 'pdf'];
  sales.forEach((n, i) => D.docs.push(mkDoc('kb-sales', 'd-sales-' + i, `${n}.${ext[i % ext.length]}`, { source: 'src-sales', addedBy: 'Sales Enablement', updated: ago((3 + i * 2) * DAY), status: i === 4 ? 'outdated' : 'ready' })));
  const prod = ['Release Notes 4.2', 'Release Notes 4.1', 'API Reference — Authentication', 'API Reference — Orders', 'API Reference — Webhooks', 'Data Retention Spec', 'SSO Setup Guide', 'Admin Console Guide', 'Mobile App FAQ', 'Integration Guide — SAP', 'Integration Guide — Salesforce', 'Rate Limits', 'Error Codes', 'Architecture Overview', 'Roadmap H2', 'Accessibility Statement', 'Billing & Invoices', 'User Roles Explained', 'Audit Log Reference', 'Sandbox Environments', 'Import & Export', 'Reporting Dashboards', 'Notifications', 'Search Syntax', 'Changelog 2026', 'Uptime & SLA', 'Migration Guide v3 to v4', 'Glossary'];
  prod.forEach((n, i) => D.docs.push(mkDoc('kb-product', 'd-prod-' + i, `${n}.${i % 5 === 0 ? 'pdf' : 'md'}`, { source: 'src-product', addedBy: 'Product Docs space', updated: ago((i * 37 + 6) * MIN * (i > 20 ? 60 : 1)), status: i < 3 ? 'processing' : i < 5 ? 'pending' : 'ready' })));
  const legal = ['Acme Corp — Master Services Agreement', 'Acme Corp — Order Form 2026', 'Fabrikam — Data Processing Addendum', 'Contoso — Mutual NDA', 'Tailspin — Reseller Agreement', 'Woodgrove — SOW 3', 'Standard Terms of Service', 'Vendor — CloudHost DPA', 'Vendor — Payroll Co MSA', 'Litware — Pilot Agreement'];
  legal.forEach((n, i) => D.docs.push(mkDoc('kb-legal', 'd-legal-' + i, `${n}.pdf`, { source: 'src-legal', addedBy: 'Executed contracts', updated: ago((12 + i * 4) * DAY) })));
})();

/* Connected accounts (a sign-in to an app) and sources (what is synced into which knowledge base). */
D.accounts = [
  { id: 'acc-conf', app: 'confluence', label: 'northwind.atlassian.net', user: 'linh.tran@northwind.com', status: 'connected', connected: ago(160 * DAY), checked: ago(6 * MIN) },
  { id: 'acc-gd', app: 'gdrive', label: 'ops@northwind.com', user: 'ops@northwind.com', status: 'expired', connected: ago(120 * DAY), checked: ago(26 * HOUR) },
];
D.sources = [
  { id: 'src-hr', name: 'People Ops space', app: 'confluence', account: 'acc-conf', kb: 'kb-hr', status: 'healthy', scope: ['People Ops / Policies', 'People Ops / Benefits'], schedule: { freq: 'daily', time: '02:00', day: 'Mon', tz: 'Asia/Ho_Chi_Minh', on: true }, last: { at: ago(2 * HOUR), result: 'partial', added: 3, updated: 5, removed: 0, failed: 2 }, next: NOW + 14 * HOUR, created: ago(150 * DAY), owner: 'An Nguyen' },
  { id: 'src-sales', name: 'Sales Enablement', app: 'gdrive', account: 'acc-gd', kb: 'kb-sales', status: 'reconnect', scope: ['Shared drives / Sales Enablement'], schedule: { freq: 'weekly', time: '06:00', day: 'Mon', tz: 'Asia/Ho_Chi_Minh', on: true }, last: { at: ago(26 * HOUR), result: 'failed', error: 'Google Drive access for ops@northwind.com expired. Reconnect the account to resume syncing.' }, next: null, created: ago(110 * DAY), owner: 'Linh Tran' },
  { id: 'src-product', name: 'Product Docs space', app: 'confluence', account: 'acc-conf', kb: 'kb-product', status: 'syncing', scope: ['Product Docs'], schedule: { freq: 'daily', time: '01:00', day: 'Mon', tz: 'Asia/Ho_Chi_Minh', on: true }, progress: { done: 19, total: 28 }, last: { at: ago(25 * HOUR), result: 'completed', added: 2, updated: 11, removed: 1, failed: 0 }, next: NOW + 15 * HOUR, created: ago(140 * DAY), owner: 'Ben Walker' },
  { id: 'src-legal', name: 'Executed contracts', app: 'gdrive', account: 'acc-gd', kb: 'kb-legal', status: 'paused', scope: ['Legal / Executed contracts'], schedule: { freq: 'manual', time: '02:00', day: 'Mon', tz: 'Asia/Ho_Chi_Minh', on: false }, last: { at: ago(12 * DAY), result: 'completed', added: 1, updated: 0, removed: 0, failed: 0 }, next: null, created: ago(90 * DAY), owner: 'Sara Lopez' },
];
/* Sync history. "Upload" runs have no source. */
D.runs = [
  { id: 'run-1048', source: 'src-product', kb: 'kb-product', trigger: 'Scheduled', status: 'running', started: ago(6 * MIN), counts: { total: 28, ok: 19, failed: 0, skipped: 0 }, by: 'Schedule' },
  { id: 'run-1047', source: 'src-hr', kb: 'kb-hr', trigger: 'Scheduled', status: 'partial', started: ago(2 * HOUR), dur: 252e3, counts: { total: 10, ok: 8, failed: 2, skipped: 0 }, by: 'Schedule', failures: ['d-hr-onboard', 'd-hr-relocation'] },
  { id: 'run-1046', source: null, kb: 'kb-hr', trigger: 'Upload', status: 'completed', started: ago(5 * DAY), dur: 48e3, counts: { total: 1, ok: 1, failed: 0, skipped: 0 }, by: 'Chi Bui' },
  { id: 'run-1045', source: 'src-sales', kb: 'kb-sales', trigger: 'Scheduled', status: 'failed', started: ago(26 * HOUR), dur: 4e3, counts: { total: 0, ok: 0, failed: 0, skipped: 0 }, by: 'Schedule', error: 'Google Drive access for ops@northwind.com expired.' },
  { id: 'run-1044', source: 'src-product', kb: 'kb-product', trigger: 'Scheduled', status: 'completed', started: ago(25 * HOUR), dur: 611e3, counts: { total: 14, ok: 14, failed: 0, skipped: 0 }, by: 'Schedule' },
  { id: 'run-1043', source: 'src-hr', kb: 'kb-hr', trigger: 'Scheduled', status: 'completed', started: ago(26 * HOUR), dur: 190e3, counts: { total: 4, ok: 4, failed: 0, skipped: 0 }, by: 'Schedule' },
  { id: 'run-1042', source: null, kb: 'kb-fin', trigger: 'Upload', status: 'completed', started: ago(3 * DAY), dur: 92e3, counts: { total: 4, ok: 4, failed: 0, skipped: 0 }, by: 'Mai Hoang' },
  { id: 'run-1041', source: 'src-sales', kb: 'kb-sales', trigger: 'Manual', status: 'cancelled', started: ago(4 * DAY), dur: 31e3, counts: { total: 24, ok: 6, failed: 0, skipped: 18 }, by: 'Linh Tran' },
  { id: 'run-1040', source: 'src-sales', kb: 'kb-sales', trigger: 'Scheduled', status: 'completed', started: ago(8 * DAY), dur: 840e3, counts: { total: 24, ok: 24, failed: 0, skipped: 0 }, by: 'Schedule' },
  { id: 'run-1039', source: 'src-legal', kb: 'kb-legal', trigger: 'Manual', status: 'completed', started: ago(12 * DAY), dur: 120e3, counts: { total: 10, ok: 10, failed: 0, skipped: 0 }, by: 'Sara Lopez' },
];
D.requests = [
  { id: 'req-1', user: 'u-david', kb: 'kb-legal', role: 'viewer', note: 'Need to check renewal terms in the Acme MSA before Thursday’s call.', at: ago(2 * HOUR), status: 'pending' },
  { id: 'req-2', user: 'u-lan', kb: 'kb-fin', role: 'viewer', note: 'Preparing Q4 discount approvals.', at: ago(26 * HOUR), status: 'pending' },
  { id: 'req-3', user: 'u-omar', kb: 'kb-product', role: 'editor', note: 'I own the API reference pages and want to upload the new webhook docs.', at: ago(3 * DAY), status: 'pending' },
];
D.audit = [
  [12 * MIN, 'u-an', 'Uploaded 2 documents', 'Knowledge', 'HR Policies', 'success'],
  [40 * MIN, 'u-ben', 'Started a sync', 'Sources', 'Product Docs space', 'success'],
  [2 * HOUR, 'system', 'Sync finished with issues', 'Sources', 'People Ops space', 'failure'],
  [3 * HOUR, 'u-linh', 'Changed role to Knowledge manager', 'People', 'Ben Walker', 'success'],
  [5 * HOUR, 'u-tuan', 'Shared knowledge base with Engineering', 'Knowledge', 'Engineering Runbooks', 'success'],
  [6 * HOUR, 'u-tuan', 'Created knowledge base', 'Knowledge', 'Engineering Runbooks', 'success'],
  [9 * HOUR, 'u-sara', 'Paused a source', 'Sources', 'Executed contracts', 'success'],
  [26 * HOUR, 'system', 'Sync failed', 'Sources', 'Sales Enablement', 'failure'],
  [28 * HOUR, 'u-linh', 'Suspended member', 'People', 'Hoa Vu', 'success'],
  [2 * DAY, 'u-linh', 'Updated assistant instructions', 'Settings', 'Assistant', 'success'],
  [2 * DAY, 'u-mai', 'Approved access request', 'People', 'James Carter → Finance & Procurement', 'success'],
  [3 * DAY, 'u-mai', 'Uploaded 4 documents', 'Knowledge', 'Finance & Procurement', 'success'],
  [4 * DAY, 'u-linh', 'Cancelled a sync', 'Sources', 'Sales Enablement', 'success'],
  [5 * DAY, 'u-chi', 'Uploaded a document', 'Knowledge', 'HR Policies', 'success'],
  [6 * DAY, 'u-tuan', 'Created group', 'People', 'Leadership', 'success'],
  [7 * DAY, 'u-linh', 'Created role', 'People', 'Auditor', 'success'],
  [9 * DAY, 'u-linh', 'Renamed workspace', 'Settings', 'Northwind Group', 'success'],
  [12 * DAY, 'u-sara', 'Started a sync', 'Sources', 'Executed contracts', 'success'],
  [14 * DAY, 'u-linh', 'Added member', 'People', 'Omar Haddad', 'success'],
  [15 * DAY, 'u-linh', 'Archived document', 'Knowledge', 'Travel Policy 2024.pdf', 'success'],
].map(([t, actor, action, type, target, outcome], i) => ({ id: 'ev-' + (900 - i), at: ago(t), actor, action, type, target, outcome, ip: '10.4.' + (12 + i) + '.' + (30 + i * 3), device: 'Chrome on macOS' }));
D.signins = [
  [3 * MIN, 'u-linh', 'Google', 'active', 'Chrome on macOS'], [8 * MIN, 'u-minh', 'Password', 'active', 'Edge on Windows'],
  [25 * MIN, 'u-an', 'Google', 'active', 'Safari on macOS'], [50 * MIN, 'u-omar', 'Google', 'active', 'Chrome on Linux'],
  [1 * HOUR, 'u-david', 'Password', 'active', 'Chrome on macOS'], [3 * HOUR, 'u-tuan', 'Google', 'ended', 'Firefox on macOS'],
  [4 * HOUR, 'u-priya', 'Google', 'ended', 'Chrome on Windows'], [6 * HOUR, 'u-sara', 'Password', 'ended', 'Safari on iPad'],
  [20 * HOUR, 'u-hoa', 'Password', 'blocked', 'Chrome on Windows'], [30 * HOUR, 'u-mai', 'Google', 'ended', 'Chrome on macOS'],
].map(([t, user, method, st, device], i) => ({ id: 'si-' + i, at: ago(t), user, method, status: st, device }));
D.usage = { questions: Array.from({ length: 30 }, (_, i) => Math.round(420 + 180 * Math.sin(i / 3.2) + i * 9 + (i % 7 > 4 ? -230 : 0))), active: 186, activePrev: 171, questions7: 4310, questions7Prev: 3846 };

/* Conversations. Citation n is per-document reader numbering; quote is the cited passage. */
D.convs = [
  { id: 'c1', title: 'Per diem for international travel', at: ago(35 * MIN), scope: [], messages: [
    { id: 'm1', role: 'user', text: 'What is the per diem for international travel, and do I need receipts for meals?' },
    { id: 'm2', role: 'assistant', activity: [{ kind: 'search', label: 'Searched HR Policies and Finance & Procurement', detail: '3 searches · 6 relevant passages' }],
      text: 'For international travel, the meal per diem is **USD 75 per day**, and it replaces itemized meal receipts for trips longer than one day [1].\n\nA few rules apply:\n- On the first and last day of travel you receive **75% of the daily rate** [1].\n- If a client or conference provides a meal, deduct that portion: 20% breakfast, 30% lunch, 50% dinner [1].\n- Hotel, airfare and ground transport still need itemized receipts, submitted within **30 days of returning** [2].\n\nFor high-cost cities listed in Appendix B, your manager can approve up to USD 110 per day before you travel [1].',
      citations: [
        { n: 1, doc: 'd-hr-travel', page: 4, quote: 'Employees traveling internationally receive a meal per diem of USD 75 per calendar day. The per diem replaces itemized meal receipts for trips longer than one day.' },
        { n: 2, doc: 'd-hr-handbook', page: 31, quote: 'Expenses for lodging, airfare and ground transportation must be supported by itemized receipts and submitted within 30 days of the employee’s return.' },
      ] },
  ] },
  { id: 'c2', title: 'Pending reimbursements over $500', at: ago(3 * HOUR), scope: ['kb-fin'], messages: [
    { id: 'm3', role: 'user', text: 'From the Q3 pending reimbursements file, list every claim over $500 and total them by department.' },
    { id: 'm4', role: 'assistant', activity: [{ kind: 'search', label: 'Searched Finance & Procurement', detail: '1 search · 1 file' }, { kind: 'code', label: 'Analyzed the spreadsheet', detail: '2 steps' }],
      text: 'I found **14 claims over $500** in *Pending reimbursements Q3.xlsx*, totaling **$18,940** [1].\n\n| Department | Claims | Total |\n|---|---|---|\n| Sales | 6 | $8,420 |\n| Engineering | 4 | $5,310 |\n| Marketing | 3 | $4,060 |\n| People Ops | 1 | $1,150 |\n\nTwo Sales claims are above the $2,000 limit that needs VP approval [2]. I saved the full list as a spreadsheet.',
      citations: [
        { n: 1, doc: 'd-fin-reimb', page: 1, quote: 'Pending claims — Q3 export, 212 rows. Columns: Employee, Department, Category, Amount (USD), Submitted.' },
        { n: 2, doc: 'd-fin-approvals', page: 1, quote: 'Single expense claims above USD 2,000 require approval from the department VP before reimbursement.' },
      ],
      artifact: { id: 'art-1', title: 'Claims over $500 — Q3', file: 'claims_over_500_q3.xlsx', type: 'xlsx', size: 18400 } },
  ] },
  { id: 'c3', title: 'Parental leave: what changed in 2026', at: ago(26 * HOUR), scope: [], messages: [] },
  { id: 'c4', title: 'Enterprise pricing tiers summary', at: ago(28 * HOUR), scope: ['kb-sales'], messages: [] },
  { id: 'c5', title: 'Contractor onboarding steps', at: ago(3 * DAY), scope: [], messages: [] },
  { id: 'c6', title: 'QBR outline for Acme', at: ago(5 * DAY), scope: [], messages: [] },
  { id: 'c7', title: 'Remote work equipment stipend', at: ago(6 * DAY), scope: [], messages: [] },
  { id: 'c8', title: 'Vendor security review checklist', at: ago(12 * DAY), scope: [], messages: [] },
  { id: 'c9', title: 'SSO setup steps for customers', at: ago(16 * DAY), scope: ['kb-product'], messages: [] },
];
/* Projects: folders for AI conversations, with references to Knowledge documents (never copies). Seeded ones are shared demo
   folders (no owner), like the seeded conversations; ones people create are theirs. */
D.projects = [
  { id: 'pj-acme', name: 'Acme renewal', created: ago(9 * DAY), docs: [] },
  { id: 'pj-travel', name: 'Travel & expenses', created: ago(20 * DAY), docs: ['d-hr-travel', 'd-fin-approvals'] },
  { id: 'pj-vendor', name: 'Q4 vendor review', created: ago(14 * DAY), docs: [] },
];
[['c1', 'pj-travel'], ['c2', 'pj-travel'], ['c4', 'pj-acme'], ['c6', 'pj-acme'], ['c8', 'pj-vendor']].forEach(([c, p]) => { D.convs.find(x => x.id === c).project = p; });
D.assistant = {
  instructions: 'You are Northwind’s internal assistant. Answer from company knowledge first and cite every factual claim. If the knowledge does not cover a question, say so and suggest who to ask. Keep answers short and use our product names exactly.',
  style: 'balanced', citations: true, caps: { search: true, analyze: true, files: true },
  welcome: 'What can I help you find?',
  starters: [
    { title: 'Find a policy', prompt: 'What does our travel policy say about per diem?' },
    { title: 'Summarize a document', prompt: 'Summarize the latest release notes in five bullets.' },
    { title: 'Prepare for a customer', prompt: 'Draft a one-page brief for my next Acme meeting.' },
  ],
};

/* Platform console */
D.pWorkspaces = [
  ...D.workspaces,
  { id: 'ws-contoso', name: 'Contoso Legal', code: 'contoso-legal', color: '#6B4FBF', members: 56, docs: 3904, status: 'active', created: ago(300 * DAY), owner: 'Sara Lopez', questions30: 5120 },
  { id: 'ws-fabrikam', name: 'Fabrikam Manufacturing', code: 'fabrikam', color: '#C2620F', members: 410, docs: 12880, status: 'active', created: ago(520 * DAY), owner: 'Marcus Webb', questions30: 30410 },
  { id: 'ws-tailspin', name: 'Tailspin Travel', code: 'tailspin', color: '#2F6FB5', members: 92, docs: 1205, status: 'active', created: ago(240 * DAY), owner: 'Elena Petrova', questions30: 6630 },
  { id: 'ws-woodgrove', name: 'Woodgrove Bank', code: 'woodgrove', color: '#1F7A8C', members: 1140, docs: 48210, status: 'active', created: ago(610 * DAY), owner: 'Hiro Tanaka', questions30: 96200 },
  { id: 'ws-adatum', name: 'Adatum Health', code: 'adatum', color: '#A23B3B', members: 74, docs: 2210, status: 'suspended', created: ago(330 * DAY), owner: 'Nora Quinn', questions30: 0 },
  { id: 'ws-litware', name: 'Litware Labs', code: 'litware', color: '#4E6B2E', members: 3, docs: 0, status: 'new', created: ago(2 * DAY), owner: 'Sam Ortiz', questions30: 4 },
];
D.pUsers = [
  ['Alex Rivera', 'alex.rivera@northwind.com', 3, true, 'active', 1 * DAY], ['Linh Tran', 'linh.tran@northwind.com', 2, false, 'active', 3 * MIN],
  ['Marcus Webb', 'marcus.webb@fabrikam.com', 1, false, 'active', 2 * HOUR], ['Hiro Tanaka', 'hiro.tanaka@woodgrove.com', 1, false, 'active', 20 * MIN],
  ['Elena Petrova', 'elena@tailspin.travel', 1, false, 'active', 3 * DAY], ['Sara Lopez', 'sara.lopez@northwind.com', 2, false, 'active', 6 * HOUR],
  ['Nora Quinn', 'nora.quinn@adatum.health', 1, false, 'suspended', 40 * DAY], ['Sam Ortiz', 'sam@litware.dev', 1, false, 'active', 2 * DAY],
  ['Priya Shah', 'priya.shah@northwind.com', 1, false, 'active', 4 * HOUR], ['Jordan Blake', 'jordan.blake@bomesh.io', 0, true, 'active', 5 * DAY],
  ['Mai Hoang', 'mai.hoang@northwind.com', 2, false, 'active', 30 * HOUR], ['Kenji Mori', 'kenji@woodgrove.com', 1, false, 'active', 1 * HOUR],
].map(([name, email, ws, platformAdmin, status, last], i) => ({ id: 'pu-' + i, name, email, ws, platformAdmin, status, last: ago(last) }));
D.pConnectors = [
  { key: 'upload', name: 'File upload', status: 'builtin', workspaces: 8, desc: 'PDF, Office, text and ZIP files uploaded directly.' },
  { key: 'gdrive', name: 'Google Drive', status: 'enabled', workspaces: 5, desc: 'Folders and shared drives, kept in sync.', auth: 'Sign in with Google' },
  { key: 'confluence', name: 'Confluence', status: 'enabled', workspaces: 4, desc: 'Spaces and page trees from Confluence Cloud.', auth: 'Site URL and API token' },
  { key: 'sharepoint', name: 'SharePoint', status: 'unavailable', requests: 7, desc: 'Sites and document libraries.' },
  { key: 'notion', name: 'Notion', status: 'unavailable', requests: 4, desc: 'Workspaces and databases.' },
  { key: 'slack', name: 'Slack', status: 'unavailable', requests: 2, desc: 'Public channels and threads.' },
];
/* AI capabilities: model choice is a deployment setting, never a UI switch. */
D.pModels = [
  { id: 'chat', name: 'Answers & reasoning', desc: 'Writes answers and decides when to search.', setting: 'OPENROUTER_MODEL', status: 'operational', p50: '1.4 s first token' },
  { id: 'embed', name: 'Search understanding', desc: 'Turns passages into searchable meaning.', setting: 'EMBEDDING_MODEL', status: 'operational', p50: '64 ms' },
  { id: 'vision', name: 'Document reading', desc: 'Reads layouts, tables and scanned pages.', setting: 'BOMESH_DOCLING_MODEL', status: 'degraded', p50: '9 min queue' },
  { id: 'context', name: 'Passage context', desc: 'Adds surrounding context to each passage before indexing.', setting: 'BOMESH_CONTEXTUALIZATION_MODEL', status: 'operational', p50: '0.8 s' },
];
D.pServices = [
  { id: 'api', name: 'Web & API', status: 'operational', latency: '82 ms', uptime: 99.99 },
  { id: 'assistant', name: 'Assistant', status: 'operational', latency: '1.4 s', uptime: 99.95 },
  { id: 'search', name: 'Search index', status: 'operational', latency: '64 ms', uptime: 99.99 },
  { id: 'processing', name: 'Document processing', status: 'degraded', latency: '9 min queue', uptime: 99.4, note: 'Queue wait is 9 min, above the 3 min target. New documents still process.' },
  { id: 'scheduler', name: 'Sync scheduler', status: 'operational', latency: '—', uptime: 99.98 },
  { id: 'storage', name: 'File storage', status: 'operational', latency: '41 ms', uptime: 100 },
  { id: 'db', name: 'Database', status: 'operational', latency: '6 ms', uptime: 99.99 },
];

/* ── Lookups ── */
const kbById = id => D.kbs.find(k => k.id === id);
const docById = id => D.docs.find(d => d.id === id);
const srcById = id => D.sources.find(s => s.id === id);
const accById = id => D.accounts.find(a => a.id === id);
const memberById = id => D.members.find(m => m.id === id);
const groupById = id => D.groups.find(g => g.id === id);
const roleById = id => D.roles.find(r => r.id === id);
const convById = id => D.convs.find(c => c.id === id);
/** Published documents of a base (submissions, declined and unpublished documents live in Manage → Documents). */
const docsIn = kbId => D.docs.filter(d => d.kb === kbId && !d.archived && (!d.stage || d.stage === 'published'));
const groupMembers = gid => D.members.filter(m => m.groups.includes(gid));
const actorName = id => id === 'system' ? 'BoMesh' : (memberById(id)?.name || id);
const KB_ROLE_RANK = { none: 0, viewer: 1, editor: 2, owner: 3 };
/** The caller's role on a knowledge base: owner | editor | viewer | none (visible, locked) | null (hidden).
    Personal bases belong to their owner; admins own everything; otherwise the best of a direct user
    share, the per-persona `access` map (seeded workspaces) and the `memberRole` default (Northwind). */
function kbRole(kb) {
  if (!kb) return null;
  if (kb.personal) return !kb.owner || kb.owner === me().id ? 'owner' : null;
  if (isAdmin()) return 'owner';
  const cands = [kb.access ? kb.access[S.persona] : kb.memberRole, ...(kb.shares || []).filter(s => s.kind === 'user' && s.id === me().id).map(s => s.role)].filter(r => r != null);
  return cands.length ? cands.reduce((a, b) => (KB_ROLE_RANK[b] > KB_ROLE_RANK[a] ? b : a)) : null;
}
/** Record the role a persona now holds on a base (access approvals, sharing changes). */
function setPersonaKbRole(kb, userId, role) {
  const key = Object.keys(PERSONAS).find(k => PERSONAS[k].id === userId); if (!key || !kb) return;
  if (kb.access) kb.access[key] = role; else if (key === 'member') kb.memberRole = role;
}
const visibleKbs = () => D.kbs.filter(k => !k.archived && kbRole(k) !== null);
const canReadKb = kb => ['owner', 'editor', 'viewer'].includes(kbRole(kb));
const canEditKb = kb => ['owner', 'editor'].includes(kbRole(kb));
const attentionSources = () => D.sources.filter(s => ['failed', 'reconnect'].includes(s.status));
const pendingRequests = () => D.requests.filter(r => r.status === 'pending');
const curWs = () => D.pWorkspaces.find(w => w.id === S.ws) || D.workspaces[0];

/* Questions people asked that knowledge could not answer well (Overview). */
D.gaps = [
  { id: 'g1', q: 'What is the notice period for contractors?', n: 23, kb: 'kb-hr', why: 'No document covers it' },
  { id: 'g2', q: 'Do we support SCIM user provisioning?', n: 17, kb: 'kb-product', why: 'Only an outdated mention in Release Notes 4.1' },
  { id: 'g3', q: 'What discount can I offer on renewals over $100k?', n: 11, kb: 'kb-sales', why: 'Answers were rated unhelpful 6 times' },
  { id: 'g4', q: 'Who approves travel to high-risk countries?', n: 6, kb: 'kb-hr', why: 'No document covers it' },
];

/* Files the assistant made in chats, keyed by artifact id (features/chat-files.js). */
D.artifacts = {};
/* Modules Northwind doesn't use yet start empty (an admin turns them on in Settings → Workspace setup). */
D.spaces = []; D.events = []; D.works = []; D.requestTypes = []; D.svcRequests = [];
DATA_SEEDING = null;
