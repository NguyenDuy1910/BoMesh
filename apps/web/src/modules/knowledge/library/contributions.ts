import {
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Sparkles,
  Undo2,
  Upload,
  type LucideIcon,
} from "lucide-react";

import { fmtDate, rel, relInline } from "@/lib/format";

import type { Contribution, Item } from "../api";
import { lifecycleKey, type LifecycleKey } from "../model";

/** My contributions (`/contributions`), optionally opening one contribution's panel (`?open=`). */
export function contributionHref(id?: string | null): string {
  const bare = id ? id.slice(id.lastIndexOf("/") + 1) : "";
  return `/contributions${bare ? `?open=${bare}` : ""}`;
}

/**
 * How a contribution reads for its contributor (preview `features/contribute.js` `X.ctb`):
 * one lifecycle key, the latest event in one line, the progress stepper and the history timeline.
 * Pure: names and items are passed in.
 */

export type ContributionGroup = "all" | "changes" | "review" | "published" | "rejected";

/** My contributions filter (preview `CTB_GROUPS`): [id, lifecycle keys | null = all]; named by `m.knowledge.contributionGroups[id]`. */
export const CTB_GROUPS: ReadonlyArray<readonly [ContributionGroup, readonly LifecycleKey[] | null]> = [
  ["all", null],
  ["changes", ["changes"]],
  ["review", ["analyzing", "review"]],
  ["published", ["published", "publishing", "queued", "merged", "failed", "update", "stored"]],
  ["rejected", ["rejected"]],
];

export const PUBLISHED_KEYS = CTB_GROUPS[3][1]!;

/**
 * Each group as a ListContributions filter on the contribution's state: the lifecycle keys of a group follow from it
 * (an approved contribution is Published whatever its document's processing state; withdrawn ones aren't listed).
 */
export const CTB_GROUP_FILTER: Readonly<Record<ContributionGroup, string>> = {
  all: "state != WITHDRAWN",
  changes: "state = CHANGES_REQUESTED",
  review: "(state = ANALYZING OR state = IN_REVIEW)",
  published: "state = APPROVED",
  rejected: "state = REJECTED",
};

/** Lifecycle of a contribution; an approved one reads its published document's states. */
export function contributionLife(c: Contribution, published?: Item | null): LifecycleKey {
  return lifecycleKey({ item: c.state === "APPROVED" ? (published ?? null) : null, contribution: c });
}

export type EventKind = "submitted" | "resubmitted" | "changes" | "rejected" | "approved" | "withdrawn";

export interface ContributionEventView {
  kind: EventKind;
  /** Member name; empty for system events. */
  by: string;
  at: string;
  text: string;
}

const EVENT_KIND: Readonly<Record<string, EventKind>> = {
  SUBMITTED: "submitted",
  RESUBMITTED: "resubmitted",
  CHANGES_REQUESTED: "changes",
  REJECTED: "rejected",
  APPROVED: "approved",
  WITHDRAWN: "withdrawn",
};

/** The people-facing events (the system's ANALYZED step is shown as the live tail instead). */
export function eventsOf(c: Contribution): ContributionEventView[] {
  const out: ContributionEventView[] = [];
  for (const e of c.events ?? []) {
    const kind = EVENT_KIND[e.kind ?? ""];
    if (kind) out.push({ kind, by: e.actor ?? "", at: e.createTime ?? "", text: e.message ?? "" });
  }
  if (out.length) return out;
  // BASIC view: rebuild what the resource itself says.
  out.push({ kind: "submitted", by: c.contributor ?? "", at: c.createTime ?? "", text: c.note ?? "" });
  const d = c.decision;
  const decided: Partial<Record<string, EventKind>> = { CHANGES_REQUESTED: "changes", REJECTED: "rejected", APPROVED: "approved" };
  const kind = decided[c.state ?? ""];
  if (kind && d) out.push({ kind, by: d.reviewer ?? "", at: d.decideTime ?? c.updateTime ?? "", text: d.message ?? "" });
  return out;
}

const lastOf = (events: ContributionEventView[], kind?: EventKind) => (kind ? [...events].reverse().find((e) => e.kind === kind) : events.at(-1));

export interface ContributionContext {
  /** The caller's member name. */
  me: string;
  /** Member name → display name. */
  names: ReadonlyMap<string, string>;
  /** Collection display name. */
  base: string;
  /** Who will see it once published (`Contribution.audienceSummary`). */
  audience?: string;
  /** The approved document (published) or the revised one (merged), when readable. */
  published?: Item | null;
}

const VERB: Readonly<Record<EventKind, string>> = {
  submitted: "đã gửi",
  resubmitted: "đã gửi lại",
  changes: "đã yêu cầu chỉnh sửa",
  rejected: "đã từ chối",
  approved: "đã duyệt",
  withdrawn: "đã rút lại",
};


/** "Bạn", the member's name, or "Ai đó" when the name isn't known. */
export function who(by: string, ctx: Pick<ContributionContext, "me" | "names">): string {
  if (by && by === ctx.me) return "Bạn";
  return (by && ctx.names.get(by)) || "Ai đó";
}

/** The reviewer's last message of a kind (state block quotes). */
export function lastEvent(c: Contribution, kind: EventKind): ContributionEventView | undefined {
  return lastOf(eventsOf(c), kind);
}

/** When anything last happened to it (History summary). */
export function lastEventAt(c: Contribution): string {
  return lastOf(eventsOf(c))?.at || c.updateTime || c.createTime || "";
}

/** One line for lists: the latest thing that happened, in plain language (preview `eventLine`). */
export function eventLine(c: Contribution, ctx: ContributionContext): string {
  const key = contributionLife(c, ctx.published);
  const events = eventsOf(c);
  const e = lastOf(events)!;
  const ok = lastOf(events, "approved");
  const by = ok && ok.by && ok.by !== ctx.me && ctx.names.get(ok.by) ? `do ${ctx.names.get(ok.by)}` : "";
  switch (key) {
    case "published":
    case "update":
    case "stored": {
      const t = Math.max(Date.parse(ctx.published?.updateTime ?? "") || 0, Date.parse(e.at) || 0);
      return `Đã công bố · ${fmtDate(t || undefined)}`;
    }
    case "merged":
      return `Đã công bố thành phiên bản mới · ${fmtDate(c.decision?.decideTime ?? e.at)}`;
    case "publishing":
      return `Đã phê duyệt${by ? ` ${by}` : ""} · đang xử lý`;
    case "queued":
      return `Đã phê duyệt${by ? ` ${by}` : ""} · chưa xử lý`;
    case "failed":
      return `Đã phê duyệt${by ? ` ${by}` : ""} · xử lý không thành công`;
    case "analyzing":
      return `${e.kind === "resubmitted" ? "Đã gửi lại" : "Đã gửi"} · ${relInline(e.at)} · trợ lý đang đọc tệp`;
  }
  if (e.kind === "submitted" && (!e.by || e.by === ctx.me)) return `Đã gửi · ${relInline(e.at)}`;
  if (e.by === ctx.me) {
    const verb = VERB[e.kind];
    return `${verb.charAt(0).toUpperCase()}${verb.slice(1)} · ${relInline(e.at)}`;
  }
  return `${who(e.by, ctx)} ${VERB[e.kind]} · ${relInline(e.at)}`;
}

export type StepTone = "" | "success" | "warning" | "danger" | "accent";

export interface TimelineStep {
  icon: LucideIcon;
  tone: StepTone;
  title: string;
  desc?: string;
  at?: string;
  quote?: string;
  /** What happens next (hollow dot, muted title). */
  next?: boolean;
  /** In progress (spinner). */
  live?: boolean;
}

const STEP: Readonly<Record<EventKind, readonly [LucideIcon, StepTone]>> = {
  submitted: [Upload, ""],
  resubmitted: [RefreshCw, ""],
  changes: [Pencil, "warning"],
  rejected: [CircleX, "danger"],
  approved: [Check, "success"],
  withdrawn: [Undo2, ""],
};

export type TimelineContext = ContributionContext & {
  mine: boolean;
  revisedName?: string;
  /** The contributor confirmed type, topics and collection before submitting (written on the candidate item). */
  confirmed?: boolean;
};

/** What happens next (or happened last) beyond the stored events (preview `tail`). */
function tail(c: Contribution, ctx: TimelineContext): TimelineStep | null {
  const key = contributionLife(c, ctx.published);
  const kb = ctx.base || "kho tài liệu";
  switch (key) {
    case "analyzing":
      return { icon: Sparkles, tone: "accent", title: "Trợ lý đang đọc tệp", desc: "Trợ lý đề xuất loại, chủ đề và kho tài liệu cho người duyệt.", live: true };
    case "review":
      return { icon: Clock, tone: "", title: "Đang chờ người duyệt", desc: `Người duyệt của ${kb} sẽ kiểm tra trước khi công bố.`, next: true };
    case "changes":
      return { icon: Pencil, tone: "", title: ctx.mine ? "Đang chờ bạn sửa đổi" : "Đang chờ bản sửa đổi", next: true };
    case "queued":
      return { icon: Clock, tone: "", title: "Đang chờ xử lý", desc: "Người duyệt quyết định khi nào xử lý. Trước đó, tìm kiếm và trợ lý chưa dùng được tài liệu này.", next: true };
    case "publishing":
      return { icon: LoaderCircle, tone: "accent", title: "Đang xử lý", desc: "Tệp sẽ tra cứu được sau vài phút.", live: true };
    case "published":
    case "update":
      return { icon: CircleCheck, tone: "success", title: "Đã công bố", desc: `Tra cứu được trong ${kb}.`, at: ctx.published?.updateTime };
    case "stored":
      return { icon: CircleCheck, tone: "success", title: "Đã công bố", desc: "Mọi người có thể tải xuống. Loại tệp này không tra cứu được.", at: ctx.published?.updateTime };
    case "merged":
      return {
        icon: CircleCheck,
        tone: "success",
        title: "Đã công bố thành phiên bản mới",
        desc: ctx.revisedName ? `Tệp đã thay thế phiên bản trước của “${ctx.revisedName}”.` : "",
        at: c.decision?.decideTime,
      };
    case "failed":
      return { icon: CircleAlert, tone: "danger", title: "Không xử lý được", desc: "Đã thông báo cho người duyệt." };
    default:
      return null;
  }
}

/**
 * Vertical history: who did what, when, and what reviewers wrote (preview `timeline`).
 * `quoted`: the event whose message is already shown above (the state alert), so it isn't repeated.
 */
export function timelineSteps(c: Contribution, ctx: TimelineContext, quoted?: ContributionEventView): TimelineStep[] {
  const steps: TimelineStep[] = eventsOf(c).map((e) => {
    const [icon, tone] = STEP[e.kind] ?? [CircleDashed, ""];
    const same = !!quoted && quoted.kind === e.kind && quoted.at === e.at && quoted.by === e.by;
    return { icon, tone, title: `${who(e.by, ctx)} ${VERB[e.kind]}`, at: e.at, quote: same ? undefined : e.text || undefined };
  });
  const t = tail(c, ctx);
  if (t) steps.push(t);
  return steps;
}

/* ── Progress: Submitted → Analyzed → In review → Approved → Published (preview `progressSteps`) ── */

export type ProgressState = "done" | "current" | "issue" | "skipped" | "todo";

export interface ProgressStep {
  label: string;
  state: ProgressState;
  /** Working right now (spinner dot). */
  busy?: boolean;
  text: string;
  at?: string;
}

/** The Studio's document stepper told from the contributor's side. */
export function progressSteps(c: Contribution, ctx: TimelineContext): ProgressStep[] {
  const k = contributionLife(c, ctx.published);
  const base = ctx.base || "kho tài liệu";
  const events = eventsOf(c);
  const byOf = (e?: ContributionEventView) => (e?.by && e.by !== ctx.me && ctx.names.get(e.by) ? `do ${ctx.names.get(e.by)}` : "");
  const sent = [...events].reverse().find((e) => e.kind === "submitted" || e.kind === "resubmitted");
  const changes = lastOf(events, "changes");
  const rejected = lastOf(events, "rejected");
  const ok = lastOf(events, "approved");
  const audience = ctx.audience ?? "";
  const open = k === "analyzing" || k === "review" || k === "changes";

  const submitted: Omit<ProgressStep, "label"> = {
    state: "done",
    at: sent?.at || c.createTime,
    text: `${sent?.kind === "resubmitted" ? "Đã gửi lại" : "Đã gửi"} đến ${base}`,
  };
  const analyzed: Omit<ProgressStep, "label"> =
    k === "analyzing"
      ? { state: "current", busy: true, text: "Đang đọc tệp và đối chiếu với các chủ đề…" }
      : {
          state: "done",
          text: ctx.confirmed
            ? `Loại, chủ đề và kho tài liệu đã được ${ctx.mine ? "bạn" : who(c.contributor ?? "", ctx)} xác nhận`
            : "Đã đề xuất loại, chủ đề và kho tài liệu",
        };
  const review: Omit<ProgressStep, "label"> =
    k === "analyzing"
      ? { state: "todo", text: `Người duyệt của ${base} sẽ kiểm tra` }
      : k === "review"
        ? { state: "current", text: `Đang chờ người duyệt ${base}` }
        : k === "changes"
          ? { state: "issue", text: `Cần chỉnh sửa${byOf(changes) ? ` ${byOf(changes)}` : ""}`, at: changes?.at }
          : k === "rejected"
            ? { state: "issue", text: `Đã từ chối${byOf(rejected) ? ` ${byOf(rejected)}` : ""}`, at: rejected?.at }
            : { state: "done", text: `Người duyệt của ${base} đã kiểm tra` };
  const approved: Omit<ProgressStep, "label"> = open
    ? { state: "todo", text: "Người duyệt sẽ duyệt hoặc yêu cầu chỉnh sửa" }
    : k === "rejected"
      ? { state: "skipped", text: "Sẽ không được công bố" }
      : { state: "done", text: `Đã phê duyệt${byOf(ok) ? ` ${byOf(ok)}` : ""}`, at: ok?.at };
  const searchable = audience ? `Tra cứu được · ${audience}` : "Tra cứu được";
  const PUB: Partial<Record<LifecycleKey, Omit<ProgressStep, "label">>> = {
    queued: { state: "current", text: "Đã công bố · đang chờ xử lý" },
    publishing: { state: "current", busy: true, text: "Đang xử lý để tìm kiếm thấy được…" },
    published: { state: "done", text: searchable, at: ctx.published?.updateTime },
    update: { state: "done", text: searchable, at: ctx.published?.updateTime },
    stored: { state: "done", text: "Đã tải lên · mọi người có thể tải xuống; loại tệp này không tra cứu được" },
    merged: { state: "done", text: "Đã công bố thành phiên bản mới", at: c.decision?.decideTime },
    failed: { state: "issue", text: "Không xử lý được · đã báo cho người duyệt" },
    unpublished: { state: "issue", text: "Đã ngừng công bố" },
    rejected: { state: "skipped", text: "Sẽ không được công bố" },
  };
  const published = PUB[k] ?? { state: "todo", text: audience ? `${audience} sẽ thấy tài liệu khi được công bố` : "Tra cứu được sau khi công bố" };
  return (
    [
      ["Đã gửi", submitted],
      ["Đã xử lý", analyzed],
      ["Chờ duyệt", review],
      ["Đã duyệt", approved],
      ["Đã công bố", published],
    ] as const
  ).map(([label, s]) => ({ label, ...s }));
}

/** Contribution flags as the contributor reads them (preview `ai.flags`). */
export function flagText(kind: string | undefined, related?: string): string {
  switch (kind) {
    case "DUPLICATE":
      return related ? `Có vẻ giống “${related}”` : "Có vẻ giống một tài liệu đã công bố";
    case "NEW_REVISION":
      return related ? `Phiên bản mới của “${related}”` : "Có vẻ là phiên bản mới của một tài liệu đã công bố";
    case "PERSONAL_DATA":
      return "Có thể chứa dữ liệu cá nhân. Hãy kiểm tra trước khi công bố.";
    case "UNSEARCHABLE_FORMAT":
      return "Loại tệp này không tra cứu được; mọi người chỉ có thể tải xuống.";
    default:
      return "";
  }
}
