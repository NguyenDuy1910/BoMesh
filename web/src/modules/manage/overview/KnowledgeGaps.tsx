"use client";

import { Upload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ui } from "@/components/ui/design-system";
import { ErrorState } from "@/components/ui/ErrorState";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { describeRequestFailure } from "@/lib/api/errors";
import { cn } from "@/lib/cn";
import { listKnowledgeGaps, updateKnowledgeGap, type KnowledgeGap, type KnowledgeGapReason } from "@/modules/manage/overview/api";
import { useApiData } from "@/lib/hooks/useApiData";

const REASON: Record<KnowledgeGapReason, string> = {
  not_covered: "No document covers it",
  outdated: "Only an outdated document mentions it",
  rated_unhelpful: "Answers were rated unhelpful",
};

/**
 * The questions people asked this week that knowledge could not answer well,
 * each with the place to add the missing documents (`analytics.knowledge_gaps`,
 * API pending).
 */
export function KnowledgeGaps({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const toast = useToast();
  const gaps = useApiData(() => listKnowledgeGaps(workspaceId, { window: "7d" }), workspaceId);
  // Dismissed rows leave at once; the server answer catches up after.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  async function setDismissed(gap: KnowledgeGap, dismissed: boolean) {
    setHidden((current) => {
      const next = new Set(current);
      if (dismissed) next.add(gap.id);
      else next.delete(gap.id);
      return next;
    });
    try {
      await updateKnowledgeGap(workspaceId, gap.id, { dismissed });
      if (dismissed) {
        toast.show({
          message: "Gap dismissed",
          action: { label: "Undo", onClick: () => void setDismissed(gap, false) },
        });
      }
    } catch (cause) {
      setHidden((current) => {
        const next = new Set(current);
        if (dismissed) next.delete(gap.id);
        else next.add(gap.id);
        return next;
      });
      toast.show({ tone: "err", message: describeRequestFailure(cause, dismissed ? "Dismissing the gap" : "Undoing the dismissal") });
    }
  }

  const visible = gaps.data?.items.filter((gap) => !gap.dismissed && !hidden.has(gap.id)) ?? [];

  return (
    <section aria-labelledby="overview-gaps" className="mt-7">
      <div className="mb-3">
        <h2 className={cn(ui.sectionTitle, "flex items-center gap-2")} id="overview-gaps">
          Knowledge gaps <PreviewTag />
        </h2>
        <p className="mt-0.5 text-meta text-text-tertiary">
          Questions people asked this week that knowledge couldn’t answer well.
        </p>
      </div>
      {gaps.error ? (
        <ErrorState description={gaps.error} layout="inline" onAction={gaps.reload} title="Knowledge gaps didn’t load" />
      ) : !gaps.data ? (
        <SkeletonRows columns={2} label="Loading knowledge gaps" rows={3} />
      ) : !visible.length ? (
        <Callout title="No gaps this week" tone="ok">Every frequent question found a good answer.</Callout>
      ) : (
        <ul className={cn(ui.card, "divide-y divide-border-subtle overflow-hidden")}>
          {visible.map((gap) => (
            <li className="flex items-center gap-3 px-4 py-3.5 max-[640px]:flex-wrap" key={gap.id}>
              <span
                className="inline-flex h-6 min-w-9 shrink-0 items-center justify-center rounded-sm bg-surface-inset px-1.5 text-caption font-semibold tabular-nums text-text-secondary"
                title={`Asked ${gap.times_asked} ${gap.times_asked === 1 ? "time" : "times"} this week`}
              >
                {gap.times_asked}×
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-body font-medium text-text-primary">“{gap.question}”</p>
                <p className="truncate text-meta text-text-tertiary">
                  {gap.suggested_collection_title
                    ? `Best place to add it: ${gap.suggested_collection_title} · ${REASON[gap.reason]}`
                    : REASON[gap.reason]}
                </p>
              </div>
              <Button
                icon={<Upload aria-hidden="true" />}
                onClick={() =>
                  router.push(
                    gap.suggested_collection_id
                      ? `/knowledge/${encodeURIComponent(gap.suggested_collection_id)}?action=upload`
                      : "/knowledge",
                  )
                }
                size="sm"
                variant="secondary"
              >
                Add documents
              </Button>
              <Button
                aria-label={`Dismiss “${gap.question}”`}
                icon={<X aria-hidden="true" />}
                iconOnly
                onClick={() => void setDismissed(gap, true)}
                size="sm"
                variant="ghost"
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
