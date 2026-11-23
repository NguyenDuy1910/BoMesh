'use strict';
/* Trường Đại học UTE — a university workspace on the Campus template (Spaces,
   Work and Requests on). Same platform records as Northwind and Finx
   (knowledge, people, sources, chats) plus courses, a research group and
   offices, events, work (quiz, study guide, notice draft) and requests.
   Knowledge follows the university's own levels: Khoa › Bộ môn › Nhóm ngành ›
   Chuyên ngành, offices (Phòng ban) with plain folders, and Biểu mẫu folders.
   UTE is PUBLIC (visibility public): applicants join through its link and
   become ordinary members (an Applicant persona and five more). Content is
   Vietnamese. Loaded after
   data/contributions.js. All UTE records are fictional demo data (see ws.demo). */

/* ═══════════════ Personas (demo people) ═══════════════ */
const UTE_LECTURER_PERMS = ['tenant.read', 'knowledge.read', 'knowledge.contribute', 'knowledge.manage', 'ingestion.read', 'ingestion.run'];
Object.assign(PERSONAS, {
  student: {
    id: 'u-ute-anh', name: 'Nguyễn Minh Anh', email: '22110101@student.ute.edu.vn', role: 'Sinh viên năm 3 · Công nghệ Thông tin', label: 'Student',
    perms: ['tenant.read', 'knowledge.read', 'knowledge.contribute'], workspaces: ['ws-campus'],
    profile: { team: 'Sinh viên K22 · CNTT', studentId: '22110101', program: 'Công nghệ Thông tin', cohort: 'K22', year: 3, advisor: 'Lê Văn Hùng' },
  },
  // Joined two days ago: no history yet, so Home shows the newcomer's start (Getting started, picks for a first week).
  newstudent: {
    id: 'u-ute-bao', name: 'Trương Gia Bảo', email: '25110072@student.ute.edu.vn', role: 'Tân sinh viên · Công nghệ Thông tin', label: 'New student',
    perms: ['tenant.read', 'knowledge.read', 'knowledge.contribute'], workspaces: ['ws-campus'],
    profile: { team: 'Sinh viên K25 · CNTT', studentId: '25110072', program: 'Công nghệ Thông tin', cohort: 'K25', year: 1, advisor: 'Đỗ Phương Thảo' },
  },
  lecturer: {
    id: 'u-ute-hung', name: 'Lê Văn Hùng', email: 'hunglv@ute.edu.vn', role: 'Giảng viên · Trưởng Bộ môn Hệ thống Thông tin', label: 'Lecturer',
    perms: UTE_LECTURER_PERMS, workspaces: ['ws-campus'],
    profile: { team: 'Bộ môn Hệ thống Thông tin' },
  },
  campusadmin: {
    id: 'u-ute-phuong', name: 'Trần Thị Mai Phương', email: 'phuongttm@ute.edu.vn', role: 'Chuyên viên Phòng Đào tạo · Quản trị workspace', label: 'Admin',
    perms: ALL_TENANT, workspaces: ['ws-campus'],
    profile: { team: 'Phòng Đào tạo' },
  },
});
/* An applicant who joined UTE through its public link (UTE is public): an ordinary member with the Member role. `joins` keeps the
   persona in UTE's prototype bar while they're out (left, or not joined yet); `workspaces` follows their membership
   (core/workspace.js syncMemberships). */
PERSONAS.applicant = {
  id: 'u-ute-khanh', name: 'Phạm Gia Khánh', email: 'giakhanh.pham2008@gmail.com', role: 'Thí sinh 2026', label: 'Applicant',
  perms: ['tenant.read', 'knowledge.read', 'knowledge.contribute'], workspaces: ['ws-campus'], joins: ['ws-campus'],
};
// The platform operator can open every demo workspace.
PERSONAS.operator.workspaces.push('ws-campus');

/* ═══════════════ Workspace record (platform) ═══════════════ */
(() => {
  const campus = {
    id: 'ws-campus', name: 'Trường Đại học UTE', code: 'ute', color: '#1F5FAD', members: 14260, docs: 7180, status: 'active', created: ago(150 * DAY), owner: 'Trần Thị Mai Phương', questions30: 48210,
    // Public: anyone with a BoMesh account can join and becomes a member (ListWorkspaces shows name, description and code).
    visibility: 'public',
    description: 'Thông tin tuyển sinh, quy chế đào tạo, học phí, học bổng và giới thiệu ngành của Trường Đại học UTE.',
    template: 'campus',
    // Campus levels plus 'Folder' for the plain sub-folders of offices (Quy chế, Lịch học, Học bổng…).
    mapLevels: ['Faculty', 'Academic department', 'Program group', 'Major', 'Administrative office', 'Forms', 'Folder'],
    // Knowledge map background (set by a workspace admin): a campus illustration, softened behind the atlas.
    mapBg: { src: 'assets/map-backgrounds/ute-campus.svg', name: 'ute-campus.svg', strength: 25, by: 'u-ute-phuong', at: ago(20 * DAY) },
    demo: 'Fictional records made for this prototype. They are not official UTE documents, regulations or people.',
  };
  D.workspaces.push(campus);
  D.pWorkspaces.splice(3, 0, campus);
})();

seedWorkspace('ws-campus', () => {
  const T = (d, h = 0) => NOW + d * DAY + h * HOUR;   // future
  const P = (d, h = 0) => NOW - d * DAY - h * HOUR;   // past
  const EOD = d => { const t = new Date(NOW); t.setHours(23, 59, 0, 0); return t.getTime() + d * DAY; };  // 23:59 in d days
  const V = (by, atDaysAgo, dueInDays) => ({ state: 'verified', by, at: P(atDaysAgo), due: dueInDays == null ? null : T(dueInDays) });

  /* Exact passages the assistant, quizzes, requests and work cite (the Reader puts them on the cited page). */
  const Q = {
    rut: 'Sinh viên được rút học phần đã đăng ký chậm nhất vào cuối tuần thứ 10 của học kỳ; học phần đã rút được ghi W trên bảng điểm và không tính vào điểm trung bình.',
    tinchi: 'Khối lượng đăng ký tối thiểu trong học kỳ chính là 14 tín chỉ; trường hợp thấp hơn phải được Khoa chấp thuận.',
    hoanphi: 'Học phí của học phần đã rút không được hoàn trả, trừ trường hợp lớp học phần bị Nhà trường hủy.',
    nghi: 'Sinh viên đã hoàn thành ít nhất một học kỳ được nghỉ học tạm thời tối đa hai học kỳ trong toàn khóa học.',
    phuckhao: 'Sinh viên được nộp đơn phúc khảo trong vòng 7 ngày kể từ ngày công bố điểm.',
    phuckhaoPhi: 'Lệ phí phúc khảo là 30.000 đồng/học phần và được hoàn lại nếu điểm thay đổi.',
    bangdiem: 'Bảng điểm chính thức được cấp trong 2 ngày làm việc, lệ phí 20.000 đồng/bản.',
    xacnhan: 'Giấy xác nhận sinh viên được cấp miễn phí và nhận tại phòng A1-108 vào ngày làm việc tiếp theo.',
    miengiam: 'Sinh viên thuộc hộ nghèo, hộ cận nghèo hoặc con của người có công được miễn hoặc giảm từ 50% đến 100% học phí.',
    hbkk: 'Học bổng khuyến khích học tập xét cho sinh viên có điểm trung bình học kỳ từ 3,2 trở lên, điểm rèn luyện từ loại Tốt và không có học phần bị điểm F.',
    nf1: 'Lược đồ ở dạng chuẩn 1NF khi mọi thuộc tính chỉ chứa giá trị nguyên tố.',
    nf2: 'Lược đồ ở dạng chuẩn 2NF khi ở 1NF và mọi thuộc tính không khóa phụ thuộc đầy đủ vào khóa chính.',
    nf3: 'Lược đồ ở dạng chuẩn 3NF khi không có thuộc tính không khóa nào phụ thuộc bắc cầu vào khóa chính.',
    bcnf: 'Lược đồ ở dạng chuẩn BCNF khi với mọi phụ thuộc hàm X → Y không tầm thường, X là siêu khóa.',
    tach: 'Phép tách về BCNF luôn bảo toàn thông tin (kết nối không mất mát) nhưng có thể không bảo toàn phụ thuộc hàm.',
    gd: 'Mô hình dự đoán ŷ = wᵀx và được huấn luyện bằng cách cực tiểu sai số bình phương trung bình giữa dự đoán và giá trị thật.',
    alpha: 'Nếu α quá lớn, gradient descent có thể vượt quá điểm cực tiểu và phân kỳ; nếu α quá nhỏ, quá trình hội tụ rất chậm.',
    scale: 'Chuẩn hóa mỗi đặc trưng về trung bình 0 và độ lệch chuẩn 1 trước khi chạy gradient descent.',
  };

  /* ═══════════════ People ═══════════════ */
  D.roles = [
    { id: 'r-admin', name: 'Workspace admin', system: true, desc: 'Full control of this workspace.', perms: ALL_TENANT },
    { id: 'r-member', name: 'Member', system: true, desc: 'Ask questions, browse the knowledge they can access, contribute documents for review and send requests.', perms: ['tenant.read', 'knowledge.read', 'knowledge.contribute'] },
    { id: 'r-gv', name: 'Giảng viên', system: false, desc: 'Phụ trách học liệu của bộ môn: đề cương, bài giảng, đề thi và câu hỏi của sinh viên.', perms: UTE_LECTURER_PERMS },
    { id: 'r-cb', name: 'Cán bộ phòng ban', system: false, desc: 'Xử lý yêu cầu của sinh viên và cập nhật quy định, biểu mẫu của phòng.', perms: ['tenant.read', 'knowledge.read', 'knowledge.contribute', 'knowledge.manage', 'audit.read'] },
  ];
  D.groups = [
    { id: 'g-ute-cntt', name: 'Khoa Công nghệ Thông tin', desc: 'Giảng viên và cán bộ Khoa Công nghệ Thông tin.' },
    { id: 'g-ute-httt', name: 'Bộ môn Hệ thống Thông tin', desc: 'Giảng viên Bộ môn Hệ thống Thông tin.' },
    { id: 'g-ute-ddt', name: 'Khoa Điện – Điện tử', desc: 'Giảng viên và cán bộ Khoa Điện – Điện tử.' },
    { id: 'g-ute-ck', name: 'Khoa Cơ khí Chế tạo máy', desc: 'Giảng viên và cán bộ Khoa Cơ khí Chế tạo máy.' },
    { id: 'g-ute-pdt', name: 'Phòng Đào tạo', desc: 'Kế hoạch đào tạo, đăng ký học phần, thi và học vụ.' },
    { id: 'g-ute-ctsv', name: 'Phòng Công tác Sinh viên', desc: 'Học bổng, rèn luyện, ký túc xá và hỗ trợ sinh viên.' },
    { id: 'g-ute-tccb', name: 'Phòng Tổ chức Cán bộ', desc: 'Tuyển dụng, hợp đồng và đánh giá viên chức.' },
    { id: 'g-ute-k22', name: 'Sinh viên K22 · CNTT', desc: 'Sinh viên ngành Công nghệ Thông tin khóa 2022.' },
    { id: 'g-ute-k23', name: 'Sinh viên K23 · Điện – Điện tử', desc: 'Sinh viên ngành Kỹ thuật Điện tử – Viễn thông khóa 2023.' },
    { id: 'g-ute-k25', name: 'Tân sinh viên K25 · CNTT', desc: 'Sinh viên năm nhất ngành Công nghệ Thông tin khóa 2025.' },
  ];
  D.members = [
    ['u-ute-phuong', 'Trần Thị Mai Phương', 'phuongttm@ute.edu.vn', 'r-admin', ['g-ute-pdt'], 4 * MIN, 150],
    ['u-ute-hung', 'Lê Văn Hùng', 'hunglv@ute.edu.vn', 'r-gv', ['g-ute-cntt', 'g-ute-httt'], 20 * MIN, 140],
    ['u-ute-thao', 'Đỗ Phương Thảo', 'thaodp@ute.edu.vn', 'r-gv', ['g-ute-cntt'], 2 * HOUR, 135],
    ['u-ute-tuan', 'Ngô Minh Tuấn', 'tuannm@ute.edu.vn', 'r-gv', ['g-ute-ddt'], 5 * HOUR, 130],
    ['u-ute-son', 'Phạm Thanh Sơn', 'sonpt@ute.edu.vn', 'r-gv', ['g-ute-ck'], 1 * DAY, 128],
    ['u-ute-quan', 'Huỳnh Minh Quân', 'quanhm@ute.edu.vn', 'r-cb', ['g-ute-pdt'], 30 * MIN, 145],
    ['u-ute-ngoc', 'Lâm Bảo Ngọc', 'ngoclb@ute.edu.vn', 'r-cb', ['g-ute-ctsv'], 3 * HOUR, 145],
    ['u-ute-hien', 'Đặng Thu Hiền', 'hiendt@ute.edu.vn', 'r-cb', ['g-ute-tccb'], 6 * HOUR, 120],
    ['u-ute-anh', 'Nguyễn Minh Anh', '22110101@student.ute.edu.vn', 'r-member', ['g-ute-k22'], 6 * MIN, 100],
    ['u-ute-huy', 'Đặng Quốc Huy', '22110145@student.ute.edu.vn', 'r-member', ['g-ute-k22'], 50 * MIN, 100],
    ['u-ute-vy', 'Trần Thảo Vy', '22110187@student.ute.edu.vn', 'r-member', ['g-ute-k22'], 2 * HOUR, 100],
    ['u-ute-khoa', 'Phan Đăng Khoa', '22110033@student.ute.edu.vn', 'r-member', ['g-ute-k22'], 9 * HOUR, 100],
    ['u-ute-linh', 'Bùi Gia Linh', '23142060@student.ute.edu.vn', 'r-member', ['g-ute-k23'], 1 * DAY, 90],
    ['u-ute-bao', 'Trương Gia Bảo', '25110072@student.ute.edu.vn', 'r-member', ['g-ute-k25'], 10 * MIN, 2],
    ['u-ute-tam', 'Võ Thanh Tâm', '21110412@student.ute.edu.vn', 'r-member', [], 26 * DAY, 140, 'suspended'],
  ].map(([id, name, email, roleId, groups, last, joinedDays, status = 'active']) => ({ id, name, email, roleId, groups, status, lastActive: ago(last), joined: ago(joinedDays * DAY) }));
  /* Applicants and parents with personal email who joined through the public link: ordinary members (Member role). */
  D.members.push(...[
    ['u-ute-khanh', 'Phạm Gia Khánh', 'giakhanh.pham2008@gmail.com', 15 * MIN, 3],
    ['u-ute-v-ha', 'Lê Thị Thu Hà', 'thuha.le1979@gmail.com', 2 * HOUR, 6],
    ['u-ute-v-manh', 'Ngô Đức Mạnh', 'manhngo.2008@gmail.com', 5 * HOUR, 9],
    ['u-ute-v-ngoc', 'Trần Bảo Ngọc', 'baongoc.tran08@yahoo.com', 1 * DAY, 12],
    ['u-ute-v-phuc', 'Nguyễn Hoàng Phúc', 'hoangphuc.nguyen@outlook.com', 3 * DAY, 20],
    ['u-ute-v-thu', 'Võ Minh Thư', 'minhthu.vo2008@gmail.com', 6 * DAY, 31],
  ].map(([id, name, email, last, joinedDays]) => ({ id, name, email, roleId: 'r-member', groups: [], status: 'active', lastActive: ago(last), joined: ago(joinedDays * DAY) })));
  D.knownAccounts = ['22110402@student.ute.edu.vn', 'minhtd@ute.edu.vn', 'hoanglt@ute.edu.vn'];

  /* ═══════════════ Knowledge: root collections ═══════════════
     access = role each demo persona holds: owner|editor|viewer|none (visible, locked)|null (hidden). The admin owns everything.
     level = the root's place in the workspace's level vocabulary (mapLevels): Faculty or Administrative office. */
  const ALL = { student: 'viewer', lecturer: 'viewer' };
  D.kbs = [
    { id: 'kb-ute-mine', name: 'Tệp của tôi', personal: true, desc: 'Chỉ bạn xem được. Dùng trong các cuộc trò chuyện và công việc của bạn.', color: '#4F5865', general: 'private', shares: [], updated: P(1) },
    { id: 'kb-ute-cntt', name: 'Khoa Công nghệ Thông tin', level: 'Faculty', desc: 'Chương trình đào tạo, đề cương, bài giảng, đề thi và khóa luận của các bộ môn Khoa CNTT.', color: '#2F6FB5', general: 'workspace', access: { student: 'viewer', lecturer: 'owner' }, shares: [{ kind: 'user', id: 'u-ute-hung', role: 'owner' }, { kind: 'group', id: 'g-ute-cntt', role: 'editor' }], updated: P(0, 4) },
    { id: 'kb-ute-ddt', name: 'Khoa Điện – Điện tử', level: 'Faculty', desc: 'Học liệu Điện tử – Viễn thông, Hệ thống nhúng & IoT và Điện công nghiệp.', color: '#C2620F', general: 'workspace', access: { ...ALL }, shares: [{ kind: 'group', id: 'g-ute-ddt', role: 'owner' }], updated: P(2, 3) },
    { id: 'kb-ute-ck', name: 'Khoa Cơ khí Chế tạo máy', level: 'Faculty', desc: 'Học liệu Chế tạo máy, Cơ điện tử, Robot & Tự động hóa và nội quy xưởng.', color: '#4E6B2E', general: 'workspace', access: { ...ALL }, shares: [{ kind: 'group', id: 'g-ute-ck', role: 'owner' }], updated: P(5) },
    { id: 'kb-ute-pdt', name: 'Phòng Đào tạo', level: 'Administrative office', desc: 'Tuyển sinh, quy chế đào tạo, lịch học, lịch thi, học phí và mẫu đơn học vụ.', color: '#1F5FAD', general: 'workspace', access: { ...ALL }, shares: [{ kind: 'group', id: 'g-ute-pdt', role: 'owner' }], updated: P(0, 6) },
    { id: 'kb-ute-ctsv', name: 'Phòng Công tác Sinh viên', level: 'Administrative office', desc: 'Học bổng, điểm rèn luyện, ký túc xá, miễn giảm học phí và giấy xác nhận.', color: '#B4467A', general: 'workspace', access: { ...ALL }, shares: [{ kind: 'group', id: 'g-ute-ctsv', role: 'owner' }], updated: P(1, 2) },
    { id: 'kb-ute-cntt-gt', name: 'Giới thiệu ngành Khoa CNTT', level: 'Faculty', desc: 'Chương trình đào tạo, chuẩn đầu ra, cơ hội nghề nghiệp và câu hỏi thường gặp của các ngành Khoa CNTT, dành cho thí sinh.', color: '#0E7C66', general: 'workspace', access: { student: 'viewer', lecturer: 'owner' }, shares: [{ kind: 'user', id: 'u-ute-hung', role: 'owner' }, { kind: 'group', id: 'g-ute-cntt', role: 'editor' }], updated: P(2, 1) },
    { id: 'kb-ute-nhansu', name: 'Hồ sơ nhân sự', level: 'Administrative office', desc: 'Tuyển dụng, hợp đồng và đánh giá viên chức. Chỉ Phòng Tổ chức Cán bộ và Ban Giám hiệu.', color: '#A23B3B', general: 'restricted', access: { student: 'none', lecturer: 'none' }, shares: [{ kind: 'group', id: 'g-ute-tccb', role: 'owner' }], updated: P(4) },
    { id: 'kb-ute-bgh', name: 'Ban Giám hiệu', level: 'Administrative office', desc: 'Kế hoạch chiến lược, ngân sách và biên bản họp Ban Giám hiệu.', color: '#4F5865', general: 'restricted', access: { student: null, lecturer: null }, shares: [{ kind: 'user', id: 'u-ute-phuong', role: 'owner' }], updated: P(9) },
  ];
  const UNIT = { 'kb-ute-cntt': 'Khoa Công nghệ Thông tin', 'kb-ute-cntt-gt': 'Khoa Công nghệ Thông tin', 'kb-ute-ddt': 'Khoa Điện – Điện tử', 'kb-ute-ck': 'Khoa Cơ khí Chế tạo máy', 'kb-ute-pdt': 'Phòng Đào tạo', 'kb-ute-ctsv': 'Phòng Công tác Sinh viên', 'kb-ute-nhansu': 'Phòng Tổ chức Cán bộ', 'kb-ute-bgh': 'Ban Giám hiệu' };
  const KB_TOPICS = { 'kb-ute-cntt': ['t-ctdt'], 'kb-ute-cntt-gt': ['t-ctdt', 't-tuyensinh'], 'kb-ute-ddt': ['t-ctdt'], 'kb-ute-ck': ['t-ctdt'], 'kb-ute-pdt': ['t-quyche', 't-tuyensinh'], 'kb-ute-ctsv': ['t-hocbong'], 'kb-ute-nhansu': ['t-nhansu'], 'kb-ute-bgh': ['t-quantri'] };
  // A first-year student and an applicant who joined read what every student reads.
  D.kbs.forEach(k => {
    if (UNIT[k.id]) Object.assign(k, { unit: UNIT[k.id], topics: KB_TOPICS[k.id] });
    if (k.access && 'student' in k.access) Object.assign(k.access, { newstudent: k.access.student, applicant: k.access.student });
  });

  /* ═══════════════ Knowledge map: folders (Khoa › Bộ môn › Nhóm ngành › Chuyên ngành; offices › folders; Biểu mẫu) ═══════════════
     Depth defaults name the level (root = Faculty, then Academic department, Program group, Major); `level` overrides it. */
  const F = (id, kb, parent, name, desc, o = {}) => ({ id, kb, parent, name, ...(desc ? { desc } : {}), ...o });
  D.folders = [
    // Khoa Công nghệ Thông tin
    F('f-ute-cntt-httt', 'kb-ute-cntt', null, 'Bộ môn Hệ thống Thông tin', 'Cơ sở dữ liệu, phân tích thiết kế hệ thống và khoa học dữ liệu.', { order: 1 }),
    F('f-ute-cntt-nganh', 'kb-ute-cntt', 'f-ute-cntt-httt', 'Nhóm ngành Máy tính và Công nghệ Thông tin', 'Các chuyên ngành do Bộ môn phụ trách.'),
    F('f-ute-cntt-ht', 'kb-ute-cntt', 'f-ute-cntt-nganh', 'Chuyên ngành Hệ thống Thông tin', 'Đề cương, bài giảng, lab, đề thi và khóa luận.', { order: 1 }),
    F('f-ute-cntt-khdl', 'kb-ute-cntt', 'f-ute-cntt-nganh', 'Chuyên ngành Khoa học Dữ liệu', 'Học máy, bài tập lớn, đề thi và khóa luận.', { order: 2 }),
    F('f-ute-cntt-ktpm', 'kb-ute-cntt', null, 'Bộ môn Kỹ thuật Phần mềm', 'Quy trình phát triển, kiểm thử và đồ án phần mềm.', { order: 2 }),
    F('f-ute-cntt-cnpm', 'kb-ute-cntt', 'f-ute-cntt-ktpm', 'Chuyên ngành Công nghệ Phần mềm', null, { level: 'Major' }),
    F('f-ute-cntt-mmt', 'kb-ute-cntt', null, 'Bộ môn Mạng máy tính & An toàn Thông tin', 'Mạng máy tính, định tuyến và bảo mật.', { order: 3 }),
    F('f-ute-cntt-bieumau', 'kb-ute-cntt', null, 'Biểu mẫu Khoa CNTT', 'Mẫu đơn khóa luận, thực tập và bảo vệ.', { level: 'Forms', order: 9 }),
    // Khoa Điện – Điện tử
    F('f-ute-ddt-dtvt', 'kb-ute-ddt', null, 'Bộ môn Điện tử – Viễn thông', 'Điện tử, hệ thống nhúng và viễn thông.', { order: 1 }),
    F('f-ute-ddt-nganh', 'kb-ute-ddt', 'f-ute-ddt-dtvt', 'Nhóm ngành Kỹ thuật Điện, Điện tử và Viễn thông'),
    F('f-ute-ddt-nhung', 'kb-ute-ddt', 'f-ute-ddt-nganh', 'Chuyên ngành Hệ thống Nhúng & IoT', 'Vi điều khiển, cảm biến và IoT.', { order: 1 }),
    F('f-ute-ddt-vt', 'kb-ute-ddt', 'f-ute-ddt-nganh', 'Chuyên ngành Kỹ thuật Viễn thông', 'Thông tin số và mạng di động.', { order: 2 }),
    F('f-ute-ddt-dcn', 'kb-ute-ddt', null, 'Bộ môn Điện công nghiệp', 'Máy điện, PLC và an toàn điện.', { order: 2 }),
    F('f-ute-ddt-bieumau', 'kb-ute-ddt', null, 'Biểu mẫu Khoa Điện – Điện tử', 'Đăng ký phòng thí nghiệm và mượn thiết bị.', { level: 'Forms', order: 9 }),
    // Khoa Cơ khí Chế tạo máy
    F('f-ute-ck-ctm', 'kb-ute-ck', null, 'Bộ môn Chế tạo máy', 'Công nghệ chế tạo, CNC và an toàn xưởng.', { order: 1 }),
    F('f-ute-ck-cdt', 'kb-ute-ck', null, 'Bộ môn Cơ điện tử', 'Cơ điện tử, robot và tự động hóa.', { order: 2 }),
    F('f-ute-ck-robot', 'kb-ute-ck', 'f-ute-ck-cdt', 'Chuyên ngành Robot & Tự động hóa', null, { level: 'Major' }),
    F('f-ute-ck-bieumau', 'kb-ute-ck', null, 'Biểu mẫu Khoa Cơ khí', 'Đăng ký xưởng và đề xuất vật tư.', { level: 'Forms', order: 9 }),
    // Phòng Đào tạo
    F('f-ute-pdt-tuyensinh', 'kb-ute-pdt', null, 'Tuyển sinh', 'Thông báo tuyển sinh, điểm chuẩn và hồ sơ nhập học.', { level: 'Folder', order: 0 }),
    F('f-ute-pdt-quyche', 'kb-ute-pdt', null, 'Quy chế & quy định', 'Quy chế đào tạo, đăng ký học phần, học vụ và tốt nghiệp.', { level: 'Folder', order: 1 }),
    F('f-ute-pdt-lich', 'kb-ute-pdt', null, 'Lịch học & lịch thi', 'Lịch năm học, thời khóa biểu và lịch thi.', { level: 'Folder', order: 2 }),
    F('f-ute-pdt-hocphi', 'kb-ute-pdt', null, 'Học phí', 'Biểu học phí và cách nộp.', { level: 'Folder', order: 3 }),
    F('f-ute-pdt-bieumau', 'kb-ute-pdt', null, 'Biểu mẫu Phòng Đào tạo', 'Mẫu đơn học vụ: nghỉ học, phúc khảo, rút học phần, bảng điểm…', { level: 'Forms', order: 9 }),
    F('f-ute-pdt-sohoa', 'kb-ute-pdt', null, 'Văn bản số hóa 2015–2024', 'Văn bản cũ được quét và tải lên hàng loạt; xử lý dần theo đợt.', { level: 'Folder', order: 10 }),
    // Phòng Công tác Sinh viên
    F('f-ute-ctsv-hocbong', 'kb-ute-ctsv', null, 'Học bổng', 'Quy định, hồ sơ và kết quả xét học bổng.', { level: 'Folder', order: 1 }),
    F('f-ute-ctsv-renluyen', 'kb-ute-ctsv', null, 'Rèn luyện & nơi ở', 'Điểm rèn luyện, ngoại trú và ký túc xá.', { level: 'Folder', order: 2 }),
    F('f-ute-ctsv-hotro', 'kb-ute-ctsv', null, 'Miễn giảm & hỗ trợ', 'Miễn, giảm học phí và vay vốn.', { level: 'Folder', order: 3 }),
    F('f-ute-ctsv-bieumau', 'kb-ute-ctsv', null, 'Biểu mẫu Phòng CTSV', 'Giấy xác nhận, đơn miễn giảm, trợ cấp và ký túc xá.', { level: 'Forms', order: 9 }),
    // Hồ sơ nhân sự (restricted)
    F('f-ute-ns-hd', 'kb-ute-nhansu', null, 'Hợp đồng & quyết định', null, { level: 'Folder', order: 1 }),
    F('f-ute-ns-danhgia', 'kb-ute-nhansu', null, 'Đánh giá viên chức', null, { level: 'Folder', order: 2 }),
    // Ban Giám hiệu (hidden)
    F('f-ute-bgh-hop', 'kb-ute-bgh', null, 'Biên bản họp 2026', null, { level: 'Folder' }),
  ];

  /* ═══════════════ Knowledge: documents ═══════════════
     row = [id, name, topics, summary?, opts?]; opts: upd (days ago), due (verification due in days; null = no expiry),
     verify:false, upload (not synced), by (who added it), status, error, contexts, pages. */
  const SRC = { 'kb-ute-pdt': ['src-ute-pdt', 'Drive Phòng Đào tạo'], 'kb-ute-cntt': ['src-ute-cntt', 'Drive Khoa CNTT'] };
  const PAGES = { xlsx: [1, 1], md: [2, 6], pdf: [3, 28], pptx: [14, 42], docx: [1, 2], png: [1, 1] };
  const put = (kb, folder, rows) => rows.forEach(([id, name, topics, summary = '', o = {}]) => {
    const h = hashOf(id), ext = name.split('.').pop().toLowerCase(), [lo, hi] = PAGES[ext] || [2, 10];
    const upd = o.upd ?? 6 + (h % 240), src = !o.upload && SRC[kb];
    const d = mkDoc(kb, id, name, { source: src ? src[0] : 'upload', addedBy: src ? src[1] : o.by || UNIT[kb], pages: o.pages || lo + (h % (hi - lo + 1)), size: Math.round(36e3 + (h % 2600) * 870), updated: P(upd, h % 9), passages: 12 + (h % 280), status: o.status, error: o.error });
    const due = o.due !== undefined ? o.due : h % 11 === 4 ? -(3 + (h % 30)) : 60 + (h % 300);
    Object.assign(d, {
      topics: topics.split(' '), lang: 'vi', views: 5 + (h % 420),
      ...(summary ? { summary } : {}), ...(folder ? { folder } : {}), ...(o.contexts ? { contexts: o.contexts } : {}),
      ...(o.verify !== false ? { verify: V(UNIT[kb], upd, due) } : {}),
    });
    D.docs.push(d);
  });
  D.docs = [
    mkDoc('kb-ute-mine', 'ute-me-1', 'Ghi chú ôn tập Chương 5 — Chuẩn hóa.md', { addedBy: 'You', updated: P(3), pages: 2, size: 9e3, passages: 8 }),
    mkDoc('kb-ute-mine', 'ute-me-2', 'CV — Nguyễn Minh Anh.pdf', { addedBy: 'You', updated: P(20), pages: 2, size: 180e3, passages: 10 }),
    mkDoc('kb-ute-mine', 'ute-me-3', 'Ảnh chụp bảng — Lab 3.png', { addedBy: 'You', updated: P(6), pages: 1, size: 2.1e6, passages: 1, status: 'unsupported' }),
  ];

  /* ── Khoa Công nghệ Thông tin ── */
  put('kb-ute-cntt', null, [
    ['ute-cntt-intro', 'Giới thiệu Khoa Công nghệ Thông tin.pdf', 't-ctdt', 'Lịch sử, các bộ môn, ngành đào tạo, phòng thí nghiệm và cách liên hệ Văn phòng Khoa.', { due: null }],
    ['ute-cntt-ctdt', 'Chương trình đào tạo ngành Công nghệ Thông tin — K2022.pdf', 't-ctdt t-totnghiep', '150 tín chỉ, chuẩn đầu ra và kế hoạch học tập 8 học kỳ của ngành Công nghệ Thông tin khóa 2022.'],
    ['ute-cntt-thuctap', 'Quy định thực tập tốt nghiệp — Khoa CNTT.pdf', 't-totnghiep', 'Điều kiện đi thực tập, thời gian 8 tuần, nhật ký thực tập và cách chấm điểm.'],
    ['ute-cntt-lichtiep', 'Lịch tiếp sinh viên của Văn phòng Khoa HK1 2026–2027.pdf', 't-dangky', 'Giờ tiếp sinh viên của Văn phòng Khoa và cố vấn học tập trong học kỳ 1.', { upd: 40, upload: true }],
  ]);
  put('kb-ute-cntt', 'f-ute-cntt-httt', [
    ['ute-httt-intro', 'Giới thiệu Bộ môn Hệ thống Thông tin.pdf', 't-db t-ctdt', 'Giảng viên, học phần phụ trách, hướng nghiên cứu và phòng lab của Bộ môn Hệ thống Thông tin.', { due: null }],
    ['ute-httt-detai', 'Danh mục đề tài khóa luận 2026–2027 — Bộ môn HTTT.xlsx', 't-khoaluan t-db', 'Đề tài khóa luận được duyệt, giảng viên hướng dẫn và số sinh viên tối đa cho mỗi đề tài.', { upd: 12 }],
    ['ute-httt-kehoach', 'Kế hoạch giảng dạy HK1 2026–2027 — Bộ môn HTTT.xlsx', 't-dangky', 'Phân công giảng dạy, phòng học và lịch thi giữa kỳ của các học phần trong Bộ môn.', { upd: 70 }],
  ]);
  put('kb-ute-cntt', 'f-ute-cntt-nganh', [
    ['ute-nganh-cdr', 'Chuẩn đầu ra nhóm ngành Máy tính và Công nghệ Thông tin 2026.pdf', 't-ctdt', 'Kiến thức, kỹ năng và mức tự chủ sinh viên nhóm ngành Máy tính và CNTT đạt được khi tốt nghiệp.'],
  ]);
  put('kb-ute-cntt', 'f-ute-cntt-ht', [
    ['ute-csdl-syl', 'Đề cương học phần IT3090 — Cơ sở dữ liệu.pdf', 't-decuong t-db', 'Mục tiêu, nội dung 15 tuần, đánh giá (quá trình 30%, giữa kỳ 20%, cuối kỳ 50%) và tài liệu học phần Cơ sở dữ liệu.', { contexts: ['sp-ute-csdl'] }],
    ['ute-csdl-c3', 'Chương 3 — Đại số quan hệ.pdf', 't-baigiang t-db', 'Phép chọn, chiếu, kết nối, hợp, hiệu và phép chia, với ví dụ trên cơ sở dữ liệu quản lý sinh viên.', { contexts: ['sp-ute-csdl'], upd: 42 }],
    ['ute-csdl-c5', 'Chương 5 — Chuẩn hóa lược đồ quan hệ (1NF–BCNF).pdf', 't-baigiang t-db', 'Phụ thuộc hàm, các dạng chuẩn 1NF, 2NF, 3NF, BCNF và phép tách lược đồ.', { contexts: ['sp-ute-csdl'], upd: 14, pages: 24 }],
    ['ute-csdl-lab3', 'Lab 3 — Truy vấn SQL nâng cao.md', 't-thuchanh t-db', 'Truy vấn lồng, GROUP BY … HAVING, CTE và hàm cửa sổ trên cơ sở dữ liệu đăng ký học phần.', { contexts: ['sp-ute-csdl'], upd: 6 }],
    ['ute-csdl-de2025', 'Đề thi giữa kỳ Cơ sở dữ liệu 2025 (có đáp án).pdf', 't-dethi t-db', 'Đề thi giữa kỳ năm 2025 gồm 5 câu về đại số quan hệ, SQL và chuẩn hóa, kèm đáp án.', { contexts: ['sp-ute-csdl'], due: null }],
    ['ute-pttk-syl', 'Đề cương học phần IT3170 — Phân tích thiết kế hệ thống thông tin.pdf', 't-decuong t-db', 'Mục tiêu, nội dung và cách đánh giá học phần Phân tích thiết kế hệ thống thông tin.'],
    ['ute-pttk-c2', 'Chương 2 — Mô hình hóa nghiệp vụ với UML.pptx', 't-baigiang t-db', 'Biểu đồ use case, hoạt động và lớp cho một hệ thống quản lý thư viện.'],
    ['ute-kl-ktx', 'Khóa luận — Hệ thống quản lý ký túc xá trên nền tảng web (2025).pdf', 't-khoaluan t-db', 'Khóa luận tốt nghiệp 2025: phân tích, thiết kế và xây dựng hệ thống quản lý ký túc xá.', { upload: true, by: 'Lê Văn Hùng', due: null }],
    ['ute-kl-dw', 'Khóa luận — Kho dữ liệu phân tích kết quả học tập sinh viên (2025).pdf', 't-khoaluan t-db t-ml', 'Khóa luận tốt nghiệp 2025: kho dữ liệu và báo cáo phân tích kết quả học tập theo khóa, ngành.', { upload: true, by: 'Lê Văn Hùng', due: null }],
  ]);
  put('kb-ute-cntt', 'f-ute-cntt-khdl', [
    ['ute-ml-syl', 'Đề cương học phần IT4071 — Học máy.pdf', 't-decuong t-ml', 'Học máy có giám sát, đánh giá mô hình và mạng nơ-ron; đánh giá gồm bài tập lớn 30%, giữa kỳ 20%, cuối kỳ 50%.', { contexts: ['sp-ute-ml'] }],
    ['ute-ml-w02', 'Tuần 2 — Hồi quy tuyến tính và gradient descent.pdf', 't-baigiang t-ml', 'Mô hình hồi quy tuyến tính, hàm mất mát MSE, phương trình chuẩn và gradient descent.', { contexts: ['sp-ute-ml'], upd: 49, pages: 32 }],
    ['ute-ml-w04', 'Tuần 4 — Chính quy hóa và đánh đổi bias–variance.pdf', 't-baigiang t-ml', 'Quá khớp, chính quy hóa L1/L2, chọn λ bằng kiểm định chéo và đánh đổi bias–variance.', { contexts: ['sp-ute-ml'], upd: 35, pages: 26 }],
    ['ute-ml-w06', 'Tuần 6 — Mạng nơ-ron.pptx', 't-baigiang t-ml', 'Perceptron nhiều lớp, hàm kích hoạt và lan truyền ngược.', { contexts: ['sp-ute-ml'], upd: 21 }],
    ['ute-ml-lab2', 'Lab 2 — Cài đặt gradient descent từ đầu.md', 't-thuchanh t-ml', 'Cài đặt gradient descent bằng NumPy, chuẩn hóa đặc trưng và vẽ đường cong mất mát.', { contexts: ['sp-ute-ml'], upd: 45 }],
    ['ute-ml-a1', 'Bài tập lớn 1 — Dự đoán giá nhà.pdf', 't-thuchanh t-ml', 'Xây dựng mô hình hồi quy dự đoán giá nhà tại TP.HCM, báo cáo và mã nguồn nộp theo nhóm.', { contexts: ['sp-ute-ml'], upd: 12 }],
    ['ute-ml-de2025', 'Đề thi cuối kỳ Học máy 2025.pdf', 't-dethi t-ml', 'Đề thi cuối kỳ năm 2025, 90 phút, gồm 4 câu tự luận.', { contexts: ['sp-ute-ml'], due: null }],
    ['ute-kl-lua', 'Khóa luận — Nhận diện bệnh lá lúa bằng học chuyển giao (2025).pdf', 't-khoaluan t-ml t-nckh', 'Khóa luận tốt nghiệp 2025: tinh chỉnh MobileNetV3 trên 4.800 ảnh lá lúa thu thập ở Đồng bằng sông Cửu Long.', { upload: true, by: 'Đỗ Phương Thảo', due: null, contexts: ['sp-ute-nckh'] }],
  ]);
  put('kb-ute-cntt', 'f-ute-cntt-ktpm', [
    ['ute-ktpm-intro', 'Giới thiệu Bộ môn Kỹ thuật Phần mềm.pdf', 't-se t-ctdt', 'Giảng viên, học phần và hướng nghiên cứu của Bộ môn Kỹ thuật Phần mềm.', { due: null }],
    ['ute-ktpm-doan', 'Hướng dẫn thực hiện đồ án phần mềm.pdf', 't-khoaluan t-se', 'Lập nhóm, chọn đề tài, các mốc nộp báo cáo và tiêu chí chấm đồ án phần mềm.'],
  ]);
  put('kb-ute-cntt', 'f-ute-cntt-cnpm', [
    ['ute-cnpm-syl', 'Đề cương học phần IT3120 — Công nghệ phần mềm.pdf', 't-decuong t-se', 'Quy trình phát triển phần mềm, yêu cầu, thiết kế, kiểm thử và quản lý dự án.'],
    ['ute-cnpm-c4', 'Chương 4 — Kiểm thử phần mềm.pptx', 't-baigiang t-se', 'Kiểm thử đơn vị, tích hợp, hệ thống và kỹ thuật thiết kế ca kiểm thử.'],
    ['ute-cnpm-lab5', 'Lab 5 — Kiểm thử tự động với Selenium.md', 't-thuchanh t-se', 'Viết kịch bản kiểm thử giao diện web với Selenium và chạy trên GitHub Actions.'],
    ['ute-cnpm-de2025', 'Đề thi cuối kỳ Công nghệ phần mềm 2025.pdf', 't-dethi t-se', 'Đề thi cuối kỳ năm 2025 với tình huống phân tích yêu cầu và thiết kế ca kiểm thử.', { due: null }],
    ['ute-kl-app', 'Đồ án — Ứng dụng di động đặt lịch phòng lab (2026).pdf', 't-khoaluan t-se', 'Đồ án 2026: ứng dụng Flutter đặt lịch phòng lab, có thông báo và thống kê sử dụng.', { upload: true, by: 'Đỗ Phương Thảo', due: null }],
  ]);
  put('kb-ute-cntt', 'f-ute-cntt-mmt', [
    ['ute-mmt-intro', 'Giới thiệu Bộ môn Mạng máy tính & An toàn Thông tin.pdf', 't-net t-ctdt', 'Giảng viên, học phần, phòng lab mạng và các chứng chỉ sinh viên có thể thi.', { due: null }],
    ['ute-mmt-syl', 'Đề cương học phần IT3150 — Mạng máy tính.pdf', 't-decuong t-net', 'Mô hình OSI/TCP-IP, địa chỉ IP, định tuyến, chuyển mạch và cách đánh giá học phần.'],
    ['ute-mmt-c6', 'Chương 6 — Định tuyến và giao thức OSPF.pdf', 't-baigiang t-net', 'Định tuyến tĩnh, định tuyến động và cấu hình OSPF một vùng.'],
    ['ute-mmt-lab4', 'Lab 4 — Cấu hình VLAN trên Packet Tracer.md', 't-thuchanh t-net', 'Tạo VLAN, trunking và định tuyến giữa các VLAN trên Cisco Packet Tracer.'],
    ['ute-mmt-de2025', 'Đề thi giữa kỳ Mạng máy tính 2025.pdf', 't-dethi t-net', 'Đề thi giữa kỳ năm 2025 về chia mạng con và định tuyến.', { due: null }],
  ]);
  put('kb-ute-cntt', 'f-ute-cntt-bieumau', [
    ['ute-cntt-f-detai', 'Đơn đăng ký đề tài khóa luận tốt nghiệp.docx', 't-bieumau t-khoaluan', 'Nộp cho Bộ môn trước tuần thứ 3 của học kỳ cuối, có chữ ký của giảng viên hướng dẫn.'],
    ['ute-cntt-f-cham', 'Phiếu chấm khóa luận tốt nghiệp.docx', 't-bieumau t-khoaluan', 'Phiếu chấm dùng cho giảng viên hướng dẫn, phản biện và hội đồng.'],
    ['ute-cntt-f-thuctap', 'Đơn xin giới thiệu thực tập doanh nghiệp.docx', 't-bieumau t-totnghiep', 'Đề nghị Khoa cấp giấy giới thiệu đến doanh nghiệp nhận thực tập.'],
    ['ute-cntt-f-baove', 'Đơn đề nghị bảo vệ khóa luận.docx', 't-bieumau t-khoaluan', 'Đăng ký bảo vệ khóa luận trước hội đồng, kèm xác nhận của giảng viên hướng dẫn.'],
  ]);

  /* ── Giới thiệu ngành Khoa CNTT (Public: what the faculty publishes for applicants) ── */
  put('kb-ute-cntt-gt', null, [
    ['ute-gt-cntt', 'Ngành Công nghệ Thông tin — chương trình và cơ hội nghề nghiệp.pdf', 't-ctdt t-tuyensinh', 'Bốn năm học gì, các chuyên ngành, phòng lab, thực tập doanh nghiệp và việc làm sau tốt nghiệp.', { due: null, upd: 30 }],
    ['ute-gt-khdl', 'Ngành Khoa học Dữ liệu — giới thiệu cho thí sinh.pdf', 't-ctdt t-tuyensinh', 'Ngành Khoa học Dữ liệu học gì, tổ hợp xét tuyển và các vị trí việc làm.', { due: null, upd: 30 }],
    ['ute-gt-ktpm', 'Ngành Kỹ thuật Phần mềm — giới thiệu cho thí sinh.pptx', 't-ctdt t-tuyensinh', 'Chương trình, dự án thực tế và doanh nghiệp đối tác của ngành Kỹ thuật Phần mềm.', { due: null, upd: 45 }],
    ['ute-gt-faq', 'Câu hỏi thường gặp của thí sinh — Khoa CNTT.md', 't-tuyensinh', 'Tổ hợp môn, chọn chuyên ngành, chương trình chất lượng cao và học bổng đầu vào.', { upd: 8 }],
  ]);

  /* ── Khoa Điện – Điện tử ── */
  put('kb-ute-ddt', null, [
    ['ute-ddt-intro', 'Giới thiệu Khoa Điện – Điện tử.pdf', 't-ctdt t-elec', 'Các bộ môn, ngành đào tạo, phòng thí nghiệm và hợp tác doanh nghiệp của Khoa Điện – Điện tử.', { due: null }],
    ['ute-ddt-ctdt', 'Chương trình đào tạo ngành Kỹ thuật Điện tử – Viễn thông — K2023.pdf', 't-ctdt', '150 tín chỉ, chuẩn đầu ra và kế hoạch học tập của ngành Kỹ thuật Điện tử – Viễn thông khóa 2023.'],
  ]);
  put('kb-ute-ddt', 'f-ute-ddt-dtvt', [
    ['ute-dtvt-intro', 'Giới thiệu Bộ môn Điện tử – Viễn thông.pdf', 't-iot t-ctdt', 'Giảng viên, học phần và phòng thí nghiệm nhúng, viễn thông của Bộ môn.', { due: null }],
  ]);
  put('kb-ute-ddt', 'f-ute-ddt-nganh', [
    ['ute-ddt-cdr', 'Chuẩn đầu ra nhóm ngành Kỹ thuật Điện, Điện tử và Viễn thông 2026.pdf', 't-ctdt', 'Chuẩn đầu ra chung của các chuyên ngành thuộc nhóm ngành Kỹ thuật Điện, Điện tử và Viễn thông.'],
  ]);
  put('kb-ute-ddt', 'f-ute-ddt-nhung', [
    ['ute-nhung-syl', 'Đề cương học phần EE3410 — Vi điều khiển.pdf', 't-decuong t-iot', 'Kiến trúc ARM Cortex-M, GPIO, ngắt, timer và giao tiếp UART/I2C/SPI.'],
    ['ute-nhung-c3', 'Chương 3 — Lập trình ngắt và timer trên ARM Cortex-M.pdf', 't-baigiang t-iot', 'Bảng vector ngắt, ưu tiên ngắt và cấu hình timer tạo PWM.'],
    ['ute-nhung-lab2', 'Lab 2 — Đọc cảm biến độ ẩm đất với ESP32.md', 't-thuchanh t-iot', 'Đọc cảm biến điện dung qua ADC, hiệu chuẩn và gửi dữ liệu lên MQTT.'],
    ['ute-nhung-de2025', 'Đề thi cuối kỳ Vi điều khiển 2025.pdf', 't-dethi t-iot', 'Đề thi cuối kỳ năm 2025 gồm phần lý thuyết và bài lập trình ngắt.', { due: null }],
    ['ute-kl-tuoi', 'Khóa luận — Hệ thống tưới tiêu thông minh dùng LoRaWAN (2025).pdf', 't-khoaluan t-iot t-nckh', 'Khóa luận tốt nghiệp 2025: mạng cảm biến LoRaWAN điều khiển tưới cho ruộng lúa, tiết kiệm 23% lượng nước.', { upload: true, by: 'Ngô Minh Tuấn', due: null }],
  ]);
  put('kb-ute-ddt', 'f-ute-ddt-vt', [
    ['ute-vt-syl', 'Đề cương học phần EE3520 — Thông tin số.pdf', 't-decuong t-elec', 'Lấy mẫu, mã hóa, điều chế số và đánh giá chất lượng kênh truyền.'],
    ['ute-vt-c5', 'Chương 5 — Mạng di động 5G.pptx', 't-baigiang t-elec', 'Kiến trúc mạng 5G, phổ tần và các kịch bản sử dụng.'],
    ['ute-vt-lab3', 'Lab 3 — Điều chế QPSK với GNU Radio.md', 't-thuchanh t-elec', 'Dựng bộ điều chế và giải điều chế QPSK, đo tỉ lệ lỗi bit theo SNR.'],
    ['ute-vt-de2025', 'Đề thi giữa kỳ Thông tin số 2025.pdf', 't-dethi t-elec', 'Đề thi giữa kỳ năm 2025 về lấy mẫu và điều chế số.', { due: null }],
  ]);
  put('kb-ute-ddt', 'f-ute-ddt-dcn', [
    ['ute-dcn-syl', 'Đề cương học phần EE3210 — Máy điện.pdf', 't-decuong t-elec', 'Máy biến áp, động cơ không đồng bộ và máy điện đồng bộ.'],
    ['ute-dcn-plc', 'Bài giảng Lập trình PLC S7-1200.pdf', 't-baigiang t-elec', 'Lập trình LAD/FBD trên TIA Portal, timer, counter và giám sát HMI.'],
    ['ute-dcn-lab1', 'Lab 1 — Điều khiển động cơ bằng PLC.md', 't-thuchanh t-elec', 'Đấu nối và lập trình khởi động sao – tam giác cho động cơ ba pha.'],
    ['ute-dcn-noiquy', 'Nội quy phòng thí nghiệm Điện.pdf', 't-thuchanh t-elec', 'Quy định an toàn điện, trang phục và trách nhiệm khi sử dụng phòng thí nghiệm.', { due: -8 }],
  ]);
  put('kb-ute-ddt', 'f-ute-ddt-bieumau', [
    ['ute-ddt-f-ptn', 'Phiếu đăng ký sử dụng phòng thí nghiệm.docx', 't-bieumau t-thuchanh', 'Đăng ký phòng thí nghiệm ngoài giờ cho đồ án và khóa luận.'],
    ['ute-ddt-f-muon', 'Đơn xin mượn thiết bị thí nghiệm.docx', 't-bieumau t-thuchanh', 'Mượn thiết bị mang ra ngoài phòng thí nghiệm, có cam kết hoàn trả.'],
  ]);

  /* ── Khoa Cơ khí Chế tạo máy ── */
  put('kb-ute-ck', null, [
    ['ute-ck-intro', 'Giới thiệu Khoa Cơ khí Chế tạo máy.pdf', 't-ctdt t-mech', 'Các bộ môn, xưởng thực hành, ngành đào tạo và doanh nghiệp đối tác của Khoa Cơ khí.', { due: null }],
  ]);
  put('kb-ute-ck', 'f-ute-ck-ctm', [
    ['ute-ctm-syl', 'Đề cương học phần ME3110 — Công nghệ chế tạo máy.pdf', 't-decuong t-mech', 'Quy trình công nghệ, chuẩn gá đặt, chế độ cắt và thiết kế đồ gá.'],
    ['ute-ctm-cnc', 'Bài giảng Lập trình gia công CNC.pdf', 't-baigiang t-mech', 'Mã G/M, bù dao và lập trình phay, tiện CNC trên hệ điều khiển Fanuc.'],
    ['ute-ctm-de2025', 'Đề thi cuối kỳ Công nghệ chế tạo máy 2025.pdf', 't-dethi t-mech', 'Đề thi cuối kỳ năm 2025 về lập quy trình công nghệ cho chi tiết trục.', { due: null }],
    ['ute-ctm-noiquy', 'Nội quy xưởng thực hành cơ khí.pdf', 't-thuchanh t-mech', 'Giờ làm việc, trang bị bảo hộ, quy tắc vận hành máy và xử lý sự cố trong xưởng.'],
    ['ute-ctm-antoan', 'Hướng dẫn an toàn lao động trong xưởng.pdf', 't-thuchanh t-mech', 'Nhận diện nguy hiểm, sơ cứu và báo cáo tai nạn trong xưởng thực hành.'],
  ]);
  put('kb-ute-ck', 'f-ute-ck-cdt', [
    ['ute-cdt-intro', 'Giới thiệu Bộ môn Cơ điện tử.pdf', 't-mech t-ctdt', 'Giảng viên, học phần và phòng thí nghiệm robot của Bộ môn Cơ điện tử.', { due: null }],
  ]);
  put('kb-ute-ck', 'f-ute-ck-robot', [
    ['ute-robot-syl', 'Đề cương học phần ME4210 — Robot công nghiệp.pdf', 't-decuong t-mech', 'Động học, động lực học, quy hoạch quỹ đạo và lập trình robot công nghiệp.'],
    ['ute-robot-c2', 'Chương 2 — Động học thuận và nghịch.pdf', 't-baigiang t-mech', 'Tham số Denavit–Hartenberg, động học thuận và nghịch cho tay máy 6 bậc tự do.'],
    ['ute-robot-lab3', 'Lab 3 — Điều khiển cánh tay robot với ROS 2.md', 't-thuchanh t-mech', 'Mô phỏng và điều khiển cánh tay robot với ROS 2 và MoveIt.'],
    ['ute-kl-robot', 'Khóa luận — Robot gắp phân loại sản phẩm dùng thị giác máy tính (2025).pdf', 't-khoaluan t-mech t-nckh', 'Khóa luận tốt nghiệp 2025: robot gắp phân loại sản phẩm trên băng tải bằng camera và YOLO.', { upload: true, by: 'Phạm Thanh Sơn', due: null }],
  ]);
  put('kb-ute-ck', 'f-ute-ck-bieumau', [
    ['ute-ck-f-xuong', 'Phiếu đăng ký thực tập xưởng.docx', 't-bieumau t-thuchanh', 'Đăng ký ca thực tập xưởng và máy cần sử dụng.'],
    ['ute-ck-f-vattu', 'Phiếu đề xuất vật tư đồ án.docx', 't-bieumau t-khoaluan', 'Đề xuất vật tư, phôi và dụng cụ cho đồ án, có xác nhận của giảng viên hướng dẫn.'],
  ]);

  /* ── Phòng Đào tạo ── */
  put('kb-ute-pdt', null, [
    ['ute-pdt-sotay', 'Sổ tay sinh viên 2026–2027.pdf', 't-quyche t-dangky', 'Mọi điều sinh viên cần biết trong năm học: quy chế, đăng ký học phần, thi, học phí, học bổng và các phòng ban.', { pages: 64, upd: 75 }],
    ['ute-pdt-intro', 'Giới thiệu Phòng Đào tạo và các thủ tục học vụ.pdf', 't-quyche t-thi', 'Phòng Đào tạo phụ trách gì, giờ làm việc và các thủ tục học vụ thường gặp.', { due: null }],
  ]);
  put('kb-ute-pdt', 'f-ute-pdt-tuyensinh', [
    ['ute-ts-thongbao', 'Thông báo tuyển sinh đại học chính quy 2026.pdf', 't-tuyensinh', 'Phương thức xét tuyển, chỉ tiêu từng ngành, tổ hợp môn và lịch đăng ký nguyện vọng năm 2026.', { upd: 20, pages: 18 }],
    ['ute-ts-diemchuan', 'Điểm chuẩn trúng tuyển 2025.pdf', 't-tuyensinh', 'Điểm chuẩn từng ngành theo từng phương thức xét tuyển năm 2025.', { upd: 110, due: null, pages: 6 }],
    ['ute-ts-nhaphoc', 'Hướng dẫn hồ sơ nhập học 2026.pdf', 't-tuyensinh t-hocphi', 'Giấy tờ cần nộp, lịch nhập học và học phí học kỳ đầu của tân sinh viên.', { upd: 15 }],
  ]);
  put('kb-ute-pdt', 'f-ute-pdt-quyche', [
    ['ute-pdt-quyche', 'Quy chế đào tạo trình độ đại học 2024.pdf', 't-quyche t-dangky', 'Quy chế đào tạo theo tín chỉ: đăng ký, rút học phần, đánh giá, cảnh báo học vụ, nghỉ học tạm thời và tốt nghiệp.', { pages: 46, upd: 40, due: 320 }],
    ['ute-pdt-dangky', 'Quy định đăng ký học phần.pdf', 't-dangky', 'Khối lượng tối thiểu, tối đa, thời gian đăng ký và điều chỉnh học phần mỗi học kỳ.'],
    ['ute-pdt-ngoaingu', 'Quy định chuẩn đầu ra ngoại ngữ.pdf', 't-totnghiep', 'Chứng chỉ ngoại ngữ được công nhận và mức tối thiểu để xét tốt nghiệp.', { upd: 300, due: -20 }],
    ['ute-pdt-hocvu', 'Quy định cảnh báo học vụ và buộc thôi học.pdf', 't-quyche', 'Điều kiện bị cảnh báo học vụ, buộc thôi học và cách đề nghị xét lại.'],
    ['ute-pdt-totnghiep', 'Quy định xét và công nhận tốt nghiệp.pdf', 't-totnghiep', 'Điều kiện xét tốt nghiệp, các đợt xét trong năm và hồ sơ cần nộp.'],
    ['ute-pdt-caithien', 'Quy định học lại và học cải thiện điểm.pdf', 't-quyche t-dangky', 'Học lại học phần bị điểm F và học cải thiện điểm, cách tính điểm cao nhất.'],
    // Revised today, after the admin's conversation about it (ute-c4) was answered: that answer is marked for update.
    ['ute-pdt-phuckhao', 'Quy định phúc khảo bài thi.pdf', 't-thi', 'Thời hạn 7 ngày, lệ phí 30.000 đồng/học phần và quy trình chấm phúc khảo.', { upd: 0 }],
  ]);
  put('kb-ute-pdt', 'f-ute-pdt-lich', [
    ['ute-pdt-lichnam', 'Lịch năm học 2026–2027.pdf', 't-dangky t-thi', 'Thời gian bắt đầu, kết thúc từng học kỳ, tuần thi, nghỉ Tết và hạn rút học phần.', { upd: 60 }],
    ['ute-pdt-tkb', 'Thời khóa biểu HK1 2026–2027.xlsx', 't-dangky', 'Lịch học từng lớp học phần: thứ, tiết, phòng và giảng viên.', { upd: 18 }],
    ['ute-pdt-lichthi', 'Lịch thi cuối kỳ HK1 2026–2027.xlsx', 't-thi', 'Ngày thi, ca thi và phòng thi cuối kỳ học kỳ 1.', { upd: 2, status: 'processing', verify: false }],
    ['ute-pdt-hddk', 'Hướng dẫn đăng ký học phần HK2 2026–2027.pdf', 't-dangky', 'Các bước đăng ký học phần học kỳ 2 trên cổng đào tạo và lịch mở đăng ký theo khóa.', { upd: 5 }],
  ]);
  put('kb-ute-pdt', 'f-ute-pdt-hocphi', [
    ['ute-pdt-hocphi', 'Biểu học phí năm học 2026–2027.pdf', 't-hocphi', 'Học phí theo tín chỉ của từng ngành, hạn nộp và chính sách hoàn học phí.', { upd: 55 }],
    ['ute-pdt-nophp', 'Hướng dẫn nộp học phí trực tuyến.pdf', 't-hocphi', 'Nộp học phí qua ngân hàng và ví điện tử, xem biên lai trên cổng sinh viên.'],
  ]);
  put('kb-ute-pdt', 'f-ute-pdt-bieumau', [
    ['ute-pdt-f-nghi', 'Đơn xin nghỉ học tạm thời.docx', 't-bieumau t-quyche', 'Đơn nghỉ học tạm thời một hoặc hai học kỳ, kèm minh chứng.'],
    ['ute-pdt-f-phuckhao', 'Đơn phúc khảo bài thi.docx', 't-bieumau t-thi', 'Đơn đề nghị chấm phúc khảo, nộp trong vòng 7 ngày kể từ ngày công bố điểm.'],
    ['ute-pdt-f-rut', 'Đơn xin rút học phần.docx', 't-bieumau t-dangky', 'Đơn rút học phần trước cuối tuần thứ 10 của học kỳ.'],
    ['ute-pdt-f-bangdiem', 'Đơn xin cấp bảng điểm.docx', 't-bieumau', 'Đơn xin cấp bảng điểm chính thức bằng tiếng Việt hoặc tiếng Anh.'],
    ['ute-pdt-f-chuyennganh', 'Đơn xin chuyển ngành.docx', 't-bieumau t-quyche', 'Đơn chuyển sang ngành khác trong trường, có ý kiến của hai khoa.'],
    ['ute-pdt-f-hocvuot', 'Đơn xin học vượt.docx', 't-bieumau t-dangky', 'Đơn đăng ký vượt khối lượng tối đa dành cho sinh viên có điểm trung bình từ 3,2.'],
  ]);

  /* ── Phòng Công tác Sinh viên ── */
  put('kb-ute-ctsv', null, [
    ['ute-ctsv-intro', 'Giới thiệu Phòng Công tác Sinh viên.pdf', 't-hotro t-hocbong', 'Phòng CTSV hỗ trợ gì, giờ làm việc ở A1-108 và cách gửi yêu cầu.', { due: null }],
  ]);
  put('kb-ute-ctsv', 'f-ute-ctsv-hocbong', [
    // A new version came out yesterday, after Minh Anh asked about it (ute-c5, four days ago): her answer needs updating.
    ['ute-ctsv-hbkk', 'Quy định học bổng khuyến khích học tập 2026.pdf', 't-hocbong', 'Điều kiện, mức học bổng theo xếp loại và thời gian xét mỗi học kỳ.', { upd: 1 }],
    ['ute-ctsv-hbdn', 'Danh sách học bổng doanh nghiệp HK1 2026–2027.xlsx', 't-hocbong', 'Học bổng do doanh nghiệp tài trợ: giá trị, số suất, điều kiện và hạn nộp.', { upd: 9 }],
    ['ute-ctsv-hdhb', 'Hướng dẫn nộp hồ sơ học bổng.pdf', 't-hocbong', 'Hồ sơ cần chuẩn bị, cách nộp trực tuyến và lịch phỏng vấn học bổng.'],
    ['ute-ctsv-kqhb', 'Kết quả xét học bổng HK2 2025–2026.pdf', 't-hocbong', 'Danh sách sinh viên nhận học bổng khuyến khích học tập học kỳ 2 năm học 2025–2026.', { upd: 120, due: null }],
  ]);
  put('kb-ute-ctsv', 'f-ute-ctsv-renluyen', [
    ['ute-ctsv-drl', 'Quy chế đánh giá điểm rèn luyện.pdf', 't-renluyen', 'Năm tiêu chí, thang điểm 100 và cách tự đánh giá điểm rèn luyện mỗi học kỳ.'],
    ['ute-ctsv-ngoaitru', 'Hướng dẫn khai báo ngoại trú.pdf', 't-ktx', 'Khai báo nơi ở ngoại trú trên cổng sinh viên trong 15 ngày đầu học kỳ.'],
    ['ute-ctsv-ktx', 'Sổ tay ký túc xá 2026.pdf', 't-ktx', 'Đăng ký phòng, nội quy, phí ký túc xá và liên hệ ban quản lý.', { upd: 70 }],
  ]);
  put('kb-ute-ctsv', 'f-ute-ctsv-hotro', [
    ['ute-ctsv-miengiam', 'Quy định miễn, giảm học phí.pdf', 't-hotro t-hocphi', 'Đối tượng được miễn, giảm học phí, mức giảm và hồ sơ cần nộp.'],
    ['ute-ctsv-vayvon', 'Hướng dẫn vay vốn tín dụng sinh viên.pdf', 't-hotro', 'Điều kiện vay vốn Ngân hàng Chính sách xã hội và giấy xác nhận của trường.'],
  ]);
  put('kb-ute-ctsv', 'f-ute-ctsv-bieumau', [
    ['ute-ctsv-f-xacnhan', 'Giấy xác nhận sinh viên.docx', 't-bieumau t-hotro', 'Mẫu đề nghị xác nhận đang là sinh viên: hoãn nghĩa vụ quân sự, vay vốn, xin visa.'],
    ['ute-ctsv-f-miengiam', 'Đơn xin miễn, giảm học phí.docx', 't-bieumau t-hotro t-hocphi', 'Đơn đề nghị miễn, giảm học phí kèm giấy tờ chứng minh đối tượng.'],
    ['ute-ctsv-f-trocap', 'Đơn xin trợ cấp xã hội.docx', 't-bieumau t-hotro', 'Đơn xin trợ cấp xã hội cho sinh viên có hoàn cảnh khó khăn.'],
    ['ute-ctsv-f-vayvon', 'Giấy xác nhận vay vốn tín dụng sinh viên.docx', 't-bieumau t-hotro', 'Mẫu xác nhận của trường gửi Ngân hàng Chính sách xã hội.'],
    ['ute-ctsv-f-ktx', 'Phiếu đăng ký ở ký túc xá.docx', 't-bieumau t-ktx', 'Đăng ký chỗ ở ký túc xá cho học kỳ tới.'],
  ]);

  /* ── Hồ sơ nhân sự (restricted: visible but locked to students and lecturers) ── */
  put('kb-ute-nhansu', null, [
    ['ute-ns-tuyendung', 'Quy trình tuyển dụng viên chức 2026.pdf', 't-nhansu', 'Các bước tuyển dụng giảng viên và viên chức, hội đồng tuyển dụng và thời hạn.'],
  ]);
  put('kb-ute-nhansu', 'f-ute-ns-hd', [
    ['ute-ns-thinhgiang', 'Danh sách hợp đồng giảng viên thỉnh giảng HK1.xlsx', 't-nhansu', 'Giảng viên thỉnh giảng, học phần, số tiết và thời hạn hợp đồng.', { verify: false }],
    ['ute-ns-bonhiem', 'Quyết định bổ nhiệm trưởng bộ môn 2026.pdf', 't-nhansu', 'Quyết định bổ nhiệm trưởng bộ môn nhiệm kỳ 2026–2031.'],
  ]);
  put('kb-ute-nhansu', 'f-ute-ns-danhgia', [
    ['ute-ns-ketqua', 'Kết quả đánh giá viên chức năm học 2025–2026.xlsx', 't-nhansu', 'Xếp loại viên chức từng đơn vị năm học 2025–2026.', { verify: false }],
    ['ute-ns-tieuchi', 'Tiêu chí đánh giá, xếp loại viên chức.pdf', 't-nhansu', 'Tiêu chí và quy trình đánh giá, xếp loại viên chức hằng năm.'],
  ]);

  /* ── Ban Giám hiệu (hidden from students and lecturers) ── */
  put('kb-ute-bgh', null, [
    ['ute-bgh-chienluoc', 'Kế hoạch chiến lược phát triển trường 2026–2030.pdf', 't-quantri', 'Mục tiêu, chỉ tiêu và lộ trình phát triển trường giai đoạn 2026–2030.', { verify: false }],
    ['ute-bgh-ngansach', 'Dự toán ngân sách năm 2027.xlsx', 't-quantri', 'Dự toán thu, chi năm 2027 theo đơn vị.', { verify: false }],
  ]);
  put('kb-ute-bgh', 'f-ute-bgh-hop', [
    ['ute-bgh-bb09', 'Biên bản họp Ban Giám hiệu — tháng 9-2026.docx', 't-quantri', 'Kết luận về tuyển sinh 2026 và kế hoạch năm học mới.', { verify: false, upd: 50 }],
    ['ute-bgh-bb10', 'Biên bản họp Ban Giám hiệu — tháng 10-2026.docx', 't-quantri', 'Kết luận về kiểm định chương trình và đầu tư phòng thí nghiệm.', { verify: false, upd: 20 }],
  ]);

  /* Versions of the documents people rely on most. */
  Object.assign(D.docs.find(d => d.id === 'ute-pdt-quyche'), { version: 3, versions: [
    { v: 3, at: P(40), by: 'Trần Thị Mai Phương', note: 'Hạn rút học phần chuyển sang cuối tuần thứ 10' },
    { v: 2, at: P(420), by: 'Phòng Đào tạo', note: 'Khối lượng tối thiểu 14 tín chỉ mỗi học kỳ chính' },
    { v: 1, at: P(800), by: 'Phòng Đào tạo', note: 'Ban hành theo hệ thống tín chỉ' },
  ] });
  Object.assign(D.docs.find(d => d.id === 'ute-ctsv-hbkk'), { version: 2, versions: [
    { v: 2, at: P(30), by: 'Lâm Bảo Ngọc', note: 'Điểm trung bình tối thiểu nâng lên 3,2' },
    { v: 1, at: P(395), by: 'Phòng Công tác Sinh viên', note: 'Quy định năm 2025' },
  ] });

  /* ═══════════════ Topics (Knowledge Studio → Topics) ═══════════════ */
  D.topics = [
    { id: 'd-hocvu', name: 'Học vụ & Quy chế', icon: 'shield', color: '#4c51bf', desc: 'Quy chế đào tạo, đăng ký học phần, thi, tốt nghiệp và học phí.' },
    { id: 't-tuyensinh', name: 'Tuyển sinh', parent: 'd-hocvu' }, { id: 't-quyche', name: 'Quy chế đào tạo', parent: 'd-hocvu' }, { id: 't-dangky', name: 'Đăng ký học phần & lịch học', parent: 'd-hocvu' }, { id: 't-thi', name: 'Thi & phúc khảo', parent: 'd-hocvu' }, { id: 't-totnghiep', name: 'Thực tập & tốt nghiệp', parent: 'd-hocvu' }, { id: 't-hocphi', name: 'Học phí', parent: 'd-hocvu' },
    { id: 'd-hoctap', name: 'Giảng dạy & Học tập', icon: 'graduation', color: '#2f6fb5', desc: 'Chương trình đào tạo, đề cương, bài giảng, thực hành và đề thi.' },
    { id: 't-ctdt', name: 'Chương trình đào tạo', parent: 'd-hoctap' }, { id: 't-decuong', name: 'Đề cương học phần', parent: 'd-hoctap' }, { id: 't-baigiang', name: 'Bài giảng', parent: 'd-hoctap' }, { id: 't-thuchanh', name: 'Thực hành & thí nghiệm', parent: 'd-hoctap' }, { id: 't-dethi', name: 'Đề thi các năm', parent: 'd-hoctap' },
    { id: 'd-nghiencuu', name: 'Nghiên cứu & Khóa luận', icon: 'flask', color: '#4e6b2e', desc: 'Khóa luận, đồ án và đề tài nghiên cứu.' },
    { id: 't-khoaluan', name: 'Khóa luận & đồ án', parent: 'd-nghiencuu' }, { id: 't-nckh', name: 'Nghiên cứu khoa học', parent: 'd-nghiencuu' },
    { id: 'd-chuyenmon', name: 'Chuyên môn', icon: 'cpu', color: '#6b4fbf', desc: 'Lĩnh vực chuyên môn của các khoa.' },
    { id: 't-db', name: 'Cơ sở dữ liệu & hệ thống thông tin', parent: 'd-chuyenmon' }, { id: 't-ml', name: 'Học máy & khoa học dữ liệu', parent: 'd-chuyenmon' }, { id: 't-se', name: 'Kỹ thuật phần mềm', parent: 'd-chuyenmon' }, { id: 't-net', name: 'Mạng & an toàn thông tin', parent: 'd-chuyenmon' },
    { id: 't-iot', name: 'Hệ thống nhúng & IoT', parent: 'd-chuyenmon' }, { id: 't-elec', name: 'Điện – điện tử', parent: 'd-chuyenmon' }, { id: 't-mech', name: 'Cơ khí & cơ điện tử', parent: 'd-chuyenmon' },
    { id: 'd-sinhvien', name: 'Đời sống sinh viên', icon: 'users', color: '#b4467a', desc: 'Học bổng, rèn luyện, ký túc xá và hỗ trợ sinh viên.' },
    { id: 't-hocbong', name: 'Học bổng', parent: 'd-sinhvien' }, { id: 't-renluyen', name: 'Rèn luyện & khen thưởng', parent: 'd-sinhvien' }, { id: 't-ktx', name: 'Ký túc xá & ngoại trú', parent: 'd-sinhvien' }, { id: 't-hotro', name: 'Miễn giảm & hỗ trợ', parent: 'd-sinhvien' },
    { id: 'd-hanhchinh', name: 'Hành chính & Nhân sự', icon: 'building', color: '#4f5865', desc: 'Biểu mẫu, nhân sự và quản trị nhà trường.' },
    { id: 't-bieumau', name: 'Biểu mẫu', parent: 'd-hanhchinh' }, { id: 't-nhansu', name: 'Nhân sự & viên chức', parent: 'd-hanhchinh' }, { id: 't-quantri', name: 'Quản trị nhà trường', parent: 'd-hanhchinh' },
  ];
  const KEYWORDS = {
    't-quyche': ['quy chế', 'học vụ', 'cảnh báo học vụ'], 't-dangky': ['đăng ký học phần', 'thời khóa biểu', 'rút học phần'], 't-thi': ['lịch thi', 'phúc khảo', 'điểm thi'],
    't-totnghiep': ['tốt nghiệp', 'thực tập', 'chuẩn đầu ra'], 't-hocphi': ['học phí', 'biên lai'], 't-ctdt': ['chương trình đào tạo', 'chuẩn đầu ra'], 't-tuyensinh': ['tuyển sinh', 'xét tuyển', 'điểm chuẩn', 'nhập học'],
    't-decuong': ['đề cương', 'syllabus'], 't-baigiang': ['bài giảng', 'chương', 'slide'], 't-thuchanh': ['lab', 'thí nghiệm', 'xưởng'], 't-dethi': ['đề thi', 'đáp án'],
    't-khoaluan': ['khóa luận', 'đồ án', 'đề tài'], 't-hocbong': ['học bổng'], 't-renluyen': ['điểm rèn luyện', 'khen thưởng'], 't-ktx': ['ký túc xá', 'ngoại trú'],
    't-hotro': ['miễn giảm', 'trợ cấp', 'vay vốn'], 't-bieumau': ['mẫu đơn', 'biểu mẫu', 'đơn xin', 'phiếu'], 't-nhansu': ['viên chức', 'hợp đồng', 'tuyển dụng'],
  };
  D.topics.filter(t => KEYWORDS[t.id]).forEach(t => { t.keywords = KEYWORDS[t.id]; });
  const topic = id => D.topics.find(t => t.id === id);
  Object.assign(topic('t-bieumau'), {
    desc: 'Mẫu đơn, phiếu và giấy xác nhận sinh viên, giảng viên tải về để nộp cho khoa và phòng ban.',
    guidance: 'Dùng cho mẫu đơn và phiếu cần điền rồi nộp.\nKhông dùng cho quy định giải thích thủ tục (Quy chế đào tạo).',
    synonyms: ['mẫu đơn', 'đơn từ'], examples: ['ute-pdt-f-phuckhao', 'ute-ctsv-f-xacnhan', 'ute-cntt-f-detai'],
  });
  Object.assign(topic('t-quyche'), { desc: 'Quy chế đào tạo theo tín chỉ và các quy định học vụ của trường.', synonyms: ['quy định đào tạo'], examples: ['ute-pdt-quyche', 'ute-pdt-hocvu'] });
  Object.assign(topic('t-hocbong'), { desc: 'Học bổng khuyến khích học tập và học bổng doanh nghiệp: điều kiện, hồ sơ và kết quả.', synonyms: ['scholarship'], examples: ['ute-ctsv-hbkk', 'ute-ctsv-hbdn'] });
  D.masterImports = [{ id: 'mdi-ute-1', file: 'danh-muc-chu-de-ute-2026.xlsx', by: 'u-ute-phuong', at: P(30, 2), mode: 'merge', counts: { added: 12, updated: 4, archived: 0 } }];
  D.topicProposals = [];
  D.reviewBatches = [];
  D.classGroups = [];
  D.dupDismissed = [];

  /* ═══════════════ Contributions (in review / sent back) ═══════════════ */
  const ev = (at, by, kind, text = '') => ({ at, by, kind, text });
  const sub = (kb, folder, id, name, by, at, o) => {
    const d = mkDoc(kb, id, name, { addedBy: D.members.find(m => m.id === by)?.name || 'Sync', updated: o.events?.at(-1)?.at || at, status: 'pending', pages: o.pages, size: o.size, passages: 30 });
    Object.assign(d, { folder, lang: 'vi', stage: o.stage, submission: { by, at, note: o.note, kbBy: 'contributor', events: [ev(at, by, 'submitted', o.note), ...(o.events || [])] } });
    D.docs.push(d);
  };
  sub('kb-ute-cntt', 'f-ute-cntt-ht', 'ute-sub-1', 'Tổng hợp câu hỏi ôn tập Chương 5 — Chuẩn hóa.docx', 'u-ute-anh', P(0, 6), { stage: 'review', pages: 4, size: 64e3, note: 'Em tổng hợp 20 câu hỏi ôn tập kèm lời giải từ bài giảng Chương 5 cho lớp.' });
  sub('kb-ute-cntt', 'f-ute-cntt-khdl', 'ute-sub-2', 'Ghi chú Tuần 4 — Chính quy hóa.md', 'u-ute-vy', P(4), { stage: 'changes', pages: 3, size: 12e3, note: 'Ghi chú bài giảng Tuần 4 có ví dụ bằng scikit-learn.',
    events: [ev(P(2, 3), 'u-ute-thao', 'changes', 'Cảm ơn Vy. Em bỏ phần lời giải Bài tập lớn 1 ra khỏi ghi chú rồi gửi lại nhé.')] });

  /* A bulk upload of 1,000 digitised records (Phòng Đào tạo): unpublished and not processed yet, so admins pick which to
     process — by year — from Knowledge Studio → Documents → All → Not processed. */
  const YR = k => 2015 + (k % 10);
  seedBulkUpload({ kb: 'kb-ute-pdt', folder: 'f-ute-pdt-sohoa', prefix: 'ute-scan', n: 1000, by: 'Trần Thị Mai Phương', daysAgo: 1, templates: [
    k => `Quyết định ${100 + k}/QĐ-ĐHUTE — công nhận tốt nghiệp đợt ${(k % 4) + 1} năm ${YR(k)}.pdf`,
    k => `Thông báo lịch thi học kỳ ${(k % 3) + 1} năm học ${YR(k)}–${YR(k) + 1}.pdf`,
    k => `Biên bản họp Hội đồng đào tạo số ${k}-${YR(k)}.docx`,
    k => `Danh sách sinh viên cảnh báo học vụ học kỳ ${(k % 2) + 1} năm ${YR(k)}.xlsx`,
    k => `Kế hoạch đào tạo năm học ${YR(k)}–${YR(k) + 1} — bản ${k}.pdf`,
  ] });

  /* ═══════════════ Sources ═══════════════ */
  D.accounts = [{ id: 'acc-ute-gd', app: 'gdrive', label: 'drive@ute.edu.vn', user: 'drive@ute.edu.vn', status: 'connected', connected: P(140), checked: ago(9 * MIN) }];
  const sched = (freq, time = '02:00') => ({ freq, time, day: 'Mon', tz: 'Asia/Ho_Chi_Minh', on: true });
  D.sources = [
    { id: 'src-ute-pdt', name: 'Drive Phòng Đào tạo — Văn bản đã ban hành', app: 'gdrive', account: 'acc-ute-gd', kb: 'kb-ute-pdt', status: 'healthy', scope: ['Shared drives / Phòng Đào tạo / Đã ban hành'], schedule: sched('daily'), last: { at: P(0, 5), result: 'completed', added: 1, updated: 2, removed: 0, failed: 0 }, next: T(0, 19), created: P(140), owner: 'Trần Thị Mai Phương', publish: 'auto' },
    { id: 'src-ute-cntt', name: 'Drive Khoa CNTT — Học liệu', app: 'gdrive', account: 'acc-ute-gd', kb: 'kb-ute-cntt', status: 'healthy', scope: ['Shared drives / Khoa CNTT / Học liệu'], schedule: sched('weekly', '06:00'), last: { at: P(1, 3), result: 'completed', added: 2, updated: 3, removed: 0, failed: 0 }, next: T(4, 6), created: P(120), owner: 'Lê Văn Hùng', publish: 'review' },
  ];
  D.runs = [
    { id: 'run-ute-33', source: 'src-ute-pdt', kb: 'kb-ute-pdt', trigger: 'Scheduled', status: 'completed', started: P(0, 5), dur: 41e3, counts: { total: 3, ok: 3, failed: 0, skipped: 0 }, by: 'Schedule' },
    { id: 'run-ute-32', source: 'src-ute-cntt', kb: 'kb-ute-cntt', trigger: 'Scheduled', status: 'completed', started: P(1, 3), dur: 186e3, counts: { total: 5, ok: 5, failed: 0, skipped: 0 }, by: 'Schedule' },
    { id: 'run-ute-31', source: 'src-ute-pdt', kb: 'kb-ute-pdt', trigger: 'Manual', status: 'completed', started: P(2, 1), dur: 22e3, counts: { total: 1, ok: 1, failed: 0, skipped: 0 }, by: 'Trần Thị Mai Phương' },
  ];

  /* Access requests (to collections) */
  D.requests = [
    { id: 'req-ute-1', user: 'u-ute-son', kb: 'kb-ute-cntt', role: 'editor', note: 'Tôi dạy liên khoa học phần Thị giác máy tính cho sinh viên CNTT, cần đăng bài giảng vào Chuyên ngành Khoa học Dữ liệu.', at: P(0, 4), status: 'pending' },
    { id: 'req-ute-2', user: 'u-ute-tuan', kb: 'kb-ute-nhansu', role: 'viewer', note: 'Cần xem hợp đồng thỉnh giảng của Bộ môn Điện tử – Viễn thông để lập kế hoạch HK2.', at: P(1, 2), status: 'pending' },
  ];

  /* ═══════════════ Activity ═══════════════ */
  D.audit = [
    [1 * HOUR, 'system', 'Sync finished', 'Sources', 'Drive Phòng Đào tạo — Văn bản đã ban hành', 'success'],
    [3 * HOUR, 'u-ute-quan', 'Approved a request', 'Requests', 'Cấp bảng điểm — Trần Thảo Vy', 'success'],
    [5 * HOUR, 'u-ute-hung', 'Published quiz', 'Work', 'Kiểm tra Chương 5 — Chuẩn hóa lược đồ → Cơ sở dữ liệu', 'success'],
    [26 * HOUR, 'u-ute-phuong', 'Verified a document', 'Knowledge', 'Quy chế đào tạo trình độ đại học 2024.pdf', 'success'],
    [2 * DAY, 'u-ute-ngoc', 'Published a document', 'Knowledge', 'Danh sách học bổng doanh nghiệp HK1 2026–2027.xlsx', 'success'],
    [4 * DAY, 'u-ute-phuong', 'Created space', 'Spaces', 'Nhóm nghiên cứu Hệ thống Thông minh', 'success'],
    [6 * DAY, 'u-ute-phuong', 'Suspended member', 'People', 'Võ Thanh Tâm', 'success'],
    [9 * DAY, 'u-ute-phuong', 'Updated assistant instructions', 'Settings', 'Assistant', 'success'],
  ].map(([t, actor, action, type, target, outcome], i) => ({ id: 'ev-ute-' + (300 - i), at: ago(t), actor, action, type, target, outcome, ip: '10.20.' + (3 + i) + '.' + (11 + i * 4), device: i % 3 ? 'Chrome on Windows' : 'Safari on iPhone' }));
  D.signins = [
    [4 * MIN, 'u-ute-phuong', 'Microsoft', 'active', 'Chrome on Windows'], [6 * MIN, 'u-ute-anh', 'Google', 'active', 'Safari on iPhone'],
    [20 * MIN, 'u-ute-hung', 'Microsoft', 'active', 'Chrome on macOS'], [30 * MIN, 'u-ute-quan', 'Microsoft', 'active', 'Edge on Windows'],
    [26 * DAY, 'u-ute-tam', 'Password', 'blocked', 'Chrome on Android'],
  ].map(([t, user, method, st, device], i) => ({ id: 'si-ute-' + i, at: ago(t), user, method, status: st, device }));
  D.usage = { questions: Array.from({ length: 30 }, (_, i) => Math.round(1300 + 420 * Math.sin(i / 2.6) + i * 22 + (i % 7 > 4 ? -700 : 0))), active: 6120, activePrev: 5480, questions7: 11480, questions7Prev: 9930 };
  D.gaps = [
    { id: 'gute1', q: 'Học kỳ hè được đăng ký tối đa bao nhiêu tín chỉ?', n: 64, kb: 'kb-ute-pdt', why: 'Quy định đăng ký học phần chưa có phần học kỳ hè' },
    { id: 'gute2', q: 'Sinh viên chuyển trường có được miễn chuẩn đầu ra ngoại ngữ không?', n: 41, kb: 'kb-ute-pdt', why: 'Quy định chuẩn đầu ra ngoại ngữ đã quá hạn rà soát và không nhắc đến sinh viên chuyển trường' },
    { id: 'gute3', q: 'Bài tập lớn 1 có được dùng scikit-learn không?', n: 19, kb: 'kb-ute-cntt', why: 'Đề bài không nói rõ' },
    { id: 'gute4', q: 'Đăng ký phòng lab A5 sau 18 giờ thế nào?', n: 12, kb: null, why: 'Chưa có tài liệu nào' },
  ];
  D.artifacts = {};

  /* ═══════════════ Assistant ═══════════════ */
  D.assistant = {
    instructions: 'Bạn là trợ lý của Trường Đại học UTE. Trả lời dựa trên quy chế, quy định, học liệu và biểu mẫu mà người hỏi được xem, và trích dẫn nguồn cho mọi thông tin. Với hạn chót, học phí và điều kiện, trích đúng quy định. Việc cần khoa hoặc phòng ban quyết định thì nói rõ ai xử lý và đề nghị gửi yêu cầu. Trả lời bằng ngôn ngữ người hỏi dùng.',
    style: 'balanced', citations: true, caps: { search: true, analyze: true, files: true },
    welcome: 'Hôm nay bạn cần tìm gì cho việc học, giảng dạy hay thủ tục?',
    starters: [
      { title: 'Tra quy chế', prompt: 'Hạn rút học phần học kỳ này là khi nào, có được hoàn học phí không?' },
      { title: 'Tìm mẫu đơn', prompt: 'Mẫu đơn phúc khảo bài thi ở đâu, nộp trong bao lâu?' },
      { title: 'Học bổng', prompt: 'Điều kiện xét học bổng khuyến khích học tập là gì?' },
    ],
    /* Starters for one role (keyed by its id); everyone else sees `starters`. */
    audienceStarters: {
      'r-member': [
        { title: 'Tra quy chế', prompt: 'Hạn rút học phần học kỳ này là khi nào, có được hoàn học phí không?' },
        { title: 'Ôn tập', prompt: 'Giải thích sự khác nhau giữa 3NF và BCNF kèm ví dụ trong Chương 5.' },
        { title: 'Tìm mẫu đơn', prompt: 'Mẫu đơn phúc khảo bài thi ở đâu, nộp trong bao lâu?' },
      ],
      // First-year students: their group's own starters (a group's list wins over its role's).
      'g-ute-k25': [
        { title: 'Năm học mới', prompt: 'Năm học 2026–2027 bắt đầu khi nào và tuần đầu tân sinh viên cần làm gì?' },
        { title: 'Học phí', prompt: 'Học phí năm nhất là bao nhiêu và nộp trực tuyến thế nào?' },
        { title: 'Ký túc xá', prompt: 'Muốn ở ký túc xá thì đăng ký thế nào, cần giấy tờ gì?' },
      ],
      'r-gv': [
        { title: 'Chuẩn bị bài', prompt: 'Tóm tắt điều kiện của 2NF, 3NF và BCNF để ôn tập đầu giờ.' },
        { title: 'Câu hỏi của lớp', prompt: 'Tuần này sinh viên hỏi gì nhiều nhất về Lab 3?' },
        { title: 'Quy định', prompt: 'Sau khi thi bao nhiêu ngày giảng viên phải nộp điểm?' },
      ],
      'r-admin': [
        { title: 'Trả lời thống nhất', prompt: 'Sinh viên được phúc khảo trong bao lâu và lệ phí bao nhiêu?' },
        { title: 'Tìm khoảng trống', prompt: 'Tuần này sinh viên hỏi gì về học kỳ hè mà chưa có câu trả lời?' },
        { title: 'Soạn thông báo', prompt: 'Soạn thông báo nhắc hạn rút học phần học kỳ 1.' },
      ],
    },
  };

  /* ═══════════════ Spaces ═══════════════ */
  D.spaces = [
    {
      id: 'sp-ute-csdl', type: 'course', name: 'Cơ sở dữ liệu', code: 'IT3090', term: 'Học kỳ 1 · 2026–2027', color: '#0E7C66',
      desc: 'Mô hình quan hệ, SQL, chuẩn hóa và giao tác.', schedule: 'Thứ Hai 09:30–12:00 · A4-105', memberCount: 96, visibility: 'members', kbs: [],
      members: [{ user: 'u-ute-hung', role: 'lecturer' }, { user: 'u-ute-anh', role: 'student' }, { user: 'u-ute-vy', role: 'student' }, { user: 'u-ute-huy', role: 'student' }, { user: 'u-ute-khoa', role: 'student' }],
      announcements: [
        { id: 'an-ute-csdl-1', by: 'u-ute-hung', at: P(0, 5), title: 'Bài kiểm tra Chương 5 đã mở', text: 'Bài kiểm tra gồm 5 câu về chuẩn hóa lược đồ, làm trong 15 phút, đóng tối thứ Năm. Mỗi bạn làm một lần.', pinned: true },
        { id: 'an-ute-csdl-2', by: 'u-ute-hung', at: P(3), title: 'Lab 3 được dùng CTE', text: 'Các em được dùng mệnh đề WITH (CTE) trong Lab 3. Hạn nộp vẫn là tối mai.' },
      ],
      joinRequests: [], created: P(70),
    },
    {
      id: 'sp-ute-ml', type: 'course', name: 'Học máy', code: 'IT4071', term: 'Học kỳ 1 · 2026–2027', color: '#2F6FB5',
      desc: 'Học máy có giám sát, đánh giá mô hình và mạng nơ-ron.', schedule: 'Thứ Ba 07:00–09:30 · Thứ Năm 13:00–15:30 · A5-302', memberCount: 118, visibility: 'members', kbs: [],
      members: [{ user: 'u-ute-thao', role: 'lecturer' }, { user: 'u-ute-anh', role: 'student' }, { user: 'u-ute-vy', role: 'student' }, { user: 'u-ute-khoa', role: 'student' }],
      announcements: [{ id: 'an-ute-ml-1', by: 'u-ute-thao', at: P(1), title: 'Bài tập lớn 1 nộp theo nhóm', text: 'Mỗi nhóm 3 bạn nộp một báo cáo và mã nguồn trên hệ thống trước 23:59 thứ Bảy.', pinned: true }],
      joinRequests: [], created: P(68),
    },
    {
      id: 'sp-ute-nckh', type: 'research', name: 'Nhóm nghiên cứu Hệ thống Thông minh', code: 'ISLab', term: '', color: '#4E6B2E',
      desc: 'Học máy ứng dụng cho nông nghiệp và giáo dục.', schedule: 'Họp nhóm thứ Năm 16:00 · B2-410', memberCount: 9, visibility: 'discoverable', kbs: [],
      members: [{ user: 'u-ute-hung', role: 'pi' }, { user: 'u-ute-thao', role: 'researcher' }, { user: 'u-ute-khoa', role: 'member' }],
      announcements: [{ id: 'an-ute-nc-1', by: 'u-ute-hung', at: P(2), title: 'Cập nhật tiến độ khóa luận', text: 'Mỗi bạn chuẩn bị 3 slide về kết quả mới nhất cho buổi họp thứ Năm.' }],
      joinRequests: [], created: P(4),
    },
    {
      id: 'sp-ute-pdt', type: 'office', name: 'Phòng Đào tạo', code: 'PĐT', term: '', color: '#1F5FAD',
      desc: 'Đăng ký học phần, thi, bảng điểm và học vụ.', schedule: 'Thứ Hai – Thứ Sáu 07:30–16:30 · A1-102', memberCount: 8, visibility: 'open', kbs: ['kb-ute-pdt'],
      members: [{ user: 'u-ute-phuong', role: 'head' }, { user: 'u-ute-quan', role: 'staff' }],
      announcements: [{ id: 'an-ute-pdt-1', by: 'u-ute-phuong', at: P(1), title: 'Hạn rút học phần HK1', text: 'Sinh viên rút học phần trước cuối tuần thứ 10. Gửi yêu cầu tại Yêu cầu → Rút học phần.', pinned: true }],
      joinRequests: [], created: P(150),
    },
    {
      id: 'sp-ute-ctsv', type: 'office', name: 'Phòng Công tác Sinh viên', code: 'CTSV', term: '', color: '#B4467A',
      desc: 'Học bổng, giấy xác nhận, miễn giảm học phí và ký túc xá.', schedule: 'Thứ Hai – Thứ Sáu 07:30–16:30 · A1-108', memberCount: 5, visibility: 'open', kbs: ['kb-ute-ctsv'],
      members: [{ user: 'u-ute-ngoc', role: 'head' }],
      announcements: [{ id: 'an-ute-ctsv-1', by: 'u-ute-ngoc', at: P(2), title: 'Mở nhận hồ sơ học bổng doanh nghiệp', text: 'Danh sách học bổng doanh nghiệp HK1 đã có trong mục Học bổng. Hạn nộp hồ sơ trong hai tuần.' }],
      joinRequests: [], created: P(150),
    },
  ];

  /* ═══════════════ Events (what's due / coming up) — audience: all | members | staff ═══════════════ */
  D.events = [
    { id: 'evt-ute-1', space: 'sp-ute-csdl', kind: 'deadline', title: 'Nộp Lab 3 — Truy vấn SQL nâng cao', at: T(1, -3), audience: 'members', doc: 'ute-csdl-lab3' },
    { id: 'evt-ute-2', space: 'sp-ute-ml', kind: 'deadline', title: 'Nộp Bài tập lớn 1 — Dự đoán giá nhà', at: T(3, 5), audience: 'members', doc: 'ute-ml-a1' },
    { id: 'evt-ute-3', space: 'sp-ute-csdl', kind: 'quiz', title: 'Bài kiểm tra Chương 5 đóng', at: T(4, 14), audience: 'members', work: 'w-ute-quiz-c5' },
    { id: 'evt-ute-4', space: 'sp-ute-pdt', kind: 'deadline', title: 'Hạn rút học phần HK1', at: EOD(9), audience: 'all', requestType: 'rt-ute-rut' },
    { id: 'evt-ute-5', space: 'sp-ute-ctsv', kind: 'deadline', title: 'Hạn nộp hồ sơ học bổng doanh nghiệp', at: EOD(14), audience: 'all', doc: 'ute-ctsv-hbdn' },
    { id: 'evt-ute-6', space: 'sp-ute-csdl', kind: 'exam', title: 'Thi giữa kỳ Cơ sở dữ liệu · A4-105', at: T(11, -6), audience: 'members' },
    { id: 'evt-ute-7', space: 'sp-ute-nckh', kind: 'meeting', title: 'Họp nhóm — cập nhật tiến độ khóa luận', at: T(2, 3), audience: 'members' },
    { id: 'evt-ute-8', space: 'sp-ute-pdt', kind: 'deadline', title: 'Công bố kết quả phúc khảo giữa kỳ', at: T(5, 3), audience: 'staff' },
  ];

  /* ═══════════════ Work (made with AI workflows) ═══════════════ */
  const cite = (doc, page, quote) => ({ doc, page, quote });
  const C5 = 'ute-csdl-c5';
  D.works = [
    {
      id: 'w-ute-quiz-c5', kind: 'quiz', workflow: 'quiz', title: 'Kiểm tra Chương 5 — Chuẩn hóa lược đồ', space: 'sp-ute-csdl', owner: 'u-ute-hung', status: 'published', visibility: 'space',
      created: P(2, 6), updated: P(0, 5), published: P(0, 5), due: T(4, 14), sources: [C5, 'ute-csdl-c3'],
      data: {
        timeLimit: 15, attemptsAllowed: 1,
        questions: [
          { id: 'q1', q: 'Dạng chuẩn 1NF yêu cầu điều gì?', options: ['Mọi thuộc tính chỉ chứa giá trị nguyên tố', 'Không có phụ thuộc bắc cầu', 'Mọi định thức là siêu khóa', 'Không có phụ thuộc đa trị'], answer: 0, difficulty: 'easy', explain: '1NF chỉ đòi hỏi giá trị nguyên tố; các dạng chuẩn cao hơn mới xét phụ thuộc hàm.', cite: cite(C5, 3, Q.nf1) },
          { id: 'q2', q: 'Khóa chính là (MaSV, MaHP) và TenSV chỉ phụ thuộc vào MaSV. Lược đồ vi phạm dạng chuẩn nào?', options: ['1NF', '2NF', 'Chỉ BCNF', 'Không vi phạm'], answer: 1, difficulty: 'medium', explain: 'TenSV phụ thuộc vào một phần của khóa chính nên không phụ thuộc đầy đủ — vi phạm 2NF.', cite: cite(C5, 6, Q.nf2) },
          { id: 'q3', q: 'Khi nào một lược đồ ở 3NF nhưng chưa ở BCNF?', options: ['Khi có thuộc tính đa trị', 'Khi có phụ thuộc hàm X → Y với X không phải siêu khóa và Y là thuộc tính khóa', 'Khi khóa chính chỉ có một thuộc tính', 'Không bao giờ xảy ra'], answer: 1, difficulty: 'hard', explain: 'BCNF đòi hỏi mọi định thức là siêu khóa; 3NF vẫn cho phép X → Y khi Y là thuộc tính khóa.', cite: cite(C5, 14, Q.bcnf) },
          { id: 'q4', q: 'Phép tách về BCNF luôn đảm bảo điều gì?', options: ['Bảo toàn phụ thuộc hàm', 'Kết nối không mất mát', 'Giảm số bảng', 'Tăng tốc truy vấn'], answer: 1, difficulty: 'medium', explain: 'Tách về BCNF luôn không mất mát thông tin nhưng có thể làm mất phụ thuộc hàm.', cite: cite(C5, 18, Q.tach) },
          { id: 'q5', q: 'Dạng chuẩn 3NF không cho phép điều gì?', options: ['Thuộc tính không khóa phụ thuộc bắc cầu vào khóa chính', 'Khóa chính gồm nhiều thuộc tính', 'Giá trị NULL', 'Khóa ngoại'], answer: 0, difficulty: 'easy', explain: '3NF loại bỏ phụ thuộc bắc cầu của thuộc tính không khóa vào khóa chính.', cite: cite(C5, 9, Q.nf3) },
        ],
        stats: { attempts: 41, avg: 3.6, byQuestion: [0.93, 0.71, 0.48, 0.66, 0.85] },
        attempts: [],
      },
    },
    {
      id: 'w-ute-guide-ml', kind: 'guide', workflow: 'study-guide', title: 'Hồi quy tuyến tính — đề cương ôn tập', space: 'sp-ute-ml', owner: 'u-ute-anh', status: 'ready', visibility: 'private',
      created: P(9), updated: P(9), sources: ['ute-ml-w02', 'ute-ml-lab2'],
      data: {
        depth: 'full', check: true,
        sections: [
          { id: 's1', key: 'summary', title: 'In one paragraph', html: '<p>Hồi quy tuyến tính dự đoán một giá trị số bằng tổng có trọng số của các đặc trưng, <b>ŷ = wᵀx</b>. Trọng số được chọn để cực tiểu sai số bình phương trung bình, bằng phương trình chuẩn hoặc từng bước với gradient descent [1].</p>', cites: [cite('ute-ml-w02', 6, Q.gd)] },
          { id: 's2', key: 'terms', title: 'Key terms', html: '<ul><li><b>Tốc độ học α</b> — bước cập nhật của gradient descent; quá lớn thì phân kỳ, quá nhỏ thì hội tụ chậm [1].</li><li><b>Chuẩn hóa đặc trưng</b> — đưa đặc trưng về trung bình 0, độ lệch chuẩn 1 để hội tụ nhanh hơn [2].</li></ul>', cites: [cite('ute-ml-w02', 18, Q.alpha), cite('ute-ml-lab2', 3, Q.scale)] },
          { id: 's3', key: 'check', title: 'Check yourself', html: '<ol><li>Vì sao dữ liệu chưa chuẩn hóa làm gradient descent chậm?</li><li>Khi nào nên dùng gradient descent thay cho phương trình chuẩn?</li><li>Đường cong mất mát trông thế nào khi α quá lớn?</li></ol>', cites: [] },
        ],
      },
    },
    {
      id: 'w-ute-draft-rut', kind: 'draft', workflow: 'draft', title: 'Thông báo hạn rút học phần HK1 2026–2027', space: 'sp-ute-pdt', owner: 'u-ute-phuong', status: 'draft', visibility: 'space',
      created: P(1, 4), updated: P(0, 20), sources: ['ute-pdt-quyche', 'ute-pdt-hocphi'],
      data: {
        type: 'announcement',
        html: '<h2>Thông báo về hạn rút học phần học kỳ 1 năm học 2026–2027</h2><p>Phòng Đào tạo thông báo: sinh viên được rút học phần đã đăng ký chậm nhất vào <b>cuối tuần thứ 10</b> của học kỳ. Học phần đã rút được ghi W trên bảng điểm và không tính vào điểm trung bình [1].</p><p>Sau khi rút, khối lượng đăng ký phải còn ít nhất <b>14 tín chỉ</b>; trường hợp thấp hơn cần Khoa chấp thuận [2]. Học phí của học phần đã rút <b>không được hoàn trả</b>, trừ khi lớp học phần bị Nhà trường hủy [3].</p><p>Sinh viên gửi yêu cầu tại mục Yêu cầu → Rút học phần.</p>',
        cites: [cite('ute-pdt-quyche', 18, Q.rut), cite('ute-pdt-quyche', 17, Q.tinchi), cite('ute-pdt-hocphi', 5, Q.hoanphi)],
      },
    },
  ];

  /* ═══════════════ Requests: what students and staff can ask offices and teaching teams ═══════════════
     checks: rules the assistant verifies before submitting (with the regulation it relies on). */
  const COURSES = ['IT3090 — Cơ sở dữ liệu', 'IT4071 — Học máy', 'IT3120 — Công nghệ phần mềm', 'IT3150 — Mạng máy tính', 'MA2010 — Xác suất thống kê', 'EN2030 — Tiếng Anh 3'];
  D.requestTypes = [
    {
      id: 'rt-ute-rut', space: 'sp-ute-pdt', name: 'Rút học phần', icon: 'arrow-left', sla: 3, fee: 'Không hoàn học phí',
      desc: 'Rút một học phần đã đăng ký trước cuối tuần thứ 10. Học phần ghi W và không tính vào điểm trung bình.',
      fields: [{ id: 'course', label: 'Học phần', type: 'select', options: COURSES, required: true }, { id: 'reason', label: 'Lý do', type: 'textarea', required: true, placeholder: 'Một câu là đủ.' }],
      checks: [
        { id: 'deadline', rule: 'before', at: EOD(9), label: 'Trước hạn rút học phần (cuối tuần thứ 10)', cite: cite('ute-pdt-quyche', 18, Q.rut) },
        { id: 'load', rule: 'info', label: 'Còn ít nhất 14 tín chỉ sau khi rút', cite: cite('ute-pdt-quyche', 17, Q.tinchi) },
        { id: 'refund', rule: 'info', label: 'Học phí học phần đã rút không được hoàn trả', cite: cite('ute-pdt-hocphi', 5, Q.hoanphi) },
      ],
    },
    {
      id: 'rt-ute-phuckhao', space: 'sp-ute-pdt', name: 'Phúc khảo bài thi', icon: 'retry', sla: 5, fee: '30.000 đồng/học phần, hoàn lại nếu điểm thay đổi',
      desc: 'Đề nghị chấm lại bài thi giữa kỳ hoặc cuối kỳ trong vòng 7 ngày kể từ ngày công bố điểm.',
      fields: [{ id: 'course', label: 'Học phần', type: 'select', options: COURSES, required: true }, { id: 'exam', label: 'Bài thi', type: 'select', options: ['Giữa kỳ', 'Cuối kỳ'], required: true }, { id: 'reason', label: 'Cần xem lại phần nào?', type: 'textarea', required: true }],
      checks: [
        { id: 'window', rule: 'info', label: 'Trong vòng 7 ngày kể từ ngày công bố điểm', cite: cite('ute-pdt-phuckhao', 1, Q.phuckhao) },
        { id: 'fee', rule: 'info', label: 'Lệ phí 30.000 đồng, hoàn lại nếu điểm thay đổi', cite: cite('ute-pdt-phuckhao', 2, Q.phuckhaoPhi) },
      ],
    },
    {
      id: 'rt-ute-nghi', space: 'sp-ute-pdt', name: 'Nghỉ học tạm thời', icon: 'pause', sla: 5, fee: null,
      desc: 'Tạm dừng việc học một hoặc hai học kỳ và được giữ kết quả học tập.',
      fields: [{ id: 'semesters', label: 'Thời gian', type: 'select', options: ['1 học kỳ', '2 học kỳ'], required: true }, { id: 'reason', label: 'Lý do', type: 'textarea', required: true }],
      checks: [{ id: 'max', rule: 'info', label: 'Đã học ít nhất một học kỳ; tối đa hai học kỳ trong toàn khóa', cite: cite('ute-pdt-quyche', 21, Q.nghi) }],
    },
    {
      id: 'rt-ute-bangdiem', space: 'sp-ute-pdt', name: 'Cấp bảng điểm', icon: 'file-text', sla: 2, fee: '20.000 đồng/bản',
      desc: 'Bảng điểm chính thức có chữ ký và dấu, bằng tiếng Việt hoặc tiếng Anh.',
      fields: [{ id: 'copies', label: 'Số bản', type: 'number', required: true, min: 1, max: 10 }, { id: 'language', label: 'Ngôn ngữ', type: 'select', options: ['Tiếng Việt', 'Tiếng Anh', 'Cả hai'], required: true }],
      checks: [{ id: 'fee', rule: 'info', label: '20.000 đồng/bản, nhận sau 2 ngày làm việc', cite: cite('ute-pdt-intro', 3, Q.bangdiem) }],
    },
    {
      id: 'rt-ute-xacnhan', space: 'sp-ute-ctsv', name: 'Giấy xác nhận sinh viên', icon: 'mail', sla: 1, fee: null,
      desc: 'Giấy xác nhận đang là sinh viên để hoãn nghĩa vụ quân sự, vay vốn, xin visa hoặc học bổng.',
      fields: [{ id: 'purpose', label: 'Mục đích', type: 'select', options: ['Hoãn nghĩa vụ quân sự', 'Vay vốn ngân hàng', 'Xin visa', 'Học bổng', 'Khác'], required: true }, { id: 'copies', label: 'Số bản', type: 'number', required: true, min: 1, max: 5 }],
      checks: [{ id: 'free', rule: 'info', label: 'Miễn phí, nhận vào ngày làm việc tiếp theo', cite: cite('ute-ctsv-intro', 2, Q.xacnhan) }],
    },
    {
      id: 'rt-ute-miengiam', space: 'sp-ute-ctsv', name: 'Miễn, giảm học phí', icon: 'sparkles', sla: 10, fee: null,
      desc: 'Đề nghị miễn hoặc giảm học phí cho sinh viên thuộc đối tượng chính sách.',
      fields: [{ id: 'doituong', label: 'Đối tượng', type: 'select', options: ['Hộ nghèo', 'Hộ cận nghèo', 'Con của người có công', 'Khác'], required: true }, { id: 'note', label: 'Giấy tờ kèm theo', type: 'textarea', required: true }],
      checks: [{ id: 'who', rule: 'info', label: 'Miễn hoặc giảm 50–100% theo đối tượng', cite: cite('ute-ctsv-miengiam', 2, Q.miengiam) }],
    },
    { id: 'rt-q-ute-csdl', space: 'sp-ute-csdl', name: 'Question for the teaching team', icon: 'message', sla: 2, fee: null, question: true, desc: 'When the assistant can’t answer from the course materials, ask the lecturer.', fields: [{ id: 'question', label: 'Question', type: 'textarea', required: true }], checks: [] },
    { id: 'rt-q-ute-ml', space: 'sp-ute-ml', name: 'Question for the teaching team', icon: 'message', sla: 2, fee: null, question: true, desc: 'When the assistant can’t answer from the course materials, ask the lecturer.', fields: [{ id: 'question', label: 'Question', type: 'textarea', required: true }], checks: [] },
  ];

  /* Request lifecycle: submitted → in_review → (needs_info ↔ in_review) → approved | declined → completed; or withdrawn. */
  const msg = (by, at, text, kind = 'message') => ({ id: uid('m'), by, at, text, kind });
  const typeOf = id => D.requestTypes.find(t => t.id === id);
  const sr = (id, type, requester, status, created, fields, thread, o = {}) => ({ id, type, space: typeOf(type).space, requester, status, created, updated: thread.length ? thread[thread.length - 1].at : created, fields, thread, assignee: o.assignee || null, due: created + typeOf(type).sla * DAY, ...o });
  D.svcRequests = [
    sr('SR-5101', 'rt-ute-phuckhao', 'u-ute-anh', 'in_review', P(2, 3), { course: 'IT3090 — Cơ sở dữ liệu', exam: 'Giữa kỳ', reason: 'Câu 4 (chuẩn hóa) bị chấm 0/2 nhưng bài làm đã đưa lược đồ về 3NF — đề nghị xem lại phần phân tích phụ thuộc hàm.' },
      [msg('u-ute-anh', P(2, 3), 'Submitted.', 'status'), msg('u-ute-quan', P(1, 6), 'Đã nhận. Bài thi đã được chuyển về Khoa CNTT để chấm lại.', 'status')], { assignee: 'u-ute-quan', fee: '30.000 đồng · đã nộp' }),
    sr('SR-5096', 'rt-ute-xacnhan', 'u-ute-anh', 'completed', P(6), { purpose: 'Vay vốn ngân hàng', copies: 2 },
      [msg('u-ute-anh', P(6), 'Submitted.', 'status'), msg('u-ute-ngoc', P(5, 2), 'Hai giấy xác nhận đã sẵn sàng tại phòng A1-108.', 'status')], { assignee: 'u-ute-ngoc' }),
    sr('SR-5104', 'rt-ute-rut', 'u-ute-huy', 'submitted', P(0, 3), { course: 'MA2010 — Xác suất thống kê', reason: 'Trùng lịch thực tập tại doanh nghiệp từ tuần sau.' }, [msg('u-ute-huy', P(0, 3), 'Submitted.', 'status')]),
    sr('SR-5103', 'rt-ute-bangdiem', 'u-ute-vy', 'approved', P(0, 9), { copies: 3, language: 'Tiếng Anh' },
      [msg('u-ute-vy', P(0, 9), 'Submitted.', 'status'), msg('u-ute-quan', P(0, 3), 'Đã duyệt. Bạn nhận bảng điểm tại A1-102 vào thứ Tư.', 'status')], { assignee: 'u-ute-quan' }),
    sr('SR-5099', 'rt-ute-nghi', 'u-ute-tam', 'needs_info', P(2), { semesters: '1 học kỳ', reason: 'Lý do sức khỏe của gia đình.' },
      [msg('u-ute-tam', P(2), 'Submitted.', 'status'), msg('u-ute-phuong', P(1, 4), 'Bạn bổ sung giấy xác nhận của bệnh viện hoặc của địa phương để Phòng Đào tạo xử lý nhé.', 'needs_info')], { assignee: 'u-ute-phuong' }),
    sr('SR-5106', 'rt-ute-miengiam', 'u-ute-linh', 'submitted', P(0, 1), { doituong: 'Hộ cận nghèo', note: 'Gia đình em thuộc hộ cận nghèo năm 2026, có giấy xác nhận của UBND xã.' }, [msg('u-ute-linh', P(0, 1), 'Submitted.', 'status')]),
    sr('SR-5105', 'rt-q-ute-csdl', 'u-ute-khoa', 'submitted', P(0, 5), { question: 'Bài kiểm tra Chương 5 có tính vào điểm quá trình không ạ?' },
      [msg('u-ute-khoa', P(0, 5), 'Submitted.', 'status')], { aiTried: 'Đề cương nêu điểm quá trình gồm các bài kiểm tra trên lớp nhưng không nói rõ bài kiểm tra trực tuyến.' }),
    sr('SR-5092', 'rt-q-ute-csdl', 'u-ute-anh', 'completed', P(8), { question: 'Lab 3 có được dùng CTE (mệnh đề WITH) không ạ?' },
      [msg('u-ute-anh', P(8), 'Submitted.', 'status'), msg('u-ute-hung', P(7, 20), 'Được, các em dùng CTE thoải mái. Thầy đã thêm vào thông báo của lớp.', 'answer')], { assignee: 'u-ute-hung' }),
  ];

  /* ═══════════════ Conversations ═══════════════ */
  const search = (label, detail) => [{ kind: 'search', label, detail }];
  D.convs = [
    { id: 'ute-c1', owner: 'u-ute-anh', title: 'Hạn rút học phần và học phí', at: P(0, 1), scope: [], messages: [
      { id: 'ute-m1', role: 'user', text: 'Hạn rút học phần học kỳ này là khi nào, có được hoàn học phí không?' },
      { id: 'ute-m2', role: 'assistant', activity: search('Searched Phòng Đào tạo', '2 searches · 3 relevant passages'),
        text: 'Bạn được rút học phần đến **cuối tuần thứ 10** của học kỳ. Học phần đã rút được ghi **W** trên bảng điểm và không tính vào điểm trung bình [1].\n\nSau khi rút, bạn phải còn **ít nhất 14 tín chỉ**; thấp hơn thì cần Khoa chấp thuận [2].\n\nHọc phí của học phần đã rút **không được hoàn trả**, trừ khi lớp học phần bị Nhà trường hủy [3].\n\nMình có thể tạo yêu cầu rút học phần giúp bạn.',
        citations: [
          { n: 1, doc: 'ute-pdt-quyche', page: 18, quote: Q.rut },
          { n: 2, doc: 'ute-pdt-quyche', page: 17, quote: Q.tinchi },
          { n: 3, doc: 'ute-pdt-hocphi', page: 5, quote: Q.hoanphi },
        ],
        next: [{ label: 'Tạo yêu cầu rút học phần', act: 'rq-new', data: { type: 'rt-ute-rut' } }] },
    ] },
    { id: 'ute-c2', owner: 'u-ute-anh', title: 'Khác nhau giữa 3NF và BCNF', at: P(1, 2), scope: [], space: 'sp-ute-csdl', messages: [
      { id: 'ute-m3', role: 'user', text: 'Giải thích sự khác nhau giữa 3NF và BCNF kèm ví dụ trong Chương 5.' },
      { id: 'ute-m4', role: 'assistant', activity: search('Searched Khoa Công nghệ Thông tin', '1 search · 3 relevant passages'),
        text: '- **3NF**: không thuộc tính không khóa nào phụ thuộc bắc cầu vào khóa chính [1].\n- **BCNF** chặt hơn: với mọi phụ thuộc hàm X → Y không tầm thường, **X phải là siêu khóa** [2].\n\nVì vậy một lược đồ có thể ở 3NF mà chưa ở BCNF khi có X → Y với X không phải siêu khóa nhưng Y là thuộc tính khóa.\n\nLưu ý: tách về BCNF luôn **không mất mát thông tin** nhưng có thể **không bảo toàn phụ thuộc hàm** [3].',
        citations: [
          { n: 1, doc: C5, page: 9, quote: Q.nf3 },
          { n: 2, doc: C5, page: 14, quote: Q.bcnf },
          { n: 3, doc: C5, page: 18, quote: Q.tach },
        ],
        next: [{ label: 'Tạo bộ câu hỏi luyện tập', act: 'work-start', data: { workflow: 'practice-quiz', space: 'sp-ute-csdl', docs: C5 } }] },
    ] },
    { id: 'ute-c3', owner: 'u-ute-hung', title: 'Ôn tập dạng chuẩn đầu giờ', at: P(0, 7), scope: [], space: 'sp-ute-csdl', messages: [
      { id: 'ute-m5', role: 'user', text: 'Tóm tắt điều kiện của 2NF, 3NF và BCNF để ôn tập đầu giờ.' },
      { id: 'ute-m6', role: 'assistant', activity: search('Searched Khoa Công nghệ Thông tin', '1 search · 3 relevant passages'),
        text: '1. **2NF**: ở 1NF và mọi thuộc tính không khóa phụ thuộc đầy đủ vào khóa chính [1].\n2. **3NF**: thêm điều kiện không có phụ thuộc bắc cầu vào khóa chính [2].\n3. **BCNF**: mọi định thức của phụ thuộc hàm không tầm thường là siêu khóa [3].\n\nTheo kết quả bài kiểm tra Chương 5, câu về 3NF và BCNF có tỉ lệ đúng thấp nhất, nên nên dành thêm thời gian cho phần này.',
        citations: [
          { n: 1, doc: C5, page: 6, quote: Q.nf2 },
          { n: 2, doc: C5, page: 9, quote: Q.nf3 },
          { n: 3, doc: C5, page: 14, quote: Q.bcnf },
        ] },
    ] },
    { id: 'ute-c4', owner: 'u-ute-phuong', title: 'Thời hạn và lệ phí phúc khảo', at: P(1, 5), scope: ['kb-ute-pdt'], space: 'sp-ute-pdt', messages: [
      { id: 'ute-m7', role: 'user', text: 'Sinh viên được phúc khảo trong bao lâu và lệ phí bao nhiêu?' },
      { id: 'ute-m8', role: 'assistant', activity: search('Searched Phòng Đào tạo', '1 search · 2 relevant passages'),
        text: 'Sinh viên nộp đơn phúc khảo **trong vòng 7 ngày** kể từ ngày công bố điểm [1]. Lệ phí là **30.000 đồng/học phần** và được **hoàn lại nếu điểm thay đổi** [2].',
        citations: [
          { n: 1, doc: 'ute-pdt-phuckhao', page: 1, quote: Q.phuckhao },
          { n: 2, doc: 'ute-pdt-phuckhao', page: 2, quote: Q.phuckhaoPhi },
        ],
        next: [{ label: 'Mở mẫu đơn phúc khảo', act: 'res-open', data: { id: 'ute-pdt-f-phuckhao' } }] },
    ] },
    { id: 'ute-c5', owner: 'u-ute-anh', title: 'Điều kiện học bổng khuyến khích', at: P(4), scope: [], messages: [
      { id: 'ute-m9', role: 'user', text: 'Điều kiện xét học bổng khuyến khích học tập là gì?' },
      { id: 'ute-m10', role: 'assistant', activity: search('Searched Phòng Công tác Sinh viên', '1 search · 1 relevant passage'),
        text: 'Bạn cần cả ba điều kiện trong học kỳ xét: **điểm trung bình từ 3,2**, **điểm rèn luyện từ loại Tốt** và **không có học phần bị điểm F** [1].',
        citations: [{ n: 1, doc: 'ute-ctsv-hbkk', page: 3, quote: Q.hbkk }] },
    ] },
  ];
  D.projects = [
    { id: 'ute-pj-thi', owner: 'u-ute-anh', name: 'Ôn thi giữa kỳ HK1', created: P(10), docs: [C5, 'ute-csdl-de2025', 'ute-ml-w04'] },
    { id: 'ute-pj-thutuc', owner: 'u-ute-anh', name: 'Thủ tục học vụ', created: P(6), docs: ['ute-pdt-quyche', 'ute-ctsv-hbkk'] },
  ];
  [['ute-c2', 'ute-pj-thi'], ['ute-c1', 'ute-pj-thutuc'], ['ute-c5', 'ute-pj-thutuc']].forEach(([c, p]) => { D.convs.find(x => x.id === c).project = p; });

  /* ═══════════════ Saved, recent, views ═══════════════ */
  D.saved = {
    'u-ute-anh': [C5, 'ute-pdt-quyche', 'ute-ctsv-hbkk', 'ute-pdt-f-phuckhao'],
    'u-ute-hung': ['ute-csdl-syl', 'ute-httt-detai'],
    'u-ute-phuong': ['ute-pdt-quyche', 'ute-pdt-ngoaingu'],
  };
  D.recent = {
    'u-ute-anh': [{ doc: C5, at: P(0, 1) }, { doc: 'ute-pdt-quyche', at: P(0, 3) }, { doc: 'ute-ml-w04', at: P(1) }, { doc: 'ute-ctsv-hbkk', at: P(4) }],
    'u-ute-hung': [{ doc: 'ute-csdl-de2025', at: P(0, 2) }, { doc: C5, at: P(0, 6) }, { doc: 'ute-httt-detai', at: P(2) }],
    'u-ute-phuong': [{ doc: 'ute-pdt-quyche', at: P(0, 2) }, { doc: 'ute-pdt-lichthi', at: P(0, 4) }, { doc: 'ute-ns-ketqua', at: P(1) }],
  };
  D.views = {
    'u-ute-anh': [{ id: 'vw-ute-1', name: 'Mẫu đơn', query: 'topic=t-bieumau', created: P(12) }],
    'u-ute-phuong': [{ id: 'vw-ute-2', name: 'Quy chế cần rà soát', query: 'topic=t-quyche&trust=review', created: P(25) }],
  };
});

/* Admissions answers (features/chat.js puts them first in its answer table; UTE only). Quotes are on the cited pages. */
const CAMPUS_TOPICS = [
  { k: /tuyển sinh|xét tuyển|điểm chuẩn|trúng tuyển|nguyện vọng|admission|cut-?off score/i, when: () => S.ws === 'ws-campus',
    text: 'Năm 2026, UTE xét tuyển theo **ba phương thức**: điểm thi tốt nghiệp THPT, học bạ THPT và điểm thi đánh giá năng lực của ĐHQG TP.HCM [1].\n\n- **Điểm chuẩn 2025** của ngành Công nghệ Thông tin theo điểm thi tốt nghiệp THPT (tổ hợp A00, A01) là **26,15** [2].\n- Thí sinh **đăng ký nguyện vọng** trên hệ thống của Bộ Giáo dục và Đào tạo **từ ngày 16/7 đến 17 giờ ngày 28/7/2026** [3].\n\nĐiểm chuẩn 2026 được công bố sau khi có kết quả thi; chỉ tiêu từng ngành có trong thông báo tuyển sinh.',
    cites: [
      { doc: 'ute-ts-thongbao', page: 2, quote: 'Năm 2026, Trường xét tuyển theo ba phương thức: điểm thi tốt nghiệp THPT, học bạ THPT và điểm thi đánh giá năng lực của ĐHQG TP.HCM.' },
      { doc: 'ute-ts-diemchuan', page: 1, quote: 'Ngành Công nghệ Thông tin: 26,15 điểm theo phương thức điểm thi tốt nghiệp THPT, tổ hợp A00, A01.' },
      { doc: 'ute-ts-thongbao', page: 9, quote: 'Thí sinh đăng ký nguyện vọng trên Hệ thống của Bộ Giáo dục và Đào tạo từ ngày 16/7 đến 17 giờ ngày 28/7/2026.' },
    ] },
];
