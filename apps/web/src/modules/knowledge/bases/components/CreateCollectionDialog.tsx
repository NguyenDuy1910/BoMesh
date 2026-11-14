"use client";

import { Button, Description, FieldError, Input, Label, ListBox, Select, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { ChoiceGroup } from "@/components/ui/ChoiceGroup";
import { toast } from "@/components/ui/Toast";
import { errorMessage } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { useSpaces } from "@/modules/spaces";

import { openContribute } from "../../components/contribute-store";
import { KnowledgeModal } from "../../components/KnowledgeModal";
import { invalidateKnowledge, useKnowledgeBases } from "../../queries";
import { createBase, getItemIamPolicy, setItemIamPolicy } from "../api";
import { accessInfo, collectionHref, DESC_MAX, GENERAL_ACCESS, NAME_MAX, nameError, withGeneralAccess, type GeneralAccess } from "../model";

/** Spaces a new collection can belong to: the ones the caller runs (preview `ownSpaces`). */
function useOwnSpaces() {
  const { can, hasModule } = useWorkspace();
  const spaces = useSpaces();
  if (!hasModule("spaces")) return [];
  return (spaces.data ?? []).filter((s) => s.callerRole === "roles/spaceLead" || can("workspaces.update"));
}

/** Preview `M['kb-create']`: name (unique), optional space, description, who can see it. Opens the new collection. */
export function CreateCollectionDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { id, workspace } = useWorkspace();
  const qc = useQueryClient();
  const router = useRouter();
  const collections = useKnowledgeBases({ showLocked: true });
  const spaces = useOwnSpaces();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [space, setSpace] = useState("");
  const [access, setAccess] = useState<GeneralAccess>("workspace");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const err = nameError(name, collections.data ?? []);
  const shown = touched || (name.trim() && err.includes("exists")) ? err : "";
  const spaceName = spaces.find((s) => s.name === space)?.displayName ?? undefined;

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
      router.push(collectionHref(item.name));
      toast(`Created “${item.displayName ?? name.trim()}”`, { action: { label: "Contribute", onPress: () => openContribute({ collection: item.name }) } });
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  const nameField = (
    <TextField className="field" value={name} onChange={setName} isRequired isInvalid={!!shown} isDisabled={busy} maxLength={NAME_MAX} autoFocus>
      <Label>Name</Label>
      <Input
        ref={nameRef}
        placeholder="e.g. Payments runbooks"
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
  );

  return (
    <KnowledgeModal
      isOpen={isOpen}
      onClose={close}
      guard={busy}
      size="lg"
      icon={BookOpen}
      title="Create collection"
      description="A home for a team’s or a topic’s documents. Add files or connect a source next."
      footerStart={<span className="t-xs muted">You’ll be its owner. You can change access any time.</span>}
      footer={
        <>
          <Button variant="ghost" onPress={close} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void create()} isPending={busy}>
            <Plus className="i" aria-hidden />
            Create collection
          </Button>
        </>
      }
    >
      <div className="kn-form">
        {spaces.length ? (
          <div className="kb-create-row">
            {nameField}
            <Select className="field" value={space || "none"} onChange={(v) => setSpace(v === "none" ? "" : String(v))} isDisabled={busy}>
              <Label>
                Space <span className="label__opt">(optional)</span>
              </Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Description>Its members can read it, even when restricted.</Description>
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
          </div>
        ) : (
          nameField
        )}
        <TextField className="field" value={desc} onChange={setDesc} isDisabled={busy} maxLength={DESC_MAX}>
          <Label>
            Description <span className="label__opt">(optional)</span>
          </Label>
          <Input
            placeholder="e.g. Runbooks for the payment rails"
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
          />
          <Description>Tells people what they can ask about.</Description>
        </TextField>
        <div className="field">
          <span className="label">Who can see it</span>
          <ChoiceGroup
            label="Who can see it"
            columns={3}
            value={access}
            onChange={setAccess}
            isDisabled={busy}
            options={GENERAL_ACCESS.map((key) => {
              const info = accessInfo(key, workspace.displayName ?? "", spaceName);
              return { value: key, title: info.label, description: info.long, icon: info.icon };
            })}
          />
        </div>
      </div>
    </KnowledgeModal>
  );
}
