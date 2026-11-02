'use strict';
/* Knowledge seeds: taxonomy, resource metadata (type, topics, spaces, owner,
   verification, versions, summaries), extra UTE sources and a larger UTE
   catalog, plus each persona's collections, saved resources, recent reads and
   saved views. Loaded after mock.js and ute.js; uses the same seedWorkspace()
   scope. All UTE records are fictional demo data (see ws.demo). */

(() => {
  const T = d => NOW + d * DAY, P = (d, h = 0) => NOW - d * DAY - h * HOUR;
  const V = (by, atDaysAgo, dueInDays) => ({ state: 'verified', by, at: P(atDaysAgo), due: dueInDays == null ? null : T(dueInDays) });
  /** Merge metadata into existing documents: { id: {…fields} }. */
  const meta = map => Object.entries(map).forEach(([id, o]) => { const d = D.docs.find(x => x.id === id); if (d) Object.assign(d, o); });
  const views = () => Math.round(5 + rnd() * 400);

  /* ═══════════════════════════ Northwind (Enterprise) ═══════════════════════════ */
  seedWorkspace('ws-northwind', () => {
    D.topics = [
      { id: 'd-people', name: 'People' }, { id: 't-travel', name: 'Travel & expenses', parent: 'd-people' }, { id: 't-leave', name: 'Leave & benefits', parent: 'd-people' }, { id: 't-conduct', name: 'Workplace & conduct', parent: 'd-people' }, { id: 't-onboarding', name: 'Onboarding', parent: 'd-people' },
      { id: 'd-sales', name: 'Sales' }, { id: 't-pricing', name: 'Pricing & discounts', parent: 'd-sales' }, { id: 't-compete', name: 'Competitive', parent: 'd-sales' }, { id: 't-stories', name: 'Customer stories', parent: 'd-sales' }, { id: 't-salesproc', name: 'Sales process', parent: 'd-sales' },
      { id: 'd-product', name: 'Product' }, { id: 't-api', name: 'API & integrations', parent: 'd-product' }, { id: 't-releases', name: 'Releases', parent: 'd-product' }, { id: 't-admin', name: 'Admin & setup', parent: 'd-product' }, { id: 't-security', name: 'Security & compliance', parent: 'd-product' },
      { id: 'd-finance', name: 'Finance' }, { id: 't-approvals', name: 'Approvals', parent: 'd-finance' }, { id: 't-procure', name: 'Procurement', parent: 'd-finance' },
      { id: 'd-legal', name: 'Legal' }, { id: 't-custagr', name: 'Customer agreements', parent: 'd-legal' }, { id: 't-vendagr', name: 'Vendor agreements', parent: 'd-legal' },
      { id: 'd-eng', name: 'Engineering' }, { id: 't-incidents', name: 'Incidents & on-call', parent: 'd-eng' },
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
  });

  /* ═══════════════════════════ UTE Campus (Campus) ═══════════════════════════ */
  seedWorkspace('ws-ute', () => {
    D.topics = [
      { id: 'd-academic', name: 'Academic affairs' }, { id: 't-registration', name: 'Registration & credits', parent: 'd-academic' }, { id: 't-exams', name: 'Exams & grading', parent: 'd-academic' }, { id: 't-calendar', name: 'Calendar & deadlines', parent: 'd-academic' }, { id: 't-graduation', name: 'Graduation', parent: 'd-academic' }, { id: 't-fees', name: 'Tuition & fees', parent: 'd-academic' },
      { id: 'd-student', name: 'Student life' }, { id: 't-scholar', name: 'Scholarships', parent: 'd-student' }, { id: 't-housing', name: 'Housing', parent: 'd-student' }, { id: 't-records', name: 'Student records & letters', parent: 'd-student' }, { id: 't-wellbeing', name: 'Wellbeing & support', parent: 'd-student' },
      { id: 'd-computing', name: 'Computing' }, { id: 't-ml', name: 'Machine learning & AI', parent: 'd-computing' }, { id: 't-db', name: 'Data & databases', parent: 'd-computing' }, { id: 't-se', name: 'Software engineering', parent: 'd-computing' }, { id: 't-net', name: 'Networks & security', parent: 'd-computing' },
      { id: 'd-engineering', name: 'Engineering' }, { id: 't-mech', name: 'Mechanical engineering', parent: 'd-engineering' }, { id: 't-elec', name: 'Electrical & electronics', parent: 'd-engineering' }, { id: 't-iot', name: 'IoT & embedded systems', parent: 'd-engineering' }, { id: 't-foundation', name: 'Foundation sciences', parent: 'd-engineering' },
      { id: 'd-agri', name: 'Agriculture technology' }, { id: 't-cropdisease', name: 'Crop disease', parent: 'd-agri' }, { id: 't-irrigation', name: 'Irrigation & water', parent: 'd-agri' }, { id: 't-sensing', name: 'Remote sensing', parent: 'd-agri' },
      { id: 'd-research', name: 'Research' }, { id: 't-grants', name: 'Funding & grants', parent: 'd-research' }, { id: 't-publishing', name: 'Publishing', parent: 'd-research' }, { id: 't-ethics', name: 'Research ethics & data', parent: 'd-research' },
    ];
    const ALL_READ = { student: 'viewer', lecturer: 'viewer', researcher: 'viewer' };
    const units = { 'kb-u-regs': 'Academic Affairs Office', 'kb-u-sso': 'Student Services Office', 'kb-u-ml': 'Faculty of IT', 'kb-u-db': 'Faculty of IT', 'kb-u-agri': 'Smart Agriculture Lab', 'kb-u-grants': 'Science & Technology Office' };
    D.kbs.forEach(k => { if (units[k.id]) k.unit = units[k.id]; });
    Object.assign(D.kbs.find(k => k.id === 'kb-u-ml'), { topics: ['t-ml'] });
    Object.assign(D.kbs.find(k => k.id === 'kb-u-db'), { topics: ['t-db'] });
    Object.assign(D.kbs.find(k => k.id === 'kb-u-agri'), { topics: ['t-cropdisease'] });
    Object.assign(D.kbs.find(k => k.id === 'kb-u-grants'), { topics: ['t-grants'] });
    D.kbs.push(
      { id: 'kb-u-cat', name: 'Course syllabi — all programs', desc: 'Approved syllabi for every course, synced from the UTEx LMS.', color: '#1F7A8C', general: 'workspace', access: { ...ALL_READ }, shares: [{ kind: 'group', id: 'g-aao', role: 'owner' }], updated: P(2), unit: 'Academic Affairs Office' },
      { id: 'kb-u-lib', name: 'UTE Digital Library — Theses', desc: 'Approved bachelor’s and master’s theses from the university repository.', color: '#6B4FBF', general: 'workspace', access: { ...ALL_READ }, shares: [{ kind: 'group', id: 'g-aao', role: 'owner' }], updated: P(4), unit: 'University Library', topics: [] },
      { id: 'kb-u-fme', name: 'Mechanical Engineering — Open courseware', desc: 'Lecture notes, lab guides and safety rules of the Faculty of Mechanical Engineering.', color: '#C2620F', general: 'workspace', access: { ...ALL_READ }, shares: [{ kind: 'group', id: 'g-aao', role: 'owner' }], updated: P(3), unit: 'Faculty of Mechanical Engineering', topics: ['t-mech'] },
      { id: 'kb-u-fee', name: 'Electrical & Electronics — Open courseware', desc: 'Lecture notes and lab guides of the Faculty of Electrical & Electronics Engineering.', color: '#A23B3B', general: 'workspace', access: { ...ALL_READ }, shares: [{ kind: 'group', id: 'g-aao', role: 'owner' }], updated: P(5), unit: 'Faculty of Electrical & Electronics Engineering', topics: ['t-elec'] },
      { id: 'kb-u-web', name: 'University news & notices', desc: 'Notices published on ute.edu.vn, collected daily.', color: '#4F5865', general: 'workspace', access: { ...ALL_READ }, shares: [{ kind: 'group', id: 'g-aao', role: 'owner' }], updated: P(0, 4), unit: '' },
    );

    /* Sources: one per system the university already uses. */
    D.accounts.push(
      { id: 'acc-u-lms', app: 'moodle', label: 'utex.ute.edu.vn', user: 'lms-sync@ute.edu.vn', status: 'connected', connected: P(80), checked: ago(14 * MIN) },
      { id: 'acc-u-lib', app: 'dspace', label: 'repository.ute.edu.vn', user: 'library@ute.edu.vn', status: 'connected', connected: P(75), checked: ago(40 * MIN) },
      { id: 'acc-u-sp', app: 'sharepoint', label: 'ute.sharepoint.com', user: 'it-admin@ute.edu.vn', status: 'connected', connected: P(60), checked: ago(22 * MIN) },
      { id: 'acc-u-web', app: 'website', label: 'ute.edu.vn', user: 'Public website', status: 'connected', connected: P(50), checked: ago(4 * HOUR) },
    );
    const sched = (freq, time = '02:00') => ({ freq, time, day: 'Mon', tz: 'Asia/Ho_Chi_Minh', on: true });
    const last = (h, added, updated) => ({ at: P(0, h), result: 'completed', added, updated, removed: 0, failed: 0 });
    D.sources.push(
      { id: 'src-u-cat', name: 'UTEx LMS — Course syllabi', app: 'moodle', account: 'acc-u-lms', kb: 'kb-u-cat', status: 'healthy', scope: ['All programs / Syllabi'], schedule: sched('weekly', '03:00'), last: last(50, 2, 6), next: T(5), created: P(80), owner: 'Võ Thị Lan' },
      { id: 'src-u-lms-db', name: 'UTEx LMS — IT3090 Database Systems', app: 'moodle', account: 'acc-u-lms', kb: 'kb-u-db', status: 'healthy', scope: ['IT3090 / Course files'], schedule: sched('daily', '01:30'), last: last(9, 1, 0), next: T(0.6), created: P(66), owner: 'Lê Văn Hùng' },
      { id: 'src-u-lib', name: 'UTE Digital Library — Theses', app: 'dspace', account: 'acc-u-lib', kb: 'kb-u-lib', status: 'healthy', scope: ['Theses / Bachelor', 'Theses / Master'], schedule: sched('weekly', '04:00'), last: last(96, 3, 0), next: T(3), created: P(75), owner: 'Võ Thị Lan' },
      { id: 'src-u-fme', name: 'FME SharePoint — Open courseware', app: 'sharepoint', account: 'acc-u-sp', kb: 'kb-u-fme', status: 'healthy', scope: ['FME / Open courseware'], schedule: sched('weekly', '05:00'), last: last(72, 0, 2), next: T(4), created: P(60), owner: 'Võ Thị Lan' },
      { id: 'src-u-fee', name: 'FEEE SharePoint — Open courseware', app: 'sharepoint', account: 'acc-u-sp', kb: 'kb-u-fee', status: 'healthy', scope: ['FEEE / Open courseware'], schedule: sched('weekly', '05:30'), last: last(120, 1, 1), next: T(2), created: P(58), owner: 'Võ Thị Lan' },
      { id: 'src-u-web', name: 'ute.edu.vn — News & notices', app: 'website', account: 'acc-u-web', kb: 'kb-u-web', status: 'healthy', scope: ['ute.edu.vn/thong-bao', 'ute.edu.vn/tin-tuc'], schedule: sched('daily', '06:00'), last: last(4, 3, 1), next: T(0.8), created: P(50), owner: 'Võ Thị Lan' },
    );
    D.docs.filter(d => d.kb === 'kb-u-db').forEach(d => { d.source = 'src-u-lms-db'; });

    /* ── Existing UTE resources: type, topics, spaces, trust, summaries ── */
    const AAO = 'Academic Affairs Office', SSO = 'Student Services Office', HUNG = 'Lê Văn Hùng';
    meta({
      'du-reg-rules': { kind: 'policy', topics: ['t-registration', 't-exams', 't-graduation'], lang: 'vi', version: 3, verify: V(AAO, 40, 140), path: 'Shared drives / Academic Affairs / Published / Regulations / Academic Regulations 2024.pdf',
        summary: 'The rules every undergraduate follows: credit loads, course registration and withdrawal, grading, academic warning and graduation.',
        versions: [{ v: 3, at: P(40), by: AAO, note: 'Withdrawal now closes at the end of week 10' }, { v: 2, at: P(420), by: AAO, note: 'Credit limits for the credit-based system' }, { v: 1, at: P(800), by: AAO, note: 'First published version' }] },
      'du-reg-cal': { kind: 'calendar', topics: ['t-calendar'], verify: V(AAO, 60, 200), summary: 'Semester dates, registration windows, exam weeks and holidays for 2026–2027.', contexts: ['sp-ml', 'sp-db'] },
      'du-reg-fees': { kind: 'policy', topics: ['t-fees'], verify: V(AAO, 55, 210), summary: 'Tuition per credit by program, service fees (re-grading, transcripts) and payment deadlines.' },
      'du-reg-reg': { kind: 'guide', topics: ['t-registration'], verify: V(AAO, 75, -6), summary: 'Step-by-step course registration on the student portal, with priority windows by cohort.' },
      'du-reg-regrade': { kind: 'procedure', topics: ['t-exams'], verify: V(AAO, 120, 60), summary: 'How to request exam re-grading within 7 days, the 30,000 VND fee and what happens next.' },
      'du-reg-leave': { kind: 'procedure', topics: ['t-registration', 't-records'], verify: V(AAO, 120, 60), summary: 'Taking a leave of absence: eligibility, documents and how to return.' },
      'du-reg-grad': { kind: 'policy', topics: ['t-graduation'], verify: V(AAO, 200, -20), summary: 'Credits, English level and thesis requirements to graduate from IT programs.' },
      'du-reg-eng': { kind: 'policy', topics: ['t-graduation'], summary: 'English proficiency levels required for graduation and accepted certificates.', verify: V(AAO, 300, 30) },
      'du-reg-summer': { kind: 'policy', topics: ['t-registration'], summary: 'Draft rules for the 2027 summer term — not yet approved.' },
      'du-sso-schol': { kind: 'policy', topics: ['t-scholar'], verify: V(SSO, 30, 300), summary: 'Merit and need-based scholarships: who qualifies, amounts and how selection works each semester.' },
      'du-sso-letter': { kind: 'guide', topics: ['t-records'], verify: V(SSO, 90, 90), summary: 'Request a student status confirmation letter (for visas, banks or military deferment) and pick it up at A1-108.' },
      'du-sso-dorm': { kind: 'handbook', topics: ['t-housing'], verify: V(SSO, 70, 100), summary: 'Dormitory rules, fees, check-in and support contacts.' },
      'du-ml-syl': { kind: 'syllabus', verify: V(HUNG, 60, 120), summary: 'Learning outcomes, weekly plan, assessment weights (quizzes 20%, assignment 30%, final 50%) and policies for IT4071.' },
      'du-ml-w01': { kind: 'lecture', verify: V(HUNG, 56, 120) }, 'du-ml-w02': { kind: 'lecture', verify: V(HUNG, 49, 120), summary: 'Linear regression, the squared-error loss and gradient descent with learning-rate choices.' },
      'du-ml-w03': { kind: 'lecture', verify: V(HUNG, 42, 120) }, 'du-ml-w04': { kind: 'lecture', verify: V(HUNG, 35, 120), summary: 'L1 and L2 regularization, the bias–variance trade-off and choosing λ on validation data.' },
      'du-ml-w05': { kind: 'lecture', verify: V(HUNG, 28, 120) }, 'du-ml-w06': { kind: 'lecture', verify: V(HUNG, 21, 120) }, 'du-ml-w07': { kind: 'lecture', verify: V(HUNG, 14, 120) },
      'du-ml-a1': { kind: 'assignment', verify: V(HUNG, 12, 60), summary: 'Predict house prices with linear regression: data, deliverables, grading rubric and the deadline.' },
      'du-ml-lab2': { kind: 'lab', summary: 'Implement batch gradient descent in NumPy and compare learning rates.', contexts: ['sp-agri'] },
      'du-db-syl': { kind: 'syllabus', verify: V(HUNG, 60, 120) }, 'du-db-w03': { kind: 'lecture', verify: V(HUNG, 42, 120) }, 'du-db-w05': { kind: 'lecture', verify: V(HUNG, 28, 120) },
      'du-db-w07': { kind: 'lecture', verify: V(HUNG, 14, 120), summary: 'Functional dependencies and normal forms from 1NF to BCNF, with decomposition examples.' },
      'du-db-lab3': { kind: 'lab', summary: 'Practice inner, outer and self joins on the course PostgreSQL server.' },
      'du-db-past': { kind: 'exam', verify: V(HUNG, 30, 300), summary: 'Last year’s midterm with worked solutions.' },
      'du-ag-p1': { kind: 'paper', topics: ['t-cropdisease', 't-ml'], verify: V('Smart Agriculture Lab', 18), summary: 'Fine-tunes ImageNet models on 4,200 Mekong rice-leaf images; best F1 0.91 on field data.' },
      'du-ag-p2': { kind: 'paper', topics: ['t-cropdisease', 't-ml'], verify: V('Smart Agriculture Lab', 40), summary: 'Survey of 120 deep-learning studies on crop disease detection and their evaluation gaps.' },
      'du-ag-p3': { kind: 'paper', topics: ['t-irrigation', 't-iot'], verify: V('Smart Agriculture Lab', 25), summary: 'TinyML soil-moisture prediction on ESP32 cuts irrigation water by 23% in field trials.' },
      'du-ag-p4': { kind: 'paper', topics: ['t-irrigation', 't-iot'], verify: V('Smart Agriculture Lab', 90), summary: 'LoRaWAN duty-cycling that keeps paddy sensors running for a full season on one battery.' },
      'du-ag-p5': { kind: 'paper', topics: ['t-cropdisease', 't-ml'], verify: V('Smart Agriculture Lab', 10), summary: 'Vision transformers stay accurate under field lighting where CNNs drop up to 14 points.' },
      'du-ag-p6': { kind: 'paper', topics: ['t-cropdisease', 't-sensing'] },
      'du-ag-proto': { kind: 'protocol', topics: ['t-irrigation'], verify: V('Trương Quốc Bảo', 33, 300), summary: 'Two-point calibration of capacitive soil sensors before each season.' },
      'du-ag-data': { kind: 'dataset', topics: ['t-cropdisease', 't-ethics'], summary: 'UTE-RiceLeaf v2: 6,800 labelled leaf images, collection protocol and licence.' },
      'du-gr-naf': { kind: 'policy', topics: ['t-grants'], verify: V('Science & Technology Office', 6, 180), summary: 'Eligibility, budget caps and the internal deadline for the NAFOSTED 2027 basic research call.' },
      'du-gr-tpl': { kind: 'template', topics: ['t-grants'], verify: V('Science & Technology Office', 6, 180) },
      'du-gr-pub': { kind: 'policy', topics: ['t-publishing'], verify: V('Science & Technology Office', 80, -10), summary: 'Rewards for Scopus/ISI publications and how to claim them.' },
    });

    /* ── Course syllabi from the LMS (one per course; IT4071/IT3090 duplicate the course copies) ── */
    const FAC = { IT: 'Faculty of IT', ME: 'Faculty of Mechanical Engineering', EE: 'Faculty of Electrical & Electronics Engineering', GE: 'Faculty of Applied Sciences', AG: 'Faculty of Chemical & Food Technology' };
    const COURSES = [
      ['IT1010', 'Introduction to Programming', 't-se'], ['IT2001', 'Data Structures & Algorithms', 't-se'], ['IT2030', 'Object-Oriented Programming', 't-se'], ['IT3010', 'Operating Systems', 't-net'],
      ['IT3030', 'Computer Networks', 't-net'], ['IT3090', 'Database Systems', 't-db'], ['IT3100', 'Software Engineering', 't-se'], ['IT3120', 'Web Programming', 't-se'],
      ['IT4071', 'Machine Learning', 't-ml'], ['IT4080', 'Deep Learning', 't-ml'], ['IT4090', 'Natural Language Processing', 't-ml'], ['IT4110', 'Information Security', 't-net'],
      ['IT4130', 'Cloud Computing', 't-net'], ['IT4150', 'Data Mining', 't-db'], ['IT4170', 'Big Data Systems', 't-db'], ['IT4190', 'Computer Vision', 't-ml'],
      ['ME2011', 'Engineering Mechanics', 't-mech'], ['ME2030', 'Thermodynamics', 't-mech'], ['ME3020', 'Machine Design', 't-mech'], ['ME3045', 'CNC Programming', 't-mech'],
      ['ME3060', 'Fluid Mechanics', 't-mech'], ['ME4050', 'Robotics', 't-mech'], ['ME4070', 'Mechatronics', 't-iot'],
      ['EE2001', 'Circuit Analysis', 't-elec'], ['EE2020', 'Signals & Systems', 't-elec'], ['EE3012', 'Microcontrollers', 't-iot'], ['EE3040', 'Embedded Systems & IoT', 't-iot'],
      ['EE3060', 'Control Engineering', 't-elec'], ['EE4025', 'Power Electronics', 't-elec'], ['EE4040', 'Renewable Energy Systems', 't-elec'],
      ['GE1010', 'Calculus 1', 't-foundation'], ['GE1020', 'Linear Algebra', 't-foundation'], ['GE1030', 'Physics 1', 't-foundation'], ['GE1050', 'Academic English 1', 't-foundation'],
      ['GE1060', 'Engineering Drawing', 't-foundation'], ['GE2010', 'Probability & Statistics', 't-foundation'], ['AG3010', 'Precision Agriculture', 't-irrigation'], ['AG3030', 'Remote Sensing for Agriculture', 't-sensing'],
    ];
    COURSES.forEach(([code, name, topic], i) => {
      const fac = FAC[code.slice(0, 2)];
      const d = mkDoc('kb-u-cat', 'du-cat-' + code.toLowerCase(), `Syllabus — ${code} ${name}.pdf`, { source: 'src-u-cat', addedBy: fac, pages: 4 + (i % 5), updated: P(20 + (i * 7) % 120) });
      Object.assign(d, {
        kind: 'syllabus', topics: [topic], owner: fac, views: views(), path: `UTEx LMS / ${code} / Syllabus`,
        summary: `Approved syllabus for ${code} ${name}: learning outcomes, weekly topics, assessment and required readings.`,
        verify: V(fac, 20 + (i * 7) % 120, i % 9 === 4 ? -15 : 160),
        ...(code === 'IT4071' ? { contexts: ['sp-ml'], dupOf: 'du-ml-syl', dupReason: 'Same course syllabus in two knowledge bases' } : code === 'IT3090' ? { contexts: ['sp-db'], dupOf: 'du-db-syl', dupReason: 'Same course syllabus in two knowledge bases' } : {}),
      });
      D.docs.push(d);
    });

    /* ── Theses from the digital library ── */
    const AUTHORS = ['Trần Quốc Bảo', 'Lê Thị Mai', 'Nguyễn Hoàng Phúc', 'Phạm Gia Hân', 'Võ Minh Khang', 'Đặng Thu Trang', 'Huỳnh Tấn Lộc', 'Bùi Ngọc Ánh', 'Hồ Đức Thịnh', 'Ngô Bảo Châu', 'Lý Thanh Tùng', 'Mai Khánh Linh'];
    const THESES = [
      ['t-ml', 'Vietnamese question answering over university regulations with retrieval-augmented generation'], ['t-ml', 'Predicting student dropout from learning-management-system logs'],
      ['t-ml', 'Fine-tuning PhoBERT for sentiment analysis of course feedback'], ['t-ml', 'Explainable credit scoring with gradient-boosted trees'],
      ['t-ml', 'Detecting misinformation in Vietnamese social media with transformers'], ['t-ml', 'Handwritten Vietnamese text recognition with CRNN'],
      ['t-ml', 'Forecasting electricity demand in Ho Chi Minh City with temporal fusion transformers'], ['t-ml', 'Few-shot traffic sign recognition for Vietnamese roads'],
      ['t-ml', 'Speech recognition for Southern Vietnamese accents'], ['t-ml', 'Recommending elective courses from transcripts'],
      ['t-db', 'A data warehouse for academic performance analytics'], ['t-db', 'Query optimization for large student information databases'],
      ['t-db', 'Graph databases for curriculum prerequisite analysis'], ['t-se', 'Timetable scheduling with constraint programming'],
      ['t-se', 'Migrating a university portal to microservices: a case study'], ['t-se', 'Automated test generation for REST APIs'],
      ['t-se', 'Detecting code clones in student programming assignments'], ['t-se', 'Event sourcing for course registration under peak load'],
      ['t-net', 'Federated intrusion detection for campus networks'], ['t-net', 'Phishing detection for university mailboxes'],
      ['t-net', 'Securing IoT devices in smart classrooms'], ['t-net', 'Wi-Fi 6 performance in dense lecture halls'], ['t-net', 'Blockchain-based verification of academic certificates'],
      ['t-iot', 'Low-power LoRaWAN nodes for urban flood monitoring'], ['t-iot', 'Smart energy metering for student dormitories'], ['t-elec', 'FPGA acceleration of convolutional neural networks'],
      ['t-elec', 'Battery management for electric motorbikes'], ['t-iot', 'Solar-powered water-quality monitoring for aquaculture'], ['t-iot', 'Embedded vision for defect detection on production lines'],
      ['t-mech', 'Design and control of a 6-DOF arm for pick-and-place'], ['t-mech', 'Topology optimization of 3D-printed brackets'], ['t-mech', 'Vibration analysis of CNC spindles'],
      ['t-mech', 'An autonomous guided vehicle for warehouse logistics'], ['t-mech', 'Thermal design of electric-vehicle battery packs'], ['t-mech', 'A digital twin of a CNC milling cell'],
      ['t-sensing', 'Drone-based rice yield estimation in the Mekong Delta'], ['t-irrigation', 'Soil-moisture prediction for precision irrigation'], ['t-cropdisease', 'A mobile app for durian leaf disease diagnosis'],
      ['t-sensing', 'Forecasting saltwater intrusion with Sentinel-2 imagery'], ['t-irrigation', 'IoT climate control for greenhouse lettuce'], ['t-cropdisease', 'Early detection of rice blast from smartphone photos'],
      ['t-ml', 'Shrimp-pond water-quality prediction with LSTM networks'],
    ];
    THESES.forEach(([topic, title], i) => {
      const year = 2019 + (i * 3) % 8, master = i % 4 === 0, author = AUTHORS[i % AUTHORS.length];
      const d = mkDoc('kb-u-lib', 'du-th-' + (i + 1), `${title} — ${master ? 'MSc' : 'BEng'} thesis ${year}.pdf`, { source: 'src-u-lib', addedBy: 'University Library', pages: master ? 80 + (i % 40) : 50 + (i % 30), updated: P(30 + i * 9) });
      Object.assign(d, {
        kind: 'thesis', topics: [topic], owner: 'University Library', views: views(), lang: i % 5 === 2 ? 'vi' : 'en', path: `Theses / ${master ? 'Master' : 'Bachelor'} / ${year}`,
        summary: `${master ? 'Master’s' : 'Bachelor’s'} thesis by ${author} (${year}). ${title}.`, author, year,
        verify: V('University Library', 30 + i * 9),
      });
      D.docs.push(d);
    });
    const lit = THESES.findIndex(t => /rice blast/.test(t[1]));
    D.docs.find(d => d.id === 'du-th-' + (lit + 1)).contexts = ['sp-agri'];

    /* ── Open courseware (two faculties) ── */
    const OCW = {
      'kb-u-fme': ['src-u-fme', 'Faculty of Mechanical Engineering', [
        ['ME3020', 't-mech', ['Lecture 1 — Design process and safety factors', 'Lecture 4 — Shafts and keys', 'Lecture 7 — Gears and gear trains']],
        ['ME3045', 't-mech', ['Lecture 2 — G-code fundamentals', 'Lecture 5 — Tool-path strategies', 'Lab guide — Milling a pocket on the HAAS VF-2']],
        ['ME4050', 't-mech', ['Lecture 3 — Forward kinematics', 'Lecture 6 — Inverse kinematics', 'Lab guide — Programming the ABB IRB 120']],
        ['ME4070', 't-iot', ['Lecture 2 — Sensors and actuators', 'Lecture 5 — PLC programming', 'Lab guide — Conveyor sorting with a PLC']],
      ], [['Workshop safety rules.pdf', 'policy', 't-mech'], ['Workshop booking procedure.pdf', 'procedure', 't-mech'], ['Capstone project handbook — FME.pdf', 'handbook', 't-graduation'], ['Internship guide — FME.pdf', 'guide', 't-graduation']]],
      'kb-u-fee': ['src-u-fee', 'Faculty of Electrical & Electronics Engineering', [
        ['EE2001', 't-elec', ['Lecture 1 — Ohm’s and Kirchhoff’s laws', 'Lecture 4 — Thevenin and Norton equivalents', 'Lecture 6 — AC steady state']],
        ['EE3012', 't-iot', ['Lecture 2 — STM32 architecture', 'Lecture 5 — Interrupts and timers', 'Lab guide — UART and I2C sensors']],
        ['EE3040', 't-iot', ['Lecture 3 — MQTT and edge gateways', 'Lecture 6 — Low-power design', 'Lab guide — ESP32 soil-moisture node']],
        ['EE4025', 't-elec', ['Lecture 2 — DC–DC converters', 'Lecture 5 — Inverters', 'Lab guide — Buck converter efficiency']],
      ], [['Electrical lab safety rules.pdf', 'policy', 't-elec'], ['Lab equipment loan form.docx', 'form', 't-elec'], ['Capstone project handbook — FEEE.pdf', 'handbook', 't-graduation']]],
    };
    Object.entries(OCW).forEach(([kb, [src, unit, courses, extra]]) => {
      let n = 0;
      courses.forEach(([code, topic, titles]) => titles.forEach(t => {
        const lab = /^Lab guide/.test(t), d = mkDoc(kb, `du-${kb.slice(5)}-${++n}`, `${code} ${t}.pdf`, { source: src, addedBy: unit, pages: lab ? 8 : 30 + (n % 20), updated: P(10 + n * 6) });
        Object.assign(d, { kind: lab ? 'lab' : 'lecture', topics: [topic], views: views(), verify: n % 4 ? V(unit, 10 + n * 6, 150) : undefined });
        D.docs.push(d);
      }));
      extra.forEach(([name, kind, topic]) => { const d = mkDoc(kb, `du-${kb.slice(5)}-${++n}`, name, { source: src, addedBy: unit, pages: 6, updated: P(40 + n * 5) }); Object.assign(d, { kind, topics: [topic], views: views(), verify: V(unit, 40 + n * 5, n % 3 ? 120 : -8) }); D.docs.push(d); });
    });

    /* ── News & notices from the website (some untagged, some in Vietnamese) ── */
    const NOTICES = [
      ['Notice — Course registration for Semester 2 opens December 1.html', 't-registration', 'en', 3], ['Notice — Exam schedule for Semester 1, 2026–2027.html', 't-exams', 'en', 6],
      ['Thông báo — Lịch thi học kỳ 1 năm học 2026–2027.html', 't-exams', 'vi', 6], ['Notice — Tuition payment deadline for Semester 1.html', 't-fees', 'en', 20],
      ['Thông báo — Hạn nộp học phí học kỳ 1.html', 't-fees', 'vi', 20], ['Scholarship results — Semester 2, 2025–2026.html', 't-scholar', 'en', 60],
      ['Notice — Dormitory registration for Semester 2.html', 't-housing', 'en', 9], ['Notice — Graduation ceremony, December 2026.html', 't-graduation', 'en', 12],
      ['Thông báo — Xét tốt nghiệp đợt tháng 12 năm 2026.html', 't-graduation', 'vi', 12], ['Notice — English placement test, week 11.html', 't-graduation', 'en', 4],
      ['Notice — Library opening hours during exams.html', null, 'en', 2], ['News — UTE robotics team wins national final.html', null, 'en', 15],
      ['News — Smart Agriculture Lab opens Mekong field station.html', 't-sensing', 'en', 25], ['Notice — Campus Wi-Fi maintenance on Saturday.html', null, 'en', 1],
      ['Thông báo — Bảo trì hệ thống Wi-Fi.html', null, 'vi', 1], ['Notice — Mental health week activities.html', 't-wellbeing', 'en', 8],
      ['Notice — Student status letters now issued in 2 days.html', 't-records', 'en', 30], ['News — New partnership with Bosch Vietnam for internships.html', null, 'en', 35],
      ['Notice — Research week call for student posters.html', 't-publishing', 'en', 18], ['Thông báo — Tuần lễ nghiên cứu khoa học sinh viên.html', 't-publishing', 'vi', 18],
      ['Academic calendar 2026–2027 (website copy).html', 't-calendar', 'en', 64], ['Notice — Parking changes near building A5.html', null, 'en', 6],
    ];
    NOTICES.forEach(([name, topic, lang, days], i) => {
      const d = mkDoc('kb-u-web', 'du-web-' + (i + 1), name, { source: 'src-u-web', addedBy: 'ute.edu.vn', pages: 1, size: 18e3 + i * 900, updated: P(days, i % 5) });
      Object.assign(d, { kind: name.startsWith('Academic calendar') ? 'calendar' : 'announcement', views: views(), lang, path: `ute.edu.vn / ${lang === 'vi' ? 'thong-bao' : 'news'} / ${i + 1}`, ...(topic ? { topics: [topic] } : {}),
        ...(name.startsWith('Academic calendar') ? { dupOf: 'du-reg-cal', dupReason: '96% the same text as the published calendar' } : {}) });
      D.docs.push(d);
    });

    /* ── More lab papers (research library) ── */
    const PAPERS = [
      ['Zhang et al. 2023 — Lightweight CNNs for on-device plant disease detection.pdf', ['t-cropdisease', 't-ml'], 'MobileNet variants reach 93% accuracy on phones with under 50 ms latency.'],
      ['Pham & Vo 2022 — Sentinel-2 indices for rice growth monitoring in An Giang.pdf', ['t-sensing'], 'NDVI and NDRE time series track rice growth stages with R² 0.82.'],
      ['Kumar et al. 2024 — Explainable AI for crop disease diagnosis.pdf', ['t-cropdisease', 't-ml'], 'Grad-CAM explanations raise agronomist trust but expose shortcut learning.'],
      ['Nguyen & Tran 2025 — Federated learning across smallholder farms.pdf', ['t-ml', 't-ethics'], 'Federated training keeps farm images local with a 2-point accuracy cost.'],
      ['Lab protocol — Leaf image collection in the field.docx', ['t-cropdisease', 't-ethics'], 'Camera settings, lighting and consent rules for collecting leaf images.'],
      ['Lab meeting notes — October 2026.md', ['t-cropdisease'], ''],
    ];
    PAPERS.forEach(([name, topics, summary], i) => {
      const d = mkDoc('kb-u-agri', 'du-ag-x' + (i + 1), name, { addedBy: i % 2 ? 'Trương Quốc Bảo' : 'Phạm Thu Hà', pages: name.endsWith('.md') ? 2 : 10 + i * 2, updated: P(5 + i * 11) });
      Object.assign(d, { topics, views: views(), ...(summary ? { summary } : {}), ...(name.endsWith('.pdf') ? { verify: V('Smart Agriculture Lab', 5 + i * 11) } : {}) });
      D.docs.push(d);
    });

    D.docs.forEach(d => { if (d.views == null && d.kb !== 'kb-u-mine') d.views = views(); });
    ['du-reg-rules', 'du-reg-cal', 'du-ml-w04', 'du-ml-a1', 'du-reg-regrade', 'du-sso-schol'].forEach((id, i) => { const d = D.docs.find(x => x.id === id); if (d) d.views = 1200 - i * 140; });

    /* ── Collections, saved, recent, views ── */
    D.collections = [
      { id: 'col-u-new', name: 'New student essentials', desc: 'What first-year students ask about most. Start here.', owner: 'u-ute-ngoc', share: 'workspace', featured: true, created: P(60), updated: P(3),
        items: [{ doc: 'du-reg-rules', note: 'Credit limits and withdrawal rules.' }, { doc: 'du-reg-cal' }, { doc: 'du-reg-reg', note: 'Registration opens by cohort — check your window.' }, { doc: 'du-reg-fees' }, { doc: 'du-sso-schol' }, { doc: 'du-sso-dorm' }, { doc: 'du-sso-letter' }] },
      { id: 'col-u-mlprep', name: 'IT4071 midterm prep', desc: 'Everything on the midterm, in the order we covered it.', owner: 'u-ute-hung', share: 'space:sp-ml', featured: true, created: P(10), updated: P(1),
        items: [{ doc: 'du-ml-syl', note: 'Assessment weights are on page 2.' }, { doc: 'du-ml-w02' }, { doc: 'du-ml-lab2', note: 'Make sure you can do this without notes.' }, { doc: 'du-ml-w03' }, { doc: 'du-ml-w04', note: 'Most-missed topic in the Week 4 quiz.' }, { doc: 'du-ml-w05' }, { doc: 'du-ml-w07' }] },
      { id: 'col-u-rice', name: 'Rice disease detection — core papers', desc: 'The papers our review and NAFOSTED proposal build on.', owner: 'u-ute-ha', share: 'space:sp-agri', created: P(30), updated: P(2),
        items: [{ doc: 'du-ag-p1', note: 'Our baseline.' }, { doc: 'du-ag-p2' }, { doc: 'du-ag-p5' }, { doc: 'du-ag-x1' }, { doc: 'du-ag-x3' }, { doc: 'du-ag-data', note: 'Cite the dataset card, not the paper.' }] },
      { id: 'col-u-grant', name: 'NAFOSTED 2027 application kit', desc: 'Call, template and the rules we need to follow.', owner: 'u-ute-ha', share: 'private', created: P(6), updated: P(6),
        items: [{ doc: 'du-gr-naf' }, { doc: 'du-gr-tpl' }, { doc: 'du-gr-pub' }] },
      { id: 'col-u-thesis', name: 'Thesis ideas', desc: '', owner: 'u-ute-anh', share: 'private', created: P(12), updated: P(2),
        items: [{ doc: 'du-th-1', note: 'Close to what I want — RAG over regulations.' }, { doc: 'du-th-2' }, { doc: 'du-th-10' }, { doc: 'du-ml-w06' }] },
    ];
    D.saved = { 'u-ute-anh': ['du-ml-w04', 'du-reg-rules', 'du-ml-a1', 'du-th-1'], 'u-ute-hung': ['du-ml-syl', 'du-reg-regrade', 'du-web-21'], 'u-ute-ha': ['du-ag-p1', 'du-ag-p5', 'du-gr-naf'], 'u-ute-lan': ['du-reg-rules', 'du-reg-summer'] };
    D.recent = {
      'u-ute-anh': [{ doc: 'du-ml-w04', at: P(0, 2) }, { doc: 'du-reg-rules', at: P(1) }, { doc: 'du-ml-a1', at: P(2) }, { doc: 'du-db-lab3', at: P(3) }, { doc: 'du-th-1', at: P(5) }],
      'u-ute-hung': [{ doc: 'du-ml-w05', at: P(0, 3) }, { doc: 'du-db-w07', at: P(1) }, { doc: 'du-ml-syl', at: P(4) }],
      'u-ute-ha': [{ doc: 'du-ag-p5', at: P(0, 1) }, { doc: 'du-gr-naf', at: P(0, 20) }, { doc: 'du-ag-p1', at: P(2) }],
      'u-ute-lan': [{ doc: 'du-reg-summer', at: P(0, 1) }, { doc: 'du-reg-eng', at: P(0, 6) }],
    };
    D.views = {
      'u-ute-anh': [{ id: 'vw-u-1', name: 'Machine learning theses', query: 'topic=t-ml&kind=thesis', created: P(5) }],
      'u-ute-ha': [{ id: 'vw-u-2', name: 'Crop disease papers', query: 'topic=t-cropdisease&kind=paper&sort=updated', created: P(14) }],
      'u-ute-lan': [{ id: 'vw-u-3', name: 'Policies due for review', query: 'kind=policy&trust=review', created: P(20) }],
    };
    D.dupDismissed = [];
  });
})();
