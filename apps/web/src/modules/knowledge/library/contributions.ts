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

import { fmtDate, rel } from "@/lib/format";

import type { Contribution, Item } from "../api";
import { lifecycleKey, type LifecycleKey } from "../model";

/** My library → Contributions, optionally opening one contribution's panel (`?open=`). */
export function contributionHref(id?: string | null): string {
  const bare = id ? id.slice(id.lastIndexOf("/") + 1) : "";
  return `/knowledge/library?tab=contributions${bare ? `&open=${bare}` : ""}`;
}

/**
 * How a contribution reads for its contributor (preview `features/contribute.js` `X.ctb`):
 * one lifecycle key, the latest event in one line, and the history timeline.
 * Pure: names and items are passed in.
 */

export type ContributionGroup = "all" | "changes" | "review" | "published" | "rejected";

/** Contributions filter (preview `CTB_GROUPS`): [id, label, lifecycle keys | null = all]. */
export const CTB_GROUPS: ReadonlyArray<readonly [ContributionGroup, string, readonly LifecycleKey[] | null]> = [
  ["all", "All", null],
  ["changes", "Needs your action", ["changes"]],
  ["review", "In review", ["analyzing", "review"]],
  ["published", "Published", ["published", "publishing", "queued", "merged", "failed", "update", "stored"]],
  ["rejected", "Not approved", ["rejected"]],
];

export const PUBLISHED_KEYS = CTB_GROUPS[3][2]!;

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
  /** Knowledge base display name. */
  base: string;
  /** The approved document (published) or the revised one (merged), when readable. */
  published?: Item | null;
}

const VERB: Readonly<Record<EventKind, string>> = {
  submitted: "submitted it",
  resubmitted: "resubmitted it",
  changes: "asked for changes",
  rejected: "didn’t approve it",
  approved: "approved it",
  withdrawn: "withdrew it",
};

const relLow = (at?: string) => rel(at).replace(/^(Just now|Yesterday)$/, (m) => m.toLowerCase());

/** "You", the member's name, or "Someone" when the name isn't known. */
export function who(by: string, ctx: Pick<ContributionContext, "me" | "names">): string {
  if (by && by === ctx.me) return "You";
  return (by && ctx.names.get(by)) || "Someone";
}

/** The reviewer's last message of a kind (state block quotes). */
export function lastEvent(c: Contribution, kind: EventKind): ContributionEventView | undefined {
  return lastOf(eventsOf(c), kind);
}

/** One line for lists: the latest thing that happened, in plain language (preview `eventLine`). */
export function eventLine(c: Contribution, ctx: ContributionContext): string {
  const key = contributionLife(c, ctx.published);
  const events = eventsOf(c);
  const e = lastOf(events)!;
  const ok = lastOf(events, "approved");
  const by = ok && ok.by && ok.by !== ctx.me && ctx.names.get(ok.by) ? ` by ${ctx.names.get(ok.by)}` : "";
  switch (key) {
    case "published":
    case "update":
    case "stored": {
      const t = Math.max(Date.parse(ctx.published?.updateTime ?? "") || 0, Date.parse(e.at) || 0);
      return `Published · ${fmtDate(t || undefined)}`;
    }
    case "merged":
      return `Published as a new version · ${fmtDate(c.decision?.decideTime ?? e.at)}`;
    case "publishing":
      return `Approved${by} · publishing now`;
    case "queued":
      return `Approved${by} · waiting to publish`;
    case "failed":
      return `Approved${by} · couldn’t publish`;
    case "analyzing":
      return `${e.kind === "resubmitted" ? "Resubmitted" : "Submitted"} · ${relLow(e.at)} · the assistant is reading it`;
  }
  if (e.kind === "submitted" && (!e.by || e.by === ctx.me)) return `Submitted · ${relLow(e.at)}`;
  if (e.by === ctx.me) {
    const verb = VERB[e.kind].replace(/ it$/, "");
    return `${verb.charAt(0).toUpperCase()}${verb.slice(1)} · ${relLow(e.at)}`;
  }
  return `${who(e.by, ctx)} ${VERB[e.kind]} · ${relLow(e.at)}`;
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

/** What happens next (or happened last) beyond the stored events (preview `tail`). */
function tail(c: Contribution, ctx: ContributionContext & { mine: boolean; revisedName?: string }): TimelineStep | null {
  const key = contributionLife(c, ctx.published);
  const kb = ctx.base || "the knowledge base";
  switch (key) {
    case "analyzing":
      return { icon: Sparkles, tone: "accent", title: "The assistant is reading it", desc: "It suggests a type, topics and a knowledge base for the reviewer.", live: true };
    case "review":
      return { icon: Clock, tone: "", title: "Waiting for a reviewer", desc: `The reviewers of ${kb} check it before it’s published.`, next: true };
    case "changes":
      return { icon: Pencil, tone: "", title: ctx.mine ? "Waiting for your revision" : "Waiting for a revision", next: true };
    case "queued":
      return { icon: Clock, tone: "", title: "Waiting to publish", next: true };
    case "publishing":
      return { icon: LoaderCircle, tone: "accent", title: "Publishing", desc: "It will be searchable in a few minutes.", live: true };
    case "published":
    case "update":
      return { icon: CircleCheck, tone: "success", title: "Published", desc: `Searchable in ${kb}.`, at: ctx.published?.updateTime };
    case "stored":
      return { icon: CircleCheck, tone: "success", title: "Published", desc: "People can download it. This file type can’t be searched.", at: ctx.published?.updateTime };
    case "merged":
      return {
        icon: CircleCheck,
        tone: "success",
        title: "Published as a new version",
        desc: ctx.revisedName ? `It replaced the earlier version of “${ctx.revisedName}”.` : "",
        at: c.decision?.decideTime,
      };
    case "failed":
      return { icon: CircleAlert, tone: "danger", title: "Couldn’t publish", desc: "The reviewers have been told." };
    default:
      return null;
  }
}

/** Vertical history: who did what, when, and what reviewers wrote (preview `timeline`). */
export function timelineSteps(c: Contribution, ctx: ContributionContext & { mine: boolean; revisedName?: string }): TimelineStep[] {
  const steps: TimelineStep[] = eventsOf(c).map((e) => {
    const [icon, tone] = STEP[e.kind] ?? [CircleDashed, ""];
    return { icon, tone, title: `${who(e.by, ctx)} ${VERB[e.kind]}`, at: e.at, quote: e.text || undefined };
  });
  const t = tail(c, ctx);
  if (t) steps.push(t);
  return steps;
}

/** Contribution flags as the contributor reads them (preview `ai.flags`). */
export function flagText(kind: string | undefined, related?: string): string {
  switch (kind) {
    case "DUPLICATE":
      return related ? `Looks like “${related}”` : "Looks like a document that’s already published";
    case "NEW_REVISION":
      return related ? `New version of “${related}”` : "Looks like a new version of a published document";
    case "PERSONAL_DATA":
      return "May contain personal data. Check before publishing.";
    case "UNSEARCHABLE_FORMAT":
      return "This file type can’t be searched; people could only download it.";
    default:
      return "";
  }
}
