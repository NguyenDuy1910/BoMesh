import { api, call, type Schema } from "@/lib/api/client";

export type MemberHome = Schema<"MemberHome">;
export type MemberHomeItem = Schema<"MemberHomeItem">;
export type ItemRevision = Schema<"ItemRevision">;

/** The caller's Home read model (`members/{member}/home`): counts, suggested questions, topics, featured, recommended, continue. */
export function getMemberHome(workspace: string, member: string): Promise<MemberHome> {
  return call(api.GET("/api/v1/workspaces/{workspace}/members/{member}/home", { params: { path: { workspace, member } } }));
}

/** One document revision by name (`workspaces/{w}/items/{i}/revisions/{n}`); Worth knowing reads the current one's change note. */
export function getItemRevision(workspace: string, revision: string): Promise<ItemRevision> {
  const [, , , item, , number] = revision.split("/");
  return call(api.GET("/api/v1/workspaces/{workspace}/items/{item}/revisions/{revision}", { params: { path: { workspace, item, revision: number } } }));
}
