"use client";

import { Description, Dropdown, Header, Label, Separator } from "@heroui/react";
import {
  Folder,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import type { Key } from "react";

import { IconButton } from "@/components/ui/IconButton";

import { useProjectActions } from "../actions";
import { PROJECTS_UNAVAILABLE, projectsAvailable } from "../adapter";
import { conversationTitle, type Conversation } from "../conversations";
import { useConversationModel } from "../queries";
import { openProjectDialog } from "../store";

const MOVE_TARGETS = 8;

export interface ConversationMenuProps {
  conversation: Conversation;
  /** Called after the conversation is deleted (before the Undo toast). An open thread is left for `/chat` automatically. */
  onDeleted?: () => void;
  /** Trigger size (default `sm`). */
  size?: "sm" | "md";
  /** Extra trigger class (`side-more` in the sidebar). */
  className?: string;
}

/**
 * Conversation ⋯ menu (preview `MENUS['conv-nav']` / `conv-row`): Rename, Move to project
 * (other projects, New project…, Remove from project), Delete. Without projects (production API)
 * a disabled "Move to project" item states why.
 */
export function ConversationMenu({
  conversation,
  onDeleted,
  size = "sm",
  className,
}: ConversationMenuProps) {
  const title = conversationTitle(conversation);
  return (
    <Dropdown>
      <IconButton
        icon={MoreHorizontal}
        tip={`Options for ${title}`}
        size={size}
        showTip={false}
        className={className}
      />
      <Dropdown.Popover placement="bottom end">
        <ConversationMenuItems
          conversation={conversation}
          onDeleted={onDeleted}
          title={title}
        />
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** Mounted only while the menu is open, so long lists don't each join conversations with projects. */
function ConversationMenuItems({
  conversation,
  onDeleted,
  title,
}: Pick<ConversationMenuProps, "conversation" | "onDeleted"> & {
  title: string;
}) {
  const model = useConversationModel();
  const actions = useProjectActions();
  const current = model.projectOf.get(conversation.name ?? "") ?? null;
  const others = projectsAvailable
    ? model.projects
        .filter((p) => p.project.id !== current?.id)
        .slice(0, MOVE_TARGETS)
    : [];

  const onAction = (key: Key) => {
    const id = String(key);
    if (id === "rename")
      openProjectDialog({ kind: "rename-conversation", conversation });
    else if (id === "delete")
      void actions.removeConversation(conversation, onDeleted);
    else if (id === "new-project")
      openProjectDialog({ kind: "new-project", conversation });
    else if (id === "unfile")
      void actions.moveConversation(conversation, null, current);
    else if (id.startsWith("move:")) {
      const target = model.projects.find(
        (p) => p.project.id === id.slice(5),
      )?.project;
      if (target) void actions.moveConversation(conversation, target, current);
    }
  };

  return (
    <Dropdown.Menu aria-label={`Options for ${title}`} onAction={onAction}>
      <Dropdown.Section>
        <Dropdown.Item id="rename" textValue="Rename">
          <Pencil className="i" aria-hidden />
          <Label>Rename</Label>
        </Dropdown.Item>
      </Dropdown.Section>
      {projectsAvailable ? (
        <Dropdown.Section>
          <Header>
            {current ? "Move to another project" : "Move to project"}
          </Header>
          {others.map(({ project }) => (
            <Dropdown.Item
              key={project.id}
              id={`move:${project.id}`}
              textValue={project.displayName}
            >
              <Folder className="i" aria-hidden />
              <Label className="truncate" translate="no">
                {project.displayName}
              </Label>
            </Dropdown.Item>
          ))}
          <Dropdown.Item id="new-project" textValue="New project…">
            <FolderPlus className="i" aria-hidden />
            <Label>New project…</Label>
          </Dropdown.Item>
          {current ? (
            <Dropdown.Item id="unfile" textValue="Remove from project">
              <X className="i" aria-hidden />
              <Label>Remove from project</Label>
            </Dropdown.Item>
          ) : null}
        </Dropdown.Section>
      ) : (
        <Dropdown.Section>
          <Dropdown.Item
            id="move-unavailable"
            textValue="Move to project"
            isDisabled
          >
            <Folder className="i" aria-hidden />
            <div className="flex flex-col">
              <Label>Move to project</Label>
              <Description>{PROJECTS_UNAVAILABLE}</Description>
            </div>
          </Dropdown.Item>
        </Dropdown.Section>
      )}
      <Separator />
      <Dropdown.Section>
        <Dropdown.Item id="delete" textValue="Delete" variant="danger">
          <Trash2 className="i" aria-hidden />
          <Label>Delete</Label>
        </Dropdown.Item>
      </Dropdown.Section>
    </Dropdown.Menu>
  );
}
