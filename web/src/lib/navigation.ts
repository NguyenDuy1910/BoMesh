import {
  Activity,
  BookOpen,
  Building2,
  ChartColumn,
  Cpu,
  House,
  Inbox,
  Plug,
  Plus,
  Search,
  Server,
  Settings,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";

import type { PendingFeatureKey } from "@/lib/api/pending";
import {
  canAccessPlatformControl,
  hasAnySessionPermission,
  hasPlatformPermission,
  hasSessionPermission,
  type AuthSession,
} from "@/lib/auth/session";

/**
 * The one navigation definition: the product shell's sidebar, the command
 * palette's "Go to" pages and the address gate all read these lists. Items
 * appear by permission; the API still authorizes every request.
 */

/** Which attention count an item shows. */
export type NavBadge = "inbox" | "sources" | "requests" | "outages";

export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Where it goes. Absent for items that open a layer (search, inbox). */
  href?: string;
  /**
   * `action` starts something where you are (a new chat, the palette, the
   * inbox); `destination` is somewhere you go. Only a destination is ever the
   * current item, so the sidebar never shows two selections.
   */
  kind: "action" | "destination";
  /** Every one of these workspace permissions is needed. */
  allOf?: readonly string[];
  /** Any one of these workspace permissions is enough. */
  anyOf?: readonly string[];
  /** Any one of these platform permissions is enough. */
  platformAnyOf?: readonly string[];
  /** Hidden while this not-yet-connected API feature is turned off. */
  pendingFeature?: PendingFeatureKey;
  badge?: NavBadge;
  /** Further address prefixes this destination owns (a document belongs to Knowledge). */
  owns?: readonly string[];
  /** Keyboard shortcut shown beside the label. */
  shortcut?: string;
}

/** Everyone in a workspace: ask, find, read. */
export const WORKSPACE_NAV: readonly NavItem[] = [
  { id: "new-chat", label: "New chat", href: "/chat", icon: Plus, kind: "action" },
  { id: "inbox", label: "Inbox", icon: Inbox, kind: "action", pendingFeature: "notifications.inbox", badge: "inbox" },
  { id: "search", label: "Search", icon: Search, kind: "action", shortcut: "⌘K" },
  { id: "knowledge", label: "Knowledge", href: "/knowledge", icon: BookOpen, kind: "destination", owns: ["/documents"] },
];

/** The Manage section: only the items the caller may open are listed. */
export const MANAGE_NAV: readonly NavItem[] = [
  { id: "overview", label: "Overview", href: "/manage/overview", icon: House, kind: "destination", allOf: ["tenant.read", "tenant.manage"] },
  { id: "sources", label: "Sources", href: "/manage/sources", icon: Plug, kind: "destination", anyOf: ["source.manage", "ingestion.read"], badge: "sources" },
  {
    id: "access",
    label: "People & access",
    href: "/manage/access",
    icon: Users,
    kind: "destination",
    anyOf: ["user.manage", "role.manage", "group.manage", "access.manage"],
    badge: "requests",
  },
  {
    id: "assistant",
    label: "Assistant setup",
    href: "/manage/assistant",
    icon: Sparkles,
    kind: "destination",
    anyOf: ["tenant.manage"],
    pendingFeature: "workspace.assistant_settings",
  },
  { id: "activity", label: "Activity", href: "/manage/activity", icon: Activity, kind: "destination", anyOf: ["audit.read"] },
  { id: "settings", label: "Settings", href: "/manage/settings", icon: Settings, kind: "destination", anyOf: ["tenant.manage"] },
];

/** The platform console: the same shell, a different sidebar. */
export const PLATFORM_NAV: readonly NavItem[] = [
  { id: "p-workspaces", label: "Workspaces", href: "/platform/workspaces", icon: Building2, kind: "destination", platformAnyOf: ["platform.tenant.read"] },
  { id: "p-users", label: "Users", href: "/platform/users", icon: Users, kind: "destination", platformAnyOf: ["platform.user.read"] },
  { id: "p-connectors", label: "Connectors", href: "/platform/connectors", icon: Plug, kind: "destination", platformAnyOf: ["platform.tenant.read"], pendingFeature: "platform.connectors" },
  { id: "p-capabilities", label: "AI capabilities", href: "/platform/capabilities", icon: Cpu, kind: "destination", platformAnyOf: ["platform.tenant.read"], pendingFeature: "platform.capabilities" },
  { id: "p-usage", label: "Usage", href: "/platform/usage", icon: ChartColumn, kind: "destination", platformAnyOf: ["platform.tenant.read"], pendingFeature: "platform.usage" },
  { id: "p-audit", label: "Audit log", href: "/platform/audit", icon: Activity, kind: "destination", platformAnyOf: ["platform.audit.read"] },
  { id: "p-health", label: "System health", href: "/platform/health", icon: Server, kind: "destination", platformAnyOf: ["platform.health.read"], badge: "outages" },
];

/** Whether a not-yet-connected feature is switched on; defaults to on (tests, previews). */
export type FeatureCheck = (key: PendingFeatureKey) => boolean;

const allFeatures: FeatureCheck = () => true;

/** Whether the caller may open one item. */
export function canOpenNavItem(item: NavItem, session: AuthSession | null, isEnabled: FeatureCheck = allFeatures): boolean {
  if (item.pendingFeature && !isEnabled(item.pendingFeature)) return false;
  if (item.allOf && !item.allOf.every((code) => hasSessionPermission(session, code))) return false;
  if (item.anyOf && !hasAnySessionPermission(session, item.anyOf)) return false;
  if (item.platformAnyOf && !item.platformAnyOf.some((code) => hasPlatformPermission(session, code))) return false;
  return true;
}

/** The items of one list the caller is actually authorized to open. */
export function visibleNavItems(
  items: readonly NavItem[],
  session: AuthSession | null,
  isEnabled: FeatureCheck = allFeatures,
): NavItem[] {
  return items.filter((item) => canOpenNavItem(item, session, isEnabled));
}

function ownsPath(prefix: string, pathname: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Whether an item is the current place. Actions never are. */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (item.kind === "action" || !item.href) return false;
  const [path] = item.href.split("?");
  return ownsPath(path, pathname) || Boolean(item.owns?.some((prefix) => ownsPath(prefix, pathname)));
}

/** The platform console owns every `/platform` address; the sidebar swaps there. */
export function isPlatformPath(pathname: string): boolean {
  return ownsPath("/platform", pathname);
}

/**
 * Whether the caller may open an address. Management and platform addresses
 * follow their nav item; `/manage` and `/platform` themselves open when any
 * of their items does. Everything else in the product is open to members
 * (what a page shows inside is still decided by the API).
 */
export function canAccessPath(pathname: string, session: AuthSession | null, isEnabled: FeatureCheck = allFeatures): boolean {
  const [path] = pathname.split("?");
  if (path === "/manage") return visibleNavItems(MANAGE_NAV, session, isEnabled).length > 0;
  if (path === "/platform") return canAccessPlatformControl(session) && visibleNavItems(PLATFORM_NAV, session, isEnabled).length > 0;
  for (const item of [...MANAGE_NAV, ...PLATFORM_NAV]) {
    if (isNavItemActive(item, path)) return canOpenNavItem(item, session, isEnabled);
  }
  if (ownsPath("/manage", path) || ownsPath("/platform", path)) return false;
  return Boolean(session);
}
