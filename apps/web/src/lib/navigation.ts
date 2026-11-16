import {
  Activity,
  BookOpen,
  Bot,
  Building,
  ChartColumn,
  ClipboardList,
  Clock,
  Database,
  Folder,
  House,
  LayoutDashboard,
  Layers,
  Library,
  MessageSquare,
  Plug,
  Server,
  Settings,
  Sparkles,
  Upload,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useSearchParams } from "next/navigation";

import type { WorkspaceModule, WorkspacePermission } from "@/lib/workspace";

/**
 * The information architecture (UX preview `scripts/core/router.js` and
 * `shell.js`): every screen's mode, title, nav item and gate, the sidebar's
 * destinations and each area's sections. The sidebar, the top row, the command
 * palette and the shell's route gate all read these; the API still authorizes
 * every request.
 */

export type ShellMode = "auth" | "workspace" | "platform";

/* ── Sections: an area's pages, listed as sidebar sub-rows (preview `pageSections`) ── */

/** One section of an area, addressed by `?tab=`. `title` is the top-row title when it differs from the label. */
export interface Section {
  id: string;
  label: string;
  href: string;
  title?: string;
  /** Starts a new cluster (a small gap above it in the sidebar). */
  gap?: boolean;
}

/** Knowledge's personal sections. Browse is `/knowledge` itself; "My files" exists only with a personal collection. */
export const librarySections: readonly Section[] = [
  { id: "saved", label: "Saved", href: "/knowledge/library?tab=saved" },
  { id: "files", label: "My files", href: "/knowledge/library?tab=files" },
  { id: "lists", label: "My reading lists", href: "/knowledge/library?tab=lists" },
];

export const peopleSections: readonly Section[] = [
  { id: "members", label: "Members", href: "/people?tab=members" },
  { id: "groups", label: "Groups", href: "/people?tab=groups" },
  { id: "roles", label: "Roles", href: "/people?tab=roles" },
  { id: "requests", label: "Access requests", href: "/people?tab=requests" },
];

export const activitySections: readonly Section[] = [
  { id: "changes", label: "Changes", href: "/activity?tab=changes" },
  { id: "signins", label: "Sign-ins", href: "/activity?tab=signins" },
];

export const settingsSections: readonly Section[] = [
  { id: "general", label: "General", href: "/settings?tab=general" },
  { id: "setup", label: "Workspace setup", href: "/settings?tab=setup" },
];

/** "By workspace", so it never reads as the Workspaces page. */
export const indexingSections: readonly Section[] = [
  { id: "workspaces", label: "By workspace", href: "/p/indexing?tab=workspaces", title: "Indexing" },
  { id: "jobs", label: "Jobs", href: "/p/indexing?tab=jobs", title: "Indexing jobs" },
  { id: "policies", label: "Policies", href: "/p/indexing?tab=policies", title: "Indexing policies" },
];

/** What decides the Knowledge Studio sections the caller gets. */
export interface StudioAccess {
  can: (permission: WorkspacePermission) => boolean;
  /** Holds `items.create`, or owns/edits at least one shared collection. */
  managesCollections: boolean;
}

export type StudioSectionId = "documents" | "collections" | "topics" | "sources";

/** [id, label, cluster, who may use it]; setup is listed in the order it's done: where → what about → what comes in. */
const STUDIO_DEFS: readonly [StudioSectionId, string, "work" | "setup", (a: StudioAccess) => boolean][] = [
  ["documents", "Documents", "work", (a) => a.can("contributions.review")],
  ["collections", "Collections", "setup", (a) => a.managesCollections],
  ["topics", "Topics", "setup", (a) => a.can("topics.update")],
  ["sources", "Sources", "setup", (a) => a.can("sources.list")],
];

/** Knowledge Studio's sections the caller may use: Documents │ Collections · Topics · Sources. */
export function studioSections(access: StudioAccess): Section[] {
  const defs = STUDIO_DEFS.filter((d) => d[3](access));
  return defs.map(([id, label, cluster], i) => ({
    id,
    label,
    href: `/studio?tab=${id}`,
    gap: i > 0 && defs[i - 1][2] !== cluster,
  }));
}

const OLD_TABS = ["flow", "review", "quality", "details", "duplicates", "all", "library", "taxonomy", "master", "bases"];
const QUALITY_PARTS = ["reverify", "details", "duplicates"];
/** The retired `?life=` stage filter → Documents' views and All's filters (`processing=`, `pub=`); other stages drop. */
const OLD_LIFE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  review: { view: "review" },
  changes: { view: "review" },
  attention: { view: "processing" },
  publishing: { view: "all", processing: "processing" },
  published: { view: "all", pub: "published" },
  closed: { view: "all", pub: "unpublished" },
  unpublished: { view: "all", pub: "unpublished" },
};

/**
 * Old Knowledge Studio addresses → the current one (preview `features/curation.js` `legacyOf`), null when `q` is
 * current. Review, Quality, Issues, Knowledge flow and their queues land in Documents' views (`view=all|processing|
 * review`; Quality is All's `quality=` filter, Issues is Processing); Taxonomy, Master data and classification rules in
 * Topics; corrections, confirmations and proposals in Topics → Suggestions; Library and All in Documents → All; Bases in
 * Collections. The Studio replaces the address with the result (no history entry).
 */
export function studioAddress(q: Readonly<Record<string, string>>): Record<string, string> | null {
  const life = q.life ?? "";
  const learn = q.node === "__learn" || q.node === "__proposed";
  const oldView = q.tab === "documents" && (q.view === "issues" || q.view === "quality");
  if (!OLD_TABS.includes(q.tab ?? "") && !q.queue && !life && !q.stage && !q.seg && !q.mode && !learn && !oldView) return null;
  const n: Record<string, string> = { ...q };
  for (const k of ["mode", "queue", "stage", "seg", "life", "part"]) delete n[k];
  if (life) return { ...n, tab: "documents", ...(OLD_LIFE[life] ?? { view: "all" }) };
  if (q.tab === "bases") return { ...n, tab: "collections" };
  const queue = q.queue || q.seg || (q.tab === "details" || q.tab === "duplicates" ? q.tab : "");
  const suggestions = queue === "confirm" || queue === "classify" || learn;
  if (q.tab === "taxonomy" || q.tab === "master" || q.mode === "rules" || suggestions) {
    if (learn) delete n.node;
    return { ...n, tab: "topics", view: suggestions ? "suggestions" : "topics" };
  }
  n.tab = "documents";
  const part = QUALITY_PARTS.find((p) => p === q.part || p === queue);
  if (q.view === "quality" || ["reverify", "details", "duplicates", "quality", "upkeep"].includes(queue) || q.tab === "quality" || (queue === "review" && q.tab !== "review")) {
    n.view = "all";
    n.quality = part ?? "reverify";
  } else if (q.view === "issues" || queue === "problems" || queue === "issues" || q.stage === "issue") n.view = "processing";
  else if (["submissions", "batches", "publish"].includes(queue) || q.stage === "decide" || q.tab === "review" || q.mode === "needs") n.view = "review";
  else n.view = "all";
  return n;
}

/**
 * The section Knowledge Studio opens on: what needs the caller first — decisions that keep documents from people
 * (Documents), then broken sources (Sources), then the first allowed section.
 */
export function studioLanding(sections: readonly Section[], counts: { documents?: number; sources?: number }): string {
  const has = (id: string) => sections.some((s) => s.id === id);
  if (has("documents") && counts.documents) return "documents";
  if (has("sources") && counts.sources) return "sources";
  return sections[0]?.id ?? "";
}

/** The `?tab=` of `query` when it names one of `sections`, else `fallback` (default: the first section). */
export function sectionOf(sections: readonly Section[], tab: string | null | undefined, fallback?: string): string {
  return tab && sections.some((s) => s.id === tab) ? tab : (fallback ?? sections[0]?.id ?? "");
}

/** The active section id from the address's `?tab=` (an unknown one falls back). */
export function useSection(sections: readonly Section[], fallback?: string): string {
  return sectionOf(sections, useSearchParams().get("tab"), fallback);
}

/** What the top row shows for a section: its `title`, else its label. */
export function sectionTitle(sections: readonly Section[], id: string): string {
  const s = sections.find((x) => x.id === id);
  return s?.title ?? s?.label ?? "";
}

/** The path part of a section address (`/people?tab=roles` → `/people`). */
export const sectionPath = (s: Section): string => s.href.split("?")[0];

/* ── Sidebar destinations ── */

/** Which attention count a nav item (or section) shows. */
export type NavBadge = "requests" | "contributions" | "studio" | "people" | "indexing" | "health" | "platformWorkspaces";

/** Which section list a row opens as sub-rows while you're in its area. */
export type NavSections = "library" | "studio" | "people" | "activity" | "settings" | "indexing";

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
  /** The area's sections, shown as sub-rows. */
  sections?: NavSections;
  /** The row's own page in the rail's section menu, when it is not one of the sections (Knowledge → Browse). */
  home?: string;
}

/** What the caller may see in the active workspace (`useWorkspace()`). */
export interface NavAccess {
  can: (permission: WorkspacePermission) => boolean;
  hasModule: (module: WorkspaceModule) => boolean;
}

/** WORKSPACE: where the organisation's knowledge and work live, filtered by workspace modules. Inbox is the top-row bell. */
export const MEMBER_NAV: readonly NavItem[] = [
  { id: "home", label: "Home", icon: House, href: "/home" },
  { id: "knowledge", label: "Knowledge", icon: BookOpen, href: "/knowledge", sections: "library", home: "Browse" },
  { id: "chat", label: "AI Chat", icon: MessageSquare, href: "/chat" },
  { id: "work", label: "Work", icon: Sparkles, href: "/work", module: "work" },
  { id: "requests", label: "Requests", icon: ClipboardList, href: "/requests", module: "requests", badge: "requests" },
];

/**
 * YOUR WORK: what you touched lately, your project folders, your spaces, your submissions. My contributions shows to
 * contributors and to anyone who still has submissions to follow (the sidebar decides the latter).
 */
export const YOUR_WORK_NAV: readonly NavItem[] = [
  { id: "recent", label: "Recent", icon: Clock, href: "/recent" },
  { id: "projects", label: "Projects", icon: Folder, href: "/projects" },
  { id: "spaces", label: "Spaces", icon: Layers, href: "/spaces", module: "spaces" },
  { id: "contributions", label: "My contributions", icon: Upload, href: "/contributions", badge: "contributions" },
];

/** Knowledge Studio: shown when the caller has at least one Studio section (`studioSections`). */
export const STUDIO_NAV: NavItem = { id: "studio", label: "Knowledge Studio", icon: Library, href: "/studio", badge: "studio", sections: "studio" };

/** MANAGE: run the workspace. Everything about knowledge is one destination, Knowledge Studio (inserted by `manageNav`). */
export const MANAGE_NAV: readonly NavItem[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard, href: "/overview", permission: "workspaces.getOverview" },
  { id: "people", label: "People", icon: Users, href: "/people", permission: "members.create", badge: "people", sections: "people" },
  { id: "assistant", label: "Assistant", icon: Bot, href: "/assistant", permission: "workspaces.updateAssistant" },
  { id: "activity", label: "Activity", icon: Activity, href: "/activity", permission: "auditEvents.list", sections: "activity" },
  { id: "settings", label: "Settings", icon: Settings, href: "/settings", permission: "workspaces.updateSettings", sections: "settings" },
];

/** The platform console (operators): the same shell, a different sidebar. */
export const PLATFORM_NAV: readonly NavItem[] = [
  { id: "p-workspaces", label: "Workspaces", icon: Building, href: "/p/workspaces", badge: "platformWorkspaces" },
  { id: "p-users", label: "Users", icon: Users, href: "/p/users" },
  { id: "p-connectors", label: "Connectors", icon: Plug, href: "/p/connectors" },
  { id: "p-indexing", label: "Indexing", icon: Database, href: "/p/indexing", badge: "indexing", alert: true, sections: "indexing" },
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

/** Your work rows; `contributions` decides whether My contributions shows, `projects` whether Projects does (the API has
 *  no projects: only the development adapter supplies them, `projectsAvailable` in `modules/projects/adapter`). */
export function yourWorkNav(access: NavAccess, contributions: boolean, projects: boolean): NavItem[] {
  return YOUR_WORK_NAV.filter(
    (item) => canSeeNavItem(item, access) && (item.id !== "contributions" || contributions) && (item.id !== "projects" || projects),
  );
}

/** Manage rows the caller may use; Knowledge Studio second when `studio` (an editor who owns a collection sees only it). */
export function manageNav(access: NavAccess, studio: boolean): NavItem[] {
  const rows = MANAGE_NAV.filter((item) => canSeeNavItem(item, access));
  if (studio) rows.splice(rows[0]?.id === "overview" ? 1 : 0, 0, STUDIO_NAV);
  return rows;
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
  { pattern: "/recent", title: "Recent", mode: "workspace", nav: "recent" },
  { pattern: "/projects", title: "Projects", mode: "workspace", nav: "projects" },
  { pattern: "/project/:id", title: "Project", mode: "workspace", nav: "projects" },
  { pattern: "/contributions", title: "My contributions", mode: "workspace", nav: "contributions" },
  { pattern: "/spaces", title: "Spaces", mode: "workspace", nav: "spaces", module: "spaces" },
  { pattern: "/space/:id", title: "Space", mode: "workspace", nav: "spaces", module: "spaces" },
  { pattern: "/work", title: "Work", mode: "workspace", nav: "work", module: "work" },
  { pattern: "/work/new", title: "New work", mode: "workspace", nav: "work", module: "work" },
  { pattern: "/work/:id", title: "Work", mode: "workspace", nav: "work", module: "work", bare: true },
  { pattern: "/requests", title: "Requests", mode: "workspace", nav: "requests", module: "requests" },
  { pattern: "/requests/new", title: "New request", mode: "workspace", nav: "requests", module: "requests" },
  { pattern: "/requests/:id", title: "Request", mode: "workspace", nav: "requests", module: "requests" },
  { pattern: "/chat", title: "New chat", mode: "workspace", nav: "chat", bare: true },
  { pattern: "/chat/:id", title: "Chat", mode: "workspace", nav: "chat", bare: true },
  { pattern: "/chat/:id/shares/:share", title: "Shared conversation", mode: "workspace", nav: "chat", bare: true },
  { pattern: "/search", title: "Search", mode: "workspace" },
  { pattern: "/knowledge", title: "Knowledge", mode: "workspace", nav: "knowledge" },
  { pattern: "/knowledge/library", title: "Knowledge", mode: "workspace", nav: "knowledge" },
  { pattern: "/knowledge/lists/:id", title: "Reading list", mode: "workspace", nav: "knowledge" },
  { pattern: "/doc/:id", title: "Document", mode: "workspace", nav: "knowledge", bare: true },
  { pattern: "/overview", title: "Overview", mode: "workspace", nav: "overview", permission: "workspaces.getOverview" },
  { pattern: "/studio", title: "Knowledge Studio", mode: "workspace", nav: "studio" },
  { pattern: "/studio/collections/:id", title: "Collection", mode: "workspace", nav: "studio" },
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
  return want.length === got.length && want.every((seg, i) => (seg.startsWith(":") ? got[i] !== "" : seg === got[i]));
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
