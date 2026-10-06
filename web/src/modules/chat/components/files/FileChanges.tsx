"use client";

import { GitCompareArrows, Layers } from "lucide-react";
import { useMemo } from "react";

import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/cn";

import { IncrementalMarkdown } from "../IncrementalMarkdown";
import { blockChangeCounts, diffBlocks, diffLines, diffMarkdown, diffSheet, sheetHasChanges, type BlockChange } from "./diff";
import { DocPage } from "./DocPage";
import { canCompare, type FileRevision } from "./file-model";
import { LoadError, PageSkeleton } from "./FilePreview";
import { SheetChanges, sheetChangeSummary } from "./SheetGrid";
import { revisionKey, useAsync, type FileDetail, type RevisionContents, type RevisionModel } from "./useFileData";

type Comparison =
  | { kind: "sheets"; before: Extract<RevisionModel, { kind: "sheets" }>; after: Extract<RevisionModel, { kind: "sheets" }>; summary: string; changed: boolean }
  | { kind: "blocks"; changes: BlockChange[]; markdown: boolean; summary: string; changed: boolean }
  | { kind: "none" };

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function compare(before: RevisionModel, after: RevisionModel): Comparison {
  if (before.kind === "sheets" && after.kind === "sheets") {
    const diffs = after.sheets.map((sheet, index) => diffSheet(before.sheets.find((candidate) => candidate.name === sheet.name) ?? before.sheets[index], sheet));
    const removedSheets = before.sheets.filter((sheet) => !after.sheets.some((candidate) => candidate.name === sheet.name)).length;
    const summary = [sheetChangeSummary(diffs), removedSheets && `${plural(removedSheets, "sheet")} removed`].filter(Boolean).join(" · ");
    return { kind: "sheets", before, after, summary, changed: removedSheets > 0 || diffs.some(sheetHasChanges) };
  }
  let changes: BlockChange[] | null = null;
  if (before.kind === "markdown" && after.kind === "markdown") changes = diffMarkdown(before.text, after.text);
  else if (before.kind === "text" && after.kind === "text") changes = diffLines(before.text, after.text);
  else if (before.kind === "blocks" && after.kind === "blocks") changes = diffBlocks(before.blocks, after.blocks);
  if (!changes) return { kind: "none" };
  const { added, removed } = blockChangeCounts(changes);
  const unit = after.kind === "text" ? "line" : "section";
  return {
    kind: "blocks",
    changes,
    markdown: after.kind !== "text",
    summary: [added && `${plural(added, unit)} added or changed`, removed && `${plural(removed, unit)} removed`].filter(Boolean).join(" · "),
    changed: added + removed > 0,
  };
}

function Legend({ changed, summary }: { changed: boolean; summary: string }) {
  const swatch = "mr-1.5 inline-block size-2.5 rounded-[3px] align-[-1px]";
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 px-4 pt-3 text-[length:var(--text-size-caption)] text-text-secondary">
      <span><i aria-hidden="true" className={cn(swatch, "bg-status-success-bg shadow-[inset_0_0_0_1px_var(--status-success-text)]")} />Added</span>
      {changed && <span><i aria-hidden="true" className={cn(swatch, "bg-status-info-bg shadow-[inset_0_0_0_1px_var(--status-info-text)]")} />Changed</span>}
      <span><i aria-hidden="true" className={cn(swatch, "bg-status-danger-bg shadow-[inset_0_0_0_1px_var(--status-danger-text)]")} />Removed</span>
      <span className="ml-auto font-medium text-text-primary">{summary}</span>
    </div>
  );
}

/** What changed from the previous version to this one. */
export function FileChanges({
  contents,
  detail,
  previous,
  revision,
}: {
  contents: RevisionContents;
  detail: FileDetail;
  revision: FileRevision;
  previous: FileRevision | undefined;
}) {
  const key = previous && canCompare(detail.kind)
    ? `${revisionKey(detail.id, previous)}->${revisionKey(detail.id, revision)}`
    : null;
  const models = useAsync(key, () => Promise.all([contents.model(previous!), contents.model(revision)]));
  const comparison = useMemo(() => (models.value ? compare(models.value[0], models.value[1]) : null), [models.value]);

  if (!previous) {
    return (
      <div className="p-4">
        <EmptyState
          description="Changes show here once there’s a newer version to compare."
          icon={<Layers />}
          size="sm"
          title="This is the first version"
        />
      </div>
    );
  }
  if (!canCompare(detail.kind) || comparison?.kind === "none") {
    return (
      <div className="p-4">
        <EmptyState
          description="Download both versions to compare them."
          icon={<GitCompareArrows />}
          size="sm"
          title="Changes can’t be shown for this file"
        />
      </div>
    );
  }
  if (models.failure) {
    return (
      <LoadError
        failure={models.failure}
        onRetry={() => {
          contents.forget(previous);
          contents.forget(revision);
          models.retry();
        }}
      />
    );
  }
  if (!comparison || !models.value) return <PageSkeleton label="Comparing versions" />;

  if (!comparison.changed) {
    return (
      <div className="p-4">
        <EmptyState
          description={`Version ${revision.revision} has the same content as version ${previous.revision}.`}
          icon={<GitCompareArrows />}
          size="sm"
          title="No changes"
        />
      </div>
    );
  }

  const truncated = models.value.some((model) => "truncated" in model && model.truncated);
  return (
    <div>
      <Legend changed={comparison.kind === "sheets"} summary={comparison.summary} />
      {truncated && (
        <div className="px-4 pt-3">
          <Callout tone="neutral">Only the first part of each version could be compared.</Callout>
        </div>
      )}
      {comparison.kind === "sheets" ? (
        <SheetChanges after={comparison.after.sheets} before={comparison.before.sheets} />
      ) : (
        <div className="p-4">
          <DocPage>
            {comparison.changes.map((change, index) => (
              <div
                className={cn(
                  // Each block is rendered alone, so its own margins go and the list sets the rhythm.
                  "relative -mx-2.5 mb-1.5 rounded-[6px] px-2.5 py-1 [&_*]:my-0!",
                  /^\s*#/.test(change.text) && index > 0 && "mt-4",
                  change.status === "added" && "bg-status-success-bg pr-[84px] shadow-[inset_3px_0_0_var(--status-success-text)]",
                  change.status === "removed" && "bg-status-danger-bg pr-[84px] text-text-secondary line-through shadow-[inset_3px_0_0_var(--status-danger-text)]",
                  change.status === "same" && "text-text-tertiary",
                )}
                key={`${index}-${change.status}`}
              >
                {change.status !== "same" && (
                  <span
                    className={cn(
                      "absolute right-2 top-1.5 inline-block text-[length:var(--text-size-caption)] font-semibold uppercase tracking-[0.03em] no-underline",
                      change.status === "added" ? "text-status-success-text" : "text-status-danger-text",
                    )}
                  >
                    {change.status === "added" ? "Added" : "Removed"}
                  </span>
                )}
                {comparison.markdown ? (
                  <IncrementalMarkdown isStreaming={false} text={change.text} />
                ) : (
                  <p className="whitespace-pre-wrap break-words font-mono text-[13px]">{change.text}</p>
                )}
              </div>
            ))}
          </DocPage>
        </div>
      )}
    </div>
  );
}
