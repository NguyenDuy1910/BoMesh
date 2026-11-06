"use client";

import { Button } from "@heroui/react";
import { CircleAlert, CircleCheck, Clock, FileText, History, LoaderCircle, Plug, ShieldCheck, Upload, UserPlus, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { EmptyState, ItemIcon, List, ListItem, toast, type Tone } from "@/components/ui";
import { errorMessage, resourceId, type Schema } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { openContribute } from "@/modules/knowledge/components/Contribute";
import { appKeyOf } from "@/modules/knowledge/components/SourceIcon";
import { useKnowledgeModel, useMemberNames } from "@/modules/knowledge/queries";
import { APPS } from "@/components/ui";
import { createIngestionRun } from "@/modules/curation/api";
import { LinkButton } from "@/modules/curation/components/parts";
import { useCuratedItems, useInvalidateCuration, useReviewQueue } from "@/modules/curation/queries";
import { useQueryClient } from "@tanstack/react-query";

import { approveRequest, type WorkspaceOverview } from "../api";
import { overviewKeys, useAccessRequests, useConnections, useServiceRequests, useSources } from "../queries";

interface Attn {
  id: string;
  tone: Tone;
  icon: LucideIcon;
  title: string;
  desc: string;
  actions: ReactNode;
}

const DAY = 86_400_000;
const WAITING_AFTER = 30 * 60_000;

/** "A", "A and B", "A, B and 3 others". */
export const names = (list: readonly string[]) => (list.length <= 2 ? list.join(" and ") : `${list.slice(0, 2).join(", ")} and ${plural(list.length - 2, "other")}`);
const title = (name: string | undefined) => (name ?? "").replace(/\.[a-z0-9]{1,5}$/i, "");

/**
 * Needs attention (preview `attention()`): each item names the problem and carries its fix.
 * Counts come from the overview read model; names from the lists the caller may read.
 */
export function Attention({ overview }: { overview: WorkspaceOverview }) {
  const { id: ws, can, hasModule } = useWorkspace();
  const qc = useQueryClient();
  const invalidate = useInvalidateCuration();
  const { ctx } = useKnowledgeModel();
  const kinds = new Map((overview.attentionItems ?? []).map((a) => [a.kind ?? "", a.itemCount ?? 0]));
  const queue = useReviewQueue({ enabled: can("contributions.review") && (kinds.get("CONTRIBUTIONS_WAITING") ?? 0) > 0 });
  const items = useCuratedItems();
  const sources = useSources();
  const connections = useConnections();
  const access = useAccessRequests();
  const service = useServiceRequests();
  const people = useMemberNames([...(access.data ?? []).map((r) => r.requester), ...(service.data ?? []).map((r) => r.requester)]);
  const baseNames = ctx.collectionNames ?? new Map<string, string>();
  const out: Attn[] = [];
  const now = Date.now();

  /* Office queues (Requests module) */
  if (hasModule("requests") && service.data) {
    const open = service.data.filter((r) => r.state === "OPEN" && r.dueTime);
    const late = open.filter((r) => Date.parse(r.dueTime!) < now);
    const soon = open.filter((r) => Date.parse(r.dueTime!) >= now && Date.parse(r.dueTime!) - now <= DAY);
    if (late.length || soon.length) {
      const list = [...late, ...soon];
      const extra = late.length && soon.length ? ` · ${soon.length} more due within a day` : "";
      out.push({
        id: "sla",
        tone: late.length ? "danger" : "warning",
        icon: Clock,
        title: late.length ? `${plural(late.length, "office request")} past the response time` : `${plural(soon.length, "office request")} due within a day`,
        desc: list.slice(0, 2).map((r) => `${r.title ?? "Request"} · ${people.get(r.requester ?? "") ?? ""}`).join(", ") + extra,
        actions: <LinkButton href="/requests?tab=queue" variant="secondary">Open queue</LinkButton>,
      });
    }
  }

  /* Sources and connections */
  const connByName = new Map((connections.data ?? []).map((c) => [c.name ?? "", c]));
  for (const s of sources.data ?? []) {
    const conn = connByName.get(s.connection ?? "");
    const app = APPS[appKeyOf(conn?.connector) as keyof typeof APPS]?.name ?? "The app";
    const kb = baseNames.get(s.targetCollection ?? "");
    if (s.state === "REAUTHORIZATION_REQUIRED" || conn?.state === "REAUTHORIZATION_REQUIRED") {
      out.push({
        id: `src-${s.name}`,
        tone: "danger",
        icon: Plug,
        title: `${s.displayName} stopped syncing`,
        desc: `${app} access expired${kb ? ` · ${kb} isn’t getting updates` : ""}`,
        actions: <LinkButton href={`/connections?open=${resourceId(s.connection)}`} variant="secondary">Reconnect</LinkButton>,
      });
    } else if (s.state === "FAILED" || s.lastSync?.state === "FAILED") {
      out.push({
        id: `src-${s.name}`,
        tone: "danger",
        icon: CircleAlert,
        title: `${s.displayName} couldn’t sync`,
        desc: "The last sync failed.",
        actions: <LinkButton href={`/sources?open=${resourceId(s.name)}`} variant="secondary">Open</LinkButton>,
      });
    }
  }
  // Without source access, the read model still says how many need attention.
  if (!sources.data && (kinds.get("SOURCE_FAILING") || kinds.get("CONNECTION_EXPIRED"))) {
    const n = (kinds.get("SOURCE_FAILING") ?? 0) + (kinds.get("CONNECTION_EXPIRED") ?? 0);
    out.push({ id: "src", tone: "danger", icon: Plug, title: `${plural(n, "source")} stopped syncing`, desc: "A source administrator can reconnect them.", actions: null });
  }

  /* Access requests */
  const reqs = access.data ?? [];
  if (reqs.length === 1) {
    const r = reqs[0];
    const approve = async () => {
      try {
        await approveRequest(ws, r.name ?? "", r.etag);
        void qc.invalidateQueries({ queryKey: overviewKeys.access(ws) });
        void qc.invalidateQueries({ queryKey: [ws, "shell-badge"] });
        toast(`${people.get(r.requester ?? "") || "They"} can now ${r.requestedRole?.includes("Editor") ? "edit" : "view"} ${baseNames.get(r.collection ?? "") ?? "it"}`);
      } catch (error) {
        toast(errorMessage(error), { tone: "danger" });
      }
    };
    out.push({
      id: "req",
      tone: "warning",
      icon: UserPlus,
      title: `${people.get(r.requester ?? "") || "Someone"} wants ${r.requestedRole?.toLowerCase().includes("editor") ? "edit" : "view"} access`,
      desc: baseNames.get(r.collection ?? "") ?? "",
      actions: (
        <>
          <LinkButton href="/people?tab=requests">Review</LinkButton>
          <Button variant="secondary" size="sm" onPress={() => void approve()}>
            Approve
          </Button>
        </>
      ),
    });
  } else if (reqs.length) {
    const who = new Set(reqs.map((r) => r.requester)).size;
    const kbs = [...new Set(reqs.map((r) => baseNames.get(r.collection ?? "")).filter(Boolean))] as string[];
    out.push({ id: "req", tone: "warning", icon: UserPlus, title: `${plural(who, "person", "people")} waiting for access`, desc: `To ${names(kbs)}`, actions: <LinkButton href="/people?tab=requests" variant="secondary">Review</LinkButton> });
  } else if (!access.data && kinds.get("ACCESS_REQUESTS")) {
    const n = kinds.get("ACCESS_REQUESTS")!;
    out.push({ id: "req", tone: "warning", icon: UserPlus, title: `${plural(n, "access request")} waiting`, desc: "", actions: <LinkButton href="/people?tab=requests" variant="secondary">Review</LinkButton> });
  }

  /* Documents */
  const waitingReview = kinds.get("CONTRIBUTIONS_WAITING") ?? 0;
  if (waitingReview) {
    const titles = (queue.data ?? []).map((s) => title(s.item?.displayName || s.item?.document?.fileName)).filter(Boolean);
    out.push({
      id: "cur-review",
      tone: "accent",
      icon: Clock,
      title: `${plural(waitingReview, "document")} waiting for review`,
      desc: names(titles),
      actions: <LinkButton href="/documents?tab=review" variant="secondary">Review</LinkButton>,
    });
  }
  const docs = items.data ?? [];
  const failedCount = kinds.get("PUBLISH_FAILED") ?? 0;
  if (failedCount) {
    const failed = docs.filter((d) => d.document?.indexingState === "FAILED" || d.document?.contentState === "FAILED");
    out.push({
      id: "docs-failed",
      tone: "warning",
      icon: FileText,
      title: `${plural(failedCount, "document")} couldn’t be published`,
      desc: names(failed.map((d) => title(d.displayName))),
      actions: <LinkButton href="/documents?tab=all&life=attention" variant="secondary">Review</LinkButton>,
    });
  }
  const outdated = new Map<string, Schema<"Item">[]>();
  for (const d of docs) {
    if (d.document?.indexingState !== "OUTDATED") continue;
    const base = d.ancestors?.[0]?.name ?? d.parentItem ?? "";
    outdated.set(base, [...(outdated.get(base) ?? []), d]);
  }
  for (const [base, list] of outdated) {
    const kb = baseNames.get(base) ?? list[0].ancestors?.[0]?.displayName ?? "";
    if (list.length === 1) {
      const d = list[0];
      out.push({
        id: `old-${d.name}`,
        tone: "warning",
        icon: History,
        title: `${title(d.displayName)} needs an update`,
        desc: `${kb} · answers that cite it may be out of date`,
        actions: (
          <>
            <LinkButton href={`/doc/${resourceId(d.name)}`}>View</LinkButton>
            <Button variant="secondary" size="sm" onPress={() => openContribute({ item: d.name })}>
              <Upload className="i" aria-hidden />
              Update
            </Button>
          </>
        ),
      });
    } else {
      out.push({
        id: `old-${base}`,
        tone: "warning",
        icon: History,
        title: `${plural(list.length, "document")} in ${kb} need an update`,
        desc: names(list.map((d) => title(d.displayName))),
        actions: <LinkButton href={`/documents?tab=all&life=attention&kb=${resourceId(base)}`} variant="secondary">Review</LinkButton>,
      });
    }
  }
  // Published but not picked up for over 30 minutes.
  const waiting = docs.filter(
    (d) =>
      d.document?.publicationState === "PUBLISHED" &&
      d.document?.indexingState === "PENDING" &&
      d.document?.contentState === "AVAILABLE" &&
      now - Date.parse(d.updateTime ?? "") > WAITING_AFTER,
  );
  if (waiting.length) {
    const publish = async () => {
      try {
        await createIngestionRun(ws, waiting.map((d) => d.name ?? ""));
        invalidate();
        toast(`Publishing ${plural(waiting.length, "document")}`, { tone: "accent" });
      } catch (error) {
        toast(errorMessage(error), { tone: "danger" });
      }
    };
    out.push({
      id: "waiting",
      tone: "default",
      icon: LoaderCircle,
      title: `${plural(waiting.length, "document")} waiting to publish`,
      desc: names(waiting.map((d) => title(d.displayName))),
      actions: (
        <Button variant="secondary" size="sm" onPress={() => void publish()}>
          Publish now
        </Button>
      ),
    });
  }
  const due = kinds.get("REVERIFICATION_DUE") ?? 0;
  if (due) {
    const list = docs.filter((d) => d.document?.verification?.state === "REVIEW_DUE");
    out.push({
      id: "kh-review",
      tone: "warning",
      icon: ShieldCheck,
      title: `${plural(due, "resource")} ${due === 1 ? "is" : "are"} due for review`,
      desc: names(list.map((d) => title(d.displayName))),
      actions: <LinkButton href="/documents?tab=quality&seg=reverify" variant="secondary">Review</LinkButton>,
    });
  }

  if (!out.length) {
    return (
      <EmptyState
        icon={CircleCheck}
        tone="success"
        boxed
        compact
        title="Everything is running"
        description={hasModule("requests") ? "Queues are on time, sources are syncing and no one is waiting on you." : "Sources are syncing and no one is waiting on you."}
      />
    );
  }
  return (
    <List className="ov-attn">
      {out.map((it) => (
        <ListItem
          key={it.id}
          lead={<ItemIcon icon={it.icon} tone={it.tone} />}
          title={it.title}
          description={
            it.desc ? <span className="truncate ov-line">{it.desc}</span> : undefined
          }
          actions={it.actions}
        />
      ))}
    </List>
  );
}
