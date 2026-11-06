import {
  Activity,
  BookOpen,
  Building,
  ChartColumn,
  ClipboardList,
  Database,
  Files,
  House,
  Inbox,
  Layers,
  MessageSquare,
  Plug,
  RefreshCw,
  Server,
  Settings,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";

import type { WorkspaceModule, WorkspacePermission } from "@/lib/workspace";

/**
 * The information architecture (UX preview `scripts/core/router.js` and
 * `shell.js`): every screen's mode, title, nav item and gate, and the
 * sidebar's destinations. The sidebar, topbar, command palette and the
 * shell's route gate all read these; the API still authorizes every request.
 */

export type ShellMode = "auth" | "workspace" | "platform";

/** Which attention count a nav item shows. */
export type NavBadge = "requests" | "documents" | "sources" | "connections" | "people" | "indexing" | "health";

export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  href: string;
  /** Workspace permission (preview `can(perm)`) the caller needs. */
  permission?: WorkspacePermission;
  /** Workspace module that must be on. */
  module?: WorkspaceModule;
  badge?: NavBadge;
  /** The badge means something is broken (danger tone). */
  alert?: boolean;
}

/** What the caller may see in the active workspace (`useWorkspace()`). */
export interface NavAccess {
  can: (permission: WorkspacePermission) => boolean;
  hasModule: (module: WorkspaceModule) => boolean;
}

/** Member destinations, filtered by workspace modules. Conversations live in the sidebar's Recent group. */
export const MEMBER_NAV: readonly NavItem[] = [
  { id: "home", label: "Home", icon: House, href: "/home" },
  { id: "knowledge", label: "Knowledge", icon: BookOpen, href: "/knowledge" },
  { id: "work", label: "Work", icon: Sparkles, href: "/work", module: "work" },
  { id: "requests", label: "Requests", icon: ClipboardList, href: "/requests", module: "requests", badge: "requests" },
];

/** Pages that are not in the sidebar but stay one ⌘K away. */
export const MORE_PAGES: readonly NavItem[] = [
  { id: "inbox", label: "Inbox", icon: Inbox, href: "/inbox" },
  { id: "chats", label: "All conversations", icon: MessageSquare, href: "/chats" },
];

/** Spaces index (sidebar group label link and ⌘K page). */
export const SPACES_NAV: NavItem = { id: "spaces", label: "Spaces", icon: Layers, href: "/spaces", module: "spaces" };

/** The Manage group: only what the caller may open is listed. */
export const MANAGE_NAV: readonly NavItem[] = [
  { id: "overview", label: "Overview", icon: House, href: "/overview", permission: "workspaces.getOverview" },
  { id: "documents", label: "Documents", icon: Files, href: "/documents", permission: "contributions.review", badge: "documents" },
  { id: "sources", label: "Sources", icon: RefreshCw, href: "/sources", permission: "sources.list", badge: "sources", alert: true },
  // Preview gates Sources and Connections on one ability (source.manage); members can list their own connections.
  { id: "connections", label: "Connections", icon: Plug, href: "/connections", permission: "sources.list", badge: "connections", alert: true },
  { id: "people", label: "People", icon: Users, href: "/people", permission: "members.create", badge: "people" },
  { id: "assistant", label: "Assistant", icon: Sparkles, href: "/assistant", permission: "workspaces.updateAssistant" },
  { id: "activity", label: "Activity", icon: Activity, href: "/activity", permission: "auditEvents.list" },
  { id: "settings", label: "Settings", icon: Settings, href: "/settings", permission: "workspaces.updateSettings" },
];

/** The platform console (operators): the same shell, a different sidebar. */
export const PLATFORM_NAV: readonly NavItem[] = [
  { id: "p-workspaces", label: "Workspaces", icon: Building, href: "/p/workspaces" },
  { id: "p-users", label: "Users", icon: Users, href: "/p/users" },
  { id: "p-connectors", label: "Connectors", icon: Plug, href: "/p/connectors" },
  { id: "p-indexing", label: "Indexing", icon: Database, href: "/p/indexing", badge: "indexing", alert: true },
  { id: "p-usage", label: "Usage", icon: ChartColumn, href: "/p/usage" },
  { id: "p-audit", label: "Audit log", icon: Activity, href: "/p/audit" },
  { id: "p-health", label: "System health", icon: Server, href: "/p/health", badge: "health", alert: true },
];

export const PLATFORM_CONSOLE: NavItem = { id: "platform", label: "Platform console", icon: Layers, href: "/p/workspaces" };

/** Whether the caller may open an item. */
export function canSeeNavItem(item: NavItem, access: NavAccess): boolean {
  return (!item.module || access.hasModule(item.module)) && (!item.permission || access.can(item.permission));
}

export function memberNav(access: NavAccess): NavItem[] {
  return MEMBER_NAV.filter((item) => canSeeNavItem(item, access));
}

export function manageNav(access: NavAccess): NavItem[] {
  return MANAGE_NAV.filter((item) => canSeeNavItem(item, access));
}

/* ── Routes ── */

export interface RouteInfo {
  title: string;
  mode: ShellMode;
  /** The nav item this screen belongs to (sidebar highlight). */
  nav?: string;
  permission?: WorkspacePermission;
  module?: WorkspaceModule;
  /** The page manages its own scrolling (chat, reader, work item). */
  bare?: boolean;
}

interface RouteDef extends RouteInfo {
  pattern: string;
}

/** The route table; `:name` matches one path segment. First match wins. */
export const ROUTES: readonly RouteDef[] = [
  { pattern: "/signin", title: "Sign in", mode: "auth" },
  { pattern: "/signup", title: "Create account", mode: "auth" },
  { pattern: "/password-reset", title: "Reset password", mode: "auth" },
  { pattern: "/password-reset/:token", title: "Reset password", mode: "auth" },
  { pattern: "/workspaces", title: "Choose a workspace", mode: "auth" },
  { pattern: "/home", title: "Home", mode: "workspace", nav: "home" },
  { pattern: "/spaces", title: "Spaces", mode: "workspace", nav: "spaces", module: "spaces" },
  { pattern: "/space/:id", title: "Space", mode: "workspace", nav: "space", module: "spaces" },
  { pattern: "/work", title: "Work", mode: "workspace", nav: "work", module: "work" },
  { pattern: "/work/new", title: "New work", mode: "workspace", nav: "work", module: "work" },
  { pattern: "/work/:id", title: "Work", mode: "workspace", nav: "work", module: "work", bare: true },
  { pattern: "/requests", title: "Requests", mode: "workspace", nav: "requests", module: "requests" },
  { pattern: "/requests/new", title: "New request", mode: "workspace", nav: "requests", module: "requests" },
  { pattern: "/requests/:id", title: "Request", mode: "workspace", nav: "requests", module: "requests" },
  { pattern: "/chat", title: "New chat", mode: "workspace", nav: "chat", bare: true },
  { pattern: "/chat/:id", title: "Chat", mode: "workspace", nav: "chat", bare: true },
  { pattern: "/chat/:id/shares/:share", title: "Shared conversation", mode: "workspace", nav: "chats", bare: true },
  { pattern: "/project/:id", title: "Project", mode: "workspace", nav: "projects" },
  { pattern: "/chats", title: "Conversations", mode: "workspace", nav: "chats" },
  { pattern: "/inbox", title: "Inbox", mode: "workspace", nav: "inbox" },
  { pattern: "/search", title: "Search", mode: "workspace", nav: "search" },
  { pattern: "/knowledge", title: "Knowledge", mode: "workspace", nav: "knowledge" },
  { pattern: "/knowledge/library", title: "My library", mode: "workspace", nav: "knowledge" },
  { pattern: "/knowledge/bases", title: "Knowledge bases", mode: "workspace", nav: "knowledge" },
  { pattern: "/knowledge/collections/:id", title: "Collection", mode: "workspace", nav: "knowledge" },
  { pattern: "/knowledge/:id", title: "Knowledge base", mode: "workspace", nav: "knowledge" },
  { pattern: "/doc/:id", title: "Document", mode: "workspace", nav: "knowledge", bare: true },
  { pattern: "/overview", title: "Overview", mode: "workspace", nav: "overview", permission: "workspaces.getOverview" },
  { pattern: "/documents", title: "Documents", mode: "workspace", nav: "documents", permission: "contributions.review" },
  { pattern: "/sources", title: "Sources", mode: "workspace", nav: "sources", permission: "sources.list" },
  { pattern: "/connections", title: "Connections", mode: "workspace", nav: "connections", permission: "sources.list" },
  { pattern: "/people", title: "People", mode: "workspace", nav: "people", permission: "members.create" },
  { pattern: "/assistant", title: "Assistant", mode: "workspace", nav: "assistant", permission: "workspaces.updateAssistant" },
  { pattern: "/activity", title: "Activity", mode: "workspace", nav: "activity", permission: "auditEvents.list" },
  { pattern: "/settings", title: "Settings", mode: "workspace", nav: "settings", permission: "workspaces.updateSettings" },
  { pattern: "/p/workspaces", title: "Workspaces", mode: "platform", nav: "p-workspaces" },
  { pattern: "/p/users", title: "Users", mode: "platform", nav: "p-users" },
  { pattern: "/p/connectors", title: "Connectors", mode: "platform", nav: "p-connectors" },
  { pattern: "/p/indexing", title: "Indexing", mode: "platform", nav: "p-indexing" },
  { pattern: "/p/usage", title: "Usage", mode: "platform", nav: "p-usage" },
  { pattern: "/p/audit", title: "Audit log", mode: "platform", nav: "p-audit" },
  { pattern: "/p/health", title: "System health", mode: "platform", nav: "p-health" },
];

const NOT_FOUND: RouteInfo = { title: "Not found", mode: "workspace" };

function matches(pattern: string, pathname: string): boolean {
  const want = pattern.split("/");
  const got = pathname.replace(/\/+$/, "").split("/");
  return want.length === got.length && want.every((seg, i) => seg.startsWith(":") ? got[i] !== "" : seg === got[i]);
}

/** The route an address belongs to; unknown addresses are "Not found" (platform ones in the console). */
export function matchRoute(pathname: string): RouteInfo {
  const def = ROUTES.find((r) => matches(r.pattern, pathname || "/"));
  if (def) {
    const { pattern: _pattern, ...info } = def;
    return info;
  }
  return pathname.startsWith("/p/") ? { ...NOT_FOUND, mode: "platform" } : NOT_FOUND;
}

/** Whether a sidebar item is the current place. */
export function isNavItemActive(item: NavItem, route: RouteInfo): boolean {
  return route.nav === item.id;
}

/** Why the shell would not render a screen for this caller, if it wouldn't. */
export function routeGate(route: RouteInfo, access: NavAccess): "permission" | "module" | null {
  if (route.permission && !access.can(route.permission)) return "permission";
  if (route.module && !access.hasModule(route.module)) return "module";
  return null;
}
