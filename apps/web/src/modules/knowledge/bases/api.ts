"use client";

import { api, call, listAll, requestId, resourceId, type Schema } from "@/lib/api/client";

import { quote } from "../api";
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
}

/** CreateItem (root COLLECTION). The creator becomes its owner. New bases accept contributions, as in the preview. */
export function createBase(workspace: string, base: NewBase): Promise<Item> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/items", {
      params: { path: { workspace }, query: { requestId: requestId() } },
      body: {
        itemKind: "COLLECTION",
        displayName: base.displayName,
        parentItem: "",
        collection: { description: base.description || undefined, discoverable: base.discoverable, acceptsContributions: true },
      },
    }),
  );
}

/** CreateItem (nested COLLECTION = a folder) under a collection or folder; it reads with its parent's access. */
export function createFolder(workspace: string, parent: string, folder: { displayName: string; description?: string }): Promise<Item> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/items", {
      params: { path: { workspace }, query: { requestId: requestId() } },
      body: {
        itemKind: "COLLECTION",
        displayName: folder.displayName,
        parentItem: parent,
        collection: { description: folder.description || undefined, inheritAccess: true, acceptsContributions: true },
      },
    }),
  );
}

export type CollectionImportRow = Schema<"CollectionImportRow">;
export type ImportCollectionsResult = Schema<"ImportCollectionsResponse">;

/**
 * ImportCollections: creates the folders of a folder tree missing under a collection or folder, in one transaction
 * (`validateOnly` reports what it would do and changes nothing). Rows come from the client's JSON file (`folderTree.ts`).
 */
export function importCollections(workspace: string, item: string, body: { rows: readonly CollectionImportRow[]; validateOnly: boolean }): Promise<ImportCollectionsResult> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/items/{item}:importCollections", {
      params: { path: it(workspace, item) },
      body: { ...body, rows: [...body.rows] },
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

/** One page of COLLECTION_ACCESS requests the caller filed or may decide (owners) matching `filter`, newest first. */
export function listAccessRequests(workspace: string, filter: string, pageSize: number) {
  return call(api.GET("/api/v1/workspaces/{workspace}/requests", { params: { path: { workspace }, query: { filter: `kind = COLLECTION_ACCESS AND ${filter}`, orderBy: "createTime desc", pageSize } } }));
}

export function createAccessRequest(workspace: string, input: { base: Item; role: "viewer" | "editor"; reason: string }): Promise<AccessRequest> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/requests", {
      params: { path: { workspace }, query: { requestId: requestId() } },
      body: {
        kind: "COLLECTION_ACCESS",
        collection: input.base.name,
        requestedRole: input.role === "editor" ? "roles/collectionEditor" : "roles/collectionViewer",
        title: `Quyền truy cập ${input.base.displayName ?? ""}`.slice(0, 200),
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

/** One page of active members whose name or email contains `q` (all active members, by name, for a blank `q`). */
export function searchActiveMembers(workspace: string, q: string, pageSize: number) {
  const term = q.trim().replace(/\*/g, "");
  const match = term ? ` AND (displayName = ${quote(`*${term}*`)} OR email = ${quote(`*${term}*`)})` : "";
  return call(api.GET("/api/v1/workspaces/{workspace}/members", { params: { path: { workspace }, query: { filter: `state = ACTIVE${match}`, orderBy: "displayName", pageSize } } }));
}

/** Every group (bounded workspace configuration: share pickers offer them all). */
export function listGroups(workspace: string): Promise<Group[]> {
  return listAll(
    (pageToken) => call(api.GET("/api/v1/workspaces/{workspace}/groups", { params: { path: { workspace }, query: { pageSize: 200, pageToken } } })),
    (page) => page.groups,
    1000,
  );
}
