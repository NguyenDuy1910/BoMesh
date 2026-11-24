import { api, call, listAll, type Schema } from "@/lib/api/client";

/** Lists /search reads besides the catalog search (knowledge core) — the caller's recent conversations, members and roles (admins). */
export type Conversation = Schema<"Conversation">;
export type Member = Schema<"Member">;
export type Role = Schema<"Role">;

/** How many of the caller's most recent conversations Search matches titles against. */
export const SEARCHED_CONVERSATIONS = 200;

/**
 * The caller's {@link SEARCHED_CONVERSATIONS} most recently active conversations (one ListConversations page). Search matches
 * their titles locally with `fold()`, so "lich" finds "Lịch" (the server's `displayName` filter is not accent-insensitive).
 */
export async function listRecentConversationPage(workspace: string): Promise<Conversation[]> {
  const page = await call(
    api.GET("/api/v1/workspaces/{workspace}/conversations", {
      params: { path: { workspace }, query: { pageSize: SEARCHED_CONVERSATIONS, orderBy: "lastMessageTime desc" } },
    }),
  );
  return page.conversations ?? [];
}

export function listMembers(workspace: string): Promise<Member[]> {
  return listAll(
    (pageToken) => call(api.GET("/api/v1/workspaces/{workspace}/members", { params: { path: { workspace }, query: { pageSize: 500, pageToken } } })),
    (page) => page.members,
  );
}

export function listRoles(workspace: string): Promise<Role[]> {
  return listAll(
    (pageToken) => call(api.GET("/api/v1/workspaces/{workspace}/roles", { params: { path: { workspace }, query: { pageSize: 200, pageToken } } })),
    (page) => page.roles,
  );
}
