"use client";

import { Button, Checkbox, Description, FieldError, Input, Label, TextField } from "@heroui/react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Check, ListPlus, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { toast } from "@/components/ui/Toast";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { createReadingList, createReadingListEntry, deleteReadingListEntry, listReadingListEntries, type ReadingList } from "../api";
import { readableTitle } from "../model";
import { knowledgeKeys, useEditableReadingLists, useItem } from "../queries";
import { KnowledgeModal } from "./KnowledgeModal";
import { ResDot } from "./ResourceRow";
import { useShareLabel } from "./share-label";

export interface AddToReadingListDialogProps {
  /** Item names or IDs to add. */
  items: string[];
  isOpen: boolean;
  onClose: () => void;
}

/** `/knowledge/lists/{id}` for a reading list name or ID. */
export const readingListHref = (list: string | undefined) => `/knowledge/lists/${resourceId(list)}`;

/**
 * Add to reading list (preview `M['res-collect']`): tick reading lists you can edit (one resource can also
 * be taken out by unticking), or create one. Reading lists point to documents; they never change access.
 */
export function AddToReadingListDialog({ items, isOpen, onClose }: AddToReadingListDialogProps) {
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
  const had = useMemo(() => {
    if (!loaded) return null;
    return editable.filter((_, i) => ids.every((id) => entries[i].data?.entries.some((e) => resourceId(e.item) === id))).map((l) => l.name ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- computed once everything has loaded
  }, [loaded, editable.length]);
  const [pickedState, setPicked] = useState<string[] | null>(null);
  const picked = pickedState ?? had ?? [];
  const [creatingState, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const shareLabel = useShareLabel();
  const creating = creatingState || (loaded && !editable.length);

  const before = had ?? [];
  const add = picked.filter((l) => !before.includes(l)).length + (creating && name.trim() ? 1 : 0);
  const drop = ids.length === 1 ? before.filter((l) => !picked.includes(l)).length : 0;
  const error = touched && !add && !drop ? (creating ? "Name the new reading list." : "Pick a reading list or create a new one.") : "";
  const what = ids.length === 1 ? `“${readableTitle((single.data?.displayName ?? "").replace(/\.[a-z0-9]{1,5}$/i, ""))}”` : plural(ids.length, "resource");
  const confirmLabel = drop ? "Save changes" : creating ? "Create and add" : add > 1 ? `Add to ${add} reading lists` : "Add to reading list";

  const toggle = (list: string) => {
    setPicked(picked.includes(list) ? picked.filter((x) => x !== list) : [...picked, list]);
    setTouched(false);
  };

  async function done() {
    if (busy) return;
    if (!add && !drop) {
      // Nothing to change: already where it belongs, or nothing chosen yet.
      if (before.length && !creating) return onClose();
      setTouched(true);
      return;
    }
    setBusy(true);
    try {
      let created: ReadingList | null = null;
      const chosen = [...picked];
      if (creating && name.trim()) {
        created = await createReadingList(ws, { displayName: name.trim(), audience: "PRIVATE" });
        chosen.push(created.name ?? "");
      }
      const added: { list: string; item: string }[] = [];
      const removed: { list: string; item: string }[] = [];
      const all = [...editable, ...(created ? [created] : [])];
      await Promise.all(
        all.map(async (l, i) => {
          const list = l.name ?? "";
          const want = chosen.includes(list);
          const have = l === created ? [] : (entries[i]?.data?.entries ?? []).map((e) => resourceId(e.item));
          for (const id of ids) {
            if (want && !have.includes(id)) {
              await createReadingListEntry(ws, list, id);
              added.push({ list, item: id });
            } else if (!want && have.includes(id) && ids.length === 1) {
              await deleteReadingListEntry(ws, list, id);
              removed.push({ list, item: id });
            }
          }
        }),
      );
      const refresh = () => void qc.invalidateQueries({ queryKey: knowledgeKeys.readingLists(ws) });
      refresh();
      onClose();
      const gained = all.filter((l) => l === created || (chosen.includes(l.name ?? "") && !before.includes(l.name ?? "")));
      if (added.length && gained.length) {
        const first = gained[0];
        toast(`Added to “${first.displayName}”${gained.length > 1 ? ` and ${plural(gained.length - 1, "other")}` : ""}`, {
          action: { label: "Open", onPress: () => router.push(readingListHref(first.name)) },
        });
      } else if (removed.length) {
        const lists = new Set(removed.map((r) => r.list)).size;
        toast(lists === 1 ? "Removed from the reading list" : `Removed from ${plural(lists, "reading list")}`, {
          undo: () => void Promise.all(removed.map((r) => createReadingListEntry(ws, r.list, r.item))).then(refresh, (e: unknown) => toast(errorMessage(e), { tone: "danger" })),
        });
      }
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <KnowledgeModal
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      title="Add to reading list"
      icon={ListPlus}
      description={`Group ${what} with related reading.`}
      footerStart="Documents keep their own access."
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void done()} isPending={busy} isDisabled={!loaded}>
            {drop ? <Check className="i" aria-hidden /> : <Plus className="i" aria-hidden />}
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="stack gap-12">
        {editable.length ? (
          <div className="option-list" role="group" aria-label="Reading lists">
            {editable.map((l) => {
              const share = shareLabel(l);
              const ShareIcon = share.icon;
              return (
                <Checkbox key={l.name} isSelected={picked.includes(l.name ?? "")} onChange={() => toggle(l.name ?? "")} isDisabled={!loaded || busy}>
                  <Checkbox.Content>
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    <span className="res-opt">
                      <span className="res-opt__name" translate="no">
                        {l.displayName}
                      </span>
                      <span className="res-opt__meta">
                        <ShareIcon className="i i-xs" aria-hidden />
                        <span className="truncate">{share.label}</span>
                        <ResDot />
                        {plural(l.itemCount ?? 0, "item")}
                      </span>
                    </span>
                  </Checkbox.Content>
                </Checkbox>
              );
            })}
          </div>
        ) : null}
        <div>
          {creating ? (
            <TextField
              value={name}
              onChange={(v) => {
                setName(v);
                if (v.trim()) setTouched(false);
              }}
              maxLength={60}
              autoFocus
              isInvalid={!!error}
              isDisabled={busy}
            >
              <Label>{editable.length ? "New reading list" : "Name your first reading list"}</Label>
              <Input placeholder="e.g. On-call reading list" onKeyDown={(e) => e.key === "Enter" && void done()} />
              {error ? <FieldError>{error}</FieldError> : <Description>Only you can see it until you share it.</Description>}
            </TextField>
          ) : (
            <>
              {error ? (
                <div className="field-error mb-8" role="alert">
                  <CircleAlert className="i" aria-hidden />
                  <span>{error}</span>
                </div>
              ) : null}
              <Button variant="ghost" size="sm" className="res-newcol" onPress={() => setCreating(true)} isDisabled={busy}>
                <Plus className="i" aria-hidden />
                New reading list
              </Button>
            </>
          )}
        </div>
      </div>
    </KnowledgeModal>
  );
}
