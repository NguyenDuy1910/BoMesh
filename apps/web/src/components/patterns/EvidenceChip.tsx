"use client";

import { FileText, Lock } from "lucide-react";
import Link from "next/link";

import { cn } from "@/lib/cn";

/**
 * A source an answer or artifact was built from: optional evidence numeral,
 * file icon and title. `locked` sources exist but the reader cannot open
 * them — lock icon, no link, and an accessible "no access" note.
 */
export function EvidenceChip({
  title,
  n,
  icon,
  locked = false,
  href,
  onClick,
  tooltip,
  className,
}: {
  title: string;
  /** The citation number this source answers to. */
  n?: number;
  /** A file-type icon (e.g. `FileTypeIcon` at 16px). Defaults to a document glyph. */
  icon?: React.ReactNode;
  locked?: boolean;
  href?: string;
  onClick?: () => void;
  /** Native title; defaults to the source title ("Handbook.pdf · page 31" is typical). */
  tooltip?: string;
  className?: string;
}) {
  const interactive = !locked && Boolean(href || onClick);
  const classes = cn(
    "inline-flex h-6 max-w-[260px] shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] pl-1 pr-2",
    "bg-[var(--surface-subtle)] text-[length:var(--text-size-meta)] text-[var(--text-secondary)] shadow-[inset_0_0_0_1px_var(--border-subtle)]",
    interactive &&
      "cursor-pointer transition-[box-shadow,color] duration-[var(--duration-fast)] hover:text-[var(--text-primary)] hover:shadow-[inset_0_0_0_1px_var(--border-strong)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
    locked && "text-[var(--text-tertiary)]",
    className,
  );
  const content = (
    <>
      {n !== undefined && (
        <span className="rounded-[var(--radius-xs)] bg-[var(--evidence-bg)] px-[5px] py-0.5 font-[family-name:var(--font-mono)] text-[11px] font-semibold leading-none text-[var(--evidence-text)]">
          {n}
        </span>
      )}
      <span aria-hidden="true" className={cn("inline-flex shrink-0", n === undefined && "pl-0.5")}>
        {locked ? <Lock size={13} /> : (icon ?? <FileText size={14} />)}
      </span>
      <span className="min-w-0 truncate">{title}</span>
      {locked && <span className="sr-only">, you don’t have access</span>}
    </>
  );
  const label = tooltip ?? title;

  if (interactive && href) {
    return (
      <Link className={classes} href={href} title={label}>
        {content}
      </Link>
    );
  }
  if (interactive) {
    return (
      <button className={classes} onClick={onClick} title={label} type="button">
        {content}
      </button>
    );
  }
  return (
    <span className={classes} title={locked ? `${title} · No access` : label}>
      {content}
    </span>
  );
}
