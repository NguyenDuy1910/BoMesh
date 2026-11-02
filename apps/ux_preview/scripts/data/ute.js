'use strict';
/* UTE Campus — a university workspace on the Campus template.
   Same platform records as Northwind (knowledge, people, sources, chats) plus
   the Campus modules: spaces (courses, research groups, offices), events,
   work (quizzes, study guides, literature reviews, drafts) and requests.
   "Now" is week 9 of Semester 1, 2026–2027. */

/* ═══════════════ Personas (demo people) ═══════════════ */
Object.assign(PERSONAS, {
  student: {
    id: 'u-ute-anh', name: 'Nguyễn Minh Anh', email: '22110101@student.ute.edu.vn', role: 'Student · Information Technology', label: 'Student',
    perms: ['tenant.read', 'knowledge.read'], workspaces: ['ws-ute'],
    profile: {
      studentId: '22110101', program: 'Information Technology', cohort: 'K22', year: 3, advisor: 'Lê Văn Hùng',
      credits: 18, gpa: 3.21,
      courses: [['IT4071', 'Machine Learning', 3, 'sp-ml'], ['IT3090', 'Database Systems', 3, 'sp-db'], ['IT3120', 'Software Engineering', 3], ['IT3150', 'Computer Networks', 3], ['MA2010', 'Probability & Statistics', 3], ['EN2030', 'Academic English 3', 3]],
    },
  },
  lecturer: { id: 'u-ute-hung', name: 'Lê Văn Hùng', email: 'hunglv@ute.edu.vn', role: 'Lecturer · Faculty of IT', label: 'Lecturer', perms: ['tenant.read', 'knowledge.read', 'knowledge.manage', 'ingestion.read', 'ingestion.run'], workspaces: ['ws-ute'] },
  researcher: { id: 'u-ute-ha', name: 'Phạm Thu Hà', email: 'hapt@ute.edu.vn', role: 'Researcher · Smart Agriculture Lab', label: 'Researcher', perms: ['tenant.read', 'knowledge.read', 'knowledge.manage', 'ingestion.read', 'ingestion.run'], workspaces: ['ws-ute'] },
  staff: { id: 'u-ute-lan', name: 'Võ Thị Lan', email: 'lanvt@ute.edu.vn', role: 'Academic Affairs · Workspace admin', label: 'Admin', perms: ALL_TENANT, workspaces: ['ws-ute'] },
});

/* ═══════════════ Workspace record (platform) ═══════════════ */
(() => {
  const ute = { id: 'ws-ute', name: 'UTE Campus', code: 'ute', color: '#1F5FAD', members: 12840, docs: 6315, status: 'active', created: ago(95 * DAY), owner: 'Võ Thị Lan', questions30: 48210, template: 'campus', demo: 'Fictional records made for this prototype. They are not official UTE documents or policies.' };
  D.workspaces.push(ute);
  D.pWorkspaces.splice(2, 0, ute);
})();

seedWorkspace('ws-ute', () => {
  const T = (d, h = 0) => NOW + d * DAY + h * HOUR;   // future
  const P = (d, h = 0) => NOW - d * DAY - h * HOUR;   // past
  const EOD = d => { const t = new Date(NOW); t.setHours(23, 59, 0, 0); return t.getTime() + d * DAY; };  // 23:59 in d days

  /* ═══════════════ People ═══════════════ */
  D.roles = [
    { id: 'r-admin', name: 'Workspace admin', system: true, desc: 'Full control of this workspace.', perms: ALL_TENANT },
    { id: 'r-student', name: 'Student', system: true, desc: 'Ask questions, study with course materials and send requests.', perms: ['tenant.read', 'knowledge.read'] },
    { id: 'r-lecturer', name: 'Lecturer', system: false, desc: 'Runs courses: materials, quizzes and student questions.', perms: ['tenant.read', 'knowledge.read', 'knowledge.manage', 'ingestion.read', 'ingestion.run'] },
    { id: 'r-researcher', name: 'Researcher', system: false, desc: 'Keeps a research library, reviews and drafts.', perms: ['tenant.read', 'knowledge.read', 'knowledge.manage', 'ingestion.read', 'ingestion.run'] },
    { id: 'r-office', name: 'Office staff', system: false, desc: 'Handles requests for an office and keeps its procedures current.', perms: ['tenant.read', 'knowledge.read', 'knowledge.manage', 'audit.read'] },
  ];
  D.groups = [
    { id: 'g-fit', name: 'Faculty of IT', desc: 'Lecturers and staff of the Faculty of Information Technology.' },
    { id: 'g-k22', name: 'IT students · K22', desc: 'Information Technology, cohort 2022.' },
    { id: 'g-agri', name: 'Smart Agriculture Lab', desc: 'Researchers and students of the IoT & AI for agriculture lab.' },
    { id: 'g-aao', name: 'Academic Affairs Office', desc: 'Registration, exams, transcripts and academic records.' },
    { id: 'g-sso', name: 'Student Services Office', desc: 'Scholarships, student status letters and support.' },
  ];
  D.members = [
    ['u-ute-lan', 'Võ Thị Lan', 'lanvt@ute.edu.vn', 'r-admin', ['g-aao'], 4 * MIN, 95],
    ['u-ute-hung', 'Lê Văn Hùng', 'hunglv@ute.edu.vn', 'r-lecturer', ['g-fit', 'g-agri'], 20 * MIN, 90],
    ['u-ute-ha', 'Phạm Thu Hà', 'hapt@ute.edu.vn', 'r-researcher', ['g-agri', 'g-fit'], 1 * HOUR, 88],
    ['u-ute-bao', 'Trương Quốc Bảo', 'baotq@ute.edu.vn', 'r-researcher', ['g-agri', 'g-fit'], 5 * HOUR, 90],
    ['u-ute-thao', 'Đỗ Phương Thảo', 'thaodp@ute.edu.vn', 'r-lecturer', ['g-fit'], 2 * HOUR, 85],
    ['u-ute-quan', 'Huỳnh Minh Quân', 'quanhm@ute.edu.vn', 'r-office', ['g-aao'], 30 * MIN, 80],
    ['u-ute-ngoc', 'Lâm Bảo Ngọc', 'ngoclb@ute.edu.vn', 'r-office', ['g-sso'], 3 * HOUR, 80],
    ['u-ute-anh', 'Nguyễn Minh Anh', '22110101@student.ute.edu.vn', 'r-student', ['g-k22'], 6 * MIN, 60],
    ['u-ute-huy', 'Đặng Quốc Huy', '22110145@student.ute.edu.vn', 'r-student', ['g-k22'], 50 * MIN, 60],
    ['u-ute-vy', 'Trần Thảo Vy', '22110187@student.ute.edu.vn', 'r-student', ['g-k22'], 2 * HOUR, 60],
    ['u-ute-khoa', 'Phan Đăng Khoa', '22110033@student.ute.edu.vn', 'r-student', ['g-k22'], 9 * HOUR, 60],
    ['u-ute-linh', 'Bùi Gia Linh', '22110260@student.ute.edu.vn', 'r-student', ['g-k22', 'g-agri'], 1 * DAY, 60],
    ['u-ute-tam', 'Võ Thanh Tâm', '21110412@student.ute.edu.vn', 'r-student', [], 3 * DAY, 420],
    ['u-ute-son', 'Ngô Hoàng Sơn', '22110311@student.ute.edu.vn', 'r-student', ['g-k22'], 26 * DAY, 60, 'suspended'],
  ].map(([id, name, email, roleId, groups, last, joinedDays, status = 'active']) => ({ id, name, email, roleId, groups, status, lastActive: ago(last), joined: ago(joinedDays * DAY) }));
  D.knownAccounts = ['22110402@student.ute.edu.vn', 'minhtd@ute.edu.vn', 'hoanglt@ute.edu.vn'];

  /* ═══════════════ Knowledge ═══════════════
     access = role each demo persona holds: owner|editor|viewer|none (visible, locked)|null (hidden). */
  D.kbs = [
    { id: 'kb-u-mine', name: 'My files', personal: true, desc: 'Only you can see these. Use them in your own chats and work.', color: '#4F5865', general: 'private', shares: [], updated: P(1) },
    { id: 'kb-u-regs', name: 'Academic regulations & procedures', desc: 'Regulations, academic calendar, fees and how-to guides from Academic Affairs.', color: '#1F5FAD', general: 'workspace', access: { student: 'viewer', lecturer: 'viewer', researcher: 'viewer' }, shares: [{ kind: 'group', id: 'g-aao', role: 'owner' }], updated: P(0, 5), space: 'sp-aao' },
    { id: 'kb-u-sso', name: 'Student services', desc: 'Scholarships, student status letters, dormitory and wellbeing.', color: '#B4467A', general: 'workspace', access: { student: 'viewer', lecturer: 'viewer', researcher: 'viewer' }, shares: [{ kind: 'group', id: 'g-sso', role: 'owner' }], updated: P(3), space: 'sp-sso' },
    { id: 'kb-u-ml', name: 'Machine Learning · IT4071', desc: 'Slides, labs and readings for Machine Learning, Semester 1 2026–2027.', color: '#2F6FB5', general: 'restricted', access: { student: 'viewer', lecturer: 'owner', researcher: 'editor' }, shares: [{ kind: 'user', id: 'u-ute-hung', role: 'owner' }, { kind: 'user', id: 'u-ute-ha', role: 'editor' }], updated: P(1, 3), space: 'sp-ml' },
    { id: 'kb-u-db', name: 'Database Systems · IT3090', desc: 'Slides, SQL labs and past exams for Database Systems.', color: '#0E7C66', general: 'restricted', access: { student: 'viewer', lecturer: 'owner', researcher: null }, shares: [{ kind: 'user', id: 'u-ute-hung', role: 'owner' }], updated: P(2), space: 'sp-db' },
    { id: 'kb-u-agri', name: 'Smart Agriculture Lab · Library', desc: 'Papers, protocols and datasets of the lab.', color: '#4E6B2E', general: 'restricted', access: { student: null, lecturer: 'viewer', researcher: 'owner' }, shares: [{ kind: 'group', id: 'g-agri', role: 'editor' }, { kind: 'user', id: 'u-ute-bao', role: 'owner' }], updated: P(0, 2), space: 'sp-agri' },
    { id: 'kb-u-grants', name: 'Research & grants', desc: 'Funding calls, grant templates and publication policies.', color: '#6B4FBF', general: 'restricted', access: { student: 'none', lecturer: 'viewer', researcher: 'viewer' }, shares: [{ kind: 'group', id: 'g-fit', role: 'viewer' }], updated: P(6) },
  ];
  const doc = (kb, id, name, o = {}) => mkDoc(kb, id, name, { addedBy: o.addedBy || 'Academic Affairs Office', ...o });
  D.docs = [
    doc('kb-u-mine', 'du-me-1', 'My notes — Week 2 regression.md', { addedBy: 'You', updated: P(5), pages: 3 }),
    doc('kb-u-mine', 'du-me-2', 'CV — Nguyen Minh Anh.pdf', { addedBy: 'You', updated: P(20), pages: 2 }),

    doc('kb-u-regs', 'du-reg-rules', 'Academic Regulations 2024.pdf', { source: 'src-u-regs', pages: 46, size: 2.1e6, updated: P(40), passages: 288 }),
    doc('kb-u-regs', 'du-reg-cal', 'Academic Calendar 2026–2027.pdf', { source: 'src-u-regs', pages: 4, size: 380e3, updated: P(60), passages: 31 }),
    doc('kb-u-regs', 'du-reg-fees', 'Tuition & Fees 2026–2027.pdf', { source: 'src-u-regs', pages: 8, size: 610e3, updated: P(55), passages: 52 }),
    doc('kb-u-regs', 'du-reg-reg', 'Course Registration Guide — Semester 1.pdf', { source: 'src-u-regs', pages: 12, updated: P(75) }),
    doc('kb-u-regs', 'du-reg-regrade', 'Exam Re-grading Procedure.pdf', { source: 'src-u-regs', pages: 3, updated: P(120) }),
    doc('kb-u-regs', 'du-reg-leave', 'Leave of Absence Procedure.pdf', { source: 'src-u-regs', pages: 4, updated: P(120) }),
    doc('kb-u-regs', 'du-reg-grad', 'Graduation Requirements — IT programs.pdf', { source: 'src-u-regs', pages: 9, updated: P(200) }),
    doc('kb-u-regs', 'du-reg-eng', 'English Proficiency Requirement.pdf', { source: 'src-u-regs', pages: 5, updated: P(0, 6), status: 'outdated' }),
    doc('kb-u-regs', 'du-reg-summer', 'Summer Term 2027 — Draft rules.docx', { addedBy: 'Huỳnh Minh Quân', pages: 6, updated: P(0, 1), status: 'pending' }),

    doc('kb-u-sso', 'du-sso-schol', 'Scholarship Policy 2026.pdf', { addedBy: 'Student Services Office', pages: 10, updated: P(30) }),
    doc('kb-u-sso', 'du-sso-letter', 'Student Status Confirmation — How to request.pdf', { addedBy: 'Student Services Office', pages: 2, updated: P(90) }),
    doc('kb-u-sso', 'du-sso-dorm', 'Dormitory Handbook 2026.pdf', { addedBy: 'Student Services Office', pages: 18, updated: P(70) }),

    doc('kb-u-ml', 'du-ml-syl', 'Syllabus — IT4071 Machine Learning.pdf', { source: 'src-u-fit', addedBy: 'Lê Văn Hùng', pages: 6, updated: P(60) }),
    doc('kb-u-ml', 'du-ml-w01', 'W01 — Introduction to machine learning.pdf', { source: 'src-u-fit', addedBy: 'Lê Văn Hùng', pages: 34, updated: P(56) }),
    doc('kb-u-ml', 'du-ml-w02', 'W02 — Linear regression & gradient descent.pdf', { source: 'src-u-fit', addedBy: 'Lê Văn Hùng', pages: 41, updated: P(49) }),
    doc('kb-u-ml', 'du-ml-w03', 'W03 — Logistic regression.pdf', { source: 'src-u-fit', addedBy: 'Lê Văn Hùng', pages: 38, updated: P(42) }),
    doc('kb-u-ml', 'du-ml-w04', 'W04 — Regularization & the bias–variance trade-off.pdf', { source: 'src-u-fit', addedBy: 'Lê Văn Hùng', pages: 36, updated: P(35) }),
    doc('kb-u-ml', 'du-ml-w05', 'W05 — Decision trees & ensembles.pdf', { source: 'src-u-fit', addedBy: 'Lê Văn Hùng', pages: 44, updated: P(28) }),
    doc('kb-u-ml', 'du-ml-w06', 'W06 — Neural networks.pdf', { source: 'src-u-fit', addedBy: 'Lê Văn Hùng', pages: 52, updated: P(21) }),
    doc('kb-u-ml', 'du-ml-w07', 'W07 — Model evaluation & validation.pptx', { source: 'src-u-fit', addedBy: 'Lê Văn Hùng', pages: 29, updated: P(14) }),
    doc('kb-u-ml', 'du-ml-w08', 'W08 — Unsupervised learning.pptx', { source: 'src-u-fit', addedBy: 'Lê Văn Hùng', pages: 33, updated: P(7), status: 'processing' }),
    doc('kb-u-ml', 'du-ml-a1', 'Assignment 1 — House price regression.pdf', { addedBy: 'Lê Văn Hùng', pages: 4, updated: P(12) }),
    doc('kb-u-ml', 'du-ml-lab2', 'Lab 2 — Gradient descent from scratch.md', { addedBy: 'Phạm Thu Hà', pages: 7, updated: P(45) }),

    doc('kb-u-db', 'du-db-syl', 'Syllabus — IT3090 Database Systems.pdf', { addedBy: 'Lê Văn Hùng', pages: 5, updated: P(60) }),
    doc('kb-u-db', 'du-db-w03', 'W03 — Relational algebra.pdf', { addedBy: 'Lê Văn Hùng', pages: 30, updated: P(42) }),
    doc('kb-u-db', 'du-db-w05', 'W05 — SQL joins & subqueries.pdf', { addedBy: 'Lê Văn Hùng', pages: 38, updated: P(28) }),
    doc('kb-u-db', 'du-db-w07', 'W07 — Normalization (1NF–BCNF).pdf', { addedBy: 'Lê Văn Hùng', pages: 33, updated: P(14) }),
    doc('kb-u-db', 'du-db-lab3', 'Lab 3 — SQL joins.md', { addedBy: 'Lê Văn Hùng', pages: 5, updated: P(6) }),
    doc('kb-u-db', 'du-db-past', 'Midterm 2025 with solutions.pdf', { addedBy: 'Lê Văn Hùng', pages: 8, updated: P(30) }),

    doc('kb-u-agri', 'du-ag-p1', 'Nguyen et al. 2024 — Transfer learning for Mekong rice leaf disease.pdf', { addedBy: 'Phạm Thu Hà', pages: 14, updated: P(18) }),
    doc('kb-u-agri', 'du-ag-p2', 'Rahman & Lee 2022 — Deep learning for crop disease detection: a survey.pdf', { addedBy: 'Phạm Thu Hà', pages: 32, updated: P(40) }),
    doc('kb-u-agri', 'du-ag-p3', 'Tran et al. 2024 — Edge AI for precision irrigation on ESP32.pdf', { addedBy: 'Trương Quốc Bảo', pages: 11, updated: P(25) }),
    doc('kb-u-agri', 'du-ag-p4', 'Le & Pham 2021 — Energy-efficient LoRaWAN sensing in rice paddies.pdf', { addedBy: 'Trương Quốc Bảo', pages: 9, updated: P(90) }),
    doc('kb-u-agri', 'du-ag-p5', 'Singh et al. 2023 — Vision transformers for plant disease under field conditions.pdf', { addedBy: 'Phạm Thu Hà', pages: 16, updated: P(10) }),
    doc('kb-u-agri', 'du-ag-p6', 'Ho et al. 2025 — Low-cost multispectral imaging for leaf blight.pdf', { addedBy: 'Bùi Gia Linh', pages: 12, updated: P(0, 3), status: 'pending' }),
    doc('kb-u-agri', 'du-ag-proto', 'Lab protocol — Soil sensor calibration.docx', { addedBy: 'Trương Quốc Bảo', pages: 6, updated: P(33) }),
    doc('kb-u-agri', 'du-ag-data', 'Dataset card — UTE-RiceLeaf v2.md', { addedBy: 'Phạm Thu Hà', pages: 3, updated: P(9) }),

    doc('kb-u-grants', 'du-gr-naf', 'NAFOSTED basic research call 2027.pdf', { addedBy: 'Science & Technology Office', pages: 15, updated: P(6) }),
    doc('kb-u-grants', 'du-gr-tpl', 'Proposal template — NAFOSTED.docx', { addedBy: 'Science & Technology Office', pages: 12, updated: P(6) }),
    doc('kb-u-grants', 'du-gr-pub', 'Publication reward policy 2026.pdf', { addedBy: 'Science & Technology Office', pages: 7, updated: P(80) }),
  ];

  /* ═══════════════ Sources ═══════════════ */
  D.accounts = [{ id: 'acc-u-gd', app: 'gdrive', label: 'drive@ute.edu.vn', user: 'drive@ute.edu.vn', status: 'connected', connected: P(90), checked: ago(9 * MIN) }];
  D.sources = [
    { id: 'src-u-regs', name: 'Academic Affairs — Published regulations', app: 'gdrive', account: 'acc-u-gd', kb: 'kb-u-regs', status: 'healthy', scope: ['Shared drives / Academic Affairs / Published'], schedule: { freq: 'daily', time: '02:00', day: 'Mon', tz: 'Asia/Ho_Chi_Minh', on: true }, last: { at: P(0, 5), result: 'completed', added: 0, updated: 1, removed: 0, failed: 0 }, next: T(0, 19), created: P(90), owner: 'Võ Thị Lan' },
    { id: 'src-u-fit', name: 'FIT shared drive — Course materials', app: 'gdrive', account: 'acc-u-gd', kb: 'kb-u-ml', status: 'healthy', scope: ['Shared drives / FIT / IT4071 Machine Learning'], schedule: { freq: 'weekly', time: '06:00', day: 'Mon', tz: 'Asia/Ho_Chi_Minh', on: true }, last: { at: P(1, 3), result: 'completed', added: 1, updated: 2, removed: 0, failed: 0 }, next: T(1, 6), created: P(70), owner: 'Lê Văn Hùng' },
  ];
  D.runs = [
    { id: 'run-u-212', source: 'src-u-regs', kb: 'kb-u-regs', trigger: 'Scheduled', status: 'completed', started: P(0, 5), dur: 41e3, counts: { total: 1, ok: 1, failed: 0, skipped: 0 }, by: 'Schedule' },
    { id: 'run-u-211', source: 'src-u-fit', kb: 'kb-u-ml', trigger: 'Scheduled', status: 'completed', started: P(1, 3), dur: 186e3, counts: { total: 3, ok: 3, failed: 0, skipped: 0 }, by: 'Schedule' },
    { id: 'run-u-210', source: 'src-u-regs', kb: 'kb-u-regs', trigger: 'Scheduled', status: 'completed', started: P(1, 5), dur: 22e3, counts: { total: 0, ok: 0, failed: 0, skipped: 0 }, by: 'Schedule' },
  ];

  /* Access requests (to knowledge bases) */
  D.requests = [
    { id: 'req-u-1', user: 'u-ute-linh', kb: 'kb-u-grants', role: 'viewer', note: 'Joining the Smart Agriculture Lab for my capstone and need the NAFOSTED template.', at: P(0, 4), status: 'pending' },
    { id: 'req-u-2', user: 'u-ute-thao', kb: 'kb-u-ml', role: 'editor', note: 'Co-teaching the Thursday lab group from week 10.', at: P(1, 2), status: 'pending' },
  ];

  /* ═══════════════ Activity ═══════════════ */
  D.audit = [
    [6 * MIN, 'u-ute-anh', 'Signed in', 'Sign-in', 'Microsoft', 'success'],
    [35 * MIN, 'u-ute-quan', 'Approved a request', 'Requests', 'Official transcript — Trần Thảo Vy', 'success'],
    [2 * HOUR, 'u-ute-hung', 'Published a quiz', 'Work', 'Week 4 quiz — Regularization & bias–variance', 'success'],
    [5 * HOUR, 'system', 'Sync finished', 'Sources', 'Academic Affairs — Published regulations', 'success'],
    [6 * HOUR, 'u-ute-lan', 'Updated a document', 'Knowledge', 'English Proficiency Requirement.pdf', 'success'],
    [27 * HOUR, 'u-ute-ha', 'Created a literature review', 'Work', 'Crop disease detection — evidence matrix', 'success'],
    [2 * DAY, 'u-ute-lan', 'Added request type', 'Requests', 'Withdraw from a course', 'success'],
    [3 * DAY, 'u-ute-lan', 'Suspended member', 'People & access', 'Ngô Hoàng Sơn', 'success'],
    [4 * DAY, 'u-ute-hung', 'Created space', 'Spaces', 'Database Systems · IT3090', 'success'],
    [6 * DAY, 'u-ute-lan', 'Updated assistant instructions', 'Settings', 'Assistant', 'success'],
  ].map(([t, actor, action, type, target, outcome], i) => ({ id: 'ev-u-' + (500 - i), at: ago(t), actor, action, type, target, outcome, ip: '10.20.' + (3 + i) + '.' + (11 + i * 4), device: i % 3 ? 'Chrome on Windows' : 'Safari on iPhone' }));
  D.signins = [
    [6 * MIN, 'u-ute-anh', 'Microsoft', 'active', 'Safari on iPhone'], [20 * MIN, 'u-ute-hung', 'Microsoft', 'active', 'Chrome on Windows'],
    [30 * MIN, 'u-ute-quan', 'Password', 'active', 'Edge on Windows'], [1 * HOUR, 'u-ute-ha', 'Microsoft', 'active', 'Chrome on macOS'],
    [26 * DAY, 'u-ute-son', 'Password', 'blocked', 'Chrome on Android'],
  ].map(([t, user, method, st, device], i) => ({ id: 'si-u-' + i, at: ago(t), user, method, status: st, device }));
  D.usage = { questions: Array.from({ length: 30 }, (_, i) => Math.round(1300 + 420 * Math.sin(i / 2.6) + i * 22 + (i % 7 > 4 ? -700 : 0))), active: 6120, activePrev: 5480, questions7: 11480, questions7Prev: 9930 };
  D.gaps = [
    { id: 'gu1', q: 'Can I register more than 25 credits in the summer term?', n: 64, kb: 'kb-u-regs', why: 'Summer rules are still a draft' },
    { id: 'gu2', q: 'Is the B1 English requirement waived for transfer students?', n: 41, kb: 'kb-u-regs', why: 'Only an outdated mention in English Proficiency Requirement' },
    { id: 'gu3', q: 'Can we use scikit-learn in Assignment 1?', n: 19, kb: 'kb-u-ml', why: 'The assignment brief doesn’t say' },
    { id: 'gu4', q: 'How do I book a lab bench in A5 after 6 pm?', n: 12, kb: 'kb-u-sso', why: 'No document covers it' },
  ];
  D.artifacts = {};

  /* ═══════════════ Assistant ═══════════════ */
  D.assistant = {
    instructions: 'You are the UTE Campus assistant. Answer from university regulations, course materials and lab libraries the person can access, and cite every factual claim. For deadlines and fees, quote the exact rule. If something needs a decision by a lecturer or an office, say who and offer to send them a request. Reply in the language the person writes in.',
    style: 'balanced', citations: true, caps: { search: true, analyze: true, files: true },
    welcome: 'What do you need for your studies or research today?',
    starters: [
      { title: 'Check a regulation', prompt: 'When is the course withdrawal deadline this semester, and is tuition refunded?' },
      { title: 'Study a topic', prompt: 'Explain the bias–variance trade-off with an example from Week 4.' },
      { title: 'Plan my week', prompt: 'What do I have due in the next 7 days across my courses?' },
    ],
    roleStarters: {
      student: [
        { title: 'Check a regulation', prompt: 'When is the course withdrawal deadline this semester, and is tuition refunded?' },
        { title: 'Study a topic', prompt: 'Explain the bias–variance trade-off with an example from Week 4.' },
        { title: 'Plan my week', prompt: 'What do I have due in the next 7 days across my courses?' },
      ],
      lecturer: [
        { title: 'Prepare a class', prompt: 'Outline a 15-minute recap of Week 4 regularization for Tuesday’s class.' },
        { title: 'Find confusion', prompt: 'What did students ask most about Assignment 1 this week?' },
        { title: 'Check a rule', prompt: 'How many days do I have to publish final grades after the exam?' },
      ],
      researcher: [
        { title: 'Search the library', prompt: 'Which papers in our library use transfer learning for rice leaf disease, and what accuracy did they report?' },
        { title: 'Grant rules', prompt: 'What is the budget ceiling and deadline for the NAFOSTED 2027 basic research call?' },
        { title: 'Method check', prompt: 'Summarize the sensor calibration protocol in five steps.' },
      ],
      staff: [
        { title: 'Answer consistently', prompt: 'What does the regulation say about withdrawing after week 10 for medical reasons?' },
        { title: 'Spot gaps', prompt: 'Which questions about the summer term did students ask this week?' },
        { title: 'Draft a notice', prompt: 'Draft a notice reminding students of the withdrawal deadline on November 10.' },
      ],
    },
  };

  /* ═══════════════ Spaces ═══════════════ */
  D.spaces = [
    {
      id: 'sp-ml', type: 'course', name: 'Machine Learning', code: 'IT4071', term: 'Semester 1 · 2026–2027', color: '#2F6FB5',
      desc: 'Supervised learning, model evaluation and neural networks.', schedule: 'Tue 07:00–09:30 · Thu 13:00–15:30 · A5-302', memberCount: 118, visibility: 'members', kbs: ['kb-u-ml'],
      members: [{ user: 'u-ute-hung', role: 'lecturer' }, { user: 'u-ute-ha', role: 'ta' }, { user: 'u-ute-anh', role: 'student' }, { user: 'u-ute-huy', role: 'student' }, { user: 'u-ute-vy', role: 'student' }, { user: 'u-ute-khoa', role: 'student' }, { user: 'u-ute-linh', role: 'student' }],
      announcements: [
        { id: 'an-ml-3', by: 'u-ute-hung', at: P(0, 2), title: 'Week 4 quiz is open', text: 'The quiz covers regularization and the bias–variance trade-off. It closes Thursday 23:59; you can take it once.', pinned: true },
        { id: 'an-ml-2', by: 'u-ute-ha', at: P(3), title: 'Lab 2 solutions posted', text: 'Solutions for gradient descent from scratch are in the materials. Office hours moved to Wednesday 15:00, A5-210.' },
      ],
      created: P(70),
    },
    {
      id: 'sp-db', type: 'course', name: 'Database Systems', code: 'IT3090', term: 'Semester 1 · 2026–2027', color: '#0E7C66',
      desc: 'Relational model, SQL, normalization and transactions.', schedule: 'Mon 09:30–12:00 · A4-105', memberCount: 96, visibility: 'members', kbs: ['kb-u-db'],
      members: [{ user: 'u-ute-hung', role: 'lecturer' }, { user: 'u-ute-anh', role: 'student' }, { user: 'u-ute-vy', role: 'student' }, { user: 'u-ute-tam', role: 'student' }],
      announcements: [{ id: 'an-db-1', by: 'u-ute-hung', at: P(1), title: 'Midterm grades are out', text: 'Grades are on the student portal. Re-grading requests go to Academic Affairs within 7 days.' }],
      created: P(66),
    },
    {
      id: 'sp-agri', type: 'research', name: 'Smart Agriculture Lab', code: 'SAL', term: '', color: '#4E6B2E',
      desc: 'IoT sensing and computer vision for Mekong Delta farming.', schedule: 'Lab meeting · Thu 16:00 · B2-410', memberCount: 9, visibility: 'discoverable', kbs: ['kb-u-agri', 'kb-u-grants'],
      members: [{ user: 'u-ute-bao', role: 'pi' }, { user: 'u-ute-ha', role: 'researcher' }, { user: 'u-ute-hung', role: 'member' }, { user: 'u-ute-linh', role: 'member' }],
      announcements: [{ id: 'an-ag-1', by: 'u-ute-bao', at: P(2), title: 'NAFOSTED internal deadline', text: 'Background and significance draft to me by Nov 13 so we have a week for revisions.', pinned: true }],
      created: P(88),
    },
    {
      id: 'sp-aao', type: 'office', name: 'Academic Affairs Office', code: 'AAO', term: '', color: '#1F5FAD',
      desc: 'Registration, exams, transcripts and academic records.', schedule: 'Mon–Fri 07:30–16:30 · A1-102', memberCount: 6, visibility: 'open', kbs: ['kb-u-regs'],
      members: [{ user: 'u-ute-lan', role: 'head' }, { user: 'u-ute-quan', role: 'staff' }],
      announcements: [{ id: 'an-aao-1', by: 'u-ute-lan', at: P(1), title: 'Withdrawal deadline: November 10', text: 'Course withdrawal for Semester 1 closes at the end of week 10. Send a request from Requests → Withdraw from a course.', pinned: true }],
      created: P(95),
    },
    {
      id: 'sp-sso', type: 'office', name: 'Student Services Office', code: 'SSO', term: '', color: '#B4467A',
      desc: 'Scholarships, student status letters and student support.', schedule: 'Mon–Fri 07:30–16:30 · A1-108', memberCount: 4, visibility: 'open', kbs: ['kb-u-sso'],
      members: [{ user: 'u-ute-ngoc', role: 'head' }],
      announcements: [], created: P(95),
    },
  ];

  /* ═══════════════ Events (what's due / coming up) — audience: all | members | staff ═══════════════ */
  D.events = [
    { id: 'evt-1', space: 'sp-db', kind: 'deadline', title: 'Lab 3 — SQL joins', at: T(1, -3), audience: 'members', doc: 'du-db-lab3' },
    { id: 'evt-2', space: 'sp-ml', kind: 'deadline', title: 'Assignment 1 — House price regression', at: T(2, 5), audience: 'members', doc: 'du-ml-a1' },
    { id: 'evt-3', space: 'sp-ml', kind: 'quiz', title: 'Week 4 quiz closes', at: T(4, 14), audience: 'members', work: 'w-quiz-w4' },
    { id: 'evt-4', space: 'sp-aao', kind: 'deadline', title: 'Course withdrawal deadline', at: EOD(9), audience: 'all', requestType: 'rt-withdraw' },
    { id: 'evt-5', space: 'sp-agri', kind: 'deadline', title: 'NAFOSTED draft to the PI', at: T(12, 7), audience: 'members', work: 'w-draft-naf' },
    { id: 'evt-6', space: 'sp-ml', kind: 'exam', title: 'Midterm exam · A5-302', at: T(18, -6), audience: 'members' },
    { id: 'evt-7', space: 'sp-agri', kind: 'meeting', title: 'Lab meeting — literature sync', at: T(3, 2), audience: 'members' },
    { id: 'evt-8', space: 'sp-db', kind: 'deadline', title: 'Publish midterm re-grading results', at: T(5, 3), audience: 'staff' },
  ];

  /* ═══════════════ Work (artifacts made with AI workflows) ═══════════════ */
  const cite = (doc, page, quote) => ({ doc, page, quote });
  D.works = [
    {
      id: 'w-quiz-w4', kind: 'quiz', workflow: 'quiz', title: 'Week 4 quiz — Regularization & bias–variance', space: 'sp-ml', owner: 'u-ute-hung', status: 'published', visibility: 'space',
      created: P(2, 6), updated: P(0, 2), published: P(0, 2), due: T(4, 14), sources: ['du-ml-w04', 'du-ml-w03'],
      data: {
        timeLimit: 15, attemptsAllowed: 1,
        questions: [
          { id: 'q1', q: 'Which term does L2 regularization add to the loss?', options: ['λ‖w‖₁', 'λ‖w‖²', 'λ·n', 'λ·log(w)'], answer: 1, difficulty: 'easy', explain: 'L2 (ridge) penalizes the squared norm of the weights.', cite: cite('du-ml-w04', 7, 'L2 regularization adds λ‖w‖² to the loss, shrinking all weights toward zero without making them exactly zero.') },
          { id: 'q2', q: 'Is the bias term w₀ usually regularized?', options: ['Yes, always', 'No, by convention it is left out', 'Only with L1', 'Only for logistic regression'], answer: 1, difficulty: 'medium', explain: 'The intercept only shifts predictions; penalizing it biases the model without reducing variance.', cite: cite('du-ml-w04', 9, 'By convention the bias term w₀ is not regularized: it shifts every prediction equally and does not add model complexity.') },
          { id: 'q3', q: 'Training error 2%, validation error 19%. What is the most likely problem?', options: ['High bias', 'High variance', 'Too little regularization is impossible here', 'Data leakage only'], answer: 1, difficulty: 'medium', explain: 'A large gap between training and validation error signals overfitting (high variance).', cite: cite('du-ml-w04', 15, 'High variance: training error is low but validation error is much higher. High bias: both errors are high.') },
          { id: 'q4', q: 'What usually happens as λ increases?', options: ['Variance increases, bias decreases', 'Both decrease', 'Variance decreases, bias increases', 'Nothing changes'], answer: 2, difficulty: 'easy', explain: 'Stronger regularization makes the model simpler: less variance, more bias.', cite: cite('du-ml-w04', 18, 'Increasing λ reduces variance but can increase bias; choose λ on a validation set.') },
          { id: 'q5', q: 'Which regularizer tends to produce sparse weights?', options: ['L2', 'L1', 'Dropout', 'Early stopping'], answer: 1, difficulty: 'medium', explain: 'The L1 penalty drives some weights exactly to zero.', cite: cite('du-ml-w04', 11, 'L1 regularization (lasso) can set weights exactly to zero, which performs feature selection.') },
          { id: 'q6', q: 'How should λ be chosen?', options: ['On the test set', 'On the training set', 'With a validation set or cross-validation', 'Always λ = 1'], answer: 2, difficulty: 'hard', explain: 'The test set must stay untouched; tune hyper-parameters on validation data.', cite: cite('du-ml-w04', 21, 'Select λ with k-fold cross-validation; never tune hyper-parameters on the test set.') },
        ],
        stats: { attempts: 37, avg: 4.1, byQuestion: [0.95, 0.43, 0.81, 0.86, 0.62, 0.38] },
        attempts: [],
      },
    },
    {
      id: 'w-quiz-w5', kind: 'quiz', workflow: 'quiz', title: 'Week 5 quiz — Decision trees', space: 'sp-ml', owner: 'u-ute-hung', status: 'draft', visibility: 'space',
      created: P(0, 20), updated: P(0, 20), sources: ['du-ml-w05'],
      data: {
        timeLimit: 15, attemptsAllowed: 1,
        questions: [
          { id: 'q1', q: 'Which impurity measure does CART use for classification by default?', options: ['Entropy', 'Gini impurity', 'Mean squared error', 'Hinge loss'], answer: 1, difficulty: 'easy', explain: 'CART splits on Gini impurity unless told otherwise.', cite: cite('du-ml-w05', 8, 'CART uses Gini impurity to choose splits for classification trees.') },
          { id: 'q2', q: 'Why does a random forest sample features at each split?', options: ['To speed up training only', 'To decorrelate the trees', 'To avoid missing values', 'To make trees deeper'], answer: 1, difficulty: 'medium', explain: 'Feature sampling makes trees less similar, so averaging reduces variance more.', cite: cite('du-ml-w05', 27, 'Sampling a subset of features at each split decorrelates the trees, so averaging them reduces variance.') },
        ],
        stats: { attempts: 0, avg: 0, byQuestion: [] }, attempts: [],
      },
    },
    {
      id: 'w-guide-w2', kind: 'guide', workflow: 'study-guide', title: 'Linear regression — study guide', space: 'sp-ml', owner: 'u-ute-anh', status: 'ready', visibility: 'private',
      created: P(9), updated: P(9), sources: ['du-ml-w02', 'du-ml-lab2'],
      data: {
        sections: [
          { id: 's1', title: 'In one paragraph', html: '<p>Linear regression predicts a number as a weighted sum of features, <b>ŷ = w₀ + w₁x₁ + … + wₙxₙ</b>. We find the weights that minimize the mean squared error, either in closed form (normal equation) or step by step with gradient descent [1].</p>', cites: [cite('du-ml-w02', 6, 'The model predicts ŷ = wᵀx and is trained by minimizing the mean squared error between predictions and targets.')] },
          { id: 's2', title: 'Key terms', html: '<ul><li><b>Learning rate α</b> — step size of each gradient descent update; too large diverges, too small is slow [1].</li><li><b>Feature scaling</b> — standardize features so gradient descent converges faster [2].</li><li><b>Normal equation</b> — w = (XᵀX)⁻¹Xᵀy, exact but expensive for many features [1].</li></ul>', cites: [cite('du-ml-w02', 18, 'If α is too large gradient descent can overshoot and diverge; if it is too small, convergence is slow.'), cite('du-ml-lab2', 3, 'Standardize each feature to zero mean and unit variance before running gradient descent.')] },
          { id: 's3', title: 'Check yourself', html: '<ol><li>Why does unscaled data slow gradient descent down?</li><li>When would you prefer gradient descent over the normal equation?</li><li>What does the loss curve look like when α is too large?</li></ol>', cites: [] },
        ],
      },
    },
    {
      id: 'w-review-agri', kind: 'review', workflow: 'review', title: 'Crop disease detection — evidence matrix', space: 'sp-agri', owner: 'u-ute-ha', status: 'ready', visibility: 'space',
      created: P(1, 3), updated: P(1, 3), sources: ['du-ag-p1', 'du-ag-p2', 'du-ag-p5', 'du-ag-p3'],
      data: {
        papers: ['du-ag-p1', 'du-ag-p5', 'du-ag-p2', 'du-ag-p3'],
        criteria: [{ id: 'method', label: 'Method' }, { id: 'data', label: 'Dataset' }, { id: 'result', label: 'Result' }, { id: 'limit', label: 'Limitations' }],
        cells: {
          'du-ag-p1': { method: { text: 'Fine-tuned MobileNetV3 (ImageNet-pretrained).', cite: cite('du-ag-p1', 4, 'We fine-tune a MobileNetV3-Large pretrained on ImageNet, freezing the first 10 blocks.') }, data: { text: '4,800 field images, 5 rice diseases, Mekong Delta.', cite: cite('du-ag-p1', 5, 'The dataset contains 4,800 images of rice leaves collected in Can Tho and An Giang across five disease classes.') }, result: { text: '96.2% accuracy; 21 ms per image on a phone.', cite: cite('du-ag-p1', 9, 'The fine-tuned model reached 96.2% accuracy with 21 ms inference on a mid-range Android phone.') }, limit: { text: 'Single season; no night or rain images.', cite: cite('du-ag-p1', 12, 'All images were taken in the dry season under daylight; performance in rain is untested.') } },
          'du-ag-p5': { method: { text: 'ViT-B/16 with field-condition augmentation.', cite: cite('du-ag-p5', 5, 'We train a ViT-B/16 with augmentations that simulate occlusion, glare and motion blur.') }, data: { text: 'PlantVillage + 3,100 field images.', cite: cite('du-ag-p5', 6, 'Training combines PlantVillage with 3,100 in-field images from India and Vietnam.') }, result: { text: '93.4% in the field vs 99.1% in the lab.', cite: cite('du-ag-p5', 11, 'Accuracy drops from 99.1% on lab images to 93.4% on field images.') }, limit: { text: 'Too heavy for edge devices.', cite: cite('du-ag-p5', 14, 'The model needs 330 ms per image on a Jetson Nano, too slow for real-time use.') } },
          'du-ag-p2': { method: { text: 'Survey of 120 studies (2015–2022).', cite: cite('du-ag-p2', 2, 'We review 120 peer-reviewed studies on deep learning for crop disease detection published between 2015 and 2022.') }, data: { text: 'Mostly PlantVillage (lab images).', cite: cite('du-ag-p2', 14, '68% of the surveyed studies evaluate only on PlantVillage, whose images are taken on uniform backgrounds.') }, result: { text: 'Transfer learning dominates (71%).', cite: cite('du-ag-p2', 9, 'Transfer learning dominates recent work: 71% of the studies fine-tune ImageNet-pretrained CNNs.') }, limit: { text: 'Lab-to-field gap rarely measured.', cite: cite('du-ag-p2', 27, 'Few studies report accuracy on field images, so the lab-to-field gap remains largely unmeasured.') } },
          'du-ag-p3': { method: { text: 'Quantized CNN on ESP32-S3 for soil moisture.', cite: cite('du-ag-p3', 3, 'An 8-bit quantized CNN runs on an ESP32-S3 to classify soil moisture states from capacitive sensor traces.') }, data: { text: '42 days of sensor traces, 3 plots.', cite: cite('du-ag-p3', 5, 'Data were logged every 5 minutes for 42 days on three experimental plots.') }, result: { text: '92% accuracy at 38 mW.', cite: cite('du-ag-p3', 8, 'The model classified soil moisture states with 92% accuracy at 38 mW average power.') }, limit: { text: 'Not a vision task; different sensor domain.', cite: cite('du-ag-p3', 10, 'Our approach targets sensor time series and does not address image-based disease detection.') } },
        },
      },
    },
    {
      id: 'w-draft-naf', kind: 'draft', workflow: 'draft', title: 'NAFOSTED 2027 — Background & significance', space: 'sp-agri', owner: 'u-ute-ha', status: 'draft', visibility: 'space',
      created: P(4), updated: P(0, 22), sources: ['du-gr-naf', 'du-ag-p1', 'du-ag-p2'],
      data: {
        html: '<h2>Background and significance</h2><p>Rice diseases cost Mekong Delta farmers an estimated 10–15% of yield each season. Deep learning now detects leaf diseases with high accuracy on lab images, and transfer learning dominates recent work [1]. Field accuracy is far less studied: most evaluations still rely on uniform-background datasets [1].</p><p>Our pilot showed that a fine-tuned MobileNetV3 reaches 96.2% accuracy on 4,800 field images from Can Tho and An Giang while running in 21 ms on a phone [2]. The proposed project extends this to rainy-season conditions and low-cost multispectral imaging.</p><h3>Fit with the call</h3><p>The 2027 basic research call prioritizes applied AI for agriculture and funds projects of up to 24 months [3].</p>',
        cites: [cite('du-ag-p2', 9, 'Transfer learning dominates recent work: 71% of the studies fine-tune ImageNet-pretrained CNNs.'), cite('du-ag-p1', 9, 'The fine-tuned model reached 96.2% accuracy with 21 ms inference on a mid-range Android phone.'), cite('du-gr-naf', 3, 'Priority areas for 2027 include applied artificial intelligence for agriculture and the environment. Projects may last up to 24 months.')],
      },
    },
  ];

  /* ═══════════════ Requests: what people can ask offices and teaching teams ═══════════════
     checks: rules the assistant verifies before submitting (with the regulation it relies on). */
  D.requestTypes = [
    {
      id: 'rt-withdraw', space: 'sp-aao', name: 'Withdraw from a course', icon: 'arrow-left', sla: 3, fee: 'Tuition is not refunded',
      desc: 'Drop a registered course before the end of week 10. It shows as W and doesn’t count toward your GPA.',
      fields: [{ id: 'course', label: 'Course', type: 'course', required: true }, { id: 'reason', label: 'Reason', type: 'textarea', required: true, placeholder: 'A sentence is enough.' }],
      checks: [
        { id: 'deadline', rule: 'before', at: EOD(9), label: `Before the withdrawal deadline (end of week 10, ${fmtDate(EOD(9))})`, cite: cite('du-reg-rules', 18, 'Students may withdraw from a registered course no later than the end of week 10 of the semester. Withdrawn courses appear as W on the transcript and do not count toward the GPA.') },
        { id: 'load', rule: 'minCredits', min: 14, label: 'You keep at least 14 credits this semester', cite: cite('du-reg-rules', 17, 'The minimum registered load in a regular semester is 14 credits; students below this load must be approved by the Faculty.') },
        { id: 'refund', rule: 'info', label: 'Tuition for the course is not refunded', cite: cite('du-reg-fees', 5, 'Tuition for withdrawn courses is not refunded, except for courses cancelled by the university.') },
      ],
    },
    {
      id: 'rt-regrade', space: 'sp-aao', name: 'Exam re-grading', icon: 'retry', sla: 5, fee: '30,000 VND per course, refunded if the grade changes',
      desc: 'Ask for a final or midterm exam to be marked again within 7 days of the grade being published.',
      fields: [{ id: 'course', label: 'Course', type: 'course', required: true }, { id: 'exam', label: 'Exam', type: 'select', options: ['Midterm', 'Final'], required: true }, { id: 'reason', label: 'What should be checked?', type: 'textarea', required: true }],
      checks: [
        { id: 'window', rule: 'info', label: 'Within 7 days of the grade being published', cite: cite('du-reg-regrade', 1, 'Students may request re-grading of an exam within 7 days after the grade is published.') },
        { id: 'fee', rule: 'info', label: 'Fee 30,000 VND, refunded if the grade changes', cite: cite('du-reg-regrade', 2, 'The re-grading fee is 30,000 VND per course and is refunded if the grade changes.') },
      ],
    },
    {
      id: 'rt-transcript', space: 'sp-aao', name: 'Official transcript', icon: 'file-text', sla: 2, fee: '20,000 VND per copy',
      desc: 'Signed and stamped copies of your transcript, in Vietnamese or English.',
      fields: [{ id: 'copies', label: 'Copies', type: 'number', required: true, min: 1, max: 10 }, { id: 'language', label: 'Language', type: 'select', options: ['Vietnamese', 'English', 'Both'], required: true }, { id: 'delivery', label: 'Delivery', type: 'select', options: ['Pick up at A1-102', 'Post to my address'], required: true }],
      checks: [{ id: 'fee', rule: 'info', label: '20,000 VND per copy, ready in 2 working days', cite: cite('du-reg-fees', 6, 'Official transcripts are issued within two working days. Each copy costs 20,000 VND.') }],
    },
    {
      id: 'rt-leave', space: 'sp-aao', name: 'Leave of absence', icon: 'pause', sla: 5, fee: null,
      desc: 'Pause your studies for one or two semesters and keep your place.',
      fields: [{ id: 'semesters', label: 'How long', type: 'select', options: ['1 semester', '2 semesters'], required: true }, { id: 'reason', label: 'Reason', type: 'textarea', required: true }],
      checks: [
        { id: 'done1', rule: 'minYear', min: 1, label: 'You have completed at least one semester', cite: cite('du-reg-leave', 1, 'Students who have completed at least one semester may suspend their studies for up to two semesters in total.') },
        { id: 'max', rule: 'info', label: 'Up to two semesters in total', cite: cite('du-reg-leave', 1, 'Students who have completed at least one semester may suspend their studies for up to two semesters in total.') },
      ],
    },
    {
      id: 'rt-letter', space: 'sp-sso', name: 'Student status letter', icon: 'mail', sla: 1, fee: null,
      desc: 'A letter confirming you are enrolled — for military deferral, banks, visas or scholarships.',
      fields: [{ id: 'purpose', label: 'Purpose', type: 'select', options: ['Military service deferral', 'Bank or student loan', 'Visa application', 'Scholarship', 'Other'], required: true }, { id: 'copies', label: 'Copies', type: 'number', required: true, min: 1, max: 5 }],
      checks: [{ id: 'free', rule: 'info', label: 'Free, ready the next working day', cite: cite('du-sso-letter', 1, 'Student status letters are free of charge and ready for pick-up at A1-108 on the next working day.') }],
    },
    {
      id: 'rt-scholar', space: 'sp-sso', name: 'Scholarship application', icon: 'sparkles', sla: 10, fee: null,
      desc: 'Apply for the academic excellence scholarship for this semester.',
      fields: [{ id: 'type', label: 'Scholarship', type: 'select', options: ['Academic excellence', 'Financial support', 'Industry-sponsored'], required: true }, { id: 'statement', label: 'Short statement', type: 'textarea', required: true }],
      checks: [{ id: 'gpa', rule: 'minGpa', min: 3.2, label: 'GPA of at least 3.2 for academic excellence', cite: cite('du-sso-schol', 3, 'Academic excellence scholarships require a semester GPA of at least 3.2 and no failed courses.') }],
    },
    { id: 'rt-q-ml', space: 'sp-ml', name: 'Question for the teaching team', icon: 'message', sla: 2, fee: null, question: true, desc: 'When the assistant can’t answer from the course materials, ask the lecturer and TA.', fields: [{ id: 'question', label: 'Question', type: 'textarea', required: true }], checks: [] },
    { id: 'rt-q-db', space: 'sp-db', name: 'Question for the teaching team', icon: 'message', sla: 2, fee: null, question: true, desc: 'When the assistant can’t answer from the course materials, ask the lecturer.', fields: [{ id: 'question', label: 'Question', type: 'textarea', required: true }], checks: [] },
  ];

  /* Request lifecycle: submitted → in_review → (needs_info ↔ in_review) → approved | declined → completed; or withdrawn. */
  const msg = (by, at, text, kind = 'message') => ({ id: uid('m'), by, at, text, kind });
  const sr = (id, type, requester, status, created, fields, thread, o = {}) => ({ id, type, space: D.requestTypes.find(t => t.id === type).space, requester, status, created, updated: thread.length ? thread[thread.length - 1].at : created, fields, thread, assignee: o.assignee || null, due: created + (D.requestTypes.find(t => t.id === type).sla) * DAY, ...o });
  D.svcRequests = [
    sr('SR-2041', 'rt-regrade', 'u-ute-anh', 'in_review', P(2, 3), { course: 'IT3090', exam: 'Midterm', reason: 'Question 4 (normalization) was marked 0/2 but my answer reaches 3NF — please check the dependency analysis.' },
      [msg('u-ute-anh', P(2, 3), 'Submitted.', 'status'), msg('u-ute-quan', P(1, 6), 'Received. The exam paper has been sent to the Faculty of IT for re-marking.', 'status')], { assignee: 'u-ute-quan', fee: '30,000 VND · paid' }),
    sr('SR-2018', 'rt-letter', 'u-ute-anh', 'completed', P(6), { purpose: 'Bank or student loan', copies: 2 },
      [msg('u-ute-anh', P(6), 'Submitted.', 'status'), msg('u-ute-ngoc', P(5, 2), 'Your 2 letters are ready to pick up at A1-108.', 'status')], { assignee: 'u-ute-ngoc' }),
    sr('SR-2047', 'rt-withdraw', 'u-ute-huy', 'submitted', P(0, 3), { course: 'MA2010', reason: 'Clashes with my internship schedule from next week.' }, [msg('u-ute-huy', P(0, 3), 'Submitted.', 'status')]),
    sr('SR-2046', 'rt-transcript', 'u-ute-vy', 'approved', P(0, 9), { copies: 3, language: 'English', delivery: 'Pick up at A1-102' }, [msg('u-ute-vy', P(0, 9), 'Submitted.', 'status'), msg('u-ute-quan', P(0, 1), 'Approved. Ready for pick-up Wednesday.', 'status')], { assignee: 'u-ute-quan' }),
    sr('SR-2044', 'rt-leave', 'u-ute-tam', 'needs_info', P(2), { semesters: '1 semester', reason: 'Family health reasons.' },
      [msg('u-ute-tam', P(2), 'Submitted.', 'status'), msg('u-ute-lan', P(1, 4), 'Please attach a medical certificate or a family confirmation letter so we can process the leave.', 'needs_info')], { assignee: 'u-ute-lan' }),
    sr('SR-2039', 'rt-regrade', 'u-ute-khoa', 'in_review', P(4), { course: 'IT3090', exam: 'Midterm', reason: 'Points for question 2 seem not to be added to the total.' },
      [msg('u-ute-khoa', P(4), 'Submitted.', 'status')], { assignee: 'u-ute-lan' }),
    sr('SR-2049', 'rt-withdraw', 'u-ute-linh', 'submitted', P(0, 1), { course: 'EN2030', reason: 'I passed the IELTS exemption and no longer need this course.' }, [msg('u-ute-linh', P(0, 1), 'Submitted.', 'status')]),
    sr('SR-2050', 'rt-q-ml', 'u-ute-huy', 'submitted', P(0, 5), { question: 'Can we use scikit-learn for Assignment 1, or must gradient descent be implemented by hand?' },
      [msg('u-ute-huy', P(0, 5), 'Submitted.', 'status')], { aiTried: 'The assignment brief doesn’t say whether libraries are allowed.' }),
    sr('SR-2045', 'rt-q-ml', 'u-ute-vy', 'submitted', P(1, 1), { question: 'In Week 4, is λ also applied to the bias term when we use scikit-learn’s Ridge?' },
      [msg('u-ute-vy', P(1, 1), 'Submitted.', 'status')], { aiTried: 'The slides say w₀ is conventionally not regularized, but don’t mention scikit-learn.' }),
    sr('SR-2043', 'rt-q-ml', 'u-ute-khoa', 'submitted', P(2, 2), { question: 'Will the midterm cover Week 6 neural networks?' }, [msg('u-ute-khoa', P(2, 2), 'Submitted.', 'status')], { aiTried: 'The syllabus lists midterm topics up to “Week 6” but the announcement says Weeks 1–5.' }),
    sr('SR-2030', 'rt-q-ml', 'u-ute-anh', 'completed', P(8), { question: 'For Lab 2, should the learning-rate plot use a log scale?' },
      [msg('u-ute-anh', P(8), 'Submitted.', 'status'), msg('u-ute-ha', P(7, 20), 'Yes — use a log scale on the x-axis (1e-4 to 1). I added this to the course FAQ.', 'answer')], { assignee: 'u-ute-ha' }),
  ];

  /* ═══════════════ Conversations ═══════════════ */
  D.convs = [
    { id: 'cu1', owner: 'u-ute-anh', title: 'Withdrawal deadline and refund', at: P(0, 1), scope: [], messages: [
      { id: 'mu1', role: 'user', text: 'When is the course withdrawal deadline this semester, and is tuition refunded?' },
      { id: 'mu2', role: 'assistant', activity: [{ kind: 'search', label: 'Searched Academic regulations & procedures', detail: '2 searches · 4 relevant passages' }],
        text: 'You can withdraw from a course until the **end of week 10, which is Tuesday, November 10** this semester [1][2]. The course then shows as **W** on your transcript and doesn’t count toward your GPA [1].\n\nTuition for a withdrawn course is **not refunded**, unless the university cancelled the course [3].\n\nOne more check: you must keep **at least 14 credits** after withdrawing [4]. You’re registered for 18, so dropping one 3-credit course is fine.\n\nIf you want, I can start a withdrawal request for you.',
        citations: [
          { n: 1, doc: 'du-reg-rules', page: 18, quote: 'Students may withdraw from a registered course no later than the end of week 10 of the semester. Withdrawn courses appear as W on the transcript and do not count toward the GPA.' },
          { n: 2, doc: 'du-reg-cal', page: 2, quote: 'Week 10 of Semester 1 ends on Tuesday, 10 November 2026.' },
          { n: 3, doc: 'du-reg-fees', page: 5, quote: 'Tuition for withdrawn courses is not refunded, except for courses cancelled by the university.' },
          { n: 4, doc: 'du-reg-rules', page: 17, quote: 'The minimum registered load in a regular semester is 14 credits; students below this load must be approved by the Faculty.' },
        ],
        next: [{ label: 'Start a withdrawal request', act: 'rq-new', data: { type: 'rt-withdraw' } }] },
    ] },
    { id: 'cu2', owner: 'u-ute-ha', title: 'Transfer learning papers on rice disease', at: P(0, 4), scope: ['kb-u-agri'], space: 'sp-agri', messages: [
      { id: 'mu3', role: 'user', text: 'Which papers in our library use transfer learning for rice leaf disease, and what accuracy did they report?' },
      { id: 'mu4', role: 'assistant', activity: [{ kind: 'search', label: 'Searched Smart Agriculture Lab · Library', detail: '3 searches · 5 relevant passages' }],
        text: 'Two papers in the library use transfer learning for this task:\n\n- **Nguyen et al. 2024** fine-tune an ImageNet-pretrained MobileNetV3 on 4,800 Mekong field images and report **96.2% accuracy** [1][2].\n- **Singh et al. 2023** use a ViT-B/16 and report **93.4% on field images**, down from 99.1% in the lab [3].\n\nThe Rahman & Lee survey notes that 71% of recent studies use transfer learning, but most evaluate only on lab images [4].',
        citations: [
          { n: 1, doc: 'du-ag-p1', page: 4, quote: 'We fine-tune a MobileNetV3-Large pretrained on ImageNet, freezing the first 10 blocks.' },
          { n: 2, doc: 'du-ag-p1', page: 9, quote: 'The fine-tuned model reached 96.2% accuracy with 21 ms inference on a mid-range Android phone.' },
          { n: 3, doc: 'du-ag-p5', page: 11, quote: 'Accuracy drops from 99.1% on lab images to 93.4% on field images.' },
          { n: 4, doc: 'du-ag-p2', page: 9, quote: 'Transfer learning dominates recent work: 71% of the studies fine-tune ImageNet-pretrained CNNs.' },
        ],
        next: [{ label: 'Compare them in a literature review', act: 'work-start', data: { workflow: 'review', space: 'sp-agri' } }] },
    ] },
    { id: 'cu3', owner: 'u-ute-hung', title: 'Week 4 recap for Tuesday', at: P(1), scope: ['kb-u-ml'], space: 'sp-ml', messages: [] },
    { id: 'cu4', owner: 'u-ute-anh', title: 'Bias–variance with an example', at: P(2), scope: ['kb-u-ml'], space: 'sp-ml', messages: [] },
    { id: 'cu5', owner: 'u-ute-lan', title: 'Withdrawal after week 10 for medical reasons', at: P(3), scope: ['kb-u-regs'], messages: [] },
    { id: 'cu6', owner: 'u-ute-anh', title: 'Scholarship GPA requirement', at: P(5), scope: [], messages: [] },
  ];
});
