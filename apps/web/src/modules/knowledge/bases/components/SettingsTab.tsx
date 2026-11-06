"use client";

import { Button, Card, FieldError, Input, Label, TextArea, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Archive } from "lucide-react";
import { useRef, useState } from "react";

import { FormSection } from "@/components/ui/FormSection";
import { SaveBar } from "@/components/ui/SaveBar";
import { toast } from "@/components/ui/Toast";
import { errorMessage } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { updateItem } from "../../api";
import { invalidateKnowledge, useKnowledgeBases } from "../../queries";
import { DESC_MAX, NAME_MAX, nameError, type Item } from "../model";
import { useBaseOperations } from "../operations";

/** Settings tab (preview `settingsTab(kb)`): name and description, archive. Owners only. */
export function SettingsTab({ base }: { base: Item }) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const bases = useKnowledgeBases({ showLocked: true });
  const ops = useBaseOperations();
  const savedName = base.displayName ?? "";
  const savedDesc = base.collection?.description ?? "";
  const [name, setName] = useState(savedName);
  const [desc, setDesc] = useState(savedDesc);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const err = nameError(name, bases.data ?? [], base.name);
  const shown = touched || (name.trim() && err.includes("exists")) ? err : "";
  const dirty = name.trim() !== savedName || desc.trim() !== savedDesc;
  const n = base.collection?.documentCount ?? 0;

  function discard() {
    setName(savedName);
    setDesc(savedDesc);
    setTouched(false);
  }

  async function save() {
    if (busy) return;
    setTouched(true);
    if (err) {
      nameRef.current?.focus();
      return;
    }
    if (!dirty) return;
    setBusy(true);
    try {
      const mask = [name.trim() !== savedName && "displayName", desc.trim() !== savedDesc && "collection.description"].filter((m): m is string => !!m);
      const item = await updateItem(ws, base.name ?? "", { displayName: name.trim(), collection: { description: desc.trim() }, etag: base.etag }, mask);
      setName(item.displayName ?? "");
      setDesc(item.collection?.description ?? "");
      setTouched(false);
      invalidateKnowledge(qc, ws);
      toast("Changes saved");
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="kb-narrow stack gap-16">
      <Card className="card--lg">
        <FormSection title="Details" description="Shown on the Knowledge page and when people choose what to ask about.">
          <TextField value={name} onChange={setName} isRequired isInvalid={!!shown} isDisabled={busy} maxLength={NAME_MAX}>
            <Label>Name</Label>
            <Input
              ref={nameRef}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
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
          <TextField className="field" value={desc} onChange={setDesc} isDisabled={busy} maxLength={DESC_MAX}>
            <Label>
              Description <span className="label__opt">(optional)</span>
            </Label>
            <TextArea rows={3} />
            <div className="row between gap-12">
              <span />
              <span className="counter">
                {desc.length}/{DESC_MAX}
              </span>
            </div>
          </TextField>
        </FormSection>
      </Card>
      <Card className="card--lg">
        <FormSection
          title="Archive knowledge base"
          description={`${n ? `Removes it and its ${plural(n, "document")} from answers and search for everyone.` : "Removes it for everyone."} You can undo right after.`}
        >
          <div>
            <Button variant="danger-soft" onPress={() => void ops.archive(base)}>
              <Archive className="i" aria-hidden />
              Archive knowledge base
            </Button>
          </div>
        </FormSection>
      </Card>
      <SaveBar isDirty={dirty} onSave={() => void save()} onDiscard={discard} isSaving={busy} />
    </div>
  );
}
