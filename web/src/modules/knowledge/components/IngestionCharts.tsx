"use client";

import { useId, useState } from "react";

import { cn } from "@/lib/cn";
import type { IngestionBucket, IngestionSummary } from "@/modules/knowledge/ingestions-api";
import { formatDuration, WINDOW_LABEL } from "@/modules/knowledge/ingestion-state";

/**
 * The three instruments above the lanes.
 *
 * Each answers one question and nothing else — how much went through, how much
 * of it worked, how long it took — and each states its answer in words as well
 * as in shape, so a screen reader and a glance get the same reading. They are
 * drawn in SVG from the design tokens rather than a chart library: three small
 * figures do not justify a dependency, and a library's defaults would not look
 * like the rest of the product.
 */

/* ── Throughput ──────────────────────────────────────────────────────────── */

const COLUMN = 10;
const BAR = 6;
const HEIGHT = 100;

/** The smallest round number at or above `value`, so the scale reads cleanly. */
function niceCeiling(value: number): number {
  if (value <= 4) return Math.max(1, value);
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= value) ?? 10;
  return step * magnitude;
}

function bucketLabel(bucket: IngestionBucket, seconds: number, withDay: boolean): string {
  const start = new Date(bucket.start);
  const end = new Date(start.getTime() + seconds * 1000);
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const day = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  return withDay
    ? `${day.format(start)} ${time.format(start)}–${time.format(end)}`
    : `${time.format(start)}–${time.format(end)}`;
}

function axisLabel(value: string, window: IngestionSummary["window"]): string {
  const date = new Date(value);
  return window === "7d"
    ? new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric" }).format(date)
    : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

export function ThroughputChart({ summary }: { summary: IngestionSummary }) {
  const { buckets, bucket_seconds: seconds, window } = summary;
  const [active, setActive] = useState<number | null>(null);
  const hintId = useId();
  const withDay = window === "7d";
  const count = buckets.length;
  if (!count) {
    return <p className="knowledge-muted">No intervals to chart for the {WINDOW_LABEL[window]}.</p>;
  }
  const width = count * COLUMN;
  const ceiling = niceCeiling(
    Math.max(0, ...buckets.map((bucket) => Math.max(bucket.started, bucket.completed + bucket.failed))),
  );
  const y = (value: number) => HEIGHT - (value / ceiling) * HEIGHT;

  const totals = buckets.reduce(
    (sum, bucket) => ({
      started: sum.started + bucket.started,
      completed: sum.completed + bucket.completed,
      failed: sum.failed + bucket.failed,
    }),
    { started: 0, completed: 0, failed: 0 },
  );
  const busiest = buckets.reduce<IngestionBucket | null>(
    (best, bucket) => (!best || bucket.started > best.started ? bucket : best),
    null,
  );
  const alternative = `Throughput, ${WINDOW_LABEL[window]}: ${totals.started} started, `
    + `${totals.completed} completed, ${totals.failed} failed.`
    + (busiest && busiest.started ? ` Busiest: ${bucketLabel(busiest, seconds, withDay)} with ${busiest.started} started.` : "");

  // Where "now" falls: inside the last bucket, not at its far edge.
  const first = count ? Date.parse(buckets[0].start) : 0;
  const span = count * seconds * 1000;
  const nowRatio = span
    ? Math.min(1, Math.max(0, (Date.parse(summary.generated_at) - first) / span))
    : 1;

  const move = (next: number) => setActive(Math.min(count - 1, Math.max(0, next)));
  const onKeyDown = (event: React.KeyboardEvent) => {
    const keys: Record<string, () => void> = {
      ArrowLeft: () => move((active ?? count) - 1),
      ArrowRight: () => move((active ?? -1) + 1),
      Home: () => move(0),
      End: () => move(count - 1),
      Escape: () => setActive(null),
    };
    const handler = keys[event.key];
    if (!handler) return;
    event.preventDefault();
    handler();
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width) return;
    move(Math.floor(((event.clientX - box.left) / box.width) * count));
  };

  const shown = active === null ? null : buckets[active];

  return (
    <figure className="knowledge-throughput">
      <div className="knowledge-throughput__scale" aria-hidden="true">
        <span>{ceiling.toLocaleString()}</span>
        <span>0</span>
      </div>
      <div
        aria-describedby={hintId}
        aria-label={alternative}
        className="knowledge-throughput__plot"
        onBlur={() => setActive(null)}
        onKeyDown={onKeyDown}
        onPointerLeave={() => setActive(null)}
        onPointerMove={onPointerMove}
        role="group"
        tabIndex={0}
      >
        <svg
          aria-hidden="true"
          className="knowledge-throughput__svg"
          preserveAspectRatio="none"
          viewBox={`0 0 ${width} ${HEIGHT}`}
        >
          <line className="knowledge-throughput__grid" vectorEffect="non-scaling-stroke" x1={0} x2={width} y1={0} y2={0} />
          <line className="knowledge-throughput__grid" vectorEffect="non-scaling-stroke" x1={0} x2={width} y1={HEIGHT / 2} y2={HEIGHT / 2} />
          <line className="knowledge-throughput__baseline" vectorEffect="non-scaling-stroke" x1={0} x2={width} y1={HEIGHT} y2={HEIGHT} />
          {buckets.map((bucket, index) => {
            const x = index * COLUMN + (COLUMN - BAR) / 2;
            const completedTop = y(bucket.completed);
            const failedTop = y(bucket.completed + bucket.failed);
            return (
              <g key={bucket.start}>
                {active === index && (
                  <rect className="knowledge-throughput__focus" height={HEIGHT} width={COLUMN} x={index * COLUMN} y={0} />
                )}
                {bucket.completed > 0 && (
                  <rect className="knowledge-throughput__completed" height={HEIGHT - completedTop} width={BAR} x={x} y={completedTop} />
                )}
                {bucket.failed > 0 && (
                  <rect className="knowledge-throughput__failed" height={completedTop - failedTop} width={BAR} x={x} y={failedTop} />
                )}
                {bucket.started > 0 && (
                  <line
                    className="knowledge-throughput__started"
                    vectorEffect="non-scaling-stroke"
                    x1={index * COLUMN + 1}
                    x2={index * COLUMN + COLUMN - 1}
                    y1={y(bucket.started)}
                    y2={y(bucket.started)}
                  />
                )}
              </g>
            );
          })}
          <line
            className="knowledge-throughput__now"
            vectorEffect="non-scaling-stroke"
            x1={nowRatio * width}
            x2={nowRatio * width}
            y1={0}
            y2={HEIGHT}
          />
        </svg>
        {shown && active !== null && (
          <div
            aria-hidden="true"
            className="knowledge-throughput__tooltip"
            style={{
              left: `${((active + 0.5) / count) * 100}%`,
              // Keep the tooltip inside the plot at either edge.
              transform: `translateX(${active < count / 4 ? "-15%" : active > (count * 3) / 4 ? "-85%" : "-50%"})`,
            }}
          >
            <strong>{bucketLabel(shown, seconds, withDay)}</strong>
            <span><i className="knowledge-swatch knowledge-swatch--started" />{shown.started} started</span>
            <span><i className="knowledge-swatch knowledge-swatch--completed" />{shown.completed} completed</span>
            <span><i className="knowledge-swatch knowledge-swatch--failed" />{shown.failed} failed</span>
          </div>
        )}
      </div>
      <div aria-hidden="true" className="knowledge-throughput__axis">
        {count > 0 && <span style={{ left: 0 }}>{axisLabel(buckets[0].start, window)}</span>}
        {count > 4 && (
          <span data-align="center" style={{ left: `${(Math.floor(count / 2) / count) * 100}%` }}>
            {axisLabel(buckets[Math.floor(count / 2)].start, window)}
          </span>
        )}
        <span data-align="end" style={{ left: `${nowRatio * 100}%` }}>Now</span>
      </div>
      <figcaption className="knowledge-legend">
        <span><i className="knowledge-swatch knowledge-swatch--completed" />Completed</span>
        <span><i className="knowledge-swatch knowledge-swatch--failed" />Failed</span>
        <span><i className="knowledge-swatch knowledge-swatch--started" />Started</span>
      </figcaption>
      <p className="sr-only" id={hintId}>Use the arrow keys to read each interval.</p>
      <p aria-live="polite" className="sr-only">
        {shown
          ? `${bucketLabel(shown, seconds, withDay)}: ${shown.started} started, ${shown.completed} completed, ${shown.failed} failed`
          : ""}
      </p>
    </figure>
  );
}

/* ── Outcomes ────────────────────────────────────────────────────────────── */

const RADIUS = 42;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function OutcomesRing({ summary }: { summary: IngestionSummary }) {
  const { totals } = summary;
  const slices = [
    { key: "completed", label: "Completed", value: totals.completed },
    { key: "failed", label: "Failed", value: totals.failed + totals.timed_out },
    { key: "cancelled", label: "Cancelled", value: totals.cancelled },
    { key: "running", label: "In progress", value: totals.running + totals.pending },
  ];
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const finished = totals.completed + totals.failed + totals.timed_out + totals.cancelled;
  const rate = finished ? Math.round((totals.completed / finished) * 100) : null;
  const alternative = `Outcomes, ${WINDOW_LABEL[summary.window]}: `
    + slices.map((slice) => `${slice.value} ${slice.label.toLowerCase()}`).join(", ")
    + (rate === null ? ". Nothing has finished yet." : `. ${rate}% of finished work succeeded.`);

  let offset = 0;
  return (
    <figure className="knowledge-outcomes">
      <div className="knowledge-outcomes__ring">
        <svg aria-label={alternative} role="img" viewBox="0 0 100 100">
          <title>{alternative}</title>
          <circle className="knowledge-outcomes__track" cx={50} cy={50} r={RADIUS} />
          {total > 0 && slices.map((slice) => {
            if (!slice.value) return null;
            const length = (slice.value / total) * CIRCUMFERENCE;
            // A hairline gap between slices, unless one slice is the whole ring.
            const gap = slice.value === total ? 0 : Math.min(1.5, length / 3);
            const arc = (
              <circle
                className={`knowledge-outcomes__slice knowledge-outcomes__slice--${slice.key}`}
                cx={50}
                cy={50}
                key={slice.key}
                r={RADIUS}
                strokeDasharray={`${length - gap} ${CIRCUMFERENCE - length + gap}`}
                strokeDashoffset={-offset}
              />
            );
            offset += length;
            return arc;
          })}
        </svg>
        <div aria-hidden="true" className="knowledge-outcomes__center">
          <strong>{rate === null ? "—" : `${rate}%`}</strong>
          <span>{rate === null ? "none finished" : "succeeded"}</span>
        </div>
      </div>
      <ul aria-hidden="true" className="knowledge-outcomes__legend">
        {slices.map((slice) => (
          <li key={slice.key}>
            <i className={`knowledge-swatch knowledge-swatch--${slice.key}`} />
            <span>{slice.label}</span>
            <strong>{slice.value.toLocaleString()}</strong>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/* ── Duration ────────────────────────────────────────────────────────────── */

export function DurationRange({ summary }: { summary: IngestionSummary }) {
  const duration = summary.duration_ms;
  const active = (
    <p className="knowledge-duration__active">
      <strong>{summary.active.toLocaleString()}</strong>
      <span>{summary.active ? "queued or running now" : "nothing running now"}</span>
    </p>
  );

  if (!duration) {
    return (
      <div className="knowledge-duration">
        <p className="knowledge-muted">Nothing finished in the {WINDOW_LABEL[summary.window]}.</p>
        {active}
      </div>
    );
  }

  const max = Math.max(duration.max, 1);
  const at = (value: number) => `${Math.min(100, (value / max) * 100)}%`;
  const alternative = `Duration, ${WINDOW_LABEL[summary.window]}: half finished within `
    + `${formatDuration(duration.p50)}, 95% within ${formatDuration(duration.p95)}, `
    + `the longest took ${formatDuration(duration.max)}.`;

  return (
    <div className="knowledge-duration">
      <div aria-label={alternative} className="knowledge-duration__bar" role="img">
        <span className="knowledge-duration__band" style={{ left: at(duration.p50), width: `calc(${at(duration.p95)} - ${at(duration.p50)})` }} />
        <span className="knowledge-duration__tick knowledge-duration__tick--p50" style={{ left: at(duration.p50) }} />
        <span className="knowledge-duration__tick knowledge-duration__tick--p95" style={{ left: at(duration.p95) }} />
        <span className="knowledge-duration__tick knowledge-duration__tick--max" style={{ left: "100%" }} />
      </div>
      <dl aria-hidden="true" className="knowledge-duration__stats">
        <div><dt>Median</dt><dd>{formatDuration(duration.p50)}</dd></div>
        <div><dt>95% within</dt><dd>{formatDuration(duration.p95)}</dd></div>
        <div><dt>Longest</dt><dd>{formatDuration(duration.max)}</dd></div>
      </dl>
      {active}
    </div>
  );
}

/** The frame each instrument sits in: a label, the figure, and a one-line total. */
export function Instrument({
  title,
  total,
  className,
  children,
}: {
  title: string;
  total?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={cn("knowledge-instrument", className)}>
      <header className="knowledge-instrument__head">
        <h3 className="knowledge-eyebrow" id={headingId}>{title}</h3>
        {total && <span>{total}</span>}
      </header>
      {children}
    </section>
  );
}
