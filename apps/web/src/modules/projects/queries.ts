"use client";

import {
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { ApiError, resourceId } from "@/lib/api/client";
import { getSession, useSession } from "@/lib/session";
import { useWorkspace } from "@/lib/workspace";
import { getItem, type Item } from "@/modules/knowledge/api";
import { knowledgeKeys } from "@/modules/knowledge/queries";

import { projectsAdapter } from "./adapter";
import {
  answerFirstLine,
  conversationTime,
  getLastAnswer,
  listConversations,
  type Conversation,
} from "./conversations";
import type { Project, ProjectScope } from "./types";

/** Query keys. Conversation keys are shared with the chat module: invalidate `conversationKeys.all` after creating one. */
export const conversationKeys = {
  all: (ws: string) => [ws, "conversations"] as const,
  list: (ws: string) => [ws, "conversations", "list"] as const,
  lastAnswer: (ws: string, conversation: string, at: string) =>
    [ws, "conversations", "lastAnswer", conversation, at] as const,
};
export const projectKeys = {
  all: (ws: string) => [ws, "projects"] as const,
  list: (ws: string, user: string) => [ws, "projects", user] as const,
};

/** The caller's project scope (workspace + user). */
export function useProjectScope(): ProjectScope {
  const { id } = useWorkspace();
  const session = useSession();
  return { workspace: id, user: session?.user.name ?? "" };
}

export function invalidateConversations(qc: QueryClient, ws: string) {
  void qc.invalidateQueries({ queryKey: conversationKeys.all(ws) });
}

/** Every conversation the caller owns. */
export function useConversations() {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: conversationKeys.list(id),
    queryFn: () => listConversations(id),
    staleTime: 30_000,
  });
}

/** The caller's projects (empty when projects are unavailable); refreshes on every adapter change. */
export function useProjects() {
  const scope = useProjectScope();
  const qc = useQueryClient();
  const key = projectKeys.list(scope.workspace, scope.user);
  useEffect(
    () =>
      projectsAdapter.subscribe(
        () =>
          void qc.invalidateQueries({
            queryKey: projectKeys.all(scope.workspace),
          }),
      ),
    [qc, scope.workspace],
  );
  return useQuery({
    queryKey: key,
    queryFn: () => projectsAdapter.list(scope),
    enabled: !!scope.user,
    staleTime: Infinity,
  });
}

/** A project with its live conversations, most recent first. */
export interface ProjectView {
  project: Project;
  conversations: Conversation[];
  /** Last use: latest chat activity or creation (preview `lastAt`). */
  lastAt: number;
}

export interface ConversationModel {
  conversations: Conversation[];
  /** Projects, most recently used first. */
  projects: ProjectView[];
  /** Conversations in no project, most recent first (sidebar Recent). */
  loose: Conversation[];
  /** Project holding a conversation, by conversation name. */
  projectOf: ReadonlyMap<string, Project>;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
}

/** Conversations joined with projects: each conversation appears once, in its project or in Recent. */
export function useConversationModel(): ConversationModel {
  const conversations = useConversations();
  const projects = useProjects();
  const model = useMemo(() => {
    const list = [...(conversations.data ?? [])].sort(
      (a, b) => conversationTime(b) - conversationTime(a),
    );
    const byName = new Map(list.map((c) => [c.name ?? "", c]));
    const projectOf = new Map<string, Project>();
    const views = (projects.data ?? []).map((project) => {
      const convs = project.conversations
        .map((n) => byName.get(n))
        .filter((c): c is Conversation => !!c && !projectOf.has(c.name ?? ""));
      convs.forEach((c) => projectOf.set(c.name ?? "", project));
      convs.sort((a, b) => conversationTime(b) - conversationTime(a));
      return {
        project,
        conversations: convs,
        lastAt: Math.max(
          Date.parse(project.createTime) || 0,
          ...convs.map(conversationTime),
        ),
      };
    });
    views.sort((a, b) => b.lastAt - a.lastAt);
    return {
      conversations: list,
      projects: views,
      loose: list.filter((c) => !projectOf.has(c.name ?? "")),
      projectOf,
    };
  }, [conversations.data, projects.data]);
  return {
    ...model,
    isPending:
      conversations.isPending ||
      (projects.isPending && projects.fetchStatus !== "idle"),
    isError: conversations.isError || projects.isError,
    error: conversations.error ?? projects.error,
    refetch: () => {
      void conversations.refetch();
      void projects.refetch();
    },
  };
}

/** The project a conversation is filed in, or null (also null when projects are unavailable). */
export function useConversationProject(
  conversation: string | undefined | null,
): Project | null {
  const projects = useProjects();
  if (!conversation) return null;
  const name = conversation.includes("/") ? conversation : null;
  const id = resourceId(conversation);
  return (
    projects.data?.find((p) =>
      p.conversations.some((c) => (name ? c === name : resourceId(c) === id)),
    ) ?? null
  );
}

/** First line of the conversation's latest answer, loaded on demand and cached per activity time. */
export function useLastAnswer(conversation: Conversation): string {
  const { id } = useWorkspace();
  const at = conversation.lastMessageTime ?? "";
  const query = useQuery({
    queryKey: conversationKeys.lastAnswer(id, conversation.name ?? "", at),
    queryFn: () => getLastAnswer(id, conversation.name ?? ""),
    enabled: !!at && !!conversation.name,
    staleTime: Infinity,
    retry: false,
  });
  return answerFirstLine(query.data?.text);
}

/**
 * Knowledge references of a project the caller can open now (never the others), in the
 * project's order. Unreadable or deleted items are dropped silently.
 */
export function useProjectReferences(projectId: string | undefined | null): {
  items: Item[];
  isPending: boolean;
} {
  const { id: ws } = useWorkspace();
  const projects = useProjects();
  const refs = projects.data?.find((p) => p.id === projectId)?.references ?? [];
  const results = useQueries({
    queries: refs.map((ref) => ({
      queryKey: knowledgeKeys.item(ws, resourceId(ref)),
      queryFn: () => getItem(ws, resourceId(ref)),
      retry: (count: number, error: unknown) =>
        !(error instanceof ApiError && error.status < 500) && count < 2,
      staleTime: 60_000,
    })),
  });
  const items = results
    .map((r) => r.data)
    .filter(
      (item): item is Item =>
        !!item && item.state !== "DELETED" && item.itemType === "DOCUMENT",
    );
  return {
    items,
    isPending: projects.isPending || results.some((r) => r.isPending),
  };
}

/**
 * Files a newly created conversation in a project (chat module, `/chat?project=`).
 * Resolves without effect when projects are unavailable.
 */
export async function attachConversationToProject(
  workspace: string,
  conversation: string,
  projectId: string,
): Promise<void> {
  const user = getSession()?.user.name;
  if (projectsAdapter.status === "unavailable" || !user || !projectId) return;
  const name = conversation.includes("/")
    ? conversation
    : `workspaces/${workspace}/conversations/${conversation}`;
  await projectsAdapter.setConversationProject(
    { workspace, user },
    name,
    projectId,
  );
}
