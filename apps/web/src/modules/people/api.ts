import { api, call, listAll, requestId, resourceId, type Schema } from "@/lib/api/client";

/**
 * People & access (api_design.md §4): members, account lookup, groups and
 * memberships, workspace roles and the permission catalog, the workspace IAM
 * policy (role assignments), effective-access analysis and knowledge-base
 * access requests (`COLLECTION_ACCESS`). Path params are bare IDs.
 */

export type Member = Schema<"Member">;
export type Group = Schema<"Group">;
export type Role = Schema<"Role">;
export type Permission = Schema<"Permission">;
export type Policy = Schema<"Policy">;
export type Binding = Schema<"Binding">;
export type User = Schema<"User">;
export type AccessRequest = Schema<"Request">;
export type IamAnalysis = Schema<"AnalyzeWorkspaceIamPolicyResponse">;

const ws = (workspace: string) => ({ workspace });

/* ── Members ── */

export function listMembers(workspace: string): Promise<Member[]> {
  return listAll(
    (pageToken) =>
      call(api.GET("/api/v1/workspaces/{workspace}/members", { params: { path: ws(workspace), query: { pageSize: 500, pageToken } } })),
    (page) => page.members,
  );
}

/** Adds an existing account (`users/{user}`) with roles granted in the same call. */
export function createMember(workspace: string, user: string, roles: readonly string[]): Promise<Member> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/members", {
      params: { path: ws(workspace), query: { requestId: requestId() } },
      body: { user, roles: [...roles] },
    }),
  );
}

export async function deleteMember(workspace: string, member: string): Promise<void> {
  await call(api.DELETE("/api/v1/workspaces/{workspace}/members/{member}", { params: { path: { ...ws(workspace), member: resourceId(member) } } }));
}

export function suspendMember(workspace: string, member: string): Promise<Member> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/members/{member}:suspend", {
      params: { path: { ...ws(workspace), member: resourceId(member) } },
      body: {},
    }),
  );
}

export function activateMember(workspace: string, member: string): Promise<Member> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/members/{member}:activate", {
      params: { path: { ...ws(workspace), member: resourceId(member) } },
      body: {},
    }),
  );
}

/** Exact-email account lookup (Add people); `null` when no account has this email. */
export async function lookupUser(email: string): Promise<User | null> {
  const { data, response, error } = await api.GET("/api/v1/users:lookup", { params: { query: { email } } });
  if (response.status === 404) return null;
  return call(Promise.resolve({ data, response, error }));
}

/* ── Groups and memberships ── */

export function listGroups(workspace: string): Promise<Group[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/groups", {
          params: { path: ws(workspace), query: { pageSize: 500, pageToken, orderBy: "displayName" } },
        }),
      ),
    (page) => page.groups,
  );
}

export function createGroup(workspace: string, group: { displayName: string; description: string }): Promise<Group> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/groups", {
      params: { path: ws(workspace), query: { requestId: requestId() } },
      body: group,
    }),
  );
}

export function updateGroup(workspace: string, group: string, patch: { displayName: string; description: string }): Promise<Group> {
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/groups/{group}", {
      params: { path: { ...ws(workspace), group: resourceId(group) }, query: { updateMask: "displayName,description" } },
      body: patch,
    }),
  );
}

export async function deleteGroup(workspace: string, group: string): Promise<void> {
  await call(api.DELETE("/api/v1/workspaces/{workspace}/groups/{group}", { params: { path: { ...ws(workspace), group: resourceId(group) } } }));
}

/** Puts a member (`workspaces/{w}/members/{m}`) in a group. */
export async function addToGroup(workspace: string, group: string, member: string): Promise<void> {
  await call(
    api.POST("/api/v1/workspaces/{workspace}/groups/{group}/memberships", {
      params: { path: { ...ws(workspace), group: resourceId(group) }, query: { requestId: requestId() } },
      body: { member },
    }),
  );
}

/** The membership ID is the member ID. */
export async function removeFromGroup(workspace: string, group: string, member: string): Promise<void> {
  await call(
    api.DELETE("/api/v1/workspaces/{workspace}/groups/{group}/memberships/{membership}", {
      params: { path: { ...ws(workspace), group: resourceId(group), membership: resourceId(member) } },
    }),
  );
}

/* ── Roles and permissions ── */

/** Predefined roles (`roles/*`); the workspace-scope ones are filtered by the caller. */
export function listPredefinedRoles(): Promise<Role[]> {
  return listAll((pageToken) => call(api.GET("/api/v1/roles", { params: { query: { pageSize: 100, pageToken } } })), (page) => page.roles);
}

/** Custom roles of the workspace (active only). */
export function listCustomRoles(workspace: string): Promise<Role[]> {
  return listAll(
    (pageToken) =>
      call(api.GET("/api/v1/workspaces/{workspace}/roles", { params: { path: ws(workspace), query: { pageSize: 200, pageToken } } })),
    (page) => page.roles,
  );
}

export function listPermissions(): Promise<Permission[]> {
  return listAll((pageToken) => call(api.GET("/api/v1/permissions", { params: { query: { pageSize: 500, pageToken } } })), (page) => page.permissions);
}

export function createRole(workspace: string, role: { displayName: string; description: string; includedPermissions: string[] }): Promise<Role> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/roles", {
      params: { path: ws(workspace), query: { requestId: requestId() } },
      body: role,
    }),
  );
}

export function updateRole(
  workspace: string,
  role: string,
  patch: Partial<Pick<Role, "displayName" | "description" | "includedPermissions">>,
): Promise<Role> {
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/roles/{role}", {
      params: { path: { ...ws(workspace), role: resourceId(role) }, query: { updateMask: Object.keys(patch).join(",") } },
      body: patch as Role,
    }),
  );
}

export function deleteRole(workspace: string, role: string): Promise<Role> {
  return call(api.DELETE("/api/v1/workspaces/{workspace}/roles/{role}", { params: { path: { ...ws(workspace), role: resourceId(role) } } }));
}

export function undeleteRole(workspace: string, role: string): Promise<Role> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/roles/{role}:undelete", {
      params: { path: { ...ws(workspace), role: resourceId(role) } },
      body: {},
    }),
  );
}

/* ── IAM ── */

export function getWorkspacePolicy(workspace: string): Promise<Policy> {
  return call(api.POST("/api/v1/workspaces/{workspace}:getIamPolicy", { params: { path: ws(workspace) }, body: {} }));
}

export function setWorkspacePolicy(workspace: string, policy: Policy): Promise<Policy> {
  return call(api.POST("/api/v1/workspaces/{workspace}:setIamPolicy", { params: { path: ws(workspace) }, body: { policy } }));
}

/** Effective roles of `user:{id}`, `group:{id}` or `workspaceMembers` on the workspace, every access-boundary collection and every space. */
export function analyzePolicy(workspace: string, principal: string): Promise<IamAnalysis> {
  return call(api.GET("/api/v1/workspaces/{workspace}:analyzeIamPolicy", { params: { path: ws(workspace), query: { principal } } }));
}

/* ── Knowledge-base access requests ── */

export function listAccessRequests(workspace: string): Promise<AccessRequest[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/requests", {
          params: { path: ws(workspace), query: { pageSize: 200, pageToken, filter: 'kind = "COLLECTION_ACCESS"', orderBy: "createTime desc" } },
        }),
      ),
    (page) => page.requests,
    400,
  );
}

export function approveRequest(workspace: string, request: string): Promise<AccessRequest> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/requests/{request}:approve", {
      params: { path: { ...ws(workspace), request: resourceId(request) } },
      body: {},
    }),
  );
}

export function denyRequest(workspace: string, request: string): Promise<AccessRequest> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/requests/{request}:deny", {
      params: { path: { ...ws(workspace), request: resourceId(request) } },
      body: {},
    }),
  );
}

/** The last sign-in of a user in this workspace (SIGN_IN audit event), when the caller may read the log. */
export async function lastSignIn(workspace: string, user: string): Promise<Schema<"AuditEvent"> | null> {
  const page = await call(
    api.GET("/api/v1/workspaces/{workspace}/auditEvents", {
      params: {
        path: ws(workspace),
        query: { pageSize: 1, filter: `category = "SIGN_IN" AND actor = "${user}" AND outcome = "SUCCEEDED"`, orderBy: "createTime desc" },
      },
    }),
  );
  return page.auditEvents?.[0] ?? null;
}
