import { Building2, FlaskConical, GraduationCap, Layers, Route, Users, type LucideIcon } from "lucide-react";

import type { Schema } from "@/lib/api/client";

/**
 * Space types (preview `SPACE_TYPES` in core/workspace.js). The workspace decides
 * which keys exist (`WorkspaceSettings.spaceTypes`); this registry gives each known
 * key its wording, icon, roles and join rule. Unknown keys join like a team and offer every space role.
 */

export type Space = Schema<"Space">;
export type SpaceRole = "roles/spaceLead" | "roles/spaceStaff" | "roles/spaceMember";
export type JoinPolicy = NonNullable<Space["joinPolicy"]>;

export const LEAD: SpaceRole = "roles/spaceLead";
export const STAFF: SpaceRole = "roles/spaceStaff";
export const MEMBER: SpaceRole = "roles/spaceMember";
export const SPACE_ROLES: readonly SpaceRole[] = [LEAD, STAFF, MEMBER];

export interface SpaceTypeDef {
  key: string;
  label: string;
  plural: string;
  icon: LucideIcon;
  desc: string;
  /** Role labels, most senior first (preview `roles`); the last one is the default for new people. */
  roles: readonly (readonly [SpaceRole, string])[];
  /** How outsiders get in: `enrolled` (outside BoMesh), `request` (ask the staff), `open` (visit and send requests). */
  join: "enrolled" | "request" | "open";
  /** Default joinPolicy for a new space of this type (preview `DEFAULT_VIS`). */
  defaultPolicy: JoinPolicy;
}

const REGISTRY: Readonly<Record<string, Omit<SpaceTypeDef, "key">>> = {
  course: {
    label: "Khóa học",
    plural: "Khóa học",
    icon: GraduationCap,
    desc: "Tài liệu, bài đánh giá và hỏi đáp cho một lớp học.",
    roles: [
      [LEAD, "Giảng viên"],
      [STAFF, "Trợ giảng"],
      [MEMBER, "Sinh viên"],
    ],
    join: "enrolled",
    defaultPolicy: "INVITE",
  },
  research: {
    label: "Nhóm nghiên cứu",
    plural: "Nhóm nghiên cứu",
    icon: FlaskConical,
    desc: "Thư viện bài báo chung, bản tổng hợp và bản nháp cho phòng thí nghiệm hoặc dự án.",
    roles: [
      [LEAD, "Chủ nhiệm đề tài"],
      [STAFF, "Nghiên cứu viên"],
      [MEMBER, "Thành viên"],
    ],
    join: "request",
    defaultPolicy: "REQUEST",
  },
  office: {
    label: "Văn phòng",
    plural: "Văn phòng",
    icon: Building2,
    desc: "Nhóm dịch vụ tiếp nhận yêu cầu.",
    roles: [
      [LEAD, "Trưởng"],
      [STAFF, "Nhân viên"],
    ],
    join: "open",
    defaultPolicy: "OPEN",
  },
  team: {
    label: "Nhóm",
    plural: "Nhóm",
    icon: Users,
    desc: "Nhóm làm việc dựa trên tài liệu chung.",
    roles: [
      [LEAD, "Trưởng nhóm"],
      [MEMBER, "Thành viên"],
    ],
    join: "request",
    defaultPolicy: "REQUEST",
  },
  project: {
    label: "Dự án",
    plural: "Dự án",
    icon: Route,
    desc: "Công việc có thời hạn với nguồn và kết quả riêng.",
    roles: [
      [LEAD, "Chủ sở hữu"],
      [MEMBER, "Thành viên"],
    ],
    join: "request",
    defaultPolicy: "INVITE",
  },
};

/** Lucide names an admin may store in `spaceTypes[].icon`. */
const ICONS: Readonly<Record<string, LucideIcon>> = {
  users: Users,
  route: Route,
  building: Building2,
  "building-2": Building2,
  graduation: GraduationCap,
  "graduation-cap": GraduationCap,
  flask: FlaskConical,
  "flask-conical": FlaskConical,
  layers: Layers,
};

/** Generic role names (guidelines §2.5: a space's lead is its "Space manager"), for spaces without a known type. */
const FALLBACK_ROLE_LABEL: Readonly<Record<SpaceRole, string>> = { [LEAD]: "Người quản lý cộng đồng", [STAFF]: "Nhân viên", [MEMBER]: "Thành viên" };

type Settings = Schema<"WorkspaceSettings"> | null | undefined;

/** The type of a space (or key), merged with the workspace's own label and icon. */
export function spaceType(key: string | undefined | null, settings?: Settings): SpaceTypeDef {
  const configured = settings?.spaceTypes?.find((t) => t.key === key);
  const known = Boolean(key && REGISTRY[key]);
  const base = known ? REGISTRY[key!] : REGISTRY.team;
  const label = configured?.displayName?.trim() || (known ? base.label : key ? key[0].toUpperCase() + key.slice(1) : "Cộng đồng");
  return {
    ...base,
    key: key ?? "",
    label,
    plural: known ? base.plural : label,
    icon: (configured?.icon && ICONS[configured.icon]) || (known ? base.icon : Layers),
    desc: known ? base.desc : "Nơi dành cho con người, tài liệu và công việc.",
    // The API's three roles all exist on an untyped space, so none of its members shows a role the picker can't set.
    roles: known ? base.roles : SPACE_ROLES.map((r) => [r, FALLBACK_ROLE_LABEL[r]] as const),
  };
}

/** A type or role name inside a sentence ("{0} giờ là {1}"), lowercased for mid-sentence use. */
export const inSentence = (name: string) => name.toLowerCase();

/** Names joined into one phrase ("khóa học, phòng ban và nhóm"). */
export function nameList(names: readonly string[], word: "and" | "or"): string {
  const parts = names.map(inSentence);
  const joiner = word === "and" ? " và " : " hoặc ";
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")}${joiner}${parts[parts.length - 1]}` : (parts[0] ?? "");
}

/** Space types the workspace offers, in settings order (preview `spaceTypeIds()`). */
export function spaceTypesOf(settings: Settings): SpaceTypeDef[] {
  return (settings?.spaceTypes ?? []).filter((t) => t.key && t.enabled !== false).map((t) => spaceType(t.key, settings));
}

export function roleLabel(type: SpaceTypeDef, role: string | undefined | null): string {
  if (!role) return "";
  return type.roles.find((r) => r[0] === role)?.[1] ?? FALLBACK_ROLE_LABEL[role as SpaceRole] ?? role.replace(/^roles\//, "");
}

/** The space's role of a member (most senior of `roles[]`). */
export function topRole(roles: readonly string[] | undefined): SpaceRole | null {
  return SPACE_ROLES.find((r) => roles?.includes(r)) ?? null;
}

/** Roles that run a space: answer questions, publish work, handle requests. */
export const isStaffRole = (role: string | undefined | null) => role === LEAD || role === STAFF;

/** Default role for people added or approved (preview `defaultRole`: the type's last role). */
export const defaultRole = (type: SpaceTypeDef): SpaceRole => type.roles[type.roles.length - 1][0];

/** How someone outside the space gets in (preview `joinMode`). */
export function joinMode(space: Space, type: SpaceTypeDef): "open" | "enrolled" | "request" {
  if (space.joinPolicy === "OPEN" || type.join === "open") return "open";
  return type.join === "enrolled" ? "enrolled" : "request";
}

/** Preview visibility options, mapped onto `joinPolicy`. */
export type Visibility = "open" | "discoverable" | "members" | "private";
export const POLICY_OF: Readonly<Record<Exclude<Visibility, "private">, JoinPolicy>> = { open: "OPEN", discoverable: "REQUEST", members: "INVITE" };
export function visibilityOf(policy: JoinPolicy | undefined): Visibility {
  return policy === "OPEN" ? "open" : policy === "REQUEST" ? "discoverable" : "members";
}

export const MAX_NAME = 60;
