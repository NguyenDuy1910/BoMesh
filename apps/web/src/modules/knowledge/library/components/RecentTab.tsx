"use client";

import { Button, buttonVariants } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { History, X } from "lucide-react";
import NextLink from "next/link";
import { useMemo } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { toast } from "@/components/ui/Toast";
import { errorMessage } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { clearRecentItems } from "../../api";
import { ResourceList, ResourceRow } from "../../components/ResourceRow";
import { knowledgeKeys, useKnowledgeModel, useRecentItems } from "../../queries";
import { restoreRecentItem } from "../api";
import { useItemsByName } from "../queries";

const DAY = 86_400_000;

/** Recent reads grouped Today / This week / Earlier, clear with Undo (preview `recentTab`). */
export function RecentTab() {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const recent = useRecentItems();
  const items = useItemsByName((recent.data ?? []).map((r) => r.item));
  const { toResource } = useKnowledgeModel();

  const all = useMemo(
    () =>
      (recent.data ?? []).flatMap((r) => {
        const item = r.item ? items.items.get(r.item) : undefined;
        return item && item.state !== "DELETED" ? [{ resource: toResource(item), at: Date.parse(r.viewTime ?? "") || 0 }] : [];
      }),
    [recent.data, items.items, toResource],
  );

  async function clear() {
    const before = recent.data ?? [];
    try {
      await clearRecentItems(ws);
      void qc.invalidateQueries({ queryKey: knowledgeKeys.recent(ws) });
      toast("History cleared", {
        undo: () =>
          void Promise.all(before.map((r) => restoreRecentItem(ws, r))).then(
            () => qc.invalidateQueries({ queryKey: knowledgeKeys.recent(ws) }),
            (e: unknown) => toast(errorMessage(e), { tone: "danger" }),
          ),
      });
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    }
  }

  if (recent.isError && !recent.data) return <ErrorState error={recent.error} onRetry={() => void recent.refetch()} />;
  if (recent.isPending || items.isPending) return <SkeletonRows rows={6} />;
  if (items.isError && !all.length) return <ErrorState error={items.error} onRetry={items.refetch} />;
  if (!all.length) {
    return (
      <EmptyState
        icon={History}
        title="No recent reads"
        description="Resources you open show up here."
        actions={
          <NextLink href="/knowledge" className={buttonVariants({ variant: "primary" })}>
            Go to Discover
          </NextLink>
        }
        boxed
      />
    );
  }

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  const week = today - 6 * DAY;
  const groups: ReadonlyArray<readonly [string, (at: number) => boolean]> = [
    ["Today", (at) => at >= today],
    ["This week", (at) => at < today && at >= week],
    ["Earlier", (at) => at < week],
  ];

  return (
    <>
      <div className="toolbar">
        <span className="t-sm muted">{plural(all.length, "resource")}</span>
        <div className="toolbar__end">
          <Button size="sm" variant="ghost" onPress={() => void clear()}>
            <X className="i" aria-hidden />
            Clear history
          </Button>
        </div>
      </div>
      <div className="stack gap-24">
        {groups.map(([label, inGroup]) => {
          const rows = all.filter((x) => inGroup(x.at));
          if (!rows.length) return null;
          return (
            <section key={label} className="lib-group">
              <h2 className="lib-group__title">{label}</h2>
              <ResourceList>
                {rows.map(({ resource }) => (
                  <ResourceRow key={resource.id} resource={resource} compact />
                ))}
              </ResourceList>
            </section>
          );
        })}
      </div>
    </>
  );
}
