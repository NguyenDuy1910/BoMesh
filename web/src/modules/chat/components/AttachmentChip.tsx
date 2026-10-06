import Link from "next/link";
import { AlertCircle, Lock, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { documentHref } from "@/modules/knowledge/preview";
import { FileIcon } from "./FileIcon";

export interface AttachmentChipModel {
  name: string;
  kind: "upload" | "reference";
  stage: "uploading" | "reading" | "ready" | "failed";
  fraction?: number;
  error?: string;
  documentId?: string;
  sourceTitle?: string;
  /** A referenced knowledge document the caller can no longer open. */
  locked?: boolean;
}

/**
 * One file on a message: uploading with its percentage, being read, ready,
 * refused with the reason, or referenced from knowledge (read in place, and
 * locked when the reader no longer has access).
 */
export function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: AttachmentChipModel;
  /** Composer only: remove before sending. */
  onRemove?: () => void;
}) {
  const { name, kind, stage, fraction, error, documentId, sourceTitle, locked } = attachment;
  const percent = stage === "uploading" ? Math.round((fraction ?? 0) * 100) : null;
  const failed = stage === "failed";
  const status = failed
    ? error ?? "Can’t attach"
    : stage === "uploading" ? `${percent}%` : stage === "reading" ? "Reading…" : null;
  const meta = kind === "reference" ? (locked ? "No access" : sourceTitle ?? "Knowledge") : null;
  const classes = cn(
    "relative inline-flex h-[30px] max-w-[280px] items-center gap-1.5 overflow-hidden rounded-md pl-1 text-[0.78125rem] text-text-secondary",
    onRemove ? "pr-1" : "pr-2",
    failed
      ? "bg-status-danger-bg text-status-danger"
      : locked
        ? "bg-surface-subtle shadow-[inset_0_0_0_1px_var(--border-subtle)]"
        : kind === "reference" ? "bg-surface-selected text-text-accent" : "bg-surface-inset",
  );
  const title = failed
    ? `${name}: ${error ?? "can’t be attached"}`
    : kind === "reference" ? (locked ? `${name} · No access` : `${name} · From knowledge — read in place, not copied`) : name;
  const content = (
    <>
      {failed ? (
        <AlertCircle aria-hidden="true" className="ml-1 shrink-0" size={14} />
      ) : locked ? (
        <Lock aria-hidden="true" className="ml-1 shrink-0" size={14} />
      ) : (
        <FileIcon name={name} size={20} />
      )}
      <span className={cn("min-w-0 truncate", failed ? "text-status-danger" : "text-text-primary")}>{name}</span>
      {meta && <span className="shrink-0 whitespace-nowrap opacity-80">· {meta}</span>}
      {status && (
        <span className={cn("min-w-0 truncate whitespace-nowrap", failed ? "" : "font-mono text-text-tertiary")} role={failed ? "alert" : undefined}>
          {failed ? `· ${status}` : status}
        </span>
      )}
      {onRemove && (stage === "ready" || failed) && (
        <button
          aria-label={`Remove ${name}`}
          className="grid size-5 shrink-0 place-items-center rounded-xs text-text-tertiary hover:bg-surface-pressed hover:text-text-primary focus-visible:shadow-(--shadow-focus) focus-visible:outline-none"
          onClick={onRemove}
          type="button"
        >
          <X aria-hidden="true" size={13} />
        </button>
      )}
      {percent !== null && (
        <span
          aria-hidden="true"
          className="absolute bottom-0 left-0 h-0.5 bg-accent-primary transition-[width] duration-(--duration-base) motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      )}
    </>
  );

  if (!onRemove && documentId && !locked && !failed) {
    return (
      <Link
        className={cn(classes, "hover:text-text-primary focus-visible:shadow-(--shadow-focus) focus-visible:outline-none")}
        href={documentHref(documentId)}
        title={`Open ${name}`}
      >
        {content}
      </Link>
    );
  }
  return (
    <span aria-label={stage === "uploading" ? `${name}, uploading ${percent}%` : undefined} className={classes} role="group" title={title}>
      {content}
    </span>
  );
}
