import {
  Activity,
  BookOpen,
  Bot,
  Building,
  ChartColumn,
  ClipboardList,
  Database,
  Folder,
  House,
  LayoutDashboard,
  Layers,
  Library,
  MessageSquarePlus,
  Plug,
  Server,
  Settings,
  Sparkles,
  Upload,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useSearchParams } from "next/navigation";

import type { Messages, Msg } from "@/i18n/messages";
import type { WorkspaceModule, WorkspacePermission } from "@/lib/workspace";

/**
 * The information architecture (UX preview `scripts/core/router.js` and
 * `shell.js`): every screen's mode, title, nav item and gate, the sidebar's
 * destinations and each area's sections. The sidebar, the top row, the command
 * palette and the shell's route gate all read these; the API still authorizes
 * every request. Names are message accessors (`m => m.nav.…`), never display
 * text: components resolve them with `useMessages()`.
 */

export type ShellMode = "auth" | "workspace" | "platform";

/** The catalog's place names (`m.nav.home`, …): the string entries of `nav`. */
type PlaceName = { [K in keyof Messages["nav"]]: Messages["nav"][K] extends string ? K : never }[keyof Messages["nav"]];

/** A place's name as a message accessor. */
const place =
  (name: PlaceName): Msg =>
  (m) =>
    m.nav[name];

/* ── Sections: an area's pages, listed as sidebar sub-rows (preview `pageSections`) ── */

/** One section of an area, addressed by `?tab=`. `title` is the top-row title when it differs from the label. */
export interface Section {
  id: string;
  label: Msg;
  href: string;
  title?: Msg;
  /** Starts a new cluster (a small gap above it in the sidebar). */
  gap?: boolean;
}

/** Knowledge's personal sections. Browse is `/knowledge` itself; "My files" exists only with a personal collection. */
export const librarySections: readonly Section[] = [
  { id: "saved", label: place("saved"), href: "/knowledge/library?tab=saved" },
  { id: "files", label: place("myFiles"), href: "/knowledge/library?tab=files" },
];

export const peopleSections: readonly Section[] = [
  { id: "members", label: place("members"), href: "/people?tab=members" },
  { id: "groups", label: place("groups"), href: "/people?tab=groups" },
  { id: "roles", label: place("roles"), href: "/people?tab=roles" },
  { id: "requests", label: place("accessRequests"), href: "/people?tab=requests" },
];

export const activitySections: readonly Section[] = [
  { id: "changes", label: place("changes"), href: "/activity?tab=changes" },
  { id: "signins", label: place("signIns"), href: "/activity?tab=signins" },
];

export const settingsSections: readonly Section[] = [
  { id: "general", label: place("general"), href: "/settings?tab=general" },
  { id: "setup", label: place("workspaceSetup"), href: "/settings?tab=setup" },
];

/** "By workspace", so it never reads as the Workspaces page. */
export const indexingSections: readonly Section[] = [
  { id: "workspaces", label: place("byWorkspace"), href: "/p/indexing?tab=workspaces", title: place("indexing") },
  { id: "jobs", label: place("jobs"), href: "/p/indexing?tab=jobs", title: place("indexingJobs") },
  { id: "policies", label: place("policies"), href: "/p/indexing?tab=policies", title: place("indexingPolicies") },
];

/** What decides the Knowledge Studio sections the caller gets. */
export interface StudioAccess {
  can: (permission: WorkspacePermission) => boolean;
  /** Holds `items.create`, or owns/edits at least one shared collection. */
  managesCollections: boolean;
}

export type StudioSectionId = "documents" | "collections" | "topics" | "sources";

/** [id, label, cluster, who may use it]; setup is listed in the order it's done: where → what about → what comes in. */
const STUDIO_DEFS: readonly [StudioSectionId, Msg, "work" | "setup", (a: StudioAccess) => boolean][] = [
  ["documents", (m) => m.nav.documents, "work", (a) => a.can("contributions.review")],
  ["collections", (m) => m.nav.collections, "setup", (a) => a.managesCollections],
  ["topics", (m) => m.nav.topics, "setup", (a) => a.can("topics.update")],
  ["sources", (m) => m.nav.sources, "setup", (a) => a.can("sources.list")],
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

/** What the top row shows for a section: its `title`, else its label ("" for an unknown section). */
export function sectionTitle(sections: readonly Section[], id: string, m: Messages): string {
  const s = sections.find((x) => x.id === id);
  return s ? (s.title ?? s.label)(m) : "";
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
  label: Msg;
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
  home?: Msg;
}

/** What the caller may see in the active workspace (`useWorkspace()`). */
export interface NavAccess {
  can: (permission: WorkspacePermission) => boolean;
  hasModule: (module: WorkspaceModule) => boolean;
}

/**
 * WORKSPACE: where the organisation's knowledge and work live, filtered by workspace modules. Inbox is the top-row bell.
 * New chat starts a conversation; the conversations themselves are the sidebar's last group, Recent.
 */
export const MEMBER_NAV: readonly NavItem[] = [
  { id: "home", label: place("home"), icon: House, href: "/home" },
  { id: "knowledge", label: place("knowledge"), icon: BookOpen, href: "/knowledge", sections: "library", home: place("browse") },
  { id: "chat", label: place("newChat"), icon: MessageSquarePlus, href: "/chat" },
  { id: "work", label: place("work"), icon: Sparkles, href: "/work", module: "work" },
  { id: "requests", label: place("requests"), icon: ClipboardList, href: "/requests", module: "requests", badge: "requests" },
];

/**
 * YOUR WORK: your project folders, your spaces, your submissions. My contributions shows to contributors and to anyone
 * who still has submissions to follow (the sidebar decides the latter).
 */
export const YOUR_WORK_NAV: readonly NavItem[] = [
  { id: "projects", label: place("projects"), icon: Folder, href: "/projects" },
  { id: "spaces", label: place("spaces"), icon: Layers, href: "/spaces", module: "spaces" },
  { id: "contributions", label: place("myContributions"), icon: Upload, href: "/contributions", badge: "contributions" },
];

/** Knowledge Studio: shown when the caller has at least one Studio section (`studioSections`). */
export const STUDIO_NAV: NavItem = { id: "studio", label: place("studio"), icon: Library, href: "/studio", badge: "studio", sections: "studio" };

/** MANAGE: run the workspace. Everything about knowledge is one destination, Knowledge Studio (inserted by `manageNav`). */
export const MANAGE_NAV: readonly NavItem[] = [
  { id: "overview", label: place("overview"), icon: LayoutDashboard, href: "/overview", permission: "workspaces.getOverview" },
  { id: "people", label: place("people"), icon: Users, href: "/people", permission: "members.create", badge: "people", sections: "people" },
  { id: "assistant", label: place("assistant"), icon: Bot, href: "/assistant", permission: "workspaces.updateAssistant" },
  { id: "activity", label: place("activity"), icon: Activity, href: "/activity", permission: "auditEvents.list", sections: "activity" },
  { id: "settings", label: place("settings"), icon: Settings, href: "/settings", permission: "workspaces.updateSettings", sections: "settings" },
];

/** The platform console (operators): the same shell, a different sidebar. */
export const PLATFORM_NAV: readonly NavItem[] = [
  { id: "p-workspaces", label: place("workspaces"), icon: Building, href: "/p/workspaces", badge: "platformWorkspaces" },
  { id: "p-users", label: place("users"), icon: Users, href: "/p/users" },
  { id: "p-connectors", label: place("connectors"), icon: Plug, href: "/p/connectors" },
  { id: "p-indexing", label: place("indexing"), icon: Database, href: "/p/indexing", badge: "indexing", alert: true, sections: "indexing" },
  { id: "p-usage", label: place("usage"), icon: ChartColumn, href: "/p/usage" },
  { id: "p-audit", label: place("auditLog"), icon: Activity, href: "/p/audit" },
  { id: "p-health", label: place("systemHealth"), icon: Server, href: "/p/health", badge: "health", alert: true },
];

export const PLATFORM_CONSOLE: NavItem = { id: "platform", label: place("platformConsole"), icon: Layers, href: "/p/workspaces" };

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
  title: Msg;
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
  { pattern: "/signin", title: place("signIn"), mode: "auth" },
  { pattern: "/signup", title: place("createAccount"), mode: "auth" },
  { pattern: "/password-reset", title: place("resetPassword"), mode: "auth" },
  { pattern: "/password-reset/:token", title: place("resetPassword"), mode: "auth" },
  { pattern: "/workspaces", title: place("chooseWorkspace"), mode: "auth" },
  { pattern: "/s/:token", title: place("sharedLink"), mode: "auth" },
  { pattern: "/home", title: place("home"), mode: "workspace", nav: "home" },
  { pattern: "/projects", title: place("projects"), mode: "workspace", nav: "projects" },
  { pattern: "/project/:id", title: place("project"), mode: "workspace", nav: "projects" },
  { pattern: "/contributions", title: place("myContributions"), mode: "workspace", nav: "contributions" },
  { pattern: "/spaces", title: place("spaces"), mode: "workspace", nav: "spaces", module: "spaces" },
  { pattern: "/space/:id", title: place("space"), mode: "workspace", nav: "spaces", module: "spaces" },
  { pattern: "/work", title: place("work"), mode: "workspace", nav: "work", module: "work" },
  { pattern: "/work/new", title: place("newWork"), mode: "workspace", nav: "work", module: "work" },
  { pattern: "/work/:id", title: place("work"), mode: "workspace", nav: "work", module: "work", bare: true },
  { pattern: "/requests", title: place("requests"), mode: "workspace", nav: "requests", module: "requests" },
  { pattern: "/requests/new", title: place("newRequest"), mode: "workspace", nav: "requests", module: "requests" },
  { pattern: "/requests/:id", title: place("request"), mode: "workspace", nav: "requests", module: "requests" },
  // New chat (/chat) starts a conversation; an open one (/chat/:id) is marked in the sidebar's Recent list, not on New chat.
  { pattern: "/chat", title: place("newChat"), mode: "workspace", nav: "chat", bare: true },
  { pattern: "/chat/:id", title: place("conversation"), mode: "workspace", nav: "conversation", bare: true },
  { pattern: "/search", title: place("search"), mode: "workspace" },
  { pattern: "/knowledge", title: place("knowledge"), mode: "workspace", nav: "knowledge" },
  { pattern: "/knowledge/library", title: place("knowledge"), mode: "workspace", nav: "knowledge" },
  { pattern: "/knowledge/map", title: place("knowledgeMap"), mode: "workspace", nav: "knowledge" },
  { pattern: "/doc/:id", title: place("document"), mode: "workspace", nav: "knowledge", bare: true },
  { pattern: "/overview", title: place("overview"), mode: "workspace", nav: "overview", permission: "workspaces.getOverview" },
  { pattern: "/studio", title: place("studio"), mode: "workspace", nav: "studio" },
  { pattern: "/studio/collections/:id", title: place("collection"), mode: "workspace", nav: "studio" },
  { pattern: "/people", title: place("people"), mode: "workspace", nav: "people", permission: "members.create" },
  { pattern: "/assistant", title: place("assistant"), mode: "workspace", nav: "assistant", permission: "workspaces.updateAssistant" },
  { pattern: "/activity", title: place("activity"), mode: "workspace", nav: "activity", permission: "auditEvents.list" },
  { pattern: "/settings", title: place("settings"), mode: "workspace", nav: "settings", permission: "workspaces.updateSettings" },
  { pattern: "/p/workspaces", title: place("workspaces"), mode: "platform", nav: "p-workspaces" },
  { pattern: "/p/users", title: place("users"), mode: "platform", nav: "p-users" },
  { pattern: "/p/connectors", title: place("connectors"), mode: "platform", nav: "p-connectors" },
  { pattern: "/p/indexing", title: place("indexing"), mode: "platform", nav: "p-indexing" },
  { pattern: "/p/usage", title: place("usage"), mode: "platform", nav: "p-usage" },
  { pattern: "/p/audit", title: place("auditLog"), mode: "platform", nav: "p-audit" },
  { pattern: "/p/health", title: place("systemHealth"), mode: "platform", nav: "p-health" },
];

const NOT_FOUND: RouteInfo = { title: place("notFound"), mode: "workspace" };

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
