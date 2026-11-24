"use client";

import { CircleAlert, CircleCheck, Clock, Plug, UserPlus, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { APPS, EmptyState, ItemIcon, List, ListItem, type Tone } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { LinkButton } from "@/modules/curation/components/parts";
import { appKeyOf } from "@/modules/knowledge/components/SourceIcon";
import { useKnowledgeBases, useMemberNames } from "@/modules/knowledge/queries";
import { ACCESS_LABEL } from "@/modules/people/model";

import type { Source, WorkspaceOverview } from "../api";
import { useAccessRequests, useConnections, useServiceSla, useSources } from "../queries";

export interface Attn {
  id: string;
  tone: Tone;
  icon: LucideIcon;
  title: string;
  desc: string;
  actions: ReactNode;
}

const RANK: Partial<Record<Tone, number>> = { danger: 0, warning: 1, accent: 2 };

/** "A", "A và B", "A, B và 3 mục khác". */
export const names = (list: readonly string[]) => (list.length <= 2 ? list.join(" và ") : `${list.slice(0, 2).join(", ")} và ${plural(list.length - 2, "other")}`);

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
  const service = useServiceSla();
  // Names for the requests this list mentions (two late requests, the one access request): one batch read.
  const named = useMemberNames([...(service.data?.first ?? []), ...(access.data?.requests.slice(0, 1) ?? [])].map((r) => r.requester));
  const bases = useKnowledgeBases({ showLocked: true });
  const waiting = [sources, connections, access, service].some((q) => q.isPending && q.fetchStatus !== "idle");
  if (!overview || waiting) return undefined;

  const who = (member: string | undefined) => named.get(member ?? "") || "Ai đó";
  const baseName = new Map((bases.data ?? []).map((b) => [b.name ?? "", b.displayName ?? ""]));
  const kinds = new Map((overview.attentionItems ?? []).map((a) => [a.kind ?? "", a.itemCount ?? 0]));
  const out: Attn[] = [];

  /* Office queues past or near their response time (Requests module). */
  if (hasModule("requests") && service.data) {
    const { late, soon, first } = service.data;
    if (late || soon) {
      const extraSoon = late && soon ? ` · thêm ${soon} yêu cầu đến hạn trong một ngày` : "";
      out.push({
        id: "sla",
        tone: late ? "danger" : "warning",
        icon: Clock,
        title: late ? `${plural(late, "yêu cầu văn phòng")} quá thời gian phản hồi` : `${plural(soon, "yêu cầu văn phòng")} đến hạn trong một ngày`,
        desc: first.map((r) => `${r.title ?? "Yêu cầu"} · ${who(r.requester)}`).join(", ") + extraSoon,
        actions: (
          <LinkButton href="/requests?tab=queue" variant="secondary">
            Mở hàng đợi
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
        const app = APPS[appKeyOf(conn?.connector) as keyof typeof APPS]?.name ?? "Ứng dụng";
        const entry = expired.get(s.connection) ?? { app, list: [] };
        entry.list.push(s);
        expired.set(s.connection, entry);
      } else if (s.state === "FAILED" || s.lastSync?.state === "FAILED") {
        out.push({
          id: `src-${s.name}`,
          tone: "danger",
          icon: CircleAlert,
          title: `${s.displayName ?? "Một nguồn dữ liệu"} không đồng bộ được`,
          desc: "Lần đồng bộ gần nhất bị lỗi.",
          actions: (
            <LinkButton href={`/studio?tab=sources&open=${resourceId(s.name)}`} variant="secondary">
              Mở bản gốc
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
        title: `${names(list.map((s) => s.displayName ?? ""))} đã ngừng đồng bộ`,
        desc: `Quyền truy cập ${app} đã hết hạn${kbs.length ? ` · ${names(kbs)} không còn được cập nhật` : ""}`,
        actions: (
          <LinkButton href={`/studio?tab=sources&view=accounts&reconnect=${resourceId(connection)}`} variant="secondary">
            Kết nối lại
          </LinkButton>
        ),
      });
    }
  } else {
    // Without access to sources the read model still counts them; a source administrator fixes them.
    const n = (kinds.get("SOURCE_FAILING") ?? 0) + (kinds.get("CONNECTION_EXPIRED") ?? 0);
    if (n) out.push({ id: "src", tone: "danger", icon: Plug, title: `${plural(n, "source")} đã ngừng đồng bộ`, desc: "Quản trị viên nguồn dữ liệu có thể kết nối lại.", actions: null });
  }

  /* Access requests: one row, linking to People › Access requests. */
  const open = access.data?.requests ?? [];
  const openLink = (
    <LinkButton href="/people?tab=requests" variant="secondary">
      Mở các yêu cầu truy cập
    </LinkButton>
  );
  if (open.length && access.data) {
    const { total, complete } = access.data;
    const r = open[0];
    const one = total === 1;
    // Who and where are named only when every open request is on the page read; otherwise the count says it.
    const people = new Set(open.map((x) => x.requester)).size;
    const kbs = [...new Set(open.map((x) => baseName.get(x.collection ?? "")).filter((n): n is string => Boolean(n)))];
    out.push({
      id: "req",
      tone: "warning",
      icon: UserPlus,
      title: one
        ? `${who(r.requester)} đã yêu cầu quyền ${ACCESS_LABEL[r.requestedRole ?? ""] ?? "Người xem"}`
        : complete
          ? `${plural(people, "person")} đang chờ quyền truy cập`
          : `${plural(total, "access request")} đang chờ`,
      desc: one ? [baseName.get(r.collection ?? ""), r.question && `“${r.question}”`].filter(Boolean).join(" · ") : complete ? `Đến ${names(kbs)}` : "",
      actions: openLink,
    });
  } else if (!access.data && kinds.get("ACCESS_REQUESTS")) {
    const n = kinds.get("ACCESS_REQUESTS")!;
    out.push({ id: "req", tone: "warning", icon: UserPlus, title: `${plural(n, "access request")} đang chờ`, desc: "", actions: openLink });
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
        title="Mọi thứ đang hoạt động"
        description={hasModule("requests") ? "Hàng đợi đúng hạn, nguồn đang đồng bộ và không ai đang chờ quyền truy cập." : "Nguồn dữ liệu đang đồng bộ và không ai đang chờ quyền truy cập."}
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
