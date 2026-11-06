"use client";

import { api, call, listAll, requestId, resourceId, type Schema } from "@/lib/api/client";

import type { AccessRequest, Item, Policy } from "./model";

/**
 * Knowledge-base calls that the shared knowledge API doesn't cover: create a root
 * collection, its IAM policy, COLLECTION_ACCESS requests, the sources feeding it,
 * and the people/groups it can be shared with.
 */

export type Member = Schema<"Member">;
export type Group = Schema<"Group">;

const it = (workspace: string, item: string) => ({ workspace, item: resourceId(item) });

/* ═══════════════ Bases ═══════════════ */

export interface NewBase {
  displayName: string;
  description?: string;
  /** `false` hides it from members who can't read it (general access "Only me"/"Only owners"). */
  discoverable: boolean;
  /** Space name (Spaces module). */
  space?: string;
}

/** CreateItem (root COLLECTION). The creator becomes its owner. New bases accept contributions, as in the preview. */
export function createBase(workspace: string, base: NewBase): Promise<Item> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/items", {
      params: { path: { workspace }, query: { requestId: requestId() } },
      body: {
        itemType: "COLLECTION",
        displayName: base.displayName,
        parentItem: "",
        collection: { description: base.description || undefined, discoverable: base.discoverable, acceptsContributions: true, space: base.space || undefined },
      },
    }),
  );
}

/* ═══════════════ IAM ═══════════════ */

export function getItemIamPolicy(workspace: string, item: string): Promise<Policy> {
  return call(api.POST("/api/v1/workspaces/{workspace}/items/{item}:getIamPolicy", { params: { path: it(workspace, item) }, body: {} }));
}

/** Replaces the policy (send the `etag` read with it; a stale one is ABORTED). */
export function setItemIamPolicy(workspace: string, item: string, policy: Policy): Promise<Policy> {
  return call(api.POST("/api/v1/workspaces/{workspace}/items/{item}:setIamPolicy", { params: { path: it(workspace, item) }, body: { policy } }));
}

/* ═══════════════ Access requests ═══════════════ */

/** COLLECTION_ACCESS requests the caller filed or may decide (owners), newest first. */
export function listAccessRequests(workspace: string, { open = false }: { open?: boolean } = {}): Promise<AccessRequest[]> {
  const filter = open ? "kind = COLLECTION_ACCESS AND (state = OPEN OR state = NEEDS_INFO)" : "kind = COLLECTION_ACCESS";
  return listAll(
    (pageToken) => call(api.GET("/api/v1/workspaces/{workspace}/requests", { params: { path: { workspace }, query: { filter, orderBy: "createTime desc", pageSize: 100, pageToken } } })),
    (page) => page.requests,
    500,
  );
}

export function createAccessRequest(workspace: string, input: { base: Item; role: "viewer" | "editor"; reason: string }): Promise<AccessRequest> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/requests", {
      params: { path: { workspace }, query: { requestId: requestId() } },
      body: {
        kind: "COLLECTION_ACCESS",
        collection: input.base.name,
        requestedRole: input.role === "editor" ? "roles/collectionEditor" : "roles/collectionViewer",
        title: `Access to ${input.base.displayName ?? ""}`.slice(0, 200),
        question: input.reason,
      },
    }),
  );
}

export function approveRequest(workspace: string, request: string): Promise<AccessRequest> {
  return call(api.POST("/api/v1/workspaces/{workspace}/requests/{request}:approve", { params: { path: { workspace, request: resourceId(request) } }, body: {} }));
}

export function denyRequest(workspace: string, request: string): Promise<AccessRequest> {
  return call(api.POST("/api/v1/workspaces/{workspace}/requests/{request}:deny", { params: { path: { workspace, request: resourceId(request) } }, body: {} }));
}

/* ═══════════════ People and groups ═══════════════ */

export function listActiveMembers(workspace: string): Promise<Member[]> {
  return listAll(
    (pageToken) => call(api.GET("/api/v1/workspaces/{workspace}/members", { params: { path: { workspace }, query: { filter: "state = ACTIVE", pageSize: 200, pageToken } } })),
    (page) => page.members,
    2000,
  );
}

export function listGroups(workspace: string): Promise<Group[]> {
  return listAll(
    (pageToken) => call(api.GET("/api/v1/workspaces/{workspace}/groups", { params: { path: { workspace }, query: { pageSize: 200, pageToken } } })),
    (page) => page.groups,
    1000,
  );
}
