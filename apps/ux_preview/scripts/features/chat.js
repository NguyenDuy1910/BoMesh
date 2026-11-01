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
const SEED = { c3: 'What changed in the parental leave policy for 2026?', c4: 'Summarize our enterprise pricing tiers.', c5: 'What are the steps to onboard a contractor?', c6: 'Draft a QBR brief for my next Acme meeting.', c7: 'How much is the remote work equipment stipend?', c8: 'What should a vendor security review checklist include?', c9: 'How do customers set up SSO?',
  cu3: 'Outline a 15-minute recap of Week 4 regularization for Tuesday’s class.', cu4: 'Explain the bias–variance trade-off with an example from Week 4.', cu5: 'What does the regulation say about withdrawing after week 10 for medical reasons?', cu6: 'What GPA do I need for the academic excellence scholarship?' };

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
/** Course concept answers: study from the cited material (students) or assess it (teaching team). */
const studyNext = (space, docs) => [NX.work('study-guide', 'Make a study guide', space, docs), NX.work('practice-quiz', 'Practice quiz', space, docs), NX.work('quiz', 'Make a quiz for students', space, docs)];
/** Where to take a question the sources don't settle: the space's teaching team, else the office that owns the knowledge. */
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

/* ═══════════════ Campus answers (UTE Campus demo content) ═══════════════
   Topic: { k, when?, text | text(ctx), cites, next?(ctx), gap?, files?, live?(q) }.
   gap: the sources don't settle it — answer honestly, cite what they do say,
   offer who can decide, and record the question as a knowledge gap. */
const ct = (doc, page, quote) => ({ doc, page, quote });
const UQ = {
  withdraw: ct('du-reg-rules', 18, 'Students may withdraw from a registered course no later than the end of week 10 of the semester. Withdrawn courses appear as W on the transcript and do not count toward the GPA.'),
  week10: ct('du-reg-cal', 2, 'Week 10 of Semester 1 ends on Tuesday, 10 November 2026.'),
  refund: ct('du-reg-fees', 5, 'Tuition for withdrawn courses is not refunded, except for courses cancelled by the university.'),
  minLoad: ct('du-reg-rules', 17, 'The minimum registered load in a regular semester is 14 credits; students below this load must be approved by the Faculty.'),
  grades: ct('du-reg-rules', 31, 'Lecturers must publish final grades on the student portal within 10 working days after the final exam.'),
  regradeWindow: ct('du-reg-regrade', 1, 'Students may request re-grading of an exam within 7 days after the grade is published.'),
  regradeFee: ct('du-reg-regrade', 2, 'The re-grading fee is 30,000 VND per course and is refunded if the grade changes.'),
  transcript: ct('du-reg-fees', 6, 'Official transcripts are issued within two working days. Each copy costs 20,000 VND.'),
  leave: ct('du-reg-leave', 1, 'Students who have completed at least one semester may suspend their studies for up to two semesters in total.'),
  leaveEvidence: ct('du-reg-leave', 2, 'Requests must state the reason and attach supporting evidence where applicable, such as a medical certificate or a family confirmation letter.'),
  scholar: ct('du-sso-schol', 3, 'Academic excellence scholarships require a semester GPA of at least 3.2 and no failed courses.'),
  a1: ct('du-ml-a1', 1, 'Train a linear regression model to predict house prices and report the RMSE on the held-out test split. Submit a notebook and a two-page report.'),
  lab2Scratch: ct('du-ml-lab2', 1, 'Implement batch gradient descent from scratch using NumPy only; do not use a machine learning library for this lab.'),
  lab2Scale: ct('du-ml-lab2', 3, 'Standardize each feature to zero mean and unit variance before running gradient descent.'),
  linreg: ct('du-ml-w02', 6, 'The model predicts ŷ = wᵀx and is trained by minimizing the mean squared error between predictions and targets.'),
  alpha: ct('du-ml-w02', 18, 'If α is too large gradient descent can overshoot and diverge; if it is too small, convergence is slow.'),
  l2: ct('du-ml-w04', 7, 'L2 regularization adds λ‖w‖² to the loss, shrinking all weights toward zero without making them exactly zero.'),
  bias0: ct('du-ml-w04', 9, 'By convention the bias term w₀ is not regularized: it shifts every prediction equally and does not add model complexity.'),
  l1: ct('du-ml-w04', 11, 'L1 regularization (lasso) can set weights exactly to zero, which performs feature selection.'),
  bv: ct('du-ml-w04', 15, 'High variance: training error is low but validation error is much higher. High bias: both errors are high.'),
  lambda: ct('du-ml-w04', 18, 'Increasing λ reduces variance but can increase bias; choose λ on a validation set.'),
  cv: ct('du-ml-w04', 21, 'Select λ with k-fold cross-validation; never tune hyper-parameters on the test set.'),
  gini: ct('du-ml-w05', 8, 'CART uses Gini impurity to choose splits for classification trees.'),
  bagging: ct('du-ml-w05', 15, 'Bagging trains each tree on a bootstrap sample of the training data and averages their predictions to reduce variance.'),
  forest: ct('du-ml-w05', 27, 'Sampling a subset of features at each split decorrelates the trees, so averaging them reduces variance.'),
  unit: ct('du-ml-w06', 4, 'A neural network stacks layers of units; each unit computes a weighted sum of its inputs followed by a non-linear activation such as ReLU.'),
  nonlin: ct('du-ml-w06', 9, 'Without non-linear activations, a stack of layers collapses into a single linear model.'),
  backprop: ct('du-ml-w06', 19, 'Backpropagation applies the chain rule to compute the gradient of the loss with respect to every weight, layer by layer from the output back.'),
  inner: ct('du-db-w05', 6, 'An INNER JOIN combines rows from two tables on a join condition and returns only the rows that have matching values in both tables.'),
  left: ct('du-db-w05', 11, 'A LEFT JOIN returns every row of the left table; columns from the right table are NULL when there is no match.'),
  lab3: ct('du-db-lab3', 2, 'Use a LEFT JOIN to list every student, including those who have not enrolled in any course.'),
  nf1: ct('du-db-w07', 3, 'Normalization removes redundancy by decomposing relations according to their functional dependencies. A relation is in 1NF when every attribute holds a single, atomic value.'),
  nf2: ct('du-db-w07', 5, 'A relation is in 2NF if it is in 1NF and every non-key attribute depends on the whole of every candidate key.'),
  nf3: ct('du-db-w07', 9, 'A relation is in 3NF if, for every non-trivial functional dependency X → A, X is a superkey or A is part of some candidate key.'),
  bcnf: ct('du-db-w07', 14, 'BCNF is stricter than 3NF: for every non-trivial functional dependency X → A, X must be a superkey.'),
  p1Method: ct('du-ag-p1', 4, 'We fine-tune a MobileNetV3-Large pretrained on ImageNet, freezing the first 10 blocks.'),
  p1Result: ct('du-ag-p1', 9, 'The fine-tuned model reached 96.2% accuracy with 21 ms inference on a mid-range Android phone.'),
  p5Result: ct('du-ag-p5', 11, 'Accuracy drops from 99.1% on lab images to 93.4% on field images.'),
  p2Transfer: ct('du-ag-p2', 9, 'Transfer learning dominates recent work: 71% of the studies fine-tune ImageNet-pretrained CNNs.'),
  p2Lab: ct('du-ag-p2', 14, '68% of the surveyed studies evaluate only on PlantVillage, whose images are taken on uniform backgrounds.'),
  p3Method: ct('du-ag-p3', 3, 'An 8-bit quantized CNN runs on an ESP32-S3 to classify soil moisture states from capacitive sensor traces.'),
  p3Data: ct('du-ag-p3', 5, 'Data were logged every 5 minutes for 42 days on three experimental plots.'),
  p3Result: ct('du-ag-p3', 8, 'The model classified soil moisture states with 92% accuracy at 38 mW average power.'),
  p3Limit: ct('du-ag-p3', 10, 'Our approach targets sensor time series and does not address image-based disease detection.'),
  p4: ct('du-ag-p4', 2, 'Nodes reporting every 15 minutes over LoRaWAN ran for 14 months on two AA batteries in flooded rice paddies.'),
  nafBudget: ct('du-gr-naf', 5, 'The total budget of a basic research project may not exceed 2.5 billion VND.'),
  nafScope: ct('du-gr-naf', 3, 'Priority areas for 2027 include applied artificial intelligence for agriculture and the environment. Projects may last up to 24 months.'),
  nafDeadline: ct('du-gr-naf', 2, 'Proposals must be submitted through the NAFOSTED online system no later than 15 January 2027.'),
  nafTpl: ct('du-gr-tpl', 2, 'Section B (Background and significance) should not exceed three pages.'),
  cal1: ct('du-ag-proto', 1, 'Calibrate each capacitive soil sensor before deployment and again every 30 days in the field.'),
  cal2: ct('du-ag-proto', 2, 'Record raw readings in dry air and in water to set the two end points of the scale.'),
  cal3: ct('du-ag-proto', 3, 'Take gravimetric samples at three moisture levels and fit a linear calibration curve; accept the sensor only if R² ≥ 0.95.'),
  cal4: ct('du-ag-proto', 5, 'Log the sensor ID, date, temperature and fitted coefficients in the calibration sheet.'),
};
const ASK_STOP = new Set([...STOP, 'students', 'student', 'asked', 'most', 'questions', 'question', 'week', 'people', 'common', 'class', 'often']);
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
  if (qs.length) parts.push(`**Sent to your teaching teams this week**\n${qs.slice(0, 5).map(r => `- [“${mdText(r.fields.question)}”](/requests/${r.id}) — ${actorName(r.requester)}, ${rel(r.created).toLowerCase()}${r.status === 'completed' ? ' · answered' : ''}`).join('\n')}`);
  if (gaps.length) parts.push(`**Questions the knowledge couldn’t answer**\n${gaps.slice(0, 5).map(g => `- “${mdText(g.q)}” — asked ${plural(g.n, 'time')} · ${mdText(g.why)}`).join('\n')}`);
  const next = [hasModule('requests') && qs.length ? { label: 'Open the question queue', href: '/requests?tab=queue' } : null, isAdmin() && gaps.length ? { label: 'Review knowledge gaps', href: '/overview' } : null].filter(Boolean);
  return { text: parts.length ? parts.join('\n\n') : 'No questions came in this week, and nothing went unanswered.', citations: [], searchLabel: 'questions sent to your spaces',
    activity: [{ kind: 'search', label: 'Checked questions sent to your spaces', detail: plural(qs.length, 'question') }, { kind: 'search', label: 'Checked unanswered questions', detail: plural(gaps.length, 'gap') }], next, files: false };
}
const UTE_TOPICS = [
  { k: /(notice|announcement|remind).*withdraw|withdraw.*(notice|announcement)/i, files: true, cites: [UQ.withdraw, UQ.week10, UQ.refund, UQ.minLoad],
    text: 'Here’s a draft notice you can post.\n\n**Reminder: course withdrawal closes on Tuesday, 10 November**\n\nStudents may withdraw from a registered course until the end of week 10 [1], which is **Tuesday, 10 November 2026** [2]. Withdrawn courses appear as W on the transcript and don’t count toward the GPA [1].\n\nTuition for withdrawn courses is not refunded, except for courses the university cancels [3]. After withdrawing you must still be registered for at least 14 credits [4].\n\nTo withdraw, open **Requests → Withdraw from a course**.' },
  { k: /(students|people|class) (ask|asked)|asked (most|about)|common questions|questions (about|did|students)|confus/i, when: () => isAdmin() || mySpaces().some(s => isSpaceStaff(s)), live: askedLately },
  { k: /(withdraw|drop).*(after week|late|medical|sick|illness|hospital)|(medical|sick|illness|hospital).*(withdraw|drop)/i, cites: [UQ.withdraw, UQ.leave, UQ.leaveEvidence],
    gap: { q: 'Can I withdraw after week 10 for medical reasons?', kb: 'kb-u-regs', why: 'The regulation has no rule for late medical withdrawal' },
    text: ({ aaoStaff }) => `The regulation sets one withdrawal deadline: the **end of week 10** [1]. It doesn’t mention exceptions after week 10, for medical reasons or otherwise.\n\nThe documented route for a student who can’t continue for health reasons is a **leave of absence**: students who have completed at least one semester may suspend their studies for up to two semesters [2], with evidence such as a medical certificate [3].\n\n${aaoStaff ? 'Because the regulation is silent, students get no reliable answer here. Adding a rule would let the assistant answer it.' : 'Only Academic Affairs can say whether an exception is possible.'}`,
    next: () => [NX.office('sp-aao', 'Ask Academic Affairs'), NX.request('rt-leave', 'Request a leave of absence')] },
  { k: /withdraw|drop (a |the |my |one )?(course|class|subject)|rút (môn|học phần)/i, cites: [UQ.withdraw, UQ.week10, UQ.refund, UQ.minLoad],
    text: ({ p }) => `You can withdraw from a course until the **end of week 10, which is Tuesday, November 10** this semester [1][2]. The course then shows as **W** on your transcript and doesn’t count toward your GPA [1].\n\nTuition for a withdrawn course is **not refunded**, unless the university cancelled the course [3].\n\n` + (p ? `One more check: you must keep **at least 14 credits** after withdrawing [4]. You’re registered for ${p.credits}, so ${p.credits - 3 >= 14 ? 'dropping one 3-credit course is fine' : 'dropping a course needs Faculty approval'}.` : 'Students must keep **at least 14 credits** after withdrawing [4].'),
    next: () => [NX.request('rt-withdraw', 'Start a withdrawal request')] },
  { k: /publish(ing)? (the )?(final )?grades|grade (submission|deadline)|submit (final )?grades/i, cites: [UQ.grades, UQ.regradeWindow],
    text: 'You have **10 working days** after the final exam to publish final grades on the student portal [1]. Once they’re published, students have **7 days** to ask for re-grading [2].' },
  { k: /re-?grad|re-?mark|regrad|phúc khảo|(grade|mark) (is|was|seems) (wrong|incorrect)|check my (exam|grade)/i, cites: [UQ.regradeWindow, UQ.regradeFee],
    text: 'You can ask for an exam to be re-graded **within 7 days** after the grade is published [1].\n\nThe fee is **30,000 VND per course**, and it’s refunded if your grade changes [2].',
    next: () => [NX.request('rt-regrade', 'Request re-grading')] },
  { k: /transcript|bảng điểm/i, cites: [UQ.transcript],
    text: 'Official transcripts are issued within **two working days**, and each copy costs **20,000 VND** [1].\n\nYou can ask for Vietnamese, English or both, and pick them up at A1-102 or have them posted.',
    next: () => [NX.request('rt-transcript', 'Request a transcript')] },
  { k: /leave of absence|suspend (my )?stud|(take|taking) (a |one |two )?(semester|term)s? off|pause (my )?stud|bảo lưu|defer (my )?stud/i, cites: [UQ.leave, UQ.leaveEvidence],
    text: ({ p }) => `If you have completed at least one semester, you can suspend your studies for **up to two semesters in total** [1] and keep your place.${p ? ` You’re in year ${p.year}, so you meet that condition.` : ''}\n\nState your reason in the request and attach evidence where it applies, such as a medical certificate [2].`,
    next: () => [NX.request('rt-leave', 'Request a leave of absence')] },
  { k: /scholarship|học bổng/i, cites: [UQ.scholar],
    text: ({ p }) => `The academic excellence scholarship needs a **semester GPA of at least 3.2** and **no failed courses** [1].` + (p ? `\n\nYour GPA is **${p.gpa}**, so you ${p.gpa >= 3.2 ? 'meet' : 'don’t yet meet'} the GPA requirement.` : ''),
    next: () => [NX.request('rt-scholar', 'Apply for the scholarship')] },
  { k: /summer/i, cites: [UQ.minLoad],
    gap: { q: 'Can I register more than 25 credits in the summer term?', kb: 'kb-u-regs', why: 'Summer rules are still a draft' },
    text: 'The Academic Regulations only set credit loads for **regular semesters**: at least 14 credits, with Faculty approval below that [1]. They don’t say how many credits you can take in the summer term.\n\nThe summer term rules are still a draft and haven’t been published, so I can’t give you a reliable answer yet.',
    next: () => [NX.office('sp-aao', 'Ask Academic Affairs')] },
  { k: /minimum (number of )?credits|credit load|how many credits|at least \d+ credits|tín chỉ|underload|fewer than \d+ credits/i, cites: [UQ.minLoad],
    text: ({ p }) => `In a regular semester you must register for **at least 14 credits**. Going below that needs approval from your Faculty [1].` + (p ? `\n\nYou’re registered for **${p.credits} credits** this semester.` : '') },
  { k: /scikit|sklearn|(use|using) (a |any )?(librar|package)|allowed to use|can (we|i) use/i, cites: [UQ.a1, UQ.lab2Scratch],
    gap: { q: 'Can we use scikit-learn in Assignment 1?', kb: 'kb-u-ml', why: 'The assignment brief doesn’t say' },
    text: 'The Assignment 1 brief doesn’t say whether you can use libraries such as scikit-learn [1]. It asks you to train a linear regression model on the house price data and report the RMSE on the test split [1].\n\nLab 2 told you to implement gradient descent from scratch with NumPy only [2], but that was an instruction for the lab, not a rule for the assignment.\n\nOnly the teaching team can decide this, so I won’t guess.',
    next: ({ q }) => [NX.staff('sp-ml', q)] },
  { k: /recap|lesson plan|lecture plan|prepare (a|my|the|for) (class|lecture)/i, cites: [UQ.bv, UQ.l2, UQ.l1, UQ.lambda, UQ.cv, UQ.bias0],
    text: () => { const s = D.works?.find(w => w.id === 'w-quiz-w4')?.data?.stats; const pc = s?.attempts ? Math.round(s.byQuestion[1] * 100) : null;
      return `Here’s a 15-minute recap of Week 4:\n\n- **0–3 min · Why regularize.** Start from the symptom: low training error but much higher validation error means high variance [1].\n- **3–8 min · L2 vs L1.** L2 adds λ‖w‖² and shrinks weights toward zero [2]; L1 can set weights exactly to zero, which selects features [3].\n- **8–12 min · Choosing λ.** A larger λ lowers variance but can raise bias [4]; pick it with cross-validation, never on the test set [5].\n- **12–15 min · Check.** Ask why the bias term w₀ isn’t regularized [6]` + (pc != null ? ` — only ${pc}% of the class got this right on the Week 4 quiz.` : '.'); },
    next: () => studyNext('sp-ml', ['du-ml-w04']) },
  { k: /bias|variance|regulari[sz]|overfit|underfit|\blambda\b|λ|ridge|lasso|\bl[12]\b/i, cites: [UQ.bv, UQ.l2, UQ.lambda, UQ.cv],
    text: 'The bias–variance trade-off describes two ways a model can fail [1]:\n\n- **High bias** (underfitting): training and validation error are both high — the model is too simple [1].\n- **High variance** (overfitting): training error is low but validation error is much higher [1].\n\n**Example from Week 4:** a model with 2% training error and 19% validation error has high variance. Regularization helps: L2 adds λ‖w‖² to the loss and shrinks the weights [2].\n\nIncreasing λ reduces variance but can increase bias [3], so choose λ with k-fold cross-validation — never on the test set [4].',
    next: () => studyNext('sp-ml', ['du-ml-w04']) },
  { k: /linear regression|gradient descent|learning rate|\balpha\b|α|normal equation|feature scaling|\bmse\b/i, cites: [UQ.linreg, UQ.alpha, UQ.lab2Scale],
    text: 'Linear regression predicts a number as a weighted sum of the features, ŷ = wᵀx, and is trained by minimizing the mean squared error [1].\n\nGradient descent finds the weights step by step. The **learning rate α** sets the step size: too large and it can overshoot and diverge, too small and it converges slowly [2].\n\nTip from Lab 2: standardize each feature to zero mean and unit variance before running gradient descent [3].',
    next: () => studyNext('sp-ml', ['du-ml-w02', 'du-ml-lab2']) },
  { k: /decision trees?|random forests?|\bgini\b|entropy|ensembles?|bagging|boosting|\bcart\b/i, cites: [UQ.gini, UQ.bagging, UQ.forest],
    text: 'A **decision tree** splits the data on one feature at a time; CART picks each split by Gini impurity for classification [1].\n\nA single deep tree overfits easily. A **random forest** trains many trees, each on a bootstrap sample of the training data, and averages their predictions [2]. It also samples a subset of features at each split, which decorrelates the trees so averaging reduces variance more [3].',
    next: () => studyNext('sp-ml', ['du-ml-w05']) },
  { k: /neural|perceptron|backprop|activation|\brelu\b|sigmoid|hidden layer|\bmlp\b/i, cites: [UQ.unit, UQ.nonlin, UQ.backprop],
    text: 'A neural network stacks layers of units. Each unit computes a weighted sum of its inputs and passes it through a non-linear activation such as ReLU [1].\n\nThe non-linearity matters: without it, any stack of layers collapses into a single linear model [2].\n\nTraining uses **backpropagation**, which applies the chain rule to get the gradient of the loss for every weight, from the output layer back [3].',
    next: () => studyNext('sp-ml', ['du-ml-w06']) },
  { k: /\bjoins?\b|subquer|\bsql\b/i, cites: [UQ.inner, UQ.left, UQ.lab3],
    text: 'A join combines rows from two tables on a join condition [1].\n\n- **INNER JOIN** returns only the rows that have a match in both tables [1].\n- **LEFT JOIN** returns every row of the left table; the right table’s columns are NULL where there’s no match [2].\n\nFor Lab 3, use a LEFT JOIN to list every student, including those not enrolled in any course [3].',
    next: () => studyNext('sp-db', ['du-db-w05', 'du-db-lab3']) },
  { k: /normali[sz]ation|normal forms?|\b[123]nf\b|\bbcnf\b|functional dependenc/i, cites: [UQ.nf1, UQ.nf2, UQ.nf3, UQ.bcnf],
    text: 'Normalization removes redundancy by splitting tables according to their functional dependencies [1]:\n\n- **1NF** — every attribute holds a single, atomic value [1].\n- **2NF** — 1NF, and every non-key attribute depends on the whole of each candidate key [2].\n- **3NF** — for every non-trivial dependency X → A, X is a superkey or A is part of a candidate key [3].\n- **BCNF** — stricter: X must always be a superkey [4].',
    next: () => studyNext('sp-db', ['du-db-w07']) },
  { k: /nafosted|\bgrants?\b|funding call|budget ceiling|research call/i, cites: [UQ.nafBudget, UQ.nafScope, UQ.nafDeadline, UQ.nafTpl],
    text: 'The NAFOSTED 2027 basic research call:\n\n- **Budget:** up to **2.5 billion VND** per project [1].\n- **Duration:** up to **24 months** [2].\n- **Deadline:** submit through the NAFOSTED online system by **15 January 2027** [3].\n- **Fit:** applied AI for agriculture and the environment is a 2027 priority area [2].\n\nIn the proposal template, the background and significance section is limited to three pages [4].',
    next: () => [NX.work('draft', 'Draft a proposal section', 'sp-agri', ['du-gr-naf', 'du-gr-tpl'])] },
  { k: /calibrat/i, cites: [UQ.cal1, UQ.cal2, UQ.cal3, UQ.cal4],
    text: 'The soil sensor calibration protocol in five steps:\n\n- **When:** calibrate each capacitive sensor before deployment and again every 30 days in the field [1].\n- **End points:** record raw readings in dry air and in water to set both ends of the scale [2].\n- **Samples:** take gravimetric samples at three moisture levels [3].\n- **Fit:** fit a linear calibration curve and accept the sensor only if R² ≥ 0.95 [3].\n- **Log:** record the sensor ID, date, temperature and fitted coefficients in the calibration sheet [4].',
    next: () => [NX.work('draft', 'Draft a methods section', 'sp-agri', ['du-ag-proto'])] },
  { k: /edge ai|irrigation|esp32|soil moisture|lorawan|\blora\b|microcontroller/i, cites: [UQ.p3Method, UQ.p3Result, UQ.p3Data, UQ.p4, UQ.p3Limit],
    text: 'Two papers in the library cover low-power sensing in the field:\n\n- **Tran et al. 2024** run an 8-bit quantized CNN on an ESP32-S3 to classify soil moisture from capacitive sensor traces [1], reaching **92% accuracy at 38 mW** [2]. They logged 42 days of data on three plots [3].\n- **Le & Pham 2021** ran LoRaWAN nodes in flooded rice paddies for 14 months on two AA batteries, reporting every 15 minutes [4].\n\nTran et al. work on sensor time series, not images, so their results don’t carry over to leaf disease detection [5].',
    next: () => [NX.work('review', 'Compare them in a literature review', 'sp-agri', ['du-ag-p3', 'du-ag-p4'])] },
  { k: /transfer learning|\brice\b|leaf disease|crop disease|plant disease|(which|what) papers|papers? (in|from) (our|the) (lab|library)/i, cites: [UQ.p1Method, UQ.p1Result, UQ.p5Result, UQ.p2Transfer, UQ.p2Lab],
    text: 'Two papers in the library use transfer learning for this task:\n\n- **Nguyen et al. 2024** fine-tune an ImageNet-pretrained MobileNetV3 on Mekong field images [1] and report **96.2% accuracy**, at 21 ms per image on a phone [2].\n- **Singh et al. 2023** use a ViT-B/16 and report **93.4% on field images**, down from 99.1% in the lab [3].\n\nThe Rahman & Lee survey notes that 71% of recent studies use transfer learning [4], but 68% evaluate only on lab images [5].',
    next: () => [NX.work('review', 'Compare them in a literature review', 'sp-agri', ['du-ag-p1', 'du-ag-p5', 'du-ag-p2'])] },
  { k: /\bdue\b|this week|next (7|seven) days|plan my week|coming up|upcoming|what.?s next|my deadlines|deadlines (this|next)/i, live: dueSoon },
];
/** Answer tables by workspace (demo content). Workspaces without one use Northwind's. files:false = no generated spreadsheets/docs unless a topic allows it. */
const TOPIC_TABLES = { 'ws-ute': { topics: UTE_TOPICS, files: false } };

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
  const ctx = { q, p: me().profile || null, aaoStaff: (D.spaces || []).some(s => s.type === 'office' && isSpaceStaff(s)) };
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
