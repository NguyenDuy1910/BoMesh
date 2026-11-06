import { api, call, listAll, type Schema } from "@/lib/api/client";

/** Lists /search reads besides the catalog search (knowledge core) — the caller's conversations, members and roles (admins). */
export type Conversation = Schema<"Conversation">;
export type Member = Schema<"Member">;
export type Role = Schema<"Role">;

/** Every conversation the caller owns, most recent first. */
export function listMyConversations(workspace: string): Promise<Conversation[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/conversations", {
          params: { path: { workspace }, query: { pageSize: 200, pageToken, orderBy: "lastMessageTime desc" } },
        }),
      ),
    (page) => page.conversations,
  );
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
