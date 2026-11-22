"use client";

import { Button, Description, FieldError, Input, Label, TextField } from "@heroui/react";
import { Check, Layers, Pencil, type LucideIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { toast } from "@/components/ui/Toast";
import { errorMessage } from "@/lib/api/client";
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";

import type { SavedSearch } from "../api";
import { KnowledgeModal } from "../components/KnowledgeModal";
import { useSavedSearchMutations } from "../queries";
import { savedSearchOf, unsavable, type BrowseParams } from "./catalog";

/** A name form shared by Save view and Rename view (preview `M['cat-save-view']`, `M['cat-view-rename']`). */
function NameForm({
  title,
  icon,
  description,
  hint,
  initial,
  confirm,
  pending,
  onClose,
  onSubmit,
}: {
  title: string;
  icon: LucideIcon;
  description?: string;
  hint?: string;
  initial: string;
  confirm: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  const [touched, setTouched] = useState(false);
  const error = touched && !name.trim() ? "Enter a name." : "";
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setTouched(true);
    if (name.trim()) onSubmit(name.trim());
  };
  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      size="sm"
      title={title}
      icon={icon}
      description={description}
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>
            Cancel
          </Button>
          <Button variant="primary" isPending={pending} onPress={() => submit()}>
            <Check aria-hidden />
            {confirm}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="stack gap-12">
        <TextField value={name} onChange={setName} isRequired isInvalid={!!error} maxLength={60} autoFocus>
          <Label>Name</Label>
          <Input />
          {hint && !error ? <Description>{hint}</Description> : null}
          <FieldError>{error}</FieldError>
        </TextField>
      </form>
    </KnowledgeModal>
  );
}

export interface SaveViewDialogProps {
  onClose: () => void;
  params: BrowseParams;
  /** Suggested name (the filters, else the query). */
  suggestion: string;
  /** The set in words ("Saves …"). */
  summary: string;
}

/** Save view (preview `M['cat-save-view']`): name the current result set; a toast offers Undo. */
export function SaveViewDialog({ onClose, params, suggestion, summary }: SaveViewDialogProps) {
  const { id: ws } = useWorkspace();
  const { create, remove } = useSavedSearchMutations();
  const facetName = useMessages().knowledge.browse.facets;
  const lost = unsavable(params).map((id) => facetName[id]);
  const save = async (name: string) => {
    try {
      const view = await create.mutateAsync(savedSearchOf(params, ws, name));
      onClose();
      toast(`Saved view “${name}”`, { undo: () => view.name && remove.mutate(view.name) });
    } catch (err) {
      toast(errorMessage(err), { tone: "danger" });
    }
  };
  return (
    <NameForm
      title="Save view"
      icon={Layers}
      description="Come back to this search and its filters from Views."
      hint={`Saves ${summary}${lost.length ? ` (${lost.join(", ")} won’t be kept)` : ""}`}
      initial={suggestion}
      confirm="Save view"
      pending={create.isPending}
      onClose={onClose}
      onSubmit={(name) => void save(name)}
    />
  );
}

/** Rename view (preview `M['cat-view-rename']`): applies at once; the toast offers Undo. */
export function RenameViewDialog({ view, onClose }: { view: SavedSearch; onClose: () => void }) {
  const { update } = useSavedSearchMutations();
  const rename = async (name: string) => {
    const prev = view.displayName;
    if (!view.name || name === prev) return onClose();
    try {
      await update.mutateAsync({ name: view.name, search: { ...view, displayName: name }, mask: ["displayName"] });
      onClose();
      toast(`Renamed to “${name}”`, { undo: () => view.name && update.mutate({ name: view.name, search: { ...view, displayName: prev }, mask: ["displayName"] }) });
    } catch (err) {
      toast(errorMessage(err), { tone: "danger" });
    }
  };
  return <NameForm title="Rename view" icon={Pencil} initial={view.displayName} confirm="Rename" pending={update.isPending} onClose={onClose} onSubmit={(name) => void rename(name)} />;
}
