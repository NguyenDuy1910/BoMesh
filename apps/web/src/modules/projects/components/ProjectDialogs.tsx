"use client";

import { Button, FieldError, Input, Label, TextField } from "@heroui/react";
import { useState, type FormEvent } from "react";

import { errorMessage } from "@/lib/api/client";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";

import { useProjectActions } from "../actions";
import {
  closeProjectDialog,
  useProjectsUi,
  type ProjectDialog,
} from "../store";
import { PROJECT_NAME_MAX } from "../types";

/** Dialogs opened from conversation and project menus (preview `M['conv-rename']`, `M['proj-name']`). Mounted once by the sidebar. */
export function ProjectDialogs() {
  const { dialog } = useProjectsUi();
  if (!dialog) return null;
  // Keyed so each opening starts from the current name.
  return <NameDialog key={keyOf(dialog)} dialog={dialog} />;
}

function keyOf(dialog: ProjectDialog): string {
  if (dialog.kind === "rename-project") return `rp:${dialog.project.id}`;
  return `${dialog.kind}:${dialog.conversation?.name ?? ""}`;
}

function NameDialog({ dialog }: { dialog: ProjectDialog }) {
  const actions = useProjectActions();
  const conversation = dialog.kind === "rename-conversation";
  const max = conversation ? 80 : PROJECT_NAME_MAX;
  const initial =
    dialog.kind === "rename-conversation"
      ? (dialog.conversation.displayName ?? "")
      : dialog.kind === "rename-project"
        ? dialog.project.displayName
        : "";
  const [name, setName] = useState(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(event?: FormEvent) {
    event?.preventDefault();
    const value = name.trim();
    const problem = !value
      ? "Enter a name."
      : value.length > max
        ? `Use ${max} characters or fewer.`
        : "";
    setError(problem);
    if (problem || busy) return;
    setBusy(true);
    try {
      if (dialog.kind === "rename-conversation") {
        await actions.renameConversation(dialog.conversation, value);
        closeProjectDialog();
      } else if (dialog.kind === "rename-project")
        await actions.renameProject(dialog.project, value);
      else await actions.createProject(value, dialog.conversation);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const title = conversation
    ? "Rename conversation"
    : dialog.kind === "rename-project"
      ? "Rename project"
      : "New project";
  return (
    <KnowledgeModal
      isOpen
      onClose={closeProjectDialog}
      size="sm"
      title={title}
      guard={busy}
      footer={
        <>
          <Button
            variant="tertiary"
            onPress={closeProjectDialog}
            isDisabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onPress={() => void save()}
            isPending={busy}
          >
            {dialog.kind === "new-project" ? "Create" : "Save"}
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void save(e)}>
        <TextField
          value={name}
          onChange={(v) => {
            setName(v);
            if (error) setError("");
          }}
          isInvalid={!!error}
          maxLength={conversation ? undefined : PROJECT_NAME_MAX}
          autoFocus
          fullWidth
        >
          <Label>Name</Label>
          <Input translate="no" />
          <FieldError>{error}</FieldError>
        </TextField>
      </form>
    </KnowledgeModal>
  );
}
