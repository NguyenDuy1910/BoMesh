"use client";

import { Layers } from "lucide-react";
import { useState } from "react";

import { CommandBar, FilterTrigger } from "@/components/layout/CommandBar";
import { CellTitle, DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatDateTime, formatRelative, pluralize } from "@/modules/workspace-control/format";
import { RUNS_PAGE_SIZE, useRunList } from "@/modules/ingestion/queries";
import {
  describeScope,
  RUN_STATUS,
  runActor,
  runProgress,
  runStatus,
  type ScopeNames,
} from "@/modules/ingestion/run-state";
import { isRunActive, type IngestionRun, type IngestionRunStatus } from "@/modules/ingestion/runs-api";

import { Pager } from "./Pager";

const STATUS_FILTERS: readonly { value: "" | IngestionRunStatus; label: string }[] = [
  { value: "", label: "All runs" },
  { value: "running", label: "Processing" },
  { value: "queued", label: "Queued" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

/** What went wrong in a run, in one line, or nothing when nothing did. */
function problemLine(run: IngestionRun): string | null {
  if (run.error) return run.error;
  const { failed } = run.counts;
  if (!failed) return null;
  return isRunActive(run)
    ? `${failed.toLocaleString()} failed so far`
    : `${pluralize(failed, "document")} could not be processed`;
}

/**
 * Every processing run, newest first.
 *
 * A row answers what was processed, whether it worked and how far it got;
 * opening it shows the documents. Nothing here speaks of batches or workers:
 * those live behind the run's technical details.
 */
export function RunsView({
  names,
  onOpenRun,
}: {
  names: ScopeNames;
  onOpenRun: (id: string) => void;
}) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<"" | IngestionRunStatus>("");
  const list = useRunList({ page, status: status || undefined });

  const columns: Column<IngestionRun>[] = [
    {
      key: "scope",
      label: "Processed",
      primary: true,
      render: (run) => {
        const problem = problemLine(run);
        return (
          <CellTitle
            subtitle={problem ? <span className="ingestion-problem">{problem}</span> : undefined}
            title={describeScope(run.scope, names)}
          />
        );
      },
    },
    {
      key: "status",
      label: "Status",
      width: 190,
      render: (run) => <StatusBadge status={runStatus(run)} vocabulary={RUN_STATUS} />,
    },
    {
      key: "progress",
      label: "Progress",
      align: "right",
      width: 120,
      render: (run) => {
        const { done, total } = runProgress(run);
        return `${done.toLocaleString()} / ${total.toLocaleString()}`;
      },
    },
    {
      key: "when",
      label: "Started",
      width: 130,
      priority: "medium",
      render: (run) => <span title={formatDateTime(run.created_at)}>{formatRelative(run.created_at)}</span>,
    },
    {
      key: "who",
      label: "By",
      width: 180,
      priority: "low",
      render: (run) => <span className="block truncate">{runActor(run)}</span>,
    },
  ];

  if (list.error && !list.loaded) {
    return (
      <ErrorState
        className="mt-[var(--space-4)]"
        description={list.error}
        layout="inline"
        onAction={list.refresh}
        title="Runs couldn’t be loaded"
      />
    );
  }
  if (!list.loaded) return <PageLoadingSkeleton className="pt-[var(--space-4)]" controls label="Loading runs" />;

  return (
    <>
      <CommandBar
        count={pluralize(list.total, "run")}
        filters={(
          <FilterTrigger
            label="Show runs"
            onChange={(value) => { setStatus(value as "" | IngestionRunStatus); setPage(1); }}
            options={STATUS_FILTERS}
            value={status}
          />
        )}
      />
      {list.error && (
        <ErrorState className="mb-[var(--space-3)]" description={list.error} layout="inline" onAction={list.refresh} />
      )}
      <DataTable
        ariaLabel="Processing runs"
        columns={columns}
        data={list.runs}
        emptyState={(
          <EmptyState
            description={status
              ? "No run matches this filter."
              : "Documents you add wait as Pending until a run processes them. Start one with New run."}
            icon={<Layers size={20} />}
            size="sm"
            title={status ? "No matching runs" : "No runs yet"}
          />
        )}
        onRowClick={(run) => onOpenRun(run.id)}
      />
      <Pager noun="runs" onChange={setPage} page={page} pageSize={RUNS_PAGE_SIZE} total={list.total} />
    </>
  );
}
