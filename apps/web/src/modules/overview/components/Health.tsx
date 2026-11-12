"use client";

import clsx from "clsx";
import NextLink from "next/link";

import { fmtNum, pct } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { reviewQueueHref, useReviewQueueCounts, type QueueId } from "@/modules/curation";

export interface HealthMetric {
  label: string;
  value: string;
  /** Review queue it opens. */
  queue: QueueId;
  /** Tone while it needs someone ('' = calm). */
  tone: "" | "accent" | "danger" | "warning" | "share";
  tip: string;
}

/**
 * Knowledge health (preview `healthMetrics()`): the Studio's Review queues as one row of metrics, decisions to publish
 * first, then what keeps published knowledge right. Undefined when the caller can't review or the counts are loading.
 */
export function useHealthMetrics(): HealthMetric[] | undefined {
  const { can } = useWorkspace();
  const counts = useReviewQueueCounts();
  const c = counts.data;
  if (!can("contributions.review") || !c) return undefined;
  // Sync batches and Topics to confirm have no API (curation `useReviewQueueCounts` leaves them out), so neither is shown.
  const metrics: (HealthMetric | null)[] = [
    { label: "Waiting for review", value: fmtNum(c.submissions), queue: "submissions", tone: c.submissions ? "accent" : "", tip: "Submissions waiting for a decision" },
    { label: "Publishing problems", value: fmtNum(c.problems), queue: "problems", tone: c.problems ? "danger" : "", tip: "Couldn’t publish, changed at the source or waiting to publish" },
    { label: "Re-verification due", value: fmtNum(c.reverify), queue: "reverify", tone: c.reverify ? "warning" : "", tip: "Verification expired or never happened" },
    { label: "Missing details", value: fmtNum(c.details), queue: "details", tone: c.details ? "warning" : "", tip: "No topic, owner or summary" },
    { label: "Possible duplicates", value: fmtNum(c.duplicates), queue: "duplicates", tone: c.duplicates ? "warning" : "", tip: "Near-identical documents that compete in answers" },
    {
      label: "Verified",
      value: c.published ? `${pct(c.verified, c.published)}%` : "—",
      queue: "reverify",
      tone: c.published ? "share" : "",
      tip: `${fmtNum(c.verified)} of ${fmtNum(c.published)} published documents are verified`,
    },
  ];
  return metrics.filter((m): m is HealthMetric => m !== null);
}

/** Decisions waiting before documents reach people: counted in the page's "need you" line. */
export const healthDue = (metrics: readonly HealthMetric[] | undefined) => (metrics ?? []).slice(0, 2).filter((m) => m.tone).length;

/** One row of metrics, each opening its Review queue (preview `healthHtml`). */
export function Health({ metrics }: { metrics: readonly HealthMetric[] }) {
  return (
    <nav className="health" aria-label="Knowledge health">
      {metrics.map((m) => (
        <NextLink key={m.label} className={clsx("health__item", m.tone && "is-due", m.tone && `health__item--${m.tone}`)} href={reviewQueueHref(m.queue)} title={m.tip}>
          <span className="health__value num">{m.value}</span>
          <span className="health__label">{m.label}</span>
        </NextLink>
      ))}
    </nav>
  );
}
