import { Globe, Lock, User, type LucideIcon } from "lucide-react";

import { resourceId, type Schema } from "@/lib/api/client";
import { hashOf } from "@/lib/format";

/**
 * Knowledge bases (root COLLECTION items) — pure helpers for the preview's
 * `features/knowledge.js`: marks, general access, roles and sharing on top of
 * the collection IAM policy (api_design.md §1: `roles/collection{Viewer,Editor,Owner}`,
 * principal `workspaceMembers` = everyone in the workspace).
 */

export type Item = Schema<"Item">;
export type Policy = Schema<"Policy">;
export type Binding = Schema<"Binding">;
export type AccessRequest = Schema<"Request">;

/* ═══════════════ Identity ═══════════════ */

/** Preview `COLORS` (knowledge.js); defined as `--kb-color-N` in knowledge.css. */
const KB_COLOR_COUNT = 8;

/** Stable mark colour of a base (the API stores none): `var(--kb-color-N)` from the bare item ID. */
export function baseColor(item: string): string {
  return `var(--kb-color-${hashOf(resourceId(item)) % KB_COLOR_COUNT})`;
}

export const isPersonal = (item: Item | null | undefined) => item?.collection?.kind === "PERSONAL";
export const isLocked = (item: Item | null | undefined) => item?.access === "LOCKED";
export const isOwner = (item: Item | null | undefined) => item?.access === "OWNER";
export const isEditor = (item: Item | null | undefined) => item?.access === "EDITOR" || item?.access === "OWNER";

export const NAME_MAX = 60;
export const DESC_MAX = 200;

/** Preview `nameError`: required, ≤ 60 characters, unique among live bases (case-insensitive). */
export function nameError(name: string, bases: readonly Item[], selfName?: string): string {
  const n = name.trim();
  if (!n) return "Enter a name.";
  if (n.length > NAME_MAX) return `Use ${NAME_MAX} characters or fewer.`;
  const dup = bases.find((b) => b.name !== selfName && !isPersonal(b) && b.state !== "DELETED" && (b.displayName ?? "").trim().toLowerCase() === n.toLowerCase());
  return dup ? `“${dup.displayName}” already exists. Choose another name.` : "";
}

/* ═══════════════ General access ═══════════════ */

/** `workspace` = everyone can read; `restricted` = discoverable, people added; `private` = hidden from non-members. */
export type GeneralAccess = "workspace" | "restricted" | "private";
export type AccessKey = GeneralAccess | "personal";

export const EVERYONE = "workspaceMembers";

export const ROLE_OF = { viewer: "roles/collectionViewer", editor: "roles/collectionEditor", owner: "roles/collectionOwner" } as const;
export type ShareRole = keyof typeof ROLE_OF;
export const ROLE_LABEL: Record<ShareRole, string> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };
export const ROLE_RANK: Record<ShareRole, number> = { viewer: 1, editor: 2, owner: 3 };
export const ROLE_DESC: Record<ShareRole, string> = {
  viewer: "Can search and read documents.",
  editor: "Can also edit document details.",
  owner: "Can also review submissions and manage access and settings.",
};
export const ROLES: readonly ShareRole[] = ["viewer", "editor", "owner"];

const roleKey = (role: string): ShareRole | null => {
  const entry = (Object.entries(ROLE_OF) as [ShareRole, string][]).find(([, r]) => r === role);
  return entry ? entry[0] : null;
};

/**
 * General access of a base. Exact with the policy (owners); without it only LOCKED is
 * known (restricted) — readers can't tell workspace-wide from shared (see the slice report).
 */
export function generalAccessOf(item: Item, policy?: Policy | null): AccessKey | null {
  if (isPersonal(item)) return "personal";
  if (policy) {
    if (policy.bindings?.some((b) => b.members.includes(EVERYONE))) return "workspace";
    return item.collection?.discoverable === false ? "private" : "restricted";
  }
  if (isLocked(item)) return "restricted";
  return null;
}

export interface AccessInfo {
  icon: LucideIcon;
  label: string;
  long: string;
}

/** Preview `kbAccess`: chip label and the sentence under General access. */
export function accessInfo(key: AccessKey, workspaceName: string, spaceName?: string): AccessInfo {
  if (key === "personal") return { icon: User, label: "Only you", long: "Only you can see this." };
  if (key === "workspace") return { icon: Globe, label: "Everyone", long: `Everyone in ${workspaceName} can find it and ask about it.` };
  if (key === "private") return { icon: Lock, label: "Owners only", long: "Only owners can find it." };
  return {
    icon: Lock,
    label: "Restricted",
    long: spaceName ? `Members of ${spaceName} and the people and groups below can find it.` : "Only the people and groups below can find it.",
  };
}

/** Policy with `workspaceMembers` granted (viewer) or removed for the chosen general access. */
export function withGeneralAccess(policy: Policy, general: GeneralAccess): Policy {
  const bindings = (policy.bindings ?? []).map((b) => ({ ...b, members: b.members.filter((m) => m !== EVERYONE) })).filter((b) => b.members.length);
  if (general === "workspace") {
    const viewer = bindings.find((b) => b.role === ROLE_OF.viewer);
    if (viewer) viewer.members = [...viewer.members, EVERYONE];
    else bindings.push({ role: ROLE_OF.viewer, members: [EVERYONE] });
  }
  return { ...policy, bindings };
}

/* ═══════════════ People and groups ═══════════════ */

export interface Share {
  /** Principal (`user:{id}` / `group:{id}`). */
  principal: string;
  kind: "user" | "group";
  /** Bare user or group ID. */
  id: string;
  role: ShareRole;
}

/** Direct shares on the base, best role per principal (the `workspaceMembers` grant is general access). */
export function sharesOf(policy: Policy | null | undefined): Share[] {
  const best = new Map<string, Share>();
  for (const b of policy?.bindings ?? []) {
    const role = roleKey(b.role);
    if (!role) continue;
    for (const principal of b.members) {
      const [kind, id] = principal.split(":");
      if ((kind !== "user" && kind !== "group") || !id) continue;
      const have = best.get(principal);
      if (!have || ROLE_RANK[role] > ROLE_RANK[have.role]) best.set(principal, { principal, kind, id, role });
    }
  }
  return [...best.values()];
}

/** Policy with `principals` holding exactly `role` (other grants of theirs removed); `role: null` removes them. */
export function withShares(policy: Policy, principals: readonly string[], role: ShareRole | null): Policy {
  const drop = new Set(principals);
  const bindings = (policy.bindings ?? []).map((b) => (roleKey(b.role) ? { ...b, members: b.members.filter((m) => !drop.has(m)) } : b)).filter((b) => b.members.length);
  if (role) {
    const target = bindings.find((b) => b.role === ROLE_OF[role]);
    if (target) target.members = [...target.members, ...principals];
    else bindings.push({ role: ROLE_OF[role], members: [...principals] });
  }
  return { ...policy, bindings };
}

export const ownerCount = (shares: readonly Share[]) => shares.filter((s) => s.role === "owner").length;

/* ═══════════════ Requests ═══════════════ */

/** Open COLLECTION_ACCESS request (waiting on the owners). */
export const isPendingRequest = (r: AccessRequest) => r.state === "OPEN" || r.state === "NEEDS_INFO";

export const requestRole = (r: AccessRequest): "viewer" | "editor" => (r.requestedRole === ROLE_OF.editor ? "editor" : "viewer");
