/**
 * The rules People & access applies before it calls the API: which roles a
 * caller may hand out, what a request asks for in words, and how the
 * server's refusals read to a person. The server enforces every one of these
 * again; the screen only avoids offering what would be refused.
 */

import type { ApprovalRequest, Member, Role } from "@/modules/manage/access/directory";

/** Any one of these opens People & access; each tab then needs its own. */
export const ACCESS_PERMISSIONS = ["user.manage", "role.manage", "group.manage", "access.manage"] as const;

/** A read as the access screens receive it from `useApiData`. */
export interface Loadable<T> {
  /** Null until the first answer; stays on screen while a refetch runs. */
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Last time each member did anything here, by user id; null without `audit.read`. */
export type LastActive = Record<string, string | null>;

/** A role as the members screens need it. Permissions are unknown when the caller cannot read roles. */
export interface RoleChoice {
  id: string;
  name: string;
  /** Null when the caller lacks `role.manage` and so cannot read what the role allows. */
  permissions: string[] | null;
  active: boolean;
  system: boolean;
  memberCount: number | null;
}

/**
 * The roles to offer. With `role.manage` they come from `/roles`; without it,
 * the only roles the caller can see are the ones members already hold.
 */
export function roleChoices(roles: Role[] | null, members: Member[] | null): RoleChoice[] {
  if (roles) {
    return roles.map((role) => ({
      id: role.id,
      name: role.display_name,
      permissions: role.permission_codes,
      active: role.status === "active",
      system: role.is_system,
      memberCount: role.member_count,
    }));
  }
  const seen: Record<string, RoleChoice> = {};
  for (const member of members ?? []) {
    for (const role of member.roles) {
      seen[role.id] ??= { id: role.id, name: role.display_name, permissions: null, active: true, system: false, memberCount: null };
    }
  }
  return Object.values(seen).sort((left, right) => left.name.localeCompare(right.name));
}

/** The server refuses to hand out a role that grants more than the caller holds. */
export function canGrant(role: RoleChoice, callerPermissions: readonly string[]): boolean {
  return role.active && (role.permissions === null || role.permissions.every((code) => callerPermissions.includes(code)));
}

/**
 * The role a new member starts with: the assignable role that allows the
 * least. Chosen by what roles allow, never by their names, so nobody is
 * added as an administrator by default.
 */
export function defaultRoleId(roles: RoleChoice[], callerPermissions: readonly string[]): string {
  const assignable = roles.filter((role) => canGrant(role, callerPermissions));
  const ranked = [...assignable].sort(
    (left, right) =>
      (left.permissions?.length ?? Number.MAX_SAFE_INTEGER) - (right.permissions?.length ?? Number.MAX_SAFE_INTEGER)
      || Number(right.system) - Number(left.system)
      || left.name.localeCompare(right.name),
  );
  return ranked[0]?.id ?? "";
}

/** A member holds one workspace role in this product; the first is the one shown and changed. */
export function memberRoleId(member: Member): string {
  return member.roles[0]?.id ?? "";
}

/** Why your own role, groups and standing are locked: the server never lets anyone change their own access. */
export const SELF_LOCK = "You can’t change your own role. Another admin can.";

/** Roles a member can be moved to: active ones the caller may grant, plus whatever they hold now. */
export function roleOptions(roles: RoleChoice[], current: string, callerPermissions: readonly string[]) {
  return roles
    .filter((role) => role.active || role.id === current)
    .map((role) => ({
      value: role.id,
      label: role.active ? role.name : `${role.name} (disabled)`,
      disabled: role.id !== current && !canGrant(role, callerPermissions),
    }));
}

/** "Copy of" names that do not collide with an existing role or group. */
export function uniqueCopyName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((name) => name.trim().toLowerCase()));
  let candidate = `${base} copy`;
  for (let index = 2; used.has(candidate.toLowerCase()); index += 1) candidate = `${base} copy ${index}`;
  return candidate;
}

/** A whole address, as `/accounts?email=` needs it; fragments never match there. */
export const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;

/** The words for what a collection-access request asks to do, by the collection role it names. */
export function requestedVerb(request: ApprovalRequest): string {
  const code = request.requested_role?.code.toLowerCase() ?? "";
  if (code.endsWith("owner")) return "manage";
  if (code.endsWith("editor")) return "edit";
  if (code.endsWith("viewer")) return "view";
  return request.requested_role ? `get ${request.requested_role.display_name.toLowerCase()} access to` : "open";
}

/**
 * The server's refusals, in the words of the person who hit them. Messages
 * the catalogue does not know pass through with a capital and a full stop.
 */
const KNOWN_REFUSALS: readonly [needle: string, message: string][] = [
  ["cannot change their own workspace access", "You can’t change your own access. Ask another admin."],
  ["last active workspace administrator", "This is the workspace’s only admin. Make someone else an admin first."],
  ["cannot change permissions of a role they hold", "You have this role, so you can’t change what it allows. Ask another admin."],
  ["cannot disable a role they hold", "You have this role, so you can’t disable it. Ask another admin."],
  ["permissions already held by the acting", "You can only give abilities you have yourself."],
  ["reassign active members before disabling", "Move everyone with this role to another role first."],
  ["beyond the acting administrator", "You can only give abilities you have yourself."],
  ["already a member", "They’re already a member of this workspace."],
  ["need to sign up first", "No BoMesh account uses this email. They need to create an account first."],
  ["account is disabled", "This account is disabled, so it can’t be added."],
  ["only pending approval requests", "Someone already decided this request."],
  ["platform-defined role cannot be changed", "Built-in roles can’t be changed. Duplicate it to make a custom role."],
];

export function accessErrorMessage(cause: unknown, fallback: string): string {
  const raw = cause instanceof Error ? cause.message.trim() : "";
  if (!raw) return fallback;
  const lower = raw.toLowerCase();
  const known = KNOWN_REFUSALS.find(([needle]) => lower.includes(needle));
  if (known) return known[1];
  if (lower.includes("failed to fetch") || lower.includes("networkerror")) return `${fallback} Check your connection, then try again.`;
  const sentence = raw.charAt(0).toUpperCase() + raw.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}
