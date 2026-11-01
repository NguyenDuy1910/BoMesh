"use client";

import { CircleCheck, CircleX, Clock, FileText, LoaderCircle, OctagonX, RotateCcw, Square } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Drawer, DrawerSection } from "@/components/ui/Drawer";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Progress } from "@/components/ui/Progress";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { runStatusKey } from "@/lib/status";
import { ingestionActions, useRunDetail } from "@/modules/ingestion/queries";
import {
  elapsed,
  formatDuration,
  retryableCount,
  runActor,
  runProgress,
  runSteps,
  type RunStepState,
} from "@/modules/ingestion/run-state";
import { isRunActive, type IngestionRun } from "@/modules/ingestion/runs-api";
import { errorMessage, formatDateTime, pluralize } from "@/lib/format";

import { AppIcon } from "./AppIcon";
import type { SourcesModel } from "./SourcesScreen";
import { runSubject } from "./SyncHistory";

const STEP_ICON: Record<RunStepState, React.ReactNode> = {
  done: <CircleCheck className="text-status-success" />,
  active: <LoaderCircle className="text-accent-primary motion-safe:animate-spin" />,
  pending: <Clock className="text-text-tertiary" />,
  failed: <CircleX className="text-status-danger" />,
  stopped: <OctagonX className="text-text-tertiary" />,
};

const STEP_WORD: Record<RunStepState, string> = {
  done: "Done",
  active: "In progress",
  pending: "Not started",
  failed: "Failed",
  stopped: "Stopped",
};

/** One sync (`?run=<id>`): how far it got, what it counted, and the documents it couldn't process. */
export function SyncDetailDrawer({
  runId,
  model,
  onClose,
}: {
  runId: string | null;
  model: SourcesModel;
  onClose: () => void;
}) {
  const detail = useRunDetail(runId);
  const toast = useToast();
  const [retrying, setRetrying] = useState(false);

  if (!runId) return null;
  const run = detail.run;

  if (!run) {
    return (
      <Drawer onClose={onClose} open title={detail.error ? "Sync not found" : "Loading sync"}>
        {detail.error ? (
          <ErrorState description={detail.error} onAction={detail.refresh} title="This sync didn’t load" />
        ) : (
          <div aria-busy="true" className="grid gap-3">
            <span className="sr-only">Loading</span>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        )}
      </Drawer>
    );
  }

  const about = runSubject(model, run);
  const source = about.source;
  const connection = source ? model.connection(source.connection_id) : undefined;
  const active = isRunActive(run);
  const progress = runProgress(run);
  const retryable = active ? 0 : retryableCount(run);
  const span = elapsed(run.started_at, run.finished_at);
  const who =
    run.trigger === "scheduled" ? "Scheduled" : run.created_by ? `Started by ${runActor(run)}` : "Started through the API";
  const canRetry = retryable > 0 && (model.canRetry || (source ? model.canManageSource(source) : false));
  const sourceKey = source ? model.status(source) : null;

  const retry = async () => {
    if (source && sourceKey === "reconnect") {
      model.open.reconnect(source.connection_id);
      return;
    }
    setRetrying(true);
    try {
      const next = await ingestionActions.retryRun(run.id);
      toast.show({ tone: "info", message: `Retrying ${pluralize(next.counts.total || retryable, "document")}…` });
      model.open.run(next.id);
    } catch (cause) {
      toast.show({ tone: "err", message: errorMessage(cause, "The retry") });
    } finally {
      setRetrying(false);
    }
  };

  const footer =
    canRetry ? (
      <>
        {source && (
          <Button onClick={() => model.open.source(source.id)} variant="secondary">
            Open source
          </Button>
        )}
        <Button icon={<RotateCcw />} loading={retrying} onClick={() => void retry()}>
          {run.counts.failed > 0 ? "Retry failed documents" : "Retry unfinished documents"}
        </Button>
      </>
    ) : source ? (
      <Button onClick={() => model.open.source(source.id)} variant="secondary">
        Open source
      </Button>
    ) : undefined;

  return (
    <Drawer
      description={`${formatDateTime(run.started_at ?? run.created_at)} · ${who}`}
      footer={footer}
      header={<StatusBadge className="mt-2" kind="run" value={runStatusKey(run)} />}
      icon={<AppIcon connector={about.connectorKey ?? "upload"} fallback="upload" />}
      onClose={onClose}
      open
      title={source ? `Sync of ${about.title}` : about.title}
    >
      {run.status === "failed" && (
        <Callout
          actions={
            sourceKey === "reconnect" && source && model.canManageSource(source) && (
              <Button onClick={() => model.open.reconnect(source.connection_id)} size="sm">
                Reconnect
              </Button>
            )
          }
          className="mb-6"
          title="This sync stopped"
          tone="err"
        >
          {run.error || "Processing could not continue."}
          {sourceKey === "reconnect" && ` Reconnect ${connection ? model.connectorName(connection.connector_key) : "the account"} to resume syncing.`}
        </Callout>
      )}
      {active && (
        <div className="mb-6 grid gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-medium">
              {progress.total
                ? `${progress.done.toLocaleString()} of ${pluralize(progress.total, "document")}`
                : "Starting"}
            </span>
            {span !== null && <span className="tabular-nums text-text-tertiary">{formatDuration(span)}</span>}
          </div>
          <Progress label="Sync progress" value={progress.total ? progress.percent : undefined} />
          {model.canCancelRun(run) && (
            <div>
              <Button
                icon={<Square />}
                onClick={() => model.act.cancelRun(run, source ? about.title : "This sync")}
                size="sm"
                variant="secondary"
              >
                Stop sync
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="mb-6 grid grid-cols-3 gap-2.5">
        <CountTile label="Processed" value={run.counts.succeeded} />
        <CountTile danger label="Failed" value={run.counts.failed} />
        <CountTile label="Skipped" value={run.counts.skipped + run.counts.cancelled} />
      </div>

      <DrawerSection
        actions={!active && span !== null && <span className="text-meta tabular-nums text-text-tertiary">{formatDuration(span)}</span>}
        title="Steps"
      >
        <RunTimeline run={run} />
      </DrawerSection>

      {run.counts.failed > 0 && (
        <DrawerSection title="Couldn’t process">
          {detail.failedItems.length ? (
            <ul className="overflow-hidden rounded-lg border border-border-subtle">
              {detail.failedItems.map((item) => (
                <li className="flex items-start gap-3 border-b border-border-subtle px-3.5 py-2.5 last:border-b-0" key={item.document_id}>
                  <FileText aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-text-tertiary" />
                  <span className="min-w-0 flex-1">
                    <Link
                      className="block truncate rounded-xs font-medium text-text-primary hover:text-text-accent focus-visible:shadow-(--shadow-focus) focus-visible:outline-none"
                      href={`/documents/${item.document_id}`}
                    >
                      {item.name}
                    </Link>
                    <span className="block text-meta text-text-secondary">{item.error || "This file couldn’t be read."}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              description="The documents that failed are in knowledge bases you can’t open."
              size="sm"
              title="Nothing to show here"
            />
          )}
          {detail.failedTotal > detail.failedItems.length && (
            <p className="mt-2 text-meta text-text-tertiary">
              Showing {detail.failedItems.length.toLocaleString()} of {detail.failedTotal.toLocaleString()}.
            </p>
          )}
        </DrawerSection>
      )}
    </Drawer>
  );
}

function CountTile({ label, value, danger = false }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="rounded-lg border border-border-subtle px-3.5 py-2.5">
      <div className={cn("text-xl font-semibold tabular-nums tracking-[-0.01em]", danger && value > 0 && "text-status-danger")}>
        {value.toLocaleString()}
      </div>
      <div className="text-meta text-text-tertiary">{label}</div>
    </div>
  );
}

function RunTimeline({ run }: { run: IngestionRun }) {
  const steps = runSteps(run);
  return (
    <ol className="grid">
      {steps.map((step, index) => (
        <li className="relative flex items-start gap-3 pb-4 last:pb-0" key={step.label}>
          {index < steps.length - 1 && (
            <span aria-hidden="true" className="absolute bottom-1 left-[9px] top-6 w-px bg-border-subtle" />
          )}
          <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center [&_svg]:size-4">
            {STEP_ICON[step.state]}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium">
              {step.label}
              <span className="sr-only">: {STEP_WORD[step.state]}</span>
            </span>
            <span className="block text-meta text-text-tertiary">{step.note}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
