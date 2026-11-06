"use client";

import { Button } from "@heroui/react";
import { Activity, Download } from "lucide-react";
import { useState } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import {
  ClearFilters,
  DataTable,
  EmptyState,
  FilterButton,
  Gate,
  KeyValue,
  NoMatches,
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
} from "@/components/ui";
import { fmtDateTime, plural, rel } from "@/lib/format";

import type { Connector, PlatformAuditEvent, User, Workspace, WorkspaceAuditEvent } from "../api";
import { actionLabel, AUDIT_WINDOWS, CATEGORY_LABEL, lastSegment, toCsv, userName, workspaceIdOf } from "../model";
import { useAuditEvents, useConnectors, usePlatformUsers, usePlatformWorkspaces } from "../queries";
import { PlatformDrawer, PREVIEW_TIP, saveFile, useUrlState, WsCell } from "./shared";
import { WorkspaceDrawer } from "./WorkspaceDrawer";

const PAGE = 15;

/** One row of the console's audit log: a platform event or a workspace event (metadata only). */
interface AuditRow {
  id: string;
  at: string | undefined;
  workspaceId: string;
  actor: string;
  action: string;
  area: string;
  target: string;
  outcome: "success" | "failure";
  ip: string;
}

type Lookups = { users: Map<string, User>; workspaces: Map<string, Workspace>; connectors: Map<string, Connector> };

function actorName(actor: string | undefined, users: Lookups["users"]): string {
  if (!actor || actor === "system") return "BoMesh";
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
    area: e.category ? CATEGORY_LABEL[e.category] : "—",
    target: e.target ? targetLabel(e.target, l) : workspaceId ? (e.category ? CATEGORY_LABEL[e.category] : "") : "",
    outcome: e.outcome === "FAILED" ? "failure" : "success",
    ip: e.ipAddress ?? "",
  });
  return [...platform.map((e) => row(e, "")), ...workspace.map((e) => row(e, workspaceIdOf(e.name)))].sort((a, b) => Date.parse(b.at ?? "") - Date.parse(a.at ?? ""));
}

/** Preview `P.pAudit`: cross-workspace events with search, window, workspace and outcome filters, drawer, CSV export. */
export function AuditPage() {
  const url = useUrlState();
  const win = AUDIT_WINDOWS.some((w) => w.value === url.get("win")) ? url.get("win") : "30";
  const events = useAuditEvents(win);
  const users = usePlatformUsers();
  const workspaces = usePlatformWorkspaces();
  const connectors = useConnectors();
  const lookups: Lookups = {
    users: new Map((users.data ?? []).map((u) => [u.name ?? "", u])),
    workspaces: new Map((workspaces.data ?? []).map((w) => [w.name ?? "", w])),
    connectors: new Map((connectors.data ?? []).map((c) => [c.name ?? "", c])),
  };
  const wsById = new Map((workspaces.data ?? []).map((w) => [lastSegment(w.name), w]));

  const q = url.get("q");
  const ws = url.get("ws");
  const outcome = url.get("outcome");
  const page = Math.max(1, Number(url.get("page")) || 1);

  const all = events.data ? toRows(events.data.platform, events.data.workspace, lookups) : [];
  const needle = q.trim().toLowerCase();
  const rows = all.filter(
    (e) =>
      (!ws || (ws === "platform" ? !e.workspaceId : e.workspaceId === ws)) &&
      (!outcome || e.outcome === outcome) &&
      (!needle || [e.actor, e.action, e.target, e.area, e.workspaceId ? wsById.get(e.workspaceId)?.displayName ?? "" : "Platform"].some((v) => v.toLowerCase().includes(needle))),
  );

  const exportCsv = () => {
    if (!rows.length) {
      toast("No events to export. Change the filters and try again.", { tone: "danger" });
      return;
    }
    saveFile(
      "platform-audit.csv",
      toCsv([
        ["When", "Workspace", "Person", "Area", "Action", "Target", "Outcome", "IP address"],
        ...rows.map((e) => [e.at ?? "", e.workspaceId ? wsById.get(e.workspaceId)?.displayName ?? e.workspaceId : "Platform", e.actor, e.area, e.action, e.target, e.outcome, e.ip]),
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

  return (
    <Page>
      <PageChrome crumbs={[{ label: "Audit log" }]} />
      <PageHeader
        title="Audit log"
        chips={<PreviewChip tooltip={PREVIEW_TIP} />}
        actions={
          <Button variant="tertiary" onPress={exportCsv}>
            <Download className="i" aria-hidden />
            Export CSV
          </Button>
        }
      />
      <Gate
        query={events}
        skeleton={<SkeletonRows rows={8} />}
        isEmpty={(d) => d.platform.length + d.workspace.length === 0 && win === "90"}
        empty={<EmptyState icon={Activity} title="No events recorded yet" description="Changes to workspaces, people and connectors appear here." boxed />}
      >
        <div className="toolbar">
          <SearchInput value={q} onChange={(v) => url.set({ q: v, page: null })} placeholder="Search events" />
          <FilterButton
            label="Workspace"
            value={ws}
            onChange={(v) => url.set({ ws: v, page: null })}
            options={[{ value: "platform", label: "Platform" }, ...(workspaces.data ?? []).map((w) => ({ value: lastSegment(w.name), label: w.displayName ?? "" }))]}
          />
          <FilterButton
            label="Outcome"
            value={outcome}
            onChange={(v) => url.set({ outcome: v, page: null })}
            options={[
              { value: "success", label: "Succeeded" },
              { value: "failure", label: "Failed" },
            ]}
          />
          <ClearFilters isActive={Boolean(ws || outcome)} onClear={() => url.set({ ws: null, outcome: null, page: null })} />
          <div className="toolbar__end">
            <Segmented label="Time window" value={win} options={AUDIT_WINDOWS} onChange={(v) => url.set({ win: v === "30" ? null : v, page: null })} />
          </div>
        </div>
        {rows.length ? (
          <DataTable
            label="Audit events"
            rows={paginate(rows, page, PAGE)}
            getRowId={(e) => e.id}
            onRowAction={(e) => url.set({ open: e.id })}
            columns={[
              {
                id: "when",
                header: "When",
                className: "pf-nowrap",
                cell: (e) => (
                  <span className="muted num" title={fmtDateTime(e.at)}>
                    {rel(e.at)}
                  </span>
                ),
              },
              {
                id: "person",
                header: "Person",
                className: "hide-md",
                hideOnMobile: true,
                cell: (e) => (
                  <span className="row gap-8">
                    <UserAvatar name={e.actor} size="xs" />
                    <span className="truncate">{e.actor}</span>
                  </span>
                ),
              },
              {
                id: "action",
                header: "Action",
                primary: true,
                cell: (e) => (
                  <div className="stack">
                    <span className="cell-title">{e.action}</span>
                    {e.target ? <span className="cell-sub truncate pf-target">{e.target}</span> : null}
                  </div>
                ),
              },
              { id: "ws", header: "Workspace", className: "hide-sm", hideOnMobile: true, cell: (e) => <WsCell workspace={e.workspaceId ? wsById.get(e.workspaceId) : null} /> },
              { id: "outcome", header: "Outcome", cell: (e) => <StatusChip kind="outcome" value={e.outcome} /> },
            ]}
            footer={<Pager page={page} pageSize={PAGE} total={rows.length} onPageChange={(p) => url.set({ page: p > 1 ? String(p) : null })} />}
          />
        ) : (
          <NoMatches what="events" onClear={() => url.set({ q: null, ws: null, outcome: null, page: null })} />
        )}
      </Gate>
      <PlatformDrawer
        isOpen={Boolean(open)}
        onClose={() => url.set({ open: null })}
        title={selected ? selected.action : events.isPending ? "Loading event" : "Event not found"}
        description={selected ? fmtDateTime(selected.at) : undefined}
        footer={
          selected?.workspaceId && wsById.get(selected.workspaceId) ? (
            <Button variant="tertiary" onPress={() => url.set({ open: null, workspace: selected.workspaceId })}>
              View workspace
            </Button>
          ) : (
            <Button variant="tertiary" onPress={() => url.set({ open: null })}>
              Done
            </Button>
          )
        }
      >
        {selected ? (
          <KeyValue
            pairs={[
              ["Outcome", <StatusChip key="o" kind="outcome" value={selected.outcome} />],
              [
                "When",
                <span key="w">
                  {fmtDateTime(selected.at)} <span className="muted">· {rel(selected.at)}</span>
                </span>,
              ],
              ["Workspace", <WsCell key="ws" workspace={selected.workspaceId ? wsById.get(selected.workspaceId) : null} />],
              [
                "Person",
                <span key="p" className="row gap-8">
                  <UserAvatar name={selected.actor} size="xs" />
                  {selected.actor}
                </span>,
              ],
              ["Area", selected.area],
              selected.target ? ["Target", selected.target] : null,
              selected.ip ? ["IP address", <span key="ip" className="mono">{selected.ip}</span>] : null,
            ]}
          />
        ) : events.isPending ? (
          <SkeletonRows rows={4} />
        ) : null}
      </PlatformDrawer>
      <WorkspaceDrawer workspaceId={url.get("workspace") || null} onClose={() => url.set({ workspace: null })} />
    </Page>
  );
}
