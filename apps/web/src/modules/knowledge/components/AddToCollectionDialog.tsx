"use client";

import { Button, Checkbox, Description, Input, Label, Link, TextField } from "@heroui/react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Lock, Plus, Users, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { toast } from "@/components/ui/Toast";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { createReadingList, createReadingListEntry, deleteReadingListEntry, listReadingListEntries, listSpaces, type ReadingList } from "../api";
import { knowledgeKeys, useEditableReadingLists, useItem } from "../queries";
import { KnowledgeModal } from "./KnowledgeModal";

/** Who a reading list is shared with (preview `shareLabel`). */
export function useShareLabel() {
  const { id, workspace, hasModule } = useWorkspace();
  const spaces = useQuery({ queryKey: [id, "spaces", "all"], queryFn: () => listSpaces(id), enabled: hasModule("spaces"), staleTime: 5 * 60_000 });
  return (list: Pick<ReadingList, "audience" | "space">): { icon: LucideIcon; label: string } => {
    if (list.audience === "WORKSPACE") return { icon: Globe, label: `Everyone in ${workspace.displayName}` };
    if (list.audience === "SPACE") return { icon: Users, label: spaces.data?.find((s) => s.name === list.space)?.displayName ?? "A space" };
    return { icon: Lock, label: "Only you" };
  };
}

export interface AddToCollectionDialogProps {
  /** Item names or IDs to add. */
  items: string[];
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Add to collection (preview `M['res-collect']`): tick reading lists you can edit (a single resource can
 * also be removed by unticking), or create one. Collections point to resources; they never change access.
 */
export function AddToCollectionDialog({ items, isOpen, onClose }: AddToCollectionDialogProps) {
  const { id: ws } = useWorkspace();
  const router = useRouter();
  const qc = useQueryClient();
  const lists = useEditableReadingLists();
  const editable = lists.data;
  const ids = useMemo(() => items.map((i) => resourceId(i)), [items]);
  const single = useItem(ids.length === 1 ? ids[0] : null);
  const entries = useQueries({
    queries: editable.map((l) => ({
      queryKey: knowledgeKeys.entries(ws, resourceId(l.name)),
      queryFn: () => listReadingListEntries(ws, resourceId(l.name)),
      enabled: isOpen,
    })),
  });
  const loaded = !lists.isPending && entries.every((e) => !e.isPending);
  const initial = useMemo(() => {
    if (!loaded) return null;
    return editable.filter((_, i) => ids.every((id) => entries[i].data?.entries.some((e) => resourceId(e.item) === id))).map((l) => l.name ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute once everything has loaded
  }, [loaded, editable.length]);
  const [pickedState, setPicked] = useState<string[] | null>(null);
  const picked = pickedState ?? initial ?? [];
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const shareLabel = useShareLabel();
  const isCreating = creating || (loaded && !editable.length);

  const toggle = (list: string) => setPicked(picked.includes(list) ? picked.filter((x) => x !== list) : [...picked, list]);

  async function done() {
    setBusy(true);
    try {
      let created: ReadingList | null = null;
      const chosen = [...picked];
      if (isCreating && name.trim()) {
        created = await createReadingList(ws, { displayName: name.trim(), audience: "PRIVATE" });
        chosen.push(created.name ?? "");
      }
      let added = 0;
      let removed = 0;
      const all = [...editable, ...(created ? [created] : [])];
      await Promise.all(
        all.map(async (l, i) => {
          const want = chosen.includes(l.name ?? "");
          const have = l === created ? [] : (entries[i]?.data?.entries ?? []).map((e) => resourceId(e.item));
          for (const id of ids) {
            if (want && !have.includes(id)) {
              await createReadingListEntry(ws, l.name ?? "", id);
              added++;
            } else if (!want && have.includes(id) && ids.length === 1) {
              await deleteReadingListEntry(ws, l.name ?? "", id);
              removed++;
            }
          }
        }),
      );
      void qc.invalidateQueries({ queryKey: knowledgeKeys.readingLists(ws) });
      onClose();
      const target = created ?? all.find((l) => chosen.includes(l.name ?? ""));
      if (added && target) {
        const others = chosen.length - 1;
        toast(`Added to “${target.displayName}”${others > 0 ? ` and ${plural(others, "other")}` : ""}`, {
          action: { label: "Open", onPress: () => router.push(`/knowledge/collections/${resourceId(target.name)}`) },
        });
      } else if (removed) toast("Removed from the collection");
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <KnowledgeModal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      title="Add to collection"
      description={ids.length === 1 ? (single.data?.displayName ?? "") : plural(ids.length, "resource")}
      footer={
        <>
          <Button variant="tertiary" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void done()} isPending={busy} isDisabled={!loaded}>
            Done
          </Button>
        </>
      }
    >
      {editable.length ? (
        <div className="res-picks">
          {editable.map((l) => {
            const share = shareLabel(l);
            const ShareIcon = share.icon;
            return (
              <div key={l.name} className="res-pick">
                <Checkbox isSelected={picked.includes(l.name ?? "")} onChange={() => toggle(l.name ?? "")} isDisabled={!loaded}>
                  <Checkbox.Content>
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    <span className="stack">
                      <span className="medium" translate="no">
                        {l.displayName}
                      </span>
                      <span className="t-xs muted row gap-4">
                        <ShareIcon className="i i-xs" aria-hidden />
                        {share.label} · {plural(l.itemCount ?? 0, "item")}
                      </span>
                    </span>
                  </Checkbox.Content>
                </Checkbox>
              </div>
            );
          })}
        </div>
      ) : null}
      <div className={editable.length ? "mt-16" : ""}>
        {isCreating ? (
          <TextField value={name} onChange={setName} maxLength={60} autoFocus onKeyDown={(e) => e.key === "Enter" && void done()}>
            <Label>New collection</Label>
            <Input placeholder="e.g. Midterm reading list" />
            <Description>Only you can see it until you share it.</Description>
          </TextField>
        ) : (
          <Link className="link row gap-4" onPress={() => setCreating(true)}>
            <Plus className="i i-sm" aria-hidden />
            New collection
          </Link>
        )}
      </div>
      <p className="t-xs muted mt-12">Collections point to resources; they don’t change who can open them.</p>
    </KnowledgeModal>
  );
}
