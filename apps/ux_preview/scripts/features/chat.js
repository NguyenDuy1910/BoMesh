(() => {
'use strict';
/* Chat: the home composer (/chat) and threads (/chat/:id) — permission-aware
   canned answers that stream with work steps, inline citations, a citation
   side panel, feedback, retry/edit, share and the product tour.
   File work (artifacts, attachments, file panel) lives in chat-files.js and
   plugs in through X.chatFiles; the conversation list is conversations.js. */

let run = null;    // active stream: { conv, msg, stop }
let stick = true;  // keep the thread pinned to the bottom while streaming
const cui = () => { const u = ui('chat', { panel: null, open: {}, edit: null, editText: '' }); u.open ??= {}; return u; };
/** Composer state per place: 'home' or a conversation id (drafts never leak between threads). */
function composer(key) { const all = ui('composer'); const c = (all[key] ??= { draft: '', files: [], scope: [], space: null }); c.draft ??= ''; c.files ??= []; c.scope ??= []; c.space ??= null; return c; }
const composerKey = () => S.cur?.r.page === 'chatThread' ? S.cur.params.id : 'home';
function findMsg(id) { for (const conv of D.convs) { const m = conv.messages.find(x => x.id === id); if (m) return { conv, m }; } return {}; }
const canDoc = d => !!d && canReadKb(kbById(d.kb));
const visCites = m => (m.citations || []).filter(c => canDoc(docById(c.doc)));
const plain = t => String(t || '').replace(/\[([^\]]+)\]\(\/[^)\s]*\)/g, '$1').replace(/\*\*|\*/g, '').replace(/\s?\[\d+\]/g, '').replace(/^\|.*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
/** The caller's personal knowledge base ("My files") in this workspace. */
const mineKb = () => D.kbs.find(k => k.personal && (!k.owner || k.owner === me().id))?.id || 'kb-mine';
const normFile = f => typeof f === 'string' ? { name: f, type: f.split('.').pop().toLowerCase(), kind: 'upload', doc: D.docs.find(d => d.kb === mineKb() && d.name === f)?.id } : f;
/** Conversations are private to their owner when they have one (seeded shared demo threads don't). */
const isMine = c => !!c && (!c.owner || c.owner === me().id);
function makeTitle(q) {
  const w = q.replace(/\s+/g, ' ').trim().split(' ');
  let t = w.slice(0, 6).join(' ').replace(/[?.!,:;]+$/, '');
  if (w.length > 6) t += '…';
  return t.charAt(0).toUpperCase() + t.slice(1);
}
/** Drop names of knowledge bases the caller can't read from step labels. */
function clean(s) {
  D.kbs.filter(k => !canReadKb(k)).forEach(k => { s = String(s).split(' and ' + k.name).join('').split(k.name + ' and ').join('').split(', ' + k.name).join(''); });
  return s;
}
const docHref = (conv, c) => `/doc/${c.doc}?q=${encodeURIComponent(c.quote)}&from=${conv.id}&page=${c.page}`;

/* ═══════════════ Answer engine (canned, permission-aware) ═══════════════ */
const CLAIMS = [
  ['Kevin Ng', 'Sales', 'Client dinner', 2480, 'Sep 12'], ['Rosa Diaz', 'Sales', 'Airfare', 2150, 'Sep 3'], ['Minh Pham', 'Sales', 'Hotel', 1040, 'Aug 28'],
  ['Lan Do', 'Sales', 'Conference', 980, 'Aug 19'], ['Grace Lee', 'Sales', 'Airfare', 920, 'Jul 30'], ['Nam Tran', 'Sales', 'Client dinner', 850, 'Jul 22'],
  ['David Kim', 'Engineering', 'Training', 1890, 'Sep 15'], ['Omar Haddad', 'Engineering', 'Hardware', 1320, 'Sep 2'], ['Tuan Le', 'Engineering', 'Conference', 1180, 'Aug 11'],
  ['Peter Vo', 'Engineering', 'Software', 920, 'Jul 18'], ['Julia Chen', 'Marketing', 'Event booth', 1760, 'Sep 9'], ['Marco Rossi', 'Marketing', 'Airfare', 1450, 'Aug 25'],
  ['Ivy Tran', 'Marketing', 'Hotel', 850, 'Aug 6'], ['Chi Bui', 'People Ops', 'Training', 1150, 'Jul 27'],
];
const TOPICS = [
  { k: /\bmars\b/i, none: true },
  { k: /reimburse|claims?\b/i, from: 'c2' },
  { k: /approval limit|purchase order|\bpo\b|procure/i,
    text: 'Purchases follow the approval limits matrix [1]:\n\n| Amount | Approver |\n|---|---|\n| Up to $5,000 | Budget owner |\n| $5,000–$25,000 | Department VP |\n| $25,000–$100,000 | CFO |\n| Over $100,000 | CEO and CFO |\n\nRaise a purchase order **before** you commit to a vendor — invoices without one are returned [2].',
    cites: [{ doc: 'd-fin-approvals', page: 1, quote: 'Purchases up to USD 5,000 are approved by the budget owner; USD 5,000 to 25,000 by the department VP.' }, { doc: 'd-fin-po', page: 3, quote: 'Invoices received without a matching purchase order are returned to the vendor.' }] },
  { k: /per ?diem|travel|trip|hotel|flight|receipt|expense/i, from: 'c1' },
  { k: /parental|maternity|paternity|\bleave\b/i,
    text: 'The 2026 update to parental leave makes three changes [1]:\n- Primary caregivers now get **20 weeks of fully paid leave**, up from 16 [1].\n- Secondary caregivers get **6 weeks**, which can be taken in up to three blocks within the first year [1].\n- You can return on a **phased schedule** — 60% of your hours at full pay for up to 4 weeks [1].\n\nTell your manager and People Ops at least **8 weeks before** your leave starts [2].',
    cites: [{ doc: 'd-hr-parental', page: 2, quote: 'From January 1, 2026, primary caregivers receive 20 weeks of fully paid parental leave, and secondary caregivers receive 6 weeks that may be taken in up to three blocks within 12 months of the birth or placement.' }, { doc: 'd-hr-handbook', page: 18, quote: 'Employees should notify their manager and People Ops at least eight weeks before the expected start of parental leave.' }] },
  { k: /pric|discount|tier|\bquote\b|deal/i,
    text: 'Northwind sells three enterprise tiers, priced per user per year [1]:\n\n| Tier | Price | Best for |\n|---|---|---|\n| Team | $240 | Up to 50 users |\n| Business | $420 | 50–500 users, SSO and audit log |\n| Enterprise | Custom | 500+ users, data residency, dedicated support |\n\nAccount executives can discount up to **15%** on their own; **15–25%** needs the regional sales director, and anything above 25% goes to the CRO [2].',
    cites: [{ doc: 'd-sales-0', page: 3, quote: 'Business tier is priced at USD 420 per user per year and includes single sign-on, the audit log and priority support.' }, { doc: 'd-sales-15', page: 1, quote: 'Discounts up to 15% may be approved by the account executive. Discounts between 15% and 25% require approval from the regional sales director.' }] },
  { k: /release|changelog|what.?s new/i,
    text: 'Here are the highlights of release 4.2:\n- **Bulk order editing** — change status, owner or due date on up to 500 orders at once [1].\n- **Webhook retries** now continue for up to 24 hours instead of 1 hour [1].\n- **Saved report views** can be shared with a team or the whole workspace [1].\n- The **SAP connector** now supports S/4HANA Cloud as well as on-premise [1].\n- The v3 API is **retired on March 31** — move remaining integrations to v4 before then [2].\n\n*Release Notes 4.2* is still being processed, so this summary uses the changelog.',
    cites: [{ doc: 'd-prod-24', page: 1, quote: 'Release 4.2 adds bulk order editing for up to 500 orders, longer webhook retries (up to 24 hours) and shared report views.' }, { doc: 'd-prod-26', page: 2, quote: 'Version 3 of the API will be retired on March 31. Integrations still using v3 endpoints must move to v4 before that date.' }] },
  { k: /\bsso\b|single sign|saml|okta/i,
    text: 'Customers set up single sign-on from the Admin Console in four steps [1]:\n- Go to **Settings › Security › Single sign-on** and choose SAML 2.0 or OpenID Connect [1].\n- Copy the Northwind sign-in address and certificate into their identity provider (Okta, Entra ID or Google) [1].\n- Map the **email** and **groups** attributes so roles are assigned on first sign-in [2].\n- Test with one account, then turn on **Require SSO** for everyone [1].\n\nSSO is included in the Business and Enterprise plans [1].',
    cites: [{ doc: 'd-prod-6', page: 1, quote: 'Single sign-on is available on Business and Enterprise plans. Administrators configure it under Settings › Security › Single sign-on using SAML 2.0 or OpenID Connect.' }, { doc: 'd-prod-17', page: 1, quote: 'When a user signs in with SSO for the first time, the groups attribute from the identity provider determines their role.' }] },
  { k: /\bapi\b|rate limit|webhook|error/i,
    text: 'The Orders API allows **600 requests per minute** per workspace, with short bursts up to 1,000 [1]. Above that, calls fail with a “Too many requests” error that says how many seconds to wait [2].\n\n- Spread bulk jobs over time, or use the bulk endpoints — they count as one request per 100 records [1].\n- Wait the time given, and back off further if errors continue [2].',
    cites: [{ doc: 'd-prod-11', page: 1, quote: 'Each workspace may send up to 600 requests per minute to the Orders API, with bursts of up to 1,000 requests.' }, { doc: 'd-prod-12', page: 2, quote: 'When the rate limit is exceeded the API returns a Too Many Requests error with a Retry-After value in seconds.' }] },
  { k: /remote|stipend|equipment|home office|laptop/i,
    text: 'Every full-time employee gets a one-time **home office stipend of USD 600**, plus **USD 40 a month** for internet [1].\n\n- Buy from the approved list, or claim other items up to the same total with receipts [1].\n- Laptops and monitors stay company property and are returned when you leave [1].\n- If you work remotely more than 3 days a week, your manager approves the arrangement once a year [2].',
    cites: [{ doc: 'd-hr-equip', page: 2, quote: 'Full-time employees receive a one-time home office stipend of USD 600 and a monthly internet allowance of USD 40.' }, { doc: 'd-hr-remote', page: 1, quote: 'Employees working remotely more than three days per week need an annual remote work agreement approved by their manager.' }] },
  { k: /contractor|onboard/i,
    text: 'Onboarding a contractor takes five steps [1]:\n- Get a signed statement of work and NDA before day one [1].\n- Request a contractor account in the People portal at least **3 working days** ahead [1].\n- Name a Northwind sponsor who approves access and timesheets [1].\n- Grant access only to the tools listed in the statement of work [2].\n- Book the 30-minute security briefing in the first week [1].\n\nContractors aren’t eligible for employee benefits or the equipment stipend [2].',
    cites: [{ doc: 'd-hr-contractor', page: 1, quote: 'Request the contractor account in the People portal at least three working days before the start date, and name a Northwind sponsor.' }, { doc: 'd-hr-handbook', page: 6, quote: 'Contractors receive access only to the systems named in their statement of work and are not eligible for employee benefits.' }] },
  { k: /acme|qbr|brief|customer|meeting|account plan/i,
    text: '**Acme Corp — meeting brief**\n\n- **Where things stand:** Acme renewed for 2026 at 1,200 seats; expanding to the EU finance team (about 300 seats) is the main open opportunity [1].\n- **Their priorities:** a faster month-end close and fewer manual approvals in procurement [1].\n- **Proof to bring:** Fabrikam cut approval time by 38% after rollout — a close match for Acme’s goals [2].\n- **Questions to ask:** who owns the EU budget, and what timeline they’re working to [3].\n- **Risk:** their champion, Dana Ruiz, moves to a new role in November — meet her successor early [1].',
    cites: [{ doc: 'd-me-1', page: 2, quote: 'Expansion: EU finance team (~300 seats) evaluating in Q4. Champion Dana Ruiz moves to Group Treasury in November.' }, { doc: 'd-sales-6', page: 2, quote: 'Fabrikam reduced average approval time by 38% within two quarters of rollout.' }, { doc: 'd-sales-2', page: 1, quote: 'Ask who owns the budget, what the decision timeline is, and what happens if nothing changes.' }] },
  { k: /vendor|security review|questionnaire|soc ?2/i,
    text: 'Use this checklist for a new vendor security review [1]:\n- Ask for a current **SOC 2 Type II** report or ISO 27001 certificate [1].\n- Confirm where data is stored and that it is encrypted at rest and in transit [1].\n- Sign a data processing agreement before sharing any personal data [1].\n- Get Security sign-off if the vendor will handle Confidential data [1].\n- Add the vendor in the procurement system only after Security approves [2].',
    cites: [{ doc: 'd-hr-security', page: 9, quote: 'Vendors that will process Confidential data must provide a current SOC 2 Type II report or ISO 27001 certificate and sign a data processing agreement.' }, { doc: 'd-fin-vendor', page: 1, quote: 'Add a new vendor in the procurement system only after Security has approved the review.' }] },
];
const STOP = new Set('what when where which with that this from have does about into your their there would could should please tell show give make find draft summarize latest list every explain passage'.split(' '));
/* Canonical answers, copied at load so deleting c1/c2 never breaks the engine. */
const CANON = Object.fromEntries(['c1', 'c2'].map(id => [id, clone(convById(id)?.messages.find(m => m.role === 'assistant') || {})]));
const SEED = { c3: 'What changed in the parental leave policy for 2026?', c4: 'Summarize our enterprise pricing tiers.', c5: 'What are the steps to onboard a contractor?', c6: 'Draft a QBR brief for my next Acme meeting.', c7: 'How much is the remote work equipment stipend?', c8: 'What should a vendor security review checklist include?', c9: 'How do customers set up SSO?' };

/* ═══════════════ Follow-up actions (module- and role-aware) ═══════════════
   An answer suggests the next step as {label, act, data} or {label, href}.
   Each helper returns null when the caller can't take that step here. */
const docList = ids => ids.filter(id => canDoc(docById(id))).join(',');
const NX = {
  request(type, label) {
    const t = hasModule('requests') && D.requestTypes?.find(x => x.id === type);
    return t && !isSpaceStaff(spaceById(t.space)) ? { label, act: 'rq-new', data: { type } } : null;
  },
  office(spaceId, label) {
    const sp = hasModule('requests') && spaceById(spaceId);
    return sp && sp.type === 'office' && !isSpaceStaff(sp) ? { label: label || `Ask ${sp.name.replace(/ Office$/, '')}`, act: 'rq-new', data: { space: sp.id } } : null;
  },
  staff(spaceId, q) {
    const sp = hasModule('requests') && spaceById(spaceId);
    if (!sp || !spaceRole(sp) || isSpaceStaff(sp) || !D.requestTypes?.some(t => t.space === sp.id && t.question)) return null;
    return { label: sp.type === 'course' ? 'Ask the teaching team' : `Ask ${sp.name}`, act: 'rq-ask-staff', data: { space: sp.id, q } };
  },
  work(workflow, label, spaceId, docs = []) {
    if (!hasModule('work')) return null;
    const sp = spaceById(spaceId);
    if (!workflowsFor(sp).some(w => w.id === workflow)) return null;
    const ids = docList(docs);
    return { label, act: 'work-start', data: { workflow, ...(sp ? { space: sp.id } : {}), ...(ids ? { docs: ids } : {}) } };
  },
};
/** Where to take a question the sources don't settle: the space's team, else the office that owns the knowledge. */
function askNext(q, scope, space) {
  const sp = spaceById(space) || (D.spaces || []).find(s => s.kbs?.some(k => scope.includes(k)));
  const office = (sp?.type === 'office' && sp) || (D.spaces || []).find(s => s.type === 'office' && !s.archived && s.kbs?.some(k => !scope.length || scope.includes(k)));
  return [NX.staff(sp?.id, q), office && NX.office(office.id)].filter(Boolean).slice(0, 1);
}
/** A question the knowledge can't answer becomes a gap the owners see (Overview); repeats count up. */
function recordGap(g) {
  D.gaps ??= [];
  const ex = D.gaps.find(x => x.q.trim().toLowerCase() === g.q.trim().toLowerCase());
  if (ex) ex.n += 1; else D.gaps.unshift({ id: uid('gap'), q: g.q, n: 1, kb: g.kb || null, why: g.why || 'No document covers it' });
}

/* ═══════════════ Finx answers (Finx Workspace demo content) ═══════════════
   Topic: { k, when?, text | text(ctx), cites, next?(ctx), gap?, files?, live?(q) }.
   gap: the sources don't settle it — answer honestly, cite what they do say,
   offer who can decide, and record the question as a knowledge gap. */
const ct = (doc, page, quote) => ({ doc, page, quote });
const FQ = {
  jit: ct('fx-sec-access', 3, 'Production access is granted just in time for a maximum of 8 hours and requires an approved change ticket.'),
  secCoding: ct('fx-sec-access', 3, 'Engineers must complete the Secure Coding training before receiving any production access.'),
  review: ct('fx-sec-access', 5, 'System owners review every access right each quarter and revoke access that is no longer needed.'),
  sev1: ct('fx-sec-incident', 2, 'A Severity 1 incident must be declared in the #incident channel within 15 minutes of detection.'),
  sbv: ct('fx-sec-incident', 4, 'When customer funds are affected, Risk & Compliance notifies the State Bank of Vietnam within 24 hours.'),
  breach: ct('fx-sec-incident', 4, 'Personal data breaches are also reported to the Ministry of Public Security under Decree 13/2023 within 72 hours. Risk & Compliance drafts both notices; the CEO signs them.'),
  masked: ct('fx-sec-privacy', 2, 'Customer personal data is masked by default in every non-production environment.'),
  pii: ct('fx-sec-privacy', 3, 'Access to unmasked customer data requires an approved PII access request and the Data privacy training.'),
  piiDays: ct('fx-sec-privacy', 3, 'Requests go to Risk & Compliance through BoMesh Requests and state the purpose, the tables needed and an end date. Access is granted for at most 30 days.'),
  napas: ct('fx-ops-cutoff', 1, 'NAPAS 247 interbank transfers settle in real time, 24 hours a day.'),
  batch: ct('fx-ops-cutoff', 2, 'Batch transfers submitted after 15:30 are settled on the next business day.'),
  holiday: ct('fx-ops-cutoff', 3, 'During Tết and other public holidays only NAPAS 247 and internal transfers run. Batches queue until the first business day after the holiday.'),
  dispute: ct('fx-ops-dispute', 2, 'A cardholder dispute must be acknowledged within 2 business days and resolved within 45 days.'),
  idemHeader: ct('fx-eng-adr031', 1, 'Every POST to a payment API must carry an Idempotency-Key header.'),
  idemReplay: ct('fx-eng-adr031', 2, 'The gateway stores the first response for 24 hours and replays it for any retry with the same key.'),
  ledger: ct('fx-eng-adr027', 1, 'Ledger balances are updated only by consuming events from the payments topic, never by direct writes.'),
  timeout: ct('fx-pay-runbook', 1, 'If the timeout rate exceeds 2% for 5 minutes, fail over card authorization to the secondary acquirer.'),
  failback: ct('fx-pay-runbook', 2, 'Fail back only after the primary acquirer confirms recovery and its health check has been green for 30 minutes.'),
  mac: ct('fx-data-mau', 1, 'A monthly active customer has at least one customer-initiated financial transaction in the calendar month; logins alone do not count.'),
  macTables: ct('fx-data-mau', 2, 'Use the certified tables above; dashboards built on raw login events will not match board reporting.'),
  office: ct('fx-pol-hybrid', 1, 'Employees work from the office at least three days a week; Tuesday and Thursday are team days.'),
  officeException: ct('fx-pol-hybrid', 2, 'Managers may approve temporary changes for health or family reasons for up to 4 weeks; longer arrangements need People & Culture approval.'),
  remotePlace: ct('fx-pol-hybrid', 2, 'Work from a safe, private place in Vietnam with a reliable connection.'),
};
const openDoc = (id, label) => (canDoc(docById(id)) ? { label, href: '/doc/' + id } : null);
const ASK_STOP = new Set([...STOP, 'people', 'asked', 'most', 'questions', 'question', 'week', 'common', 'often', 'team', 'teams']);
/** Visible calendar items in the next 7 days (Home's up-next when available, else the events I can see). */
const eventVisible = e => { const sp = spaceById(e.space); return e.audience === 'all' || (e.audience === 'staff' ? isSpaceStaff(sp) : !!spaceRole(sp)); };
const eventHref = e => e.work ? '/work/' + e.work : e.doc && canDoc(docById(e.doc)) ? '/doc/' + e.doc : e.requestType ? '/requests/new?type=' + e.requestType : '/space/' + e.space;
const mdText = s => String(s || '').replace(/[[\]*]/g, '').replace(/\s+/g, ' ').trim();
function dueSoon() {
  const horizon = Date.now() + 7 * DAY;
  let items = X.upNext?.({ limit: 12 });
  if (!Array.isArray(items)) items = (D.events || []).filter(e => e.at > Date.now() && eventVisible(e)).sort((a, b) => a.at - b.at).map(e => ({ ...e, action: { href: eventHref(e) } }));
  items = items.filter(i => !i.at || i.at <= horizon);
  const href = i => { if (i.action?.href) return i.action.href; const e = D.events?.find(x => x.id === i.id); return e ? eventHref(e) : i.space ? '/space/' + i.space : homeRoute(); };
  const line = i => { const sp = spaceById(i.space); return `- [${mdText(i.title)}](${href(i)}) · ${sp ? sp.name + ' · ' : ''}${i.at ? `${fmtDateTime(i.at)} (${relFuture(i.at)})` : 'needs your attention'}`; };
  const soon = items.find(i => i.at && i.at - Date.now() < 2 * DAY);
  const text = items.length
    ? `Here’s what’s coming up in the next 7 days:\n\n${items.map(line).join('\n')}` + (soon ? `\n\nStart with **${mdText(soon.title)}** — it’s ${relFuture(soon.at).replace(/^in /, 'due in ')}.` : '')
    : 'Nothing is due in the next 7 days across your spaces.';
  const next = items.filter(i => i.action?.label && i.action.label !== 'Open' && (i.action.act || i.action.href)).slice(0, 2).map(i => ({ label: i.action.label, act: i.action.act, data: i.action.data, href: i.action.act ? undefined : i.action.href }));
  return { text, citations: [], searchLabel: 'your calendars', activity: [{ kind: 'search', label: 'Checked the calendars of your spaces', detail: plural(items.length, 'item') }], next, files: false };
}
/** Teaching teams and admins: what people asked lately, and what the knowledge couldn't answer. */
function askedLately(q) {
  const staffIn = mySpaces().filter(s => isSpaceStaff(s));
  const ids = new Set(staffIn.map(s => s.id)), kbs = new Set(staffIn.flatMap(s => s.kbs || []));
  const words = (q.toLowerCase().match(/[a-z0-9]{4,}/g) || []).filter(w => !ASK_STOP.has(w));
  const week = Date.now() - 7 * DAY;
  const allQs = (D.svcRequests || []).filter(r => ids.has(r.space) && D.requestTypes?.find(t => t.id === r.type)?.question && r.created >= week).sort((a, b) => b.created - a.created);
  const allGaps = (D.gaps || []).filter(g => isAdmin() || kbs.has(g.kb)).sort((a, b) => b.n - a.n);
  const hit = t => words.some(w => new RegExp('\\b' + w, 'i').test(t));
  let qs = allQs.filter(r => hit(r.fields?.question || '')), gaps = allGaps.filter(g => hit(g.q));
  if (!qs.length && !gaps.length) { qs = allQs; gaps = allGaps; }
  const parts = [];
  if (qs.length) parts.push(`**Sent to your spaces this week**\n${qs.slice(0, 5).map(r => `- [“${mdText(r.fields.question)}”](/requests/${r.id}) — ${actorName(r.requester)}, ${rel(r.created).toLowerCase()}${r.status === 'completed' ? ' · answered' : ''}`).join('\n')}`);
  if (gaps.length) parts.push(`**Questions the knowledge couldn’t answer**\n${gaps.slice(0, 5).map(g => `- “${mdText(g.q)}” — asked ${plural(g.n, 'time')} · ${mdText(g.why)}`).join('\n')}`);
  const next = [hasModule('requests') && qs.length ? { label: 'Open the question queue', href: '/requests?tab=queue' } : null, isAdmin() && gaps.length ? { label: 'Review knowledge gaps', href: '/overview' } : null].filter(Boolean);
  return { text: parts.length ? parts.join('\n\n') : 'No questions came in this week, and nothing went unanswered.', citations: [], searchLabel: 'questions sent to your spaces',
    activity: [{ kind: 'search', label: 'Checked questions sent to your spaces', detail: plural(qs.length, 'question') }, { kind: 'search', label: 'Checked unanswered questions', detail: plural(gaps.length, 'gap') }], next, files: false };
}
const FINX_TOPICS = [
  { k: /(people|team|staff) (ask|asked)|asked (most|about)|common questions|questions (about|did|people)|confus/i, when: () => isAdmin() || mySpaces().some(s => isSpaceStaff(s)), live: askedLately },
  { k: /(unmasked|pii|personal data|customer data).*(access|need|get|see|query)|(access|need|get|see|query).*(unmasked|pii|personal data|customer data)/i, cites: [FQ.masked, FQ.pii, FQ.piiDays],
    text: ({ p }) => `Customer personal data is **masked by default** in every non-production environment [1], so most analysis doesn’t need special access.\n\nTo see unmasked data you need two things [2]:\n- an **approved PII access request**, and\n- the **Data privacy training**.\n\nThe request goes to Risk & Compliance with the purpose, the tables you need and an end date; access lasts **at most 30 days** [3].` + (p?.trainings ? `\n\nYour profile shows ${p.trainings.includes('Data privacy 2026') ? 'Data privacy 2026 completed, so you can send the request now' : 'no Data privacy training yet — complete it before you send the request'}.` : ''),
    next: () => [NX.request('rt-pii', 'Request PII access'), openDoc('fx-sec-privacy', 'Open the data protection standard')] },
  { k: /prod(uction)? access|access (to )?prod|break.?glass|just.?in.?time|\bjit\b/i, cites: [FQ.jit, FQ.secCoding, FQ.review],
    text: ({ p }) => `Production access at Finx is **just in time**: you get it for **at most 8 hours**, and only with an **approved change ticket** [1].\n\nBefore your first request you must complete the **Secure Coding training** [2]. Access ends automatically when the window closes, and system owners review every access right each quarter [3].` + (p?.trainings ? `\n\n${p.trainings.includes('Secure coding 2026') ? 'Your profile shows **Secure coding 2026** completed, so you can request access now.' : 'Your profile doesn’t show the **Secure coding 2026** training yet — complete it first, or the request will be declined.'}` : '') + '\n\nSend the request to the IT Service Desk with the system, the duration and your change ticket.',
    next: () => [NX.request('rt-prod', 'Request production access'), openDoc('fx-sec-access', 'Open the Access Control Policy')] },
  { k: /access review|review (of )?access|revoke access/i, cites: [FQ.review, FQ.jit],
    text: 'System owners review **every access right each quarter** and revoke access that is no longer needed [1]. Production access is never standing: it’s granted just in time for at most 8 hours [2].',
    next: () => [openDoc('fx-sec-access', 'Open the Access Control Policy')] },
  { k: /\bsbv\b|state bank|regulator|notify|notification|sev(erity)? ?1|declare (an )?incident|incident (response|process)/i, cites: [FQ.sev1, FQ.sbv, FQ.breach],
    text: 'Two clocks start when an incident hits customers:\n\n- **Declare it:** a Severity 1 must be declared in **#incident within 15 minutes** of detection [1].\n- **Notify the SBV:** when **customer funds are affected**, Risk & Compliance notifies the State Bank of Vietnam **within 24 hours** [2].\n\nIf personal data is breached, the Ministry of Public Security must also be told within 72 hours under Decree 13/2023 [3]. You don’t send these notices yourself — Risk & Compliance drafts them and the CEO signs.',
    next: () => [openDoc('fx-sec-incident', 'Open the Incident Response Plan')] },
  { k: /time[sd]? ?outs?|gateway (is )?(down|slow|failing)|acquirer|fail ?over|\b504\b/i, cites: [FQ.timeout, FQ.sev1, FQ.failback],
    text: 'Follow the gateway timeout runbook:\n\n- **Decide:** if the timeout rate is **above 2% for 5 minutes**, fail over card authorization to the **secondary acquirer** [1].\n- **Declare:** if customers can’t pay, it’s a Severity 1 — declare it in #incident within 15 minutes [2].\n- **Fail back** only after the primary acquirer confirms recovery and its health check has been green for 30 minutes [3].',
    next: () => [openDoc('fx-pay-runbook', 'Open the runbook')] },
  { k: /idempot|adr-?031|retr(y|ies) (a )?payment|double (debit|charge)|duplicate payment/i, cites: [FQ.idemHeader, FQ.idemReplay],
    text: 'ADR-031 makes retries safe:\n\n- Every **POST to a payment API must carry an Idempotency-Key header** [1]. Clients create one key per payment and reuse it for every retry.\n- The gateway **stores the first response for 24 hours** and replays it for any retry with the same key [2], so a retry never debits the customer twice.',
    next: () => [openDoc('fx-eng-adr031', 'Open ADR-031'), NX.work('draft', 'Draft an ADR from these sources', 'sp-cbm', ['fx-eng-adr031', 'fx-eng-adr027'])] },
  { k: /ledger|adr-?027|event.?driven|kafka|pulsar|\bmsk\b|stream(ing)? platform/i, cites: [FQ.ledger],
    text: 'ADR-027 sets the rule: **ledger balances are updated only by consuming events from the payments topic, never by direct writes** [1].\n\nThat’s why the streaming platform matters — the CBM team is comparing Confluent Cloud, self-hosted Pulsar and Amazon MSK on throughput, exactly-once support, operations effort, data residency and cost.',
    next: () => [(D.works || []).some(w => w.id === 'w-review-stream') && hasModule('work') ? { label: 'Open the streaming evaluation', href: '/work/w-review-stream' } : null, openDoc('fx-eng-adr027', 'Open ADR-027')] },
  { k: /cut.?off|napas|interbank|settle(ment)?|batch transfer|citad/i, cites: [FQ.napas, FQ.batch, FQ.holiday],
    text: '- **NAPAS 247** interbank transfers settle **in real time, 24 hours a day** — there’s no cut-off [1].\n- **Batch transfers** submitted **after 15:30** settle on the **next business day** [2].\n\nDuring Tết and other public holidays only NAPAS 247 and internal transfers run; batches wait for the first business day after the holiday [3].',
    next: () => [openDoc('fx-ops-cutoff', 'Open cut-off times')] },
  { k: /dispute|chargeback/i, cites: [FQ.dispute],
    text: 'A cardholder dispute must be **acknowledged within 2 business days** and **resolved within 45 days** [1]. Log it in the case tool with the transaction ID, and block the card if the customer reports fraud.',
    next: () => [openDoc('fx-ops-dispute', 'Open the dispute procedure')] },
  { k: /monthly active|active customer|\bmau\b|\bmac\b|how (do we|to) (define|count) (an? )?(active|customer)/i, cites: [FQ.mac, FQ.macTables],
    text: 'A **monthly active customer** has **at least one customer-initiated financial transaction** in the calendar month — **logins alone don’t count** [1].\n\nTransfers, card and QR payments, bill payments and top-ups count; interest, fees and refunds don’t. Build reports on the certified tables: dashboards on raw login events won’t match board reporting [2].',
    next: () => [openDoc('fx-data-mau', 'Open the metric definition')] },
  { k: /(work|working) (fully )?(remote|from home|abroad)|remote.*(month|weeks|abroad|overseas)|(month|weeks).*(remote|from home)/i, cites: [FQ.office, FQ.officeException, FQ.remotePlace],
    gap: { q: 'Can I work remotely from abroad for a few weeks?', kb: 'kb-fx-pol', why: 'The hybrid policy doesn’t cover working from outside Vietnam' },
    text: 'The Hybrid Work Policy expects **three office days a week**, with Tuesday and Thursday as team days [1]. Your manager can approve a temporary change for health or family reasons for up to 4 weeks; longer needs People & Culture [2].\n\nIt says remote days are worked from a safe, private place **in Vietnam** [3], but it doesn’t say whether working from abroad can ever be approved — so I won’t guess. People & Culture can decide.' },
  { k: /office days?|hybrid|work from (the )?office|team days?|days a week|wfh/i, cites: [FQ.office, FQ.officeException],
    text: 'You work from the office **at least three days a week**; **Tuesday and Thursday are team days** [1]. Your team picks the third day together.\n\nFor health or family reasons your manager can approve a temporary change for up to 4 weeks [2].',
    next: () => [openDoc('fx-pol-hybrid', 'Open the Hybrid Work Policy')] },
  { k: /\bdue\b|this week|next (7|seven) days|plan my week|coming up|upcoming|what.?s next|my deadlines|deadlines (this|next)/i, live: dueSoon },
];
/** Answer tables by workspace (demo content). Workspaces without one use Northwind's. files:false = no generated spreadsheets/docs unless a topic allows it. */
const TOPIC_TABLES = { 'ws-finx': { topics: FINX_TOPICS, files: false } };

/** Keep only lines whose citations survive; renumber the rest. */
function prune(text, cites, keep) {
  const map = {}; let k = 0; cites.forEach((c, i) => { if (keep[i]) map[c.n] = ++k; });
  const lines = text.split('\n').filter(l => [...l.matchAll(/\[(\d+)\]/g)].map(x => +x[1]).every(n => map[n]));
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().replace(/\[(\d+)\]/g, (_, n) => `[${map[n]}]`), citations: cites.filter((_, i) => keep[i]).map(c => ({ ...c, n: map[c.n] })) };
}
function answer(q, scope = [], fileNames = [], space = null) {
  const readable = visibleKbs().filter(canReadKb);
  const inScope = id => !scope.length || scope.includes(id);
  const lockedExists = visibleKbs().some(k => kbRole(k) === 'none');
  const table = TOPIC_TABLES[S.ws];
  const t = (table?.topics || TOPICS).find(x => x.k.test(q) && (!x.when || x.when()));
  if (t?.live) return t.live(q);
  const ctx = { q, p: me().profile || null };
  const files = t?.files ?? table?.files;
  let text, cites, artifact = null; const extra = [];
  if (t?.from) { const src = CANON[t.from]; text = src.text; cites = src.citations; artifact = src.artifact || null; if (t.from === 'c2') extra.push({ kind: 'code', label: 'Analyzed the spreadsheet', detail: '2 steps' }); }
  else if (t && !t.none) { text = typeof t.text === 'function' ? t.text(ctx) : t.text; cites = t.cites.map((c, i) => ({ n: i + 1, ...c })); }
  else if (!t) {
    const words = (q.toLowerCase().match(/[a-z]{4,}/g) || []).filter(w => !STOP.has(w));
    const pool = D.docs.filter(d => !d.archived && ['ready', 'outdated'].includes(d.status) && canDoc(d) && inScope(d.kb));
    // Workspaces with a curated answer table answer honestly instead of guessing: a document must match at least two words, and nothing is padded in.
    const minScore = table ? Math.min(2, words.length) : 1;
    let picks = pool.map(d => ({ d, s: words.filter(w => d.name.toLowerCase().includes(w.slice(0, 5))).length })).filter(x => x.s && x.s >= minScore).sort((a, b) => b.s - a.s).map(x => x.d).slice(0, 2);
    if (picks.length < 2 && !table) { const fill = (scope.length ? pool : pool.filter(d => ['d-hr-handbook', 'd-prod-7'].includes(d.id))).filter(d => !picks.includes(d)); picks = [...picks, ...fill].slice(0, 2); }
    if (picks.length) {
      const b = picks.map(d => d.name.replace(/\.[^.]+$/, ''));
      text = `Here’s what the most relevant documents say.\n\n- *${b[0]}* covers the main rules, who they apply to and who to contact [1].` + (b[1] ? `\n- *${b[1]}* adds the practical steps, with examples for common cases [2].` : '') + '\n\nTell me a little more about your situation and I can give a more specific answer.';
      cites = picks.map((d, i) => ({ n: i + 1, doc: d.id, page: 1, quote: i ? `${b[1]} walks through the practical steps, with examples for the most common cases.` : `${b[0]} explains the main rules, who they apply to and who to contact with questions.` }));
    }
  }
  const topicKbs = [...new Set((cites || []).map(c => docById(c.doc)?.kb))];
  const searched = readable.filter(k => inScope(k.id)).sort((a, b) => (topicKbs.includes(b.id) - topicKbs.includes(a.id)) || (!!a.personal - !!b.personal));
  const names = searched.map(k => k.name);
  const searchLabel = names.length <= 2 ? names.join(' and ') : `${names[0]}, ${names[1]} and ${names.length - 2} more`;
  const noRes = restricted => {
    const r = { text: 'I couldn’t find this in the knowledge you can access.', citations: [], searchLabel, activity: [{ kind: 'search', label: `Searched ${plural(searched.length, 'knowledge base')}`, detail: 'No relevant passages' }], noResults: { scoped: scope.length > 0, restricted: restricted || lockedExists }, files };
    // Not covered where the caller searched: offer who can answer; unscoped misses become a knowledge gap.
    if (!restricted && hasModule('requests')) { const n = askNext(q, scope, space); r.next = n.length ? n : null; if (!scope.length) r.gap = { q: q.trim(), kb: null }; }
    return r;
  };
  if (!cites || !text) return noRes(false);
  const flags = cites.map(c => { const d = docById(c.doc); return { ok: canDoc(d) && inScope(d.kb), perm: !!d && !canDoc(d) }; });
  const permDropped = flags.some(f => f.perm);
  if (!flags.some(f => f.ok)) return noRes(permDropped);
  const pr = prune(text, cites, flags.map(f => f.ok));
  if (!pr.citations.length || !pr.text) return noRes(permDropped);
  pr.citations.forEach(c => { const d = docById(c.doc); c.page = Math.max(1, Math.min(c.page, d.pages)); });
  const readDocs = [...new Set(pr.citations.map(c => c.doc))].map(docById);
  const activity = [
    { kind: 'search', label: `Searched ${names.length <= 2 && names.length ? searchLabel : plural(searched.length, 'knowledge base')}`, detail: `${pr.citations.length * 3 + 1} relevant passages` },
    ...fileNames.map(f => ({ kind: 'read', label: `Read ${f}`, detail: 'your attachment' })),
    ...readDocs.map(d => ({ kind: 'read', label: `Read ${d.name}`, detail: plural(pr.citations.filter(c => c.doc === d.id).length, 'passage') })),
    ...extra,
  ];
  const next = (t?.next?.(ctx) || []).filter(Boolean);
  return { text: pr.text, citations: pr.citations, activity, artifact: flags.every(f => f.ok) ? artifact : null, searchLabel, partial: permDropped, next: next.length ? next : null, gap: t?.gap || null, lowConf: !!t?.gap, files };
}
/** Seeded conversations without messages get their first answer the first time they are opened. */
function ensureSeed(conv) {
  if (conv.messages.length) return;
  const q = SEED[conv.id] || conv.title;
  const a = answer(q, conv.scope || [], [], conv.space || null);
  conv.messages.push({ id: uid('m'), role: 'user', text: q }, { id: uid('m'), role: 'assistant', q, text: a.text, citations: a.citations, work: a.activity.map(s => ({ k: s.kind, label: s.label, d: s.detail })), noResults: a.noResults || null, partial: a.partial, next: a.next || null, lowConf: !!a.lowConf, state: 'done', dur: 4 });
}
function lastLine(conv) {
  const a = [...conv.messages].reverse().find(m => m.role === 'assistant'); if (!a) return '';
  if (a.citations?.length && !visCites(a).length) return 'Uses knowledge you can’t access';
  return (plain(a.text).split('\n').find(l => l.trim()) || '').replace(/:\s*$/, '');
}

/* ═══════════════ Markdown subset ═══════════════ */
function inline(s, ctx) {
  return esc(s).replace(/\[([^\]]+)\]\((\/[^)\s]*)\)/g, '<a class="chat-link" href="#$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*\s][^*]*)\*/g, '<em>$1</em>')
    .replace(/\s?\[(\d+)\]/g, (m, n) => { const h = ctx.cite(+n); return h ? (m[0] === '[' ? '' : ' ') + h : ''; });
}
function md(text, ctx) {
  const L = text.split('\n'); let h = '', i = 0;
  const isBul = l => /^\s*[-*] /.test(l), isTbl = l => /^\s*\|/.test(l);
  while (i < L.length) {
    const l = L[i];
    if (!l.trim()) { i++; continue; }
    if (isBul(l)) { let li = ''; while (i < L.length && isBul(L[i])) li += `<li>${inline(L[i++].replace(/^\s*[-*] /, ''), ctx)}</li>`; h += `<ul>${li}</ul>`; continue; }
    if (isTbl(l)) {
      const rows = []; while (i < L.length && isTbl(L[i])) { const r = L[i++]; if (!/^\s*\|[\s|:\-\u2063]+\|?\s*$/.test(r)) rows.push(r.trim().replace(/^\||\|$/g, '').split('|').map(x => x.trim())); }
      h += `<div class="chat-table"><table>${rows.map((r, ri) => `<tr>${r.map(c => ri ? `<td>${inline(c, ctx)}</td>` : `<th>${inline(c, ctx)}</th>`).join('')}</tr>`).join('')}</table></div>`; continue;
    }
    if (/^#{1,4} /.test(l)) { h += `<h4>${inline(l.replace(/^#+ /, ''), ctx)}</h4>`; i++; continue; }
    const p = []; while (i < L.length && L[i].trim() && !isBul(L[i]) && !isTbl(L[i])) p.push(inline(L[i++], ctx)); h += `<p>${p.join('<br>')}</p>`;
  }
  return h.replace('\u2063', '<span class="chat-caret" aria-hidden="true"></span>');
}

/* ═══════════════ Composer ═══════════════ */
/** What the composer searches: the open conversation, or the home composer. Both carry scope (knowledge base ids) and space (context). */
function scopeHolder() { const conv = S.cur?.r.page === 'chatThread' && convById(S.cur.params.id); if (conv) { conv.scope ??= []; return conv; } return composer('home'); }
const readableKbsOf = sp => (sp?.kbs || []).filter(id => canReadKb(kbById(id)));
/** Spaces offered as a scope: mine, with knowledge I can read. */
const scopeSpaces = () => hasModule('spaces') ? mySpaces().filter(sp => readableKbsOf(sp).length) : [];
const holderSpace = h => (h.space && hasModule('spaces') && spaceById(h.space)) || null;
function setSpace(h, sp) { h.space = sp?.id || null; h.scope.splice(0, h.scope.length, ...readableKbsOf(sp)); }
function scopeBtn(h) {
  const sp = holderSpace(h);
  if (sp) return btn(sp.name, { v: 'ghost', size: 'sm', icon: spaceType(sp.type).icon, iconRight: 'chevron-down', menu: 'chat-scope', id: 'chat-scope', cls: 'chat-scope chat-scope--on', tip: `Searching ${sp.name}. Change what to search` });
  const names = h.scope.map(kbById).filter(k => k && canReadKb(k)).map(k => k.name);
  const label = !names.length ? 'All knowledge' : names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
  return btn(label, { v: 'ghost', size: 'sm', icon: names.length ? 'book' : 'layers', iconRight: 'chevron-down', menu: 'chat-scope', id: 'chat-scope', cls: cx('chat-scope', names.length && 'chat-scope--on'), tip: 'Choose what to search' });
}
function composerHtml({ key, holder, placeholder, streaming, lg }) {
  const c = composer(key);
  const files = c.files.map((f, i) => X.chatFiles?.chip(f, i, true) || '').join('');
  const canSend = c.draft.trim() && c.files.every(f => f.ready || f.error);
  const send = streaming
    ? btn('', { v: 'tertiary', icon: 'stop', tip: 'Stop answering', act: 'chat-stop', cls: 'chat-composer__send' })
    : btn('', { v: 'primary', icon: 'arrow-up', tip: 'Send', act: 'chat-send', id: 'chat-send', disabled: !canSend, cls: 'chat-composer__send' });
  return `<div class="${cx('chat-composer', lg && 'chat-composer--lg')}" id="chat-composer">
    <div class="chat-composer__files" id="chat-files" ${files ? '' : 'hidden'}>${files}</div>
    <textarea class="chat-composer__input" id="chat-input" rows="${lg ? 2 : 1}" placeholder="${esc(placeholder)}" aria-label="Message" data-bind="composer.${key}.draft" data-input="chat-draft" data-enter="chat-send" data-autofocus>${esc(c.draft)}</textarea>
    <div class="chat-composer__bar">${iconBtn('paperclip', 'Attach files', { size: 'sm', menu: 'wk-attach' })}${scopeBtn(holder)}<span class="grow"></span>${c.files.length ? `<span class="t-xs muted num chat-composer__count">${c.files.length}/5</span>` : ''}${send}</div>
    <input type="file" id="wk-file-in" multiple hidden data-change="wk-file-picked" aria-label="Choose files to attach">
  </div>`;
}
function grow(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'; }
function focusComposer() { requestAnimationFrame(() => { const t = $('#chat-input'); if (!t) return; t.focus(); const n = t.value.length; t.setSelectionRange(n, n); grow(t); }); }
function afterComposer(changed) {
  const ta = $('#chat-input'); if (!ta) return;
  grow(ta);
  if (changed) setTimeout(() => { const t = $('#chat-input'); if (!t || document.activeElement !== t && document.activeElement !== document.body && document.activeElement) return; t.focus({ preventScroll: true }); const n = t.value.length; t.setSelectionRange(n, n); }, 0);
}
A['chat-draft'] = el => { grow(el); const b = $('#chat-send'); if (b) b.disabled = !(el.value.trim() && composer(composerKey()).files.every(f => f.ready || f.error)); };
/* Scope picker: a checkbox menu that stays open while toggling. Whole workspace, one of my spaces, or chosen knowledge bases. */
MENUS['chat-scope'] = () => {
  const h = scopeHolder(), sc = h.scope, sp = holderSpace(h); const kbs = visibleKbs().filter(canReadKb); const spaces = scopeSpaces();
  const reopen = i => { refresh(); requestAnimationFrame(() => { const t = $('#chat-scope'); if (!t) return; openMenu(t, MENUS['chat-scope'](t), 'chat-scope:'); requestAnimationFrame(() => $(`#menu [data-mi="${i}"]`)?.focus()); }); };
  const row = (label, on, icon) => `<span class="${cx('chat-check', on && 'is-on')}" aria-hidden="true">${ic('check')}</span>${ic(icon)}<span class="grow truncate">${esc(label)}</span>`;
  const items = [{ section: 'Search in' }];
  const add = (label, on, icon, apply) => { const i = items.length; items.push({ html: row(label, on, icon), checked: on, run: () => { apply(); reopen(i); } }); };
  add(`All of ${curWs().name}`, !sc.length && !sp, 'layers', () => setSpace(h, null));
  if (spaces.length) {
    items.push({ sep: true }, { section: 'My spaces' });
    spaces.forEach(s => add(s.name, sp?.id === s.id, spaceType(s.type).icon, () => setSpace(h, sp?.id === s.id ? null : s)));
    items.push({ sep: true }, { section: 'Knowledge bases' });
  } else items.push({ sep: true });
  kbs.forEach(k => add(k.name, !sp && sc.includes(k.id), k.personal ? 'user' : 'book', () => { if (sp) setSpace(h, null); const j = sc.indexOf(k.id); if (j >= 0) sc.splice(j, 1); else sc.push(k.id); }));
  return items;
};

/* ═══════════════ Messages ═══════════════ */
function userHtml(m) {
  const u = cui();
  const files = (m.files || []).map(f => X.chatFiles?.chip(normFile(f), 0, false) || '').join('');
  const filesRow = files ? `<div class="chat-user__files">${files}</div>` : '';
  if (u.edit === m.id) return `<div class="chat-msg chat-msg--user" id="msg-${m.id}"><div class="chat-edit">${filesRow}${textarea({ id: 'chat-edit-in', bind: 'chat.editText', value: u.editText, rows: 3, attrs: 'data-enter="chat-edit-save" aria-label="Edit your message"' })}<div class="row gap-8"><span class="grow t-xs muted">The answer below will be replaced.</span>${btn('Cancel', { size: 'sm', act: 'chat-edit-cancel' })}${btn('Send', { v: 'primary', size: 'sm', act: 'chat-edit-save' })}</div></div></div>`;
  return `<div class="chat-msg chat-msg--user" id="msg-${m.id}"><div class="chat-user">${filesRow}<div class="chat-bubble">${esc(m.text)}</div><div class="chat-user__actions">${iconBtn('copy', 'Copy', { size: 'sm', act: 'copy', data: { text: m.text, msg: 'Copied' } })}${iconBtn('pencil', 'Edit', { size: 'sm', act: 'chat-edit', data: { msg: m.id } })}</div></div></div>`;
}
const STEP_IC = { search: 'search', read: 'file-text', prepare: 'server', code: 'terminal', export: 'file', edit: 'pencil' };
function stepsSummary(m) {
  const steps = (m.work || []).filter(s => !s.live); const parts = [];
  const search = steps.find(s => s.k === 'search'); if (search) parts.push(clean(search.label));
  const reads = steps.filter(s => s.k === 'read').length; if (reads) parts.push(`Read ${plural(reads, 'document')}`);
  const runs = steps.flatMap(s => s.runs || []);
  if (runs.length) { const bad = runs.filter(r => r.exit).length; parts.push(runs.length === 1 && !bad ? 'Ran code' : `Ran ${plural(runs.length, 'command')}${bad ? `, ${bad} failed` : ''}`); }
  const made = (m.artifacts || []).filter(r => r.rev <= 1).length, upd = (m.artifacts || []).length - made;
  if (made) parts.push(`Created ${plural(made, 'file')}`);
  if (upd) parts.push(`Updated ${plural(upd, 'file')}`);
  if (!parts.length && steps[0]) parts.push(clean(steps[0].label));
  if (m.dur) parts.push(`${m.dur}s`);
  return parts.join(' · ');
}
function stepsList(m) {
  const u = cui();
  return `<ol class="chat-steps__list" aria-label="Steps">${(m.work || []).map((s, si) => {
    const runs = (s.runs || []).map((r, ri) => {
      const key = `${m.id}:run:${si}:${ri}`, show = !!u.open[key];
      const lastErr = r.exit ? String(r.out || '').trim().split('\n').filter(Boolean).at(-1) : '';
      return `<div class="chat-run"><div class="chat-run__head">${ic('terminal', 'i-xs')}<span>Command ${ri + 1}</span>${linkBtn(show ? 'Hide code' : 'Show code', { act: 'chat-run', data: { k: key } })}<span class="grow"></span>${chip(r.exit ? `Failed · exit ${r.exit}` : 'OK', { tone: r.exit ? 'danger' : 'success', size: 'sm', variant: r.exit ? 'soft' : 'tertiary' })}</div>${show ? `<pre class="chat-run__code">${esc(r.cmd)}</pre>${r.out ? `<pre class="${cx('chat-run__out', r.err && 'is-err')}">${esc(r.out)}</pre>` : ''}` : lastErr ? `<pre class="chat-run__out is-err">${esc(lastErr)}</pre>` : ''}</div>`;
    }).join('');
    return `<li class="${cx('chat-step', s.live && 'is-live', s.bad && 'is-bad')}">${s.live ? spinner('sm') : ic(STEP_IC[s.k] || 'check', 'i-sm')}<div class="grow"><span>${esc(clean(s.label))}</span>${s.d ? ` <span class="muted">· ${esc(s.d)}</span>` : ''}${runs}</div></li>`;
  }).join('')}</ol>`;
}
function stepsHtml(m) {
  const work = m.work || [];
  if (m.state === 'streaming' && m.phase === 'work') {
    const cur = [...work].reverse().find(s => s.live);
    return `<div class="chat-steps"><span class="chat-steps__live" role="status" aria-live="polite">${spinner('sm')}<span class="truncate">${esc(clean(cur?.label || `Searching ${m.searching || 'your knowledge'}`))}…</span></span>${prefShowSteps() && work.length ? stepsList(m) : ''}</div>`;
  }
  if (!prefShowSteps() || !work.length) return '';
  const open = !!cui().open[m.id];
  return `<div class="chat-steps"><button type="button" class="chat-steps__toggle" data-act="chat-steps" data-msg="${m.id}" aria-expanded="${open}">${ic(open ? 'chevron-down' : 'chevron-right', 'i-sm')}<span class="truncate">${esc(stepsSummary(m) || 'How this answer was found')}</span></button>${open ? stepsList(m) : ''}</div>`;
}
/* Follow-up action chips under an answer: the next step it suggests. */
const NEXT_IC = { 'rq-new': 'send', 'rq-ask-staff': 'message' };
const nextIcon = n => n.act === 'work-start' ? (WORKFLOWS[n.data?.workflow]?.icon || 'sparkles') : NEXT_IC[n.act] || 'arrow-right';
function nextHtml(m) {
  const items = (m.next || []).filter(n => n?.label && (n.act || n.href));
  if (!items.length || m.state === 'streaming') return '';
  return `<div class="chat-next" role="group" aria-label="Next steps">${items.map((n, i) => btn(n.label, { v: i ? 'tertiary' : 'secondary', size: 'sm', icon: nextIcon(n), act: 'chat-next', data: { msg: m.id, i: (m.next || []).indexOf(n) } })).join('')}</div>`;
}
const qstr = o => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%2C/g, ',')}`).join('&');
/** Routes to fall back on while the module that owns an action hasn't loaded. */
const NEXT_ROUTE = {
  'work-start': d => '/work/new?' + qstr({ workflow: d.workflow, space: d.space, docs: d.docs }),
  'rq-new': d => '/requests/new' + (d.type ? '?type=' + d.type : ''),
  'rq-ask-staff': d => '/space/' + d.space,
};
A['chat-next'] = el => {
  const { conv, m } = findMsg(el.dataset.msg); const n = m?.next?.[+el.dataset.i]; if (!n) return;
  if (n.href) { go(n.href); return; }
  const data = Object.fromEntries(Object.entries(n.data || {}).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v == null ? '' : String(v)]));
  if (n.act === 'rq-ask-staff') data.conv ??= conv.id;
  if (A[n.act]) A[n.act]({ dataset: data });
  else if (NEXT_ROUTE[n.act]) go(NEXT_ROUTE[n.act](data));
};

function aiInner(conv, m) {
  X.chatFiles?.migrate(conv, m);
  if (m.activity?.length && !m.work) { m.work = m.activity.map(s => ({ k: s.kind, label: s.label, d: s.detail })); delete m.activity; }
  const u = cui(), all = m.citations || [], vis = visCites(m), visN = new Set(vis.map(c => c.n));
  const activeN = u.panel?.kind === 'cite' && u.panel.msg === m.id ? u.panel.n : null;
  // Built only from knowledge this person can't read: show nothing of it.
  if (all.length && !vis.length && m.state !== 'streaming') {
    const kb = kbById(docById(all[0].doc)?.kb); const locked = kbRole(kb) === 'none';
    return alertBox('default', 'This answer uses knowledge you can’t access', locked ? `It comes from ${esc(kb.name)}. Request access to see it.` : 'Ask a workspace admin if you need it, or ask again to search what you can access.', locked ? btn('Request access', { size: 'sm', act: 'chat-request', data: { kb: kb.id } }) : '', { icon: 'lock' });
  }
  let h = stepsHtml(m);
  const ctx = { cite: n => { if (!visN.has(n)) return ''; const c = vis.find(x => x.n === n), d = docById(c.doc); return `<button type="button" class="cite" data-act="cite-open" data-msg="${m.id}" data-n="${n}" aria-pressed="${activeN === n}" aria-label="Source ${n}: ${esc(d.name)}, page ${c.page}">${n}</button>`; } };
  const txt = (m.text || '') + (m.state === 'streaming' && m.phase === 'write' ? '\u2063' : '');
  if (txt) h += `<div class="chat-answer">${md(txt, ctx)}</div>`;
  if (m.state === 'stopped') h += `<div class="chat-stopped">${ic('stop', 'i-xs')}<span>Stopped</span>${btn('Retry', { v: 'ghost', size: 'sm', icon: 'retry', act: 'chat-retry', data: { msg: m.id } })}</div>`;
  if (m.state === 'error') {
    const fileWork = (m.work || []).some(s => s.bad);
    h += `<div class="mt-12">${alertBox('danger', fileWork ? 'The file work stopped before it finished' : 'The answer stopped before it finished', fileWork ? 'Nothing was saved. Retry to run it again.' : 'Retry to get the full answer.', btn('Retry', { size: 'sm', icon: 'retry', act: 'chat-retry', data: { msg: m.id } }))}</div>`;
  }
  if ((m.state || 'done') === 'done') {
    if (m.noResults) {
      h += `<div class="row gap-8 wrap mt-12">${m.noResults.scoped ? btn('Search all knowledge', { size: 'sm', icon: 'search', act: 'chat-unscope', data: { msg: m.id } }) : ''}${btn('Browse knowledge', { v: m.noResults.scoped ? 'ghost' : 'tertiary', size: 'sm', icon: 'book', href: '/knowledge' })}</div>`;
      if (m.noResults.restricted) h += `<p class="chat-hint">${ic('lock', 'i-xs')}<span>Some knowledge bases are restricted. You can request access from Knowledge.</span></p>`;
    } else if (m.partial || vis.length < all.length) h += `<p class="chat-hint">${ic('lock', 'i-xs')}<span>Knowledge you can’t access may have more on this.</span></p>`;
    if (m.lowConf) h += `<p class="chat-hint">${ic('info', 'i-xs')}<span>The sources don’t settle this, so it’s been flagged to the people who keep this knowledge.</span></p>`;
    h += X.chatFiles?.cards(m) || '';
    if (vis.length) h += `<div class="chat-sources" role="group" aria-label="Sources">${vis.map(c => { const d = docById(c.doc); return `<button type="button" class="chat-source" data-act="cite-open" data-msg="${m.id}" data-n="${c.n}" aria-pressed="${activeN === c.n}" data-tip="${esc(d.name)} · page ${c.page}"><span class="chat-source__n">${c.n}</span>${fileIcon(d.type, 'sm')}<span class="truncate">${esc(d.name)}</span></button>`; }).join('')}</div>`;
    h += nextHtml(m);
    if (!m.noResults) {
      const vi = m.vi ?? (m.variants?.length || 1) - 1;
      const pager = m.variants?.length > 1 ? `<span class="chat-pager">${iconBtn('chevron-left', 'Previous answer', { size: 'sm', act: 'chat-variant', data: { msg: m.id, d: -1 }, disabled: !vi })}<span class="t-xs num">${vi + 1}/${m.variants.length}</span>${iconBtn('chevron-right', 'Next answer', { size: 'sm', act: 'chat-variant', data: { msg: m.id, d: 1 }, disabled: vi >= m.variants.length - 1 })}</span>` : '';
      h += `<div class="chat-actions">${pager}${iconBtn('copy', 'Copy', { size: 'sm', act: 'copy', data: { text: plain(m.text), msg: 'Copied' } })}${iconBtn('retry', 'Retry', { size: 'sm', menu: 'chat-retry', data: { msg: m.id } })}${iconBtn('thumbs-up', 'Good answer', { size: 'sm', act: 'chat-up', data: { msg: m.id }, aria: `aria-pressed="${m.feedback === 'up'}"` })}${iconBtn('thumbs-down', 'Bad answer', { size: 'sm', menu: 'chat-down', data: { msg: m.id }, aria: `aria-pressed="${m.feedback === 'down'}"` })}${iconBtn('more', 'More', { size: 'sm', menu: 'chat-ans-more', data: { msg: m.id } })}</div>`;
    }
  }
  return h;
}
function paint(m) {
  const el = document.getElementById('msg-' + m.id); if (!el) return;
  const { conv } = findMsg(m.id); el.innerHTML = aiInner(conv, m);
  const sc = $('#chat-scroll'); if (sc && stick) sc.scrollTop = sc.scrollHeight;
}
/** A reload mid-stream leaves 'streaming' messages behind; show them as stopped. */
function settleStale(conv) { conv.messages.forEach(m => { if (m.state === 'streaming' && run?.msg !== m.id) { m.state = 'stopped'; m.phase = null; (m.work || []).forEach(s => (s.live = false)); } }); }

/* ═══════════════ Citation panel ═══════════════ */
function citePanel(conv, p) {
  const m = conv.messages.find(x => x.id === p.msg); if (!m) return '';
  const vis = visCites(m); if (!vis.length) return '';
  const i = Math.max(0, vis.findIndex(c => c.n === p.n)), c = vis[i], d = docById(c.doc), kb = kbById(d.kb);
  const ref = `“${c.quote}” — ${d.name}, page ${c.page} (${kb.name})`;
  const others = vis.length > 1 ? `<div class="t-label mt-24 mb-8">In this answer</div>${list(vis.map(x => { const dx = docById(x.doc); return item({ lead: `<span class="cite" aria-hidden="true">${x.n}</span>`, title: esc(dx.name), desc: `Page ${x.page}`, act: 'cite-open', data: { msg: m.id, n: x.n }, cls: cx('chat-cite__other', x.n === c.n && 'is-on') }); }), 'list--plain')}` : '';
  return `<aside class="split__panel chat-cite" aria-label="Source ${c.n}">
    <div class="panel__header"><h2 class="panel__title">Source ${i + 1} of ${vis.length}</h2>${iconBtn('chevron-left', 'Previous source', { size: 'sm', act: 'cite-step', data: { d: -1 }, disabled: i === 0 })}${iconBtn('chevron-right', 'Next source', { size: 'sm', act: 'cite-step', data: { d: 1 }, disabled: i === vis.length - 1 })}${iconBtn('x', 'Close', { size: 'sm', act: 'chat-panel-close' })}</div>
    <div class="panel__body" id="chat-panel-body" data-keep-scroll>
      <div class="row gap-12">${fileIcon(d.type, 'lg')}<div class="grow"><a class="chat-cite__name truncate" href="#${docHref(conv, c)}">${esc(d.name)}</a><div class="t-xs muted truncate">${esc(kb.name)} · Page ${c.page}</div></div>${d.status !== 'ready' ? status('doc', d.status) : ''}</div>
      <blockquote class="chat-cite__quote"><mark class="evidence is-focus">${esc(c.quote)}</mark></blockquote>
      ${others}
    </div>
    <div class="panel__footer">${btn('Open document', { v: 'primary', icon: 'arrow-up-right', href: docHref(conv, c) })}${btn('Copy citation', { v: 'ghost', icon: 'copy', act: 'copy', data: { text: ref, msg: 'Citation copied' } })}</div>
  </aside>`;
}
A['cite-open'] = el => {
  const { msg, n } = el.dataset; const { conv, m } = findMsg(msg); if (!conv) return;
  const vis = visCites(m); const num = +n || vis[0]?.n; if (!vis.length) return;
  const u = cui();
  if (u.panel?.kind === 'file' && X.chatFiles?.leaveEdit && !X.chatFiles.leaveEdit(() => A['cite-open'](el))) return;
  u.panel = { conv: conv.id, kind: 'cite', msg, n: num }; u.panelScroll = true;
  if (S.cur?.path !== '/chat/' + conv.id) go('/chat/' + conv.id); else refresh();
};
A['cite-step'] = el => {
  const p = cui().panel; if (p?.kind !== 'cite') return; const { m } = findMsg(p.msg); const vis = m ? visCites(m) : [];
  const i = vis.findIndex(c => c.n === p.n) + +el.dataset.d; if (!vis[i]) return;
  p.n = vis[i].n; cui().panelScroll = true; refresh();
};
function closePanel() { cui().panel = null; refresh(); focusComposer(); }
A['chat-panel-close'] = () => { if (X.chatFiles?.leaveEdit && !X.chatFiles.leaveEdit(closePanel)) return; closePanel(); };

/* ═══════════════ Pages ═══════════════ */
const STARTER_IC = ['file-text', 'list', 'users'];
/** Quick starts under the home composer: AI workflows that fit what's being searched (a space, the space of one knowledge base, or everywhere). */
function quickStarts(c) {
  if (!hasModule('work')) return '';
  const sp = holderSpace(c) || (c.scope.length === 1 && hasModule('spaces') && spaceById(kbById(c.scope[0])?.space)) || null;
  const wfs = workflowsFor(sp || undefined).slice(0, 3); if (!wfs.length) return '';
  return `<div class="chat-quick" role="group" aria-label="${esc(sp ? `Start work in ${sp.name}` : 'Start work')}">${wfs.map(w => btn(w.label, { v: 'tertiary', size: 'sm', icon: w.icon, act: 'chat-workflow', data: { workflow: w.id, space: sp?.id || '' }, tip: w.desc })).join('')}</div>`;
}
A['chat-workflow'] = el => {
  const { workflow, space } = el.dataset; const data = { workflow, ...(space ? { space } : {}) };
  if (A['work-start']) A['work-start']({ dataset: data }); else go(NEXT_ROUTE['work-start'](data));
};
P.chatHome = () => {
  const a = D.assistant, c = composer('home');
  const starters = (a.roleStarters?.[S.persona] || a.starters || []).slice(0, 3);
  const placeholder = hasModule('spaces') ? `Ask anything in ${curWs().name}` : 'Ask anything about your company knowledge';
  return `<div class="chat-home chat-drop" data-drop="home"><div class="chat-home__inner">
    <h1 class="chat-home__title">${esc(a.welcome || 'What can I help you find?')}</h1>
    <div class="chat-home__ask">${composerHtml({ key: 'home', holder: c, placeholder, lg: true })}${quickStarts(c)}</div>
    ${starters.length ? `<div class="chat-starters" id="chat-starters">${starters.map((s, i) => `<button type="button" class="card card--action chat-starter" data-act="chat-starter" data-prompt="${esc(s.prompt)}"><span class="chat-starter__title">${ic(STARTER_IC[i % 3], 'i-sm')}${esc(s.title)}</span><span class="chat-starter__prompt clamp-2">${esc(s.prompt)}</span></button>`).join('')}</div>` : ''}
  </div></div>`;
};
AFTER.chatHome = ({ changed }) => { if (changed) { cui().panel = null; cui().edit = null; } afterComposer(changed); tourPaint(false); };
function threadSkel() {
  return `<div class="chat-thread" aria-busy="true" aria-label="Loading">${[0, 1].map(i => `<div class="chat-msg chat-msg--user"><span class="skeleton" style="width:${300 - i * 80}px;height:44px;border-radius:var(--radius-3xl)"></span></div><div class="stack gap-8"><span class="skeleton skeleton--line" style="width:40%;height:10px"></span><span class="skeleton skeleton--line" style="width:96%"></span><span class="skeleton skeleton--line" style="width:88%"></span><span class="skeleton skeleton--line" style="width:72%"></span></div>`).join('')}</div>`;
}
P.chatThread = ({ params }) => {
  const conv = convById(params.id);
  if (!isMine(conv)) {
    crumbs([{ label: 'Conversations', to: '/chats' }, { label: 'Not found' }]);
    return `<div class="page">${emptyState({ icon: 'message', title: 'This conversation isn’t available', desc: 'It may have been deleted, or it belongs to someone else.', actions: btn('New chat', { v: 'primary', icon: 'message-plus', href: '/chat' }) + btn('Conversations', { href: '/chats' }) })}</div>`;
  }
  ensureSeed(conv); conv.scope ??= []; settleStale(conv);
  const sp = holderSpace(conv);
  crumbs(sp ? [{ label: 'Spaces', to: '/spaces' }, { label: sp.name, to: '/space/' + sp.id }, { label: conv.title }] : [{ label: 'Conversations', to: '/chats' }, { label: conv.title }]);
  topbarActions(btn('Share', { v: 'ghost', size: 'sm', icon: 'share', act: 'chat-share', data: { id: conv.id } }) + iconBtn('more', 'More', { size: 'sm', menu: 'chat-more', data: { id: conv.id } }));
  const u = cui(); const panel = u.panel?.conv === conv.id ? u.panel : null;
  const streaming = run?.conv === conv.id;
  const ok = () => `<h1 class="sr-only">${esc(conv.title)}</h1><div class="chat-thread">${conv.messages.map(m => m.role === 'user' ? userHtml(m) : `<div class="chat-msg chat-msg--ai" id="msg-${m.id}">${aiInner(conv, m)}</div>`).join('')}</div>`;
  const side = panel ? (panel.kind === 'file' ? X.chatFiles?.panel(conv, panel) : citePanel(conv, panel)) || '' : '';
  return `<div class="split chat-split">
    <div class="split__main chat-main chat-drop" data-drop="${conv.id}">
      <div class="chat-scroll" id="chat-scroll" data-keep-scroll>${gate({ ok, loading: threadSkel, error: ok, empty: ok })}</div>
      <div class="chat-dock"><div class="chat-dock__inner">${composerHtml({ key: conv.id, holder: conv, placeholder: 'Ask a follow-up', streaming })}</div></div>
    </div>${side}</div>`;
};
AFTER.chatThread = ({ params, changed }) => {
  const u = cui();
  if (changed) { u.edit = null; if (u.panel && u.panel.conv !== params.id) { u.panel = null; refresh(); return; } }
  const sc = $('#chat-scroll');
  if (sc) {
    if (changed || stick) sc.scrollTop = sc.scrollHeight;
    if (changed) stick = true;
    sc.onscroll = () => { stick = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80; };
  }
  if (u.panelScroll) {
    u.panelScroll = false;
    const mark = u.panel?.kind === 'cite' && $(`#msg-${u.panel.msg} .cite[aria-pressed="true"]`);
    if (mark && sc) { const r = mark.getBoundingClientRect(), s = sc.getBoundingClientRect(); if (r.top < s.top || r.bottom > s.bottom) { sc.scrollTop += r.top - s.top - s.height / 3; stick = false; } }
  }
  X.chatFiles?.after?.();
  afterComposer(changed);
};

/* ═══════════════ Sending & streaming ═══════════════ */
const SNAP = ['text', 'citations', 'work', 'artifacts', 'noResults', 'partial', 'next', 'lowConf', 'feedback', 'reason', 'dur', 'state'];
const snap = m => Object.fromEntries(SNAP.map(k => [k, clone(m[k] ?? null)]));
function basicPlan(q, conv, files, mod) {
  const a = answer(q, conv.scope || [], files.map(f => f.name), conv.space || null);
  let text = a.text;
  if (mod === 'shorter' && !a.noResults) text = text.split('\n\n').slice(0, 2).join('\n\n');
  return { text, citations: a.citations, noResults: a.noResults || null, partial: a.partial, next: a.next || null, gap: a.gap || null, lowConf: !!a.lowConf, searchLabel: a.searchLabel, work: a.activity.map(s => ({ k: s.kind, label: s.label, d: s.detail })) };
}
async function stream(conv, am, fail) {
  const r = run = { conv: conv.id, msg: am.id, stop: false };
  const um = conv.messages[conv.messages.indexOf(am) - 1];
  const files = (um?.files || []).map(normFile);
  if (am.text && ['done', 'stopped'].includes(am.state || 'done')) am.variants ??= [snap(am)];
  const plan = (X.chatFiles?.plan || basicPlan)(am.q, conv, files, am.mod); am.mod = null;
  delete am.activity; delete am.artifact;
  Object.assign(am, { text: '', citations: [], work: [], artifacts: [], noResults: null, partial: false, next: null, lowConf: false, feedback: null, reason: null, state: 'streaming', phase: 'work', searching: plan.searchLabel, t0: Date.now() });
  refresh();
  const alive = () => D.convs.includes(conv) && !r.stop;
  for (const st of plan.work) {
    if (!alive()) return end(r, am, 'stopped');
    const step = { ...st, live: true, runs: st.runs ? [] : undefined }; am.work.push(step); paint(am);
    if (st.runs) for (const x of st.runs) {
      await sleep(600); if (!alive()) return end(r, am, 'stopped');
      if (fail) { step.runs.push({ cmd: x.cmd, out: 'The secure workspace stopped responding.', exit: 1, err: true }); step.label = 'Code hit an error'; step.bad = true; step.live = false; paint(am); return end(r, am, 'error'); }
      step.runs.push(x); paint(am);
    }
    await sleep(st.k === 'search' ? 900 : st.k === 'code' ? 300 : 500);
    step.live = false; paint(am);
  }
  if (!alive()) return end(r, am, 'stopped');
  Object.assign(am, { phase: 'write', citations: plan.citations });
  const parts = (plan.text || '').split(/(\s+)/), failAt = fail ? Math.floor(parts.length * 0.45) : Infinity;
  for (let i = 0; i < parts.length; i += 2) {
    if (!alive()) return end(r, am, 'stopped');
    if (i >= failAt) return end(r, am, 'error');
    am.text = parts.slice(0, i + 1).join(''); paint(am);
    await sleep(22);
  }
  Object.assign(am, { text: plan.text, noResults: plan.noResults, partial: plan.partial, next: plan.next || null, lowConf: !!plan.lowConf });
  if (plan.gap && !am.gapLogged) { recordGap(plan.gap); am.gapLogged = true; }
  if (plan.apply) am.artifacts = plan.apply();
  if (am.variants) { am.variants.push(null); am.vi = am.variants.length - 1; }
  end(r, am, 'done');
  if (am.variants) am.variants[am.vi] = snap(am);
  X.chatFiles?.afterStream?.(am, plan);
}
function end(r, am, st) { am.dur = Math.max(2, Math.round((Date.now() - (am.t0 || Date.now())) / 1000)); am.state = st; am.phase = null; (am.work || []).forEach(s => (s.live = false)); if (run === r) run = null; refresh(); }
/** Add a user turn to a conversation and stream the answer. */
function ask(conv, q, files = []) {
  conv.at = Date.now();
  conv.messages.push({ id: uid('m'), role: 'user', text: q, files });
  const am = { id: uid('m'), role: 'assistant', q, text: '', citations: [], state: 'streaming', phase: 'work' };
  conv.messages.push(am); stick = true;
  const fail = S.pageState === 'error';
  if (S.cur?.path !== '/chat/' + conv.id) go('/chat/' + conv.id);
  stream(conv, am, fail);
  return am;
}
function start(q, { scope = [], files = [], space = null } = {}) {
  const conv = { id: uid('c'), owner: me().id, title: makeTitle(q), at: Date.now(), scope, ...(space ? { space } : {}), messages: [] };
  D.convs.unshift(conv); cui().panel = null;
  ask(conv, q, files);
  return conv;
}
A['chat-send'] = () => {
  const key = composerKey(); const c = composer(key); const q = c.draft.trim();
  if (!q || c.files.some(f => !f.ready && !f.error)) { $('#chat-input')?.focus(); return; }
  if (run) { toast(run.conv === key ? 'Wait for this answer to finish, or stop it.' : 'Another answer is still being written. Wait for it or stop it.', { tone: 'accent' }); return; }
  const files = c.files.filter(f => f.ready).map(({ name, type, kind, doc }) => ({ name, type, kind, doc }));
  c.draft = ''; c.files = [];
  if (key === 'home') { const scope = c.scope.filter(id => canReadKb(kbById(id))); const space = holderSpace(c)?.id || null; c.scope = []; c.space = null; start(q, { scope, space, files }); }
  else ask(convById(key), q, files);
};
A['chat-starter'] = el => { composer('home').draft = el.dataset.prompt; A['chat-send'](); };
A['chat-stop'] = () => { if (run) run.stop = true; };
function retry(msgId, mod) {
  if (run) return; const { conv, m } = findMsg(msgId); if (!m) return;
  m.q ??= conv.messages[conv.messages.indexOf(m) - 1]?.text || conv.title;
  m.mod = mod; stick = true; stream(conv, m, S.pageState === 'error');
}
A['chat-retry'] = el => retry(el.dataset.msg, null);
A['chat-unscope'] = el => { const { conv } = findMsg(el.dataset.msg); if (!conv || run) return; conv.scope = []; conv.space = null; retry(el.dataset.msg, null); };
MENUS['chat-retry'] = el => {
  const { conv } = findMsg(el.dataset.msg); if (!conv) return [];
  const items = [{ label: 'Try again', icon: 'retry', run: () => retry(el.dataset.msg, null) }, { label: 'More detail', icon: 'list', run: () => retry(el.dataset.msg, 'detail') }, { label: 'Shorter', icon: 'sliders', run: () => retry(el.dataset.msg, 'shorter') }];
  if (conv.scope?.length) items.push({ sep: true }, { label: 'Search all knowledge', icon: 'layers', run: () => { conv.scope = []; conv.space = null; retry(el.dataset.msg, null); } });
  return run ? items.map(i => i.sep ? i : { ...i, disabled: true }) : items;
};
A['chat-variant'] = el => { const { m } = findMsg(el.dataset.msg); if (!m?.variants || run) return; m.vi = Math.max(0, Math.min(m.variants.length - 1, (m.vi ?? m.variants.length - 1) + +el.dataset.d)); Object.assign(m, clone(m.variants[m.vi])); refresh(); };
A['chat-steps'] = el => { const u = cui(); u.open[el.dataset.msg] = !u.open[el.dataset.msg]; refresh(); };
A['chat-run'] = el => { const u = cui(); u.open[el.dataset.k] = !u.open[el.dataset.k]; const { m } = findMsg(el.dataset.k.split(':run:')[0]); m ? paint(m) : refresh(); };

/** Shared entry point: start a new conversation with question q, optionally scoped to a knowledge base or a space (its knowledge), with one resource (doc) or several (docs, comma list) attached as references. Empty q opens /chat with that scope chosen. */
A['chat-ask'] = el => {
  const { q = '', kb, space, doc, docs } = el?.dataset || {};
  const sp = space && hasModule('spaces') ? spaceById(space) : null;
  const spKbs = readableKbsOf(sp);
  const scope = kb && canReadKb(kbById(kb)) ? [kb] : spKbs;
  const spaceId = sp && spKbs.length ? sp.id : null;
  if (!q.trim()) { Object.assign(composer('home'), { scope, space: spaceId }); go('/chat'); focusComposer(); return; }
  if (run) run.stop = true;
  const refs = [...new Set([doc, ...String(docs || '').split(',')].filter(Boolean))].map(docById).filter(d => d && canDoc(d)).slice(0, 10);
  start(q.trim(), { scope, space: spaceId, files: refs.map(d => ({ name: d.name, type: d.type, kind: 'ref', doc: d.id })) });
};

/* Edit a question → replaces the answer below it */
A['chat-edit'] = el => {
  if (run) return; const { m } = findMsg(el.dataset.msg); if (!m) return;
  const u = cui(); u.edit = m.id; u.editText = m.text; refresh();
  requestAnimationFrame(() => { const t = $('#chat-edit-in'); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } });
};
A['chat-edit-cancel'] = () => { cui().edit = null; refresh(); focusComposer(); };
A['chat-edit-save'] = () => {
  const u = cui(); const { conv, m } = findMsg(u.edit); const t = (u.editText || '').trim(); if (!m || !t) return;
  const i = conv.messages.indexOf(m); const later = conv.messages.length - (i + 2);
  const resend = () => {
    m.text = t; u.edit = null;
    let am = conv.messages[i + 1];
    if (!am || am.role !== 'assistant') { am = { id: uid('m'), role: 'assistant' }; conv.messages.splice(i + 1, 0, am); }
    conv.messages.length = i + 2; am.q = t; am.text = ''; am.variants = null; am.vi = null; stick = true; conv.at = Date.now();
    stream(conv, am, S.pageState === 'error');
  };
  if (later > 0) confirmAction({ title: 'Edit and resend?', body: `The ${plural(later, 'later message')} in this conversation will be removed. Files the assistant made stay available.`, confirm: 'Edit and resend', delay: 0, onConfirm: resend });
  else resend();
};

/* Feedback */
const FB_REASONS = ['Not accurate', 'Missing information', 'Wrong source', 'Didn’t answer my question'];
function setFeedback(m, kind, reason = null) { m.feedback = kind; m.reason = reason; refresh(); if (kind) toast('Thanks — your feedback goes to the workspace admins'); }
A['chat-up'] = el => { const { m } = findMsg(el.dataset.msg); if (m) setFeedback(m, m.feedback === 'up' ? null : 'up'); };
MENUS['chat-down'] = el => {
  const { m } = findMsg(el.dataset.msg); if (!m) return [];
  const items = [{ section: 'What was wrong?' }, ...FB_REASONS.map(r => ({ label: r, checked: m.feedback === 'down' ? m.reason === r : undefined, run: () => setFeedback(m, 'down', r) })),
    { label: 'Something else…', icon: 'pencil', run: () => { S.ui.chatFb = { text: '', err: '' }; openModal('chat-feedback', { msg: m.id }); } }];
  if (m.feedback === 'down') items.push({ sep: true }, { label: 'Remove feedback', icon: 'x', run: () => setFeedback(m, null) });
  return items;
};
M['chat-feedback'] = p => {
  const f = ui('chatFb', { text: '', err: '' });
  return { size: 'sm', title: 'What was wrong with this answer?', desc: 'Your feedback goes to the workspace admins.',
    body: field({ id: 'chat-fb-text', label: 'Tell us more', error: f.err, control: textarea({ id: 'chat-fb-text', bind: 'chatFb.text', value: f.text, rows: 3, placeholder: 'What should the answer have said?', invalid: !!f.err }) }),
    foot: btn('Cancel', { act: 'close-modal' }) + btn('Send feedback', { v: 'primary', act: 'chat-fb-send', loading: p.busy }) };
};
A['chat-fb-send'] = async () => {
  const f = ui('chatFb'), p = S.modal.props;
  if (!f.text.trim()) { f.err = 'Add a short comment.'; refreshLayer(); $('#chat-fb-text')?.focus(); return; }
  p.busy = true; p.guard = true; refreshLayer(); await sleep(600);
  const { m } = findMsg(p.msg); closeModal(); if (m) setFeedback(m, 'down', f.text.trim().slice(0, 140));
};

/* Answer: more menu (copy as Markdown, Word, PDF) */
function wrap(line, w = 90) { const out = []; let cur = ''; String(line).split(/\s+/).forEach(word => { if ((cur + ' ' + word).trim().length > w) { if (cur) out.push(cur); cur = word; } else cur = (cur + ' ' + word).trim(); }); if (cur) out.push(cur); return out.length ? out : ['']; }
function downloadAnswer(conv, m, format) {
  const vis = visCites(m); const visN = new Set(vis.map(c => c.n));
  const srcLines = vis.map(c => { const d = docById(c.doc); return `[${c.n}] ${d.name}, page ${c.page}`; });
  if (format === 'word') {
    const html = md(m.text, { cite: n => visN.has(n) ? `<sup>[${n}]</sup>` : '' }) + (vis.length ? `<h3>Sources</h3><ol>${vis.map(c => { const d = docById(c.doc); return `<li>${esc(d.name)}, page ${c.page} — “${esc(c.quote)}”</li>`; }).join('')}</ol>` : '');
    return saveWord(withExt(conv.title, '.doc'), conv.title, html);
  }
  const body = String(m.text || '').replace(/\*\*|\*/g, '').split('\n').filter(l => !/^\s*\|[\s|:-]+\|?\s*$/.test(l)).map(l => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').replace(/\|/g, ' | ').replace(/^\s*- /, '• '));
  savePdf(withExt(conv.title, '.pdf'), conv.title, [...body.flatMap(l => wrap(l)), ...(srcLines.length ? ['', 'Sources', ...srcLines.flatMap(l => wrap(l))] : [])]);
}
MENUS['chat-ans-more'] = el => {
  const { conv, m } = findMsg(el.dataset.msg); if (!m) return [];
  return [{ label: 'Copy as Markdown', icon: 'copy', run: () => copyText(m.text, 'Copied as Markdown') }, { sep: true },
    { label: 'Download as Word', icon: 'download', meta: '.doc', run: () => downloadAnswer(conv, m, 'word') },
    { label: 'Download as PDF', icon: 'download', meta: '.pdf', run: () => downloadAnswer(conv, m, 'pdf') }];
};
A['chat-request'] = el => {
  if (A['kb-request']) return A['kb-request'](el);
  const kb = el.dataset.kb;
  if (D.requests.some(r => r.user === me().id && r.kb === kb && r.status === 'pending')) { toast('Access already requested', { tone: 'accent' }); return; }
  D.requests.push({ id: uid('req'), user: me().id, kb, role: 'viewer', note: '', at: Date.now(), status: 'pending' });
  toast('Access requested'); refresh();
};

/* Thread more menu → rename / delete live in conversations.js */
MENUS['chat-more'] = el => [
  { label: 'Rename', icon: 'pencil', run: () => A['conv-rename']?.({ dataset: { id: el.dataset.id } }) },
  { sep: true },
  { label: 'Delete conversation', icon: 'trash', danger: true, run: () => A['conv-delete']?.({ dataset: { id: el.dataset.id } }) },
];

/* ═══════════════ Share ═══════════════ */
A['chat-share'] = el => { S.ui.chatShare = { id: el.dataset.id, who: 'workspace', people: '', err: '' }; openModal('chat-share'); };
M['chat-share'] = () => {
  const s = ui('chatShare'); const conv = convById(s.id); const ws = curWs();
  const link = `https://bomesh.app/${ws.code}/s/${s.id}-${(hashOf(s.id) % 1679616).toString(36)}`;
  return { title: 'Share conversation', desc: esc(conv?.title || ''),
    body: field({ id: 'chat-share-who', label: 'Who can open the link', control: select({ id: 'chat-share-who', bind: 'chatShare.who', value: s.who, change: 'chat-share-who', options: [['workspace', `Anyone in ${ws.name}`], ['people', 'Only people I choose']] }) })
      + (s.who === 'people' ? field({ id: 'chat-share-people', label: 'People', desc: 'Separate names or emails with commas.', error: s.err, control: input({ id: 'chat-share-people', bind: 'chatShare.people', value: s.people, placeholder: 'An Nguyen, ben.walker@northwind.com', autofocus: true, invalid: !!s.err }) }) : '')
      + field({ id: 'chat-share-link', label: 'Link', control: input({ id: 'chat-share-link', value: link, attrs: 'readonly', cls: 'mono' }) })
      + `<p class="chat-hint mt-16">${ic('lock', 'i-xs')}<span>People see the answers, but only open sources they already have access to.</span></p>`,
    foot: btn('Done', { act: 'close-modal' }) + btn('Copy link', { v: 'primary', icon: 'copy', act: 'chat-share-copy', data: { link } }) };
};
A['chat-share-who'] = () => { ui('chatShare').err = ''; refreshLayer(); };
A['chat-share-copy'] = async el => {
  const s = ui('chatShare');
  if (s.who === 'people' && !s.people.trim()) { s.err = 'Add at least one person.'; refreshLayer(); $('#chat-share-people')?.focus(); return; }
  s.err = ''; refreshLayer();
  if (await copyText(el.dataset.link, s.who === 'people' ? 'Link copied. Only the people you chose can open it.' : 'Link copied')) closeModal();
};

/* ═══════════════ Escape: edit → file editing → panel ═══════════════ */
const prevEsc = A['esc-page'];
A['esc-page'] = () => {
  if (S.cur?.r.page === 'chatThread') {
    const u = cui();
    if (u.edit) { A['chat-edit-cancel'](); return true; }
    if (u.panel) { A['chat-panel-close'](); return true; }
  }
  return prevEsc?.() || false;
};

/* ═══════════════ Product tour (4 steps on /chat) ═══════════════ */
const TOUR = [
  { sel: '#chat-composer', title: 'Ask in your own words', body: 'Answers come from your company knowledge and cite every source they use.' },
  { sel: '#chat-scope', title: 'Choose what to search', body: 'Search all knowledge, or narrow it to the knowledge bases that matter.' },
  { sel: '#chat-starters', title: 'Start from a suggestion', body: 'Common questions, picked by your workspace admin.' },
  { sel: '.sidebar [data-act="palette"]', title: 'Find anything', body: 'Search conversations, documents and pages, or press ⌘K.' },
];
let tourAt = null;
function tourSteps() {
  const fr = $('#frame').getBoundingClientRect();
  return TOUR.filter(s => { const el = $(s.sel); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.right > fr.left + 4 && r.left < fr.right - 4; });
}
function tourClose() { tourAt = null; $('#chat-tour')?.remove(); $('#chat-tour-ring')?.remove(); }
function tourPaint(focus) {
  $('#chat-tour')?.remove(); $('#chat-tour-ring')?.remove();
  if (tourAt == null) return;
  if (S.cur?.r.page !== 'chatHome') { tourAt = null; return; }
  const steps = tourSteps(); if (!steps.length) { tourAt = null; return; }
  tourAt = Math.min(tourAt, steps.length - 1);
  const st = steps[tourAt], t = $(st.sel), frame = $('#frame');
  const fr = frame.getBoundingClientRect(), r = t.getBoundingClientRect(), pad = 6, last = tourAt === steps.length - 1;
  const ring = document.createElement('div'); ring.id = 'chat-tour-ring'; ring.className = 'chat-tour-ring';
  Object.assign(ring.style, { left: r.left - fr.left - pad + 'px', top: r.top - fr.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
  const card = document.createElement('div'); card.id = 'chat-tour'; card.className = 'chat-tour'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-labelledby', 'chat-tour-title');
  card.innerHTML = `<div class="row between"><span class="t-xs muted num">${tourAt + 1} of ${steps.length}</span>${iconBtn('x', 'Close tour', { size: 'sm', act: 'chat-tour-skip' })}</div><h3 class="t-subheading" id="chat-tour-title">${esc(st.title)}</h3><p class="t-sm muted">${esc(st.body)}</p><div class="row between mt-8">${btn('Skip', { v: 'ghost', size: 'sm', act: 'chat-tour-skip' })}<div class="row gap-8">${tourAt ? btn('Back', { size: 'sm', act: 'chat-tour-step', data: { d: -1 } }) : ''}${btn(last ? 'Done' : 'Next', { v: 'primary', size: 'sm', act: 'chat-tour-step', data: { d: 1 }, id: 'chat-tour-next' })}</div></div>`;
  frame.append(ring, card);
  const cw = card.offsetWidth, ch = card.offsetHeight; let left, top;
  if (r.left - fr.left < 260 && r.width < 300) { left = r.right - fr.left + 16; top = r.top - fr.top - 8; }
  else { left = r.left - fr.left + r.width / 2 - cw / 2; top = r.bottom - fr.top + 14; if (top + ch > fr.height - 12) top = r.top - fr.top - ch - 14; }
  card.style.left = Math.max(12, Math.min(fr.width - cw - 12, left)) + 'px';
  card.style.top = Math.max(12, Math.min(fr.height - ch - 12, top)) + 'px';
  if (focus) requestAnimationFrame(() => $('#chat-tour-next')?.focus());
}
X.startTour = () => {
  tourClose();
  if (S.cur?.r.page !== 'chatHome') go('/chat');
  else if (S.navOpen) { S.navOpen = false; refresh(); }
  setTimeout(() => { tourAt = 0; tourPaint(true); }, 160);
};
A['chat-tour-step'] = el => {
  const n = tourAt + +el.dataset.d;
  if (n >= tourSteps().length) { tourClose(); toast('You’re all set. Ask your first question.'); focusComposer(); return; }
  tourAt = Math.max(0, n); tourPaint(true);
};
A['chat-tour-skip'] = () => { tourClose(); focusComposer(); };
window.addEventListener('resize', () => tourAt != null && tourPaint(false));
window.addEventListener('hashchange', () => setTimeout(() => tourAt != null && tourPaint(false), 0));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && tourAt != null && !S.modal && !S.menu && !S.palette) { e.stopPropagation(); tourClose(); focusComposer(); } }, true);

/* Internal API shared with chat-files.js and conversations.js */
X.chat = { findMsg, answer, plain, makeTitle, cui, composer, composerKey, canDoc, visCites, normFile, mineKb, isMine, paint, focusComposer, ensureSeed, lastLine, ask, CLAIMS,
  busy: () => !!run, streamingIn: id => run?.conv === id, stopIfIn: id => { if (run?.conv === id) run.stop = true; } };
})();
