"use client";

import { Button, Checkbox, FieldError, Input, Label, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ChoiceGroup, SkeletonRows, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { updateItem } from "@/modules/knowledge/api";
import { createBase } from "@/modules/knowledge/bases/api";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";

import { createSpace } from "../api";
import { invalidateSpaces, useLinkableBases, useSpaces } from "../queries";
import { MAX_NAME, spaceType, spaceTypesOf, type Space } from "../types";

/** Name rule shared by Create and Settings (preview `nameError`). */
export function spaceNameError(name: string, spaces: readonly Space[], self?: string): string {
  const n = name.trim();
  if (!n) return "Enter a name.";
  if (n.length > MAX_NAME) return `Use ${MAX_NAME} characters or fewer.`;
  const dup = spaces.find((s) => s.name !== self && (s.displayName ?? "").trim().toLowerCase() === n.toLowerCase());
  return dup ? `“${dup.displayName}” already exists. Choose another name.` : "";
}

export interface CreateSpaceDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Preselected type key (the open tab). */
  type?: string;
}

/** Create space (preview `M['sp-create']`): type, name, description, knowledge to link or create. */
export function CreateSpaceDialog({ isOpen, onClose, type }: CreateSpaceDialogProps) {
  return isOpen ? <CreateSpaceForm onClose={onClose} type={type} /> : null;
}

function CreateSpaceForm({ onClose, type }: Omit<CreateSpaceDialogProps, "isOpen">) {
  const { id: ws, settings, can } = useWorkspace();
  const router = useRouter();
  const qc = useQueryClient();
  const types = spaceTypesOf(settings);
  const spaces = useSpaces();
  const bases = useLinkableBases();
  const canCreateBase = can("items.create");
  const [kind, setKind] = useState(types.some((t) => t.key === type) ? type! : (types[0]?.key ?? ""));
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [newBase, setNewBase] = useState(canCreateBase);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const error = touched ? spaceNameError(name, spaces.data ?? []) : "";
  const linkable = (bases.data ?? []).filter((b) => b.editable && !b.base.collection?.space);

  async function submit() {
    setTouched(true);
    if (spaceNameError(name, spaces.data ?? [])) return;
    setBusy(true);
    try {
      const def = spaceType(kind, settings);
      const space = await createSpace(ws, {
        displayName: name.trim(),
        description: desc.trim() || undefined,
        spaceType: kind || undefined,
        joinPolicy: def.defaultPolicy,
      });
      const links = picked.map((item) => updateItem(ws, item, { collection: { space: space.name } }, ["collection.space"]));
      if (newBase) {
        links.push(
          createBase(ws, {
            displayName: name.trim(),
            description: desc.trim() || `Materials for ${name.trim()}.`,
            discoverable: true,
            space: space.name,
          }),
        );
      }
      const results = await Promise.allSettled(links);
      void invalidateSpaces(qc, ws);
      void qc.invalidateQueries({ queryKey: [ws, "items"] });
      onClose();
      router.push(`/space/${resourceId(space.name)}`);
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed) toast(`Created “${name.trim()}”, but ${failed === 1 ? "a knowledge base" : `${failed} knowledge bases`} couldn’t be linked`, { tone: "warning" });
      else toast(`Created “${name.trim()}”`);
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
      setBusy(false);
    }
  }

  const def = spaceType(kind, settings);
  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      guard={busy}
      size="lg"
      title="Create space"
      footer={
        <>
          <Button variant="tertiary" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void submit()} isPending={busy}>
            Create space
          </Button>
        </>
      }
    >
      <form
        className="stack gap-16"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {types.length ? (
          <div className="field sp-types">
            <span className="label">Type</span>
            <ChoiceGroup
              label="Type"
              value={kind}
              onChange={setKind}
              isDisabled={busy}
              columns={Math.min(types.length, 3)}
              options={types.map((t) => ({ value: t.key, title: t.label, description: t.desc }))}
            />
          </div>
        ) : null}
        <TextField value={name} onChange={setName} isRequired isInvalid={!!error} maxLength={MAX_NAME} isDisabled={busy} autoFocus>
          <Label>Name</Label>
          <Input placeholder={def.key === "course" ? "e.g. Computer Vision" : "e.g. Field robotics"} />
          <FieldError>{error}</FieldError>
        </TextField>
        <TextField value={desc} onChange={setDesc} maxLength={140} isDisabled={busy}>
          <Label>
            Short description <span className="label__opt">(optional)</span>
          </Label>
          <Input placeholder="What happens here, in one line" />
        </TextField>
        <div className="field">
          <span className="label">Knowledge</span>
          <div className="description">Members can read and ask about linked knowledge bases.</div>
          <div className="stack gap-8 mt-4">
            {bases.isPending ? <SkeletonRows rows={2} /> : null}
            {linkable.map(({ base }) => (
              <Checkbox
                key={base.name}
                isDisabled={busy}
                isSelected={picked.includes(base.name ?? "")}
                onChange={(on) => setPicked(on ? [...picked, base.name ?? ""] : picked.filter((x) => x !== base.name))}
              >
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <span translate="no">{base.displayName}</span>
                </Checkbox.Content>
              </Checkbox>
            ))}
            {canCreateBase ? (
              <Checkbox isDisabled={busy} isSelected={newBase} onChange={setNewBase}>
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  Create a new knowledge base for it
                </Checkbox.Content>
              </Checkbox>
            ) : null}
            {!bases.isPending && !linkable.length && !canCreateBase ? <p className="t-sm muted">No knowledge bases to link yet.</p> : null}
          </div>
        </div>
      </form>
    </KnowledgeModal>
  );
}
