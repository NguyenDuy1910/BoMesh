"use client";

import { Button } from "@heroui/react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Clock, History, LogIn, Pause, Play, Plug, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo } from "react";

import {
  ClearFilters,
  DataTable,
  EmptyState,
  FilterButton,
  Gate,
  IconButton,
  NoMatches,
  PageHeader,
  PreviewChip,
  SearchInput,
  Segmented,
  SkeletonRows,
  type DataTableColumn,
  type RowAction,
} from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { fmtNum, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { useSourceActions, type SourceActions } from "../actions";
import type { Connection, Source, Sync } from "../api";
import { accountLabel, appName, canTogglePause, lastSyncText, rowActionKind, scopeText, sourceName, sourceStatus, syncedWithIssues } from "../model";
import { openReconnect, openWizard } from "../overlays";
import { useConnections, useSources, useSyncs } from "../queries";
import { scheduleText } from "../schedule";
import { AccountsView } from "./AccountsView";
import { AddSourceButton } from "./AddSourceButton";
import { HistoryTab } from "./HistoryTab";
import { CollectionLink, PolicyNote, SourceAppIcon, SourceStatusChip, SyncingCell, useCollectionIndex, useParamState, useSyncIndex } from "./shared";
import { SourceOverlays, syncParam } from "./SourceOverlays";

type View = "sources" | "history" | "accounts";
const VIEWS: readonly [View, string][] = [
  ["sources", "Sources"],
  ["history", "Sync history"],
  ["accounts", "Accounts"],
];

/**
 * Knowledge Studio → Sources (preview `X.src.tab`): everything that brings documents in — the sources, their
 * sync history and the accounts they sign in with — switched with one segmented control (`?view=`). No alert
 * banners: each row's one visible action is its fix. URL: `?view=history&source=&status=&page=`,
 * `?q=&status=` (sources), `?open=<source id>&focus=schedule`, `?sync=<source id>.<sync id>`,
 * `?reconnect=<connection id>`, `?connect=1&kb=<collection id>`.
 */
export function SourcesSection() {
  const { can, name: workspaceName, workspace } = useWorkspace();
  const { params, set } = useParamState();
  const asked = params.get("view");
  const view: View = asked === "history" || asked === "accounts" ? asked : "sources";
  const sources = useSources();
  const connections = useConnections();
  const syncs = useSyncs();
  const collections = useCollectionIndex();
  const actions = useSourceActions(connections.byName);
  const manage = can("sources.create");

  // Deep links: `?connect=1&kb=` opens Add source (with that collection), `?reconnect=` the Reconnect dialog.
  const connect = params.get("connect");
  const kbParam = params.get("kb");
  const reconnect = params.get("reconnect");
  useEffect(() => {
    if (!connect && !reconnect) return;
    if (connect && manage) openWizard({ collection: kbParam ? `${workspaceName}/items/${resourceId(kbParam)}` : undefined });
    if (reconnect && can("connections.create")) openReconnect(`${workspaceName}/connections/${resourceId(reconnect)}`);
    set({ connect: null, kb: null, reconnect: null });
  }, [connect, kbParam, reconnect, manage, can, set, workspaceName]);

  const live = !!sources.data && !!connections.data;
  const expired = (connections.data ?? []).filter((c) => c.state === "REAUTHORIZATION_REQUIRED").length;
  const counts: Record<View, string> = {
    sources: live ? fmtNum(sources.data?.length ?? 0) : "",
    history: "",
    accounts: expired ? `${fmtNum(expired)} expired` : live ? fmtNum(connections.data?.length ?? 0) : "",
  };

  return (
    <>
      <PageHeader
        title="Sources"
        chips={workspace.demo ? <PreviewChip label="Demo data" tooltip="This workspace holds fictional demo content." /> : null}
        actions={<AddSourceButton />}
      />
      <div className="src-views">
        <Segmented
          label="Sources views"
          value={view}
          options={VIEWS.map(([value, label]) => ({ value, label: counts[value] ? `${label} · ${counts[value]}` : label }))}
          // Each view keeps its own filters; switching starts clean.
          onChange={(v) => set({ view: v === "sources" ? null : v, q: null, status: null, source: null, page: null })}
        />
      </div>
      {view === "history" ? (
        <HistoryTab syncs={syncs} sources={sources.data ?? []} connections={connections.byName} collections={collections.byName} onOpen={(sync: Sync) => set({ open: null, sync: syncParam(sync) })} />
      ) : view === "accounts" ? (
        <AccountsView />
      ) : (
        <SourcesView query={sources} syncs={syncs.data} connections={connections.byName} actions={actions} manage={manage} />
      )}
      <SourceOverlays />
    </>
  );
}

const STATUS_FILTER = [
  { value: "healthy", label: "Up to date" },
  { value: "partial", label: "Synced with issues" },
  { value: "syncing", label: "Syncing" },
  { value: "attention", label: "Needs attention" },
  { value: "paused", label: "Paused" },
];

function SourcesView({
  query,
  syncs,
  connections,
  actions,
  manage,
}: {
  query: UseQueryResult<Source[]>;
  syncs: readonly Sync[] | undefined;
  connections: ReadonlyMap<string, Connection>;
  actions: SourceActions;
  manage: boolean;
}) {
  const { params, set } = useParamState();
  const collections = useCollectionIndex();
  const syncIndex = useSyncIndex(syncs);
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const open = (s: Source, focus?: string) => set({ open: resourceId(s.name), focus: focus ?? null, sync: null });

  const empty = <EmptyState icon={Plug} title="No sources yet" description="Keep a collection in sync with Google Drive or Confluence." boxed actions={<AddSourceButton />} />;

  const columns = useMemo<DataTableColumn<Source>[]>(
    () => [
      {
        id: "name",
        header: "Source",
        primary: true,
        sortValue: (s) => sourceName(s).toLowerCase(),
        cell: (s) => (
          <div className="row gap-12">
            <SourceAppIcon source={s} connections={connections} />
            <div className="stack src-min">
              <span className="cell-title truncate" translate="no">
                {sourceName(s)}
              </span>
              <span className="cell-sub truncate" translate="no">
                {connections.get(s.connection) ? scopeText(s) : "No account"}
              </span>
            </div>
          </div>
        ),
      },
      {
        id: "collection",
        header: "Collection",
        cell: (s) => (
          <div className="stack src-min src-kbcell">
            <CollectionLink name={s.targetCollection} label={collections.byName.get(s.targetCollection)?.displayName} />
            <PolicyNote source={s} />
          </div>
        ),
      },
      {
        id: "schedule",
        header: "Schedule",
        hideOnMobile: true,
        className: "src-when",
        cell: (s) => <span className={s.state === "PAUSED" ? "muted" : undefined}>{scheduleText(s.schedule)}</span>,
      },
      {
        id: "last",
        header: "Last sync",
        hideOnMobile: true,
        sortValue: (s) => (s.lastSync?.endTime ? Date.parse(s.lastSync.endTime) : 0),
        cell: (s) =>
          s.lastSync && s.lastSync.state !== "RUNNING" ? (
            <div className="stack src-when">
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
        cell: (s) => (sourceStatus(s) === "syncing" ? <SyncingCell source={s} syncs={syncIndex} /> : <SourceStatusChip source={s} syncs={syncIndex} />),
      },
    ],
    [connections, collections.byName, syncIndex],
  );

  /** The one visible row action (preview `rowAction`). */
  const rowLead = (s: Source) => {
    switch (rowActionKind(s, connections.get(s.connection))) {
      case "reconnect":
        return (
          <Button size="sm" variant="secondary" onPress={() => openReconnect(s.connection)}>
            <LogIn className="i" aria-hidden />
            Reconnect
          </Button>
        );
      case "retry":
        return (
          <Button size="sm" variant="secondary" onPress={() => void actions.syncNow(s)}>
            <RefreshCw className="i" aria-hidden />
            Retry
          </Button>
        );
      case "resume":
        return (
          <Button size="sm" variant="secondary" isDisabled={!canTogglePause(s)} onPress={() => void actions.togglePause(s)}>
            <Play className="i" aria-hidden />
            Resume
          </Button>
        );
      case "publish":
        return (
          <Button size="sm" variant="secondary" onPress={() => void actions.publish([s])}>
            <Play className="i" aria-hidden />
            {`Publish ${fmtNum(s.pendingDocumentCount ?? 0)}`}
          </Button>
        );
      case "sync":
        return <IconButton icon={RefreshCw} tip="Sync now" size="sm" className="src-quiet" onPress={() => void actions.syncNow(s)} />;
      default:
        return null;
    }
  };

  /** Row ⋯ holds what the row doesn't show. */
  const rowMenu = (s: Source): RowAction[] => {
    const shown = rowActionKind(s, connections.get(s.connection));
    const syncing = sourceStatus(s) === "syncing";
    const paused = s.state === "PAUSED";
    const items: RowAction[] = [];
    if (s.state === "REAUTHORIZATION_REQUIRED") items.push({ id: "reconnect", label: "Reconnect", icon: LogIn, onAction: () => openReconnect(s.connection) });
    else if (shown !== "sync") items.push({ id: "sync", label: "Sync now", icon: RefreshCw, isDisabled: syncing || paused, onAction: () => void actions.syncNow(s) });
    items.push({ id: "schedule", label: "Edit schedule", icon: Clock, onAction: () => open(s, "schedule") });
    if (shown !== "resume")
      items.push({ id: "pause", label: paused ? "Resume" : "Pause", icon: paused ? Play : Pause, isDisabled: syncing || !canTogglePause(s), onAction: () => void actions.togglePause(s) });
    items.push(
      { id: "history", label: "View sync history", icon: History, onAction: () => set({ view: "history", source: resourceId(s.name), status: null, page: null, q: null }) },
      { id: "disconnect", label: "Disconnect", icon: Trash2, danger: true, onAction: () => void actions.disconnect(s, collections.byName.get(s.targetCollection)?.displayName) },
    );
    return items;
  };

  return (
    <Gate query={query} skeleton={<SkeletonRows rows={4} />} isEmpty={(d) => d.length === 0} empty={empty}>
      {(data) => {
        const needle = q.trim().toLowerCase();
        const rows = data.filter((s) => {
          const st = sourceStatus(s);
          if (status) {
            if (status === "attention" ? st !== "failed" && st !== "reconnect" : status === "partial" ? !syncedWithIssues(s) : st !== status || (status === "healthy" && syncedWithIssues(s))) return false;
          }
          if (!needle) return true;
          const connection = connections.get(s.connection);
          return [sourceName(s), collections.byName.get(s.targetCollection)?.displayName, accountLabel(connection), appName(connection?.connector), scopeText(s)].some((v) => v?.toLowerCase().includes(needle));
        });
        // Search, filter only once there are enough sources to need them (or one is in use).
        const tools = data.length >= 7 || !!(q || status);
        return (
          <>
            {tools ? (
              <div className="toolbar">
                <SearchInput value={q} onChange={(v) => set({ q: v || null })} placeholder="Search sources" />
                <FilterButton label="Status" options={STATUS_FILTER} value={status} onChange={(v) => set({ status: v || null })} />
                <ClearFilters isActive={!!status} onClear={() => set({ status: null })} />
              </div>
            ) : null}
            {rows.length ? (
              <DataTable
                label="Sources"
                rows={rows}
                columns={columns}
                getRowId={(s) => s.name ?? ""}
                onRowAction={(s) => open(s)}
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
