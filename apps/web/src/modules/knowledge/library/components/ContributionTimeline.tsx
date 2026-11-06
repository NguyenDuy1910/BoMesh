"use client";

import { Spinner } from "@heroui/react";
import clsx from "clsx";

import { fmtDateTime, rel } from "@/lib/format";

import type { Contribution } from "../../api";
import { timelineSteps, type TimelineStep } from "../contributions";
import { useContributionViews, type ContributionView } from "../useContributionViews";

/** The history list (preview `X.ctb.timeline`) for an already resolved contribution view. */
export function TimelineSteps({ view, compact = false }: { view: ContributionView; compact?: boolean }) {
  const steps: TimelineStep[] = timelineSteps(view.contribution, view.ctx);
  if (!steps.length) return <p className="t-sm muted">No history yet.</p>;
  return (
    <ol className={clsx("ctb-tl", compact && "ctb-tl--compact")}>
      {steps.map((s, i) => (
        <li key={i} className={clsx("ctb-tl__step", s.tone && `ctb-tl__step--${s.tone}`, s.next && "is-next")}>
          <span className="ctb-tl__dot" aria-hidden>
            {s.live ? <Spinner size="sm" /> : <s.icon className="i" />}
          </span>
          <div className="ctb-tl__body">
            <div className="ctb-tl__title">{s.title}</div>
            {s.desc ? <div className="ctb-tl__desc">{s.desc}</div> : null}
            {s.at ? (
              <div className="ctb-tl__meta" title={fmtDateTime(s.at)}>
                {rel(s.at)}
              </div>
            ) : null}
            {s.quote ? (
              <blockquote className="ctb-quote" translate="no">
                {s.quote}
              </blockquote>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * Who did what to a contribution, when, and what reviewers wrote — plus what happens next.
 * Self-contained (resolves names and documents); the Reader's submission view uses it.
 */
export function ContributionTimeline({ contribution, compact = false }: { contribution: Contribution; compact?: boolean }) {
  const { view } = useContributionViews([contribution]);
  return <TimelineSteps view={view(contribution)} compact={compact} />;
}
