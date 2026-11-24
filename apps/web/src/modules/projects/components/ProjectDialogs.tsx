"use client";

import { Button, Description, FieldError, Input, Label, TextField } from "@heroui/react";
import { FolderPlus, Pencil, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";

import { errorMessage } from "@/lib/api/client";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";

import { useProjectActions } from "../actions";
import { conversationTitle } from "../conversations";
import { useConversationProject, useProjects } from "../queries";
import { closeProjectDialog, useProjectDialog, type ProjectDialog } from "../store";
import { PROJECT_NAME_MAX } from "../types";

const CONVERSATION_NAME_MAX = 80;

/**
 * Name dialogs opened from conversation and project menus (preview `M['conv-rename']`, `M['proj-name']`).
 * Each page with those menus mounts it once.
 */
export function ProjectDialogs() {
  const dialog = useProjectDialog();
  if (!dialog) return null;
  // Keyed so each opening starts from the current name.
  const key = dialog.kind === "rename-project" ? `rp:${dialog.project.id}` : `${dialog.kind}:${dialog.conversation?.name ?? ""}`;
  return <NameDialog key={key} dialog={dialog} />;
}

function NameDialog({ dialog }: { dialog: ProjectDialog }) {
  const actions = useProjectActions();
  const projects = useProjects();
  const conversation = dialog.kind === "rename-conversation" ? dialog.conversation : dialog.kind === "new-project" ? dialog.conversation : undefined;
  const from = useConversationProject(dialog.kind === "new-project" ? conversation?.name : null);
  const renamingConversation = dialog.kind === "rename-conversation";
  const max = renamingConversation ? CONVERSATION_NAME_MAX : PROJECT_NAME_MAX;
  const initial = dialog.kind === "rename-conversation" ? (dialog.conversation.displayName ?? "") : dialog.kind === "rename-project" ? dialog.project.displayName : "";
  const [name, setName] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);

  // Required; project names are unique among your projects so two folders never read the same.
  const value = name.trim();
  const self = dialog.kind === "rename-project" ? dialog.project.id : null;
  const problem = !value
    ? "Nhập tên."
    : !renamingConversation && (projects.data ?? []).some((p) => p.id !== self && p.displayName.trim().toLowerCase() === value.toLowerCase())
      ? "Bạn đã có một dự án với tên này."
      : "";
  const error = (touched ? problem : "") || failure;

  async function save(event?: FormEvent) {
    event?.preventDefault();
    setTouched(true);
    if (problem || busy) return;
    setBusy(true);
    try {
      if (dialog.kind === "rename-conversation") {
        if (value !== (dialog.conversation.displayName ?? "")) await actions.renameConversation(dialog.conversation, value);
        closeProjectDialog();
      } else if (dialog.kind === "rename-project") await actions.renameProject(dialog.project, value);
      else await actions.createProject(value, dialog.conversation, from);
    } catch (e) {
      setFailure(errorMessage(e));
      setBusy(false);
    }
  }

  const creating = dialog.kind === "new-project";
  const title = renamingConversation ? "Đổi tên cuộc trò chuyện" : creating ? "Tạo dự án" : "Đổi tên dự án";
  const hint = creating ? (conversation ? `“${conversationTitle(conversation)}” sẽ được chuyển vào dự án này.` : "Chỉ bạn mới thấy các dự án của mình.") : "";
  return (
    <KnowledgeModal
      isOpen
      onClose={closeProjectDialog}
      size="sm"
      icon={creating ? FolderPlus : Pencil}
      title={title}
      description={creating ? "Gom các cuộc trò chuyện liên quan lại với nhau, cùng tài liệu mà mọi cuộc trò chuyện mới sẽ bắt đầu từ đó." : undefined}
      guard={busy}
      footer={
        <>
          <Button variant="ghost" onPress={closeProjectDialog} isDisabled={busy}>
            Hủy
          </Button>
          <Button variant="primary" onPress={() => void save()} isPending={busy}>
            {creating ? <Plus className="i" aria-hidden /> : null}
            {creating ? "Tạo dự án" : "Đổi tên"}
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void save(e)}>
        <TextField
          value={name}
          onChange={(v) => {
            setName(v);
            setFailure("");
          }}
          isInvalid={!!error}
          maxLength={max}
          isDisabled={busy}
          autoFocus
          fullWidth
        >
          <Label>Tên</Label>
          <Input translate="no" placeholder={creating ? "VD: Rà soát quyền truy cập hằng quý" : undefined} />
          {hint && !error ? <Description translate={conversation ? "no" : undefined}>{hint}</Description> : null}
          <FieldError>{error}</FieldError>
        </TextField>
      </form>
    </KnowledgeModal>
  );
}
