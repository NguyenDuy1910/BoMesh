"use client";

import { Dropdown, Label, Separator } from "@heroui/react";
import {
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import type { Key } from "react";

import { IconButton } from "@/components/ui/IconButton";

import { useProjectActions } from "../actions";
import { openProjectDialog } from "../store";
import type { Project } from "../types";

export interface ProjectMenuProps {
  project: Project;
  /** Conversations in it (for the delete confirmation). */
  conversationCount: number;
  /** Accessible name of the trigger (default "Options for {name}"). */
  label?: string;
  size?: "sm" | "md";
  className?: string;
}

/** Project ⋯ menu (preview `MENUS['proj-row']`): New chat in project, Rename, Delete project. */
export function ProjectMenu({
  project,
  conversationCount,
  label,
  size = "sm",
  className,
}: ProjectMenuProps) {
  const router = useRouter();
  const pathname = usePathname();
  const actions = useProjectActions();
  const href = `/project/${project.id}`;
  const here = pathname === href;

  const onAction = (key: Key) => {
    if (key === "open") router.push(href);
    else if (key === "rename")
      openProjectDialog({ kind: "rename-project", project });
    else if (key === "delete")
      void actions.deleteProject(project, conversationCount);
  };

  return (
    <Dropdown>
      <IconButton
        icon={MoreHorizontal}
        tip={label ?? `Options for ${project.displayName}`}
        size={size}
        showTip={false}
        className={className}
      />
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label={label ?? `Options for ${project.displayName}`}
          onAction={onAction}
        >
          <Dropdown.Section>
            {here ? null : (
              <Dropdown.Item id="open" textValue="New chat in project">
                <MessageSquarePlus className="i" aria-hidden />
                <Label>New chat in project</Label>
              </Dropdown.Item>
            )}
            <Dropdown.Item id="rename" textValue="Rename">
              <Pencil className="i" aria-hidden />
              <Label>Rename</Label>
            </Dropdown.Item>
          </Dropdown.Section>
          <Separator />
          <Dropdown.Section>
            <Dropdown.Item
              id="delete"
              textValue="Delete project"
              variant="danger"
            >
              <Trash2 className="i" aria-hidden />
              <Label>Delete project</Label>
            </Dropdown.Item>
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
