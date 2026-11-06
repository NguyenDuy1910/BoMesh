/**
 * Platform console logic that does not touch the network or React: vocabularies,
 * derived statuses, indexing statistics, policy ↔ form mapping, audit wording and CSV.
 * Kept free of runtime imports so `tests/platform-model.test.mts` can load it directly.
 */

import type { Schema } from "@/lib/api/client";

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
  { value: "active", label: "Active" },
  { value: "new", label: "Setting up" },
  { value: "suspended", label: "Suspended" },
  { value: "archived", label: "Archived" },
];

export type TemplateId = NonNullable<Workspace["template"]>;

/** Preview `TEMPLATES` (label + description), keyed by `Workspace.template`. */
export const TEMPLATES: Record<TemplateId, { label: string; description: string }> = {
  ENTERPRISE: { label: "Enterprise", description: "Company knowledge with governed sources and access." },
  CAMPUS: { label: "Campus", description: "Courses, research groups and offices: learning, research and student services in one workspace." },
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
  if (!name) errors.name = "Enter a name for the workspace.";
  else if (name.length < 2) errors.name = "Use at least 2 characters.";
  if (!code) errors.code = "Enter a web address.";
  else if (!WORKSPACE_CODE_RE.test(code)) errors.code = "Use 3–40 lowercase letters, numbers or hyphens.";
  else if (taken) errors.code = `Already used by ${taken.displayName ?? code}. Try another.`;
  if (!email) errors.email = "Enter the email of the first admin.";
  else if (!EMAIL_RE.test(email)) errors.email = "Enter a full email address, like sam@litware.com.";
  return errors;
}

/* ── Users ──────────────────────────────────────────────────────────────── */

export type PlatformRole = NonNullable<Schema<"User">["platformRole"]>;

export const ROLE_OPTIONS: { value: PlatformRole; label: string }[] = [
  { value: "ADMIN", label: "Platform admin" },
  { value: "OPERATOR", label: "Platform operator" },
  { value: "NONE", label: "Standard" },
];

export function userName(user: Pick<Schema<"User">, "displayName" | "email" | "username">): string {
  return user.displayName?.trim() || user.username || user.email || "Unknown person";
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
  OAUTH: "Sign in with OAuth",
  API_TOKEN: "Site URL and API token",
  NONE: "None",
};

/* ── Indexing ───────────────────────────────────────────────────────────── */

/** Backend `errorClass` vocabulary (provider-neutral, never raw messages), in triage order. */
export const ERROR_CLASSES = {
  unsupported_format: { label: "Unsupported or unreadable", retry: false, hint: "The file couldn’t be parsed. It’s stored, not searchable." },
  content_unavailable: { label: "File unavailable", retry: false, hint: "The file couldn’t be read. The workspace has to replace it." },
  provider_refused: { label: "Refused by the AI provider", retry: false, hint: "The model provider declined this content. A retry rarely helps." },
  interrupted: { label: "Interrupted", retry: true, hint: "Processing stopped before it finished. Usually clears on retry." },
  internal: { label: "Processing error", retry: true, hint: "Something failed while processing. Usually clears on retry." },
} as const satisfies Record<string, { label: string; retry: boolean; hint: string }>;

export type ErrorClass = keyof typeof ERROR_CLASSES;

export function errorClassOf(value: string | null | undefined): ErrorClass {
  return value && value in ERROR_CLASSES ? (value as ErrorClass) : "internal";
}

export const PHASE_LABEL: Record<NonNullable<IngestionTask["phase"]>, string> = {
  QUEUED: "Queued",
  FETCHING: "Fetch",
  PARSING: "Parse",
  OCR: "OCR",
  CHUNKING: "Chunk",
  EMBEDDING: "Embed",
  INDEXING: "Index",
  PUBLISHING: "Publish",
};

/** Preview `JOB` keys; `held` = queued or running while the workspace's ingestion is paused. */
export type JobStatus = "queued" | "running" | "held" | "done" | "failed" | "cancelled";

export const JOB_STATUS: Record<JobStatus, { label: string; tone: "default" | "accent" | "success" | "danger" }> = {
  queued: { label: "Queued", tone: "default" },
  running: { label: "Running", tone: "accent" },
  held: { label: "On hold", tone: "default" },
  done: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "default" },
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

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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
  /** Median processing time of the tasks that succeeded in the last 24 hours. */
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
 * Indexing rows for every workspace. `now` = summary over every run (live queue);
 * `day` = summary over runs created in the last 24 hours (throughput, failure rate, error classes);
 * `tasks` = recent tasks (median processing time).
 */
export function buildIndexing(
  workspaces: readonly Workspace[],
  now: readonly IngestionWorkspaceSummary[],
  day: readonly IngestionWorkspaceSummary[],
  tasks: readonly IngestionTask[],
  at = Date.now(),
): WorkspaceIndexing[] {
  const byWs = (rows: readonly IngestionWorkspaceSummary[]) => new Map(rows.map((r) => [lastSegment(r.workspace), r]));
  const live = byWs(now);
  const recent = byWs(day);
  const durations = new Map<string, number[]>();
  for (const task of tasks) {
    if (task.state !== "SUCCEEDED") continue;
    const end = Date.parse(task.endTime ?? "");
    if (!Number.isFinite(end) || at - end > DAY) continue;
    const ms = taskDuration(task);
    if (ms === null) continue;
    const ws = workspaceIdOf(task.name);
    durations.set(ws, [...(durations.get(ws) ?? []), ms]);
  }
  return workspaces.map((w) => {
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
      medianMs: median(durations.get(id) ?? []),
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
  { id: "sheets", label: "Excel and CSV", mimes: ["application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/csv"] },
  { id: "text", label: "Text and Markdown", mimes: ["text/plain", "text/markdown"] },
  { id: "html", label: "Web pages (HTML)", mimes: ["text/html"] },
  { id: "images", label: "Images (PNG, JPG)", mimes: ["image/png", "image/jpeg"] },
  { id: "zip", label: "ZIP archives", mimes: ["application/zip"] },
] as const;

export type FileTypeGroup = (typeof FILE_TYPE_GROUPS)[number]["id"];

export const MAX_FILE_MB = 2048;
const MB = 1_048_576;

export const RETENTION_OPTIONS: { value: string; label: string }[] = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "180", label: "180 days" },
  { value: "365", label: "1 year" },
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
  if (!form.types.length) errors.types = "Allow at least one file type.";
  if (!form.maxMb.trim() || !Number.isInteger(mb) || mb < 1 || mb > MAX_FILE_MB) {
    errors.maxMb = `Enter a whole number from 1 to ${MAX_FILE_MB.toLocaleString("en")}.`;
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
  KNOWLEDGE: "Knowledge",
  FILES: "Files",
  SOURCES: "Sources",
  PEOPLE: "People & access",
  SETTINGS: "Settings",
  SPACES: "Spaces",
  REQUESTS: "Requests",
  SIGN_IN: "Sign-in",
};

const PAST: Record<string, string> = {
  Create: "Created", Update: "Updated", Delete: "Deleted", Undelete: "Restored", Verify: "Verified", Withdraw: "Withdrew",
  Analyze: "Analyzed", Export: "Exported", Suspend: "Suspended", Activate: "Reactivated", Archive: "Archived",
  Publish: "Published", Unpublish: "Unpublished", Approve: "Approved", Deny: "Denied", Pause: "Paused", Resume: "Resumed",
  Enable: "Turned on", Disable: "Turned off", Retry: "Retried", Cancel: "Cancelled", Move: "Moved", Add: "Added",
  Remove: "Removed", Submit: "Submitted", Revise: "Revised", Commit: "Committed", Rollback: "Rolled back", Join: "Joined",
  Leave: "Left", Answer: "Answered", Close: "Closed", Send: "Sent", Sync: "Synced", Converse: "Asked", Set: "Set",
  Reset: "Reset", Lookup: "Looked up", Request: "Requested", Revoke: "Revoked", Invite: "Invited", Accept: "Accepted",
};

const SPECIAL: Record<string, string> = {
  CreateSession: "Signed in",
  DeleteSession: "Signed out",
  CreateUser: "Created account",
  ResetPassword: "Reset password",
  SendPasswordReset: "Sent password reset",
};

/** API method name (`UpdateWorkspaceSettings`) → plain words ("Updated workspace settings"). */
export function actionLabel(action: string | undefined): string {
  if (!action) return "Unknown action";
  if (SPECIAL[action]) return SPECIAL[action];
  const iam = /^(Set|Get)(\w*)IamPolicy$/.exec(action);
  if (iam) {
    const noun = (iam[2].match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? []).map((w) => w.toLowerCase()).join(" ");
    return `${iam[1] === "Set" ? "Changed" : "Viewed"} ${noun ? `${noun} ` : ""}access`;
  }
  const words = action.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? [action];
  const [verb, ...rest] = words;
  const head = PAST[verb] ?? verb;
  return [head, ...rest.map((w) => w.toLowerCase())].join(" ");
}

/** Window keys (days) → milliseconds. */
export const AUDIT_WINDOWS: { value: string; label: string }[] = [
  { value: "1", label: "24 hours" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
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

/** Preview `status('service', …)` keys from `Component.state`. */
export function serviceStatus(state: Schema<"Component">["state"]): "operational" | "degraded" | "down" | "not_configured" {
  if (state === "HEALTHY") return "operational";
  if (state === "DEGRADED") return "degraded";
  if (state === "DOWN") return "down";
  return "not_configured";
}

/** Components that need attention (nav badge and banner). */
export function unhealthyComponents<T extends Pick<Schema<"Component">, "state">>(components: readonly T[]): T[] {
  return components.filter((c) => c.state === "DEGRADED" || c.state === "DOWN");
}

/** Backend `errorCategory` → plain words. */
export function errorCategoryLabel(category: string | undefined): string {
  if (!category) return "Unknown cause";
  const words = category.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Preview `fmtDur` for incident durations. */
export function fmtIncidentDuration(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  return `${Math.floor(ms / HOUR)} h ${Math.round((ms % HOUR) / 60_000)} min`;
}
