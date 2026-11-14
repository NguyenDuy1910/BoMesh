"use client";

import { Dropdown, Label, Separator } from "@heroui/react";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { Key } from "react";

import { IconButton } from "@/components/ui/IconButton";

import { useProjectActions } from "../actions";
import { openProjectDialog } from "../store";
import type { Project } from "../types";

export interface ProjectMenuProps {
  project: Project;
  /** Conversations in it (the delete toast says they stay in AI Chat). */
  conversationCount: number;
  /** Accessible name of the trigger (default "Options for {name}"). */
  label?: string;
  size?: "sm" | "md";
  className?: string;
}

/**
 * Project ⋯ menu (preview `MENUS['proj-row']`): only what the row can't do — Rename, Delete project (at once, with
 * Undo). New chats start on the project page, which the row opens.
 */
export function ProjectMenu({ project, conversationCount, label, size = "sm", className }: ProjectMenuProps) {
  const actions = useProjectActions();
  const name = label ?? `Options for ${project.displayName}`;
  const onAction = (key: Key) => {
    if (key === "rename") openProjectDialog({ kind: "rename-project", project });
    else if (key === "delete") void actions.deleteProject(project, conversationCount);
  };
  return (
    <Dropdown>
      <IconButton icon={MoreHorizontal} tip={name} size={size} showTip={false} className={className} />
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label={name} onAction={onAction}>
          <Dropdown.Item id="rename" textValue="Rename">
            <Pencil className="i" aria-hidden />
            <Label>Rename</Label>
          </Dropdown.Item>
          <Separator />
          <Dropdown.Item id="delete" textValue="Delete project" variant="danger">
            <Trash2 className="i" aria-hidden />
            <Label>Delete project</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
