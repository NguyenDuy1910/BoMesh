"use client";

import { Button, Description, FieldError, Input, Label, ListBox, Select, TextArea, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { ChoiceGroup } from "@/components/ui/ChoiceGroup";
import { toast } from "@/components/ui/Toast";
import { errorMessage, resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { useSpaces } from "@/modules/spaces";

import { KnowledgeModal } from "../../components/KnowledgeModal";
import { invalidateKnowledge, useKnowledgeBases } from "../../queries";
import { createBase, getItemIamPolicy, setItemIamPolicy } from "../api";
import { DESC_MAX, NAME_MAX, nameError, withGeneralAccess, type GeneralAccess } from "../model";

/** Spaces a new base can belong to: the ones the caller runs (preview `ownSpaces`). */
function useOwnSpaces() {
  const { can, hasModule } = useWorkspace();
  const spaces = useSpaces();
  if (!hasModule("spaces")) return [];
  return (spaces.data ?? []).filter((s) => s.callerRole === "roles/spaceLead" || can("workspaces.update"));
}

/** Preview `M['kb-create']`: name (unique), description, optional space, who can see it. Opens the new base. */
export function CreateBaseDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { id, workspace } = useWorkspace();
  const qc = useQueryClient();
  const router = useRouter();
  const bases = useKnowledgeBases({ showLocked: true });
  const spaces = useOwnSpaces();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [space, setSpace] = useState("");
  const [access, setAccess] = useState<GeneralAccess>("workspace");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const err = nameError(name, bases.data ?? []);
  const shown = touched || (name.trim() && err.includes("exists")) ? err : "";

  function close() {
    onClose();
    setName("");
    setDesc("");
    setSpace("");
    setAccess("workspace");
    setTouched(false);
  }

  async function create() {
    if (busy) return;
    setTouched(true);
    if (err) {
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const item = await createBase(id, { displayName: name.trim(), description: desc.trim(), discoverable: access !== "private", space });
      if (access === "workspace" && item.name) {
        const policy = await getItemIamPolicy(id, item.name);
        await setItemIamPolicy(id, item.name, withGeneralAccess(policy, "workspace"));
      }
      invalidateKnowledge(qc, id);
      close();
      router.push(`/knowledge/${resourceId(item.name)}`);
      toast(`Created “${item.displayName ?? name.trim()}”`);
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <KnowledgeModal
      isOpen={isOpen}
      onClose={close}
      guard={busy}
      title="Create knowledge base"
      footer={
        <>
          <Button variant="tertiary" onPress={close} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void create()} isPending={busy}>
            Create
          </Button>
        </>
      }
    >
      <TextField className="field" value={name} onChange={setName} isRequired isInvalid={!!shown} isDisabled={busy} maxLength={NAME_MAX} autoFocus>
        <Label>Name</Label>
        <Input
          ref={nameRef}
          placeholder="e.g. Customer Support"
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
          }}
        />
        {shown ? (
          <FieldError>{shown}</FieldError>
        ) : (
          <div className="row between gap-12">
            <span />
            <span className="counter">
              {name.length}/{NAME_MAX}
            </span>
          </div>
        )}
      </TextField>
      <TextField className="field mt-16" value={desc} onChange={setDesc} isDisabled={busy} maxLength={DESC_MAX}>
        <Label>
          Description <span className="label__opt">(optional)</span>
        </Label>
        <TextArea rows={2} className="min-h-20" />
        <Description>Tells people what they can ask about.</Description>
      </TextField>
      {spaces.length ? (
        <Select className="field mt-16" value={space || "none"} onChange={(v) => setSpace(v === "none" ? "" : String(v))} isDisabled={busy}>
          <Label>
            Space <span className="label__opt">(optional)</span>
          </Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Description>Its members can read it, even when access is restricted.</Description>
          <Select.Popover>
            <ListBox>
              <ListBox.Item id="none" textValue="No space">
                No space
                <ListBox.ItemIndicator />
              </ListBox.Item>
              {spaces.map((s) => (
                <ListBox.Item key={s.name} id={s.name ?? ""} textValue={s.displayName ?? ""}>
                  {s.displayName}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      ) : null}
      <div className="field mt-16">
        <span className="label">Who can see it</span>
        <ChoiceGroup
          label="Who can see it"
          value={access}
          onChange={setAccess}
          isDisabled={busy}
          options={[
            { value: "workspace", title: `Everyone in ${workspace.displayName ?? ""}`, description: "Anyone can find it and ask about it." },
            { value: "restricted", title: space ? "Space members and people I add" : "Only people I add", description: "Share it with people and groups after it’s created." },
            { value: "private", title: "Only me", description: "Keep it private until you’re ready." },
          ]}
        />
      </div>
    </KnowledgeModal>
  );
}
