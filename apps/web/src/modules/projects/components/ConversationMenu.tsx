"use client";

import { Dropdown, Header, Label, Separator } from "@heroui/react";
import { Folder, FolderPlus, MoreHorizontal, Pencil, Trash2, X } from "lucide-react";
import type { Key } from "react";

import { IconButton } from "@/components/ui/IconButton";
import { resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { useProjectActions } from "../actions";
import { projectsAvailable } from "../adapter";
import { conversationTitle, type Conversation } from "../conversations";
import { useConversationModel } from "../queries";
import { openProjectDialog } from "../store";

const MOVE_TARGETS = 8;

export interface ConversationMenuProps {
  conversation: Conversation;
  /** Trigger size (default `sm`). */
  size?: "sm" | "md";
  /** Extra trigger class. */
  className?: string;
}

/**
 * The one conversation ⋯ menu (preview `conversations.js` `menu()`), wherever a conversation shows: Rename, Move to
 * project (other projects, New project…, Remove from project; only with projects), Delete conversation (at once, with Undo).
 */
export function ConversationMenu({ conversation, size = "sm", className }: ConversationMenuProps) {
  const title = conversationTitle(conversation);
  return (
    <Dropdown>
      <IconButton icon={MoreHorizontal} tip={`Tùy chọn cho ${title}`} size={size} showTip={false} className={className} />
      <Dropdown.Popover placement="bottom end">
        <ConversationMenuItems conversation={conversation} title={title} />
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** Mounted only while the menu is open, so long lists don't each join conversations with projects. */
function ConversationMenuItems({ conversation, title }: { conversation: Conversation; title: string }) {
  const { hasModule } = useWorkspace();
  // Without projects there is nothing to join, so the menu never loads every conversation.
  const model = useConversationModel(projectsAvailable);
  const actions = useProjectActions();
  const current = model.projectOf.get(conversation.name ?? "") ?? null;
  const others = projectsAvailable ? model.projects.filter((p) => p.project.id !== current?.id).slice(0, MOVE_TARGETS) : [];
  // One level up from an open conversation: its project, its space, else New chat.
  const space = hasModule("spaces") ? conversation.scope?.spaces?.[0] : undefined;
  const parent = current ? `/project/${current.id}` : space ? `/space/${resourceId(space)}` : "/chat";

  const onAction = (key: Key) => {
    const id = String(key);
    if (id === "rename") openProjectDialog({ kind: "rename-conversation", conversation });
    else if (id === "delete") void actions.removeConversation(conversation, parent);
    else if (id === "new-project") openProjectDialog({ kind: "new-project", conversation });
    else if (id === "unfile") void actions.moveConversation(conversation, null, current);
    else if (id.startsWith("move:")) {
      const target = model.projects.find((p) => p.project.id === id.slice(5))?.project;
      if (target) void actions.moveConversation(conversation, target, current);
    }
  };

  return (
    <Dropdown.Menu aria-label={`Tùy chọn cho ${title}`} onAction={onAction}>
      <Dropdown.Section>
        <Dropdown.Item id="rename" textValue="Đổi tên">
          <Pencil className="i" aria-hidden />
          <Label>Đổi tên</Label>
        </Dropdown.Item>
      </Dropdown.Section>
      {projectsAvailable ? (
        <Dropdown.Section>
          <Header>{current ? "Chuyển sang dự án khác" : "Chuyển vào dự án"}</Header>
          {others.map(({ project }) => (
            <Dropdown.Item key={project.id} id={`move:${project.id}`} textValue={project.displayName}>
              <Folder className="i" aria-hidden />
              <Label className="truncate" translate="no">
                {project.displayName}
              </Label>
            </Dropdown.Item>
          ))}
          <Dropdown.Item id="new-project" textValue="Dự án mới…">
            <FolderPlus className="i" aria-hidden />
            <Label>Dự án mới…</Label>
          </Dropdown.Item>
          {current ? (
            <Dropdown.Item id="unfile" textValue="Gỡ khỏi dự án">
              <X className="i" aria-hidden />
              <Label>Gỡ khỏi dự án</Label>
            </Dropdown.Item>
          ) : null}
        </Dropdown.Section>
      ) : null}
      <Separator />
      <Dropdown.Section>
        <Dropdown.Item id="delete" textValue="Xóa cuộc trò chuyện" variant="danger">
          <Trash2 className="i" aria-hidden />
          <Label>Xóa cuộc trò chuyện</Label>
        </Dropdown.Item>
      </Dropdown.Section>
    </Dropdown.Menu>
  );
}
