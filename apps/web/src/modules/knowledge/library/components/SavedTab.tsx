"use client";

import { Button, buttonVariants } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Bookmark, ListPlus } from "lucide-react";
import NextLink from "next/link";
import { useMemo, useState } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { NoMatches } from "@/components/ui/NoMatches";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { toast } from "@/components/ui/Toast";
import { errorMessage } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { createSavedItem, deleteSavedItem } from "../../api";
import { openAddToCollection } from "../../components/dialogs";
import { ResourceList, ResourceRow } from "../../components/ResourceRow";
import { fold, tokens, type Resource } from "../../model";
import { knowledgeKeys, useKnowledgeModel, useSavedItems } from "../../queries";
import { useItemsByName } from "../queries";
import { BulkBar, SortMenu } from "./parts";

const SAVED_SORTS = { saved: "Recently saved", updated: "Recently updated", title: "Title A–Z" } as const;
type SavedSort = keyof typeof SAVED_SORTS;

/** Every search word appears in the title, summary, type or base (preview `scoreRes > 0`). */
export function matchesWords(r: Resource, words: readonly string[]): boolean {
  if (!words.length) return true;
  const hay = fold([r.title, r.fileName, r.summary, r.kindMeta.label, r.base?.displayName ?? ""].join(" "));
  return words.every((w) => hay.includes(w));
}

/** Saved resources: search, sort, select → Add to collection / Remove from saved (preview `savedTab`). */
export function SavedTab() {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const saved = useSavedItems();
  const items = useItemsByName((saved.data ?? []).map((s) => s.item));
  const { toResource } = useKnowledgeModel();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SavedSort>("saved");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const all = useMemo(
    () =>
      (saved.data ?? []).flatMap((s) => {
        const item = items.items.get(s.item);
        return item && item.state !== "DELETED" ? [{ resource: toResource(item), savedAt: s.createTime ?? "" }] : [];
      }),
    [saved.data, items.items, toResource],
  );
  const rows = useMemo(() => {
    const words = tokens(q);
    const out = all.filter((x) => matchesWords(x.resource, words));
    if (sort === "updated") out.sort((a, b) => (b.resource.updated ?? "").localeCompare(a.resource.updated ?? ""));
    else if (sort === "title") out.sort((a, b) => a.resource.title.localeCompare(b.resource.title));
    return out;
  }, [all, q, sort]);
  const live = new Set(all.map((x) => x.resource.id));
  const sel = [...selected].filter((id) => live.has(id));

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };

  async function unsave() {
    const ids = sel;
    if (!ids.length) return;
    setSelected(new Set());
    try {
      await Promise.all(ids.map((id) => deleteSavedItem(ws, id)));
      void qc.invalidateQueries({ queryKey: knowledgeKeys.saved(ws) });
      toast(`Removed ${plural(ids.length, "resource")} from saved`, {
        undo: () =>
          void Promise.all(ids.map((id) => createSavedItem(ws, id))).then(
            () => qc.invalidateQueries({ queryKey: knowledgeKeys.saved(ws) }),
            (e: unknown) => toast(errorMessage(e), { tone: "danger" }),
          ),
      });
    } catch (e) {
      void qc.invalidateQueries({ queryKey: knowledgeKeys.saved(ws) });
      toast(errorMessage(e), { tone: "danger" });
    }
  }

  const empty = (
    <EmptyState
      icon={Bookmark}
      title="Nothing saved yet"
      description="Save resources you come back to. They stay here."
      actions={
        <NextLink href="/knowledge" className={buttonVariants({ variant: "primary" })}>
          Browse knowledge
        </NextLink>
      }
      boxed
    />
  );

  const toolbar = (
    <div className="toolbar">
      <SearchInput value={q} onChange={setQ} placeholder="Search saved" />
      <div className="toolbar__end">
        <SortMenu value={sort} options={SAVED_SORTS} onChange={setSort} />
      </div>
    </div>
  );

  if (saved.isError && !saved.data) return <ErrorState error={saved.error} onRetry={() => void saved.refetch()} />;
  if (saved.isPending || items.isPending) return <SkeletonRows rows={6} />;
  if (items.isError && !all.length) return <ErrorState error={items.error} onRetry={items.refetch} />;
  if (!all.length) return empty;

  return (
    <>
      {toolbar}
      {rows.length ? (
        <ResourceList>
          {rows.map(({ resource }) => (
            <ResourceRow
              key={resource.id}
              resource={resource}
              q={q}
              selected={selected.has(resource.id)}
              onSelectChange={(on) => toggle(resource.id, on)}
            />
          ))}
        </ResourceList>
      ) : (
        <NoMatches what="saved resources" onClear={() => setQ("")} />
      )}
      <BulkBar count={sel.length} onClear={() => setSelected(new Set())}>
        <Button size="sm" variant="ghost" onPress={() => openAddToCollection(sel)}>
          <ListPlus className="i" aria-hidden />
          Add to collection
        </Button>
        <Button size="sm" variant="ghost" onPress={() => void unsave()}>
          <Bookmark className="i" aria-hidden />
          Remove from saved
        </Button>
      </BulkBar>
    </>
  );
}
