"use client";

import { Button, FieldError, Input, Label, TextField } from "@heroui/react";
import { useState, type FormEvent } from "react";

import { toast } from "@/components/ui/Toast";
import { errorMessage } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { KnowledgeModal } from "../components/KnowledgeModal";
import { useSavedSearchMutations, useTopics } from "../queries";
import { savedSearchOf, unsavable, type BrowseParams } from "./catalog";

export interface SaveViewDialogProps {
  isOpen: boolean;
  onClose: () => void;
  params: BrowseParams;
  /** Suggested name (the filters, else the query). */
  suggestion: string;
  /** The set in words (dialog description). */
  description: string;
}

/** Save view (preview `M['cat-save-view']`): name the current result set; a toast offers Undo. */
export function SaveViewDialog({ isOpen, onClose, params, suggestion, description }: SaveViewDialogProps) {
  return isOpen ? <SaveViewForm onClose={onClose} params={params} suggestion={suggestion} description={description} /> : null;
}

function SaveViewForm({ onClose, params, suggestion, description }: Omit<SaveViewDialogProps, "isOpen">) {
  const { id: ws } = useWorkspace();
  const topics = useTopics();
  const { create, remove } = useSavedSearchMutations();
  const [name, setName] = useState(suggestion);
  const [touched, setTouched] = useState(false);
  const error = touched && !name.trim() ? "Enter a name." : "";
  const lost = unsavable(params);

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    setTouched(true);
    const n = name.trim();
    if (!n) return;
    try {
      const view = await create.mutateAsync(savedSearchOf(params, ws, topics.data ?? [], n));
      onClose();
      toast(`Saved view “${n}”`, { undo: () => view.name && remove.mutate(view.name) });
    } catch (err) {
      toast(errorMessage(err), { tone: "danger" });
    }
  };

  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      size="sm"
      title="Save view"
      description={description}
      footer={
        <>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button variant="primary" isPending={create.isPending} onPress={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void save(e)} className="stack gap-12">
        <TextField value={name} onChange={setName} isRequired isInvalid={!!error} maxLength={60} autoFocus>
          <Label>Name</Label>
          <Input />
          <FieldError>{error}</FieldError>
        </TextField>
        {lost.length ? <p className="muted text-sm">{`${lost.join(", ")} won’t be kept in the view.`}</p> : null}
      </form>
    </KnowledgeModal>
  );
}
