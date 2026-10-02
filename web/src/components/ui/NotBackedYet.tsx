"use client";

import { Clock3 } from "lucide-react";

interface NotBackedYetProps {
  /** What this screen will manage, in the reader's words. */
  title: string;
  /** What happens today instead, and what will change. No implementation terms. */
  description: string;
}

/**
 * A section that is planned but not available yet.
 *
 * It sits under the page's real header, aligned with the rest of the page, so
 * the section still reads as part of the product. It states what happens
 * today rather than rendering invented settings — a person deciding whether a
 * change took effect is never left guessing.
 */
export function NotBackedYet({ title, description }: NotBackedYetProps) {
  return (
    <div
      className="flex max-w-2xl items-start gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-inset)] px-4 py-3.5"
      role="status"
    >
      <Clock3 aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--text-tertiary)]" size={18} />
      <div className="min-w-0">
        <p className="text-[length:var(--text-size-ui)] font-semibold leading-[var(--text-lh-ui)] text-[var(--text-primary)]">
          {title}
        </p>
        <p className="mt-1 text-pretty text-[length:var(--text-size-ui)] leading-[var(--text-lh-ui)] text-[var(--text-secondary)]">
          {description}
        </p>
      </div>
    </div>
  );
}
