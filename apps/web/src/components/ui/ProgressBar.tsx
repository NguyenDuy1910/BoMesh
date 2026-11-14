import clsx from "clsx";

export interface ProgressBarProps {
  /** 0–100. */
  value: number;
  tone?: "accent" | "success" | "warning" | "danger";
  /** Accessible name. */
  label?: string;
}

/** Thin progress bar (preview `progress()`, HeroUI ProgressBar visuals). */
export function ProgressBar({ value, tone, label = "Progress" }: ProgressBarProps) {
  return (
    <div
      className={clsx("progress-bar", tone && `progress-bar--${tone}`)}
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span className="progress-bar__fill" style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
    </div>
  );
}
