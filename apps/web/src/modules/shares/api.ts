/**
 * Shares API (`openapi.yaml` tag Workspaces, `database_architecture.md` "Resource shares"): every URL BoMesh hands out.
 * A SHARE points at a document, collection, space or conversation (`/s/{share}`); an INVITE grants a role in the
 * workspace, a space or a collection (`/s/{token}`, shown only in the CreateShare response). Path params are bare IDs.
 */

import { api, call, requestId, resourceId, type Schema } from "@/lib/api/client";

export type Share = Schema<"Share">;
export type ShareResolution = Schema<"ShareResolution">;

export const shareKeys = {
  all: (ws: string) => [ws, "shares"] as const,
  list: (ws: string, filter: string) => [ws, "shares", "list", filter] as const,
  resolve: (token: string) => ["shares", "resolve", token] as const,
};

/** AIP-160 filter: `target = "…" AND kind = SHARE AND state = ACTIVE AND creator = "…" AND audience = WORKSPACE`. */
export function shareFilter({ target, kind, state, creator, audience }: { target?: string; kind?: Share["kind"]; state?: Share["state"]; creator?: string; audience?: Share["audience"] }): string {
  return [target && `target = "${target}"`, kind && `kind = ${kind}`, state && `state = ${state}`, creator && `creator = "${creator}"`, audience && `audience = ${audience}`]
    .filter(Boolean)
    .join(" AND ");
}

/** One ListShares page: your shares, plus every share of a target whose access you manage. Newest first. */
export async function listSharePage(workspace: string, filter: string, pageSize: number): Promise<Share[]> {
  return (await call(api.GET("/api/v1/workspaces/{workspace}/shares", { params: { path: { workspace }, query: { filter, pageSize } } }))).shares ?? [];
}

export function createShare(workspace: string, body: Share): Promise<Share> {
  return call(api.POST("/api/v1/workspaces/{workspace}/shares", { params: { path: { workspace }, query: { requestId: requestId() } }, body }));
}

/** DeleteShare revokes (final): the URL stops working; grants made by accepted invites stay. */
export function deleteShare(name: string): Promise<Share> {
  const [, workspace, , share] = name.split("/");
  return call(api.DELETE("/api/v1/workspaces/{workspace}/shares/{share}", { params: { path: { workspace, share } } }));
}

/** shares:resolve — what `/s/{token}` does for the signed-in caller; changes nothing. Unknown token → 404. */
export function resolveShare(token: string): Promise<ShareResolution> {
  return call(api.POST("/api/v1/shares:resolve", { body: { token } }));
}

/** shares:accept — accept an invite; returns the resolution with the target now openable. */
export function acceptShare(token: string): Promise<ShareResolution> {
  return call(api.POST("/api/v1/shares:accept", { body: { token } }));
}

/** Your live share of a target to the whole workspace (Copy link reuses it), else a new one. */
export async function workspaceShareOf(workspace: string, target: string, creator: string): Promise<Share> {
  const [live] = await listSharePage(workspace, shareFilter({ target, kind: "SHARE", state: "ACTIVE", creator, audience: "WORKSPACE" }), 1);
  return live ?? createShare(workspace, { kind: "SHARE", target, audience: "WORKSPACE" });
}

export const workspaceTarget = (workspace: string) => `workspaces/${workspace}`;
export const memberName = (workspace: string, member: string) => `workspaces/${workspace}/members/${resourceId(member)}`;
