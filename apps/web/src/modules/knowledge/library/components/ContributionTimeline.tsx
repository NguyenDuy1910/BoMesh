"use client";

import { Spinner } from "@heroui/react";
import clsx from "clsx";
import { Check, CircleDashed, Clock, LoaderCircle, Minus, TriangleAlert, type LucideIcon } from "lucide-react";

import { fmtDateTime, rel, relInline } from "@/lib/format";

import type { Contribution } from "../../api";
import { progressSteps, timelineSteps, type ContributionEventView, type ProgressState } from "../contributions";
import { useContributionViews, type ContributionView } from "../useContributionViews";

/** The history list (preview `X.ctb.timeline`) for an already resolved contribution view. `quoted`: the event the state alert shows. */
export function TimelineSteps({ view, compact = false, quoted }: { view: ContributionView; compact?: boolean; quoted?: ContributionEventView }) {
  const steps = timelineSteps(view.contribution, view.ctx, quoted);
  if (!steps.length) return <p className="t-sm muted">Chưa có lịch sử.</p>;
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

const PROG_ICON: Readonly<Record<ProgressState, readonly [LucideIcon, string]>> = {
  done: [Check, "success"],
  current: [Clock, "accent"],
  issue: [TriangleAlert, "warning"],
  skipped: [Minus, ""],
  todo: [CircleDashed, ""],
};
const PROG_SR: Readonly<Record<ProgressState, string>> = { done: "Xong", current: "Đang xử lý", issue: "Cần chú ý", skipped: "Đã bỏ qua", todo: "Chưa" };

/** Submitted → Analyzed → In review → Approved → Published (preview `stepper`, the Studio's `.flow-steps`). */
export function ProgressStepper({ view }: { view: ContributionView }) {
  return (
    <ol className="flow-steps" aria-label="Tiến độ">
      {progressSteps(view.contribution, view.ctx).map((s) => {
        const [Icon, tone] = s.busy ? ([LoaderCircle, "accent"] as const) : PROG_ICON[s.state];
        return (
          <li key={s.label} className={clsx("flow-steps__item", `is-${s.state}`, s.busy && "is-busy")}>
            <span className={clsx("flow-steps__dot", tone && `flow-steps__dot--${tone}`)} aria-hidden>
              <Icon className="i i-xs" />
            </span>
            <div className="grow">
              <div className="t-sm">
                <span className="medium">{s.label}</span>
                <span className="sr-only">{PROG_SR[s.state]}</span>
              </div>
              <div className="flow-steps__text">
                {s.text}
                {s.at ? (
                  <span className="muted" title={fmtDateTime(s.at)}>
                    {` · ${relInline(s.at)}`}
                  </span>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
