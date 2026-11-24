/**
 * Platform console logic that does not touch the network or React: vocabularies,
 * derived statuses, indexing statistics, policy ↔ form mapping, audit wording and CSV.
 * Imports only other pure models (by `.ts` path) so `tests/platform-model.test.mts` can load it directly.
 */

import type { Schema } from "@/lib/api/client";

import { describeAction } from "../activity/model.ts";

type Workspace = Schema<"Workspace">;
type IngestionTask = Schema<"IngestionTask">;
type IngestionWorkspaceSummary = Schema<"IngestionWorkspaceSummary">;
type IngestionPolicy = Schema<"IngestionPolicy">;

const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** Last segment of a resource name (`workspaces/w` → `w`). */
export function lastSegment(name: string | null | undefined): string {
  if (!name) return "";
  const i = name.lastIndexOf("/");
  return i < 0 ? name : name.slice(i + 1);
}

/** Workspace ID inside any `workspaces/{w}/…` resource name; empty when the name has none. */
export function workspaceIdOf(name: string | null | undefined): string {
  const match = /^workspaces\/([^/]+)/.exec(name ?? "");
  return match && match[1] !== "-" ? match[1] : "";
}

/* ── Workspaces ─────────────────────────────────────────────────────────── */

/** Preview `WS_STATUS` keys (`status('ws', …)`), from `Workspace.state`. */
export type WorkspaceStatus = "active" | "new" | "suspended" | "archived";

export function workspaceStatus(state: Workspace["state"]): WorkspaceStatus {
  if (state === "CREATING") return "new";
  if (state === "SUSPENDED") return "suspended";
  if (state === "ARCHIVED") return "archived";
  return "active";
}

export const WORKSPACE_STATUS_OPTIONS: { value: WorkspaceStatus; label: string }[] = [
  { value: "active", label: "Đang hoạt động" },
  { value: "new", label: "Đang thiết lập" },
  { value: "suspended", label: "Đã tạm ngưng" },
  { value: "archived", label: "Đã lưu trữ" },
];

export type TemplateId = NonNullable<Workspace["template"]>;

/** Preview `TEMPLATES` (label + description), keyed by `Workspace.template`. */
export const TEMPLATES: Record<TemplateId, { label: string; description: string }> = {
  ENTERPRISE: { label: "Doanh nghiệp", description: "Tài liệu doanh nghiệp với nguồn dữ liệu và quyền truy cập được quản lý." },
  CAMPUS: { label: "Trường học", description: "Khóa học, nhóm nghiên cứu và văn phòng: học tập, nghiên cứu và dịch vụ sinh viên trong một không gian làm việc." },
};

/** Preview `slug()`: a web address suggested from the workspace name. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

export const WORKSPACE_CODE_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface NewWorkspaceForm {
  name: string;
  code: string;
  email: string;
}

export type NewWorkspaceErrors = Partial<Record<keyof NewWorkspaceForm, string>>;

/** Preview `newErrors()`; `taken` is the workspace already using the address, if any. */
export function newWorkspaceErrors(form: NewWorkspaceForm, taken?: { displayName?: string } | null): NewWorkspaceErrors {
  const errors: NewWorkspaceErrors = {};
  const name = form.name.trim();
  const code = form.code.trim();
  const email = form.email.trim();
  if (!name) errors.name = "Nhập tên cho không gian làm việc.";
  else if (name.length < 2) errors.name = "Dùng ít nhất 2 ký tự.";
  if (!code) errors.code = "Nhập địa chỉ web.";
  else if (!WORKSPACE_CODE_RE.test(code)) errors.code = "Dùng 3–40 chữ thường, số hoặc dấu gạch ngang.";
  else if (taken) errors.code = `Đã được ${taken.displayName ?? code} sử dụng. Hãy thử tên khác.`;
  if (!email) errors.email = "Nhập email của quản trị viên đầu tiên.";
  else if (!EMAIL_RE.test(email)) errors.email = "Nhập địa chỉ email đầy đủ, ví dụ sam@litware.com.";
  return errors;
}

/* ── Users ──────────────────────────────────────────────────────────────── */

export type PlatformRole = NonNullable<Schema<"User">["platformRole"]>;

export const ROLE_OPTIONS: { value: PlatformRole; label: string }[] = [
  { value: "ADMIN", label: "Quản trị viên nền tảng" },
  { value: "OPERATOR", label: "Người vận hành nền tảng" },
  { value: "NONE", label: "Tiêu chuẩn" },
];

export function userName(user: Pick<Schema<"User">, "displayName" | "email" | "username">): string {
  return user.displayName?.trim() || user.username || user.email || "Người không xác định";
}

/* ── Connectors ─────────────────────────────────────────────────────────── */

/** Preview `status('connector', …)` keys from `Connector.state`. */
export function connectorStatus(state: Schema<"Connector">["state"]): "enabled" | "disabled" | "unavailable" {
  if (state === "ACTIVE") return "enabled";
  if (state === "DISABLED") return "disabled";
  return "unavailable";
}

/** Catalog ID (`connectors/google_drive`) → Kit `AppIcon` key. */
export function connectorApp(name: string | undefined): string {
  const id = lastSegment(name);
  if (id === "google_drive") return "gdrive";
  return id;
}

export const AUTH_LABEL: Record<NonNullable<Schema<"Connector">["authenticationType"]>, string> = {
  OAUTH: "Đăng nhập bằng OAuth",
  API_TOKEN: "URL trang và token API",
  NONE: "Không có",
};

/* ── Indexing ───────────────────────────────────────────────────────────── */

/** Backend `errorClass` vocabulary (provider-neutral, never raw messages), in triage order. */
export const ERROR_CLASSES = {
  unsupported_format: { label: "Không hỗ trợ hoặc không đọc được", retry: false, hint: "Không phân tích được tệp. Tệp được lưu nhưng không tra cứu được." },
  content_unavailable: { label: "Tệp không khả dụng", retry: false, hint: "Không đọc được tệp. Không gian làm việc phải thay tệp này." },
  provider_refused: { label: "Nhà cung cấp AI đã từ chối", retry: false, hint: "Nhà cung cấp mô hình đã từ chối nội dung này. Thử lại hiếm khi có tác dụng." },
  interrupted: { label: "Bị gián đoạn", retry: true, hint: "Quá trình xử lý dừng trước khi xong. Thường sẽ ổn khi thử lại." },
  internal: { label: "Lỗi xử lý", retry: true, hint: "Đã có lỗi khi xử lý. Thử lại thường sẽ khắc phục được." },
} as const satisfies Record<string, { label: string; retry: boolean; hint: string }>;

export type ErrorClass = keyof typeof ERROR_CLASSES;

export function errorClassOf(value: string | null | undefined): ErrorClass {
  return value && value in ERROR_CLASSES ? (value as ErrorClass) : "internal";
}

export const PHASE_LABEL: Record<NonNullable<IngestionTask["phase"]>, string> = {
  QUEUED: "Đang chờ",
  FETCHING: "Tải về",
  PARSING: "Phân tích",
  OCR: "OCR",
  CLASSIFYING: "Phân loại",
  CHUNKING: "Phân đoạn",
  EMBEDDING: "Cho phép tra cứu",
  INDEXING: "Lập chỉ mục",
};

/** Preview `JOB` keys; `held` = queued or running while the workspace's ingestion is paused. */
export type JobStatus = "queued" | "running" | "held" | "done" | "failed" | "cancelled";

export const JOB_STATUS: Record<JobStatus, { label: string; tone: "default" | "accent" | "success" | "danger" }> = {
  queued: { label: "Đang chờ", tone: "default" },
  running: { label: "Đang chạy", tone: "accent" },
  held: { label: "Đang chờ", tone: "default" },
  done: { label: "Xong", tone: "success" },
  failed: { label: "Lỗi", tone: "danger" },
  cancelled: { label: "Đã hủy", tone: "default" },
};

export function jobStatus(task: Pick<IngestionTask, "state">, paused: boolean): JobStatus {
  switch (task.state) {
    case "QUEUED":
      return paused ? "held" : "queued";
    case "RUNNING":
      return paused ? "held" : "running";
    case "SUCCEEDED":
      return "done";
    case "FAILED":
      return "failed";
    default:
      return "cancelled";
  }
}

/** Processing time of a finished task (start, or creation when it never reported a start, to end). */
export function taskDuration(task: Pick<IngestionTask, "startTime" | "createTime" | "endTime">): number | null {
  const start = Date.parse(task.startTime ?? task.createTime ?? "");
  const end = Date.parse(task.endTime ?? "");
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

/** A protobuf Duration ("12.5s") in milliseconds; null when absent. */
function durationMs(value: string | undefined): number | null {
  const s = value ? Number.parseFloat(value) : NaN;
  return Number.isFinite(s) ? s * 1000 : null;
}

/** A failure rate at or above this marks a workspace degraded. */
export const DEGRADED_FAILURE_RATE = 0.05;

export type IndexStatus = "healthy" | "degraded" | "paused";

/** One row of the Indexing table (job metadata only). */
export interface WorkspaceIndexing {
  workspaceId: string;
  status: IndexStatus;
  paused: boolean;
  /** Queued + running tasks now. */
  queue: number;
  /** Tasks that succeeded in the last 24 hours. */
  published24: number;
  /** Failed share of the tasks that finished in the last 24 hours. */
  failureRate: number;
  /** Median processing time of the tasks that succeeded in the last 24 hours (server summary). */
  medianMs: number | null;
  /** Failed tasks in the last 24 hours, by class, most frequent first. */
  errors: { errorClass: ErrorClass; count: number }[];
  /** Failed tasks in the last 24 hours that a retry can fix. */
  retryable: number;
  failed: number;
}

export function indexStatus(paused: boolean, failureRate: number, failed: number): IndexStatus {
  if (paused) return "paused";
  return failed > 0 && failureRate >= DEGRADED_FAILURE_RATE ? "degraded" : "healthy";
}

function mergeErrors(classes: IngestionWorkspaceSummary["errorClasses"]): { errorClass: ErrorClass; count: number }[] {
  const counts = new Map<ErrorClass, number>();
  for (const entry of classes ?? []) {
    const key = errorClassOf(entry.errorClass);
    counts.set(key, (counts.get(key) ?? 0) + (entry.taskCount ?? 0));
  }
  const order = Object.keys(ERROR_CLASSES);
  return [...counts]
    .map(([errorClass, count]) => ({ errorClass, count }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count || order.indexOf(a.errorClass) - order.indexOf(b.errorClass));
}

/**
 * Indexing rows for every workspace that can index (archived ones are read-only and left out). `now` = summary over every run (live queue);
 * `day` = summary over runs created in the last 24 hours (throughput, failure rate, error classes).
 */
export function buildIndexing(workspaces: readonly Workspace[], now: readonly IngestionWorkspaceSummary[], day: readonly IngestionWorkspaceSummary[]): WorkspaceIndexing[] {
  const byWs = (rows: readonly IngestionWorkspaceSummary[]) => new Map(rows.map((r) => [lastSegment(r.workspace), r]));
  const live = byWs(now);
  const recent = byWs(day);
  return workspaces.filter((w) => w.state !== "ARCHIVED").map((w) => {
    const id = lastSegment(w.name);
    const q = live.get(id);
    const d = recent.get(id);
    const paused = w.ingestionState === "PAUSED";
    const errors = mergeErrors(d?.errorClasses);
    const failed = errors.reduce((a, e) => a + e.count, 0);
    const failureRate = d?.failureRate ?? 0;
    return {
      workspaceId: id,
      status: indexStatus(paused, failureRate, failed),
      paused,
      queue: (q?.queuedTaskCount ?? 0) + (q?.runningTaskCount ?? 0),
      published24: Math.round((d?.throughputPerHour ?? 0) * 24),
      failureRate,
      medianMs: durationMs(d?.medianProcessingDuration),
      errors,
      failed,
      retryable: errors.filter((e) => ERROR_CLASSES[e.errorClass].retry).reduce((a, e) => a + e.count, 0),
    };
  });
}

const STATUS_ORDER: IndexStatus[] = ["paused", "degraded", "healthy"];

/** Preview order: paused, then degraded, then healthy; longest queue first inside each. */
export function sortIndexing(rows: readonly WorkspaceIndexing[]): WorkspaceIndexing[] {
  return [...rows].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || b.queue - a.queue);
}

/** Nav badge: workspaces that need attention (degraded or paused). */
export function indexingAlerts(rows: readonly WorkspaceIndexing[]): number {
  return rows.filter((r) => r.status !== "healthy").length;
}

/** Preview `fmtPct` for failure rates. */
export function fmtRate(rate: number): string {
  if (!rate) return "0%";
  return `${(rate * 100).toFixed(rate < 0.1 ? 1 : 0)}%`;
}

/* ── Ingestion policy ───────────────────────────────────────────────────── */

/** Preview `TYPES`: file-type groups and the MIME types each one allows. */
export const FILE_TYPE_GROUPS = [
  { id: "pdf", label: "PDF", mimes: ["application/pdf"] },
  { id: "word", label: "Word (DOC, DOCX)", mimes: ["application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"] },
  { id: "slides", label: "PowerPoint (PPT, PPTX)", mimes: ["application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation"] },
  { id: "sheets", label: "Excel và CSV", mimes: ["application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/csv"] },
  { id: "text", label: "Văn bản và Markdown", mimes: ["text/plain", "text/markdown"] },
  { id: "html", label: "Trang web (HTML)", mimes: ["text/html"] },
  { id: "images", label: "Hình ảnh (PNG, JPG)", mimes: ["image/png", "image/jpeg"] },
  { id: "zip", label: "Tệp nén ZIP", mimes: ["application/zip"] },
] as const;

export type FileTypeGroup = (typeof FILE_TYPE_GROUPS)[number]["id"];

export const MAX_FILE_MB = 2048;
const MB = 1_048_576;

export const RETENTION_OPTIONS: { value: string; label: string }[] = [
  { value: "7", label: "7 ngày" },
  { value: "30", label: "30 ngày" },
  { value: "90", label: "90 ngày" },
  { value: "180", label: "180 ngày" },
  { value: "365", label: "1 năm" },
];

export interface PolicyForm {
  types: FileTypeGroup[];
  maxMb: string;
  ocr: boolean;
  sheets: boolean;
  /** Days, as a string (select value). */
  retention: string;
}

/** Protobuf Duration JSON (`"2592000s"`) → whole days. */
export function durationDays(value: string | undefined): number {
  const seconds = Number.parseFloat((value ?? "").replace(/s$/, ""));
  return Number.isFinite(seconds) ? Math.round(seconds / 86_400) : 30;
}

export function policyForm(policy: IngestionPolicy): PolicyForm {
  const allowed = new Set(policy.allowedMimeTypes ?? []);
  const bytes = Number(policy.maxFileSizeBytes ?? 0);
  return {
    types: FILE_TYPE_GROUPS.filter((g) => g.mimes.some((m) => allowed.has(m))).map((g) => g.id),
    maxMb: String(Math.round(bytes / MB)),
    ocr: policy.ocrScannedPdfs ?? false,
    sheets: policy.parseSpreadsheets ?? false,
    retention: String(durationDays(policy.rejectedRetentionDuration)),
  };
}

function normalized(form: PolicyForm): string {
  const types = FILE_TYPE_GROUPS.map((g) => g.id).filter((id) => form.types.includes(id));
  return JSON.stringify([types, Number(form.maxMb), form.ocr, form.sheets, form.retention]);
}

export function policyDirty(form: PolicyForm, saved: PolicyForm): boolean {
  return normalized(form) !== normalized(saved);
}

export function policyErrors(form: PolicyForm): Partial<Record<"types" | "maxMb", string>> {
  const errors: Partial<Record<"types" | "maxMb", string>> = {};
  const mb = Number(form.maxMb);
  if (!form.types.length) errors.types = "Cho phép ít nhất một loại tệp.";
  if (!form.maxMb.trim() || !Number.isInteger(mb) || mb < 1 || mb > MAX_FILE_MB) {
    errors.maxMb = `Nhập số nguyên từ 1 đến ${MAX_FILE_MB.toLocaleString("vi-VN")}.`;
  }
  return errors;
}

/**
 * The PATCH body for a form. MIME types outside every group (set in the deployment) are kept;
 * a group's MIME types are added when it is checked and removed when it is not.
 */
export function policyPatch(form: PolicyForm, current: IngestionPolicy): IngestionPolicy {
  const grouped = new Set<string>(FILE_TYPE_GROUPS.flatMap((g) => [...g.mimes]));
  const kept = (current.allowedMimeTypes ?? []).filter((m) => !grouped.has(m));
  const chosen = FILE_TYPE_GROUPS.filter((g) => form.types.includes(g.id)).flatMap((g) => [...g.mimes]);
  return {
    allowedMimeTypes: [...kept, ...chosen],
    maxFileSizeBytes: String(Number(form.maxMb) * MB),
    ocrScannedPdfs: form.ocr,
    parseSpreadsheets: form.sheets,
    rejectedRetentionDuration: `${Number(form.retention) * 86_400}s`,
    etag: current.etag,
  };
}

export const POLICY_MASK = "allowedMimeTypes,maxFileSizeBytes,ocrScannedPdfs,parseSpreadsheets,rejectedRetentionDuration";

/* ── Audit ──────────────────────────────────────────────────────────────── */

export const CATEGORY_LABEL: Record<NonNullable<Schema<"AuditEvent">["category"]>, string> = {
  KNOWLEDGE: "Tài liệu",
  FILES: "Tệp",
  SOURCES: "Nguồn",
  PEOPLE: "Người dùng & phân quyền",
  SETTINGS: "Cài đặt",
  SPACES: "Cộng đồng",
  REQUESTS: "Yêu cầu",
  SIGN_IN: "Đăng nhập",
};

/**
 * Workspace-scoped events the platform Audit log shows: the workspace's lifecycle and indexing state, which the
 * platform decides. Everything else inside a workspace stays in that workspace's Activity (SCREEN_INVENTORY).
 */
export const PLATFORM_WORKSPACE_ACTIONS: readonly string[] = [
  "CreateWorkspace",
  "UpdateWorkspace",
  "SuspendWorkspace",
  "ActivateWorkspace",
  "ArchiveWorkspace",
  "PauseWorkspaceIngestion",
  "ResumeWorkspaceIngestion",
];

/** Audit page cursor over both streams: events at or before `before`, minus the `seen` ones already shown at that instant. */
export interface AuditCursor {
  before: string;
  seen: string[];
}

type AuditStamp = { name?: string; createTime?: string };

/**
 * One merged audit page from a read of each stream at `cursor`: the newest `pageSize` events not already shown, and
 * the cursor after them (null on the last page). `more` = a stream has events beyond what it returned.
 */
export function mergeAuditPage<P extends AuditStamp, W extends AuditStamp>(
  platform: readonly P[],
  workspace: readonly W[],
  cursor: AuditCursor | null,
  pageSize: number,
  more: boolean,
): { platform: P[]; workspace: W[]; next: AuditCursor | null } {
  const seen = new Set(cursor?.seen ?? []);
  const tagged = [...platform.map((e) => ({ e, platform: true })), ...workspace.map((e) => ({ e, platform: false }))]
    .filter(({ e }) => !seen.has(e.name ?? ""))
    .sort((a, b) => (b.e.createTime ?? "").localeCompare(a.e.createTime ?? ""));
  const shown = tagged.slice(0, pageSize);
  const last = shown.at(-1)?.e.createTime;
  const atLast = shown.filter(({ e }) => e.createTime === last).map(({ e }) => e.name ?? "");
  return {
    platform: shown.flatMap((t) => (t.platform ? [t.e as P] : [])),
    workspace: shown.flatMap((t) => (t.platform ? [] : [t.e as W])),
    next: (more || tagged.length > pageSize) && last ? { before: last, seen: [...(cursor?.before === last ? seen : []), ...atLast] } : null,
  };
}

/** Platform-console wording that differs from the workspace Activity sentences. */
const SPECIAL: Record<string, string> = {
  CreateUser: "Đã tạo tài khoản",
  ResetPassword: "Đã đặt lại mật khẩu",
  PauseWorkspaceIngestion: "Đã tạm dừng lập chỉ mục",
  ResumeWorkspaceIngestion: "Đã tiếp tục lập chỉ mục",
  UpdateIngestionPolicy: "Đã cập nhật chính sách lập chỉ mục",
};

/** API method name (`SuspendWorkspace`) → plain sentence ("Đã tạm ngưng không gian làm việc"). */
export function actionLabel(action: string | undefined): string {
  if (!action) return "Hành động không xác định";
  return SPECIAL[action] ?? describeAction(action);
}

/** Window keys (days) → milliseconds. */
export const AUDIT_WINDOWS: { value: string; label: string }[] = [
  { value: "1", label: "24 giờ" },
  { value: "7", label: "7 ngày" },
  { value: "30", label: "30 ngày" },
  { value: "90", label: "90 ngày" },
];

/** One CSV document (RFC 4180 quoting), CRLF line ends. */
export function toCsv(rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n");
}

/* ── Health ─────────────────────────────────────────────────────────────── */

export type ServiceStatus = "operational" | "degraded" | "down" | "not_configured";

/** Preview `status('service', …)` keys from `Component.state`. */
export function serviceStatus(state: Schema<"Component">["state"]): ServiceStatus {
  if (state === "HEALTHY") return "operational";
  if (state === "DEGRADED") return "degraded";
  if (state === "DOWN") return "down";
  return "not_configured";
}

/** Components that need attention (nav badge and banner). */
export function unhealthyComponents<T extends Pick<Schema<"Component">, "state">>(components: readonly T[]): T[] {
  return components.filter((c) => c.state === "DEGRADED" || c.state === "DOWN");
}

/** Backend `errorCategory` (`bomesh/health.py`) → plain words. */
const ERROR_CATEGORY: Record<string, string> = {
  timeout: "Hết thời gian chờ",
  connection_failed: "Không kết nối được",
  invalid_response: "Phản hồi không hợp lệ",
  no_project_access: "Không có quyền truy cập dự án",
  incomplete_configuration: "Cấu hình chưa đầy đủ",
  not_configured: "Chưa cấu hình",
  authentication_failed: "Xác thực thất bại",
  resource_not_found: "Không tìm thấy tài nguyên",
  rate_limited: "Bị giới hạn tần suất",
  upstream_error: "Lỗi từ dịch vụ bên ngoài",
};

export function errorCategoryLabel(category: string | undefined): string {
  if (!category) return "Không rõ nguyên nhân";
  return ERROR_CATEGORY[category] ?? "Lỗi dịch vụ";
}

/** Preview `fmtDur` for incident durations. */
export function fmtIncidentDuration(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60_000))} phút`;
  return `${Math.floor(ms / HOUR)} giờ ${Math.round((ms % HOUR) / 60_000)} phút`;
}
