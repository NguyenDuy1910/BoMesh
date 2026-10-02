"use client";

import { StatusPill } from "@/components/ui/StatusPill";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/modules/knowledge/connection-state";
import type { Ingestion } from "@/modules/knowledge/ingestions-api";
import {
  failureLine,
  formatDuration,
  ingestionStatus,
  ingestionTitle,
  isActive,
  progressLabel,
  triggerLabel,
} from "@/modules/knowledge/ingestion-state";
import { formatDateTime } from "@/modules/workspace-control/format";

import { IngestionIcon } from "./IngestionIcon";

/**
 * One ingestion, as a line in a log.
 *
 * A line, not a card: what an operator scans for is whether anything failed
 * and when, and everything else is noise until one of them did. So a failure
 * spends the second line on its reason, and a healthy line spends it on where
 * the work landed.
 *
 * With `onOpen` the whole line is the control that opens its details; without
 * it (an account's own sync history) it is read-only.
 */
export function SyncRunRow({
  ingestion,
  label,
  collection,
  selected = false,
  onOpen,
}: {
  ingestion: Ingestion;
  /** Names it when the ingestion carries no title of its own. */
  label?: string;
  /** The destination Collection's name, when known. */
  collection?: string;
  selected?: boolean;
  onOpen?: () => void;
}) {
  const status = ingestionStatus(ingestion);
  const title = ingestion.title ?? label ?? ingestionTitle(ingestion);
  const failed = ingestion.status === "failed" || ingestion.status === "timed_out";
  const when = ingestion.finished_at ?? ingestion.started_at ?? ingestion.created_at;
  const detail = failed
    ? failureLine(ingestion)
    : [
        collection,
        isActive(ingestion) ? progressLabel(ingestion) : triggerLabel(ingestion),
        ingestion.attempt > 1 ? `Attempt ${ingestion.attempt}` : null,
      ].filter(Boolean).join(" · ");

  const content = (
    <>
      <IngestionIcon ingestion={ingestion} />
      <span className="knowledge-run__title">
        <strong title={title}>{title}</strong>
        {detail && (
          <span className={cn("knowledge-run__detail", failed && "knowledge-run__detail--bad")}>
            {detail}
          </span>
        )}
      </span>
      <StatusPill pulse={status.pulse} tone={status.tone}>{status.label}</StatusPill>
      <span className="knowledge-run__duration">
        {ingestion.duration_ms !== null && !isActive(ingestion) ? formatDuration(ingestion.duration_ms) : ""}
      </span>
      <time className="knowledge-run__time" dateTime={when} title={formatDateTime(when)}>
        {relativeTime(when)}
      </time>
    </>
  );

  return (
    <li className="knowledge-run">
      {onOpen ? (
        <button
          aria-current={selected ? "true" : undefined}
          className="knowledge-run__summary knowledge-run__summary--button"
          onClick={onOpen}
          type="button"
        >
          {content}
        </button>
      ) : (
        <div className="knowledge-run__summary">{content}</div>
      )}
    </li>
  );
}
