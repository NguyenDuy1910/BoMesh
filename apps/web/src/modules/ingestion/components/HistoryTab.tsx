"use client";

import { History } from "lucide-react";
import { useMemo } from "react";

import { ClearFilters, DataTable, EmptyState, FilterButton, Gate, NoMatches, Pager, SkeletonRows, StatusChip, type DataTableColumn } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { fmtDateTime, fmtDuration } from "@/lib/format";
import type { Item } from "@/modules/knowledge/bases/model";

import { sourceOfSync, type Connection, type Source, type Sync } from "../api";
import { RUN_STATUS_OPTIONS, sourceName, syncDeltaText, syncDuration, syncStatus, syncTotals, TRIGGER_LABEL, type RunStatus } from "../model";
import { useSyncPages } from "../queries";
import { SourceAppIcon, SyncProgress, useParamState } from "./shared";

const PAGE_SIZE = 10;

/** The ListSyncs filter for each status (`syncStatus`). */
const STATUS_FILTER: Record<RunStatus, string> = {
  running: "state = RUNNING",
  failed: "state = FAILED",
  completed: "state = SUCCEEDED AND failedCount = 0",
  partial: "state = SUCCEEDED AND failedCount > 0",
};

/** Sync history (preview `tabHistory`): every source's syncs, filtered by source and status on the server, 10 per page. */
export function HistoryTab({
  sources,
  connections,
  collections,
  onOpen,
}: {
  sources: readonly Source[];
  connections: ReadonlyMap<string, Connection>;
  collections: ReadonlyMap<string, Item>;
  onOpen: (sync: Sync) => void;
}) {
  const { params, set } = useParamState();
  const sourceFilter = params.get("source") ?? "";
  const status = params.get("status") ?? "";
  const byId = useMemo(() => new Map(sources.map((s) => [resourceId(s.name), s] as const)), [sources]);
  const syncs = useSyncPages({ source: byId.get(sourceFilter)?.name, filter: STATUS_FILTER[status as RunStatus] }, PAGE_SIZE);

  const columns = useMemo<DataTableColumn<Sync>[]>(
    () => [
      {
        id: "source",
        header: "Nguồn",
        primary: true,
        cell: (sync) => {
          const source = byId.get(resourceId(sourceOfSync(sync)));
          return (
            <div className="row gap-12">
              <SourceAppIcon source={source} connections={connections} />
              <div className="stack src-min">
                <span className="cell-title truncate" translate="no">
                  {source ? sourceName(source) : "Đã gỡ nguồn dữ liệu"}
                </span>
                <span className="cell-sub truncate" translate="no">
                  {source ? (collections.get(source.targetCollection)?.displayName ?? "") : ""}
                </span>
              </div>
            </div>
          );
        },
      },
      {
        id: "trigger",
        header: "Kích hoạt",
        hideOnMobile: true,
        cell: (sync) => (sync.trigger ? TRIGGER_LABEL[sync.trigger] : "—"),
      },
      { id: "started", header: "Bắt đầu", className: "num", cell: (sync) => fmtDateTime(sync.startTime) },
      {
        id: "duration",
        header: "Thời lượng",
        hideOnMobile: true,
        className: "num muted",
        cell: (sync) => {
          const ms = syncDuration(sync);
          return ms ? fmtDuration(ms) : "—";
        },
      },
      {
        id: "documents",
        header: "Tài liệu",
        cell: (sync) => {
          if (sync.state === "RUNNING") {
            const t = syncTotals(sync);
            return <SyncProgress label={`${t.added + t.updated} cho đến nay`} />;
          }
          return <span className={sync.failedCount ? "text-warning" : undefined}>{syncDeltaText(sync)}</span>;
        },
      },
      { id: "status", header: "Trạng thái", cell: (sync) => <StatusChip kind="run" value={syncStatus(sync)} /> },
    ],
    [byId, connections, collections],
  );

  const none = <EmptyState icon={History} title="Chưa có lần đồng bộ nào" description="Các lần đồng bộ sẽ hiển thị ở đây khi nguồn dữ liệu chạy." boxed />;

  return (
    <Gate query={syncs} skeleton={<SkeletonRows rows={6} />} isEmpty={(d) => !sourceFilter && !status && !d.syncs?.length} empty={none}>
      {(data) => {
        const sourceOptions = sources.map((s) => ({ value: resourceId(s.name), label: sourceName(s) }));
        const rows = data.syncs ?? [];
        // Filters only once there are enough syncs to need them (or one is in use).
        const tools = syncs.hasNext || syncs.page > 1 || rows.length >= 7 || !!(sourceFilter || status);
        return (
          <>
            {tools ? (
              <div className="toolbar">
                {sourceOptions.length > 1 || sourceFilter ? (
                  <FilterButton label="Nguồn" options={sourceOptions} value={sourceFilter} onChange={(v) => set({ source: v || null, page: null })} />
                ) : null}
                <FilterButton label="Trạng thái" options={RUN_STATUS_OPTIONS} value={status} onChange={(v) => set({ status: v || null, page: null })} />
                <ClearFilters isActive={!!(sourceFilter || status)} onClear={() => set({ source: null, status: null, page: null })} />
              </div>
            ) : null}
            {rows.length ? (
              <DataTable
                label="Lịch sử đồng bộ"
                rows={rows}
                columns={columns}
                getRowId={(s) => s.name ?? ""}
                onRowAction={onOpen}
                footer={<Pager page={syncs.page} pageSize={PAGE_SIZE} total={syncs.total} pageCount={rows.length} hasNext={syncs.hasNext} onPageChange={syncs.setPage} />}
              />
            ) : (
              <NoMatches what="lần đồng bộ" onClear={() => set({ source: null, status: null, page: null })} />
            )}
          </>
        );
      }}
    </Gate>
  );
}
