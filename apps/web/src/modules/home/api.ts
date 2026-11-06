import { api, call, type Schema } from "@/lib/api/client";

export type MemberHome = Schema<"MemberHome">;
export type MemberHomeItem = Schema<"MemberHomeItem">;
export type ItemRevision = Schema<"ItemRevision">;

/** The caller's Home read model (`members/{member}/home`): counts, suggested questions, topics, featured, recommended, continue. */
export function getMemberHome(workspace: string, member: string): Promise<MemberHome> {
  return call(api.GET("/api/v1/workspaces/{workspace}/members/{member}/home", { params: { path: { workspace, member } } }));
}

/** A document's revisions, newest first (Worth knowing reads the latest change note and the version number). */
export async function listItemRevisions(workspace: string, item: string): Promise<ItemRevision[]> {
  const page = await call(api.GET("/api/v1/workspaces/{workspace}/items/{item}/revisions", { params: { path: { workspace, item }, query: { pageSize: 100 } } }));
  return page.revisions ?? [];
}
