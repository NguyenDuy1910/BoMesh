"use client";

import { Button, FieldError, Input, Label, ListBox, Select, TextArea, TextField } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Globe, Layers, List, Lock, Pencil, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ChoiceGroup, type Choice } from "@/components/ui/ChoiceGroup";
import { toast } from "@/components/ui/Toast";
import { errorMessage } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { spacesListQuery } from "@/modules/spaces/queries";

import { createReadingList, createReadingListEntry, testSpacePermissions, updateReadingList, type ReadingList, type Space } from "../api";
import { knowledgeKeys } from "../queries";
import { readingListHref } from "./AddToReadingListDialog";
import { KnowledgeModal } from "./KnowledgeModal";

export interface ReadingListDialogProps {
  /** Edit this reading list; omit to create one. */
  list?: ReadingList;
  /** Items the new reading list starts with. */
  items?: string[];
  isOpen: boolean;
  onClose: () => void;
}

type Scope = "private" | "space" | "workspace";
const MASK = ["displayName", "description", "audience", "space"];

/** Spaces whose materials the caller may curate (preview `linkableSpaces`): leads and staff with `materials.create`. */
function useRunSpaces(enabled: boolean) {
  const { id: ws, hasModule } = useWorkspace();
  const qc = useQueryClient();
  return useQuery({
    queryKey: [ws, "spaces", "curated"],
    enabled: enabled && hasModule("spaces"),
    queryFn: async () => {
      const all = (await qc.fetchQuery(spacesListQuery(ws))).filter((s) => s.state !== "DELETED" && (s.callerRole === "roles/spaceLead" || s.callerRole === "roles/spaceStaff"));
      const ok = await Promise.all(all.map((s) => testSpacePermissions(ws, s.name ?? "", ["materials.create"]).then((p) => p.length > 0, () => false)));
      return all.filter((_, i) => ok[i]);
    },
  });
}

/**
 * Create / edit a reading list (preview `M['col-edit']`, API ReadingList). Who can see it: only me, the
 * members of a space the caller runs, or everyone (`readingLists.publish`). A space the list is already
 * shared with stays selectable. Reading lists never grant access to the documents in them.
 */
export function ReadingListDialog({ list, items = [], isOpen, onClose }: ReadingListDialogProps) {
  const { id: ws, workspace, can } = useWorkspace();
  const router = useRouter();
  const qc = useQueryClient();
  const run = useRunSpaces(isOpen);
  const [name, setName] = useState(list?.displayName ?? "");
  const [desc, setDesc] = useState(list?.description ?? "");
  const [scope, setScope] = useState<Scope>(list?.audience === "WORKSPACE" ? "workspace" : list?.audience === "SPACE" ? "space" : "private");
  const [spacePick, setSpace] = useState(list?.audience === "SPACE" ? (list.space ?? "") : "");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const error = touched && !name.trim() ? "Enter a name." : "";

  // A space it is already shared with stays selectable even if the caller no longer runs it.
  const mine: Pick<Space, "name" | "displayName">[] = run.data ?? [];
  const current = list?.audience === "SPACE" && list.space && !mine.some((s) => s.name === list.space) ? [{ name: list.space, displayName: "Current space" }] : [];
  const spaces = [...current, ...mine];
  const space = spaces.some((s) => s.name === spacePick) ? spacePick : (spaces[0]?.name ?? "");
  const options: Choice<Scope>[] = [
    { value: "private", title: "Only me", description: "A personal reading list.", icon: Lock },
    ...(spaces.length
      ? [{ value: "space" as const, title: "A space", description: spaces.length === 1 ? `Members of ${spaces[0].displayName}.` : "Its members can see it.", icon: Layers }]
      : []),
    ...(can("readingLists.publish") || list?.audience === "WORKSPACE"
      ? [{ value: "workspace" as const, title: "Everyone", description: `Anyone in ${workspace.displayName}.`, icon: Globe }]
      : []),
  ];

  const bodyOf = (): ReadingList => {
    const audience = scope === "space" && space ? "SPACE" : scope === "workspace" ? "WORKSPACE" : "PRIVATE";
    return { displayName: name.trim(), description: desc.trim(), audience, space: audience === "SPACE" ? space : undefined };
  };

  async function save() {
    if (busy) return;
    setTouched(true);
    if (!name.trim()) return;
    setBusy(true);
    const refresh = () => void qc.invalidateQueries({ queryKey: knowledgeKeys.readingLists(ws) });
    try {
      if (list?.name) {
        const prev: ReadingList = { displayName: list.displayName, description: list.description ?? "", audience: list.audience, space: list.space };
        const saved = await updateReadingList(ws, list.name, { ...bodyOf(), etag: list.etag }, MASK);
        refresh();
        onClose();
        toast("Reading list saved", {
          undo: () => void updateReadingList(ws, list.name ?? "", { ...prev, etag: saved.etag }, MASK).then(refresh, (e: unknown) => toast(errorMessage(e), { tone: "danger" })),
        });
        return;
      }
      const created = await createReadingList(ws, bodyOf());
      for (const item of items) await createReadingListEntry(ws, created.name ?? "", item);
      refresh();
      onClose();
      router.push(readingListHref(created.name));
      toast(items.length ? `Created “${created.displayName}”` : `Created “${created.displayName}”. Add resources to start the list.`);
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  const n = items.length;
  return (
    <KnowledgeModal
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      guard={busy}
      title={list ? "Edit reading list" : "New reading list"}
      icon={list ? Pencil : List}
      description={
        list
          ? "Change its name, description or who can see it."
          : n
            ? `A reading list that starts with ${plural(n, "resource")}.`
            : "A reading list you can order, annotate and share."
      }
      footerStart="Documents keep their own access."
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void save()} isPending={busy}>
            {list ? <Check className="i" aria-hidden /> : <Plus className="i" aria-hidden />}
            {list ? "Save changes" : "Create reading list"}
          </Button>
        </>
      }
    >
      <div className="kn-form">
        <TextField
          value={name}
          onChange={(v) => {
            setName(v);
            if (v.trim()) setTouched(false);
          }}
          isRequired
          isInvalid={!!error}
          isDisabled={busy}
          maxLength={60}
          autoFocus
        >
          <Label>Name</Label>
          <Input placeholder="e.g. On-call reading list" onKeyDown={(e) => e.key === "Enter" && void save()} />
          <FieldError>{error}</FieldError>
        </TextField>
        <TextField value={desc} onChange={setDesc} maxLength={200} isDisabled={busy}>
          <Label>
            Description <span className="label__opt">(optional)</span>
          </Label>
          <TextArea rows={2} placeholder="What it’s for and who should read it" />
        </TextField>
        {options.length > 1 ? (
          <div className="field col-scope">
            <span className="label">Who can see it</span>
            <ChoiceGroup label="Who can see it" value={scope} options={options} onChange={setScope} columns={options.length} isDisabled={busy} />
            {scope === "space" && spaces.length > 1 ? (
              <div className="col-space">
                <Select value={space} onChange={(v) => setSpace(String(v))} isDisabled={busy}>
                  <Label>Which space?</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {spaces.map((s) => (
                        <ListBox.Item key={s.name} id={s.name ?? ""} textValue={s.displayName ?? ""}>
                          {s.displayName}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="col-only">
            <Lock className="i i-sm" aria-hidden />
            <span>Only you can see it.</span>
          </p>
        )}
      </div>
    </KnowledgeModal>
  );
}
