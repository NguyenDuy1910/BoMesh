/**
 * The identity side of workspace control: workspaces, members, groups, roles,
 * and the audit trail — read from and written to the real API.
 *
 * Types here mirror the API payloads rather than reshaping them, so a screen
 * shows what the server actually said. Where a screen needs a different word
 * for something, it maps at the point of display.
 */

import { controlPlaneRequest, queryString } from "@/modules/workspace-control/control-plane-api";
import { invalidateApiData } from "@/lib/api/revision";
import type { Paginated } from "@/modules/workspace-control/collections";
import { getAuthSession } from "@/lib/auth/session";

export interface Workspace {
  id: string;
  code: string;
  name: string;
  status: string;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceHealth extends Workspace {
  owner: { display_name: string | null; email: string } | null;
  member_count: number;
  connection_count: number;
}

export interface RoleRef {
  id: string;
  code: string;
  display_name: string;
}

export interface GroupRef {
  id: string;
  code: string;
  display_name: string;
}

/** A workspace member, exactly as `GET /users` returns it (OpenAPI `User`). */
export interface Member {
  [key: string]: unknown;
  id: string;
  email: string;
  display_name: string | null;
  status: MemberStatus;
  roles: RoleRef[];
  groups: GroupRef[];
}

export type MemberStatus = "active" | "inactive" | "suspended";

/** An existing account found by its exact email (OpenAPI `Account`). */
export interface Account {
  id: string;
  email: string;
  display_name: string | null;
  status: "active" | "disabled";
  workspace_membership: "none" | "active" | "suspended";
}

export interface GroupMember {
  id: string;
  email: string;
  display_name: string | null;
}

export interface Group {
  [key: string]: unknown;
  id: string;
  tenant_id: string;
  code: string;
  display_name: string;
  description: string | null;
  status: string;
  member_count: number;
  /** Present on a single-group read; lists leave it empty. */
  members?: GroupMember[];
  created_at: string;
  updated_at: string;
}

export interface Role {
  [key: string]: unknown;
  id: string;
  tenant_id: string | null;
  code: string;
  display_name: string;
  scope_type: "platform" | "tenant" | "collection";
  is_system: boolean;
  permission_codes: string[];
  status: string;
  member_count: number;
  created_at: string;
  updated_at: string;
}

export interface Permission {
  code: string;
  description: string;
  scopes: string[];
}

export interface AuditEvent {
  [key: string]: unknown;
  id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: string;
  details: Record<string, unknown>;
  actor: { id: string | null; email: string | null; display_name: string | null };
  created_at: string | null;
  /** Present only on the platform trail; null for a platform-scoped action. */
  workspace?: { id: string; name: string | null } | null;
}

export interface WorkspaceOverview {
  workspace: { id: string; code: string; name: string; status: string };
  metrics: Record<string, number>;
  attention: Record<string, number>;
  recent_activity: AuditEvent[];
  generated_at: string | null;
}

export interface PlatformOverview {
  metrics: Record<string, number>;
  workspace_health: WorkspaceHealth[];
}

/** A page size that reads as "everything" for directories this size. */
const ALL = 100;

export const workspaceDirectoryApi = {
  workspaces: () => controlPlaneRequest<Paginated<Workspace>>("/workspaces"),
  workspace: (tenantId: string) => controlPlaneRequest<Workspace>(`/workspaces/${tenantId}`),
  async saveWorkspace(tenantId: string, patch: { name?: string; settings?: Record<string, unknown> }) {
    const saved = await controlPlaneRequest<Workspace>(`/workspaces/${tenantId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    invalidateApiData();
    return saved;
  },

  overview: (workspaceId = getAuthSession()?.active_workspace_id ?? "") => controlPlaneRequest<WorkspaceOverview>(`/workspaces/${workspaceId}/overview`),

  members: (search = "") =>
    controlPlaneRequest<Paginated<Member>>(`/users${queryString({ page_size: ALL, search })}`),
  async saveMember(
    userId: string,
    patch: { display_name?: string; role_ids?: string[]; status?: MemberStatus; group_ids?: string[] },
  ) {
    const saved = await controlPlaneRequest<Member>(`/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    invalidateApiData();
    return saved;
  },
  /** The account one exact email names, and its standing in this workspace. */
  async lookupAccount(email: string, signal?: AbortSignal) {
    const page = await controlPlaneRequest<{ items: Account[]; total: number }>(
      `/accounts${queryString({ email })}`,
      { signal },
    );
    return page.items[0] ?? null;
  },
  /** Give an existing account membership; identities are never created here. */
  async addMember(input: { email: string; role_ids: string[]; group_ids?: string[] }) {
    const added = await controlPlaneRequest<Member>("/users", {
      method: "POST",
      body: JSON.stringify({ group_ids: [], ...input }),
    });
    invalidateApiData();
    return added;
  },

  groups: (search = "") =>
    controlPlaneRequest<Paginated<Group>>(`/groups${queryString({ page_size: ALL, search })}`),
  /** One group with its current members, for editing membership. */
  group: (groupId: string) => controlPlaneRequest<Group>(`/groups/${groupId}`),
  /** Groups are named by people; the server derives their internal code. */
  async createGroup(input: { display_name: string; description?: string }, memberIds: string[] = []) {
    const created = await controlPlaneRequest<Group>("/groups", {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (memberIds.length) {
      await controlPlaneRequest<Group>(`/groups/${created.id}/members`, {
        method: "PUT",
        body: JSON.stringify({ user_ids: memberIds }),
      });
    }
    invalidateApiData();
    return created;
  },
  /** Save what changed: the group's details, its members, or both. */
  async saveGroup(
    groupId: string,
    changes: { details?: { display_name?: string; description?: string | null }; memberIds?: string[] },
  ) {
    if (changes.details && Object.keys(changes.details).length) {
      await controlPlaneRequest<Group>(`/groups/${groupId}`, {
        method: "PATCH",
        body: JSON.stringify(changes.details),
      });
    }
    if (changes.memberIds) {
      await controlPlaneRequest<Group>(`/groups/${groupId}/members`, {
        method: "PUT",
        body: JSON.stringify({ user_ids: changes.memberIds }),
      });
    }
    invalidateApiData();
  },
  async deleteGroup(groupId: string) {
    await controlPlaneRequest<void>(`/groups/${groupId}`, { method: "DELETE" });
    invalidateApiData();
  },

  roles: () => controlPlaneRequest<Paginated<Role>>(`/roles${queryString({ page_size: ALL })}`),
  permissions: () => controlPlaneRequest<{ items: Permission[]; total: number }>("/permissions"),
  /** Roles are named by people; the server derives their internal code. */
  async createRole(input: { display_name: string; permission_codes: string[] }) {
    const created = await controlPlaneRequest<Role>("/roles", {
      method: "POST",
      body: JSON.stringify(input),
    });
    invalidateApiData();
    return created;
  },
  async updateRole(
    roleId: string,
    patch: { display_name?: string; permission_codes?: string[]; status?: "active" | "inactive" },
  ) {
    const saved = await controlPlaneRequest<Role>(`/roles/${roleId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    invalidateApiData();
    return saved;
  },

  auditLogs: (search = "") =>
    controlPlaneRequest<Paginated<AuditEvent>>(`/audit-logs${queryString({ page_size: ALL, search })}`),

  platform: {
    overview: () => controlPlaneRequest<PlatformOverview>("/platform/overview"),
    workspaces: (search = "") =>
      controlPlaneRequest<Paginated<WorkspaceHealth>>(
        `/platform/workspaces${queryString({ page_size: ALL, search })}`,
      ),
    users: (search = "") =>
      controlPlaneRequest<Paginated<Member>>(
        `/platform/users${queryString({ page_size: ALL, search })}`,
      ),
    audit: (search = "") =>
      controlPlaneRequest<Paginated<AuditEvent>>(
        `/platform/audit-logs${queryString({ page_size: ALL, search })}`,
      ),
    health: () => controlPlaneRequest<SystemHealth>("/platform/health"),
  },
};

export interface SystemHealth {
  status: "healthy" | "degraded" | "unhealthy";
  checked_at: string;
  duration_ms: number;
  services: {
    name: string;
    status: "healthy" | "degraded" | "unhealthy";
    required: boolean;
    latency_ms?: number | null;
    detail?: string | null;
  }[];
}

/** People are named by their display name, and by their email when they have none. */
export function memberName(member: { display_name: string | null; email: string }): string {
  return member.display_name?.trim() || member.email;
}

/** Anything other than an active membership reads as suspended: it cannot reach the workspace. */
export function memberStatus(member: Member): "active" | "suspended" {
  return member.status === "active" ? "active" : "suspended";
}

export function roleNames(member: Member): string {
  return member.roles.map((role) => role.display_name).join(", ");
}
