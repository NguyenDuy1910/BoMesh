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
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";

import { useSourceActions, type SourceActions } from "../actions";
import type { Connection, Source, Sync } from "../api";
import { accountLabel, appName, canTogglePause, lastSyncText, rowActionKind, scopeText, sourceName, sourceStatus, syncedWithIssues } from "../model";
import { openReconnect, openWizard } from "../overlays";
import { useConnections, useRunningSyncs, useSources } from "../queries";
import { scheduleText } from "../schedule";
import { AccountsView } from "./AccountsView";
import { AddSourceButton } from "./AddSourceButton";
import { HistoryTab } from "./HistoryTab";
import { CollectionLink, PolicyNote, SourceAppIcon, SourceStatusChip, SyncingCell, useCollectionIndex, useParamState, useSyncIndex } from "./shared";
import { SourceOverlays, syncParam } from "./SourceOverlays";

/** Sources' views (`?view=`), named by `m.studio.sourceViews[view]`. */
const VIEWS = ["sources", "history", "accounts"] as const;
type View = (typeof VIEWS)[number];

/**
 * Knowledge Studio → Sources (preview `X.src.tab`): everything that brings documents in — the sources, their
 * sync history and the accounts they sign in with — switched with one segmented control (`?view=`). No alert
 * banners: each row's one visible action is its fix. URL: `?view=history&source=&status=&page=`,
 * `?q=&status=` (sources), `?open=<source id>&focus=schedule`, `?sync=<source id>.<sync id>`,
 * `?reconnect=<connection id>`, `?connect=1&kb=<collection id>`.
 */
export function SourcesSection() {
  const { can, name: workspaceName, workspace } = useWorkspace();
  const m = useMessages();
  const { params, set } = useParamState();
  const asked = params.get("view");
  const view: View = asked === "history" || asked === "accounts" ? asked : "sources";
  const sources = useSources();
  const connections = useConnections();
  const running = useRunningSyncs();
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

  // Like Documents' views, a view counts only what needs someone (preview `sourcesTabBody`): expired accounts.
  const expired = (connections.data ?? []).filter((c) => c.state === "REAUTHORIZATION_REQUIRED").length;
  const counts: Record<View, string> = { sources: "", history: "", accounts: expired ? `${fmtNum(expired)} hết hạn` : "" };

  return (
    <>
      <PageHeader
        title={m.nav.sources}
        chips={workspace.demo ? <PreviewChip label="Dữ liệu mẫu" tooltip="Không gian làm việc này chứa nội dung minh họa hư cấu." /> : null}
        actions={<AddSourceButton />}
      />
      <div className="src-views">
        <Segmented
          label={m.studio.sourceViews.label}
          value={view}
          options={VIEWS.map((value) => {
            const label = m.studio.sourceViews[value];
            return { value, label: counts[value] ? `${label} · ${counts[value]}` : label };
          })}
          // Each view keeps its own filters; switching starts clean.
          onChange={(v) => set({ view: v === "sources" ? null : v, q: null, status: null, source: null, page: null })}
        />
      </div>
      {view === "history" ? (
        <HistoryTab sources={sources.data ?? []} connections={connections.byName} collections={collections.byName} onOpen={(sync: Sync) => set({ open: null, sync: syncParam(sync) })} />
      ) : view === "accounts" ? (
        <AccountsView />
      ) : (
        <SourcesView query={sources} syncs={running.data} connections={connections.byName} actions={actions} manage={manage} />
      )}
      <SourceOverlays />
    </>
  );
}

const STATUS_FILTER = [
  { value: "healthy", label: "Mới nhất" },
  { value: "partial", label: "Đồng bộ có lỗi" },
  { value: "syncing", label: "Đang đồng bộ" },
  { value: "attention", label: "Cần chú ý" },
  { value: "paused", label: "Đã tạm dừng" },
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

  const empty = <EmptyState icon={Plug} title="Chưa có nguồn dữ liệu" description="Giữ một kho tài liệu đồng bộ với Google Drive hoặc Confluence." boxed actions={<AddSourceButton />} />;

  const columns = useMemo<DataTableColumn<Source>[]>(
    () => [
      {
        id: "name",
        header: "Nguồn",
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
                {connections.get(s.connection) ? scopeText(s) : "Chưa có tài khoản"}
              </span>
            </div>
          </div>
        ),
      },
      {
        id: "collection",
        header: "Kho tài liệu",
        cell: (s) => (
          <div className="stack src-min src-kbcell">
            <CollectionLink name={s.targetCollection} label={collections.byName.get(s.targetCollection)?.displayName} />
            <PolicyNote source={s} />
          </div>
        ),
      },
      {
        id: "schedule",
        header: "Lịch",
        hideOnMobile: true,
        className: "src-when",
        cell: (s) => <span className={s.state === "PAUSED" ? "muted" : undefined}>{scheduleText(s.schedule)}</span>,
      },
      {
        id: "last",
        header: "Lần đồng bộ gần nhất",
        hideOnMobile: true,
        sortValue: (s) => (s.lastSync?.endTime ? Date.parse(s.lastSync.endTime) : 0),
        cell: (s) =>
          s.lastSync && s.lastSync.state !== "RUNNING" ? (
            <div className="stack src-when">
              <span>{rel(s.lastSync.endTime)}</span>
              <span className={`cell-sub ${s.lastSync.state === "FAILED" ? "text-danger" : s.lastSync.failedCount ? "text-warning" : ""}`}>{lastSyncText(s)}</span>
            </div>
          ) : s.lastSync ? (
            <span className="muted">Đang đồng bộ</span>
          ) : (
            <span className="muted">Chưa bao giờ</span>
          ),
      },
      {
        id: "status",
        header: "Trạng thái",
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
            Kết nối lại
          </Button>
        );
      case "retry":
        return (
          <Button size="sm" variant="secondary" onPress={() => void actions.syncNow(s)}>
            <RefreshCw className="i" aria-hidden />
            Thử lại
          </Button>
        );
      case "resume":
        return (
          <Button size="sm" variant="secondary" isDisabled={!canTogglePause(s)} onPress={() => void actions.togglePause(s)}>
            <Play className="i" aria-hidden />
            Tiếp tục
          </Button>
        );
      case "process":
        return (
          <Button size="sm" variant="secondary" onPress={() => void actions.process(s)}>
            <Play className="i" aria-hidden />
            {`Xử lý ${fmtNum(s.pendingDocumentCount ?? 0)}`}
          </Button>
        );
      case "sync":
        return <IconButton icon={RefreshCw} tip="Đồng bộ ngay" size="sm" className="src-quiet" onPress={() => void actions.syncNow(s)} />;
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
    if (s.state === "REAUTHORIZATION_REQUIRED") items.push({ id: "reconnect", label: "Kết nối lại", icon: LogIn, onAction: () => openReconnect(s.connection) });
    else if (shown !== "sync") items.push({ id: "sync", label: "Đồng bộ ngay", icon: RefreshCw, isDisabled: syncing || paused, onAction: () => void actions.syncNow(s) });
    items.push({ id: "schedule", label: "Sửa lịch", icon: Clock, onAction: () => open(s, "schedule") });
    if (shown !== "resume")
      items.push({ id: "pause", label: paused ? "Tiếp tục" : "Tạm dừng", icon: paused ? Play : Pause, isDisabled: syncing || !canTogglePause(s), onAction: () => void actions.togglePause(s) });
    items.push(
      { id: "history", label: "Xem lịch sử đồng bộ", icon: History, onAction: () => set({ view: "history", source: resourceId(s.name), status: null, page: null, q: null }) },
      { id: "disconnect", label: "Ngắt kết nối", icon: Trash2, danger: true, onAction: () => void actions.disconnect(s, collections.byName.get(s.targetCollection)?.displayName) },
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
                <SearchInput value={q} onChange={(v) => set({ q: v || null })} placeholder="Tìm kiếm nguồn dữ liệu" />
                <FilterButton label="Trạng thái" options={STATUS_FILTER} value={status} onChange={(v) => set({ status: v || null })} />
                <ClearFilters isActive={!!status} onClear={() => set({ status: null })} />
              </div>
            ) : null}
            {rows.length ? (
              <DataTable
                label="Nguồn"
                rows={rows}
                columns={columns}
                getRowId={(s) => s.name ?? ""}
                onRowAction={(s) => open(s)}
                rowActions={manage ? rowMenu : undefined}
                rowActionLead={manage ? rowLead : undefined}
                actionsClassName="src-actions"
              />
            ) : (
              <NoMatches what="nguồn dữ liệu" onClear={() => set({ q: null, status: null })} />
            )}
          </>
        );
      }}
    </Gate>
  );
}
