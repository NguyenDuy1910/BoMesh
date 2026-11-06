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

const BUILT_IN_LABEL: Record<string, string> = { [ADMIN_ROLE]: "Workspace admin", [MEMBER_ROLE]: "Member" };

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
    return { name, label: BUILT_IN_LABEL[name], description: role?.description ?? "", builtIn: true, permissions: role?.includedPermissions ?? [] };
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
  if (member.user === self) return "You can’t change your own role";
  if (isLastAdmin(member, members)) return "The last workspace admin keeps this role";
  return "";
}

/** Why this member can't be suspended or removed ('' when they can). */
export function accountGuard(member: GuardMember, members: readonly GuardMember[], self: string, verb: "suspend" | "remove"): string {
  if (member.user === self) return `You can’t ${verb} yourself`;
  if (isLastAdmin(member, members)) return `You can’t ${verb} the last workspace admin`;
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
  group: string;
  /** Shown only while this module is on. */
  module?: "spaces" | "requests";
  items: readonly PermissionSwitch[];
}

const crud = (resource: string, verbs: readonly string[]) => verbs.map((v) => `${resource}.${v}`);

/** Preview `D.permCatalog`, mapped onto the API's permission catalog. Codes stay internal. */
export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  {
    group: "Workspace",
    items: [
      { id: "tenant.read", title: "View the workspace overview", permissions: ["workspaces.getOverview", "knowledgeGaps.list", "knowledgeGaps.get"] },
      { id: "tenant.manage", title: "Change workspace settings and assistant setup", permissions: ["workspaces.update", "workspaces.updateSettings", "workspaces.updateAssistant"] },
    ],
  },
  {
    group: "People & access",
    items: [
      {
        id: "user.manage",
        title: "Add, suspend and remove members",
        permissions: [...crud("members", ["create", "delete", "suspend", "activate"]), "workspaces.getIamPolicy", "workspaces.setIamPolicy", "workspaces.analyzeIamPolicy"],
      },
      { id: "group.manage", title: "Create and manage groups", permissions: [...crud("groups", ["create", "update", "delete"]), ...crud("memberships", ["create", "delete", "get", "list"])] },
      { id: "role.manage", title: "Create and edit roles", permissions: crud("roles", ["create", "update", "delete", "undelete"]) },
      {
        id: "access.manage",
        title: "Approve or deny access requests",
        permissions: [...crud("requests", ["get", "approve", "deny", "sendBack", "update", "close"]), ...crud("requestMessages", ["create", "get", "list"])],
      },
    ],
  },
  {
    group: "Knowledge",
    items: [
      {
        id: "knowledge.read",
        title: "Ask questions and browse knowledge",
        permissions: [
          ...crud("conversations", ["create", "get", "list", "update", "delete", "undelete", "converse"]),
          ...crud("messages", ["get", "list", "submitFeedback"]),
          ...crud("items", ["list", "search", "testIamPermissions"]),
          ...crud("savedItems", ["create", "delete", "get", "list"]),
          ...crud("recentItems", ["clear", "delete", "get", "list", "update"]),
          ...crud("savedSearches", ["create", "delete", "get", "list", "update"]),
          ...crud("shares", ["create", "delete", "get", "list"]),
        ],
      },
      { id: "knowledge.contribute", title: "Contribute documents for review", permissions: crud("contributions", ["create", "get", "list", "withdraw", "resubmit", "delete"]) },
      {
        id: "knowledge.manage",
        title: "Create knowledge bases; review and publish what is submitted to bases they own",
        permissions: [
          ...crud("items", ["create", "update", "move", "publish", "verify", "delete", "undelete", "get", "getIamPolicy", "setIamPolicy"]),
          ...crud("itemLinks", ["create", "delete", "get", "list"]),
          "contributions.review",
          ...crud("topics", ["create", "update", "delete", "undelete", "accept", "reject"]),
          "readingLists.publish",
          ...crud("knowledgeGaps", ["dismiss", "reopen"]),
        ],
      },
    ],
  },
  {
    group: "Sources",
    items: [
      {
        id: "source.manage",
        title: "Connect and manage sources and schedules",
        permissions: [
          ...crud("sources", ["create", "update", "delete", "pause", "resume", "get", "list"]),
          ...crud("connections", ["create", "update", "delete", "get", "test", "reauthorize", "browseResources"]),
        ],
      },
      { id: "ingestion.read", title: "View sync history", permissions: [...crud("syncs", ["get", "list"]), ...crud("ingestionRuns", ["get", "list", "summarize"]), ...crud("tasks", ["get", "list"])] },
      { id: "ingestion.run", title: "Start syncs and reprocess documents", permissions: ["syncs.create", "ingestionRuns.create"] },
      { id: "ingestion.manage", title: "Cancel any running sync", permissions: ["ingestionRuns.cancel"] },
    ],
  },
  {
    group: "Spaces",
    module: "spaces",
    items: [
      {
        id: "space.manage",
        title: "Create and manage spaces",
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
    module: "requests",
    items: [
      { id: "request.types", title: "Set up request types", permissions: crud("requestTypes", ["create", "update", "delete", "undelete"]) },
      { id: "request.answer", title: "Answer questions sent to service teams", permissions: ["requests.answer"] },
    ],
  },
  {
    group: "Activity",
    items: [{ id: "audit.read", title: "View the activity log and sign-ins", permissions: crud("auditEvents", ["list", "get", "export", "summarize"]) }],
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
  let name = `${base} copy`;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} copy ${i}`;
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

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export const firstName = (name: string | undefined) => String(name || "").split(" ")[0];

/** Group name validation (create and rename). */
export function groupNameError(name: string, others: readonly string[]): string {
  const n = name.trim();
  if (!n) return "Enter a group name.";
  if (others.some((o) => o.toLowerCase() === n.toLowerCase())) return "A group with this name already exists.";
  return "";
}

/** Role name validation (create and edit details). */
export function roleNameError(name: string, others: readonly string[]): string {
  const n = name.trim();
  if (!n) return "Enter a role name.";
  if (others.some((o) => o.toLowerCase() === n.toLowerCase())) return "A role with this name already exists.";
  return "";
}

/** Plain words for a collection role on a knowledge base. */
export const CAN: Record<string, string> = {
  "roles/collectionOwner": "Can manage",
  "roles/collectionEditor": "Can edit",
  "roles/collectionViewer": "Can view",
};
/** Most capable collection role among `roles`, or null. */
export function topCollectionRole(roles: readonly string[] | undefined): string | null {
  return ["roles/collectionOwner", "roles/collectionEditor", "roles/collectionViewer"].find((r) => roles?.includes(r)) ?? null;
}
