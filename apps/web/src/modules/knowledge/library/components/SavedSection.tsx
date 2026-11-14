"use client";

import { Button, buttonVariants } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Bookmark, ListPlus } from "lucide-react";
import NextLink from "next/link";
import { useMemo, useState } from "react";

import { BulkBar } from "@/components/ui/BulkBar";
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
import { openAddToReadingList } from "../../components/dialogs";
import { ResourceList, ResourceRow } from "../../components/ResourceRow";
import { fold, tokens, type Resource } from "../../model";
import { knowledgeKeys, useItemsByName, useKnowledgeModel, useSavedItems } from "../../queries";
import { originParam } from "../../reader/links";
import { needsTools, SortMenu } from "./parts";

const SAVED_SORTS = { saved: "Recently saved", updated: "Recently updated", title: "Title A–Z" } as const;
type SavedSort = keyof typeof SAVED_SORTS;

/** Every search word appears in the title, summary, type or collection (preview `scoreRes > 0`). */
export function matchesWords(r: Resource, words: readonly string[]): boolean {
  if (!words.length) return true;
  const hay = fold([r.title, r.fileName, r.summary, r.kindMeta.label, r.base?.displayName ?? ""].join(" "));
  return words.every((w) => hay.includes(w));
}

/**
 * Saved (preview `savedTab`): resources the member keeps coming back to. Search, sort and selection
 * (Add to reading list / Remove from saved with Undo) appear once the list is long enough.
 */
export function SavedSection() {
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
        return item && item.state !== "DELETED" ? [toResource(item)] : [];
      }),
    [saved.data, items.items, toResource],
  );
  const rows = useMemo(() => {
    const words = tokens(q);
    const out = all.filter((r) => matchesWords(r, words));
    if (sort === "updated") out.sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
    else if (sort === "title") out.sort((a, b) => a.title.localeCompare(b.title));
    return out;
  }, [all, q, sort]);
  const live = new Set(all.map((r) => r.id));
  const sel = [...selected].filter((id) => live.has(id));
  const tools = needsTools(all.length, q || sel.length);

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

  if (saved.isError && !saved.data) return <ErrorState error={saved.error} onRetry={() => void saved.refetch()} />;
  if (saved.isPending || items.isPending) return <SkeletonRows rows={6} />;
  if (items.isError && !all.length) return <ErrorState error={items.error} onRetry={items.refetch} />;
  if (!all.length) {
    return (
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
  }

  return (
    <>
      {tools ? (
        <div className="toolbar">
          <SearchInput value={q} onChange={setQ} placeholder="Search saved" />
          <div className="toolbar__end">
            <SortMenu value={sort} options={SAVED_SORTS} onChange={setSort} />
          </div>
        </div>
      ) : null}
      {rows.length ? (
        <ResourceList>
          {rows.map((r) => (
            <ResourceRow
              key={r.id}
              resource={r}
              from={originParam({ kind: "library", tab: "saved" })}
              q={q}
              selected={tools ? selected.has(r.id) : undefined}
              onSelectChange={tools ? (on) => toggle(r.id, on) : undefined}
            />
          ))}
        </ResourceList>
      ) : (
        <NoMatches what="saved resources" onClear={() => setQ("")} />
      )}
      <BulkBar count={sel.length} onClear={() => setSelected(new Set())}>
        <Button size="sm" variant="ghost" onPress={() => openAddToReadingList(sel)}>
          <ListPlus className="i" aria-hidden />
          Add to reading list
        </Button>
        <Button size="sm" variant="ghost" onPress={() => void unsave()}>
          <Bookmark className="i" aria-hidden />
          Remove from saved
        </Button>
      </BulkBar>
    </>
  );
}
