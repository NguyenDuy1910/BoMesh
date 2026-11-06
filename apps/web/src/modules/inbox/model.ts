import {
  AlertCircle,
  Bell,
  CheckCircle2,
  Clock,
  FileText,
  Megaphone,
  MessageSquare,
  Pencil,
  UserPlus,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import type { Tone } from "@/components/ui/StatusChip";
import { resourceId } from "@/lib/api/client";

import type { Contribution, Notification, Request } from "./api";

/**
 * How the inbox shows one notification (preview `inbox.js` rows): icon and tone by
 * kind and subject, where opening it goes, and the one inline action it offers.
 * The text itself (title, body) is the server's, written for the recipient.
 */
export type TargetType = "items" | "contributions" | "requests" | "sources" | "connections" | "spaces" | "";

export interface TargetRef {
  type: TargetType;
  /** Bare ID of the subject. */
  id: string;
}

/** `workspaces/w/requests/r` → `{ type: "requests", id: "r" }`. */
export function targetOf(n: Pick<Notification, "target">): TargetRef {
  const parts = (n.target ?? "").split("/");
  const type = (parts.length >= 4 ? parts[parts.length - 2] : "") as TargetType;
  return { type, id: resourceId(n.target) };
}

export type InlineAction =
  | { kind: "decide"; request: Request }
  | { kind: "reconnect"; href: string }
  | { kind: "cta"; label: string; href: string }
  | { kind: "open"; href: string };

export interface InboxView {
  icon: LucideIcon;
  tone: Tone | "";
  href: string;
  action: InlineAction;
}

const OPEN_REQUEST: Readonly<Record<string, true>> = { OPEN: true, NEEDS_INFO: true };

/** Where the notification's subject lives in the app. */
export function hrefOf(t: TargetRef, n: Pick<Notification, "kind">): string {
  switch (t.type) {
    case "items":
      return `/doc/${t.id}`;
    case "contributions":
      return n.kind === "contribution_submitted" ? "/documents?tab=review" : `/knowledge/library?tab=contributions&open=${t.id}`;
    case "requests":
      return `/requests/${t.id}`;
    case "sources":
      return `/sources?source=${t.id}`;
    case "connections":
      return `/sources?reconnect=${t.id}`;
    case "spaces":
      return `/space/${t.id}`;
    default:
      return "/inbox";
  }
}

export interface Subjects {
  /** Request subjects by bare ID (loaded only for request notifications). */
  requests: ReadonlyMap<string, Request>;
  contributions: ReadonlyMap<string, Contribution>;
  /** Caller's member resource name (requester checks). */
  me: string;
  /** Workspace admin: access requests are decided in People › Requests. */
  admin: boolean;
}

/** Display + action for one notification; subjects refine it once loaded (e.g. Approve only while the request is open). */
export function viewOf(n: Notification, subjects: Subjects): InboxView {
  const t = targetOf(n);
  const href = hrefOf(t, n);
  const open: InlineAction = { kind: "open", href };
  switch (n.kind) {
    case "access_request": {
      const r = subjects.requests.get(t.id);
      const pending = r && OPEN_REQUEST[r.state ?? ""];
      // Base access: admins decide in People › Requests, owners on the base's Access tab. Space membership: the request page.
      const base = r?.kind === "COLLECTION_ACCESS" ? r.collection : undefined;
      const decideHref = base ? (subjects.admin ? "/people?tab=requests" : `/knowledge/${resourceId(base)}?tab=access`) : href;
      return { icon: UserPlus, tone: "warning", href: decideHref, action: pending ? { kind: "decide", request: r } : { kind: "open", href: decideHref } };
    }
    case "contribution_submitted":
      return { icon: Clock, tone: "accent", href, action: { kind: "cta", label: "Review", href } };
    case "contribution_reviewed": {
      const state = subjects.contributions.get(t.id)?.state;
      if (state === "CHANGES_REQUESTED") return { icon: Pencil, tone: "warning", href, action: { kind: "cta", label: "Revise", href } };
      if (state === "REJECTED") return { icon: XCircle, tone: "", href, action: open };
      if (state === "APPROVED") return { icon: CheckCircle2, tone: "success", href, action: open };
      return { icon: FileText, tone: "accent", href, action: open };
    }
    case "request_updated": {
      const r = subjects.requests.get(t.id);
      const mine = r?.requester === subjects.me;
      if (r?.state === "NEEDS_INFO" && mine) return { icon: MessageSquare, tone: "warning", href, action: { kind: "cta", label: "Reply", href } };
      if (r?.state === "APPROVED") return { icon: CheckCircle2, tone: "success", href, action: open };
      if (r?.state === "ANSWERED") return { icon: MessageSquare, tone: "success", href, action: open };
      if (r?.state === "DENIED") return { icon: XCircle, tone: "danger", href, action: open };
      return { icon: MessageSquare, tone: "accent", href, action: open };
    }
  }
  if (t.type === "connections") return { icon: AlertCircle, tone: "danger", href, action: { kind: "reconnect", href } };
  if (t.type === "sources") return { icon: AlertCircle, tone: "danger", href, action: open };
  if (t.type === "spaces") return { icon: Megaphone, tone: "accent", href, action: open };
  if (t.type === "items") return { icon: FileText, tone: "accent", href, action: open };
  return { icon: Bell, tone: "", href, action: open };
}
