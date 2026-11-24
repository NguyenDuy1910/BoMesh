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
  /** Conversations in it (the delete toast says they stay in Recent). */
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
  const name = label ?? `Tùy chọn cho ${project.displayName}`;
  const onAction = (key: Key) => {
    if (key === "rename") openProjectDialog({ kind: "rename-project", project });
    else if (key === "delete") void actions.deleteProject(project, conversationCount);
  };
  return (
    <Dropdown>
      <IconButton icon={MoreHorizontal} tip={name} size={size} showTip={false} className={className} />
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label={name} onAction={onAction}>
          <Dropdown.Item id="rename" textValue="Đổi tên">
            <Pencil className="i" aria-hidden />
            <Label>Đổi tên</Label>
          </Dropdown.Item>
          <Separator />
          <Dropdown.Item id="delete" textValue="Xóa dự án" variant="danger">
            <Trash2 className="i" aria-hidden />
            <Label>Xóa dự án</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
