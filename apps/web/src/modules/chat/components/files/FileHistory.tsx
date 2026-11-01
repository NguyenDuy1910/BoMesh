"use client";

import { BookUp, ChevronRight } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { cn } from "@/lib/cn";
import { formatBytes, formatDateTime, formatRelative } from "@/lib/format";

import { revisionTitle, type FileRevision } from "./file-model";

/** A copy saved to knowledge from this panel, as the publish call reported it. */
export interface SavedCopy {
  collectionId: string;
  collectionTitle: string;
  revision: number;
  savedAt: string;
}

/**
 * Every version, newest first, with View and Restore; then where this panel
 * saved copies. Restoring makes a new version — nothing is overwritten.
 */
export function FileHistory({
  canRestore,
  canSave,
  onRestore,
  onSave,
  onView,
  revisions,
  saved,
  selected,
}: {
  revisions: readonly FileRevision[];
  selected: number;
  canRestore: boolean;
  canSave: boolean;
  onView: (revision: number) => void;
  onRestore: (revision: number) => void;
  onSave: () => void;
  saved: readonly SavedCopy[];
}) {
  const latest = revisions.at(-1)?.revision;
  return (
    <div className="flex flex-col gap-6 p-4">
      <section aria-labelledby="file-history-versions">
        <h3 className="mb-2.5 text-[length:var(--text-size-section)] font-semibold" id="file-history-versions">
          Versions
        </h3>
        <ol className="flex flex-col gap-2">
          {[...revisions].reverse().map((revision) => {
            const current = revision.revision === selected;
            return (
              <li
                aria-current={current || undefined}
                className={cn(
                  "flex items-start gap-3 rounded-(--radius-sheet) border border-border-subtle bg-surface-base px-3.5 py-3",
                  current && "border-accent-primary shadow-[0_0_0_1px_var(--accent-primary)]",
                )}
                key={`${revision.revision}-${revision.local}`}
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface-inset font-mono text-[length:var(--text-size-caption)] font-semibold">
                  v{revision.revision}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{revisionTitle(revision, revision === revisions[0])}</span>
                    {revision.revision === latest && <Badge dot={false} tone="accent">Latest</Badge>}
                    {revision.local && <PreviewTag />}
                  </div>
                  <p className="mt-px text-[length:var(--text-size-meta)] text-text-tertiary">
                    {revision.author === "you" ? (revision.restoredFrom !== null ? "Restored by you" : "Edited by you") : "By the assistant"}
                    {revision.createdAt && <> · <span title={formatDateTime(revision.createdAt)}>{formatRelative(revision.createdAt)}</span></>}
                    {revision.sizeBytes > 0 && <> · {formatBytes(revision.sizeBytes)}</>}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  {!current && (
                    <Button onClick={() => onView(revision.revision)} size="sm" variant="secondary">
                      View
                    </Button>
                  )}
                  {canRestore && revision.revision !== latest && (
                    <Button onClick={() => onRestore(revision.revision)} size="sm" variant="ghost">
                      Restore
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        {canRestore && (
          <p className="mt-2 flex items-center gap-2 text-[length:var(--text-size-meta)] text-text-tertiary">
            Restoring makes a new version. Nothing is overwritten.
            <PreviewTag />
          </p>
        )}
      </section>

      <section aria-labelledby="file-history-saved">
        <div className="mb-2.5 flex items-center justify-between gap-3">
          <h3 className="text-[length:var(--text-size-section)] font-semibold" id="file-history-saved">
            Saved to knowledge
          </h3>
          {canSave && (
            <Button icon={<BookUp aria-hidden="true" className="size-4" />} onClick={onSave} size="sm" variant="secondary">
              Save to knowledge
            </Button>
          )}
        </div>
        {saved.length ? (
          <ul className="flex flex-col divide-y divide-border-subtle rounded-(--radius-lg) border border-border-subtle bg-surface-base">
            {saved.map((copy) => (
              <li className="flex items-center gap-3 px-3.5 py-2.5" key={`${copy.collectionId}-${copy.revision}`}>
                <BookUp aria-hidden="true" className="size-4 shrink-0 text-text-tertiary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{copy.collectionTitle}</div>
                  <div className="text-[length:var(--text-size-meta)] text-text-tertiary">
                    Version {copy.revision} · {formatRelative(copy.savedAt)}
                  </div>
                </div>
                <Link
                  className="inline-flex items-center gap-1 rounded-sm text-[length:var(--text-size-meta)] font-medium text-text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  href={`/knowledge/${encodeURIComponent(copy.collectionId)}`}
                >
                  Open
                  <ChevronRight aria-hidden="true" className="size-3.5" />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-text-tertiary">
            Save a copy to a knowledge base so the people who can open it can find and cite it.
          </p>
        )}
      </section>
    </div>
  );
}
