"use client";

import { Button } from "@heroui/react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Clock, History, Pause, Play, Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import {
  Callout,
  ClearFilters,
  DataTable,
  EmptyState,
  FilterButton,
  Gate,
  NoMatches,
  Page,
  PageHeader,
  SearchInput,
  SectionTabs,
  SkeletonRows,
  type DataTableColumn,
  type RowAction,
} from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { useSourceActions, type SourceActions } from "../actions";
import type { Connection, Source, Sync } from "../api";
import { accountLabel, accountUser, appName, canTogglePause, lastSyncText, scopeText, sourceName, sourceStatus } from "../model";
import { openReconnect, openWizard } from "../overlays";
import { useConnections, useSources, useSyncs } from "../queries";
import { scheduleText } from "../schedule";
import { HistoryTab } from "./HistoryTab";
import { IngestionDialogs } from "./IngestionDialogs";
import { KbLink, PolicyNote, SourceAppIcon, SourceStatusChip, SyncProgress, useBaseIndex, useParamState } from "./shared";
import { SourceDrawer } from "./SourceDrawer";
import { SyncDrawer } from "./SyncDrawer";

/**
 * `/sources` (preview `P.sources`): apps that keep knowledge bases up to date.
 * Tabs Sources · Sync history; alerts for expired accounts, failed sources and
 * documents waiting to publish; the source and sync drawers; the connect wizard.
 * URL: `?tab=history&source=&status=&page=`, `?q=&status=` (sources), `?open=<source id>`,
 * `?sync=<source id>.<sync id>`, `?connect=1&kb=<collection item id>`.
 */
export function SourcesPage() {
  const { can, name: workspaceName } = useWorkspace();
  const { params, set } = useParamState();
  const tab = params.get("tab") === "history" ? "history" : "sources";
  const sources = useSources();
  const connections = useConnections();
  const syncs = useSyncs();
  const bases = useBaseIndex();
  const actions = useSourceActions(connections.byName);
  const manage = can("sources.create");

  const connect = params.get("connect");
  const kbParam = params.get("kb");
  useEffect(() => {
    if (!connect) return;
    if (manage) openWizard({ kb: kbParam ? `${workspaceName}/items/${resourceId(kbParam)}` : undefined });
    set({ connect: null, kb: null });
  }, [connect, kbParam, manage, set, workspaceName]);

  const list = sources.data ?? [];
  const live = !!sources.data;
  const empty = live && list.length === 0;
  const alerts = live ? <Alerts sources={list} connections={connections.byName} syncs={syncs.data ?? []} actions={actions} manage={manage} /> : null;
  const hasAlerts = live && attentionCount(list) > 0;

  const openSync = (sync: Sync) => {
    const name = sync.name ?? "";
    set({ open: null, sync: `${resourceId(name.slice(0, name.indexOf("/syncs/")))}.${resourceId(name)}` });
  };

  return (
    <Page>
      <PageChrome crumbs={[{ label: "Sources" }]} />
      <PageHeader
        title="Sources"
        description="Apps that keep your knowledge bases up to date."
        actions={
          manage && !(tab === "sources" && empty) ? (
            <Button variant={hasAlerts ? "secondary" : "primary"} onPress={() => openWizard()}>
              <Plus className="i" aria-hidden />
              Connect source
            </Button>
          ) : null
        }
      />
      {alerts}
      <div className="page-tabs">
        <SectionTabs
          items={[
            { id: "sources", label: "Sources", count: live ? list.length : null },
            { id: "history", label: "Sync history" },
          ]}
          active={tab}
          base="/sources"
        />
      </div>
      {tab === "history" ? (
        <HistoryTab syncs={syncs} sources={list} connections={connections.byName} bases={bases.byName} onOpen={openSync} />
      ) : (
        <SourcesTab query={sources} connections={connections.byName} actions={actions} manage={manage} />
      )}
      <SourceDrawer sourceId={params.get("open")} focus={params.get("focus")} connections={connections.byName} actions={actions} onOpenSync={openSync} />
      <SyncDrawer param={params.get("sync")} connections={connections.byName} actions={actions} />
      <IngestionDialogs />
    </Page>
  );
}

function attentionCount(sources: readonly Source[]): number {
  return sources.filter((s) => s.state === "FAILED" || s.state === "REAUTHORIZATION_REQUIRED" || ((s.pendingDocumentCount ?? 0) > 0 && sourceStatus(s) !== "syncing")).length;
}

/** One alert per problem: an expired account (grouping its sources), a failed source, documents waiting to publish. */
function Alerts({
  sources,
  connections,
  syncs,
  actions,
  manage,
}: {
  sources: readonly Source[];
  connections: ReadonlyMap<string, Connection>;
  syncs: readonly Sync[];
  actions: SourceActions;
  manage: boolean;
}) {
  const byConnection = new Map<string, Source[]>();
  for (const s of sources.filter((x) => x.state === "REAUTHORIZATION_REQUIRED")) byConnection.set(s.connection, [...(byConnection.get(s.connection) ?? []), s]);
  const failed = sources.filter((s) => s.state === "FAILED");
  const waiting = sources.filter((s) => sourceStatus(s) !== "syncing" && (s.pendingDocumentCount ?? 0) > 0);
  const waitingCount = waiting.reduce((n, s) => n + (s.pendingDocumentCount ?? 0), 0);
  if (!byConnection.size && !failed.length && !waiting.length) return null;

  return (
    <div className="stack gap-8 mb-16">
      {[...byConnection.entries()].map(([name, list]) => {
        const connection = connections.get(name);
        const first = list[0]!;
        const who = list.length === 1 ? sourceName(first) : `${sourceName(first)} and ${plural(list.length - 1, "other source")}`;
        return (
          <Callout
            key={name}
            tone="danger"
            title={`${who} can’t sync — ${appName(connection?.connector)} access expired`}
            description={connection ? `Sign in again as ${accountUser(connection)}. Synced documents stay searchable.` : undefined}
            actions={
              manage ? (
                <Button size="sm" variant="primary" onPress={() => openReconnect(name)}>
                  Reconnect
                </Button>
              ) : null
            }
          />
        );
      })}
      {failed.map((s) => (
        <Callout
          key={s.name}
          tone="danger"
          title={`${sourceName(s)} couldn’t sync`}
          description={syncs.find((x) => x.name === s.lastSync?.sync)?.error?.message || "Try syncing again."}
          actions={
            manage ? (
              <Button size="sm" variant="primary" onPress={() => void actions.syncNow(s)}>
                Sync now
              </Button>
            ) : null
          }
        />
      ))}
      {waiting.length ? (
        <Callout
          tone="accent"
          title={`${plural(waitingCount, "synced document")} waiting to publish`}
          description={`From ${waiting.map(sourceName).join(", ")}. Publishing makes them searchable.`}
          actions={
            manage ? (
              <Button size="sm" variant="secondary" onPress={() => void actions.publish(waiting)}>
                <Play className="i" aria-hidden />
                Publish all waiting
              </Button>
            ) : null
          }
        />
      ) : null}
    </div>
  );
}

const STATUS_FILTER = [
  { value: "healthy", label: "Up to date" },
  { value: "syncing", label: "Syncing" },
  { value: "attention", label: "Needs attention" },
  { value: "paused", label: "Paused" },
];

function SourcesTab({
  query,
  connections,
  actions,
  manage,
}: {
  query: UseQueryResult<Source[]>;
  connections: ReadonlyMap<string, Connection>;
  actions: SourceActions;
  manage: boolean;
}) {
  const { params, set } = useParamState();
  const bases = useBaseIndex();
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";

  const empty = (
    <EmptyState
      icon={Plug}
      title="Connect your first source"
      description="Keep a knowledge base in sync with Google Drive or Confluence."
      boxed
      actions={
        manage ? (
          <Button variant="primary" onPress={() => openWizard()}>
            <Plus className="i" aria-hidden />
            Connect source
          </Button>
        ) : undefined
      }
    />
  );

  const columns = useMemo<DataTableColumn<Source>[]>(
    () => [
      {
        id: "name",
        header: "Source",
        primary: true,
        sortValue: (s) => sourceName(s).toLowerCase(),
        cell: (s) => {
          const connection = connections.get(s.connection);
          return (
            <div className="row gap-12">
              <SourceAppIcon source={s} connections={connections} />
              <div className="stack src-min">
                <span className="cell-title truncate" translate="no">
                  {sourceName(s)}
                </span>
                <span className="cell-sub truncate" translate="no">
                  {connection ? scopeText(s) : "No account"}
                </span>
              </div>
            </div>
          );
        },
      },
      {
        id: "kb",
        header: "Knowledge base",
        cell: (s) => (
          <div className="stack src-min src-kbcell">
            <KbLink base={bases.byName.get(s.targetCollection)} name={s.targetCollection} />
            <PolicyNote source={s} />
          </div>
        ),
      },
      {
        id: "schedule",
        header: "Schedule",
        hideOnMobile: true,
        cell: (s) => <span className={s.state === "PAUSED" ? "muted" : undefined}>{scheduleText(s.schedule)}</span>,
      },
      {
        id: "last",
        header: "Last sync",
        hideOnMobile: true,
        sortValue: (s) => (s.lastSync?.endTime ? Date.parse(s.lastSync.endTime) : 0),
        cell: (s) =>
          s.lastSync && s.lastSync.state !== "RUNNING" ? (
            <div className="stack">
              <span>{rel(s.lastSync.endTime)}</span>
              <span className={`cell-sub ${s.lastSync.state === "FAILED" ? "text-danger" : s.lastSync.failedCount ? "text-warning" : ""}`}>{lastSyncText(s)}</span>
            </div>
          ) : s.lastSync ? (
            <span className="muted">Syncing now</span>
          ) : (
            <span className="muted">Never</span>
          ),
      },
      {
        id: "status",
        header: "Status",
        cell: (s) =>
          sourceStatus(s) === "syncing" ? (
            <div className="src-syncing">
              <SourceStatusChip source={s} />
              <SyncProgress value={null} label={`${(s.lastSync?.addedCount ?? 0) + (s.lastSync?.updatedCount ?? 0)} so far`} />
            </div>
          ) : (
            <SourceStatusChip source={s} />
          ),
      },
    ],
    [connections, bases.byName],
  );

  const rowLead = (s: Source) => {
    const st = sourceStatus(s);
    if (st === "reconnect")
      return (
        <Button size="sm" variant="secondary" onPress={() => openReconnect(s.connection)}>
          Reconnect
        </Button>
      );
    if (st === "paused")
      return (
        <Button size="sm" variant="secondary" onPress={() => void actions.togglePause(s)}>
          <Play className="i" aria-hidden />
          Resume
        </Button>
      );
    if (st === "syncing" || connections.get(s.connection)?.state !== "ACTIVE") return null;
    return (
      <Button size="sm" variant="secondary" onPress={() => void actions.syncNow(s)}>
        <RefreshCw className="i" aria-hidden />
        Sync now
      </Button>
    );
  };

  const rowMenu = (s: Source): RowAction[] => {
    const syncing = sourceStatus(s) === "syncing";
    const paused = s.state === "PAUSED";
    return [
      { id: "sync", label: "Sync now", icon: RefreshCw, isDisabled: syncing || paused, onAction: () => void actions.syncNow(s) },
      { id: "schedule", label: "Edit schedule", icon: Clock, onAction: () => set({ open: resourceId(s.name), focus: "schedule" }) },
      { id: "pause", label: paused ? "Resume" : "Pause", icon: paused ? Play : Pause, isDisabled: syncing || !canTogglePause(s), onAction: () => void actions.togglePause(s) },
      { id: "history", label: "View sync history", icon: History, onAction: () => set({ tab: "history", source: resourceId(s.name), status: null, page: null, q: null }) },
      { id: "disconnect", label: "Disconnect", icon: Trash2, danger: true, onAction: () => void actions.disconnect(s, bases.byName.get(s.targetCollection)?.displayName) },
    ];
  };

  return (
    <Gate query={query} skeleton={<SkeletonRows rows={4} />} isEmpty={(d) => d.length === 0} empty={empty}>
      {(data) => {
        const needle = q.trim().toLowerCase();
        const rows = data.filter((s) => {
          const st = sourceStatus(s);
          if (status && (status === "attention" ? st !== "failed" && st !== "reconnect" : st !== status)) return false;
          if (!needle) return true;
          const connection = connections.get(s.connection);
          return [sourceName(s), bases.byName.get(s.targetCollection)?.displayName, accountLabel(connection), appName(connection?.connector), scopeText(s)].some((v) => v?.toLowerCase().includes(needle));
        });
        return (
          <>
            <div className="toolbar">
              <SearchInput value={q} onChange={(v) => set({ q: v || null })} placeholder="Search sources" />
              <FilterButton label="Status" options={STATUS_FILTER} value={status} onChange={(v) => set({ status: v || null })} />
              <ClearFilters isActive={!!status} onClear={() => set({ status: null })} />
            </div>
            {rows.length ? (
              <DataTable
                label="Sources"
                rows={rows}
                columns={columns}
                getRowId={(s) => s.name ?? ""}
                onRowAction={(s) => set({ open: resourceId(s.name), focus: null })}
                rowActions={manage ? rowMenu : undefined}
                rowActionLead={manage ? rowLead : undefined}
                actionsClassName="src-actions"
              />
            ) : (
              <NoMatches what="sources" onClear={() => set({ q: null, status: null })} />
            )}
          </>
        );
      }}
    </Gate>
  );
}
