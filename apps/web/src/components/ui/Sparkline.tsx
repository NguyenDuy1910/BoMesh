import type { Tone } from "./StatusChip";

export interface SparklineProps {
  values: readonly number[];
  /** Height in px (default 36); the line stretches to the container width. */
  height?: number;
  /** Line color (default accent). */
  tone?: Exclude<Tone, "default">;
}

/** Decorative trend line with a soft area fill (preview `sparkline()`); pair it with the number it summarises. */
export function Sparkline({ values, height = 36, tone = "accent" }: SparklineProps) {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const n = values.length;
  const d = values
    .map((v, i) => {
      const x = (i / Math.max(1, n - 1)) * 100;
      const y = height - 2 - ((v - min) / Math.max(1, max - min)) * (height - 4);
      return `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <svg className={`chart sparkline sparkline--${tone}`} viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" height={height} aria-hidden>
      {n ? <path className="sparkline__area" d={`${d} L100 ${height} L0 ${height} Z`} /> : null}
      {n ? <path className="sparkline__line" d={d} vectorEffect="non-scaling-stroke" /> : null}
    </svg>
  );
}
