"use client";

import { ChevronRight } from "lucide-react";
import { memo } from "react";

import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { FileTypeIcon, fileTypeOf } from "@/modules/knowledge/components/FileTypeIcon";

import { artifactFormatLabel, artifactSizeLabel, type TurnArtifact } from "../../artifacts";

/**
 * A file the assistant made, under the answer that presents it. The whole
 * card opens the file panel at the version this answer made.
 */
export const FileCard = memo(function FileCard({
  active = false,
  artifact,
  onOpen,
}: {
  artifact: TurnArtifact;
  onOpen: (artifactId: string, revision?: number) => void;
  /** This file and version are open in the panel. */
  active?: boolean;
}) {
  const type = fileTypeOf(artifact.mimeType, artifact.fileName);
  return (
    <button
      aria-label={`Open ${artifact.title}, version ${artifact.revision}`}
      aria-pressed={active}
      className={cn(
        "group flex min-w-0 items-center gap-3 rounded-(--radius-sheet) border border-border-subtle bg-surface-base py-2.5 pl-3 pr-2.5 text-left",
        "transition-[border-color,box-shadow] duration-(--duration-fast) hover:border-border-default hover:shadow-(--shadow-2)",
        "focus-visible:outline-none focus-visible:shadow-(--shadow-focus)",
        active && "border-accent-primary shadow-[0_0_0_1px_var(--accent-primary)] hover:border-accent-primary",
      )}
      onClick={() => onOpen(artifact.id, artifact.revision)}
      type="button"
    >
      <FileTypeIcon decorative kind={type.kind} label={type.label} size="lg" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[length:var(--text-size-body)] font-medium text-text-primary">{artifact.title}</span>
          {artifact.revision > 1 && (
            <Badge className="shrink-0" dot={false} tone="outline">
              v{artifact.revision}
            </Badge>
          )}
        </span>
        <span className="mt-px block truncate text-[length:var(--text-size-caption)] text-text-tertiary">
          {[artifactFormatLabel(artifact.mimeType), artifact.sizeBytes > 0 ? artifactSizeLabel(artifact.sizeBytes) : null].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5 text-[length:var(--text-size-meta)] font-medium text-text-tertiary group-hover:text-text-accent">
        Open
        <ChevronRight aria-hidden="true" className="size-4" />
      </span>
    </button>
  );
});

/** The files one answer made, as a grid of cards. */
export function FileCards({
  activeId,
  artifacts,
  onOpen,
}: {
  artifacts: readonly TurnArtifact[];
  /** `id` or `id:revision` of the file open in the panel. */
  activeId?: string;
  onOpen: (artifactId: string, revision?: number) => void;
}) {
  if (!artifacts.length) return null;
  return (
    <div aria-label="Files from this answer" className="mt-3.5 grid max-w-[620px] grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-2" role="group">
      {artifacts.map((artifact) => (
        <FileCard
          active={activeId === artifact.id || activeId === `${artifact.id}:${artifact.revision}`}
          artifact={artifact}
          key={artifact.id}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}
