import { fmtNum } from "@/lib/format";

export interface BarsChartProps {
  values: readonly number[];
  /** Chart height in px (default 120); the chart stretches to the container width. */
  height?: number;
  /** Per-bar label for the hover title ("Mar 4"). */
  labels?: readonly string[];
  /** Value formatter for the hover title (default `fmtNum`). */
  format?: (value: number) => string;
  /** Emphasise only the last bar (the current period) — default; `false` makes every bar solid. */
  highlightLast?: boolean;
  /** Accessible summary (default "Bar chart"). */
  label?: string;
}

/** Theme-aware inline SVG bar chart (preview `bars()`): accent bars, the latest one solid. */
export function BarsChart({ values, height = 120, labels = [], format = fmtNum, highlightLast = true, label = "Bar chart" }: BarsChartProps) {
  const max = Math.max(...values, 1);
  const w = 100 / Math.max(values.length, 1);
  return (
    <svg className="chart" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" height={height} role="img" aria-label={label}>
      {values.map((v, i) => {
        const h = Math.max(1.5, (v / max) * (height - 4));
        const solid = !highlightLast || i === values.length - 1;
        return (
          <rect key={i} className={solid ? "chart__bar" : "chart__bar chart__bar--dim"} x={i * w + w * 0.18} y={height - h} width={w * 0.64} height={h} rx={0.8}>
            <title>{`${labels[i] ?? ""} ${format(v)}`.trim()}</title>
          </rect>
        );
      })}
    </svg>
  );
}
