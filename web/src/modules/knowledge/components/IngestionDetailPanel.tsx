"use client";

import { Ban, FileSearch, RotateCw, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusPill } from "@/components/ui/StatusPill";
import type { Ingestion, IngestionEvent } from "@/modules/knowledge/ingestions-api";
import {
  canRetry,
  eventLabel,
  failureHeadline,
  formatDuration,
  ingestionShape,
  ingestionStatus,
  ingestionTitle,
  isActive,
  liveElapsed,
  progressLabel,
  triggerLabel,
} from "@/modules/knowledge/ingestion-state";
import { knowledgeActions, useIngestionDetail } from "@/modules/knowledge/queries";
import { formatDateTime } from "@/modules/workspace-control/format";

import { IngestionIcon } from "./IngestionIcon";
import { LaneTrack, useNow } from "./IngestionLanes";

const SHAPE_LABEL = {
  document: "Document",
  archive: "Archive",
  source: "Source sync",
} as const;

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });

/**
 * One ingestion, start to finish.
 *
 * It docks beside the log rather than covering it, like a document's details:
 * the reason to open it is usually to compare it with the rows around it. So
 * it is non-modal — Escape closes it and focus returns to the row — and it
 * keeps reading while the work runs, so the timeline grows as you watch.
 *
 * Mount it under `key={ingestionId}` so moving to another ingestion starts
 * from a clean timeline instead of flashing the previous one.
 */
export function IngestionDetailPanel({
  ingestionId,
  initial,
  collectionName,
  hasDocument,
  onOpenDocument,
  onReplace,
  onChanged,
  onClose,
}: {
  ingestionId: string;
  /** The row that was opened, shown until the first read answers. */
  initial?: Ingestion;
  collectionName: (ingestion: Ingestion) => string | undefined;
  /** Whether the document is still in the workspace, so it can be opened. */
  hasDocument: (documentId: string) => boolean;
  onOpenDocument: (documentId: string) => void;
  /** A retry answers with the ingestion to follow from now on. */
  onReplace: (next: Ingestion) => void;
  /** Something changed; the feed behind the panel should read again. */
  onChanged: () => void;
  onClose: () => void;
}) {
  const detail = useIngestionDetail(ingestionId);
  const ingestion = detail.ingestion ?? initial ?? null;
  const [busy, setBusy] = useState<"retry" | "cancel" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const running = ingestion ? isActive(ingestion) : false;
  const now = useNow(running);
  const collection = ingestion ? collectionName(ingestion) : undefined;

  // Focus moves in on open and back to whatever opened it on close.
  useEffect(() => {
    const restore = globalThis.document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCloseRef.current();
    };
    globalThis.document.addEventListener("keydown", onKeyDown);
    return () => {
      globalThis.document.removeEventListener("keydown", onKeyDown);
      restore?.focus();
    };
  }, []);

  const act = async (kind: "retry" | "cancel") => {
    if (!ingestion) return;
    setBusy(kind);
    setActionError(null);
    try {
      const next = kind === "retry"
        ? await knowledgeActions.retryIngestion(ingestion.id)
        : await knowledgeActions.cancelIngestion(ingestion.id);
      onChanged();
      if (next.id !== ingestion.id) onReplace(next);
      else detail.refresh();
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : kind === "retry" ? "It could not be retried. Try again in a moment." : "It could not be cancelled. Try again in a moment.",
      );
      detail.refresh();
    } finally {
      setBusy(null);
    }
  };

  const status = ingestion ? ingestionStatus(ingestion) : null;
  const title = ingestion ? ingestionTitle(ingestion) : "Activity";
  const elapsed = ingestion ? liveElapsed(ingestion, detail.receivedAt || now, now) : null;
  const failed = ingestion?.status === "failed" || ingestion?.status === "timed_out";

  return (
    <aside aria-label={`${title} details`} className="knowledge-details knowledge-ingestion-panel" ref={panelRef}>
      <header className="knowledge-details__header knowledge-ingestion-panel__header">
        {ingestion && <IngestionIcon ingestion={ingestion} />}
        <div className="min-w-0 flex-1">
          <h3 title={title}>{title}</h3>
          <p className="knowledge-ingestion-panel__meta">
            {ingestion && status && (
              <StatusPill pulse={status.pulse} tone={status.tone}>{status.label}</StatusPill>
            )}
            {ingestion && <span>{SHAPE_LABEL[ingestionShape(ingestion)]}</span>}
            {collection && <span>{collection}</span>}
          </p>
        </div>
        <Button
          aria-label="Close details"
          icon={<X size={16} />}
          iconOnly
          onClick={onClose}
          size="sm"
          variant="ghost"
        />
      </header>

      <div className="knowledge-details__body">
        {detail.error && (
          <ErrorState
            actionLabel="Try again"
            className="my-[var(--space-3)]"
            description={detail.error}
            layout="inline"
            onAction={detail.refresh}
            title="This activity couldn’t be refreshed"
          />
        )}

        {!ingestion ? (
          <div aria-busy="true" className="grid gap-[var(--space-2)] py-[var(--space-4)]" role="status">
            <span className="sr-only">Loading activity</span>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
          </div>
        ) : (
          <>
            {running && (
              <section aria-label="Progress" className="knowledge-ingestion-panel__progress">
                <p>
                  <strong>{progressLabel(ingestion)}</strong>
                  {elapsed !== null && ingestion.status === "running" && (
                    <span>{formatDuration(elapsed, { precise: false })}</span>
                  )}
                </p>
                <LaneTrack ingestion={ingestion} />
              </section>
            )}

            {failed && (
              <div className="knowledge-notice knowledge-notice--danger knowledge-ingestion-panel__notice" role="alert">
                <TriangleAlert aria-hidden="true" size={16} />
                <div>
                  <strong>{failureHeadline(ingestion)}</strong>
                  <p>
                    {ingestion.error
                      ?? "No reason was recorded. Retry it, and if it fails again, check the file or the source’s account."}
                  </p>
                </div>
              </div>
            )}

            <dl className="knowledge-details__facts">
              <div><dt>Started</dt><dd>{formatDateTime(ingestion.started_at, "Not started yet")}</dd></div>
              {ingestion.finished_at && (
                <div><dt>Finished</dt><dd>{formatDateTime(ingestion.finished_at)}</dd></div>
              )}
              <div>
                <dt>Duration</dt>
                <dd className="tabular-nums">{formatDuration(elapsed ?? ingestion.duration_ms)}</dd>
              </div>
              <div><dt>Started by</dt><dd>{triggerLabel(ingestion)}</dd></div>
              {ingestion.attempt > 1 && (
                <div><dt>Attempt</dt><dd className="tabular-nums">{ingestion.attempt}</dd></div>
              )}
              {ingestion.progress && <Counts ingestion={ingestion} />}
            </dl>

            <section aria-labelledby="ingestion-timeline-heading" className="knowledge-ingestion-panel__timeline">
              <h4 className="knowledge-eyebrow" id="ingestion-timeline-heading">Timeline</h4>
              <Timeline events={detail.events} ingestion={ingestion} loaded={detail.receivedAt > 0} />
            </section>

            <details className="knowledge-details__disclosure">
              <summary>Reference</summary>
              <p>Quote this if you ask someone to look into it: <code>{ingestion.id}</code></p>
            </details>
          </>
        )}
      </div>

      {ingestion && (
        <footer className="knowledge-details__actions">
          {actionError && (
            <p className="knowledge-ingestion-panel__error" role="alert">{actionError}</p>
          )}
          {ingestion.kind === "document" && ingestion.document_id && hasDocument(ingestion.document_id) && (
            <button onClick={() => onOpenDocument(ingestion.document_id!)} type="button">
              <FileSearch aria-hidden="true" size={16} />Open document
            </button>
          )}
          {canRetry(ingestion) && (
            <button disabled={busy !== null} onClick={() => void act("retry")} type="button">
              <RotateCw aria-hidden="true" className={busy === "retry" ? "motion-safe:animate-spin" : undefined} size={16} />
              {busy === "retry" ? "Retrying…" : "Retry"}
            </button>
          )}
          {running && (
            <button
              className="knowledge-details__danger"
              disabled={busy !== null}
              onClick={() => void act("cancel")}
              type="button"
            >
              <Ban aria-hidden="true" size={16} />
              {busy === "cancel" ? "Cancelling…" : "Cancel"}
            </button>
          )}
        </footer>
      )}
    </aside>
  );
}

/** What was counted, in the unit this kind of work counts. */
function Counts({ ingestion }: { ingestion: Ingestion }) {
  const progress = ingestion.progress!;
  const shape = ingestionShape(ingestion);
  const unit = shape === "source" ? "Items" : shape === "archive" ? "Files" : "Chunks";
  const rows: [string, number][] = shape === "document"
    ? [["Found", progress.discovered_count], ["Embedded", progress.processed_count], ["Indexed", progress.indexed_count]]
    : shape === "archive"
      ? [["Accepted", progress.discovered_count], ["Stored", progress.processed_count]]
      : [
          ["Found", progress.discovered_count],
          ["Processed", progress.processed_count],
          ["Indexed", progress.indexed_count],
          ["Removed", progress.deleted_count],
        ];
  if (progress.failed_count) rows.push(["Failed", progress.failed_count]);
  return (
    <div>
      <dt>{unit}</dt>
      <dd className="knowledge-ingestion-panel__counts">
        {rows.map(([label, value]) => (
          <span key={label}><strong>{value.toLocaleString()}</strong> {label.toLowerCase()}</span>
        ))}
      </dd>
    </div>
  );
}

/**
 * The ingestion's history, oldest first. While it runs, a last entry stands
 * for the step in progress, so the line always ends where the work is.
 */
function Timeline({
  ingestion,
  events,
  loaded,
}: {
  ingestion: Ingestion;
  events: IngestionEvent[];
  loaded: boolean;
}) {
  if (!loaded) {
    return (
      <div aria-hidden="true" className="grid gap-[var(--space-2)] py-[var(--space-2)]">
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    );
  }
  if (!events.length && !isActive(ingestion)) {
    return <p className="knowledge-muted py-[var(--space-2)]">Nothing was recorded for this one.</p>;
  }

  return (
    <ol className="knowledge-timeline">
      {events.map((event) => {
        const { label, tone } = eventLabel(event);
        return (
          <li className="knowledge-timeline__event" data-tone={tone} key={event.id}>
            <span aria-hidden="true" className="knowledge-timeline__dot" />
            <div>
              <p className="knowledge-timeline__title">
                <strong>{label}</strong>
                {event.duration_ms !== null && (
                  <span className="tabular-nums">took {formatDuration(event.duration_ms)}</span>
                )}
                <time dateTime={event.at} title={formatDateTime(event.at)}>{clock.format(new Date(event.at))}</time>
              </p>
              {event.message && <p className="knowledge-timeline__message">{event.message}</p>}
            </div>
          </li>
        );
      })}
      {isActive(ingestion) && (
        <li aria-live="polite" className="knowledge-timeline__event" data-live="true" data-tone="info">
          <span aria-hidden="true" className="knowledge-timeline__dot" />
          <div>
            <p className="knowledge-timeline__title">
              <strong>{progressLabel(ingestion)}</strong>
              <span>now</span>
            </p>
          </div>
        </li>
      )}
    </ol>
  );
}
