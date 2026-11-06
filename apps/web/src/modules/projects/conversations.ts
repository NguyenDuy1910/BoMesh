"use client";

import { api, call, listAll, resourceId, type Schema } from "@/lib/api/client";

/** Conversation API used by the conversation lists (`/chats`, sidebar, projects). */

export type Conversation = Schema<"Conversation">;
export type Message = Schema<"Message">;

/** Every conversation the caller owns, most recently active first (ListConversations). */
export function listConversations(workspace: string): Promise<Conversation[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/conversations", {
          params: {
            path: { workspace },
            query: {
              pageSize: 1000,
              pageToken,
              orderBy: "lastMessageTime desc",
            },
          },
        }),
      ),
    (page) => page.conversations,
  );
}

/** UpdateConversation with an explicit field mask. */
export function updateConversation(
  workspace: string,
  conversation: string,
  patch: Conversation,
  updateMask: readonly string[],
): Promise<Conversation> {
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/conversations/{conversation}", {
      params: {
        path: { workspace, conversation: resourceId(conversation) },
        query: { updateMask: updateMask.join(",") },
      },
      body: patch,
    }),
  );
}

/** Soft delete (DeleteConversation); `undeleteConversation` restores it within the retention window. */
export function deleteConversation(
  workspace: string,
  conversation: string,
): Promise<Conversation> {
  return call(
    api.DELETE("/api/v1/workspaces/{workspace}/conversations/{conversation}", {
      params: { path: { workspace, conversation: resourceId(conversation) } },
    }),
  );
}

export function undeleteConversation(
  workspace: string,
  conversation: string,
): Promise<Conversation> {
  return call(
    api.POST(
      "/api/v1/workspaces/{workspace}/conversations/{conversation}:undelete",
      {
        params: { path: { workspace, conversation: resourceId(conversation) } },
        body: {},
      },
    ),
  );
}

/** The latest completed assistant answer of a conversation, if any (ListMessages, newest first, one result). */
export async function getLastAnswer(
  workspace: string,
  conversation: string,
): Promise<Message | null> {
  const page = await call(
    api.GET(
      "/api/v1/workspaces/{workspace}/conversations/{conversation}/messages",
      {
        params: {
          path: { workspace, conversation: resourceId(conversation) },
          query: {
            pageSize: 1,
            orderBy: "createTime desc",
            filter: 'role = "ASSISTANT" AND state = "COMPLETED"',
          },
        },
      },
    ),
  );
  return page.messages?.[0] ?? null;
}

/** Title shown for a conversation (server `displayName`; untitled ones read "New chat"). */
export function conversationTitle(conversation: Conversation): string {
  return conversation.displayName?.trim() || "New chat";
}

/** When the conversation was last active: last message, else creation. */
export function conversationTime(conversation: Conversation): number {
  return (
    Date.parse(
      conversation.lastMessageTime ||
        conversation.createTime ||
        "",
    ) || 0
  );
}

/**
 * First readable line of an answer for list previews (preview `lastLine`): markdown and
 * citation markers removed, a trailing colon dropped.
 */
export function answerFirstLine(markdown: string | undefined): string {
  if (!markdown) return "";
  const line =
    markdown
      .replace(/```[\s\S]*?```/g, "")
      .split("\n")
      .map((l) =>
        l
          .replace(/\[\d{1,3}\]/g, "")
          .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
          .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
          .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "")
          .replace(/[*_`~|]/g, "")
          .trim(),
      )
      .find((l) => l && !/^-{3,}$/.test(l)) ?? "";
  return line.replace(/:\s*$/, "");
}
