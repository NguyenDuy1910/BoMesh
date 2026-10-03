"use client";

import Link from "next/link";
import { useId, useState } from "react";

import { cn } from "@/lib/cn";

/*
 * The instruments the workspace dashboards are built from.
 *
 * One visual language for every figure: ink for the measure being read, a
 * quiet grey for the volume behind it, and red only where something failed.
 * Change is stated in words next to the number rather than painted, so a
 * dashboard full of figures never turns into a field of green and red.
 */

/* ── Metric ledger ───────────────────────────────────────────────────────── */

/** A row of headline figures in one ruled panel, divided by hairlines. */
export function MetricLedger({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <section aria-label={label} className="ctl-ledger">
      {children}
    </section>
  );
}

export function Metric({
  label,
  value,
  change,
  trend,
  note,
  href,
  tone = "default",
}: {
  label: string;
  value: number | string;
  /** How this period compares with the one before, already worded. */
  change?: string;
  /** The figure over time, oldest first, drawn as a sparkline. */
  trend?: number[];
  note?: React.ReactNode;
  href?: string;
  tone?: "default" | "danger";
}) {
  const body = (
    <>
      <span className="ctl-metric__label">{label}</span>
      <span className={cn("ctl-metric__value", tone === "danger" && "ctl-metric__value--danger")}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </span>
      {change && <span className="ctl-metric__change">{change}</span>}
      {note && <span className="ctl-metric__note">{note}</span>}
      {trend && trend.length > 1 && <Sparkline values={trend} />}
    </>
  );
  return href ? (
    <Link className="ctl-metric ctl-metric--link" href={href}>{body}</Link>
  ) : (
    <div className="ctl-metric">{body}</div>
  );
}

/**
 * "↑ 12% vs previous 7 days". Percentages from a zero base mean nothing, so
 * that case is said plainly instead.
 */
export function changeLabel(current: number, previous: number, span: string): string {
  if (current === previous) return `Same as previous ${span}`;
  if (previous === 0) return `Up from none the previous ${span}`;
  const percent = Math.round(((current - previous) / previous) * 100);
  return `${percent > 0 ? "↑" : "↓"} ${Math.abs(percent)}% vs previous ${span}`;
}

function Sparkline({ values }: { values: number[] }) {
  const ceiling = Math.max(1, ...values);
  const step = 100 / (values.length - 1);
  const points = values.map((value, index) => `${index * step},${24 - (value / ceiling) * 22 - 1}`).join(" ");
  return (
    <svg aria-hidden="true" className="ctl-metric__spark" preserveAspectRatio="none" viewBox="0 0 100 24">
      <polyline points={points} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* ── Trend chart ─────────────────────────────────────────────────────────── */

export interface TrendSeries {
  key: string;
  label: string;
  /** `bar`s stack in order; a `line` is drawn over them; `detail` only appears in the readout. */
  kind: "bar" | "line" | "detail";
  tone: "muted" | "ink" | "danger";
}

type Bucket = { start: string };

const COLUMN = 10;
const BAR = 6;
const HEIGHT = 100;

/** The smallest round number at or above `value`, so the scale reads cleanly. */
function niceCeiling(value: number): number {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= value) ?? 10;
  return step * magnitude;
}

function bucketFormatter(bucket: "hour" | "day", timezone: string, withWeekday = false) {
  return new Intl.DateTimeFormat(undefined, bucket === "hour"
    ? { hour: "2-digit", minute: "2-digit", timeZone: timezone }
    : { day: "numeric", month: "short", weekday: withWeekday ? "short" : undefined, timeZone: timezone });
}

/**
 * Bars for volume, a line for the measure that matters, one readout on hover
 * or arrow keys. Every bucket the backend sends is drawn, empty ones included,
 * so a quiet day reads as quiet rather than as missing.
 */
export function TrendChart<B extends Bucket>({
  buckets,
  series,
  bucket,
  timezone,
  label,
}: {
  buckets: B[];
  series: TrendSeries[];
  bucket: "hour" | "day";
  timezone: string;
  /** What the chart shows, for people who cannot see it. */
  label: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const hintId = useId();
  const count = buckets.length;
  const read = (row: B, key: string) => Number((row as Record<string, unknown>)[key] ?? 0);
  const bars = series.filter((item) => item.kind === "bar");
  const lines = series.filter((item) => item.kind === "line");
  const drawn = series.filter((item) => item.kind !== "detail");
  if (!count) return <p className="ctl-muted">Nothing to chart for this period.</p>;

  const ceiling = niceCeiling(Math.max(
    0,
    ...buckets.map((row) => Math.max(
      bars.reduce((sum, item) => sum + read(row, item.key), 0),
      ...lines.map((item) => read(row, item.key)),
    )),
  ));
  const width = count * COLUMN;
  const y = (value: number) => HEIGHT - (value / ceiling) * HEIGHT;
  const short = bucketFormatter(bucket, timezone);
  const long = bucketFormatter(bucket, timezone, true);
  const totals = series.map((item) => `${buckets.reduce((sum, row) => sum + read(row, item.key), 0).toLocaleString()} ${item.label.toLowerCase()}`);

  const move = (next: number) => setActive(Math.min(count - 1, Math.max(0, next)));
  const keys: Record<string, () => void> = {
    ArrowLeft: () => move((active ?? count) - 1),
    ArrowRight: () => move((active ?? -1) + 1),
    Home: () => move(0),
    End: () => move(count - 1),
    Escape: () => setActive(null),
  };
  const shown = active === null ? null : buckets[active];
  const middle = Math.floor(count / 2);

  return (
    <figure className="ctl-trend">
      <div className="ctl-trend__scale" aria-hidden="true">
        <span>{ceiling.toLocaleString()}</span>
        <span>{(ceiling / 2).toLocaleString()}</span>
        <span>0</span>
      </div>
      <div
        aria-describedby={hintId}
        aria-label={`${label}: ${totals.join(", ")}.`}
        className="ctl-trend__plot"
        onBlur={() => setActive(null)}
        onKeyDown={(event) => {
          const handler = keys[event.key];
          if (!handler) return;
          event.preventDefault();
          handler();
        }}
        onPointerLeave={() => setActive(null)}
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          if (box.width) move(Math.floor(((event.clientX - box.left) / box.width) * count));
        }}
        role="group"
        tabIndex={0}
      >
        <svg aria-hidden="true" className="ctl-trend__svg" preserveAspectRatio="none" viewBox={`0 0 ${width} ${HEIGHT}`}>
          {[0, HEIGHT / 2].map((line) => (
            <line className="ctl-trend__grid" key={line} vectorEffect="non-scaling-stroke" x1={0} x2={width} y1={line} y2={line} />
          ))}
          <line className="ctl-trend__baseline" vectorEffect="non-scaling-stroke" x1={0} x2={width} y1={HEIGHT} y2={HEIGHT} />
          {buckets.map((row, index) => {
            let top = HEIGHT;
            return (
              <g key={row.start}>
                {active === index && <rect className="ctl-trend__focus" height={HEIGHT} width={COLUMN} x={index * COLUMN} y={0} />}
                {bars.map((item) => {
                  const value = read(row, item.key);
                  if (!value) return null;
                  const height = HEIGHT - y(value);
                  top -= height;
                  return (
                    <rect
                      className="ctl-trend__bar"
                      data-tone={item.tone}
                      height={height}
                      key={item.key}
                      width={BAR}
                      x={index * COLUMN + (COLUMN - BAR) / 2}
                      y={top}
                    />
                  );
                })}
              </g>
            );
          })}
          {lines.map((item) => (
            <polyline
              className="ctl-trend__line"
              data-tone={item.tone}
              key={item.key}
              points={buckets.map((row, index) => `${index * COLUMN + COLUMN / 2},${y(read(row, item.key))}`).join(" ")}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {shown && active !== null && (
          <div
            aria-hidden="true"
            className="ctl-trend__readout"
            style={{
              left: `${((active + 0.5) / count) * 100}%`,
              transform: `translateX(${active < count / 4 ? "-12%" : active > (count * 3) / 4 ? "-88%" : "-50%"})`,
            }}
          >
            <strong>{long.format(new Date(shown.start))}</strong>
            {series.map((item) => (
              <span key={item.key}>
                <i className="ctl-swatch" data-kind={item.kind} data-tone={item.tone} />
                {item.label}
                <b>{read(shown, item.key).toLocaleString()}</b>
              </span>
            ))}
          </div>
        )}
      </div>
      <div aria-hidden="true" className="ctl-trend__axis">
        <span style={{ left: `${(0.5 / count) * 100}%` }}>{short.format(new Date(buckets[0].start))}</span>
        {count > 4 && (
          <span data-align="center" style={{ left: `${((middle + 0.5) / count) * 100}%` }}>
            {short.format(new Date(buckets[middle].start))}
          </span>
        )}
        <span data-align="end" style={{ left: `${((count - 0.5) / count) * 100}%` }}>
          {bucket === "hour" ? "Now" : "Today"}
        </span>
      </div>
      <figcaption className="ctl-legend">
        {drawn.map((item) => (
          <span key={item.key}>
            <i className="ctl-swatch" data-kind={item.kind} data-tone={item.tone} />
            {item.label}
          </span>
        ))}
      </figcaption>
      <p className="sr-only" id={hintId}>Use the arrow keys to read each interval.</p>
      <p aria-live="polite" className="sr-only">
        {shown
          ? `${long.format(new Date(shown.start))}: ${series.map((item) => `${read(shown, item.key)} ${item.label.toLowerCase()}`).join(", ")}`
          : ""}
      </p>
    </figure>
  );
}

/* ── Bar list ────────────────────────────────────────────────────────────── */

export interface BarListRow {
  key: string;
  label: React.ReactNode;
  value: number;
  /** One quiet line under the bar, e.g. "2 failed". */
  detail?: React.ReactNode;
  tone?: "ink" | "danger";
}

/** A ranked breakdown: each row's share drawn against the largest. */
export function BarList({ rows, empty }: { rows: BarListRow[]; empty: string }) {
  if (!rows.length) return <p className="ctl-muted">{empty}</p>;
  const largest = Math.max(1, ...rows.map((row) => row.value));
  return (
    <ul className="ctl-barlist">
      {rows.map((row) => (
        <li key={row.key}>
          <div className="ctl-barlist__row">
            <span className="ctl-barlist__label">{row.label}</span>
            <span className="ctl-barlist__value">{row.value.toLocaleString()}</span>
          </div>
          <div aria-hidden="true" className="ctl-barlist__track">
            <i data-tone={row.tone ?? "ink"} style={{ width: `${(row.value / largest) * 100}%` }} />
          </div>
          {row.detail && <span className="ctl-barlist__detail">{row.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

/* ── Composition ─────────────────────────────────────────────────────────── */

/** A titled panel on the dashboard grid. `aside` sits opposite the title. */
export function Panel({
  title,
  aside,
  className,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("ctl-panel", className)}>
      <header className="ctl-panel__head">
        <h2 className="ctl-panel__title" id={id}>{title}</h2>
        {aside && <div className="ctl-panel__aside">{aside}</div>}
      </header>
      {children}
    </section>
  );
}

/** Two or three panels side by side, collapsing to one column on narrow screens. */
export function PanelRow({ children, layout = "wide-narrow" }: { children: React.ReactNode; layout?: "wide-narrow" | "halves" }) {
  return <div className="ctl-panel-row" data-layout={layout}>{children}</div>;
}
