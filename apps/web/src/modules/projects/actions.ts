"use client";

import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";

import { confirm } from "@/components/ui/Confirm";
import { toast } from "@/components/ui/Toast";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import type { Item } from "@/modules/knowledge/api";

import { projectsAdapter } from "./adapter";
import {
  conversationTitle,
  deleteConversation,
  undeleteConversation,
  updateConversation,
  type Conversation,
} from "./conversations";
import {
  conversationKeys,
  invalidateConversations,
  useProjectScope,
} from "./queries";
import { closeProjectDialog, setFolderOpen } from "./store";
import { MAX_PROJECT_REFERENCES, type Project } from "./types";

const fail = (error: unknown) => toast(errorMessage(error), { tone: "danger" });

/**
 * Conversation and project mutations with the preview's feedback: confirm destructive steps,
 * toast with Undo where cheaply reversible, keep the user on a sensible page.
 */
export function useProjectActions() {
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const scope = useProjectScope();
  const ws = scope.workspace;

  const patchCached = (name: string, patch: Partial<Conversation>) =>
    qc.setQueryData<Conversation[]>(conversationKeys.list(ws), (list) =>
      list?.map((c) => (c.name === name ? { ...c, ...patch } : c)),
    );

  async function setTitle(conversation: Conversation, displayName: string) {
    const name = conversation.name ?? "";
    await updateConversation(ws, name, { displayName }, ["displayName"]);
    patchCached(name, { displayName });
    invalidateConversations(qc, ws);
  }

  /** Rename (dialog save). Throws so the dialog can stay open on failure. */
  async function renameConversation(
    conversation: Conversation,
    displayName: string,
  ) {
    const before = conversation.displayName ?? "";
    await setTitle(conversation, displayName);
    toast("Conversation renamed", {
      undo: () => void setTitle(conversation, before).catch(fail),
    });
  }

  /** Delete with confirmation; Undo restores it (and reopens it when it was open). */
  async function removeConversation(
    conversation: Conversation,
    onDeleted?: () => void,
  ) {
    const name = conversation.name ?? "";
    const ok = await confirm({
      title: "Delete this conversation?",
      description: `“${conversationTitle(conversation)}” will be removed from your conversations.`,
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    const href = `/chat/${resourceId(name)}`;
    const wasOpen = pathname === href;
    try {
      await deleteConversation(ws, name);
    } catch (error) {
      return fail(error);
    }
    qc.setQueryData<Conversation[]>(conversationKeys.list(ws), (list) =>
      list?.filter((c) => c.name !== name),
    );
    invalidateConversations(qc, ws);
    onDeleted?.();
    if (wasOpen) router.push("/chat");
    toast("Conversation deleted", {
      undo: () =>
        void undeleteConversation(ws, name)
          .then(() => {
            invalidateConversations(qc, ws);
            if (wasOpen) router.push(href);
          })
          .catch(fail),
    });
  }

  /** File a conversation in a project or (`null`) back in Recent; Undo puts it back. */
  async function moveConversation(
    conversation: Conversation,
    target: Project | null,
    from: Project | null,
  ) {
    const name = conversation.name ?? "";
    if ((target?.id ?? null) === (from?.id ?? null)) return;
    try {
      await projectsAdapter.setConversationProject(
        scope,
        name,
        target?.id ?? null,
      );
    } catch (error) {
      return fail(error);
    }
    if (target) setFolderOpen(target.id, true);
    toast(
      target ? `Moved to “${target.displayName}”` : "Removed from the project",
      {
        undo: () =>
          void projectsAdapter
            .setConversationProject(scope, name, from?.id ?? null)
            .catch(fail),
      },
    );
  }

  /** Create a project (dialog save). With a conversation it moves there; otherwise the new project opens. */
  async function createProject(
    displayName: string,
    conversation?: Conversation,
  ) {
    const project = await projectsAdapter.create(scope, {
      displayName,
      conversations: conversation?.name ? [conversation.name] : [],
    });
    setFolderOpen(project.id, true);
    closeProjectDialog();
    if (conversation) toast(`Moved to “${displayName}”`);
    else router.push(`/project/${project.id}`);
  }

  /** Rename (dialog save); Undo restores the old name. */
  async function renameProject(project: Project, displayName: string) {
    await projectsAdapter.update(scope, project.id, { displayName });
    closeProjectDialog();
    toast("Project renamed", {
      undo: () =>
        void projectsAdapter
          .update(scope, project.id, { displayName: project.displayName })
          .catch(fail),
    });
  }

  /** Delete with confirmation; its conversations return to Recent. Undo restores both. */
  async function deleteProject(project: Project, conversationCount: number) {
    const ok = await confirm({
      title: `Delete “${project.displayName}”?`,
      description: conversationCount
        ? `Its ${plural(conversationCount, "conversation")} move to Recent. Knowledge documents are not affected.`
        : "Knowledge documents are not affected.",
      confirmLabel: "Delete project",
      tone: "danger",
    });
    if (!ok) return;
    const href = `/project/${project.id}`;
    const here = pathname === href;
    try {
      await projectsAdapter.delete(scope, project.id);
    } catch (error) {
      return fail(error);
    }
    if (here) router.push("/home");
    toast(`Deleted “${project.displayName}”`, {
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
    const fresh = items
      .map((i) => i.name ?? "")
      .filter((n) => n && !project.references.includes(n));
    const added = fresh.slice(
      0,
      MAX_PROJECT_REFERENCES - project.references.length,
    );
    if (!added.length) return;
    try {
      await projectsAdapter.update(scope, project.id, {
        references: [...project.references, ...added],
      });
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
      await projectsAdapter.update(scope, project.id, {
        references: before.filter((r) => r !== item),
      });
    } catch (error) {
      return fail(error);
    }
    toast("Removed from the project", {
      undo: () =>
        void projectsAdapter
          .update(scope, project.id, { references: before })
          .catch(fail),
    });
  }

  return {
    renameConversation,
    removeConversation,
    moveConversation,
    createProject,
    renameProject,
    deleteProject,
    addReferences,
    removeReference,
  };
}
