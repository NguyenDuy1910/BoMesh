(() => {
'use strict';
/* Chat: New chat (/chat: the composer, nothing open) and threads (/chat/:id) — permission-aware
   canned answers that stream with work steps, inline citations, a citation
   side panel, feedback, retry/edit, share and the product tour.
   File work (artifacts, attachments, file panel) lives in chat-files.js and
   plugs in through X.chatFiles; the conversation list and its ⋯ menu are conversations.js. */

let run = null;    // active stream: { conv, msg, stop }
/* Scrolling: opening a conversation shows its latest turn; sending (or retrying, or editing) brings the question to the
   top and the answer grows below it — the thread never scrolls by itself while the assistant works. `turn` = a turn was
   sent in this view (its question stays reachable at the top: room under it, `#chat-tail`); `pin` = bring it there. */
let turn = false, pin = false;
const PIN_GAP = 16;
const lastQuestion = sc => [...sc.querySelectorAll('.chat-msg--user')].at(-1);
/** Room under the last question, so it can sit at the top while its answer is still short. */
function fitTail(sc) {
  const tail = sc.querySelector('#chat-tail'); if (!tail) return;
  const q = turn && lastQuestion(sc);
  const h = q ? Math.max(0, sc.clientHeight - (tail.getBoundingClientRect().top - q.getBoundingClientRect().top) - PIN_GAP) : 0;
  tail.style.height = h + 'px'; cui().tail = h;
}
function pinQuestion(sc) {
  const q = lastQuestion(sc); if (!q) return;
  const top = sc.scrollTop + q.getBoundingClientRect().top - sc.getBoundingClientRect().top - PIN_GAP;
  sc.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
const cui = () => { const u = ui('chat', { panel: null, open: {}, edit: null, editText: '' }); u.open ??= {}; return u; };
/** Composer state per place: 'home', 'proj:<project id>' or a conversation id (drafts never leak between threads). */
function composer(key) { const all = ui('composer'); const c = (all[key] ??= { draft: '', files: [], scope: [], space: null, off: [] }); c.draft ??= ''; c.files ??= []; c.scope ??= []; c.space ??= null; c.off ??= []; return c; }
const composerKey = () => S.cur?.r.page === 'chatThread' ? S.cur.params.id : S.cur?.r.page === 'project' ? 'proj:' + S.cur.params.id : 'home';
function findMsg(id) { for (const conv of D.convs) { const m = conv.messages.find(x => x.id === id); if (m) return { conv, m }; } return {}; }
const canDoc = d => !!d && canReadKb(kbById(d.kb));
const visCites = m => (m.citations || []).filter(c => canDoc(docById(c.doc)));
const plain = t => String(t || '').replace(/\[([^\]]+)\]\(\/[^)\s]*\)/g, '$1').replace(/\*\*|\*/g, '').replace(/\s?\[\d+\]/g, '').replace(/^\|.*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
/** The caller's personal collection ("My files") in this workspace. */
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
/** Drop names of collections the caller can't read from step labels. */
function clean(s) {
  D.kbs.filter(k => !canReadKb(k)).forEach(k => { s = String(s).split(' and ' + k.name).join('').split(k.name + ' and ').join('').split(', ' + k.name).join(''); });
  return s;
}

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
  return { text, citations: [], activity: [{ kind: 'search', label: 'Checked the calendars of your spaces' }], next, files: false };
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
  return { text: parts.length ? parts.join('\n\n') : 'No questions came in this week, and nothing went unanswered.', citations: [],
    activity: [{ kind: 'search', label: 'Checked questions sent to your spaces' }, { kind: 'search', label: 'Checked unanswered questions' }], next, files: false };
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
/** Greetings, thanks and questions about the assistant itself need no knowledge: the answer comes without a search step
    (the model decides; the live line says "Thinking" until it writes). */
const SMALL_TALK = /^\s*(hi|hello|hey|thanks?|thank you|cảm ơn|xin chào|chào( bạn)?|who are you|what('?s| is) your name|what can you do|bạn (là ai|tên (là )?gì)( vậy)?|bạn làm được gì)\b[\s!?.]*$/i;
function smallTalk(q) {
  if (!SMALL_TALK.test(q)) return null;
  const text = /thank|cảm ơn/i.test(q) ? 'You’re welcome. Ask me anything else about your work.'
    : `I’m the ${curWs().name} assistant. I answer from the knowledge you can access and cite the documents I use. Ask me about a policy, a process or a document.`;
  return { text, citations: [], activity: [], files: false };
}
function answer(q, scope = [], fileNames = [], space = null) {
  const readable = visibleKbs().filter(canReadKb);
  const inScope = id => !scope.length || scope.includes(id);
  const lockedExists = visibleKbs().some(k => kbRole(k) === 'none');
  const table = TOPIC_TABLES[S.ws];
  const t = (table?.topics || TOPICS).find(x => x.k.test(q) && (!x.when || x.when()));
  if (t?.live) return t.live(q);
  const chat = !fileNames.length && smallTalk(q);
  if (chat) return chat;
  const ctx = { q, p: me().profile || null };
  const files = t?.files ?? table?.files;
  let text, cites, artifact = null; const extra = [];
  if (t?.from) { const src = CANON[t.from]; text = src.text; cites = src.citations; artifact = src.artifact || null; if (t.from === 'c2') extra.push({ kind: 'code', label: 'Analyzed the spreadsheet' }); }
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
  // Named only when the person narrowed the search to one or two collections; never a count.
  const scopeName = scope.length && names.length && names.length <= 2 ? names.join(' and ') : 'your knowledge';
  const noRes = restricted => {
    const r = { text: 'I couldn’t find this in the knowledge you can access.', citations: [], activity: [{ kind: 'search', label: `Searched ${scopeName}` }], noResults: { scoped: scope.length > 0, restricted: restricted || lockedExists }, files };
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
  // A search finds more than the answer ends up citing: the closest neighbours in the same collections.
  const nearby = D.docs.filter(d => !readDocs.includes(d) && !d.archived && d.status === 'ready' && canDoc(d) && readDocs.some(r => r.kb === d.kb)).sort((a, b) => b.updated - a.updated).slice(0, 2);
  const activity = [
    { kind: 'search', label: `Searched ${scopeName}`, docs: [...readDocs, ...nearby].map(d => d.id) },
    ...fileNames.map(f => ({ kind: 'read', label: `Read ${f}`, detail: 'your attachment' })),
    ...readDocs.map(d => ({ kind: 'read', label: `Read ${d.name}`, doc: d.id })),
    ...extra,
  ];
  const next = (t?.next?.(ctx) || []).filter(Boolean);
  return { text: pr.text, citations: pr.citations, activity, artifact: flags.every(f => f.ok) ? artifact : null, partial: permDropped, next: next.length ? next : null, gap: t?.gap || null, lowConf: !!t?.gap, files };
}
/** A planned activity as a work step; a search keeps the documents it found (`docs`), a read the one it read (`doc`). */
const workStep = s => ({ k: s.kind, label: s.label, d: s.detail, ...(s.docs?.length ? { docs: s.docs } : {}), ...(s.doc ? { doc: s.doc } : {}) });
const stemName = name => String(name || '').replace(/\.[^.]+$/, '');
const shortQuery = q => { const s = String(q || '').trim().replace(/\s+/g, ' '); return s.length > 60 ? s.slice(0, 57).trimEnd() + '…' : s; };
/**
 * The work as the assistant tells it, in order: a short note before it searches, what the search found (each document
 * with where it lives and the matching passage), a note on what it will read, the reads — then the answer. The notes
 * are the model's commentary (what it is doing and why), never its hidden reasoning or the tools' internals.
 */
function flowOf(q, a) {
  const steps = a.activity.map(workStep);
  const at = steps.findIndex(s => s.k === 'search' && /^Searched /.test(s.label));
  if (at < 0) return steps;
  const search = steps[at], scope = search.label.replace(/^Searched /, '');
  const hits = {};
  (a.citations || []).forEach(c => { hits[c.doc] ??= { page: c.page, quote: c.quote }; });
  Object.assign(search, { q: shortQuery(q), hits });
  const found = search.docs || [], reads = steps.filter(s => s.k === 'read' && s.doc).length;
  const before = { k: 'note', text: `I’ll look through ${scope} for this.` };
  const after = found.length
    ? { k: 'note', text: `${stemName(docById(found[0])?.name)} looks most relevant. ${reads > 1 ? 'I’ll read the closest matches' : 'I’ll read it'} before answering.` }
    : { k: 'note', text: `Nothing in ${scope} covers this, so I won’t guess.` };
  return [...steps.slice(0, at), before, search, after, ...steps.slice(at + 1)];
}
/** Seeded conversations without messages get their first answer the first time they are opened. */
function ensureSeed(conv) {
  if (conv.messages.length) return;
  const q = SEED[conv.id] || conv.title;
  const a = answer(q, conv.scope || [], [], conv.space || null);
  conv.messages.push({ id: uid('m'), role: 'user', text: q }, { id: uid('m'), role: 'assistant', q, text: a.text, citations: a.citations, work: flowOf(q, a), noResults: a.noResults || null, partial: a.partial, next: a.next || null, lowConf: !!a.lowConf, state: 'done' });
}
function lastLine(conv) {
  const a = [...conv.messages].reverse().find(m => m.role === 'assistant'); if (!a) return '';
  if (a.citations?.length && !visCites(a).length) return 'Uses knowledge you can’t access';
  return (plain(a.text).split('\n').find(l => l.trim()) || '').replace(/^\s*(?:[-*•]|\d+\.)\s+/, '').replace(/:\s*$/, '');
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
/** What the composer searches: the open conversation, or the home composer. Both carry scope (collection ids) and space (context). */
function scopeHolder() { const conv = S.cur?.r.page === 'chatThread' && convById(S.cur.params.id); if (conv) { conv.scope ??= []; return conv; } return composer(composerKey()); }
const readableKbsOf = sp => (sp?.kbs || []).filter(id => canReadKb(kbById(id)));
/** Spaces offered as a scope: mine, with knowledge I can read. */
const scopeSpaces = () => hasModule('spaces') ? mySpaces().filter(sp => readableKbsOf(sp).length) : [];
const holderSpace = h => (h.space && hasModule('spaces') && spaceById(h.space)) || null;
function setSpace(h, sp) { h.space = sp?.id || null; h.scope.splice(0, h.scope.length, ...readableKbsOf(sp)); }
/** One name for "everything": All of {workspace} (the same words as Home's box). */
const allLabel = () => `All of ${curWs().name}`;
const scopeKbNames = h => h.scope.map(kbById).filter(k => k && canReadKb(k)).map(k => k.name);
function scopeLabel(h) {
  const sp = holderSpace(h); if (sp) return sp.name;
  const names = scopeKbNames(h);
  return !names.length ? allLabel() : names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
}
/** The placeholder says where the question goes. */
function scopePlaceholder(h) {
  const sp = holderSpace(h); if (sp) return `Ask about ${sp.name}`;
  const names = scopeKbNames(h);
  if (!names.length) return hasModule('spaces') ? `Ask anything in ${curWs().name}` : 'Ask anything about your company knowledge';
  return names.length === 1 ? `Ask about ${names[0]}` : `Ask about ${names[0]} and ${names.length - 1} more`;
}
function scopeBtn(h) {
  const sp = holderSpace(h), on = !!sp || scopeKbNames(h).length > 0, label = scopeLabel(h);
  return btn(label, { v: 'ghost', size: 'sm', icon: sp ? spaceType(sp.type).icon : on ? 'book' : 'layers', iconRight: 'chevron-down', id: 'chat-scope', cls: cx('chat-scope', on && 'chat-scope--on'), tip: 'Choose what to search', aria: `data-popover="chat-scope" aria-haspopup="dialog" aria-expanded="false" aria-label="${esc('Search in: ' + label)}"` });
}
/** Chips in the composer: the file being edited, a project's documents (removable for this chat only), then this message's own files. */
function composerFiles(key) {
  const c = composer(key), chip = (f, i) => X.chatFiles?.chip(f, i, true) || '';
  const target = X.chatFiles?.editTarget?.(key);
  const proj = key.startsWith('proj:') ? (X.projects?.refs(key.slice(5)) || []).filter(f => !c.off.includes(f.doc) && !c.files.some(x => x.doc === f.doc)) : [];
  return (target ? X.chatFiles.ctxChip(target) : '') + [...proj.map(f => chip({ ...f, proj: true }, -1)), ...c.files.map(chip)].join('');
}
function composerHtml({ key, holder, placeholder, streaming, lg }) {
  const c = composer(key);
  const target = X.chatFiles?.editTarget?.(key);
  const files = composerFiles(key);
  const send = streaming
    ? btn('', { v: 'tertiary', icon: 'stop', tip: 'Stop answering', act: 'chat-stop', cls: 'chat-composer__send' })
    : btn('', { v: 'primary', icon: 'arrow-up', tip: 'Send', act: 'chat-send', id: 'chat-send', cls: 'chat-composer__send' });
  const ph = target ? `Ask for changes to ${target.title}` : placeholder || scopePlaceholder(holder);
  return `<div class="${cx('chat-composer', lg && 'chat-composer--lg')}" id="chat-composer">
    <div class="chat-composer__files" id="chat-files" ${files ? '' : 'hidden'}>${files}</div>
    <textarea class="chat-composer__input" id="chat-input" rows="${lg ? 2 : 1}" placeholder="${esc(ph)}" aria-label="${esc(ph)}" data-bind="composer.${key}.draft" data-input="chat-draft" data-enter="chat-send" data-autofocus>${esc(c.draft)}</textarea>
    <div class="chat-composer__bar">${iconBtn('paperclip', 'Attach files', { size: 'sm', menu: 'wk-attach' })}${target ? '' : scopeBtn(holder)}<span class="grow"></span>${c.files.length ? `<span class="t-xs muted num chat-composer__count">${c.files.length}/5</span>` : ''}${send}</div>
    <input type="file" id="wk-file-in" multiple hidden data-change="wk-file-picked" aria-label="Choose files to attach">
  </div>`;
}
function grow(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'; }
function focusComposer() { requestAnimationFrame(() => { const t = $('#chat-input'); if (!t) return; t.focus(); const n = t.value.length; t.setSelectionRange(n, n); grow(t); }); }
function afterComposer(changed) {
  const ta = $('#chat-input'); if (!ta) return;
  grow(ta);
  if (changed) { scopeUi().kbs = false; setTimeout(() => { const t = $('#chat-input'); if (!t || document.activeElement !== t && document.activeElement !== document.body && document.activeElement) return; t.focus({ preventScroll: true }); const n = t.value.length; t.setSelectionRange(n, n); }, 0); }
}
A['chat-draft'] = el => grow(el);
/* Scope picker (Popover): "Search in" is one choice — the whole workspace, one of my spaces, or specific collections.
   Only that last choice reveals the knowledge-base checklist (multi-select), so a space and a base with the same name never sit side by side. */
const scopeUi = () => ui('chatScope', { kbs: false });
function scopeMode(h) { const sp = holderSpace(h); return sp ? 'sp:' + sp.id : h.scope.length || scopeUi().kbs ? 'kbs' : 'all'; }
const docCount = k => D.docs.filter(d => d.kb === k.id && !d.archived).length;
function scopeOpt(value, on, icon, label, meta) {
  return `<label class="${cx('chat-opt', on && 'is-on')}"><input type="radio" name="chat-scope" value="${esc(value)}" ${on ? 'checked' : ''} data-change="chat-scope-set" data-value="${esc(value)}"><span class="radio__control" aria-hidden="true"></span>${ic(icon, 'i-sm chat-opt__icon')}<span class="chat-opt__body"><span class="chat-opt__label truncate">${esc(label)}</span>${meta ? `<span class="chat-opt__meta truncate">${esc(meta)}</span>` : ''}</span></label>`;
}
PO['chat-scope'] = () => {
  const h = scopeHolder(), mode = scopeMode(h), spaces = scopeSpaces(), kbs = visibleKbs().filter(canReadKb);
  const radios = [scopeOpt('all', mode === 'all', 'layers', allLabel(), plural(kbs.length, 'collection')),
    ...spaces.map(s => scopeOpt('sp:' + s.id, mode === 'sp:' + s.id, spaceType(s.type).icon, s.name, `Space · ${plural(readableKbsOf(s).length, 'collection')}`)),
    scopeOpt('kbs', mode === 'kbs', 'book', 'Specific collections', mode === 'kbs' && h.scope.length ? `${h.scope.length} selected` : 'Choose one or more')].join('');
  const list = mode === 'kbs' ? `<div class="chat-scope-pop__kbs" role="group" aria-label="Collections">${kbs.map(k => checkbox({ checked: h.scope.includes(k.id), act: 'chat-scope-kb', data: { id: k.id }, label: `${ic(k.personal ? 'user' : 'book', 'i-sm chat-opt__icon')}<span class="chat-opt__body"><span class="chat-opt__label truncate">${esc(k.name)}</span><span class="chat-opt__meta">${k.personal ? 'Only you' : plural(docCount(k), 'document')}</span></span>` })).join('')}</div>` : '';
  return { title: 'Search in', body: `<div class="chat-scope-pop"><div class="chat-scope-pop__group" role="radiogroup" aria-label="Search in">${radios}</div>${list}</div>` };
};
A['chat-scope-set'] = el => {
  const h = scopeHolder(), v = el.dataset.value || el.value, u = scopeUi();
  if (v === 'kbs') { u.kbs = true; if (holderSpace(h)) setSpace(h, null); }
  else { u.kbs = false; setSpace(h, v.startsWith('sp:') ? spaceById(v.slice(3)) : null); }
  refresh(); refreshLayer();
};
A['chat-scope-kb'] = (el, e) => {
  e?.stopPropagation();
  const h = scopeHolder(), id = el.dataset.id, j = h.scope.indexOf(id);
  if (holderSpace(h)) setSpace(h, null);
  if (j >= 0) h.scope.splice(j, 1); else h.scope.push(id);
  scopeUi().kbs = true; refresh(); refreshLayer();
};

/* ═══════════════ Messages ═══════════════ */
function userHtml(m) {
  const u = cui();
  const files = (m.edit ? X.chatFiles?.ctxChip?.(m.edit) || '' : '') + (m.files || []).map(f => X.chatFiles?.chip(normFile(f), 0, false) || '').join('');
  const filesRow = files ? `<div class="chat-user__files">${files}</div>` : '';
  if (u.edit === m.id) return `<div class="chat-msg chat-msg--user" id="msg-${m.id}"><div class="chat-edit">${filesRow}${textarea({ id: 'chat-edit-in', bind: 'chat.editText', value: u.editText, rows: 3, attrs: 'data-enter="chat-edit-save" aria-label="Edit your message"' })}<div class="row gap-8"><span class="grow t-xs muted">The answer below will be replaced.</span>${btn('Cancel', { v: 'ghost', size: 'sm', act: 'chat-edit-cancel' })}${btn('Send', { v: 'primary', size: 'sm', icon: 'arrow-up', act: 'chat-edit-save' })}</div></div></div>`;
  return `<div class="chat-msg chat-msg--user" id="msg-${m.id}"><div class="chat-user">${filesRow}<div class="chat-bubble">${esc(m.text)}</div><div class="chat-user__actions">${iconBtn('copy', 'Copy', { size: 'sm', act: 'copy', data: { text: m.text, msg: 'Copied' } })}${iconBtn('pencil', 'Edit', { size: 'sm', act: 'chat-edit', data: { msg: m.id } })}</div></div></div>`;
}
const STEP_IC = { search: 'search', read: 'file-text', prepare: 'server', code: 'terminal', export: 'file', edit: 'pencil' };
/** What a running step says (its stored label is the past tense shown once it finished). */
const LIVE_LABEL = { search: 'Searching your knowledge', read: 'Reading a document', code: 'Running code', prepare: 'Preparing a file', export: 'Saving a file' };
const THINK = '<span class="chat-think" aria-hidden="true"><i></i><i></i></span>';
const CARET = '<span class="chat-caret" aria-hidden="true"></span>';
/** Documents a search shows before "Show more". */
const FOUND_SHOWN = 3;
function liveLabel(s) {
  if (s.k === 'search' && /^Searched /.test(s.label)) return s.label.replace(/^Searched /, 'Searching ');
  if (s.k === 'read' && s.doc) return `Reading ${stemName(docById(s.doc)?.name)}`;
  return LIVE_LABEL[s.k] || s.label;
}
/** The folded flow in one line: what was done, never how many. */
function stepsSummary(m) {
  const steps = (m.work || []).filter(s => !s.live && s.k !== 'note'); const parts = [];
  const search = steps.find(s => s.k === 'search'); if (search) parts.push(clean(search.label));
  const reads = steps.filter(s => s.k === 'read');
  if (reads.length) parts.push(reads.length === 1 && reads[0].doc ? `Read ${stemName(docById(reads[0].doc)?.name)}` : 'Read the closest matches');
  const runs = steps.flatMap(s => s.runs || []);
  if (runs.length) parts.push(runs.some(r => r.exit) ? 'Code hit an error' : 'Ran code');
  const arts = m.artifacts || [];
  if (arts.length) parts.push(arts.some(r => r.rev <= 1) ? 'Created a file' : 'Updated a file');
  if (!parts.length && steps[0]) parts.push(clean(steps[0].label));
  return parts.join(' · ');
}
/** A one-time entrance although paint() re-renders: a negative delay resumes the animation where it stands (a later
    start waits). Older content renders still. */
function appear(at) {
  const age = Date.now() - (at || 0);
  return at && age < 900 ? { cls: ' is-fresh', style: ` style="animation-delay:${-age}ms"` } : { cls: '', style: '' };
}
/** One found document: what it is, where it lives, how fresh, and the passage that matched. Once the answer cites it,
    its source number. Opens the preview at that passage. */
function docCard(m, s, id, i) {
  const d = docById(id); if (!d || !canDoc(d)) return '';
  const hit = s.hits?.[id], ns = visCites(m).filter(c => c.doc === id).map(c => c.n);
  const where = folderById(docFolder(d))?.name || kbById(d.kb)?.name;
  const meta = [where, rel(d.updated)].filter(Boolean).join(' · ');
  const f = appear(s.at && s.at + i * 70);
  const badges = ns.length ? `<span class="chat-doc__ns" aria-label="${ns.length > 1 ? 'Sources' : 'Source'} ${ns.join(', ')}">${ns.map(n => `<span class="chat-doc__n">${n}</span>`).join('')}</span>` : '';
  return `<button type="button" role="listitem" class="chat-doc${f.cls}"${f.style} data-act="doc-preview" data-id="${d.id}"${hit ? ` data-page="${hit.page}" data-quote="${esc(hit.quote || '')}"` : ''}>${fileIcon(d.type, 'sm')}<span class="chat-doc__head"><span class="chat-doc__title truncate" translate="no">${esc(stemName(d.name))}</span><span class="chat-doc__meta truncate">${esc(meta)}</span>${badges}</span>${hit?.quote ? `<span class="chat-doc__quote" translate="no"><b>p. ${hit.page}</b> · ${esc(hit.quote)}</span>` : ''}</button>`;
}
function foundHtml(m, s, si) {
  const ids = (s.docs || []).filter(id => canDoc(docById(id))); if (!ids.length) return '';
  const key = `${m.id}:found:${si}`, all = !!cui().open[key], shown = all ? ids : ids.slice(0, FOUND_SHOWN);
  const more = ids.length > FOUND_SHOWN ? `<div class="chat-docs__more">${linkBtn(all ? 'Show less' : 'Show more', { act: 'chat-docs-more', data: { k: key, msg: m.id } })}</div>` : '';
  return `<div class="chat-docs" role="list" aria-label="Found documents">${shown.map((id, i) => docCard(m, s, id, i)).join('')}</div>${more}`;
}
/** One action of the flow: icon, what it did, and what it found or ran. */
function actionRow(m, s, si) {
  const u = cui();
  const runs = (s.runs || []).map((r, ri) => {
    const key = `${m.id}:run:${si}:${ri}`, show = !!u.open[key];
    const lastErr = r.exit ? String(r.out || '').trim().split('\n').filter(Boolean).at(-1) : '';
    return `<div class="chat-run"><div class="chat-run__head">${ic('terminal', 'i-xs')}<span>Command ${ri + 1}</span>${linkBtn(show ? 'Hide code' : 'Show code', { act: 'chat-run', data: { k: key } })}<span class="grow"></span>${chip(r.exit ? `Failed · exit ${r.exit}` : 'OK', { tone: r.exit ? 'danger' : 'success', size: 'sm', variant: r.exit ? 'soft' : 'tertiary' })}</div>${show ? `<pre class="chat-run__code">${esc(r.cmd)}</pre>${r.out ? `<pre class="${cx('chat-run__out', r.err && 'is-err')}">${esc(r.out)}</pre>` : ''}` : lastErr ? `<pre class="chat-run__out is-err">${esc(lastErr)}</pre>` : ''}</div>`;
  }).join('');
  const read = s.k === 'read' && s.doc ? docById(s.doc) : null;
  const label = read && canDoc(read)
    ? `Read <button type="button" class="chat-doc-link" data-act="doc-preview" data-id="${read.id}" translate="no">${esc(stemName(read.name))}</button>`
    : esc(clean(s.label));
  const detail = s.k === 'search' && s.q ? `“${esc(s.q)}”` : s.d ? esc(s.d) : '';
  return `<li class="${cx('chat-step', s.bad && 'is-bad')}">${ic(STEP_IC[s.k] || 'check', 'i-sm')}<div class="grow"><span>${label}</span>${detail ? ` <span class="muted">· ${detail}</span>` : ''}${s.k === 'search' ? foundHtml(m, s, si) : ''}${runs}</div></li>`;
}
/** The flow in order — notes, finished actions with what they found — and, while working, the live row last. */
function stepsList(m, live = null) {
  const rows = (m.work || []).map((s, si) => {
    if (s.k === 'note') {
      const f = appear(s.at);
      return `<li class="chat-step chat-step--note${f.cls}"${f.style}><p translate="no">${esc(s.text)}${s.live ? CARET : ''}</p></li>`;
    }
    return s.live ? '' : actionRow(m, s, si);
  }).join('');
  const liveRow = live ? `<li class="chat-step is-live" role="status" aria-live="polite">${THINK}<span class="chat-steps__label truncate">${esc(live.label)}</span>${live.q ? `<span class="chat-steps__q truncate" translate="no">“${esc(live.q)}”</span>` : ''}</li>` : '';
  return `<ol class="chat-steps__list" aria-label="How the answer is being found">${rows}${liveRow}</ol>`;
}
/**
 * How the answer is found, as one flow above it: the assistant says what it will do (a note), does it (a search shows
 * the documents it found as cards, a read names the document), says what it found and what comes next, and then
 * answers. The live row last names the action that runs right now or says "Thinking" (never a search that isn't
 * happening); a note being written needs none. Answers written in this session keep the flow open; it folds into
 * one summary line. With "Show how answers were found" off, only the live line shows.
 */
function stepsHtml(m) {
  const work = m.work || [], streaming = m.state === 'streaming';
  const cur = [...work].reverse().find(s => s.live);
  const live = streaming && m.phase === 'work' && cur?.k !== 'note'
    ? (cur ? { label: clean(liveLabel(cur)), q: cur.k === 'search' ? cur.q : '' } : { label: 'Thinking' })
    : null;
  const liveLine = live ? `<span class="chat-steps__live" role="status" aria-live="polite">${THINK}<span class="chat-steps__label truncate">${esc(live.label)}</span></span>` : '';
  const shown = work.some(s => !s.live || s.k === 'note');
  if (!prefShowSteps() || (streaming && !shown)) return liveLine ? `<div class="chat-steps">${liveLine}</div>` : '';
  if (streaming) return `<div class="chat-steps">${stepsList(m, live)}</div>`;
  if (!work.length) return '';
  const open = !!cui().open[m.id];
  return `<div class="chat-steps"><button type="button" class="chat-steps__toggle" data-act="chat-steps" data-msg="${m.id}" aria-expanded="${open}">${ic(open ? 'chevron-down' : 'chevron-right', 'i-sm')}<span class="truncate">${esc(stepsSummary(m) || 'How this answer was found')}</span></button>${open ? stepsList(m) : ''}</div>`;
}
A['chat-docs-more'] = el => { const u = cui(); u.open[el.dataset.k] = !u.open[el.dataset.k]; const { m } = findMsg(el.dataset.msg); m ? paint(m) : refresh(); };
/* Next steps an answer suggests: actions, not documents — their own labelled row of secondary buttons, apart from the quiet source chips. */
const NEXT_IC = { 'rq-new': 'send', 'rq-ask-staff': 'message' };
const nextIcon = n => n.act === 'work-start' ? (WORKFLOWS[n.data?.workflow]?.icon || 'sparkles') : NEXT_IC[n.act] || 'arrow-right';
function nextHtml(m) {
  const items = (m.next || []).filter(n => n?.label && (n.act || n.href));
  if (!items.length || m.state === 'streaming') return '';
  return `<div class="chat-next" role="group" aria-labelledby="next-${m.id}"><span class="chat-next__label" id="next-${m.id}">${items.length > 1 ? 'Next steps' : 'Next step'}</span>${items.map(n => btn(n.label, { v: 'secondary', size: 'sm', icon: nextIcon(n), act: 'chat-next', data: { msg: m.id, i: (m.next || []).indexOf(n) } })).join('')}</div>`;
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
  if (m.activity?.length && !m.work) { m.work = m.activity.map(workStep); delete m.activity; }
  const all = m.citations || [], vis = visCites(m), visN = new Set(vis.map(c => c.n));
  // Built only from knowledge this person can't read: show nothing of it.
  if (all.length && !vis.length && m.state !== 'streaming') {
    const kb = kbById(docById(all[0].doc)?.kb); const locked = kbRole(kb) === 'none';
    return alertBox('default', 'This answer uses knowledge you can’t access', locked ? `It comes from ${esc(kb.name)}. Request access to see it.` : 'Ask a workspace admin if you need it, or ask again to search only what you can access.', locked ? btn('Request access', { v: 'secondary', size: 'sm', act: 'chat-request', data: { kb: kb.id } }) : btn('Ask again with what I can access', { v: 'secondary', size: 'sm', icon: 'retry', act: 'chat-unscope', data: { msg: m.id } }), { icon: 'lock' });
  }
  let h = ((m.state || 'done') === 'done' ? freshnessHtml(conv, m) : '') + stepsHtml(m);
  const ctx = { cite: n => { if (!visN.has(n)) return ''; const c = vis.find(x => x.n === n), d = docById(c.doc); return `<button type="button" class="cite" data-act="cite-open" data-msg="${m.id}" data-n="${n}" aria-label="Source ${n}: ${esc(d.name)}, page ${c.page}">${n}</button>`; } };
  const txt = (m.text || '') + (m.state === 'streaming' && m.phase === 'write' ? '\u2063' : '');
  if (txt) h += `<div class="chat-answer">${md(txt, ctx)}</div>`;
  if (m.state === 'stopped') h += `<div class="chat-stopped">${ic('stop', 'i-xs')}<span>Stopped</span>${btn('Retry', { v: 'ghost', size: 'sm', icon: 'retry', act: 'chat-retry', data: { msg: m.id } })}</div>`;
  if (m.state === 'error') {
    const fileWork = (m.work || []).some(s => s.bad);
    h += `<div class="mt-12">${alertBox('danger', fileWork ? 'The file work stopped before it finished' : 'The answer stopped before it finished', fileWork ? 'Nothing was saved. Retry to run it again.' : 'Retry to get the full answer.', btn('Retry', { size: 'sm', icon: 'retry', act: 'chat-retry', data: { msg: m.id } }))}</div>`;
  }
  if ((m.state || 'done') === 'done') {
    if (m.noResults) {
      h += `<div class="row gap-8 wrap mt-12">${m.noResults.scoped ? btn(`Ask again in ${allLabel().replace(/^All/, 'all')}`, { v: 'secondary', size: 'sm', icon: 'layers', act: 'chat-unscope', data: { msg: m.id } }) : ''}${btn('Browse knowledge', { v: 'ghost', size: 'sm', icon: 'book', href: '/knowledge' })}</div>`;
      if (m.noResults.restricted) h += `<p class="chat-hint">${ic('lock', 'i-xs')}<span>Some collections are restricted. You can request access from Knowledge.</span></p>`;
    } else if (m.partial || vis.length < all.length) h += `<p class="chat-hint">${ic('lock', 'i-xs')}<span>Knowledge you can’t access may have more on this.</span></p>`;
    if (m.lowConf) h += `<p class="chat-hint">${ic('info', 'i-xs')}<span>The sources don’t settle this, so it’s been flagged to the people who keep this knowledge.</span></p>`;
    h += X.chatFiles?.cards(m) || '';
    if (vis.length) h += sourcesHtml(m, vis);
    h += nextHtml(m);
    if (!m.noResults) {
      const vi = m.vi ?? (m.variants?.length || 1) - 1;
      const pager = m.variants?.length > 1 ? `<span class="chat-pager">${iconBtn('chevron-left', 'Previous answer', { size: 'sm', act: 'chat-variant', data: { msg: m.id, d: -1 }, disabled: !vi })}<span class="t-xs num">${vi + 1}/${m.variants.length}</span>${iconBtn('chevron-right', 'Next answer', { size: 'sm', act: 'chat-variant', data: { msg: m.id, d: 1 }, disabled: vi >= m.variants.length - 1 })}</span>` : '';
      h += `<div class="chat-actions">${pager}${iconBtn('copy', 'Copy', { size: 'sm', act: 'chat-copy', data: { msg: m.id } })}${iconBtn('retry', 'Retry', { size: 'sm', act: 'chat-retry', data: { msg: m.id } })}${iconBtn('thumbs-up', 'Good answer', { size: 'sm', act: 'chat-up', data: { msg: m.id }, aria: `aria-pressed="${m.feedback === 'up'}"` })}${iconBtn('thumbs-down', 'Bad answer', { size: 'sm', menu: 'chat-down', data: { msg: m.id }, aria: `aria-pressed="${m.feedback === 'down'}"` })}${iconBtn('more', 'More', { size: 'sm', menu: 'chat-ans-more', data: { msg: m.id } })}</div>`;
    }
  }
  return h;
}
/** One chip per cited document (an answer often quotes the same policy three times); its numbers open the matching passages. */
function sourcesHtml(m, vis) {
  const groups = [];
  vis.forEach(c => { let g = groups.find(x => x.doc === c.doc); if (!g) groups.push(g = { doc: c.doc, cites: [] }); g.cites.push(c); });
  return `<div class="chat-sources" role="group" aria-label="Sources">${groups.map(g => {
    const d = docById(g.doc), ns = g.cites.map(c => c.n), pages = [...new Set(g.cites.map(c => c.page))];
    const where = pages.length > 1 ? `pages ${pages.join(', ')}` : `page ${pages[0]}`;
    return `<button type="button" class="chat-source" data-act="cite-open" data-msg="${m.id}" data-n="${ns[0]}" aria-label="${ns.length > 1 ? 'Sources' : 'Source'} ${ns.join(', ')}: ${esc(d.name)}, ${where}" data-tip="${esc(d.name)} · ${where}"><span class="chat-source__ns" aria-hidden="true">${ns.map(n => `<span class="chat-source__n">${n}</span>`).join('')}</span>${fileIcon(d.type, 'sm')}<span class="truncate">${esc(d.name)}</span></button>`;
  }).join('')}</div>`;
}
function paint(m) {
  const el = document.getElementById('msg-' + m.id); if (!el) return;
  const { conv } = findMsg(m.id); el.innerHTML = aiInner(conv, m);
  const sc = $('#chat-scroll'); if (sc) fitTail(sc);
}
/** A reload mid-stream leaves 'streaming' messages behind; show them as stopped. */
function settleStale(conv) { conv.messages.forEach(m => { if (m.state === 'streaming' && run?.msg !== m.id) { m.state = 'stopped'; m.phase = null; (m.work || []).forEach(s => (s.live = false)); } }); }

/* ═══════════════ Citations ═══════════════ */
/** A citation (inline number or source chip) opens the shared document preview (preview.js) over the conversation: the cited passage
    highlighted in the document's own pages, stepping through every passage this answer quotes; Open full document goes to the Reader. */
A['cite-open'] = el => {
  const { msg, n } = el.dataset; const { conv, m } = findMsg(msg); if (!conv) return;
  const vis = visCites(m); if (!vis.length) return;
  const num = +n || vis[0].n;
  X.preview.open({ id: vis.find(c => c.n === num)?.doc || vis[0].doc, n: num, from: conv.id, cites: vis.map(c => ({ doc: c.doc, page: c.page, quote: c.quote, n: c.n })) });
};
function closePanel() { cui().panel = null; refresh(); focusComposer(); }
A['chat-panel-close'] = () => { if (X.chatFiles?.leaveEdit && !X.chatFiles.leaveEdit(closePanel)) return; closePanel(); };

/* ═══════════════ Pages ═══════════════ */
/** One suggestion area under Home's composer, as short labels (the full question fills the box and shows on hover). Searching a
    space (or one collection that a space of yours has among its materials) with AI workflows swaps the starter questions for that
    space's workflows — same pills, so the row never grows a second set of ideas. */
function suggestions(c) {
  const viaKb = c.scope.length === 1 && hasModule('spaces') ? (D.spaces || []).find(s => !s.archived && spaceRole(s) && s.kbs?.includes(c.scope[0])) : null;
  const sp = hasModule('work') && (holderSpace(c) || viaKb) || null;
  const wfs = sp ? workflowsFor(sp).slice(0, 3) : [];
  const pill = (attrs, icon, label, tip, own) => `<button type="button" class="chat-starter" ${attrs}${tip ? ` data-tip="${esc(tip)}"` : ''}>${ic(icon, 'i-sm')}<span class="truncate"${own ? ' translate="no"' : ''}>${esc(label)}</span></button>`;
  if (wfs.length) return `<div class="chat-starters" id="chat-starters" role="group" aria-label="${esc(`Start work in ${sp.name}`)}">${wfs.map(w => pill(`data-act="chat-workflow" data-workflow="${esc(w.id)}" data-space="${esc(sp.id)}"`, w.icon, w.label, w.desc, false)).join('')}</div>`;
  const picks = (X.assistantStarters?.() || D.assistant.starters || []).filter(s => s?.prompt).slice(0, 4);
  return picks.length ? `<div class="chat-starters" id="chat-starters" role="group" aria-label="Suggested questions">${picks.map(s => pill(`data-act="chat-starter" data-prompt="${esc(s.prompt)}"`, 'sparkles', s.title || s.prompt, s.title ? s.prompt : '', true)).join('')}</div>` : '';
}
A['chat-workflow'] = el => {
  const { workflow, space } = el.dataset; const data = { workflow, ...(space ? { space } : {}) };
  if (A['work-start']) A['work-start']({ dataset: data }); else go(NEXT_ROUTE['work-start'](data));
};
/** New chat (the sidebar's New chat row, ⌘K, ⌘⇧O): the composer with nothing open. Home's composer is the same component and
    draft: a question asked there opens its thread. */
A['chat-new'] = () => { if (S.navOpen) S.navOpen = false; if (S.cur?.r.page !== 'chats') go('/chat'); else refresh(); setTimeout(focusComposer, 0); };
/** A document as context for the next question (a one-click chip on the new-chat canvas). */
A['chat-ref'] = el => {
  const d = docById(el.dataset.id), c = composer(composerKey());
  if (d && canDoc(d) && c.files.length < 5 && !c.files.some(f => f.doc === d.id)) c.files.push({ name: d.name, type: d.type, kind: 'ref', doc: d.id, ready: true });
  refresh(); focusComposer();
};
/** New chat (/chat): the composer, its suggestions, what you just read as one-click context, and — when some exist — the
    conversations whose answers rely on documents that changed since, each one click away. All your conversations are the
    sidebar's Recent list. */
P.chats = () => {
  const c = composer('home');
  pageHeader({ title: 'New chat' });
  const recent = recentResources(8).map(x => x.doc).filter(d => !c.files.some(f => f.doc === d.id)).slice(0, 3);
  const context = recent.length ? `<div class="chat-context" role="group" aria-label="Ask about what you just read"><span class="chat-context__label">Ask about what you just read</span>${recent.map(d => `<button type="button" class="chat-context__doc" data-act="chat-ref" data-id="${esc(d.id)}">${fileIcon(d.type, 'sm')}<span class="truncate" translate="no">${esc(docTitle(d))}</span>${ic('plus', 'i-xs')}</button>`).join('')}</div>` : '';
  const stale = myConvs().filter(cv => outdatedAnswers(cv).length).sort((a, b) => b.at - a.at);
  const review = stale.length ? `<section class="chat-review" aria-labelledby="chat-review-h">
    <h2 class="chat-review__title" id="chat-review-h">${ic('retry', 'i-sm')}<span>${esc(stale.length === 1 ? '1 conversation relies on a document that changed' : `${stale.length} conversations rely on documents that changed`)}</span></h2>
    ${stale.slice(0, 3).map(cv => `<a class="chat-review__item" href="#/chat/${esc(cv.id)}"><span class="chat-review__name truncate" translate="no">${esc(cv.title)}</span>${X.conversations.staleLine(cv)}</a>`).join('')}
  </section>` : '';
  return `<div class="chat-canvas chat-drop" data-drop="home"><div class="chat-canvas__inner">
    <h1 class="chat-canvas__title">${esc(D.assistant?.welcome || 'What can I help you find?')}</h1>
    ${composerHtml({ key: 'home', holder: c, lg: true })}
    ${suggestions(c)}
    ${context}${review}
  </div></div>`;
};
AFTER.chats = ({ changed }) => { if (changed) { cui().panel = null; cui().edit = null; } afterComposer(changed); };
function threadSkel() {
  return `<div class="chat-thread" aria-busy="true" aria-label="Loading">${[0, 1].map(i => `<div class="chat-msg chat-msg--user"><span class="skeleton" style="width:${300 - i * 80}px;height:44px;border-radius:var(--radius-3xl)"></span></div><div class="stack gap-8"><span class="skeleton skeleton--line" style="width:40%;height:10px"></span><span class="skeleton skeleton--line" style="width:96%"></span><span class="skeleton skeleton--line" style="width:88%"></span><span class="skeleton skeleton--line" style="width:72%"></span></div>`).join('')}</div>`;
}
P.chatThread = ({ params }) => {
  const conv = convById(params.id);
  if (!isMine(conv)) {
    // Someone else's conversation opens only through a live share whose audience includes you: read-only (sharedThread).
    if (conv && X.shares?.sharedWithMe(conv.id)) return sharedThread(conv);
    crumbs([{ label: 'Not found' }]);
    return `<div class="page">${emptyState({ icon: 'message', title: 'This conversation isn’t available', desc: 'It may have been deleted, or it belongs to someone else.', actions: btn('New chat', { v: 'primary', icon: 'message-plus', act: 'chat-new' }) })}</div>`;
  }
  ensureSeed(conv); conv.scope ??= []; settleStale(conv);
  const sp = holderSpace(conv);
  const proj = X.projects?.of(conv);
  // Its parent is where it lives, as in Delete (conversations.js): its project, else its space; else it stands alone (its row in
  // the sidebar's Recent list is the current one).
  crumbs(proj ? [{ label: 'Projects', to: '/projects' }, { label: proj.name, to: '/project/' + proj.id }, { label: conv.title }] : sp ? [{ label: 'Spaces', to: '/spaces' }, { label: sp.name, to: '/space/' + sp.id }, { label: conv.title }] : [{ label: conv.title }]);
  // The conversation's title is the top row's H1 (click it to rename), its Share and ⋯ the row's actions: the thread starts right under it.
  const u = cui(); if (u.renaming && u.renaming !== conv.id) u.renaming = null;
  const shared = liveShare(conv);
  pageHeader({ title: conv.title, heading: X.conversations?.title(conv), actions: `<span class="chat-top-actions">${btn(shared ? 'Shared' : 'Share', { v: 'ghost', size: 'sm', icon: shared ? 'users' : 'share', act: 'chat-share', data: { id: conv.id }, tip: shared ? shareSummary(conv) : '' })}${iconBtn('more', 'More', { size: 'sm', menu: 'chat-more', data: { id: conv.id } })}</span>` });
  const panel = u.panel?.conv === conv.id ? u.panel : null;
  const streaming = run?.conv === conv.id;
  const ok = () => `<div class="chat-thread">${conv.messages.map(m => m.role === 'user' ? userHtml(m) : `<div class="chat-msg chat-msg--ai" id="msg-${m.id}">${aiInner(conv, m)}</div>`).join('')}</div><div class="chat-tail" id="chat-tail" aria-hidden="true" style="height:${turn ? u.tail || 0 : 0}px"></div>`;
  const side = panel?.kind === 'file' ? X.chatFiles?.panel(conv, panel) || '' : '';
  return `<div class="split chat-split">
    <div class="split__main chat-main chat-drop" data-drop="${conv.id}">
      <div class="chat-scroll" id="chat-scroll" data-keep-scroll>${gate({ ok, loading: threadSkel, error: ok, empty: ok })}</div>
      <div class="chat-dock"><div class="chat-dock__inner">${streaming ? '' : X.chatFiles?.quickAsks?.(conv.id) || ''}${composerHtml({ key: conv.id, holder: conv, placeholder: 'Ask a follow-up', streaming })}</div></div>
    </div>${side}</div>`;
};
AFTER.chatThread = ({ params, changed }) => {
  const u = cui();
  if (changed) { u.edit = null; if (u.panel && u.panel.conv !== params.id) { u.panel = null; refresh(); return; } }
  const sc = $('#chat-scroll');
  if (sc) {
    // Opened: the latest turn; opened on a turn just sent (from New chat's or Home's composer): its question at the top.
    if (changed) { turn = pin = run?.conv === params.id; if (!turn) u.tail = 0; }
    fitTail(sc);
    if (pin) { pin = false; pinQuestion(sc); }
    else if (changed) sc.scrollTop = sc.scrollHeight;
  }
  X.chatFiles?.after?.();
  afterComposer(changed);
};

/* ═══════════════ Sending & streaming ═══════════════ */
const SNAP = ['text', 'citations', 'work', 'artifacts', 'noResults', 'partial', 'next', 'lowConf', 'feedback', 'reason', 'state', 'at', 'refreshed'];
const snap = m => Object.fromEntries(SNAP.map(k => [k, clone(m[k] ?? null)]));
function basicPlan(q, conv, files, mod) {
  const a = answer(q, conv.scope || [], files.map(f => f.name), conv.space || null);
  let text = a.text;
  if (mod === 'shorter' && !a.noResults) text = text.split('\n\n').slice(0, 2).join('\n\n');
  return { text, citations: a.citations, noResults: a.noResults || null, partial: a.partial, next: a.next || null, gap: a.gap || null, lowConf: !!a.lowConf, work: flowOf(q, a) };
}
async function stream(conv, am, fail) {
  const r = run = { conv: conv.id, msg: am.id, stop: false };
  const um = conv.messages[conv.messages.indexOf(am) - 1];
  const files = (um?.files || []).map(normFile);
  // The answer being replaced keeps when it was written, so stepping back to it (‹ 1/2 ›) shows it as it was.
  if (am.text && ['done', 'stopped'].includes(am.state || 'done')) { am.at ??= conv.at; am.variants ??= [snap(am)]; }
  const plan = (X.chatFiles?.plan || basicPlan)(am.q, conv, files, am.mod, am.edit); am.mod = null;
  const refreshed = am.refreshing || null; delete am.refreshing;
  delete am.activity; delete am.artifact;
  Object.assign(am, { text: '', citations: [], work: [], artifacts: [], noResults: null, partial: false, next: null, lowConf: false, feedback: null, reason: null, state: 'streaming', phase: 'work', refreshed });
  // Written in front of the reader: its timeline stays open afterwards (no fold, no jump when it finishes).
  if (prefShowSteps()) cui().open[am.id] = true;
  refresh();
  const alive = () => D.convs.includes(conv) && !r.stop;
  // The model reads the question before it says anything.
  await sleep(450);
  for (const st of plan.work) {
    if (!alive()) return end(r, am, 'stopped');
    if (st.k === 'note') {
      // A note streams like the answer, word by word.
      const step = { ...st, text: '', live: true, at: Date.now() }; am.work.push(step);
      const words = st.text.split(/(\s+)/);
      for (let i = 0; i < words.length; i += 2) {
        if (!alive()) return end(r, am, 'stopped');
        step.text = words.slice(0, i + 1).join(''); paint(am);
        await sleep(30);
      }
      step.live = false; paint(am);
      await sleep(250);
      continue;
    }
    const step = { ...st, live: true, runs: st.runs ? [] : undefined }; am.work.push(step); paint(am);
    if (st.runs) for (const x of st.runs) {
      await sleep(600); if (!alive()) return end(r, am, 'stopped');
      if (fail) { step.runs.push({ cmd: x.cmd, out: 'The secure workspace stopped responding.', exit: 1, err: true }); step.label = 'Code hit an error'; step.bad = true; step.live = false; paint(am); return end(r, am, 'error'); }
      step.runs.push(x); paint(am);
    }
    await sleep(st.k === 'search' ? 1100 : st.k === 'code' ? 300 : 600);
    // Done: what it found shows at once, the cards one after another.
    Object.assign(step, { live: false, at: Date.now() }); paint(am);
    if (st.docs?.length) await sleep(Math.min(st.docs.length, FOUND_SHOWN) * 90 + 350);
  }
  // The model reads what the tools returned (or, with no tools, just the question) before it writes.
  await sleep(plan.work.length ? 300 : 700);
  if (!alive()) return end(r, am, 'stopped');
  Object.assign(am, { phase: 'write', citations: plan.citations });
  const parts = (plan.text || '').split(/(\s+)/), failAt = fail ? Math.floor(parts.length * 0.45) : Infinity;
  for (let i = 0; i < parts.length; i += 2) {
    if (!alive()) return end(r, am, 'stopped');
    if (i >= failAt) return end(r, am, 'error');
    am.text = parts.slice(0, i + 1).join(''); paint(am);
    await sleep(22);
  }
  Object.assign(am, { text: plan.text, noResults: plan.noResults, partial: plan.partial, next: plan.next || null, lowConf: !!plan.lowConf, at: Date.now() });
  if (plan.gap && !am.gapLogged) { recordGap(plan.gap); am.gapLogged = true; }
  if (plan.apply) am.artifacts = plan.apply();
  if (am.variants) { am.variants.push(null); am.vi = am.variants.length - 1; }
  end(r, am, 'done');
  if (am.variants) am.variants[am.vi] = snap(am);
  X.chatFiles?.afterStream?.(am, plan);
}
function end(r, am, st) { am.state = st; am.phase = null; (am.work || []).forEach(s => (s.live = false)); if (run === r) run = null; refresh(); }
/** Add a user turn to a conversation and stream the answer. edit: the id of an open file the question asks to change. */
function ask(conv, q, files = [], { edit = null } = {}) {
  stampAnswers(conv);
  conv.at = Date.now();
  conv.messages.push({ id: uid('m'), role: 'user', text: q, files, ...(edit ? { edit } : {}) });
  const am = { id: uid('m'), role: 'assistant', q, text: '', citations: [], state: 'streaming', phase: 'work', ...(edit ? { edit } : {}) };
  conv.messages.push(am); turn = pin = true;
  const fail = S.pageState === 'error';
  if (S.cur?.path !== '/chat/' + conv.id) go('/chat/' + conv.id);
  stream(conv, am, fail);
  return am;
}
/** Start a conversation. project: the project it belongs to (its Knowledge references are attached to the first question). */
function start(q, { scope = [], files = [], space = null, project = null } = {}) {
  const conv = { id: uid('c'), owner: me().id, title: makeTitle(q), at: Date.now(), scope, ...(space ? { space } : {}), ...(project ? { project } : {}), messages: [] };
  D.convs.unshift(conv); cui().panel = null;
  ask(conv, q, files);
  return conv;
}
A['chat-send'] = () => {
  const key = composerKey(); const c = composer(key); const q = c.draft.trim();
  if (!q) { $('#chat-input')?.focus(); return; }
  if (c.files.some(f => !f.ready && !f.error)) { toast('Wait for your files to finish uploading.', { tone: 'accent' }); return; }
  if (run) { toast(run.conv === key ? 'Wait for this answer to finish, or stop it.' : 'Another answer is still being written. Wait for it or stop it.', { tone: 'accent' }); return; }
  const files = c.files.filter(f => f.ready).map(({ name, type, kind, doc }) => ({ name, type, kind, doc }));
  const off = c.off; c.draft = ''; c.files = []; c.off = [];
  if (key === 'home') { const scope = c.scope.filter(id => canReadKb(kbById(id))); const space = holderSpace(c)?.id || null; c.scope = []; c.space = null; start(q, { scope, space, files }); }
  else if (key.startsWith('proj:')) {
    const pid = key.slice(5), scope = c.scope.filter(id => canReadKb(kbById(id))), space = holderSpace(c)?.id || null;
    const refs = (X.projects?.refs(pid) || []).filter(f => !off.includes(f.doc) && !files.some(x => x.doc === f.doc));
    start(q, { scope, space, project: X.projects?.byId(pid) ? pid : null, files: [...refs, ...files] });
  }
  else { const target = X.chatFiles?.editTarget?.(key); ask(convById(key), q, files, { edit: target?.id || null }); }
};
/** A suggestion fills the box (the person sees and can change the question before sending). */
A['chat-starter'] = el => { composer(composerKey()).draft = el.dataset.prompt; refresh(); focusComposer(); };
A['chat-stop'] = () => { if (run) run.stop = true; };
function retry(msgId, mod) {
  if (run) return; const { conv, m } = findMsg(msgId); if (!m) return;
  m.q ??= conv.messages[conv.messages.indexOf(m) - 1]?.text || conv.title;
  m.mod = mod; turn = pin = true; stream(conv, m, S.pageState === 'error');
}
A['chat-retry'] = el => retry(el.dataset.msg, null);
A['chat-unscope'] = el => { const { conv } = findMsg(el.dataset.msg); if (!conv || run) return; conv.scope = []; conv.space = null; retry(el.dataset.msg, null); };

/* ═══════════════ Living answers ═══════════════
   An answer remembers when it was written (m.at; a seeded one, its conversation's time until the conversation moves on). A source
   it cites that got a newer version afterwards (doc.updated later) or was archived makes it out of date: the thread says which, and
   the sidebar's Recent list marks the conversation (⟳). Update answer asks the same question again (retry) on today's documents; the earlier
   answer stays one step back (‹ 1/2 ›), so nothing is lost and the two can be compared. */
/** Before a conversation's time moves on, give its seeded answers that time, so they keep their own age. */
function stampAnswers(conv) { conv.messages.forEach(x => { if (x.role === 'assistant') x.at ??= conv.at; }); }
/** Readable sources of an answer that changed after it was written. */
function changedSources(conv, m) {
  if (m.role !== 'assistant' || (m.state || 'done') !== 'done' || !m.citations?.length) return [];
  const at = m.at || conv.at;
  return [...new Set(m.citations.map(c => c.doc))].map(docById).filter(d => d && canDoc(d) && (d.archived || d.updated > at));
}
/** A conversation's answers (latest version shown) whose sources changed since. */
const outdatedAnswers = conv => conv.messages.filter(m => changedSources(conv, m).length && (m.vi ?? (m.variants?.length || 1) - 1) === (m.variants?.length || 1) - 1);
A['chat-refresh'] = el => {
  const { conv, m } = findMsg(el.dataset.msg); if (!conv || !m || run) return;
  m.refreshing = changedSources(conv, m).map(d => d.id);
  stampAnswers(conv); conv.at = Date.now();
  retry(m.id, null);
};
/** Above an answer: which source changed and Update answer; on an earlier version, a way back to the latest. After an update:
    what it was updated from, and the previous answer one click away. */
function freshnessHtml(conv, m) {
  const last = (m.variants?.length || 1) - 1, vi = m.vi ?? last;
  const changed = changedSources(conv, m);
  if (vi < last) return changed.length ? `<div class="chat-outdated chat-outdated--old">${ic('history', 'i-sm')}<span class="chat-outdated__text">An earlier answer, written before its sources changed.</span>${btn('Latest answer', { v: 'ghost', size: 'sm', act: 'chat-variant', data: { msg: m.id, d: last - vi } })}</div>` : '';
  if (changed.length) {
    const d = changed[0];
    const what = changed.length > 1 ? `<span>${esc(`${changed.length} sources changed since this answer`)}</span>`
      : `<b translate="no">${esc(docTitle(d))}</b> <span>${esc(d.archived ? 'was archived since this answer' : 'has a newer version')}</span>${d.archived ? '' : `<span class="res-dot" aria-hidden="true">·</span><span>${esc(rel(d.updated))}</span>`}`;
    return `<div class="chat-outdated" role="status">${ic('retry', 'i-sm')}<span class="chat-outdated__text">${what}</span>${btn('Update answer', { v: 'secondary', size: 'sm', act: 'chat-refresh', data: { msg: m.id } })}</div>`;
  }
  if (m.refreshed?.length && vi > 0) {
    const d = docById(m.refreshed[0]);
    return `<p class="chat-hint chat-hint--ok">${ic('check', 'i-xs')}<span>Updated from the latest version of</span> <b translate="no">${esc(d ? docTitle(d) : '')}</b>${btn('Previous answer', { v: 'link', size: 'sm', act: 'chat-variant', data: { msg: m.id, d: -1 } })}</p>`;
  }
  return '';
}
/** One Copy: the answer as formatted text, with Markdown as the plain-text flavour (pastes well in docs and in chat tools). */
A['chat-copy'] = async el => {
  const { m } = findMsg(el.dataset.msg); if (!m) return;
  const vis = visCites(m), visN = new Set(vis.map(c => c.n));
  const mdText = String(m.text || '').replace(/\s?\[(\d+)\]/g, (x, n) => visN.has(+n) ? x : '');
  try {
    const html = md(mdText, { cite: n => visN.has(n) ? `<sup>[${n}]</sup>` : '' });
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([mdText], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
    toast('Copied');
  } catch { copyText(mdText, 'Copied'); }
};
A['chat-variant'] = el => { const { m } = findMsg(el.dataset.msg); if (!m?.variants || run) return; m.vi = Math.max(0, Math.min(m.variants.length - 1, (m.vi ?? m.variants.length - 1) + +el.dataset.d)); Object.assign(m, clone(m.variants[m.vi])); refresh(); };
A['chat-steps'] = el => { const u = cui(); u.open[el.dataset.msg] = !u.open[el.dataset.msg]; refresh(); };
A['chat-run'] = el => { const u = cui(); u.open[el.dataset.k] = !u.open[el.dataset.k]; const { m } = findMsg(el.dataset.k.split(':run:')[0]); m ? paint(m) : refresh(); };

/** Shared entry point: start a new conversation with question q, optionally scoped to a collection or a space (its knowledge), with one resource (doc) or several (docs, comma list) attached as references. Empty q opens Home's composer with that scope chosen. */
A['chat-ask'] = el => {
  const { q = '', kb, space, doc, docs } = el?.dataset || {};
  const sp = space && hasModule('spaces') ? spaceById(space) : null;
  const spKbs = readableKbsOf(sp);
  const scope = kb && canReadKb(kbById(kb)) ? [kb] : spKbs;
  const spaceId = sp && spKbs.length ? sp.id : null;
  if (!q.trim()) { Object.assign(composer('home'), { scope, space: spaceId }); A['chat-new'](); return; }
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
    conv.messages.length = i + 2; am.q = t; am.text = ''; am.variants = null; am.vi = null; turn = pin = true; conv.at = Date.now();
    stream(conv, am, S.pageState === 'error');
  };
  if (later > 0) confirmAction({ title: 'Edit and resend?', icon: 'pencil', body: `The ${plural(later, 'later message')} in this conversation will be removed. Files the assistant made stay available.`, confirm: 'Edit and resend', delay: 0, onConfirm: resend });
  else resend();
};

/* Feedback */
const FB_REASONS = ['Not accurate', 'Missing information', 'Wrong source', 'Didn’t answer my question'];
function setFeedback(m, kind, reason = null) { m.feedback = kind; m.reason = reason; refresh(); if (kind) toast('Thanks — your feedback goes to the workspace admins'); }
A['chat-up'] = el => { const { m } = findMsg(el.dataset.msg); if (m) setFeedback(m, m.feedback === 'up' ? null : 'up'); };
MENUS['chat-down'] = el => {
  const { m } = findMsg(el.dataset.msg); if (!m) return [];
  const items = [{ section: 'What was wrong?' }, ...FB_REASONS.map(r => ({ label: r, checked: m.feedback === 'down' ? m.reason === r : undefined, run: () => setFeedback(m, 'down', r) })),
    { label: 'Something else…', icon: 'pencil', run: () => { S.ui.chatFb = { text: '', touched: false, busy: false }; openModal('chat-feedback', { msg: m.id }); } }];
  if (m.feedback === 'down') items.push({ sep: true }, { label: 'Remove feedback', icon: 'x', run: () => setFeedback(m, null) });
  return items;
};
/** A quiet "what this is about" row at the top of a dialog (the question, the conversation, the file). */
const ctxRow = (lead, title, meta = '') => `<div class="chat-ctx">${lead}<div class="grow"><div class="chat-ctx__title truncate" translate="no">${title}</div>${meta ? `<div class="t-xs muted truncate">${meta}</div>` : ''}</div></div>`;
const FB_MAX = 140;
M['chat-feedback'] = p => {
  const f = ui('chatFb', { text: '', touched: false, busy: false }), { m } = findMsg(p.msg), dis = f.busy ? 'disabled' : '';
  const err = f.touched && !f.text.trim() ? 'Add a short note so the admins know what to fix.' : '';
  return { size: 'sm', icon: 'thumbs-down', title: 'Send feedback', desc: 'Workspace admins see it with this answer and use it to fix the knowledge.',
    body: (m?.q ? ctxRow(itemIcon('message', '', 'sm'), `“${esc(m.q)}”`, 'The question you asked') : '')
      + field({ id: 'chat-fb-text', label: 'What was wrong?', error: err, counter: `<span class="counter">${f.text.length}/${FB_MAX}</span>`,
        control: textarea({ id: 'chat-fb-text', bind: 'chatFb.text', value: f.text, rows: 3, placeholder: 'e.g. It cites last year’s version of the policy', invalid: !!err, attrs: `maxlength="${FB_MAX}" data-live data-autofocus data-enter="chat-fb-send" ${dis}` }) }),
    foot: btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: f.busy }) + btn('Send feedback', { v: 'primary', icon: 'send', act: 'chat-fb-send', loading: f.busy }) };
};
A['chat-fb-send'] = async () => {
  const f = ui('chatFb'), p = S.modal.props; if (f.busy) return;
  f.touched = true;
  if (!f.text.trim()) { refreshLayer(); $('#chat-fb-text')?.focus(); return; }
  f.busy = true; p.guard = true; refreshLayer(); await sleep(600);
  const { m } = findMsg(p.msg); closeModal(); if (m) setFeedback(m, 'down', f.text.trim().slice(0, FB_MAX));
};

/* Answer: more menu (rewrite, download) */
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
  const busy = !!run, again = (label, icon, mod) => ({ label, icon, disabled: busy, run: () => retry(m.id, mod) });
  return [{ section: 'Rewrite' }, again('More detail', 'list', 'detail'), again('Shorter', 'sliders', 'shorter'),
    conv.scope?.length && { label: `Ask again in ${allLabel().replace(/^All/, 'all')}`, icon: 'layers', disabled: busy, run: () => A['chat-unscope']({ dataset: { msg: m.id } }) },
    { sep: true }, { section: 'Download' },
    { label: 'Word document', icon: 'download', meta: '.doc', run: () => downloadAnswer(conv, m, 'word') },
    { label: 'PDF', icon: 'download', meta: '.pdf', run: () => downloadAnswer(conv, m, 'pdf') }].filter(Boolean);
};
A['chat-request'] = el => {
  if (A['kb-request']) return A['kb-request'](el);
  const kb = el.dataset.kb;
  if (D.requests.some(r => r.user === me().id && r.kb === kb && r.status === 'pending')) { toast('Access already requested', { tone: 'accent' }); return; }
  D.requests.push({ id: uid('req'), user: me().id, kb, role: 'viewer', note: '', at: Date.now(), status: 'pending' });
  toast('Access requested'); refresh();
};

/* Thread ⋯: the conversation menu of the sidebar's Recent rows and project pages (conversations.js), minus Rename — the title renames itself */
MENUS['chat-more'] = el => X.conversations?.menu(convById(el.dataset.id), { rename: false }) || [];

/* ═══════════════ Share ═══════════════
   Sharing a conversation is a share of the LIVE conversation (features/shares.js; backend workspaces/{w}/shares/{s} with
   target …/conversations/{c}): whoever it resolves for reads it as it grows, read-only, at /chat/:id (sharedThread). Its
   audience is everyone in the workspace or the people chosen. The dialog edits your one live share: changing who can open
   it revokes the old link and makes a new one (a share's audience is fixed); Stop sharing revokes it. Revoking is final, so
   there is no Undo — sharing again makes a new link. The dialog edits a draft: Cancel discards it. */
const liveShare = conv => (conv ? X.shares?.liveFor({ type: 'conversation', id: conv.id }) : null);
const memberName = id => D.members.find(x => x.id === id)?.name || 'Someone';
function namesList(ids) { const n = ids.map(memberName); return n.length <= 2 ? n.join(' and ') : `${n[0]}, ${n[1]} and ${n.length - 2} more`; }
function shareSummary(conv) { const s = liveShare(conv); return !s ? '' : s.audience === 'people' ? `Shared with ${namesList(s.recipients)}` : `Anyone in ${curWs().name} can open it`; }
const sameAudience = (s, d) => !!s && s.audience === d.who && (d.who !== 'people' || (s.recipients.length === d.people.length && s.recipients.every(id => d.people.includes(id))));
A['chat-share'] = el => { const conv = convById(el.dataset.id), s = liveShare(conv); if (!conv) return; S.ui.chatShare = { id: conv.id, who: s?.audience || 'workspace', people: [...(s?.recipients || [])], q: '', touched: false }; openModal('chat-share'); };
function shareMatches(s) {
  const q = s.q.trim().toLowerCase(); if (!q) return [];
  return (D.members || []).filter(x => x.id !== me().id && x.email !== me().email && x.status !== 'deactivated' && !s.people.includes(x.id) && (x.name.toLowerCase().includes(q) || x.email.toLowerCase().includes(q))).slice(0, 5);
}
M['chat-share'] = () => {
  const s = ui('chatShare'), conv = convById(s.id), ws = curWs(); if (!conv) return { title: 'Share conversation', body: '' };
  const asked = conv.messages.filter(m => m.role === 'user').length;
  const err = s.who === 'people' && s.touched && !s.people.length ? 'Add at least one person.' : '';
  const matches = shareMatches(s);
  const chips = s.people.map(id => `<span class="chat-share__chip">${avatar(memberName(id), 'xs')}<span class="truncate">${esc(memberName(id))}</span><button type="button" class="chat-share__x" data-act="chat-share-remove" data-id="${esc(id)}" aria-label="Remove ${esc(memberName(id))}">${ic('x', 'i-xs')}</button></span>`).join('');
  const people = s.who !== 'people' ? '' : `<div class="field"><label class="label" for="chat-share-q">People</label>
    <div class="${cx('chat-share__box', err && 'is-invalid')}">${chips}<input id="chat-share-q" class="chat-share__input" type="text" value="${esc(s.q)}" placeholder="${s.people.length ? 'Add another person' : 'Search people by name or email'}" data-bind="chatShare.q" data-live data-enter="chat-share-enter" autocomplete="off" role="combobox" aria-expanded="${!!matches.length}" aria-controls="chat-share-opts" ${err ? 'aria-invalid="true" aria-describedby="chat-share-q-err"' : ''}></div>
    ${matches.length ? `<div class="chat-share__opts" id="chat-share-opts" role="listbox" aria-label="People">${matches.map(x => `<button type="button" class="chat-share__opt" role="option" data-act="chat-share-add" data-id="${esc(x.id)}">${avatar(x.name, 'sm')}<span class="grow"><span class="chat-share__name">${esc(x.name)}</span><span class="t-xs muted truncate">${esc(x.email)}</span></span></button>`).join('')}</div>` : s.q.trim() ? `<div class="description">No one in ${esc(ws.name)} matches “${esc(s.q.trim())}”.</div>` : ''}
    ${err ? `<div class="field-error" id="chat-share-q-err" role="alert">${ic('alert-circle')}<span>${esc(err)}</span></div>` : ''}</div>`;
  const share = liveShare(conv), changed = !sameAudience(share, s);
  const status = share ? `<div class="chat-share__status">${ic(share.audience === 'people' ? 'users' : 'building', 'i-sm')}<span class="grow">${esc(shareSummary(conv))}</span><span class="t-xs muted none">${esc(rel(share.at))}</span></div>` : '';
  const link = share ? `<div class="field"><label class="label" for="chat-share-link">Link</label><div class="input-group input-group--suffix">${input({ id: 'chat-share-link', value: X.shares.url(share), attrs: 'readonly', cls: 'mono' })}<span class="input-group__suffix">${iconBtn('copy', 'Copy link', { size: 'sm', act: 'copy', data: { text: X.shares.url(share), msg: 'Link copied' } })}</span></div>${changed ? '<div class="description">Saving makes a new link. This one stops opening.</div>' : ''}</div>` : '';
  return { title: 'Share conversation', icon: 'share',
    desc: 'They read it as it grows, without replying. Answers and sources they can’t open stay hidden.',
    body: ctxRow(itemIcon('message', '', 'sm'), esc(conv.title), `${plural(asked, 'question')} · Updated ${rel(conv.at).toLowerCase()}`) + status
      + `<div class="field"><span class="label">Who can open it</span>${choiceGroup({ name: 'chat-share-who', value: s.who, act: 'chat-share-who', options: [['workspace', `Anyone in ${ws.name}`, 'Everyone who can sign in to this workspace.', 'building'], ['people', 'Only people you choose', 'Only the people you add below.', 'lock']] })}</div>`
      + people + link,
    footStart: share ? btn('Stop sharing', { v: 'danger-soft', act: 'chat-share-stop' }) : '',
    foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn(!share ? 'Share' : changed ? 'Update sharing' : 'Copy link', { v: 'primary', icon: !share || changed ? 'share' : 'copy', act: 'chat-share-save' }) };
};
A['chat-share-who'] = el => { const s = ui('chatShare'); s.who = el.dataset.value; s.touched = false; refreshLayer(); if (s.who === 'people') requestAnimationFrame(() => $('#chat-share-q')?.focus()); };
A['chat-share-add'] = el => { const s = ui('chatShare'); if (!s.people.includes(el.dataset.id)) s.people.push(el.dataset.id); s.q = ''; refreshLayer(); requestAnimationFrame(() => $('#chat-share-q')?.focus()); };
A['chat-share-enter'] = () => { const m = shareMatches(ui('chatShare'))[0]; if (m) A['chat-share-add']({ dataset: { id: m.id } }); else A['chat-share-save'](); };
A['chat-share-remove'] = el => { const s = ui('chatShare'); s.people = s.people.filter(id => id !== el.dataset.id); refreshLayer(); $('#chat-share-q')?.focus(); };
A['chat-share-save'] = async () => {
  const s = ui('chatShare'), conv = convById(s.id); if (!conv) return closeModal();
  if (s.who === 'people' && !s.people.length) { s.touched = true; refreshLayer(); $('#chat-share-q')?.focus(); return; }
  const prev = liveShare(conv);
  if (sameAudience(prev, s)) { if (await copyText(X.shares.url(prev), 'Link copied')) closeModal(); return; }
  X.shares.revoke(prev);
  const { share } = X.shares.create({ kind: 'share', target: { type: 'conversation', id: conv.id }, audience: s.who, recipients: s.who === 'people' ? [...s.people] : [] });
  closeModal(); refresh();
  const msg = prev ? 'Sharing updated. The new link is copied; the old one no longer opens.' : s.who === 'people' ? `Shared with ${namesList(s.people)}. Link copied.` : `Shared with everyone in ${curWs().name}. Link copied.`;
  await copyText(X.shares.url(share), msg);
};
A['chat-share-stop'] = () => {
  const conv = convById(ui('chatShare').id), share = liveShare(conv); if (!share) return;
  X.shares.revoke(share); closeModal(); refresh();
  toast('Stopped sharing. The link no longer opens.');
};

/* A conversation shared with you (read-only, live): what the owner asked and what the assistant answered, re-filtered for
   you on every read — an answer built only from knowledge you can't open is withheld, sources you can't open are dropped.
   No composer, feedback, retry, next steps or files (files are shared on their own); only the owner continues it. */
function sharedAnswer(m) {
  const all = m.citations || [], vis = visCites(m), visN = new Set(vis.map(c => c.n));
  if (all.length && !vis.length) return `<p class="chat-hint">${ic('lock', 'i-xs')}<span>This answer uses knowledge you can’t open, so it isn’t shown.</span></p>`;
  if (!m.text) return '';
  const ctx = { cite: n => { if (!visN.has(n)) return ''; const c = vis.find(x => x.n === n), d = docById(c.doc); return `<button type="button" class="cite" data-act="cite-open" data-msg="${m.id}" data-n="${n}" aria-label="Source ${n}: ${esc(d.name)}, page ${c.page}">${n}</button>`; } };
  return `<div class="chat-answer">${md(m.text, ctx)}</div>`
    + (vis.length < all.length ? `<p class="chat-hint">${ic('lock', 'i-xs')}<span>Some sources are hidden because you can’t open them.</span></p>` : '')
    + (vis.length ? sourcesHtml(m, vis) : '');
}
function sharedThread(conv) {
  ensureSeed(conv);
  const share = X.shares.sharedWithMe(conv.id);
  crumbs([{ label: conv.title }]);
  pageHeader({ title: conv.title, meta: `Shared by ${memberName(conv.owner)} · ${rel(share.at)}` });
  const turns = conv.messages.filter(m => m.role === 'user' || (m.state || 'done') === 'done').map(m => m.role === 'user'
    ? `<div class="chat-msg chat-msg--user"><div class="chat-user"><div class="chat-bubble">${esc(m.text)}</div></div></div>`
    : `<div class="chat-msg chat-msg--ai">${sharedAnswer(m)}</div>`).join('');
  return `<div class="split chat-split"><div class="split__main chat-main">
    <div class="chat-scroll" id="chat-scroll" data-keep-scroll>${gate({ ok: () => `<div class="chat-thread">${turns}</div>`, loading: threadSkel })}</div>
    <div class="chat-dock"><div class="chat-dock__inner"><p class="chat-hint chat-hint--readonly">${ic('lock', 'i-xs')}<span>${esc(`Read-only. Only ${memberName(conv.owner)} can continue this conversation.`)}</span></p></div></div>
  </div></div>`;
}

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

/* ═══════════════ Product tour: Home, the real landing page ═══════════════
   Starts by itself the first time a person lands on Home in a workspace (remembered per person and workspace), and from
   the account menu any time. It shows Home's three parts — the Ask box, Picked for you, Explore by domain — then New chat and
   Search. Steps skip what isn't on screen (the sidebar on phones). The card never covers what it points at: it sits beside
   the target, or as a bottom sheet on phones with the target scrolled above it. One way out: Skip tour (or Esc). */
DATA_KEYS.push('tourSeen');
const touch = () => matchMedia('(hover: none)').matches;
const TOUR = [
  { sel: '#home-ask', title: 'Ask anything', body: () => `Answers come only from documents you can read in ${curWs().name}, with their sources. Attach files or choose what to search; the suggestions are questions people in your role ask.` },
  { sel: '.home-picks', title: 'Picked for you', body: () => 'Chosen from your role’s questions, your spaces and what you read. The label on each card says why.' },
  { sel: '.home-domains', title: 'Everything, by domain', body: () => 'A domain opens Knowledge filtered to it; a topic goes straight to its documents.' },
  { sel: '#nav-chat', title: 'New chat', body: () => 'Start a conversation here, with files and a chosen scope. Your conversations are listed under Recent at the bottom of the sidebar; ⟳ marks one whose answer relies on a document that changed.' },
  { sel: '#side-search, #topbar-search', title: 'Find anything', body: () => touch() ? 'Search conversations, documents and pages.' : 'Search conversations, documents and pages, or press ⌘K.' },
];
let tourAt = null;
const tourKey = () => `${me().id}:${S.ws}`;
const tourSeen = () => (D.tourSeen ??= {});
/** The first on-screen element a step points at (phones show some controls in other places, or not at all). */
function tourEl(sel) {
  const fr = $('#frame').getBoundingClientRect();
  return $$(sel).find(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > fr.left + 4 && r.left < fr.right - 4; }) || null;
}
const tourSteps = () => TOUR.filter(s => tourEl(s.sel));
function tourClose() { tourAt = null; $('#chat-tour')?.remove(); $('#chat-tour-ring')?.remove(); }
const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
function tourPaint(focus) {
  $('#chat-tour')?.remove(); $('#chat-tour-ring')?.remove();
  if (tourAt == null) return;
  if (S.cur?.r.page !== 'home') { tourAt = null; return; }
  const steps = tourSteps(); if (!steps.length) { tourAt = null; return; }
  tourAt = Math.min(tourAt, steps.length - 1);
  const st = steps[tourAt], t = tourEl(st.sel), frame = $('#frame'), last = tourAt === steps.length - 1;
  const card = document.createElement('div'); card.id = 'chat-tour'; card.className = 'chat-tour'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-labelledby', 'chat-tour-title'); card.setAttribute('aria-describedby', 'chat-tour-body');
  card.innerHTML = `<span class="chat-tour__step num">${tourAt + 1} of ${steps.length}</span><h3 class="chat-tour__title" id="chat-tour-title">${esc(st.title)}</h3><p class="chat-tour__body" id="chat-tour-body">${esc(st.body())}</p><div class="chat-tour__foot">${btn('Skip tour', { v: 'ghost', size: 'sm', act: 'chat-tour-skip' })}<span class="grow"></span>${tourAt ? btn('Back', { size: 'sm', act: 'chat-tour-step', data: { d: -1 } }) : ''}${btn(last ? 'Done' : 'Next', { v: 'primary', size: 'sm', act: 'chat-tour-step', data: { d: 1 }, id: 'chat-tour-next' })}</div>`;
  const fr0 = frame.getBoundingClientRect(), sheet = fr0.width < 680;
  if (sheet) card.classList.add('chat-tour--sheet');
  frame.append(card);
  const cw = card.offsetWidth, ch = card.offsetHeight;
  // Bring the target into view (above the sheet on phones) before measuring.
  const sc = $('#scroll'), r0 = t.getBoundingClientRect();
  if (sc && sc.contains(t)) {
    const room = sheet ? fr0.bottom - ch - 24 : fr0.bottom - 16;
    if (r0.bottom > room || r0.top < fr0.top + 64) sc.scrollTop += r0.top - fr0.top - (sheet ? Math.max(64, (room - fr0.top - r0.height) / 2) : 96);
  }
  const fr = frame.getBoundingClientRect(), r = t.getBoundingClientRect(), pad = 6;
  const ring = document.createElement('div'); ring.id = 'chat-tour-ring'; ring.className = 'chat-tour-ring';
  const rr = { left: r.left - fr.left - pad, top: r.top - fr.top - pad, right: r.right - fr.left + pad, bottom: r.bottom - fr.top + pad };
  Object.assign(ring.style, { left: rr.left + 'px', top: rr.top + 'px', width: rr.right - rr.left + 'px', height: rr.bottom - rr.top + 'px' });
  frame.insertBefore(ring, card);
  if (!sheet) {
    const gap = 12, cx0 = (rr.left + rr.right) / 2 - cw / 2, cy0 = (rr.top + rr.bottom) / 2 - ch / 2;
    const clampX = x => Math.max(12, Math.min(fr.width - cw - 12, x)), clampY = y => Math.max(12, Math.min(fr.height - ch - 12, y));
    const spots = [[clampX(cx0), rr.bottom + gap], [clampX(cx0), rr.top - gap - ch], [rr.right + gap, clampY(cy0)], [rr.left - gap - cw, clampY(cy0)]];
    const fits = ([x, y]) => x >= 12 && y >= 12 && x + cw <= fr.width - 12 && y + ch <= fr.height - 12 && !overlaps({ left: x, top: y, right: x + cw, bottom: y + ch }, rr);
    const [x, y] = spots.find(fits) || [fr.width - cw - 16, fr.height - ch - 16];
    card.style.left = x + 'px'; card.style.top = y + 'px';
  }
  if (focus) requestAnimationFrame(() => $('#chat-tour-next')?.focus());
}
function tourBegin() { tourSeen()[tourKey()] = Date.now(); persist(); tourAt = 0; tourPaint(true); }
X.startTour = () => {
  tourClose();
  if (S.navOpen) S.navOpen = false;
  if (S.cur?.r.page !== 'home') go('/home'); else refresh();
  setTimeout(tourBegin, 200);
};
/** First visit to Home in this workspace: start once, by itself (after Home has finished loading). */
function tourAuto() {
  if (tourAt != null || !S.signedIn || S.cur?.r.page !== 'home' || S.pageState !== 'live' || S.modal || S.drawer || S.palette || S.menu) return;
  if (tourSeen()[tourKey()]) return;
  if (S.navLoading || !$('#home-ask')) { setTimeout(tourAuto, 300); return; }
  tourBegin();
}
/* Home re-renders (workspace switch, page state) keep the tour on its target. */
new MutationObserver(() => { if (tourAt != null) requestAnimationFrame(() => tourPaint(false)); }).observe(document.getElementById('app'), { childList: true });
const tourDone = () => tourClose();
A['chat-tour-step'] = el => {
  const n = tourAt + +el.dataset.d;
  if (n >= tourSteps().length) { tourDone(); toast('You’re all set. Ask a question or open something picked for you.'); return; }
  tourAt = Math.max(0, n); tourPaint(true);
};
A['chat-tour-skip'] = tourDone;
window.addEventListener('resize', () => tourAt != null && tourPaint(false));
window.addEventListener('load', () => setTimeout(tourAuto, 600));
window.addEventListener('hashchange', () => setTimeout(() => (tourAt != null ? tourPaint(false) : tourAuto()), 400));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && tourAt != null && !S.modal && !S.menu && !S.palette) { e.stopPropagation(); tourDone(); } }, true);

/* Internal API shared with chat-files.js and conversations.js */
X.chat = { findMsg, answer, flowOf, plain, makeTitle, cui, composer, composerKey, composerHtml, composerFiles, afterComposer, suggestions, changedSources, outdatedAnswers, canDoc, visCites, normFile, mineKb, isMine, paint, focusComposer, ensureSeed, lastLine, ask, CLAIMS,
  busy: () => !!run, streamingIn: id => run?.conv === id, stopIfIn: id => { if (run?.conv === id) run.stop = true; } };
})();
