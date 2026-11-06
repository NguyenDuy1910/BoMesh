import { api, call, listAll, requestId, resourceId, type Schema } from "@/lib/api/client";

import type { Space, SpaceRole } from "./types";

/**
 * Spaces API (`/api/v1/workspaces/{w}/spaces…`, api_design.md §8): spaces, their members
 * (space IAM bindings), announcements, events, request types, plus the requests and
 * artifacts filtered by a space. Space materials live in the knowledge core
 * (`listMaterials` / `createMaterial` / `deleteMaterial`), which LinkToSpacesDialog shares.
 * Every function takes the bare workspace ID first; `space` accepts a bare ID or a full name.
 */

export type SpaceMember = Schema<"SpaceMember">;
export type Announcement = Schema<"Announcement">;
export type SpaceEvent = Schema<"SpaceEvent">;
export type RequestType = Schema<"RequestType">;
export type Request = Schema<"Request">;
export type Artifact = Schema<"Artifact">;
export type Policy = Schema<"Policy">;

const sp = (workspace: string, space: string) => ({ workspace, space: resourceId(space) });
/** Child resource name → path params (`workspaces/w/spaces/s/{collection}/{id}`). */
const child = (name: string) => {
  const parts = name.split("/");
  return { workspace: parts[1], space: parts[3], id: parts[5] };
};
export const spaceName = (workspace: string, space: string) => `workspaces/${workspace}/spaces/${resourceId(space)}`;
export const memberName = (workspace: string, member: string) => `workspaces/${workspace}/members/${resourceId(member)}`;
const lit = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Space permissions the space page tests once (`:testIamPermissions`). */
export const SPACE_PERMISSIONS = [
  "spaces.update",
  "spaces.delete",
  "spaces.setIamPolicy",
  "spaceMembers.list",
  "spaceMembers.create",
  "spaceMembers.delete",
  "announcements.list",
  "announcements.create",
  "announcements.update",
  "announcements.delete",
  "events.list",
  "events.create",
  "events.update",
  "events.delete",
  "materials.list",
  "materials.create",
  "materials.delete",
  "requestTypes.list",
  "requests.approve",
] as const;
export type SpacePermission = (typeof SPACE_PERMISSIONS)[number];

/* ═══════════════ Spaces ═══════════════ */

export function listSpaces(workspace: string): Promise<Space[]> {
  return listAll(
    (pageToken) =>
      call(api.GET("/api/v1/workspaces/{workspace}/spaces", { params: { path: { workspace }, query: { pageSize: 200, pageToken, orderBy: "displayName" } } })),
    (page) => page.spaces,
  );
}

export function getSpace(workspace: string, space: string): Promise<Space> {
  return call(api.GET("/api/v1/workspaces/{workspace}/spaces/{space}", { params: { path: sp(workspace, space) } }));
}

export function createSpace(workspace: string, space: Space): Promise<Space> {
  return call(api.POST("/api/v1/workspaces/{workspace}/spaces", { params: { path: { workspace }, query: { requestId: requestId() } }, body: space }));
}

export function updateSpace(workspace: string, space: string, patch: Space, updateMask: readonly string[]): Promise<Space> {
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/spaces/{space}", {
      params: { path: sp(workspace, space), query: { updateMask: updateMask.join(",") } },
      body: patch,
    }),
  );
}

export function deleteSpace(workspace: string, space: string, etag?: string): Promise<Space> {
  return call(api.DELETE("/api/v1/workspaces/{workspace}/spaces/{space}", { params: { path: sp(workspace, space), query: { etag } } }));
}

export function undeleteSpace(workspace: string, space: string): Promise<Space> {
  return call(api.POST("/api/v1/workspaces/{workspace}/spaces/{space}:undelete", { params: { path: sp(workspace, space) }, body: {} }));
}

export function joinSpace(workspace: string, space: string): Promise<SpaceMember> {
  return call(api.POST("/api/v1/workspaces/{workspace}/spaces/{space}:join", { params: { path: sp(workspace, space) }, body: {} }));
}

export async function leaveSpace(workspace: string, space: string): Promise<void> {
  await call(api.POST("/api/v1/workspaces/{workspace}/spaces/{space}:leave", { params: { path: sp(workspace, space) }, body: {} }));
}

export async function testSpacePermissions(workspace: string, space: string, permissions: readonly string[] = SPACE_PERMISSIONS): Promise<string[]> {
  const res = await call(
    api.POST("/api/v1/workspaces/{workspace}/spaces/{space}:testIamPermissions", {
      params: { path: sp(workspace, space) },
      body: { permissions: [...permissions] },
    }),
  );
  return res.permissions ?? [];
}

export function getSpacePolicy(workspace: string, space: string): Promise<Policy> {
  return call(api.POST("/api/v1/workspaces/{workspace}/spaces/{space}:getIamPolicy", { params: { path: sp(workspace, space) }, body: {} }));
}

export function setSpacePolicy(workspace: string, space: string, policy: Policy): Promise<Policy> {
  return call(api.POST("/api/v1/workspaces/{workspace}/spaces/{space}:setIamPolicy", { params: { path: sp(workspace, space) }, body: { policy } }));
}

/**
 * Gives each person exactly `role` in the space (read-modify-write of the space policy).
 * People not yet in the space join with that role.
 */
export async function setSpaceRole(workspace: string, space: string, members: readonly string[], role: SpaceRole): Promise<void> {
  const policy = await getSpacePolicy(workspace, space);
  const users = new Set(members.map((m) => `user:${resourceId(m)}`));
  const bindings = (policy.bindings ?? [])
    .map((b) => ({ ...b, members: b.members.filter((m) => !users.has(m)) }))
    .filter((b) => b.members.length > 0);
  const target = bindings.find((b) => b.role === role);
  if (target) target.members.push(...users);
  else bindings.push({ role, members: [...users] });
  await setSpacePolicy(workspace, space, { ...policy, bindings });
}

/* ═══════════════ Members ═══════════════ */

export function listSpaceMembers(workspace: string, space: string): Promise<SpaceMember[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/spaces/{space}/members", {
          params: { path: sp(workspace, space), query: { pageSize: 200, pageToken, orderBy: "displayName" } },
        }),
      ),
    (page) => page.members,
    5000,
  );
}

export function createSpaceMember(workspace: string, space: string, member: string): Promise<SpaceMember> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/spaces/{space}/members", {
      params: { path: sp(workspace, space), query: { requestId: requestId() } },
      body: { member: memberName(workspace, member) },
    }),
  );
}

export async function deleteSpaceMember(workspace: string, space: string, member: string): Promise<void> {
  await call(
    api.DELETE("/api/v1/workspaces/{workspace}/spaces/{space}/members/{member}", {
      params: { path: { ...sp(workspace, space), member: resourceId(member) } },
    }),
  );
}

/* ═══════════════ Announcements ═══════════════ */

export function listAnnouncements(workspace: string, space: string): Promise<Announcement[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/spaces/{space}/announcements", {
          params: { path: sp(workspace, space), query: { pageSize: 100, pageToken } },
        }),
      ),
    (page) => page.announcements,
  );
}

export function createAnnouncement(workspace: string, space: string, announcement: Announcement): Promise<Announcement> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/spaces/{space}/announcements", {
      params: { path: sp(workspace, space), query: { requestId: requestId() } },
      body: announcement,
    }),
  );
}

export function updateAnnouncement(name: string, patch: Announcement, updateMask: readonly string[]): Promise<Announcement> {
  const { workspace, space, id } = child(name);
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/spaces/{space}/announcements/{announcement}", {
      params: { path: { workspace, space, announcement: id }, query: { updateMask: updateMask.join(",") } },
      body: patch,
    }),
  );
}

export async function deleteAnnouncement(name: string): Promise<void> {
  const { workspace, space, id } = child(name);
  await call(
    api.DELETE("/api/v1/workspaces/{workspace}/spaces/{space}/announcements/{announcement}", {
      params: { path: { workspace, space, announcement: id } },
    }),
  );
}

/* ═══════════════ Events ═══════════════ */

/** Events starting after `since` (ISO), soonest first. */
export function listSpaceEvents(workspace: string, space: string, since?: string): Promise<SpaceEvent[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/spaces/{space}/events", {
          params: {
            path: sp(workspace, space),
            query: { pageSize: 100, pageToken, orderBy: "startTime", filter: since ? `startTime >= ${lit(since)}` : undefined },
          },
        }),
      ),
    (page) => page.events,
    300,
  );
}

export function createSpaceEvent(workspace: string, space: string, event: SpaceEvent): Promise<SpaceEvent> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/spaces/{space}/events", {
      params: { path: sp(workspace, space), query: { requestId: requestId() } },
      body: event,
    }),
  );
}

export function updateSpaceEvent(name: string, patch: SpaceEvent, updateMask: readonly string[]): Promise<SpaceEvent> {
  const { workspace, space, id } = child(name);
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/spaces/{space}/events/{event}", {
      params: { path: { workspace, space, event: id }, query: { updateMask: updateMask.join(",") } },
      body: patch,
    }),
  );
}

export async function deleteSpaceEvent(name: string): Promise<void> {
  const { workspace, space, id } = child(name);
  await call(api.DELETE("/api/v1/workspaces/{workspace}/spaces/{space}/events/{event}", { params: { path: { workspace, space, event: id } } }));
}

/* ═══════════════ Request types (catalog) ═══════════════ */

export function listRequestTypes(workspace: string, space: string): Promise<RequestType[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/spaces/{space}/requestTypes", {
          params: { path: sp(workspace, space), query: { pageSize: 200, pageToken, orderBy: "displayName" } },
        }),
      ),
    (page) => page.requestTypes,
  );
}

/* ═══════════════ Requests about a space ═══════════════ */

export function listRequests(workspace: string, filter: string, orderBy = "createTime"): Promise<Request[]> {
  return listAll(
    (pageToken) => call(api.GET("/api/v1/workspaces/{workspace}/requests", { params: { path: { workspace }, query: { pageSize: 200, pageToken, filter, orderBy } } })),
    (page) => page.requests,
    1000,
  );
}

/** Requests the space's staff work (SERVICE and QUESTION), every state. */
export function listSpaceQueue(workspace: string, space: string): Promise<Request[]> {
  return listRequests(workspace, `space = ${lit(spaceName(workspace, space))} AND (kind = SERVICE OR kind = QUESTION)`);
}

/** Open requests to join the space (its staff see them). */
export function listJoinRequests(workspace: string, space: string): Promise<Request[]> {
  return listRequests(workspace, `space = ${lit(spaceName(workspace, space))} AND kind = SPACE_MEMBERSHIP AND state = OPEN`);
}

/** The caller's open requests to join any space. */
export function listMyJoinRequests(workspace: string, member: string): Promise<Request[]> {
  return listRequests(workspace, `requester = ${lit(memberName(workspace, member))} AND kind = SPACE_MEMBERSHIP AND state = OPEN`);
}

/** Ask to join: a SPACE_MEMBERSHIP request; the optional note travels in `fields.note`. */
export function requestToJoin(workspace: string, space: string, note: string): Promise<Request> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/requests", {
      params: { path: { workspace }, query: { requestId: requestId() } },
      body: {
        kind: "SPACE_MEMBERSHIP",
        space: spaceName(workspace, space),
        requestedRole: "roles/spaceMember",
        fields: note ? { note } : undefined,
      },
    }),
  );
}

type Decision = "approve" | "deny" | "withdraw";
export function decideRequest(name: string, decision: Decision): Promise<Request> {
  const [, workspace, , request] = name.split("/");
  const path = { workspace, request };
  if (decision === "approve") return call(api.POST("/api/v1/workspaces/{workspace}/requests/{request}:approve", { params: { path }, body: {} }));
  if (decision === "deny") return call(api.POST("/api/v1/workspaces/{workspace}/requests/{request}:deny", { params: { path }, body: {} }));
  return call(api.POST("/api/v1/workspaces/{workspace}/requests/{request}:withdraw", { params: { path }, body: {} }));
}

/** Requests waiting on the caller as requester (NEEDS_INFO). */
export function listMyRepliesNeeded(workspace: string, member: string): Promise<Request[]> {
  return listRequests(workspace, `requester = ${lit(memberName(workspace, member))} AND state = NEEDS_INFO`, "updateTime desc");
}

/* ═══════════════ Work in a space ═══════════════ */

export function listSpaceArtifacts(workspace: string, space: string): Promise<Artifact[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/artifacts", {
          params: { path: { workspace }, query: { pageSize: 100, pageToken, filter: `space = ${lit(spaceName(workspace, space))}`, orderBy: "updateTime desc" } },
        }),
      ),
    (page) => page.artifacts,
    500,
  );
}

/* ═══════════════ Workspace people (Add people) ═══════════════ */

export function listWorkspaceMembers(workspace: string): Promise<Schema<"Member">[]> {
  return listAll(
    (pageToken) => call(api.GET("/api/v1/workspaces/{workspace}/members", { params: { path: { workspace }, query: { pageSize: 200, pageToken } } })),
    (page) => page.members,
    5000,
  );
}
