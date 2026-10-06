"use client";

import { useState } from "react";

import { cn } from "@/lib/cn";

export interface BarDatum {
  /** The period, e.g. "Mar 4". Shown in the hover bubble and the data table. */
  label: string;
  value: number;
}

interface BarsChartProps {
  data: readonly BarDatum[];
  /** What is counted, e.g. "Questions per day, last 30 days". Caption of the data table. */
  label: string;
  /** Plot height in pixels. Defaults to 120. */
  height?: number;
  formatValue?: (value: number) => string;
  /** First and last labels under the plot. Defaults to `true`. */
  axis?: boolean;
  className?: string;
}

/**
 * A small vertical bar chart for daily usage. The latest bar is drawn in the
 * accent colour and the rest muted. Screen readers get the same numbers as a
 * table; pointer users get a bubble on hover.
 */
export function BarsChart({
  data,
  label,
  height = 120,
  formatValue = (value) => value.toLocaleString(),
  axis = true,
  className,
}: BarsChartProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((datum) => datum.value));
  const active = hovered === null ? null : data[hovered];

  return (
    <figure className={cn("relative m-0 w-full", className)}>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {data.map((datum) => (
            <tr key={datum.label}>
              <th scope="row">{datum.label}</th>
              <td>{formatValue(datum.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div aria-hidden="true" className="relative" onPointerLeave={() => setHovered(null)}>
        <div className="flex w-full items-end" style={{ height }}>
          {data.map((datum, index) => (
            <div
              className="flex h-full min-w-0 flex-1 items-end justify-center"
              key={datum.label}
              onPointerEnter={() => setHovered(index)}
            >
              <span
                className={cn(
                  "block w-[72%] rounded-t-[2px] transition-colors duration-[var(--duration-fast)]",
                  index === hovered
                    ? "bg-[var(--accent-hover)]"
                    : index === data.length - 1
                      ? "bg-[var(--accent-primary)]"
                      : "bg-[var(--accent-soft-hover)]",
                )}
                style={{ height: `max(1.5px, ${(Math.max(0, datum.value) / max) * 100}%)` }}
              />
            </div>
          ))}
        </div>
        {active && hovered !== null && (
          <span
            className={cn(
              "pointer-events-none absolute top-0 z-10 w-max -translate-y-[calc(100%+6px)] rounded-[var(--radius-sm)] px-2 py-1",
              "bg-[var(--surface-inverse)] text-[length:var(--text-size-caption)] font-medium text-[var(--text-inverse)]",
              hovered > data.length / 2 ? "-translate-x-full" : "",
            )}
            style={{ left: `${((hovered + (hovered > data.length / 2 ? 1 : 0)) / data.length) * 100}%` }}
          >
            {active.label} · {formatValue(active.value)}
          </span>
        )}
      </div>
      {axis && data.length > 1 && (
        <figcaption
          aria-hidden="true"
          className="mt-1.5 flex justify-between text-[length:var(--text-size-caption)] text-[var(--text-tertiary)]"
        >
          <span>{data[0].label}</span>
          <span>{data[data.length - 1].label}</span>
        </figcaption>
      )}
    </figure>
  );
}
