"use client";

import { Button, Description, FieldError, Input, Label, TextArea, TextField } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ChoiceGroup, type Choice } from "@/components/ui/ChoiceGroup";
import { toast } from "@/components/ui/Toast";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { createReadingList, createReadingListEntry, listSpaces, testSpacePermissions, updateReadingList, type ReadingList } from "../api";
import { knowledgeKeys } from "../queries";
import { KnowledgeModal } from "./KnowledgeModal";

export interface ReadingListDialogProps {
  /** Edit this list; omit to create one. */
  list?: ReadingList;
  /** Items to add to a new list. */
  items?: string[];
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Create / edit a collection (preview `M['col-edit']`, API ReadingList). Sharing: only me, a space the caller
 * leads or staffs, or everyone (`readingLists.publish`). A collection never grants access.
 */
export function ReadingListDialog({ list, items = [], isOpen, onClose }: ReadingListDialogProps) {
  const { id: ws, workspace, can, hasModule } = useWorkspace();
  const router = useRouter();
  const qc = useQueryClient();
  const [name, setName] = useState(list?.displayName ?? "");
  const [desc, setDesc] = useState(list?.description ?? "");
  const [share, setShare] = useState(list?.audience === "SPACE" ? `space:${list.space}` : (list?.audience ?? "PRIVATE"));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const spaces = useQuery({
    queryKey: [ws, "spaces", "curated"],
    enabled: isOpen && hasModule("spaces"),
    queryFn: async () => {
      const all = (await listSpaces(ws)).filter((s) => s.callerRole === "roles/spaceLead" || s.callerRole === "roles/spaceStaff");
      const ok = await Promise.all(all.map((s) => testSpacePermissions(ws, s.name ?? "", ["materials.create"]).then((p) => p.length > 0, () => false)));
      return all.filter((_, i) => ok[i]);
    },
  });
  const error = touched && !name.trim() ? "Enter a name." : "";
  const options: Choice[] = [
    { value: "PRIVATE", title: "Only me", description: "A personal reading list." },
    ...(spaces.data ?? []).map((s) => ({ value: `space:${s.name}`, title: s.displayName, description: `Members of this ${s.spaceType ?? "space"} can see it.` })),
    ...(can("readingLists.publish") ? [{ value: "WORKSPACE", title: `Everyone in ${workspace.displayName}`, description: "Shown on Home for everyone." }] : []),
  ];
  if (!options.some((o) => o.value === share)) options.push({ value: share, title: "Current sharing", description: "" });

  async function save() {
    setTouched(true);
    if (!name.trim()) return;
    const audience = share.startsWith("space:") ? "SPACE" : (share as "PRIVATE" | "WORKSPACE");
    const body: ReadingList = { displayName: name.trim(), description: desc.trim(), audience, space: audience === "SPACE" ? share.slice(6) : undefined };
    setBusy(true);
    try {
      if (list?.name) {
        await updateReadingList(ws, list.name, { ...body, etag: list.etag }, ["displayName", "description", "audience", "space"]);
        void qc.invalidateQueries({ queryKey: knowledgeKeys.readingLists(ws) });
        onClose();
        toast("Collection saved");
        return;
      }
      const created = await createReadingList(ws, body);
      for (const item of items) await createReadingListEntry(ws, created.name ?? "", item);
      void qc.invalidateQueries({ queryKey: knowledgeKeys.readingLists(ws) });
      onClose();
      router.push(`/knowledge/collections/${resourceId(created.name)}`);
      toast(`Created “${created.displayName}”`);
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
      title={list ? "Edit collection" : "New collection"}
      description={items.length ? `${plural(items.length, "resource")} will be added` : undefined}
      footer={
        <>
          <Button variant="tertiary" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void save()} isPending={busy}>
            {list ? "Save" : "Create"}
          </Button>
        </>
      }
    >
      <TextField value={name} onChange={setName} isRequired isInvalid={!!error} maxLength={60} autoFocus onKeyDown={(e) => e.key === "Enter" && void save()}>
        <Label>Name</Label>
        <Input placeholder="e.g. Thesis reading list" />
        <FieldError>{error}</FieldError>
      </TextField>
      <TextField className="mt-16" value={desc} onChange={setDesc} maxLength={200}>
        <Label>
          Description <span className="label__opt">(optional)</span>
        </Label>
        <TextArea rows={2} />
      </TextField>
      <div className="field mt-16">
        <span className="label">Who can see it</span>
        <ChoiceGroup label="Who can see it" value={share} options={options} onChange={setShare} />
        <Description className="description mt-4">People still need access to a resource to open it.</Description>
      </div>
    </KnowledgeModal>
  );
}
