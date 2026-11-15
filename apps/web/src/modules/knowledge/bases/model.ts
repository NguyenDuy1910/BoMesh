import { Globe, Lock, User, Users, type LucideIcon } from "lucide-react";

import { resourceId, type Schema } from "@/lib/api/client";
import { hashOf } from "@/lib/format";

/**
 * Collections (root COLLECTION items) — pure helpers for the preview's
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

/** Stable mark colour of a collection (the API stores none): `var(--kb-color-N)` from the bare item ID. */
export function baseColor(item: string): string {
  return `var(--kb-color-${hashOf(resourceId(item)) % KB_COLOR_COUNT})`;
}

export const isPersonal = (item: Item | null | undefined) => item?.collection?.kind === "PERSONAL";
export const isLocked = (item: Item | null | undefined) => item?.access === "LOCKED";
export const isOwner = (item: Item | null | undefined) => item?.access === "OWNER";
export const isEditor = (item: Item | null | undefined) => item?.access === "EDITOR" || item?.access === "OWNER";

export const NAME_MAX = 60;
export const DESC_MAX = 200;

/** Knowledge Studio → Collections. */
export const COLLECTIONS_HREF = "/studio?tab=collections";

/** A collection's management page (`tab` = contents | access | sources | settings). */
export const collectionHref = (collection: string | undefined, tab?: string) => `/studio/collections/${resourceId(collection)}${tab ? `?tab=${tab}` : ""}`;

/** Preview `nameError`: required, ≤ 60 characters, unique among live collections (case-insensitive). */
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
  viewer: "Can search and read its documents.",
  editor: "Can also add documents and edit their details.",
  owner: "Can also review submissions and manage access and settings.",
};
export const ROLES: readonly ShareRole[] = ["viewer", "editor", "owner"];

const roleKey = (role: string): ShareRole | null => {
  const entry = (Object.entries(ROLE_OF) as [ShareRole, string][]).find(([, r]) => r === role);
  return entry ? entry[0] : null;
};

/**
 * General access of a collection. Exact with the policy (owners); without it only LOCKED is
 * known (restricted) — readers can't tell workspace-wide from shared.
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

/** General access choices in the preview's order (`KB_ACCESS`). */
export const GENERAL_ACCESS: readonly GeneralAccess[] = ["workspace", "restricted", "private"];

/** Preview `kbAccess` / `KB_ACCESS` + `kbAccessDesc`: chip label, icon and the sentence under General access. */
export function accessInfo(key: AccessKey, workspaceName: string, spaceName?: string): AccessInfo {
  if (key === "personal") return { icon: User, label: "Only you", long: "Only you can see this." };
  if (key === "workspace") return { icon: Globe, label: "Everyone", long: `Anyone in ${workspaceName || "the workspace"} can find it and ask about it.` };
  if (key === "private") return { icon: Lock, label: "Private", long: "Only its owners." };
  return {
    icon: Users,
    label: "Restricted",
    long: spaceName ? `Only the people and groups you add, plus members of ${spaceName}.` : "Only the people and groups you add.",
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

/** Policy whose collection-role grants are exactly `shares` (other bindings kept): a folder's own access. */
export function withExactShares(policy: Policy, shares: readonly Pick<Share, "principal" | "role">[]): Policy {
  const kept = (policy.bindings ?? []).filter((b) => !roleKey(b.role));
  const bindings = ROLES.map((role) => ({ role: ROLE_OF[role], members: shares.filter((s) => s.role === role).map((s) => s.principal) })).filter((b) => b.members.length);
  return { ...policy, bindings: [...kept, ...bindings] };
}

/* ═══════════════ Folders ═══════════════ */

/**
 * A collection's folders (nested COLLECTION items; `item_model.md`): the structure Home draws and Contents
 * manages. Indexed by name with each parent's folders by name.
 */
export interface FolderIndex {
  /** The root collection's name. */
  root: string;
  byName: ReadonlyMap<string, Item>;
  children: ReadonlyMap<string, readonly Item[]>;
}

export function folderIndex(root: string, folders: readonly Item[]): FolderIndex {
  const byName = new Map(folders.map((f) => [f.name ?? "", f]));
  const children = new Map<string, Item[]>();
  for (const f of folders) {
    const parent = f.parentItem ?? root;
    children.set(parent, [...(children.get(parent) ?? []), f]);
  }
  for (const list of children.values()) list.sort((a, b) => (a.displayName ?? "").localeCompare(b.displayName ?? ""));
  return { root, byName, children };
}

export const EMPTY_FOLDERS: FolderIndex = { root: "", byName: new Map(), children: new Map() };

/** The folders from the top level down to `folder` (inclusive); empty for the collection itself. */
export function folderPath(index: FolderIndex, folder: string | null | undefined): Item[] {
  const out: Item[] = [];
  for (let f = folder ? index.byName.get(folder) : undefined; f; f = index.byName.get(f.parentItem ?? "")) out.unshift(f);
  return out;
}

/** `folder` and every folder under it. */
export function folderSubtree(index: FolderIndex, folder: string): string[] {
  const out = [folder];
  for (let i = 0; i < out.length; i++) for (const k of index.children.get(out[i]!) ?? []) out.push(k.name ?? "");
  return out;
}

/** A folder with its own access (`inheritAccess = false`): it replaces, never adds to, what's above it. */
export const hasOwnAccess = (folder: Item | null | undefined) => folder?.collection?.inheritAccess === false;

/** The nearest folder on the path with its own access (it decides who reads `folder`), else null. */
export const accessFolder = (index: FolderIndex, folder: string | null | undefined) => folderPath(index, folder).reverse().find(hasOwnAccess) ?? null;

/** "Payments › Disputes › Chargebacks" (preview `destLabel` / `where`). */
export const whereLabel = (collectionName: string, index: FolderIndex, folder: string | null | undefined) =>
  [collectionName, ...folderPath(index, folder).map((f) => f.displayName)].filter(Boolean).join(" › ");

export const FOLDER_NAME_MAX = 80;

/** Preview `folderNameError`: required, ≤ 80 characters, unique among its siblings (case-insensitive). */
export function folderNameError(name: string, siblings: readonly Item[], selfName?: string): string {
  const n = name.trim();
  if (!n) return "Enter a name.";
  if (n.length > FOLDER_NAME_MAX) return "Use 80 characters or fewer.";
  const dup = siblings.find((x) => x.name !== selfName && (x.displayName ?? "").trim().toLowerCase() === n.toLowerCase());
  return dup ? `“${dup.displayName}” is already here. Choose another name.` : "";
}

/* ═══════════════ Requests ═══════════════ */

/** Open COLLECTION_ACCESS request (waiting on the owners). */
export const isPendingRequest = (r: AccessRequest) => r.state === "OPEN" || r.state === "NEEDS_INFO";

export const requestRole = (r: AccessRequest): "viewer" | "editor" => (r.requestedRole === ROLE_OF.editor ? "editor" : "viewer");
