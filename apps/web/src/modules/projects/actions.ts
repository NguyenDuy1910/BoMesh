"use client";

import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";

import { toast } from "@/components/ui/Toast";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import type { Item } from "@/modules/knowledge/api";

import { projectsAdapter } from "./adapter";
import { conversationTitle, deleteConversation, undeleteConversation, updateConversation, type Conversation } from "./conversations";
import { conversationKeys, invalidateConversations, useProjectScope } from "./queries";
import { closeProjectDialog } from "./store";
import { MAX_PROJECT_REFERENCES, type Project } from "./types";

const fail = (error: unknown) => toast(errorMessage(error), { tone: "danger" });

/**
 * Conversation and project mutations with the preview's feedback (`conversations.js`, `projects.js`):
 * reversible changes apply at once with Undo (Undo restores silently), and deleting the open page goes one level up.
 */
export function useProjectActions() {
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const scope = useProjectScope();
  const ws = scope.workspace;

  const updateList = (update: (list: Conversation[]) => Conversation[]) => {
    for (const key of [conversationKeys.list(ws), conversationKeys.recent(ws)]) qc.setQueryData<Conversation[]>(key, (list) => list && update(list));
  };

  async function setTitle(conversation: Conversation, displayName: string) {
    const name = conversation.name ?? "";
    await updateConversation(ws, name, { displayName }, ["displayName"]);
    updateList((list) => list.map((c) => (c.name === name ? { ...c, displayName } : c)));
    invalidateConversations(qc, ws);
  }

  /** Rename (dialog save). Throws so the dialog can stay open on failure. */
  async function renameConversation(conversation: Conversation, displayName: string) {
    const before = conversation.displayName ?? "";
    await setTitle(conversation, displayName);
    toast(`Renamed to “${displayName}”`, { undo: () => void setTitle(conversation, before).catch(fail) });
  }

  /**
   * Delete at once; Undo puts it back. Deleting the open conversation goes one level up (`parent`:
   * its project, its space, else New chat) and Undo returns to it.
   */
  async function removeConversation(conversation: Conversation, parent = "/chat") {
    const name = conversation.name ?? "";
    const href = `/chat/${resourceId(name)}`;
    const wasOpen = pathname === href;
    try {
      await deleteConversation(ws, name);
    } catch (error) {
      return fail(error);
    }
    updateList((list) => list.filter((c) => c.name !== name));
    invalidateConversations(qc, ws);
    if (wasOpen) router.push(parent);
    toast(`Deleted “${conversationTitle(conversation)}”`, {
      undo: () =>
        void undeleteConversation(ws, name)
          .then(() => {
            invalidateConversations(qc, ws);
            if (wasOpen) router.push(href);
          })
          .catch(fail),
    });
  }

  /** File a conversation in a project, or (`null`) take it out (it stays in Recent); Undo puts it back. */
  async function moveConversation(conversation: Conversation, target: Project | null, from: Project | null) {
    const name = conversation.name ?? "";
    if ((target?.id ?? null) === (from?.id ?? null)) return;
    try {
      await projectsAdapter.setConversationProject(scope, name, target?.id ?? null);
    } catch (error) {
      return fail(error);
    }
    toast(target ? `Moved to “${target.displayName}”` : "Removed from the project", {
      undo: () => void projectsAdapter.setConversationProject(scope, name, from?.id ?? null).catch(fail),
    });
  }

  /** Create a project (dialog save). With a conversation it moves there (Undo moves it back); otherwise the new project opens. */
  async function createProject(displayName: string, conversation?: Conversation, from?: Project | null) {
    const project = await projectsAdapter.create(scope, { displayName, conversations: conversation?.name ? [conversation.name] : [] });
    closeProjectDialog();
    if (conversation?.name) {
      const name = conversation.name;
      toast(`Moved to “${displayName}”`, { undo: () => void projectsAdapter.setConversationProject(scope, name, from?.id ?? null).catch(fail) });
      return;
    }
    router.push(`/project/${project.id}`);
    toast(`Created “${displayName}”`);
  }

  /** Rename (dialog save); Undo restores the old name. */
  async function renameProject(project: Project, displayName: string) {
    if (project.displayName === displayName) return closeProjectDialog();
    await projectsAdapter.update(scope, project.id, { displayName });
    closeProjectDialog();
    toast(`Renamed to “${displayName}”`, {
      undo: () => void projectsAdapter.update(scope, project.id, { displayName: project.displayName }).catch(fail),
    });
  }

  /**
   * Delete at once: its conversations stay in Recent, its documents in Knowledge. Undo restores the project with its
   * conversations. Deleting the open project goes to Projects.
   */
  async function deleteProject(project: Project, conversationCount: number) {
    const href = `/project/${project.id}`;
    const here = pathname === href;
    try {
      await projectsAdapter.delete(scope, project.id);
    } catch (error) {
      return fail(error);
    }
    if (here) router.push("/projects");
    const message = conversationCount
      ? `Deleted “${project.displayName}”. Its ${plural(conversationCount, "conversation")} stay in Recent.`
      : `Deleted “${project.displayName}”`;
    toast(message, {
      undo: () =>
        void projectsAdapter
          .undelete(scope, project.id)
          .then(() => {
            if (here) router.push(href);
          })
          .catch(fail),
    });
  }

  /** Add picked documents (deduplicated, up to the limit). */
  async function addReferences(project: Project, items: readonly Item[]) {
    const fresh = items.map((i) => i.name ?? "").filter((n) => n && !project.references.includes(n));
    const added = fresh.slice(0, MAX_PROJECT_REFERENCES - project.references.length);
    if (!added.length) return;
    try {
      await projectsAdapter.update(scope, project.id, { references: [...project.references, ...added] });
    } catch (error) {
      return fail(error);
    }
    toast(`Added ${plural(added.length, "document")} to the project`);
  }

  /** Remove one reference; Undo puts it back in place. */
  async function removeReference(project: Project, item: string) {
    const before = project.references;
    if (!before.includes(item)) return;
    try {
      await projectsAdapter.update(scope, project.id, { references: before.filter((r) => r !== item) });
    } catch (error) {
      return fail(error);
    }
    toast("Removed from the project", { undo: () => void projectsAdapter.update(scope, project.id, { references: before }).catch(fail) });
  }

  return { renameConversation, removeConversation, moveConversation, createProject, renameProject, deleteProject, addReferences, removeReference };
}
