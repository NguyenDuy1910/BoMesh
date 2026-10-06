import { cn } from "@/lib/cn";

export type MeterTone = "accent" | "ok" | "warn" | "err" | "info" | "neutral";

/* Status text colours double as segment fills: they already clear contrast
   against the inset track in both themes. */
const toneColor: Record<MeterTone, string> = {
  accent: "var(--accent-primary)",
  ok: "var(--status-success-text)",
  warn: "var(--status-warning-text)",
  err: "var(--status-danger-text)",
  info: "var(--status-info-text)",
  neutral: "var(--border-strong)",
};

export interface MeterSegment {
  label: string;
  value: number;
  tone: MeterTone;
}

interface MeterProps {
  /** Accessible name, e.g. "Knowledge health". */
  label: string;
  segments: readonly MeterSegment[];
  /** The whole the segments are part of. Defaults to their sum. */
  max?: number;
  /** Render the labelled legend under the bar. Defaults to `true`. */
  legend?: boolean;
  formatValue?: (value: number) => string;
  className?: string;
}

/**
 * One bar split into labelled parts (documents ready / processing / failed).
 * Colour is never the only carrier: the legend names every part with its value.
 */
export function Meter({ label, segments, max, legend = true, formatValue = String, className }: MeterProps) {
  const total = max ?? segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  const summary = segments.map((segment) => `${segment.label} ${formatValue(segment.value)}`).join(", ");

  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      <div
        aria-label={`${label}: ${summary}`}
        className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-[var(--surface-inset)]"
        role="img"
      >
        {total > 0 &&
          segments.map((segment) =>
            segment.value > 0 ? (
              <span
                className="block h-full"
                key={segment.label}
                style={{ width: `${(segment.value / total) * 100}%`, background: toneColor[segment.tone] }}
              />
            ) : null,
          )}
      </div>
      {legend && (
        <Legend
          items={segments.map((segment) => ({ ...segment, value: formatValue(segment.value) }))}
        />
      )}
    </div>
  );
}

interface LegendProps {
  items: readonly { label: string; tone: MeterTone; value?: React.ReactNode }[];
  className?: string;
}

/** Swatch + label (+ value) keys for a Meter or a chart. */
export function Legend({ items, className }: LegendProps) {
  return (
    <ul
      className={cn(
        "flex flex-wrap gap-x-4 gap-y-1.5 text-[length:var(--text-size-meta)] text-[var(--text-secondary)]",
        className,
      )}
    >
      {items.map((item) => (
        <li className="inline-flex items-center gap-1.5" key={item.label}>
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: toneColor[item.tone] }} />
          <span>{item.label}</span>
          {item.value !== undefined && (
            <span className="tabular-nums font-medium text-[var(--text-primary)]">{item.value}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
