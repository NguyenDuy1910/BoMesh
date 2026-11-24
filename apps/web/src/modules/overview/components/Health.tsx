"use client";

import clsx from "clsx";
import NextLink from "next/link";

import { fmtNum, pct } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";
import { docsHref, firstQualityPart, qualityCount, useDocCounts } from "@/modules/curation";

export interface HealthMetric {
  label: string;
  value: string;
  /** The Documents view (and filter) it opens. */
  href: string;
  /** Tone while it needs someone ('' = calm). */
  tone: "" | "accent" | "danger" | "warning" | "share";
  tip: string;
}

/**
 * Knowledge health (preview `healthMetrics()`): what keeps documents from people first, in the order work flows
 * (Processing, then Review), then what keeps published knowledge right (All filtered by quality). Undefined when the
 * caller can't review or the counts are loading.
 */
export function useHealthMetrics(): HealthMetric[] | undefined {
  const { can } = useWorkspace();
  const m = useMessages();
  const counts = useDocCounts();
  const c = counts.data;
  if (!can("contributions.review") || !c) return undefined;
  // Sync batches and Topics to confirm have no API (curation `useDocCounts` leaves them out), so neither is shown.
  const quality = qualityCount(c);
  return [
    {
      label: m.studio.documentViews.processing,
      value: fmtNum(c.processing),
      href: docsHref("processing"),
      tone: c.waiting ? "warning" : "",
      tip: "Not processed, failed or changed at the source: search and the assistant can’t use them, and submissions wait to be classified for review",
    },
    { label: m.studio.documentViews.review, value: fmtNum(c.review), href: docsHref("review"), tone: c.review ? "accent" : "", tip: "Processed submissions and new versions, waiting for a decision" },
    { label: m.studio.quality.label, value: fmtNum(quality), href: docsHref("all", { quality: firstQualityPart(c) }), tone: quality ? "warning" : "", tip: "Re-verification due, missing owner or summary, possible duplicates" },
    {
      label: "Verified",
      value: c.published ? `${pct(c.verified, c.published)}%` : "—",
      href: docsHref("all", { quality: "reverify" }),
      tone: c.published ? "share" : "",
      tip: `${fmtNum(c.verified)} of ${fmtNum(c.published)} published documents are verified`,
    },
  ];
}

/** Decisions waiting before documents reach people: counted in the page's "need you" line. */
export const healthDue = (metrics: readonly HealthMetric[] | undefined) => (metrics ?? []).slice(0, 2).filter((m) => m.tone).length;

/** One row of metrics, each opening its Documents view (preview `healthHtml`). */
export function Health({ metrics }: { metrics: readonly HealthMetric[] }) {
  return (
    <nav className="health" aria-label="Knowledge health">
      {metrics.map((m) => (
        <NextLink key={m.label} className={clsx("health__item", m.tone && "is-due", m.tone && `health__item--${m.tone}`)} href={m.href} title={m.tip}>
          <span className="health__value num">{m.value}</span>
          <span className="health__label">{m.label}</span>
        </NextLink>
      ))}
    </nav>
  );
}
