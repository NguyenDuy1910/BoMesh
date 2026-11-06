"use client";

import { Button, Tooltip } from "@heroui/react";
import {
  Folder,
  FolderOpen,
  FolderPlus,
  MessageSquarePlus,
  Plus,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { IconButton } from "@/components/ui/IconButton";
import { PreviewChip } from "@/components/ui/PreviewChip";
import { fmtNum } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import {
  DEV_DATA_TOOLTIP,
  PROJECTS_UNAVAILABLE,
  projectsAdapter,
  projectsAvailable,
} from "../adapter";
import { conversationTitle, type Conversation } from "../conversations";
import { useConversationModel, type ProjectView } from "../queries";
import { openProjectDialog, setFolderOpen, useProjectsUi } from "../store";
import { ConversationMenu } from "./ConversationMenu";
import { ProjectDialogs } from "./ProjectDialogs";
import { ProjectMenu } from "./ProjectMenu";

/** Chats shown under an expanded folder before "See all" (preview `KIDS`). */
const KIDS = 6;
/** Conversations in Recent (preview `RECENT`). */
const RECENT = 8;

function ConversationLink({
  conversation,
  pathname,
  sub,
}: {
  conversation: Conversation;
  pathname: string;
  sub?: boolean;
}) {
  const title = conversationTitle(conversation);
  const href = `/chat/${conversation.name?.split("/").pop() ?? ""}`;
  return (
    <div className={sub ? "side-conv side-conv--sub" : "side-conv"}>
      <Link
        className="nav-item nav-item--recent"
        href={href}
        aria-current={pathname === href ? "page" : undefined}
        title={title}
      >
        <span
          className="nav-item__label"
          translate={conversation.displayName ? "no" : undefined}
        >
          {title}
        </span>
      </Link>
      <ConversationMenu conversation={conversation} className="side-more" />
    </div>
  );
}

function ProjectFolder({
  view,
  open,
  pathname,
}: {
  view: ProjectView;
  open: boolean;
  pathname: string;
}) {
  const { project, conversations } = view;
  const href = `/project/${project.id}`;
  const Icon = open ? FolderOpen : Folder;
  return (
    <div className="side-proj">
      <div className="side-conv">
        <button
          type="button"
          className="nav-item side-proj__toggle"
          id={`side-proj-${project.id}`}
          aria-expanded={open}
          title={project.displayName}
          onClick={() => setFolderOpen(project.id, !open)}
        >
          <Icon className="i" aria-hidden />
          <span className="nav-item__label" translate="no">
            {project.displayName}
          </span>
        </button>
        <ProjectMenu
          project={project}
          conversationCount={conversations.length}
          className="side-more"
        />
      </div>
      {open ? (
        <div
          className="side-kids"
          role="group"
          aria-label={project.displayName}
        >
          {conversations.slice(0, KIDS).map((c) => (
            <ConversationLink
              key={c.name}
              conversation={c}
              pathname={pathname}
              sub
            />
          ))}
          {conversations.length > KIDS ? (
            <Link
              className="nav-item nav-item--recent side-kids__more"
              href={href}
            >
              <span className="nav-item__label">
                See all {fmtNum(conversations.length)}
              </span>
            </Link>
          ) : null}
          <Link
            className="nav-item nav-item--recent side-kids__new"
            href={href}
            aria-current={pathname === href ? "page" : undefined}
          >
            <MessageSquarePlus className="i i-sm" aria-hidden />
            <span className="nav-item__label">New chat</span>
          </Link>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Sidebar conversation groups (preview `X.projects.sidebar`): Projects (expandable folders
 * with their chats) and Recent (chats in no project), so each conversation appears once.
 * Without projects (production API) the Projects header shows a disabled + with the reason.
 * Also mounts the shared project dialogs.
 */
export function SidebarConversations() {
  const { id: ws } = useWorkspace();
  const pathname = usePathname();
  const model = useConversationModel();
  const { folders } = useProjectsUi();

  const openChat = pathname.startsWith("/chat/")
    ? `workspaces/${ws}/conversations/${pathname.slice(6)}`
    : null;
  const active = pathname.startsWith("/project/")
    ? pathname.slice(9)
    : openChat
      ? model.projectOf.get(openChat)?.id
      : undefined;
  const recent = model.loose.slice(0, RECENT);

  return (
    <>
      {projectsAvailable ? (
        <div className="sidebar__group">
          <div className="sidebar__group-label">
            <span className="row gap-6">
              Projects
              {projectsAdapter.status === "development" ? (
                <PreviewChip
                  label="Development data"
                  tooltip={DEV_DATA_TOOLTIP}
                />
              ) : null}
            </span>
            <IconButton
              icon={Plus}
              tip="New project"
              size="sm"
              className="side-add"
              onPress={() => openProjectDialog({ kind: "new-project" })}
            />
          </div>
          {model.projects.length ? (
            model.projects.map((view) => (
              <ProjectFolder
                key={view.project.id}
                view={view}
                open={folders[view.project.id] ?? view.project.id === active}
                pathname={pathname}
              />
            ))
          ) : (
            <button
              type="button"
              className="nav-item nav-item--recent"
              onClick={() => openProjectDialog({ kind: "new-project" })}
            >
              <FolderPlus className="i i-sm" aria-hidden />
              <span className="nav-item__label">New project</span>
            </button>
          )}
        </div>
      ) : (
        <div className="sidebar__group">
          <div className="sidebar__group-label">
            <span>Projects</span>
            <Tooltip>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label={`New project. ${PROJECTS_UNAVAILABLE}`}
                aria-disabled="true"
                className="button--muted side-add side-add--unavailable"
              >
                <Plus aria-hidden />
              </Button>
              <Tooltip.Content>{PROJECTS_UNAVAILABLE}</Tooltip.Content>
            </Tooltip>
          </div>
        </div>
      )}
      {recent.length ? (
        <div className="sidebar__group">
          <div className="sidebar__group-label">
            <span>Recent</span>
            <Link
              href="/chats"
              aria-current={pathname === "/chats" ? "page" : undefined}
            >
              All
            </Link>
          </div>
          {recent.map((c) => (
            <ConversationLink
              key={c.name}
              conversation={c}
              pathname={pathname}
            />
          ))}
        </div>
      ) : null}
      <ProjectDialogs />
    </>
  );
}
