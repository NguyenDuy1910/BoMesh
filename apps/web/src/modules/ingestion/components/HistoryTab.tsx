"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { History } from "lucide-react";
import { useMemo } from "react";

import { ClearFilters, DataTable, EmptyState, FilterButton, Gate, NoMatches, Pager, paginate, SkeletonRows, StatusChip, type DataTableColumn } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { fmtDateTime, fmtDuration } from "@/lib/format";
import type { Item } from "@/modules/knowledge/bases/model";

import { sourceOfSync, type Connection, type Source, type Sync } from "../api";
import { RUN_STATUS_OPTIONS, sourceName, syncDeltaText, syncDuration, syncStatus, syncTotals, TRIGGER_LABEL } from "../model";
import { SourceAppIcon, SyncProgress, useParamState } from "./shared";

const PAGE_SIZE = 10;

/** Sync history (preview `tabHistory`): every source's syncs, filtered by source and status, 10 per page. */
export function HistoryTab({
  syncs,
  sources,
  connections,
  bases,
  onOpen,
}: {
  syncs: UseQueryResult<Sync[]>;
  sources: readonly Source[];
  connections: ReadonlyMap<string, Connection>;
  bases: ReadonlyMap<string, Item>;
  onOpen: (sync: Sync) => void;
}) {
  const { params, set } = useParamState();
  const sourceFilter = params.get("source") ?? "";
  const status = params.get("status") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const byId = useMemo(() => new Map(sources.map((s) => [resourceId(s.name), s] as const)), [sources]);

  const columns = useMemo<DataTableColumn<Sync>[]>(
    () => [
      {
        id: "source",
        header: "Source",
        primary: true,
        cell: (sync) => {
          const source = byId.get(resourceId(sourceOfSync(sync)));
          return (
            <div className="row gap-12">
              <SourceAppIcon source={source} connections={connections} />
              <div className="stack src-min">
                <span className="cell-title truncate" translate="no">
                  {source ? sourceName(source) : "Removed source"}
                </span>
                <span className="cell-sub truncate" translate="no">
                  {source ? (bases.get(source.targetCollection)?.displayName ?? "") : ""}
                </span>
              </div>
            </div>
          );
        },
      },
      {
        id: "trigger",
        header: "Trigger",
        hideOnMobile: true,
        cell: (sync) => (sync.trigger ? TRIGGER_LABEL[sync.trigger] : "—"),
      },
      { id: "started", header: "Started", className: "num", cell: (sync) => fmtDateTime(sync.startTime) },
      {
        id: "duration",
        header: "Duration",
        hideOnMobile: true,
        className: "num muted",
        cell: (sync) => {
          const ms = syncDuration(sync);
          return ms ? fmtDuration(ms) : "—";
        },
      },
      {
        id: "documents",
        header: "Documents",
        cell: (sync) => {
          if (sync.state === "RUNNING") {
            const t = syncTotals(sync);
            return <SyncProgress value={null} label={`${t.added + t.updated} so far`} />;
          }
          return <span className={sync.failedCount ? "text-warning" : undefined}>{syncDeltaText(sync)}</span>;
        },
      },
      { id: "status", header: "Status", cell: (sync) => <StatusChip kind="run" value={syncStatus(sync)} /> },
    ],
    [byId, connections, bases],
  );

  const none = <EmptyState icon={History} title="No syncs yet" description="Syncs appear here once a source runs." boxed />;

  return (
    <Gate query={syncs} skeleton={<SkeletonRows rows={6} />} isEmpty={(d) => d.length === 0} empty={none}>
      {(all) => {
        const sourceOptions = [...new Set(all.map((s) => resourceId(sourceOfSync(s))))].map((id) => {
          const source = byId.get(id);
          return { value: id, label: source ? sourceName(source) : "Removed source" };
        });
        const rows = all.filter((s) => (!sourceFilter || resourceId(sourceOfSync(s)) === sourceFilter) && (!status || syncStatus(s) === status));
        return (
          <>
            <div className="toolbar">
              <FilterButton label="Source" options={sourceOptions} value={sourceFilter} onChange={(v) => set({ source: v || null, page: null })} />
              <FilterButton label="Status" options={RUN_STATUS_OPTIONS} value={status} onChange={(v) => set({ status: v || null, page: null })} />
              <ClearFilters isActive={!!(sourceFilter || status)} onClear={() => set({ source: null, status: null, page: null })} />
            </div>
            {rows.length ? (
              <DataTable
                label="Sync history"
                rows={paginate(rows, page, PAGE_SIZE)}
                columns={columns}
                getRowId={(s) => s.name ?? ""}
                onRowAction={onOpen}
                footer={<Pager page={page} pageSize={PAGE_SIZE} total={rows.length} onPageChange={(p) => set({ page: p > 1 ? String(p) : null })} />}
              />
            ) : (
              <NoMatches what="syncs" onClear={() => set({ source: null, status: null, page: null })} />
            )}
          </>
        );
      }}
    </Gate>
  );
}
