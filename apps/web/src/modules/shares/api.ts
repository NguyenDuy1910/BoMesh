/**
 * Shares API (`openapi.yaml` tag Workspaces, `database_architecture.md` "Resource shares"): every URL BoMesh hands out.
 * A SHARE points at a document, collection, space or conversation (`/s/{share}`); an INVITE grants a role in the
 * workspace, a space or a collection (`/s/{token}`, shown only in the CreateShare response). Path params are bare IDs.
 */

import { api, call, listAll, requestId, resourceId, type Schema } from "@/lib/api/client";

export type Share = Schema<"Share">;
export type ShareResolution = Schema<"ShareResolution">;

export const shareKeys = {
  all: (ws: string) => [ws, "shares"] as const,
  list: (ws: string, filter: string) => [ws, "shares", "list", filter] as const,
  resolve: (token: string) => ["shares", "resolve", token] as const,
};

/** AIP-160 filter: `target = "…" AND kind = SHARE AND state = ACTIVE`. */
export function shareFilter({ target, kind, state }: { target?: string; kind?: Share["kind"]; state?: Share["state"] }): string {
  return [target && `target = "${target}"`, kind && `kind = ${kind}`, state && `state = ${state}`].filter(Boolean).join(" AND ");
}

/** ListShares: your shares, plus every share of a target whose access you manage. Newest first. */
export function listShares(workspace: string, filter: string): Promise<Share[]> {
  return listAll(
    (pageToken) => call(api.GET("/api/v1/workspaces/{workspace}/shares", { params: { path: { workspace }, query: { filter, pageToken } } })),
    (page) => page.shares,
  );
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
  const live = await listShares(workspace, shareFilter({ target, kind: "SHARE", state: "ACTIVE" }));
  return live.find((s) => s.audience === "WORKSPACE" && s.creator === creator) ?? createShare(workspace, { kind: "SHARE", target, audience: "WORKSPACE" });
}

export const workspaceTarget = (workspace: string) => `workspaces/${workspace}`;
export const memberName = (workspace: string, member: string) => `workspaces/${workspace}/members/${resourceId(member)}`;
