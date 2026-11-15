"use client";

import { CircleAlert, CircleCheck, Clock, Plug, UserPlus, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { APPS, EmptyState, ItemIcon, List, ListItem, type Tone } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { LinkButton } from "@/modules/curation/components/parts";
import { appKeyOf } from "@/modules/knowledge/components/SourceIcon";
import { useKnowledgeBases } from "@/modules/knowledge/queries";
import { useMembersQuery } from "@/modules/people/queries";

import type { Source, WorkspaceOverview } from "../api";
import { useAccessRequests, useConnections, useServiceRequests, useSources } from "../queries";

export interface Attn {
  id: string;
  tone: Tone;
  icon: LucideIcon;
  title: string;
  desc: string;
  actions: ReactNode;
}

const DAY = 86_400_000;
const RANK: Partial<Record<Tone, number>> = { danger: 0, warning: 1, accent: 2 };
const ACCESS_LABEL: Readonly<Record<string, string>> = { "roles/collectionEditor": "Editor", "roles/collectionOwner": "Owner" };

/** "A", "A and B", "A, B and 3 others". */
export const names = (list: readonly string[]) => (list.length <= 2 ? list.join(" and ") : `${list.slice(0, 2).join(", ")} and ${plural(list.length - 2, "other")}`);

/**
 * Needs attention (preview `attention()`): each item names a problem once and links to the one place its fix
 * lives. Knowledge work (submissions, issues, quality checks) is counted in Knowledge health instead.
 * `extra` is the next unfinished setup step. `items` is undefined while the lists load.
 */
export function useAttention(overview: WorkspaceOverview | undefined, extra: Attn | null): Attn[] | undefined {
  const { hasModule } = useWorkspace();
  const sources = useSources();
  const connections = useConnections();
  const access = useAccessRequests();
  const service = useServiceRequests();
  const members = useMembersQuery();
  const bases = useKnowledgeBases({ showLocked: true });
  const waiting = [sources, connections, access, service].some((q) => q.isPending && q.fetchStatus !== "idle");
  if (!overview || waiting) return undefined;

  const person = new Map((members.data ?? []).map((m) => [resourceId(m.name), m.displayName || m.email || ""]));
  const who = (member: string | undefined) => person.get(resourceId(member)) || "Someone";
  const baseName = new Map((bases.data ?? []).map((b) => [b.name ?? "", b.displayName ?? ""]));
  const kinds = new Map((overview.attentionItems ?? []).map((a) => [a.kind ?? "", a.itemCount ?? 0]));
  const out: Attn[] = [];
  const now = Date.now();

  /* Office queues past or near their response time (Requests module). */
  if (hasModule("requests") && service.data) {
    const open = service.data.filter((r) => r.state === "OPEN" && r.dueTime);
    const late = open.filter((r) => Date.parse(r.dueTime!) < now);
    const soon = open.filter((r) => Date.parse(r.dueTime!) >= now && Date.parse(r.dueTime!) - now <= DAY);
    if (late.length || soon.length) {
      const extraSoon = late.length && soon.length ? ` · ${soon.length} more due within a day` : "";
      out.push({
        id: "sla",
        tone: late.length ? "danger" : "warning",
        icon: Clock,
        title: late.length ? `${plural(late.length, "office request")} past the response time` : `${plural(soon.length, "office request")} due within a day`,
        desc:
          [...late, ...soon]
            .slice(0, 2)
            .map((r) => `${r.title ?? "Request"} · ${who(r.requester)}`)
            .join(", ") + extraSoon,
        actions: (
          <LinkButton href="/requests?tab=queue" variant="secondary">
            Open queue
          </LinkButton>
        ),
      });
    }
  }

  /* Sources: an expired account is one problem however many sources it stops; Reconnect fixes it. */
  if (sources.data) {
    const connByName = new Map((connections.data ?? []).map((c) => [c.name ?? "", c]));
    const expired = new Map<string, { app: string; list: Source[] }>();
    for (const s of sources.data) {
      const conn = connByName.get(s.connection);
      if (s.state === "REAUTHORIZATION_REQUIRED" || conn?.state === "REAUTHORIZATION_REQUIRED") {
        const app = APPS[appKeyOf(conn?.connector) as keyof typeof APPS]?.name ?? "The app";
        const entry = expired.get(s.connection) ?? { app, list: [] };
        entry.list.push(s);
        expired.set(s.connection, entry);
      } else if (s.state === "FAILED" || s.lastSync?.state === "FAILED") {
        out.push({
          id: `src-${s.name}`,
          tone: "danger",
          icon: CircleAlert,
          title: `${s.displayName ?? "A source"} couldn’t sync`,
          desc: "The last sync failed.",
          actions: (
            <LinkButton href={`/studio?tab=sources&open=${resourceId(s.name)}`} variant="secondary">
              Open source
            </LinkButton>
          ),
        });
      }
    }
    for (const [connection, { app, list }] of expired) {
      const kbs = [...new Set(list.map((s) => baseName.get(s.targetCollection)).filter((n): n is string => Boolean(n)))];
      out.push({
        id: `acc-${connection}`,
        tone: "danger",
        icon: Plug,
        title: `${names(list.map((s) => s.displayName ?? ""))} stopped syncing`,
        desc: `${app} access expired${kbs.length ? ` · ${names(kbs)} ${kbs.length === 1 ? "isn’t" : "aren’t"} getting updates` : ""}`,
        actions: (
          <LinkButton href={`/studio?tab=sources&view=accounts&reconnect=${resourceId(connection)}`} variant="secondary">
            Reconnect
          </LinkButton>
        ),
      });
    }
  } else {
    // Without access to sources the read model still counts them; a source administrator fixes them.
    const n = (kinds.get("SOURCE_FAILING") ?? 0) + (kinds.get("CONNECTION_EXPIRED") ?? 0);
    if (n) out.push({ id: "src", tone: "danger", icon: Plug, title: `${plural(n, "source")} stopped syncing`, desc: "A source administrator can reconnect them.", actions: null });
  }

  /* Access requests: one row, linking to People › Access requests. */
  const open = access.data ?? [];
  const openLink = (
    <LinkButton href="/people?tab=requests" variant="secondary">
      Open access requests
    </LinkButton>
  );
  if (open.length) {
    const r = open[0];
    const one = open.length === 1;
    const people = new Set(open.map((x) => x.requester)).size;
    const kbs = [...new Set(open.map((x) => baseName.get(x.collection ?? "")).filter((n): n is string => Boolean(n)))];
    out.push({
      id: "req",
      tone: "warning",
      icon: UserPlus,
      title: one ? `${who(r.requester)} asked for ${ACCESS_LABEL[r.requestedRole ?? ""] ?? "Viewer"} access` : `${plural(people, "person", "people")} waiting for access`,
      desc: one ? [baseName.get(r.collection ?? ""), r.question && `“${r.question}”`].filter(Boolean).join(" · ") : `To ${names(kbs)}`,
      actions: openLink,
    });
  } else if (!access.data && kinds.get("ACCESS_REQUESTS")) {
    const n = kinds.get("ACCESS_REQUESTS")!;
    out.push({ id: "req", tone: "warning", icon: UserPlus, title: `${plural(n, "access request")} waiting`, desc: "", actions: openLink });
  }

  if (extra) out.push(extra);
  // Most urgent first: broken, then waiting on you, then routine.
  return out.sort((a, b) => (RANK[a.tone] ?? 3) - (RANK[b.tone] ?? 3));
}

/** The Needs attention list, or "Everything is running". */
export function AttentionList({ items }: { items: Attn[] }) {
  const { hasModule } = useWorkspace();
  if (!items.length) {
    return (
      <EmptyState
        icon={CircleCheck}
        tone="success"
        boxed
        compact
        title="Everything is running"
        description={hasModule("requests") ? "Queues are on time, sources are syncing and no one is waiting for access." : "Sources are syncing and no one is waiting for access."}
      />
    );
  }
  return (
    <List className="ov-attn">
      {items.map((it) => (
        <ListItem
          key={it.id}
          lead={<ItemIcon icon={it.icon} tone={it.tone} />}
          title={it.title}
          description={it.desc ? <span className="ov-line">{it.desc}</span> : undefined}
          actions={it.actions}
        />
      ))}
    </List>
  );
}
