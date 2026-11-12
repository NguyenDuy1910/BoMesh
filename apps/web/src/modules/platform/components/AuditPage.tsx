"use client";

import { Button } from "@heroui/react";
import { Activity, ArrowRight, Copy, Download, Info, Search, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  ClearFilters,
  DataTable,
  Disclosure,
  EmptyState,
  FilterButton,
  Gate,
  IconButton,
  KeyValue,
  Page,
  PageHeader,
  Pager,
  paginate,
  PreviewChip,
  SearchInput,
  Segmented,
  SkeletonRows,
  StatusChip,
  toast,
  UserAvatar,
  type DataTableSort,
} from "@/components/ui";
import { fmtDateTime, plural, rel } from "@/lib/format";

import type { Connector, PlatformAuditEvent, User, Workspace, WorkspaceAuditEvent } from "../api";
import { actionLabel, AUDIT_WINDOWS, CATEGORY_LABEL, lastSegment, PLATFORM_WORKSPACE_ACTIONS, toCsv, userName, workspaceIdOf } from "../model";
import { useAuditEvents, useConnectors, usePlatformUsers, usePlatformWorkspaces } from "../queries";
import { copyText, PlatformDrawer, PREVIEW_TIP, saveFile, useUrlState, WsCell } from "./shared";
import { WorkspaceDrawer } from "./WorkspaceDrawer";

const PAGE = 15;
const SYSTEM = "BoMesh";

/** One row of the console's audit log: a platform event or a workspace event (metadata only). */
interface AuditRow {
  id: string;
  at: string | undefined;
  workspaceId: string;
  actor: string;
  action: string;
  category: string;
  area: string;
  target: string;
  /** Resource name the event is about (for the drawer's related object). */
  targetName: string;
  outcome: "success" | "failure";
  ip: string;
}

type Lookups = { users: Map<string, User>; workspaces: Map<string, Workspace>; connectors: Map<string, Connector> };

function actorName(actor: string | undefined, users: Lookups["users"]): string {
  if (!actor || actor === "system") return SYSTEM;
  const u = users.get(actor);
  return u ? userName(u) : "Unknown person";
}

/** A resource name in plain words: people, workspaces and connectors by name; other resources by kind. */
function targetLabel(target: string | undefined, l: Lookups): string {
  if (!target) return "";
  const u = l.users.get(target);
  if (u) return userName(u);
  const w = l.workspaces.get(target);
  if (w) return w.displayName ?? target;
  const c = l.connectors.get(target);
  if (c) return c.displayName ?? target;
  // Collection/id pairs: an odd-length path ends in a singleton resource (e.g. `users/{id}/preferences`).
  const parts = target.split("/");
  const singleton = parts.length % 2 === 1;
  const kind = (singleton ? parts.at(-1) : parts.at(-2)) ?? target;
  const spaced = kind.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  const words = singleton ? spaced : spaced.replace(/s$/, "");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function toRows(platform: readonly PlatformAuditEvent[], workspace: readonly WorkspaceAuditEvent[], l: Lookups): AuditRow[] {
  const row = (e: PlatformAuditEvent | WorkspaceAuditEvent, workspaceId: string): AuditRow => ({
    id: e.name ?? "",
    at: e.createTime,
    workspaceId,
    actor: actorName(e.actor, l.users),
    action: actionLabel(e.action),
    category: e.category ?? "",
    area: e.category ? CATEGORY_LABEL[e.category] : "—",
    // Workspace lifecycle events carry no target: the workspace itself is what changed (preview: its name under the action).
    target: e.target ? targetLabel(e.target, l) : workspaceId ? (l.workspaces.get(`workspaces/${workspaceId}`)?.displayName ?? (e.category ? CATEGORY_LABEL[e.category] : "")) : "",
    targetName: e.target ?? "",
    outcome: e.outcome === "FAILED" ? "failure" : "success",
    ip: e.ipAddress ?? "",
  });
  // Workspace-internal events stay in that workspace's Activity; the console shows the workspace's lifecycle only.
  const lifecycle = workspace.filter((e) => PLATFORM_WORKSPACE_ACTIONS.includes(e.action ?? ""));
  return [...platform.map((e) => row(e, workspaceIdOf(e.target))), ...lifecycle.map((e) => row(e, workspaceIdOf(e.name)))].sort(
    (a, b) => Date.parse(b.at ?? "") - Date.parse(a.at ?? ""),
  );
}

/** Preview `X.auditLog.whoAv`: the product itself ("BoMesh") gets a system mark instead of initials. */
function ActorAvatar({ name, size = "sm" }: { name: string; size?: "xs" | "sm" | "lg" }) {
  if (name !== SYSTEM) return <UserAvatar name={name} size={size} />;
  return (
    <span className={`avatar avatar--default avatar--${size} act-sys`} aria-hidden>
      <Zap className="i i-xs" />
    </span>
  );
}

/** Preview `P.pAudit` (built like workspace Activity, plus a Workspace column): search, window, filters, drawer, CSV. */
export function AuditPage() {
  const url = useUrlState();
  const router = useRouter();
  const win = AUDIT_WINDOWS.some((w) => w.value === url.get("win")) ? url.get("win") : "30";
  const events = useAuditEvents(win);
  const users = usePlatformUsers();
  const workspaces = usePlatformWorkspaces();
  const connectors = useConnectors();
  const [sort, setSort] = useState<DataTableSort | null>(null);
  const lookups: Lookups = {
    users: new Map((users.data ?? []).map((u) => [u.name ?? "", u])),
    workspaces: new Map((workspaces.data ?? []).map((w) => [w.name ?? "", w])),
    connectors: new Map((connectors.data ?? []).map((c) => [c.name ?? "", c])),
  };
  const wsById = new Map((workspaces.data ?? []).map((w) => [lastSegment(w.name), w]));
  const wsName = (id: string) => (id ? (wsById.get(id)?.displayName ?? id) : "Platform");

  const q = url.get("q");
  const ws = url.get("ws");
  const area = url.get("area");
  const outcome = url.get("outcome");
  const page = Math.max(1, Number(url.get("page")) || 1);

  const all = events.data ? toRows(events.data.platform, events.data.workspace, lookups) : [];
  const needle = q.trim().toLowerCase();
  const filteredRows = all.filter(
    (e) =>
      (!ws || (ws === "platform" ? !e.workspaceId : e.workspaceId === ws)) &&
      (!area || e.category === area) &&
      (!outcome || e.outcome === outcome) &&
      (!needle || [e.actor, e.action, e.target, e.area, wsName(e.workspaceId)].some((v) => v.toLowerCase().includes(needle))),
  );
  // Newest first unless a column sort is set; sorted before paging so every page follows it.
  const rows = sort
    ? [...filteredRows].sort((a, b) => {
        const d = sort.column === "actor" ? a.actor.localeCompare(b.actor) : Date.parse(a.at ?? "") - Date.parse(b.at ?? "");
        return sort.direction === "ascending" ? d : -d;
      })
    : filteredRows;
  const areas = [...new Set(all.map((e) => e.category).filter(Boolean))].map((c) => ({ value: c, label: CATEGORY_LABEL[c as keyof typeof CATEGORY_LABEL] }));
  const reset = () => url.set({ q: null, ws: null, area: null, outcome: null, win: null, page: null });

  const exportCsv = () => {
    if (!rows.length) {
      toast("No events to export. Change the filters and try again.", { tone: "danger" });
      return;
    }
    saveFile(
      "platform-audit.csv",
      toCsv([
        ["When", "Workspace", "Person", "Area", "Action", "Target", "Outcome", "IP address"],
        ...rows.map((e) => [e.at ?? "", wsName(e.workspaceId), e.actor, e.area, e.action, e.target, e.outcome, e.ip]),
      ]),
    );
    toast(`Saved ${plural(rows.length, "event")} to platform-audit.csv`);
  };

  const open = url.get("open");
  const current = open ? all.find((e) => e.id === open) : undefined;
  // Keep the last event while the drawer animates closed, so it never flashes "Event not found".
  const [shown, setShown] = useState<AuditRow | undefined>(current);
  if (current && current.id !== shown?.id) setShown(current);
  const selected = current ?? (open ? undefined : shown);

  /** The object an event is about, when the console can show it (preview `pRelated`). */
  const related = (e: AuditRow): { label: string; run: () => void } | null => {
    const user = lookups.users.get(e.targetName);
    if (user) return { label: `View ${userName(user)}`, run: () => router.push(`/p/users?open=${lastSegment(user.name)}`) };
    const connector = lookups.connectors.get(e.targetName);
    if (connector) return { label: `Open ${connector.displayName}`, run: () => router.push(`/p/connectors?open=${lastSegment(connector.name)}`) };
    const target = lookups.workspaces.get(e.targetName);
    const id = target ? lastSegment(target.name) : e.workspaceId && wsById.has(e.workspaceId) ? e.workspaceId : "";
    if (id) return { label: "View workspace", run: () => url.set({ open: null, workspace: id }) };
    return null;
  };
  const to = selected ? related(selected) : null;

  return (
    <Page>
      <PageHeader
        title="Audit log"
        chips={<PreviewChip tooltip={PREVIEW_TIP} />}
        actions={
          <Button variant="tertiary" isDisabled={!events.data} onPress={exportCsv}>
            <Download className="i" aria-hidden />
            Export CSV
          </Button>
        }
      />
      <Gate
        query={events}
        skeleton={<SkeletonRows rows={8} />}
        isEmpty={(d) => d.platform.length + d.workspace.length === 0 && win === "90"}
        empty={<EmptyState icon={Activity} title="No events recorded yet" description="Changes to workspaces, accounts, connectors and indexing appear here." boxed />}
      >
        <div className="toolbar act-toolbar">
          <SearchInput value={q} onChange={(v) => url.set({ q: v, page: null })} placeholder="Search events" />
          <Segmented label="Time window" value={win} options={AUDIT_WINDOWS} onChange={(v) => url.set({ win: v === "30" ? null : v, page: null })} />
          <FilterButton
            label="Workspace"
            value={ws}
            onChange={(v) => url.set({ ws: v, page: null })}
            options={[{ value: "platform", label: "Platform" }, ...(workspaces.data ?? []).map((w) => ({ value: lastSegment(w.name), label: w.displayName ?? "" }))]}
          />
          <FilterButton label="Area" value={area} onChange={(v) => url.set({ area: v, page: null })} options={areas} />
          <FilterButton
            label="Outcome"
            value={outcome}
            onChange={(v) => url.set({ outcome: v, page: null })}
            options={[
              { value: "success", label: "Succeeded" },
              { value: "failure", label: "Failed" },
            ]}
          />
          <ClearFilters isActive={Boolean(ws || area || outcome)} onClear={() => url.set({ ws: null, area: null, outcome: null, page: null })} />
          <span className="toolbar__end t-sm muted num">{plural(rows.length, "event")}</span>
        </div>
        {rows.length ? (
          <DataTable
            label="Audit events"
            rows={paginate(rows, page, PAGE)}
            getRowId={(e) => e.id}
            onRowAction={(e) => url.set({ open: e.id })}
            sort={sort}
            onSortChange={(s) => {
              setSort(s);
              url.set({ page: null });
            }}
            columns={[
              {
                id: "what",
                header: "What happened",
                primary: true,
                cell: (e) => (
                  <span className="stack act-what">
                    <span className="row gap-6">
                      <span className="cell-title truncate">{e.action}</span>
                      {e.outcome === "failure" ? <StatusChip kind="outcome" value="failure" size="sm" /> : null}
                    </span>
                    {e.target ? <span className="cell-sub truncate">{e.target}</span> : null}
                  </span>
                ),
              },
              {
                id: "actor",
                header: "Person",
                sortValue: (e) => e.actor,
                cell: (e) => (
                  <span className="row gap-8">
                    <ActorAvatar name={e.actor} />
                    <span className="truncate">{e.actor}</span>
                  </span>
                ),
              },
              { id: "ws", header: "Workspace", className: "hide-md", hideOnMobile: true, cell: (e) => <WsCell workspace={e.workspaceId ? wsById.get(e.workspaceId) : null} /> },
              {
                id: "at",
                header: "When",
                sortValue: (e) => Date.parse(e.at ?? ""),
                cell: (e) => (
                  <span className="muted act-when" title={fmtDateTime(e.at)}>
                    {rel(e.at)}
                  </span>
                ),
              },
            ]}
            footer={<Pager page={page} pageSize={PAGE} total={rows.length} onPageChange={(p) => url.set({ page: p > 1 ? String(p) : null })} />}
          />
        ) : (
          <EmptyState
            icon={Search}
            title="No events match"
            description="Try a longer time window or clear the filters."
            actions={
              <Button variant="tertiary" onPress={reset}>
                Reset filters
              </Button>
            }
            boxed
            compact
          />
        )}
      </Gate>
      <PlatformDrawer
        isOpen={Boolean(open)}
        onClose={() => url.set({ open: null })}
        lead={selected ? <ActorAvatar name={selected.actor} size="lg" /> : undefined}
        title={selected ? selected.action : events.isPending ? "Loading event" : "Event not found"}
        description={selected ? `${selected.actor} · ${rel(selected.at)}` : undefined}
        footer={
          to ? (
            <Button variant="primary" onPress={to.run}>
              {to.label}
              <ArrowRight className="i" aria-hidden />
            </Button>
          ) : null
        }
      >
        {selected ? (
          <>
            <section className="drawer__section">
              <KeyValue
                pairs={[
                  selected.target ? ["Target", selected.target] : null,
                  ["Area", selected.area],
                  ["Workspace", <WsCell key="ws" workspace={selected.workspaceId ? wsById.get(selected.workspaceId) : null} />],
                  ["Outcome", <StatusChip key="o" kind="outcome" value={selected.outcome} />],
                  ["Time", fmtDateTime(selected.at)],
                ]}
              />
            </section>
            <section className="drawer__section">
              <Disclosure icon={Info} title="Technical details">
                <KeyValue
                  pairs={[
                    [
                      "Event ID",
                      <span key="id" className="row gap-4">
                        <span className="mono t-sm">{lastSegment(selected.id)}</span>
                        <IconButton icon={Copy} tip="Copy event ID" size="sm" className="act-copy" onPress={() => void copyText(lastSegment(selected.id), "Event ID copied")} />
                      </span>,
                    ],
                    ["IP address", <span key="ip" className="mono t-sm">{selected.ip || "—"}</span>],
                  ]}
                />
              </Disclosure>
            </section>
          </>
        ) : events.isPending ? (
          <SkeletonRows rows={4} />
        ) : null}
      </PlatformDrawer>
      <WorkspaceDrawer workspaceId={url.get("workspace") || null} onClose={() => url.set({ workspace: null })} />
    </Page>
  );
}
