import { Building2, FlaskConical, GraduationCap, Layers, Route, Users, type LucideIcon } from "lucide-react";

import type { Schema } from "@/lib/api/client";

/**
 * Space types (preview `SPACE_TYPES` in core/workspace.js). The workspace decides
 * which keys exist (`WorkspaceSettings.spaceTypes`); this registry gives each known
 * key its wording, icon, roles and join rule. Unknown keys read like a team.
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
    label: "Course",
    plural: "Courses",
    icon: GraduationCap,
    desc: "Materials, assessments and Q&A for one class.",
    roles: [
      [LEAD, "Lecturer"],
      [STAFF, "Teaching assistant"],
      [MEMBER, "Student"],
    ],
    join: "enrolled",
    defaultPolicy: "INVITE",
  },
  research: {
    label: "Research group",
    plural: "Research",
    icon: FlaskConical,
    desc: "A shared paper library, reviews and drafts for a lab or project.",
    roles: [
      [LEAD, "Principal investigator"],
      [STAFF, "Researcher"],
      [MEMBER, "Member"],
    ],
    join: "request",
    defaultPolicy: "REQUEST",
  },
  office: {
    label: "Office",
    plural: "Offices",
    icon: Building2,
    desc: "A service team people send requests to.",
    roles: [
      [LEAD, "Head"],
      [STAFF, "Staff"],
    ],
    join: "open",
    defaultPolicy: "OPEN",
  },
  team: {
    label: "Team",
    plural: "Teams",
    icon: Users,
    desc: "A group that works from shared knowledge.",
    roles: [
      [LEAD, "Lead"],
      [MEMBER, "Member"],
    ],
    join: "request",
    defaultPolicy: "REQUEST",
  },
  project: {
    label: "Project",
    plural: "Projects",
    icon: Route,
    desc: "Time-bound work with its own sources and outputs.",
    roles: [
      [LEAD, "Owner"],
      [MEMBER, "Member"],
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

const FALLBACK_ROLE_LABEL: Readonly<Record<SpaceRole, string>> = { [LEAD]: "Lead", [STAFF]: "Staff", [MEMBER]: "Member" };

type Settings = Schema<"WorkspaceSettings"> | null | undefined;

/** The type of a space (or key), merged with the workspace's own label and icon. */
export function spaceType(key: string | undefined | null, settings?: Settings): SpaceTypeDef {
  const configured = settings?.spaceTypes?.find((t) => t.key === key);
  const base = (key && REGISTRY[key]) || REGISTRY.team;
  const label = configured?.displayName?.trim() || (key && REGISTRY[key] ? base.label : key ? key[0].toUpperCase() + key.slice(1) : "Space");
  return {
    ...base,
    key: key ?? "",
    label,
    plural: key && REGISTRY[key] ? base.plural : label,
    icon: (configured?.icon && ICONS[configured.icon]) || (key && REGISTRY[key] ? base.icon : Layers),
    desc: key && REGISTRY[key] ? base.desc : "A place for people, materials and work.",
  };
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
