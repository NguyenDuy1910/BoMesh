"use client";

import { ArrowLeft, ExternalLink, FileText, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { CellTitle, DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Tabs } from "@/components/ui/Tabs";
import { useToast } from "@/components/ui/Toast";
import { formatBytes, formatDateTime, formatRelative, pluralize, titleCase } from "@/modules/workspace-control/format";
import { ingestionActions, RUN_ITEMS_PAGE_SIZE, useRunDetail } from "@/modules/ingestion/queries";
import {
  describePhases,
  describeScope,
  elapsed,
  formatDuration,
  RUN_ITEM_STATUS,
  RUN_STATUS,
  runActor,
  runProgress,
  runStatus,
  TRIGGER_LABEL,
  type ScopeNames,
} from "@/modules/ingestion/run-state";
import { isRunActive, type IngestionRun, type IngestionRunItem } from "@/modules/ingestion/runs-api";

import { Pager } from "./Pager";

type ItemFilter = "all" | "failed";

/** Where a document opens in Knowledge. */
const documentHref = (id: string) => `/workspace-control/knowledge?document=${encodeURIComponent(id)}`;

/** What retrying would pick up: the documents this run did not finish. */
function unfinished(run: IngestionRun): number {
  return run.counts.failed + run.counts.skipped + run.counts.cancelled;
}

/**
 * One run: how far it got, which documents it touched, and the one thing to
 * do next — cancel it while it is working, retry what failed once it is not.
 *
 * Batches, models and phase timings are real but rarely needed, so they wait
 * under Technical details rather than crowding the documents.
 */
export function RunDetailView({
  runId,
  names,
  onBack,
  onOpenRun,
}: {
  runId: string;
  names: ScopeNames;
  onBack: () => void;
  /** A retry is a new run; the page moves to it. */
  onOpenRun: (id: string) => void;
}) {
  const { toast } = useToast();
  const [filter, setFilter] = useState<ItemFilter>("all");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState<"retry" | "cancel" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const detail = useRunDetail(runId, { page, status: filter === "failed" ? "failed" : undefined });
  const run = detail.run;

  const back = (
    <Button className="-ml-2.5 self-start" icon={<ArrowLeft size={16} />} onClick={onBack} size="sm" variant="ghost">
      Runs
    </Button>
  );

  if (!run) {
    return (
      <section aria-label="Run" className="ingestion-run">
        {back}
        {detail.error ? (
          <ErrorState
            description={detail.error}
            layout="inline"
            onAction={detail.refresh}
            title="This run couldn’t be loaded"
          />
        ) : (
          <PageLoadingSkeleton label="Loading run" />
        )}
      </section>
    );
  }

  const active = isRunActive(run);
  const progress = runProgress(run);
  const retryable = active ? 0 : unfinished(run);
  /** Something went wrong, rather than work being left undone by a cancel. */
  const alarming = run.status === "failed" || run.counts.failed > 0;
  const title = describeScope(run.scope, names);

  const act = async (kind: "retry" | "cancel") => {
    setBusy(kind);
    setActionError(null);
    try {
      if (kind === "retry") {
        const next = await ingestionActions.retryRun(run.id);
        toast({
          title: `Processing ${pluralize(next.counts.total, "document")} again`,
          variant: "success",
        });
        onOpenRun(next.id);
      } else {
        await ingestionActions.cancelRun(run.id);
        toast({ title: "Run cancelled", description: "Documents it had not reached stay pending." });
        detail.refresh();
      }
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : kind === "retry" ? "The run couldn’t be retried." : "The run couldn’t be cancelled.",
      );
    } finally {
      setBusy(null);
    }
  };

  const retryLabel = run.counts.failed > 0 ? "Retry failed" : "Process the rest";
  const counts = [
    { label: "Ready", value: run.counts.succeeded },
    { label: "Failed", value: run.counts.failed },
    { label: "Processing", value: run.counts.running },
    { label: "Waiting", value: run.counts.queued },
    { label: "Skipped", value: run.counts.skipped },
    { label: "Cancelled", value: run.counts.cancelled },
  ].filter((entry) => entry.value > 0);

  const columns: Column<IngestionRunItem>[] = [
    {
      key: "name",
      label: "Document",
      primary: true,
      render: (item) => (
        <CellTitle
          icon={<FileText aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" size={16} />}
          subtitle={item.error
            ? <span className="ingestion-problem">{item.error}</span>
            : item.status === "running" && item.phase
              ? `${titleCase(item.phase)}…`
              : undefined}
          title={item.name}
        />
      ),
    },
    {
      key: "status",
      label: "Status",
      width: 150,
      render: (item) => <StatusBadge status={item.status} vocabulary={RUN_ITEM_STATUS} />,
    },
    {
      key: "time",
      label: "Took",
      align: "right",
      width: 110,
      priority: "medium",
      render: (item) => {
        const span = elapsed(item.started_at, item.finished_at);
        return span === null ? "—" : formatDuration(span);
      },
    },
  ];

  const startedFor = elapsed(run.started_at, run.finished_at);
  const configuration = Object.entries(run.configuration);
  const phased = detail.items.filter((item) => item.phases.length > 0);

  return (
    <section aria-label={title} className="ingestion-run">
      <div className="knowledge-detail-intro">
        {back}
        <header className="ingestion-run__header">
          <div className="min-w-0 flex-1">
            <h2>{title}</h2>
            <p>
              {run.created_by ? `Started by ${runActor(run)}` : TRIGGER_LABEL[run.trigger]}
              {" · "}
              <span title={formatDateTime(run.created_at)}>{formatRelative(run.created_at)}</span>
            </p>
          </div>
          <StatusBadge status={runStatus(run)} vocabulary={RUN_STATUS} />
          {active && (
            <Button loading={busy === "cancel"} onClick={() => void act("cancel")} variant="secondary">
              Cancel
            </Button>
          )}
        </header>
      </div>

      {actionError && (
        <ErrorState actionLabel="Dismiss" description={actionError} layout="inline" onAction={() => setActionError(null)} />
      )}

      {retryable > 0 && (
        <div
          className="knowledge-notice"
          data-tone={alarming ? undefined : "neutral"}
          role={alarming ? "alert" : "status"}
        >
          <TriangleAlert aria-hidden="true" size={16} />
          <div>
            <strong>
              {run.status === "failed"
                ? "Processing stopped before it finished"
                : run.counts.failed > 0
                  ? `${pluralize(run.counts.failed, "document")} could not be processed`
                  : `${pluralize(retryable, "document was", "documents were")} not processed`}
            </strong>
            <p>
              {run.error
                ?? (run.counts.failed > 0
                  ? "Each one shows why below. Retrying processes them again in a new run."
                  : "The run was cancelled before it reached them.")}
            </p>
          </div>
          <Button loading={busy === "retry"} onClick={() => void act("retry")}>
            {retryLabel}
          </Button>
        </div>
      )}

      <section aria-label="Progress" className="ingestion-progress">
        <p>
          <strong>{progress.done.toLocaleString()} of {pluralize(progress.total, "document")}</strong>
          <span>{progress.percent}%</span>
        </p>
        <div
          aria-label="Processed"
          aria-valuemax={progress.total}
          aria-valuemin={0}
          aria-valuenow={progress.done}
          className="ingestion-progress__track"
          role="progressbar"
        >
          <i style={{ width: `${run.counts.total ? (run.counts.succeeded / run.counts.total) * 100 : 0}%` }} />
          <i data-tone="danger" style={{ width: `${run.counts.total ? (run.counts.failed / run.counts.total) * 100 : 0}%` }} />
        </div>
        {counts.length > 0 && (
          <ul className="ingestion-progress__counts">
            {counts.map((entry) => (
              <li key={entry.label}><strong>{entry.value.toLocaleString()}</strong> {entry.label}</li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="run-documents-heading">
        <div className="ingestion-run__items-head">
          <h3 className="knowledge-eyebrow" id="run-documents-heading">Documents</h3>
          <Tabs
            activeTab={filter}
            ariaLabel="Show documents"
            density="compact"
            onChange={(value) => { setFilter(value as ItemFilter); setPage(1); }}
            tabs={[
              { id: "all", label: "All", count: run.counts.total },
              { id: "failed", label: "Failed", count: run.counts.failed },
            ]}
          />
        </div>
        <DataTable
          ariaLabel="Documents in this run"
          columns={columns}
          data={detail.items}
          emptyState={(
            <EmptyState
              description={filter === "failed" ? "Every document so far was processed or is still on its way." : undefined}
              size="sm"
              title={filter === "failed" ? "Nothing failed" : "No documents to show"}
            />
          )}
          getRowId={(item) => item.document_id}
          rowActions={(item) => (
            <Link className="ingestion-link" href={documentHref(item.document_id)}>
              View document
            </Link>
          )}
        />
        <Pager noun="documents" onChange={setPage} page={page} pageSize={RUN_ITEMS_PAGE_SIZE} total={detail.itemTotal} />
      </section>

      <details className="ingestion-technical">
        <summary>Technical details</summary>
        <dl className="knowledge-kv">
          <div><dt>Run</dt><dd><code>{run.id}</code></dd></div>
          <div><dt>Trigger</dt><dd>{TRIGGER_LABEL[run.trigger]}</dd></div>
          <div>
            <dt>Created by</dt>
            <dd>{run.created_by ? [run.created_by.display_name, run.created_by.email].filter(Boolean).join(" · ") : "—"}</dd>
          </div>
          {run.scope.retry_of_run_id && (
            <div>
              <dt>Retry of</dt>
              <dd>
                <button className="ingestion-link" onClick={() => onOpenRun(run.scope.retry_of_run_id!)} type="button">
                  Previous run <ExternalLink aria-hidden="true" size={12} />
                </button>
              </dd>
            </div>
          )}
          <div><dt>Created</dt><dd>{formatDateTime(run.created_at)}</dd></div>
          <div><dt>Started</dt><dd>{formatDateTime(run.started_at, "Not yet")}</dd></div>
          <div><dt>Finished</dt><dd>{formatDateTime(run.finished_at, active ? "Still running" : "—")}</dd></div>
          {startedFor !== null && <div><dt>Duration</dt><dd>{formatDuration(startedFor)}</dd></div>}
          {configuration.map(([key, value]) => (
            <div key={key}>
              <dt>{titleCase(key)}</dt>
              <dd>
                {typeof value === "number" && key.endsWith("_bytes")
                  ? formatBytes(value)
                  : typeof value === "object" ? JSON.stringify(value) : String(value)}
              </dd>
            </div>
          ))}
        </dl>
        {phased.length > 0 && (
          <>
            <h4 className="knowledge-eyebrow">Phases by document</h4>
            <ul className="ingestion-technical__phases">
              {phased.map((item) => (
                <li key={item.document_id}>
                  <strong>{item.name}</strong>
                  <span>
                    {[describePhases(item.phases), item.chunk_count === null ? null : pluralize(item.chunk_count, "chunk")]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </details>
    </section>
  );
}
