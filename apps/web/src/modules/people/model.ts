/**
 * Pure People & access logic (no React, no fetch): workspace roles and how a
 * member's single "role" maps onto IAM bindings, self / last-admin guards,
 * plain-language permission switches over the permission catalog, and the
 * Add people email parsing. Covered by `tests/people-model.test.mts`.
 */

export const ADMIN_ROLE = "roles/workspaceAdmin";
export const MEMBER_ROLE = "roles/workspaceMember";
/** Built-in workspace roles, in display order (preview "Workspace admin", "Member"). */
export const BUILT_IN_ROLES = [ADMIN_ROLE, MEMBER_ROLE] as const;

const BUILT_IN_LABEL: Record<string, string> = { [ADMIN_ROLE]: "Quản trị viên", [MEMBER_ROLE]: "Thành viên" };
/** Product-language descriptions (preview `D.roles`): the catalog's are developer English and don't translate. */
const BUILT_IN_DESCRIPTION: Record<string, string> = {
  [ADMIN_ROLE]: "Toàn quyền với không gian làm việc này.",
  [MEMBER_ROLE]: "Đặt câu hỏi, tra cứu tài liệu được phép truy cập và gửi tài liệu để duyệt.",
};

export interface PolicyBinding {
  role: string;
  members: string[];
}
export interface PolicyLike {
  version?: number;
  bindings?: PolicyBinding[];
  etag?: string;
}

export interface RoleLike {
  name?: string;
  displayName: string;
  description?: string;
  includedPermissions: string[];
  etag?: string;
}

/** A role a member can hold in this workspace (built-in or custom). */
export interface WorkspaceRole {
  /** `roles/workspaceAdmin` or `workspaces/{w}/roles/{role}`. */
  name: string;
  label: string;
  description: string;
  builtIn: boolean;
  permissions: string[];
  etag?: string;
}

export const isBuiltIn = (role: string) => (BUILT_IN_ROLES as readonly string[]).includes(role);

/** Built-ins first (admin, member), then custom roles by name. Other predefined roles (collection, space, platform) are not workspace roles. */
export function workspaceRoles(predefined: readonly RoleLike[], custom: readonly RoleLike[]): WorkspaceRole[] {
  const builtIn = BUILT_IN_ROLES.map((name): WorkspaceRole => {
    const role = predefined.find((r) => r.name === name);
    return { name, label: BUILT_IN_LABEL[name], description: BUILT_IN_DESCRIPTION[name], builtIn: true, permissions: role?.includedPermissions ?? [] };
  });
  const customRoles = custom
    .filter((r): r is RoleLike & { name: string } => Boolean(r.name))
    .map((r): WorkspaceRole => ({ name: r.name, label: r.displayName, description: r.description ?? "", builtIn: false, permissions: r.includedPermissions, etag: r.etag }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...builtIn, ...customRoles];
}

export const userPrincipal = (userId: string) => `user:${userId}`;

/** Workspace roles bound directly to the user in the workspace policy. */
export function directRoles(policy: PolicyLike | undefined, userId: string, roleNames: ReadonlySet<string>): string[] {
  const principal = userPrincipal(userId);
  return (policy?.bindings ?? []).filter((b) => roleNames.has(b.role) && b.members.includes(principal)).map((b) => b.role);
}

/** The one role the UI shows for a member: admin wins, then a custom role, else Member. */
export function primaryRole(held: readonly string[]): string {
  if (held.includes(ADMIN_ROLE)) return ADMIN_ROLE;
  return held.find((r) => !isBuiltIn(r)) ?? MEMBER_ROLE;
}

/** People per workspace role (the role the UI shows), counted over the users bound directly in `policy`. */
export function roleCounts(policy: PolicyLike | undefined, roleNames: ReadonlySet<string>): Map<string, number> {
  const held = new Map<string, string[]>();
  for (const b of policy?.bindings ?? []) {
    if (!roleNames.has(b.role)) continue;
    for (const m of b.members) if (m.startsWith("user:")) held.set(m, [...(held.get(m) ?? []), b.role]);
  }
  const counts = new Map<string, number>();
  for (const roles of held.values()) {
    const role = primaryRole(roles);
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  return counts;
}

/** An AIP-160 string literal. */
export const literal = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** A ListMembers search: name or email contains `q` (case-insensitive); '' without a query. */
export function memberSearch(q: string): string {
  const t = q.trim();
  return t ? `(displayName = ${literal(`*${t}*`)} OR email = ${literal(`*${t}*`)})` : "";
}

/** ListMembers filter of the members table and pickers: search, role held, state, in or not in a group. */
export function memberFilter({ q = "", role, state, group, notGroup }: { q?: string; role?: string; state?: string; group?: string; notGroup?: string }): string {
  return [
    memberSearch(q),
    role && `roles:${literal(role)}`,
    state && `state = ${literal(state)}`,
    group && `groups:${literal(group)}`,
    notGroup && `NOT groups:${literal(notGroup)}`,
  ]
    .filter(Boolean)
    .join(" AND ");
}

/**
 * The policy after giving each user exactly one workspace role: the user leaves every
 * other workspace-role binding (built-in or custom) and joins the target one. Bindings of
 * other roles and principals are untouched; empty bindings are dropped.
 */
export function withRoles(policy: PolicyLike, changes: ReadonlyMap<string, string>, roleNames: ReadonlySet<string>): Required<Pick<PolicyLike, "bindings">> & PolicyLike {
  const principals = new Map([...changes].map(([user, role]) => [userPrincipal(user), role]));
  const bindings = (policy.bindings ?? []).map((b) =>
    roleNames.has(b.role) ? { role: b.role, members: b.members.filter((m) => !principals.has(m) || principals.get(m) === b.role) } : { ...b, members: [...b.members] },
  );
  for (const [principal, role] of principals) {
    let binding = bindings.find((b) => b.role === role);
    if (!binding) {
      binding = { role, members: [] };
      bindings.push(binding);
    }
    if (!binding.members.includes(principal)) binding.members.push(principal);
  }
  return { ...policy, bindings: bindings.filter((b) => b.members.length > 0) };
}

/* ── Guards ── */

export interface GuardMember {
  user: string;
  state?: string;
  role: string;
}

/** Active members holding the admin role. */
export const activeAdmins = (members: readonly GuardMember[]) => members.filter((m) => m.role === ADMIN_ROLE && m.state !== "SUSPENDED");

export function isLastAdmin(member: GuardMember, members: readonly GuardMember[]): boolean {
  return member.role === ADMIN_ROLE && member.state !== "SUSPENDED" && activeAdmins(members).length <= 1;
}

/** Why this member's role can't change ('' when it can). */
export function roleGuard(member: GuardMember, members: readonly GuardMember[], self: string): string {
  if (member.user === self) return "Bạn không thể đổi vai trò của chính mình";
  if (isLastAdmin(member, members)) return "Quản trị viên không gian làm việc cuối cùng phải giữ vai trò này";
  return "";
}

/** Why this member can't be suspended or removed ('' when they can). */
export function accountGuard(member: GuardMember, members: readonly GuardMember[], self: string, verb: "suspend" | "remove"): string {
  const action = verb === "suspend" ? "tạm ngưng" : "gỡ";
  if (member.user === self) return `Bạn không thể ${action} chính mình`;
  if (isLastAdmin(member, members)) return `Bạn không thể ${action} quản trị viên không gian làm việc cuối cùng`;
  return "";
}

/** Whether moving `changing` users to `role` would leave no active admin. */
export function leavesNoAdmin(changing: readonly GuardMember[], role: string, members: readonly GuardMember[]): boolean {
  if (role === ADMIN_ROLE) return false;
  const users = new Set(changing.map((m) => m.user));
  return changing.some((m) => m.role === ADMIN_ROLE) && !activeAdmins(members).some((a) => !users.has(a.user));
}

/* ── Plain-language permissions ── */

export interface PermissionSwitch {
  id: string;
  title: string;
  /** Catalog permission IDs the switch grants together. */
  permissions: readonly string[];
}
export interface PermissionGroup {
  /** Stable key (icon, React key); `title` is the heading. */
  group: string;
  title: string;
  /** Shown only while this module is on. */
  module?: "spaces" | "requests";
  items: readonly PermissionSwitch[];
}

const crud = (resource: string, verbs: readonly string[]) => verbs.map((v) => `${resource}.${v}`);

/** Preview `D.permCatalog`, mapped onto the API's permission catalog. Codes stay internal. */
export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  {
    group: "Workspace",
    title: "Không gian làm việc",
    items: [
      { id: "tenant.read", title: "Xem trang tổng quan không gian làm việc", permissions: ["workspaces.getOverview", "knowledgeGaps.list", "knowledgeGaps.get"] },
      {
        id: "tenant.manage",
        title: "Thay đổi cài đặt không gian làm việc và thiết lập trợ lý",
        permissions: [
          "workspaces.update",
          "workspaces.updateSettings",
          "workspaces.updateAssistant",
          // Workspace admins keep the classification schemes (preview `canManageTaxonomy`).
          ...crud("conceptSchemes", ["create", "update", "publish"]),
          ...crud("concepts", ["create", "update", "delete"]),
          ...crud("conceptRules", ["create", "update", "delete", "get", "list"]),
        ],
      },
    ],
  },
  {
    group: "People",
    title: "Người dùng & phân quyền",
    items: [
      {
        id: "user.manage",
        title: "Thêm, tạm ngưng và gỡ thành viên",
        permissions: [...crud("members", ["create", "delete", "suspend", "activate"]), "workspaces.getIamPolicy", "workspaces.setIamPolicy", "workspaces.analyzeIamPolicy"],
      },
      { id: "group.manage", title: "Tạo và quản lý nhóm", permissions: [...crud("groups", ["create", "update", "delete"]), ...crud("memberships", ["create", "delete", "get", "list"])] },
      { id: "role.manage", title: "Tạo và chỉnh sửa vai trò", permissions: crud("roles", ["create", "update", "delete", "undelete"]) },
      {
        id: "access.manage",
        title: "Phê duyệt hoặc từ chối yêu cầu truy cập",
        permissions: [...crud("requests", ["get", "approve", "deny", "sendBack", "update", "close"]), ...crud("requestMessages", ["create", "get", "list"])],
      },
    ],
  },
  {
    group: "Knowledge",
    title: "Tài liệu",
    items: [
      {
        id: "knowledge.read",
        title: "Đặt câu hỏi và tra cứu tài liệu",
        permissions: [
          ...crud("conversations", ["create", "get", "list", "update", "delete", "undelete", "converse"]),
          ...crud("messages", ["get", "list", "submitFeedback"]),
          ...crud("items", ["list", "search", "testIamPermissions"]),
          ...crud("savedItems", ["create", "delete", "get", "list"]),
          ...crud("recentItems", ["clear", "delete", "get", "list", "update"]),
          ...crud("savedSearches", ["create", "delete", "get", "list", "update"]),
          ...crud("shares", ["create", "delete", "get", "list"]),
          ...crud("conceptSchemes", ["get", "list"]),
          ...crud("concepts", ["get", "list"]),
        ],
      },
      { id: "knowledge.contribute", title: "Gửi tài liệu để duyệt", permissions: crud("contributions", ["create", "get", "list", "withdraw", "resubmit", "delete"]) },
      {
        id: "knowledge.manage",
        title: "Tạo kho tài liệu; duyệt và công bố tài liệu được gửi vào kho tài liệu họ sở hữu",
        permissions: [
          ...crud("items", ["create", "update", "move", "publish", "verify", "delete", "undelete", "get", "getIamPolicy", "setIamPolicy"]),
          ...crud("itemShortcuts", ["create", "delete", "get", "list"]),
          "contributions.review",
          ...crud("conceptProposals", ["get", "list", "decide"]),
          ...crud("knowledgeGaps", ["dismiss", "reopen"]),
        ],
      },
    ],
  },
  {
    group: "Sources",
    title: "Nguồn dữ liệu",
    items: [
      {
        id: "source.manage",
        title: "Kết nối và quản lý nguồn dữ liệu cùng lịch đồng bộ",
        permissions: [
          ...crud("sources", ["create", "update", "delete", "pause", "resume", "get", "list"]),
          ...crud("connections", ["create", "update", "delete", "get", "test", "reauthorize", "browseResources"]),
        ],
      },
      { id: "ingestion.read", title: "Xem lịch sử đồng bộ", permissions: [...crud("syncs", ["get", "list"]), ...crud("ingestionRuns", ["get", "list", "summarize"]), ...crud("tasks", ["get", "list"])] },
      { id: "ingestion.run", title: "Bắt đầu đồng bộ và xử lý lại tài liệu", permissions: ["syncs.create", "ingestionRuns.create"] },
      { id: "ingestion.manage", title: "Hủy mọi lượt đồng bộ đang chạy", permissions: ["ingestionRuns.cancel"] },
    ],
  },
  {
    group: "Spaces",
    title: "Cộng đồng",
    module: "spaces",
    items: [
      {
        id: "space.manage",
        title: "Tạo và quản lý cộng đồng",
        permissions: [
          ...crud("spaces", ["create", "update", "delete", "undelete", "getIamPolicy", "setIamPolicy"]),
          ...crud("spaceMembers", ["create", "delete", "get", "list"]),
          ...crud("materials", ["create", "delete", "get", "list"]),
          ...crud("announcements", ["create", "delete", "get", "list", "update"]),
          ...crud("events", ["create", "delete", "get", "list", "update"]),
        ],
      },
    ],
  },
  {
    group: "Requests",
    title: "Yêu cầu",
    module: "requests",
    items: [
      { id: "request.types", title: "Thiết lập loại yêu cầu", permissions: crud("requestTypes", ["create", "update", "delete", "undelete"]) },
      { id: "request.answer", title: "Trả lời câu hỏi gửi đến các nhóm dịch vụ", permissions: ["requests.answer"] },
    ],
  },
  {
    group: "Activity",
    title: "Nhật ký hoạt động",
    items: [{ id: "audit.read", title: "Xem nhật ký hoạt động và lượt đăng nhập", permissions: crud("auditEvents", ["list", "get", "export", "summarize"]) }],
  },
];

/** The switch's permissions that exist in the catalog and may go in custom roles. */
export const grantable = (item: PermissionSwitch, catalog: ReadonlySet<string>) => item.permissions.filter((p) => catalog.has(p));

/** On when the role holds every grantable permission of the switch. */
export function isSwitchOn(item: PermissionSwitch, held: ReadonlySet<string>, catalog: ReadonlySet<string>): boolean {
  const perms = grantable(item, catalog);
  return perms.length > 0 && perms.every((p) => held.has(p));
}

/** Turns a switch on (adds its permissions) or off (removes them); other permissions stay. Sorted for stable comparison. */
export function toggleSwitch(held: readonly string[], item: PermissionSwitch, on: boolean, catalog: ReadonlySet<string>): string[] {
  const next = new Set(held);
  for (const p of grantable(item, catalog)) {
    if (on) next.add(p);
    else next.delete(p);
  }
  return [...next].sort();
}

export const samePermissions = (a: readonly string[], b: readonly string[]) => [...a].sort().join() === [...b].sort().join();

/** "Member copy", then "Member copy 2", … unique among `names` (case-insensitive). */
export function uniqueCopyName(base: string, names: readonly string[]): string {
  const taken = new Set(names.map((n) => n.toLowerCase()));
  let name = `${base} (bản sao)`;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} (bản sao ${i})`;
  return name;
}

/* ── Add people ── */

export const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** Emails typed or pasted, separated by commas, semicolons or whitespace; lower-cased, de-duplicated. */
export function splitEmails(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

/** "an.nguyen@x.com" → "An Nguyen" (avatar initials before the account is known). */
export function nameFromEmail(email: string): string {
  return (
    email
      .split("@")[0]
      .split(/[._-]+/)
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ") || email
  );
}

/** "A", "A và B", "A, B và C". */
export function joinNames(names: readonly string[]): string {
  return names.length <= 2 ? names.join(" và ") : `${names.slice(0, -1).join(", ")} và ${names[names.length - 1]}`;
}

/** Group name validation (create and rename). */
export function groupNameError(name: string, others: readonly string[]): string {
  const n = name.trim();
  if (!n) return "Nhập tên nhóm.";
  if (others.some((o) => o.toLowerCase() === n.toLowerCase())) return "Đã có nhóm với tên này.";
  return "";
}

/** Role name validation (create and edit details). */
export function roleNameError(name: string, others: readonly string[]): string {
  const n = name.trim();
  if (!n) return "Nhập tên vai trò.";
  if (others.some((o) => o.toLowerCase() === n.toLowerCase())) return "Đã có vai trò với tên này.";
  return "";
}

/** Collection role words, one map product-wide (preview `KB_ROLES`): Viewer · Editor · Owner. */
export const ACCESS_LABEL: Readonly<Record<string, string>> = {
  "roles/collectionOwner": "Chủ sở hữu",
  "roles/collectionEditor": "Người chỉnh sửa",
  "roles/collectionViewer": "Người xem",
};

/** List tools (search, filters, bulk) appear from 7 rows, or while a filter is set (preview core `needsTools`). */
export const needsTools = (rows: number, filtered: boolean) => rows >= 7 || filtered;

/** Roles `principal` holds in `policy` (a collection's own grants). */
export const rolesOf = (policy: PolicyLike, principal: string): string[] => (policy.bindings ?? []).filter((b) => b.members.includes(principal)).map((b) => b.role);

/** `policy` with `principal` added to each of `roles` (Undo of a group delete restores its collection grants). */
export function withGrants(policy: PolicyLike, principal: string, roles: readonly string[]): PolicyLike {
  const bindings = (policy.bindings ?? []).map((b) => (roles.includes(b.role) && !b.members.includes(principal) ? { ...b, members: [...b.members, principal] } : b));
  for (const role of roles) if (!bindings.some((b) => b.role === role)) bindings.push({ role, members: [principal] });
  return { ...policy, bindings };
}
/** Most capable collection role among `roles`, or null. */
export function topCollectionRole(roles: readonly string[] | undefined): string | null {
  return ["roles/collectionOwner", "roles/collectionEditor", "roles/collectionViewer"].find((r) => roles?.includes(r)) ?? null;
}
