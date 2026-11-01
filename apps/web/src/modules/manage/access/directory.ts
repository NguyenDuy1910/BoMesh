/**
 * The identity side of workspace control: workspaces, members, groups, roles,
 * and the audit trail — read from and written to the real API.
 *
 * Types here mirror the API payloads rather than reshaping them, so a screen
 * shows what the server actually said. Where a screen needs a different word
 * for something, it maps at the point of display.
 */

import { apiRequest, queryString, type Paginated } from "@/lib/api/request";
import { invalidateApiData } from "@/lib/api/revision";
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
  joined_at?: string | null;
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
  /** Non-deleted collections and documents, documents by processing state. */
  knowledge: { collections: number; documents: number; ready: number; processing: number; pending: number; failed: number; outdated: number };
  /** Thirty daily buckets in `timezone`, with the last seven days against the seven before. */
  usage: {
    timezone: string;
    buckets: UsageBucket[];
    totals: UsageTotals;
    previous: UsageTotals;
  };
  generated_at: string | null;
}

export interface UsageTotals {
  active_users: number;
  questions: number;
  sign_ins: number;
}

export interface UsageBucket extends UsageTotals {
  start: string;
}

export type ActivityWindow = "24h" | "7d" | "30d";

/** One span's counts (OpenAPI `ActivityTotals`). */
export interface ActivityTotals {
  active_users: number;
  sign_ins: number;
  questions: number;
  conversations: number;
  changes: number;
  failed_changes: number;
}

export interface ActivityBucket {
  start: string;
  active_users: number;
  sign_ins: number;
  questions: number;
  changes: number;
  failed_changes: number;
}

export interface ActivityPerson {
  user_id: string;
  email: string | null;
  display_name: string | null;
  questions: number;
  conversations: number;
  sign_ins: number;
  changes: number;
  last_active_at: string | null;
}

/** How the workspace was used over one window (OpenAPI `WorkspaceActivity`). */
export interface WorkspaceActivity {
  window: ActivityWindow;
  timezone: string;
  bucket: "hour" | "day";
  start: string;
  generated_at: string;
  totals: ActivityTotals;
  previous: ActivityTotals;
  live_sessions: number;
  buckets: ActivityBucket[];
  sign_in_methods: { method: string; count: number }[];
  top_changes: { action: string; count: number; failed: number }[];
  people: ActivityPerson[];
}

/** One time someone entered the workspace (OpenAPI `AccessSessionRecord`). */
export interface AccessSessionRecord {
  id: string;
  user: { id: string; email: string | null; display_name: string | null };
  authentication_method: string;
  entry: "sign_in" | "workspace_switch";
  status: "active" | "expired" | "revoked" | "superseded";
  started_at: string;
  last_seen_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  expires_at: string;
  current: boolean;
}

/** The browser's own zone, so a "day" on a chart is the reader's day. */
const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export interface PlatformOverview {
  metrics: Record<string, number>;
  workspace_health: WorkspaceHealth[];
}

/** A page size that reads as "everything" for directories this size. */
const ALL = 100;

export const workspaceDirectoryApi = {
  workspaces: () => apiRequest<Paginated<Workspace>>("/workspaces"),
  workspace: (tenantId: string) => apiRequest<Workspace>(`/workspaces/${tenantId}`),
  async saveWorkspace(tenantId: string, patch: { name?: string; settings?: Record<string, unknown> }) {
    const saved = await apiRequest<Workspace>(`/workspaces/${tenantId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    invalidateApiData();
    return saved;
  },

  overview: (workspaceId = getAuthSession()?.active_workspace_id ?? "") =>
    apiRequest<WorkspaceOverview>(`/workspaces/${workspaceId}/overview${queryString({ tz: browserTimezone() })}`),
  activity: (window: ActivityWindow, workspaceId = getAuthSession()?.active_workspace_id ?? "") =>
    apiRequest<WorkspaceActivity>(
      `/workspaces/${workspaceId}/activity${queryString({ window, tz: browserTimezone() })}`,
    ),
  accessSessions: (params: { search?: string; status?: "active" | "ended" | ""; user_id?: string; page?: number } = {}) =>
    apiRequest<Paginated<AccessSessionRecord>>(
      `/access-sessions${queryString({
        page: params.page,
        page_size: ALL,
        search: params.search,
        status: params.status || undefined,
        user_id: params.user_id,
      })}`,
    ),

  members: (search = "") =>
    apiRequest<Paginated<Member>>(`/users${queryString({ page_size: ALL, search })}`),
  async saveMember(
    userId: string,
    patch: { display_name?: string; role_ids?: string[]; status?: MemberStatus; group_ids?: string[] },
  ) {
    const saved = await apiRequest<Member>(`/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    invalidateApiData();
    return saved;
  },
  /** The account one exact email names, and its standing in this workspace. */
  async lookupAccount(email: string, signal?: AbortSignal) {
    const page = await apiRequest<{ items: Account[]; total: number }>(
      `/accounts${queryString({ email })}`,
      { signal },
    );
    return page.items[0] ?? null;
  },
  /** Give an existing account membership; identities are never created here. */
  async addMember(input: { email: string; role_ids: string[]; group_ids?: string[] }) {
    const added = await apiRequest<Member>("/users", {
      method: "POST",
      body: JSON.stringify({ group_ids: [], ...input }),
    });
    invalidateApiData();
    return added;
  },

  groups: (search = "") =>
    apiRequest<Paginated<Group>>(`/groups${queryString({ page_size: ALL, search })}`),
  /** One group with its current members, for editing membership. */
  group: (groupId: string) => apiRequest<Group>(`/groups/${groupId}`),
  /** Groups are named by people; the server derives their internal code. */
  async createGroup(input: { display_name: string; description?: string }, memberIds: string[] = []) {
    const created = await apiRequest<Group>("/groups", {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (memberIds.length) {
      await apiRequest<Group>(`/groups/${created.id}/members`, {
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
      await apiRequest<Group>(`/groups/${groupId}`, {
        method: "PATCH",
        body: JSON.stringify(changes.details),
      });
    }
    if (changes.memberIds) {
      await apiRequest<Group>(`/groups/${groupId}/members`, {
        method: "PUT",
        body: JSON.stringify({ user_ids: changes.memberIds }),
      });
    }
    invalidateApiData();
  },
  async deleteGroup(groupId: string) {
    await apiRequest<void>(`/groups/${groupId}`, { method: "DELETE" });
    invalidateApiData();
  },

  roles: () => apiRequest<Paginated<Role>>(`/roles${queryString({ page_size: ALL })}`),
  permissions: () => apiRequest<{ items: Permission[]; total: number }>("/permissions"),
  /** Roles are named by people; the server derives their internal code. */
  async createRole(input: { display_name: string; permission_codes: string[] }) {
    const created = await apiRequest<Role>("/roles", {
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
    const saved = await apiRequest<Role>(`/roles/${roleId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    invalidateApiData();
    return saved;
  },

  auditLogs: (search = "", page = 1) =>
    apiRequest<Paginated<AuditEvent>>(`/audit-logs${queryString({ page, page_size: ALL, search })}`),

  platform: {
    overview: () => apiRequest<PlatformOverview>("/platform/overview"),
    workspaces: (search = "") =>
      apiRequest<Paginated<WorkspaceHealth>>(
        `/platform/workspaces${queryString({ page_size: ALL, search })}`,
      ),
    users: (search = "") =>
      apiRequest<Paginated<Member>>(
        `/platform/users${queryString({ page_size: ALL, search })}`,
      ),
    audit: (search = "", page = 1) =>
      apiRequest<Paginated<AuditEvent>>(
        `/platform/audit-logs${queryString({ page, page_size: ALL, search })}`,
      ),
    health: () => apiRequest<SystemHealth>("/platform/health"),
  },
};

/* ── Approval requests (`/approval-requests`) ─────────────────────────────── */

export type ApprovalRequestType = "resource_access" | "plugin_installation";
export type ApprovalRequestStatus = "pending" | "approved" | "denied" | "cancelled";

/** One request for access or a connector, exactly as the API returns it (OpenAPI `ApprovalRequest`). */
export interface ApprovalRequest {
  id: string;
  request_type: ApprovalRequestType;
  /** A collection id for `resource_access`; a connector key for `plugin_installation`. */
  target_id: string;
  status: ApprovalRequestStatus;
  requester: { id: string; email: string; display_name: string | null };
  /** The collection role a `resource_access` request asks for; null for connectors. */
  requested_role: { id: string; code: string; display_name: string } | null;
  details?: Record<string, unknown>;
  reason: string | null;
  decision_note: string | null;
  decided_by_user_id: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string | null;
}

/**
 * Requests the caller made or may review. The server lists the caller's own
 * requests plus every type their permissions let them decide; deciding is
 * re-checked on the server (`access.manage` for collections, `source.manage`
 * for connectors).
 */
export const approvalRequestsApi = {
  list: (params: { status?: ApprovalRequestStatus; request_type?: ApprovalRequestType; search?: string } = {}) =>
    apiRequest<Paginated<ApprovalRequest>>(`/approval-requests${queryString({ page_size: ALL, ...params })}`),
  get: (requestId: string) => apiRequest<ApprovalRequest>(`/approval-requests/${requestId}`),
  async create(input: { request_type: ApprovalRequestType; target_id: string; details?: Record<string, unknown>; reason?: string | null }) {
    const created = await apiRequest<ApprovalRequest>("/approval-requests", {
      method: "POST",
      body: JSON.stringify(input),
    });
    invalidateApiData();
    return created;
  },
  /** Approve, deny or cancel a pending request. A decision is final; there is no way back to pending. */
  async decide(requestId: string, decision: { status: Exclude<ApprovalRequestStatus, "pending">; decision_note?: string | null }) {
    const decided = await apiRequest<ApprovalRequest>(`/approval-requests/${requestId}`, {
      method: "PATCH",
      body: JSON.stringify(decision),
    });
    invalidateApiData();
    return decided;
  },
};

/** Who reviews a request type: the permission the server checks before a decision. */
export const REVIEW_PERMISSION: Record<ApprovalRequestType, string> = {
  resource_access: "access.manage",
  plugin_installation: "source.manage",
};

/* ── Knowledge access by person or group (collection ACLs) ────────────────── */

export type CollectionRole = "owner" | "editor" | "viewer";

/** The collection fields this module reads (OpenAPI `Collection`). */
export interface CollectionSummary {
  id: string;
  title: string;
  status: string;
  permissions?: string[];
}

/** One grant on one collection (OpenAPI `CollectionAccess`). */
export interface CollectionGrant {
  collection_id: string;
  principal_type: "user" | "group";
  principal_id: string;
  principal_name?: string | null;
  role: CollectionRole;
}

export interface KnowledgeGrants {
  collections: CollectionSummary[];
  grants: CollectionGrant[];
  /** Collections the caller cannot share, so their grants could not be read. */
  unreadable: number;
}

export const knowledgeAccessApi = {
  collections: () => apiRequest<Paginated<CollectionSummary>>(`/collections${queryString({ page_size: ALL })}`),
  /**
   * Every grant on every collection the caller may share. There is no
   * per-principal endpoint, so this reads each collection's access list;
   * collections the caller cannot share are counted, never guessed.
   */
  async grants(): Promise<KnowledgeGrants> {
    const page = await knowledgeAccessApi.collections();
    const collections = page.items.filter((collection) => collection.status !== "archived");
    const shareable = collections.filter((collection) => !collection.permissions || collection.permissions.includes("collection.share"));
    const lists = await Promise.all(
      shareable.map((collection) =>
        apiRequest<Paginated<CollectionGrant>>(`/collections/${collection.id}/access${queryString({ page_size: ALL })}`)
          .then((access) => access.items)
          .catch(() => null),
      ),
    );
    return {
      collections,
      grants: lists.flatMap((items) => items ?? []),
      unreadable: collections.length - lists.filter(Boolean).length,
    };
  },
};

export interface SystemHealth {
  status: "healthy" | "degraded" | "unhealthy";
  checked_at: string;
  duration_ms: number;
  services: {
    name: string;
    status: "healthy" | "degraded" | "unhealthy" | "not_configured";
    required: boolean;
    latency_ms?: number | null;
    detail?: string | null;
    /** Why a check failed, as a category (`timeout`, `auth_failed`…); never a message or secret. */
    error_category?: string | null;
    /** The model a model-backed service answered with. */
    model?: string | null;
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
