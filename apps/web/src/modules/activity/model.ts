/**
 * Activity log vocabulary (preview `features/activity.js`): plain-language
 * sentences for AuditEvent `action` codes, areas for `category`, time windows
 * and the target kind of a resource name. Pure; covered by `tests/activity-model.test.mts`.
 */

export type Category = "KNOWLEDGE" | "FILES" | "SOURCES" | "PEOPLE" | "SETTINGS" | "SPACES" | "REQUESTS" | "SIGN_IN";

/** Areas in the order people think about them (preview `AREA_ORDER`). Sign-ins have their own section. */
export const AREAS: readonly { value: Category; label: string; module?: "spaces" | "requests" }[] = [
  { value: "KNOWLEDGE", label: "Tài liệu" },
  { value: "FILES", label: "Tệp" },
  { value: "SOURCES", label: "Nguồn" },
  { value: "SPACES", label: "Cộng đồng", module: "spaces" },
  { value: "REQUESTS", label: "Yêu cầu", module: "requests" },
  { value: "PEOPLE", label: "Người dùng & phân quyền" },
  { value: "SETTINGS", label: "Cài đặt" },
  { value: "SIGN_IN", label: "Đăng nhập" },
];

export const areaLabel = (category: string | undefined) => AREAS.find((a) => a.value === category)?.label ?? "Khác";

export type Window = "24h" | "7d" | "30d" | "90d";
/** Time windows (preview `WIN_OPTS`); `summary` is the matching SummarizeAuditEvents window, when there is one. */
export const WINDOWS: readonly { value: Window; label: string; ms: number; summary?: "P1D" | "P7D" | "P30D" }[] = [
  { value: "24h", label: "24 giờ", ms: 86_400_000, summary: "P1D" },
  { value: "7d", label: "7 ngày", ms: 7 * 86_400_000, summary: "P7D" },
  { value: "30d", label: "30 ngày", ms: 30 * 86_400_000, summary: "P30D" },
  { value: "90d", label: "90 ngày", ms: 90 * 86_400_000 },
];

/** Escapes a value for an AIP-160 string literal. */
export const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** ListAuditEvents filter for the window and server-side facets; `exclude` drops one category (Changes has no sign-ins). */
export function auditFilter({ since, category, exclude, actor, outcome }: { since: Date; category?: string; exclude?: string; actor?: string; outcome?: string }): string {
  const parts = [`createTime >= ${quote(since.toISOString())}`];
  if (category) parts.push(`category = ${quote(category)}`);
  else if (exclude) parts.push(`category != ${quote(exclude)}`);
  if (actor) parts.push(`actor = ${quote(actor)}`);
  if (outcome) parts.push(`outcome = ${quote(outcome)}`);
  return parts.join(" AND ");
}

/**
 * How someone signed in, from the event's fixed sentence ("Signed in with Google" → "Google"; a password reads
 * "Mật khẩu"). Any other text is not a method (e.g. a generic "Create session (session)") and reads "—".
 */
export function signInMethod(description: string | undefined): string {
  const m = /^signed in (?:with|using|via) (.+?)\.?$/i.exec(String(description ?? "").trim());
  if (!m) return "—";
  return /^(?:an? )?password$/i.test(m[1]) ? "Mật khẩu" : m[1];
}

/** Sentences for actions whose generic reading would be unclear. */
const SPECIAL: Record<string, string> = {
  CreateSession: "Đã đăng nhập",
  DeleteSession: "Đã đăng xuất",
  CreateItemMedia: "Đã tải lên một tệp",
  CompleteItemUpload: "Đã hoàn tất tải lên",
  CreateMember: "Đã thêm thành viên",
  DeleteMember: "Đã gỡ thành viên",
  SuspendMember: "Đã tạm ngưng thành viên",
  ActivateMember: "Đã kích hoạt lại thành viên",
  CreateMembership: "Đã thêm người vào nhóm",
  DeleteMembership: "Đã gỡ một người khỏi nhóm",
  SetWorkspaceIamPolicy: "Đã thay đổi vai trò trong không gian làm việc",
  SetItemIamPolicy: "Đã thay đổi người có thể mở kho tài liệu",
  SetSpaceIamPolicy: "Đã thay đổi vai trò trong cộng đồng",
  UpdateWorkspace: "Đã đổi tên hoặc địa chỉ không gian làm việc",
  UpdateWorkspaceSettings: "Đã thay đổi thiết lập không gian làm việc",
  UploadMapBackground: "Đã đổi ảnh nền bản đồ Trang chủ",
  UploadWorkspaceLogo: "Đã đổi logo không gian làm việc",
  UpdateWorkspaceAssistant: "Đã cập nhật thiết lập trợ lý",
  ArchiveWorkspace: "Đã lưu trữ không gian làm việc",
  CreateIngestionRun: "Đã bắt đầu xử lý tài liệu",
  CancelIngestionRun: "Đã hủy một lượt xử lý",
  CreateSync: "Đã bắt đầu đồng bộ",
  PauseWorkspaceIngestion: "Đã tạm dừng xử lý cho không gian làm việc",
  ResumeWorkspaceIngestion: "Đã tiếp tục xử lý cho không gian làm việc",
  SendBackRequest: "Đã gửi trả yêu cầu",
  CreateSpaceMember: "Đã thêm người vào cộng đồng",
  DeleteSpaceMember: "Đã gỡ một người khỏi cộng đồng",
  VerifyItem: "Đã đánh dấu tài liệu là đã xác minh",
  PublishItem: "Đã công bố một tài liệu",
  UnpublishItem: "Đã ngừng công bố tài liệu",
  ApproveContribution: "Đã duyệt tài liệu đã gửi",
  RejectContribution: "Đã từ chối tài liệu đã gửi",
  RequestContributionChanges: "Đã yêu cầu chỉnh sửa tài liệu đã gửi",
  AnalyzeContribution: "Đã xử lý tài liệu đã gửi",
  ApproveRequest: "Đã phê duyệt yêu cầu",
  DenyRequest: "Đã từ chối yêu cầu",
  ExportAuditEvents: "Đã xuất nhật ký hoạt động",
  CreateShare: "Đã chia sẻ liên kết",
  DeleteShare: "Đã ngừng chia sẻ liên kết",
  AcceptShare: "Đã tham gia bằng liên kết mời",
  CreateConceptScheme: "Đã thêm một trục phân loại",
  UpdateConceptScheme: "Đã sửa thiết lập một trục phân loại",
  PublishConceptScheme: "Đã công bố một trục phân loại",
  ApplyConceptSchemeTemplateChanges: "Đã áp dụng thay đổi của mẫu cho một trục phân loại",
  ImportConcepts: "Đã nhập khái niệm",
  CreateConcept: "Đã thêm một khái niệm",
  UpdateConcept: "Đã sửa một khái niệm",
  DeprecateConcept: "Đã ngừng dùng một khái niệm",
  DeleteConcept: "Đã xóa một khái niệm nháp",
  ConfirmConceptAssignments: "Đã xác nhận khái niệm được gợi ý",
  RejectConceptAssignments: "Đã từ chối khái niệm được gợi ý",
  AcceptConceptProposal: "Đã chấp nhận một đề xuất phân loại",
  RejectConceptProposal: "Đã từ chối một đề xuất phân loại",
  CreateConceptGroup: "Đã thêm một nhóm khái niệm",
  UpdateConceptGroup: "Đã sửa một nhóm khái niệm",
  DeleteConceptGroup: "Đã xóa một nhóm khái niệm",
  CreateConceptRule: "Đã thêm một quy tắc phân loại",
  UpdateConceptRule: "Đã sửa một quy tắc phân loại",
  DeleteConceptRule: "Đã xóa một quy tắc phân loại",
  ImportMemberAffiliations: "Đã nhập đơn vị và chương trình của thành viên",
  MergeItem: "Đã hợp nhất bản trùng lặp",
  RollbackItem: "Đã khôi phục phiên bản trước của một tài liệu",
  ReviseArtifact: "Đã cập nhật mục công việc",
  RollbackArtifact: "Đã khôi phục phiên bản trước của mục công việc",
  CompleteConnectionAuthorization: "Đã kết nối một tài khoản",
  LeaveWorkspace: "Đã rời không gian làm việc",
  SendPasswordReset: "Đã gửi liên kết đặt lại mật khẩu",
  MarkNotificationsRead: "Đã đánh dấu thông báo là đã đọc",
  ConverseConversation: "Đã đặt câu hỏi cho trợ lý",
};

/** Action verbs (first word of the code), as the Vietnamese verb after "Đã". */
const VERB: Record<string, string> = {
  Create: "tạo",
  Update: "cập nhật",
  Delete: "xóa",
  Undelete: "khôi phục",
  Set: "thay đổi",
  Add: "thêm",
  Remove: "gỡ",
  Move: "di chuyển",
  Publish: "công bố",
  Unpublish: "ngừng công bố",
  Verify: "xác minh",
  Approve: "duyệt",
  Deny: "từ chối",
  Reject: "từ chối",
  Accept: "chấp nhận",
  Merge: "hợp nhất",
  Archive: "lưu trữ",
  Suspend: "tạm ngưng",
  Activate: "kích hoạt lại",
  Pause: "tạm dừng",
  Resume: "tiếp tục",
  Cancel: "hủy",
  Retry: "thử lại",
  Enable: "bật",
  Disable: "tắt",
  Export: "xuất",
  Import: "nhập",
  Answer: "trả lời",
  Close: "đóng",
  Withdraw: "rút lại",
  Resubmit: "gửi lại",
  Revise: "chỉnh sửa",
  Commit: "lưu",
  Rollback: "khôi phục phiên bản trước của",
  Dismiss: "bỏ qua",
  Reopen: "mở lại",
  Join: "tham gia",
  Leave: "rời",
  Test: "kiểm tra",
  Reauthorize: "kết nối lại",
  Complete: "hoàn tất",
  Send: "gửi",
  Reset: "đặt lại",
  Submit: "gửi",
  Copy: "sao chép",
  Mark: "đánh dấu",
  Clear: "xóa",
  Analyze: "phân tích",
  Sync: "đồng bộ",
  Converse: "hỏi",
  Lookup: "tra cứu",
  Request: "yêu cầu",
  Revoke: "thu hồi",
  Invite: "mời",
  Upload: "tải lên",
  Confirm: "xác nhận",
  Resolve: "mở",
  Compile: "tạo",
  Summarize: "tổng hợp",
  Get: "xem",
  List: "xem danh sách",
  Search: "tìm kiếm",
  Browse: "xem",
};

/** Code nouns (lowercase, singular) in product words; internal nouns people never see read as the product word. */
const NOUN: Record<string, string> = {
  item: "mục",
  ingestion: "xử lý",
  access: "quyền truy cập",
  policy: "chính sách",
  tenant: "không gian làm việc",
  workspace: "không gian làm việc",
  collection: "kho tài liệu",
  artifact: "mục công việc",
  connection: "tài khoản đã kết nối",
  connector: "trình kết nối",
  space: "cộng đồng",
  group: "nhóm",
  role: "vai trò",
  member: "thành viên",
  membership: "tư cách thành viên",
  user: "người dùng",
  session: "phiên đăng nhập",
  share: "liên kết chia sẻ",
  source: "nguồn dữ liệu",
  settings: "thiết lập",
  assistant: "trợ lý",
  schedule: "lịch",
  run: "lượt",
  sync: "lượt đồng bộ",
  request: "yêu cầu",
  type: "loại",
  message: "tin nhắn",
  concept: "khái niệm",
  scheme: "trục phân loại",
  proposal: "đề xuất",
  version: "phiên bản",
  contribution: "bài gửi",
  announcement: "thông báo chung",
  notification: "thông báo",
  conversation: "cuộc trò chuyện",
  material: "tài liệu tham khảo",
  event: "sự kiện",
  audit: "nhật ký",
  platform: "nền tảng",
  revision: "phiên bản",
  shortcut: "lối tắt",
  saved: "đã lưu",
  search: "tìm kiếm",
  recent: "gần đây",
  knowledge: "tài liệu",
  gap: "khoảng trống",
  correction: "lần sửa",
  classification: "phân loại",
  prompt: "câu lệnh",
  feedback: "phản hồi",
  usage: "mức sử dụng",
  preferences: "tùy chọn",
  logo: "logo",
  map: "bản đồ",
  background: "ảnh nền",
  media: "tệp",
  upload: "lượt tải lên",
  password: "mật khẩu",
  home: "trang chủ",
  overview: "tổng quan",
  preview: "bản xem trước",
  passage: "đoạn trích",
  permission: "quyền",
  operation: "thao tác",
  component: "thành phần",
  incident: "sự cố",
  task: "tác vụ",
  resource: "tài nguyên",
  predefined: "định sẵn",
  assignment: "phân công",
};

/** Head nouns there is only one of: the sentence names them without "một". */
const SINGLE: Record<string, true> = {
  workspace: true,
  settings: true,
  assistant: true,
  access: true,
  policy: true,
  preferences: true,
  logo: true,
  background: true,
  home: true,
  overview: true,
  usage: true,
  password: true,
};

/** A code word's singular form and whether it was plural (`collections` → `collection`). */
function singular(word: string): { word: string; plural: boolean } {
  if (NOUN[word]) return { word, plural: false };
  for (const [suffix, repl] of [["ies", "y"], ["es", ""], ["s", ""]] as const) {
    const base = word.endsWith(suffix) ? word.slice(0, -suffix.length) + repl : "";
    if (base && NOUN[base]) return { word: base, plural: true };
  }
  return { word, plural: false };
}

/**
 * Plain sentence for an audit `action` (`CreateSpace` → "Đã tạo một cộng đồng"). Never returns the raw code. `item`
 * names the target when it is known (e.g. "kho tài liệu"), instead of the generic "mục". Vietnamese puts the head noun
 * first, so the code's nouns read in reverse (`IngestionSchedule` → "lịch xử lý").
 */
export function describeAction(action: string | undefined | null, item?: string): string {
  const code = String(action ?? "").trim();
  if (!code) return "Đã thực hiện một thao tác";
  if (SPECIAL[code]) return SPECIAL[code];
  // "ConceptScheme" is one thing (a trục phân loại), not a scheme of concepts.
  const words = code
    .replace(/Iam(?:Policy|Permissions)$/, "Access")
    .replace("ConceptScheme", "Scheme")
    .match(/[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])/g);
  const verb = words?.length ? VERB[words[0]] : undefined;
  if (!words || !verb) return "Đã thực hiện một thao tác";
  const nouns = words.slice(1).map((w) => singular(w.toLowerCase()));
  if (!nouns.length) return `Đã ${verb}`;
  const known = nouns.filter((n) => NOUN[n.word]);
  const head = known.at(-1);
  if (!head) return `Đã ${verb} một mục`;
  const phrase = known
    .reverse()
    .map((n) => (n.word === "item" && item ? item : NOUN[n.word]))
    .join(" ");
  const article = head.plural ? "các " : SINGLE[head.word] ? "" : "một ";
  return `Đã ${verb} ${article}${phrase}`;
}

export type TargetKind =
  | "member"
  | "user"
  | "group"
  | "role"
  | "item"
  | "space"
  | "source"
  | "connection"
  | "settings"
  | "assistant"
  | "workspace"
  | "session"
  | "request"
  | "scheme"
  | "concept"
  | "proposal"
  | "rule"
  | "contribution"
  | "artifact"
  | "other";

/** What a target resource name points at, and its bare ID (a concept's own ID, not its scheme's). */
export function targetOf(name: string | undefined | null): { kind: TargetKind; id: string } {
  const parts = String(name ?? "").split("/");
  const id = parts[parts.length - 1] ?? "";
  if (!name) return { kind: "other", id: "" };
  if (parts[0] === "sessions") return { kind: "session", id };
  if (parts[0] === "users") return { kind: "user", id };
  if (parts[0] !== "workspaces") return { kind: "other", id };
  if (parts.length === 2) return { kind: "workspace", id };
  if (parts[2] === "conceptSchemes") return parts[4] === "concepts" && parts[5] ? { kind: "concept", id: parts[5] } : { kind: "scheme", id: parts[3] ?? "" };
  const KINDS: Record<string, TargetKind> = {
    members: "member",
    groups: "group",
    roles: "role",
    items: "item",
    spaces: "space",
    sources: "source",
    connections: "connection",
    settings: "settings",
    assistant: "assistant",
    requests: "request",
    conceptProposals: "proposal",
    conceptRules: "rule",
    contributions: "contribution",
    artifacts: "artifact",
  };
  return { kind: KINDS[parts[2]] ?? "other", id: parts.length > 3 ? parts[3] : id };
}
