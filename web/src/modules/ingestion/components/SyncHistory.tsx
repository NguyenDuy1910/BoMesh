"use client";

import { History } from "lucide-react";
import { useState } from "react";

import { Avatar } from "@/components/ui/Avatar";
import { CellTitle, DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { ClearFilters, FilterChip } from "@/components/ui/FilterChip";
import { Progress } from "@/components/ui/Progress";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Toolbar } from "@/components/ui/Toolbar";
import { runStatusKey } from "@/lib/status";
import { sourceName } from "@/modules/ingestion/connection-state";
import { RUNS_PAGE_SIZE, useRunList } from "@/modules/ingestion/queries";
import { describeScope, elapsed, formatDuration, runActor, runProgress } from "@/modules/ingestion/run-state";
import { isRunActive, type IngestionRun, type IngestionRunStatus } from "@/modules/ingestion/runs-api";
import { formatDateTime } from "@/lib/format";

import { AppIcon } from "./AppIcon";
import type { SourcesModel } from "./SourcesScreen";

const RESULT_FILTERS: { value: IngestionRunStatus; label: string }[] = [
  { value: "running", label: "In progress" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

/** What a sync did to its documents: progress while it runs, counts once it has finished. */
export function RunDocuments({ run }: { run: IngestionRun }) {
  const { done, total, percent } = runProgress(run);
  if (isRunActive(run)) {
    return (
      <span className="inline-flex items-center gap-2 text-caption text-text-tertiary">
        <Progress className="w-[72px]" label="Sync progress" value={total ? percent : undefined} />
        <span className="whitespace-nowrap tabular-nums">
          {total ? `${done.toLocaleString()} of ${total.toLocaleString()}` : "Starting"}
        </span>
      </span>
    );
  }
  if (!total) return <span className="text-text-tertiary">—</span>;
  const skipped = run.counts.skipped + run.counts.cancelled;
  return (
    <span className="tabular-nums">
      {run.counts.succeeded.toLocaleString()} processed
      {run.counts.failed > 0 && <span className="text-status-danger"> · {run.counts.failed.toLocaleString()} failed</span>}
      {skipped > 0 && <span className="text-text-tertiary"> · {skipped.toLocaleString()} skipped</span>}
    </span>
  );
}

/** The run's source, or what it processed when no source started it (an upload, a reprocess). */
export function runSubject(model: SourcesModel, run: IngestionRun) {
  const source = run.scope.source_id ? model.data?.sources.find((item) => item.id === run.scope.source_id) : undefined;
  const connection = source ? model.connection(source.connection_id) : undefined;
  const kbId = source?.collection_id ?? run.scope.collection_id;
  return {
    source,
    title: source
      ? sourceName(source)
      : run.scope.source_id
        ? "Disconnected source"
        : describeScope(run.scope, {
            collection: (id) => model.knowledgeBase(id)?.title,
            source: (id) => model.data?.sources.find((item) => item.id === id)?.display_name ?? undefined,
          }),
    knowledgeBase: kbId ? model.knowledgeBase(kbId)?.title : undefined,
    connectorKey: connection?.connector_key ?? null,
  };
}

/** The Sync history tab: every sync, newest first, filterable by source and result. */
export function SyncHistory({
  model,
  sourceId,
  onSourceChange,
  activeRunId,
}: {
  model: SourcesModel;
  sourceId: string | null;
  onSourceChange: (sourceId: string | null) => void;
  activeRunId: string | null;
}) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<IngestionRunStatus | "">("");
  const list = useRunList({ page, status: status || undefined, sourceId: sourceId ?? undefined });
  const filtered = Boolean(sourceId || status);

  const sourceOptions = (model.data?.sources ?? []).map((source) => ({ value: source.id, label: sourceName(source) }));
  if (sourceId && !sourceOptions.some((option) => option.value === sourceId)) {
    sourceOptions.push({ value: sourceId, label: "Disconnected source" });
  }

  const columns: DataTableColumn<IngestionRun>[] = [
    {
      id: "started",
      header: "Started",
      cell: (run) => <span className="whitespace-nowrap tabular-nums">{formatDateTime(run.started_at ?? run.created_at)}</span>,
    },
    {
      id: "source",
      header: "Source",
      minWidth: 200,
      cell: (run) => {
        const about = runSubject(model, run);
        return (
          <CellTitle
            icon={<AppIcon connector={about.connectorKey ?? "upload"} fallback="upload" size="sm" />}
            subtitle={about.knowledgeBase}
            title={about.title}
          />
        );
      },
    },
    {
      id: "result",
      header: "Result",
      cell: (run) => <StatusBadge kind="run" value={runStatusKey(run)} />,
    },
    {
      id: "documents",
      header: "Documents",
      cell: (run) => <RunDocuments run={run} />,
    },
    {
      id: "duration",
      header: "Duration",
      hideBelow: 900,
      cell: (run) => {
        const span = elapsed(run.started_at, run.finished_at);
        return <span className="tabular-nums text-text-secondary">{span === null ? "—" : formatDuration(span)}</span>;
      },
    },
    {
      id: "by",
      header: "Started by",
      hideBelow: 1080,
      cell: (run) => {
        const actor = runActor(run);
        return run.created_by ? (
          <span className="inline-flex min-w-0 items-center gap-2">
            <Avatar name={actor} size="xs" />
            <span className="truncate">{actor}</span>
          </span>
        ) : (
          <span className="text-text-tertiary">{actor}</span>
        );
      },
    },
  ];

  return (
    <>
      <Toolbar
        filters={
          <>
            <FilterChip
              label="Source"
              onChange={(value) => {
                setPage(1);
                onSourceChange(value || null);
              }}
              options={sourceOptions}
              value={sourceId ?? ""}
            />
            <FilterChip
              label="Result"
              onChange={(value) => {
                setPage(1);
                setStatus(value as IngestionRunStatus | "");
              }}
              options={RESULT_FILTERS}
              value={status}
            />
            <ClearFilters
              active={filtered}
              onClear={() => {
                setPage(1);
                setStatus("");
                onSourceChange(null);
              }}
            />
          </>
        }
      />
      <DataTable
        activeRowId={activeRunId}
        ariaLabel="Sync history"
        columns={columns}
        data={list.runs}
        emptyState={
          <EmptyState
            boxed
            description="Syncs appear here when a source updates or someone uploads files."
            icon={<History />}
            title="No syncs yet"
          />
        }
        error={list.loaded ? null : list.error}
        filtered={filtered}
        loading={!list.loaded && !list.error}
        onClearFilters={() => {
          setPage(1);
          setStatus("");
          onSourceChange(null);
        }}
        onRetry={list.refresh}
        onRowClick={(run) => model.open.run(run.id)}
        pagination={{ page, pageSize: RUNS_PAGE_SIZE, total: list.total, onPageChange: setPage }}
      />
    </>
  );
}
