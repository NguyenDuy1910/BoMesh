import type { Schema } from "@/lib/api/client";
import { relInline } from "@/lib/format";
import type { ChipVariant, Tone } from "@/components/ui";

/**
 * Requests vocabulary (preview `features/requests.js`) mapped onto the API's
 * Request lifecycle (api_design.md §8): OPEN ⇄ NEEDS_INFO, then APPROVED,
 * DENIED, ANSWERED, WITHDRAWN or CLOSED. Pure helpers, no React.
 */

export type Request = Schema<"Request">;
export type RequestType = Schema<"RequestType">;
export type RequestTypeField = Schema<"RequestTypeField">;
export type RequestTypeRule = Schema<"RequestTypeRule">;
export type RequestMessage = Schema<"RequestMessage">;
export type RequestEligibilityResult = Schema<"RequestEligibilityResult">;
export type Space = Schema<"Space">;

/** Kinds handled on /requests (access, membership and connector asks are decided on their own surfaces). */
export const REQUEST_KINDS = ["SERVICE", "QUESTION"] as const;
export const isHandledKind = (r: Request) => r.kind === "SERVICE" || r.kind === "QUESTION";

/** Preview status keys (`STATUS.svc`). */
export type RequestStatus = "submitted" | "in_review" | "needs_info" | "approved" | "declined" | "completed" | "withdrawn";

/** `[tone, label, variant?]` — preview `STATUS.svc`, the requester's wording. */
export const REQUEST_STATUS: Record<RequestStatus, readonly [Tone, string, ChipVariant?]> = {
  submitted: ["default", "Đã gửi"],
  in_review: ["accent", "Chờ duyệt"],
  needs_info: ["warning", "Cần bạn phản hồi"],
  approved: ["success", "Đã phê duyệt"],
  declined: ["danger", "Đã từ chối"],
  completed: ["success", "Xong", "tertiary"],
  withdrawn: ["default", "Đã rút lại"],
};

/** Status of a request in preview terms: an OPEN request someone took is "In review". */
export function requestStatus(r: Request): RequestStatus {
  switch (r.state) {
    case "NEEDS_INFO":
      return "needs_info";
    case "APPROVED":
      return "approved";
    case "DENIED":
      return "declined";
    case "ANSWERED":
    case "CLOSED":
      return "completed";
    case "WITHDRAWN":
      return "withdrawn";
    default:
      return r.assignee ? "in_review" : "submitted";
  }
}

const OPEN: readonly RequestStatus[] = ["submitted", "in_review", "needs_info", "approved"];
/** Open states where the next step is the staff's (needs_info waits on the requester). */
const ACTIONABLE: readonly RequestStatus[] = ["submitted", "in_review", "approved"];

export const isOpen = (r: Request) => OPEN.includes(requestStatus(r));
export const isActionable = (r: Request) => ACTIONABLE.includes(requestStatus(r));
/** OPEN/NEEDS_INFO: the states that take messages, decisions and withdrawal. */
export const isActive = (r: Request) => r.state === "OPEN" || r.state === "NEEDS_INFO";
export const isQuestion = (r: Request) => r.kind === "QUESTION";

/* ═══════════════ ListRequests filters for the same groups ═══════════════ */

/** Open (the requester's In progress and Needs your reply, the queue's Open view). */
export const OPEN_FILTER = '(state = "OPEN" OR state = "NEEDS_INFO" OR state = "APPROVED")';
/** The next step is the staff's. */
export const ACTIONABLE_FILTER = '(state = "OPEN" OR state = "APPROVED")';
export const CLOSED_FILTER = '(state = "DENIED" OR state = "ANSWERED" OR state = "WITHDRAWN" OR state = "CLOSED")';
/** Each status as a filter (an OPEN request someone took is "In review"). */
export const STATUS_FILTER: Record<RequestStatus, string> = {
  submitted: 'state = "OPEN" AND NOT assignee:*',
  in_review: 'state = "OPEN" AND assignee:*',
  needs_info: 'state = "NEEDS_INFO"',
  approved: 'state = "APPROVED"',
  declined: 'state = "DENIED"',
  completed: '(state = "ANSWERED" OR state = "CLOSED")',
  withdrawn: 'state = "WITHDRAWN"',
};

const ms = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);
export const dueMs = (r: Request) => ms(r.dueTime);
export const updatedMs = (r: Request) => ms(r.updateTime) || ms(r.createTime) || 0;
export const createdMs = (r: Request) => ms(r.createTime) || 0;

export const isOverdue = (r: Request, now = Date.now()) => isActionable(r) && Number.isFinite(dueMs(r)) && dueMs(r) < now;

/** Soonest due first; requests waiting on the requester last (preview `byDue`). */
export function byDue(a: Request, b: Request): number {
  const wait = Number(a.state === "NEEDS_INFO") - Number(b.state === "NEEDS_INFO");
  if (wait) return wait;
  const da = dueMs(a), db = dueMs(b);
  return (Number.isFinite(da) ? da : Infinity) - (Number.isFinite(db) ? db : Infinity);
}
export const byUpdated = (a: Request, b: Request) => updatedMs(b) - updatedMs(a);

/** What the list shows as the request's name: the question, else the title or the type's name. */
export function requestTitle(r: Request, type?: RequestType | null): string {
  if (isQuestion(r)) return (r.question ?? "").trim() || r.title || "Câu hỏi";
  return r.title || type?.displayName || "Yêu cầu";
}

/** Short human reference for a request (the API ID is a UUID). */
export const shortId = (r: Request) => (r.name?.split("/").pop() ?? "").slice(0, 8).toUpperCase();

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** `12 phút`, `5 giờ`, `3 ngày` (preview `span`). */
export function span(d: number): string {
  if (d < HOUR - MIN / 2) return `${Math.max(1, Math.round(d / MIN))} phút`;
  if (Math.round(d / HOUR) < 24) return `${Math.round(d / HOUR)} giờ`;
  return `${Math.round(d / DAY)} ngày`;
}

/** `slaDuration` ("259200s") in whole days, at least 1; `null` without an SLA. */
export function slaDays(t: RequestType | null | undefined): number | null {
  const m = /^([0-9]+(?:\.[0-9]+)?)s$/.exec(t?.slaDuration ?? "");
  if (!m) return null;
  return Math.max(1, Math.round(Number(m[1]) / 86_400));
}

/** "Usually the next working day" / "Usually 3 working days" (preview `slaUsual`). */
export function slaUsual(t: RequestType | null | undefined): string | null {
  const d = slaDays(t);
  if (d === null) return null;
  return d <= 1 ? "Thường vào ngày làm việc tiếp theo" : `Thường ${d} ngày làm việc`;
}

export interface Sla {
  text: string;
  tone: "" | "danger" | "warning" | "muted";
  tip?: string;
}

/** SLA for staff: due in / overdue / paused while waiting for the requester (preview `sla`). */
export function slaOf(r: Request, now = Date.now()): Sla {
  if (!isOpen(r)) return { text: "Đã đóng " + relInline(r.closeTime ?? r.updateTime), tone: "muted" };
  if (r.state === "NEEDS_INFO") return { text: "Đã tạm dừng", tone: "muted", tip: "Thời gian tạm dừng khi chờ người yêu cầu" };
  const due = dueMs(r);
  if (!Number.isFinite(due)) return { text: "Không có thời hạn", tone: "muted" };
  const d = due - now;
  if (d < 0) return { text: "Quá hạn " + span(-d), tone: "danger" };
  return { text: "Đến hạn sau " + span(d), tone: d < DAY ? "warning" : "" };
}

/** "Tue, Nov 8" (preview `fmtDay`). */
export function fmtDay(value: string | undefined): string {
  const t = ms(value);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleDateString("vi-VN", { weekday: "short", month: "short", day: "numeric" });
}

/** "the teaching team" / "the office" / "the team", by space type (preview `teamWord`). */
export function teamWord(space: Pick<Space, "spaceType"> | null | undefined): string {
  return space?.spaceType === "course" ? "nhóm giảng dạy" : space?.spaceType === "office" ? "văn phòng" : "nhóm";
}

export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Shortens text at a word boundary (preview `clip`). */
export function clip(value: string | null | undefined, n: number): string {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), n - 12)).replace(/[\s,;:.–—-]+$/, "") + "…";
}

/** Staff roles of a space member (`roles/spaceLead`, `roles/spaceStaff`). */
export const STAFF_ROLES = ["roles/spaceLead", "roles/spaceStaff"];
export function roleLabel(roles: readonly string[] | undefined): string {
  if (roles?.includes("roles/spaceLead")) return "Trưởng nhóm";
  if (roles?.includes("roles/spaceStaff")) return "Nhân viên";
  return "";
}

/* ═══════════════ Rule check (eligibility) ═══════════════ */

export type CheckState = "pass" | "warn" | "fail" | "info" | "wait";

export interface CheckLine {
  key: string;
  state: CheckState;
  label: string;
  detail?: string;
  consequence?: string;
  /** Item name of the policy document (only when the reader can open it). */
  cite?: string;
  /** A failing rule the requester can fix in the form (its condition reads `fields`); others hide the form. */
  fixable?: boolean;
}

/**
 * The check card rows: every rule of the type, marked from the server's eligibility
 * (`results` are the triggered rules; BLOCK → fail, WARN → warn, untriggered → pass).
 * `eligibility` null means the server could not evaluate yet (`wait`).
 */
export function checkLines(rules: readonly RequestTypeRule[], eligibility: Request["eligibility"] | null, team: string): CheckLine[] {
  const triggered = new Map((eligibility?.results ?? []).map((r) => [r.condition ?? "", r]));
  return rules.map((rule, i) => {
    const label = rule.message || rule.condition;
    const key = `${i}:${rule.condition}`;
    if (!eligibility) return { key, state: "wait", label, detail: "Điền thông tin để kiểm tra quy tắc này.", cite: rule.policyCitation };
    const hit = triggered.get(rule.condition);
    if (!hit) return { key, state: "pass", label, cite: rule.policyCitation };
    if (hit.severity === "BLOCK") {
      const fixable = /\bfields\./.test(rule.condition);
      const consequence = fixable
        ? `${capital(team)} không thể chấp nhận yêu cầu như hiện tại. Hãy sửa thông tin, hoặc hỏi họ xem có ngoại lệ nào áp dụng cho bạn không.`
        : `${capital(team)} không chấp nhận được yêu cầu này. Hãy hỏi họ xem có ngoại lệ nào áp dụng cho bạn không.`;
      return { key, state: "fail", label, detail: "Yêu cầu của bạn chưa đáp ứng quy tắc này.", consequence, cite: hit.policyCitation, fixable };
    }
    return { key, state: "warn", label, detail: "Bạn vẫn có thể gửi; văn phòng sẽ cân nhắc điều này.", cite: hit.policyCitation };
  });
}

/** Rows for a sent request: the triggered rules it was sent with (preview "Checked before sending"). */
export function sentCheckLines(r: Request): CheckLine[] {
  return (r.eligibility?.results ?? []).map((res, i) => ({
    key: `${i}:${res.condition}`,
    state: res.severity === "BLOCK" ? "fail" : "warn",
    label: res.message || res.condition || "Quy tắc",
    cite: res.policyCitation,
  }));
}

/* ═══════════════ Form ═══════════════ */

export type FieldValues = Record<string, string>;

/** Initial values: query params for matching keys (preview `formState`). */
export function initialValues(fields: readonly RequestTypeField[], query: URLSearchParams): FieldValues {
  const out: FieldValues = {};
  for (const f of fields) {
    let v = ["type", "space", "conv", "q"].includes(f.key) ? "" : (query.get(f.key) ?? "");
    if (f.type === "SELECT" && !(f.options ?? []).includes(v)) v = "";
    if (f.type === "BOOLEAN" && v !== "true") v = "false";
    out[f.key] = v;
  }
  return out;
}

/** Client validation (preview `validate`): required values and whole numbers. */
export function validateValues(fields: readonly RequestTypeField[], vals: FieldValues): Record<string, string> {
  const e: Record<string, string> = {};
  for (const f of fields) {
    const v = String(vals[f.key] ?? "").trim();
    if (f.required && (!v || (f.type === "BOOLEAN" && v !== "true")))
      e[f.key] = f.type === "SELECT" ? "Chọn một tùy chọn." : f.key === "reason" ? "Thêm lý do. Một câu là đủ." : "Trường này là bắt buộc.";
    else if (f.type === "NUMBER" && v && !Number.isFinite(Number(v))) e[f.key] = "Nhập một số.";
  }
  return e;
}

/** Typed `fields` Struct for the API: only non-empty values. */
export function toStruct(fields: readonly RequestTypeField[], vals: FieldValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = String(vals[f.key] ?? "").trim();
    if (!v) continue;
    if (f.type === "NUMBER") {
      const n = Number(v);
      if (Number.isFinite(n)) out[f.key] = n;
    } else if (f.type === "BOOLEAN") out[f.key] = v === "true";
    else out[f.key] = v;
  }
  return out;
}

/** A field value as the details card shows it. */
export function fieldText(f: RequestTypeField | undefined, v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Có" : "Không";
  if (f?.type === "DATE" && typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return new Date(t).toLocaleDateString("vi-VN", { year: "numeric", month: "short", day: "numeric" });
  }
  return String(v);
}
