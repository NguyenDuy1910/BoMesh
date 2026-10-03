import type { LucideIcon } from "lucide-react";

import {
  modeForPath,
  platformControlRailItems,
  workspaceControlRailItems,
  workspaceControlRailTail,
  type RailItem,
} from "@/lib/navigation";
import { canAccessPlatformControl, hasAnySessionPermission, type AuthSession } from "@/lib/auth/session";

/**
 * Control-plane addressing, derived from the rails.
 *
 * The rails in `@/lib/navigation` decide what exists and where it lives. This
 * module only adds what the command palette and the breadcrumb need on top of
 * that: a sentence per section, and the older addresses that must keep
 * resolving so an existing link never dead-ends.
 */
export type ControlPlaneNavGroupId = "workspace" | "platform";

export const controlPlaneNavGroupLabels: Record<ControlPlaneNavGroupId, string> = {
  workspace: "Workspace control",
  platform: "Platform control",
};

export interface ControlPlaneRoute {
  id: string;
  path: string;
  label: string;
  description: string;
  /** Older names for this section, so searching the old word still finds it. */
  keywords: string[];
  icon: LucideIcon;
  group: ControlPlaneNavGroupId;
}

/**
 * Addresses that predate the Workspace Architecture.
 *
 * Members, roles and groups became tabs of one Access section; knowledge
 * governance, connectors and apps all became Knowledge; the audit log became
 * Activity. Each old address resolves to its successor and rewrites the bar.
 */
export const legacySectionAliases: Record<string, string> = {
  "": "overview",
  dashboard: "overview",
  members: "access",
  people: "access",
  roles: "access",
  groups: "access",
  "knowledge-governance": "knowledge",
  connectors: "knowledge",
  sources: "knowledge",
  apps: "knowledge",
  "apps-permissions": "knowledge",
  "agents-policies": "agent",
  audit: "activity",
  "audit-logs": "activity",
  "workspace-settings": "settings",
  "platform/overview": "platform-tenants",
  "platform/workspaces": "platform-tenants",
  "platform/policies": "platform-models",
  "platform/health": "platform-system",
};

/* One line each, stating what the page is for in product words. A line
   promises only what the page actually shows. */
const DESCRIPTIONS: Record<string, string> = {
  overview: "Workspace health and what needs your attention.",
  knowledge: "The collections, documents and sources the assistant answers from.",
  agent: "How the assistant behaves in this workspace.",
  access: "Members, groups and roles for this workspace.",
  experience: "What members see when they open this workspace.",
  activity: "Administrative changes and sync events in this workspace.",
  settings: "This workspace's name and status.",
  "platform-tenants": "Every tenant on this deployment. Members see each one as a workspace.",
  "platform-users": "Everyone with an account, their workspaces and platform roles.",
  "platform-models": "Which models and capabilities tenants may use.",
  "platform-integrations": "The connectors this deployment supports.",
  "platform-usage": "Volume and cost across tenants.",
  "platform-audit": "The complete audit record across tenants.",
  "platform-system": "Service health for this deployment.",
};

/** Platform ids are prefixed so a workspace section can never collide with one. */
function sectionId(item: RailItem, group: ControlPlaneNavGroupId) {
  return group === "platform" ? `platform-${item.id}` : item.id;
}

const keywordsById = new Map<string, string[]>();
for (const [legacy, target] of Object.entries(legacySectionAliases)) {
  if (!legacy) continue;
  keywordsById.set(target, [...(keywordsById.get(target) ?? []), legacy.replace(/[-/]/g, " ")]);
}

function toRoute(item: RailItem, group: ControlPlaneNavGroupId): ControlPlaneRoute {
  const id = sectionId(item, group);
  return {
    id,
    path: item.href,
    label: item.label,
    description: DESCRIPTIONS[id] ?? "",
    keywords: keywordsById.get(id) ?? [],
    icon: item.icon,
    group,
  };
}

export const controlPlaneRoutes: ControlPlaneRoute[] = [
  ...workspaceControlRailItems.map((item) => toRoute(item, "workspace")),
  ...workspaceControlRailTail.map((item) => toRoute(item, "workspace")),
  ...platformControlRailItems.map((item) => toRoute(item, "platform")),
];

const permissionsById = new Map<string, readonly string[] | undefined>(
  [...workspaceControlRailItems, ...workspaceControlRailTail].map(
    (item) => [sectionId(item, "workspace"), item.permissionCodes] as const,
  ),
);

export function canAccessControlPlaneRoute(route: ControlPlaneRoute, session: AuthSession | null): boolean {
  if (route.group === "platform") return canAccessPlatformControl(session);
  const codes = permissionsById.get(route.id);
  return !codes || hasAnySessionPermission(session, codes);
}

export function findRoute(id: string): ControlPlaneRoute | undefined {
  return controlPlaneRoutes.find((route) => route.id === id);
}

/** The route whose section a given address belongs to, nested pages included. */
export function routeForPath(pathname: string): ControlPlaneRoute | undefined {
  const platform = modeForPath(pathname) === "platform-control";
  const candidates = controlPlaneRoutes.filter((route) => route.group === (platform ? "platform" : "workspace"));
  return (
    candidates.find((route) => route.path === pathname)
    ?? candidates
      .filter((route) => pathname.startsWith(`${route.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0]
  );
}

/** Path suffix — everything after `/workspace-control/` — to the route that owns it. */
const byPath = new Map<string, ControlPlaneRoute>(
  controlPlaneRoutes.map((route) => [route.path.replace(/^\/workspace-control\/?/, ""), route]),
);

export function resolveSection(rawSection: string): {
  section: string;
  canonicalPath: string;
  redirect: boolean;
} {
  const trimmed = rawSection.replace(/^\/+|\/+$/g, "");
  const alias = legacySectionAliases[trimmed];
  if (alias) {
    return { section: alias, canonicalPath: findRoute(alias)?.path ?? "/workspace-control", redirect: true };
  }
  const route = byPath.get(trimmed);
  return {
    section: route?.id ?? (trimmed || "overview"),
    canonicalPath: route?.path ?? "/workspace-control",
    redirect: false,
  };
}
