"use client";

import { Dropdown, Header, Label, Separator } from "@heroui/react";
import clsx from "clsx";
import { ArrowLeft, ChevronDown, PanelLeft, RefreshCw, Search, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useState, type FocusEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";

import { IconButton } from "@/components/ui/IconButton";
import { Kbd } from "@/components/ui/Kbd";
import { resourceId } from "@/lib/api/client";
import {
  activitySections,
  indexingSections,
  isNavItemActive,
  librarySections,
  manageNav,
  memberNav,
  PLATFORM_NAV,
  peopleSections,
  sectionOf,
  sectionPath,
  settingsSections,
  studioAddress,
  studioLanding,
  yourWorkNav,
  type NavItem,
  type NavSections,
  type RouteInfo,
  type Section,
  type ShellMode,
} from "@/lib/navigation";
import { isPlatformOperator, useSession } from "@/lib/session";
import { useWorkspace } from "@/lib/workspace";
import { usePlatformNavBadges } from "@/modules/platform/queries";
import { ConversationMenu, conversationTitle, projectsAvailable, useConversations, type Conversation } from "@/modules/projects";

import { AccountMenu } from "./AccountMenu";
import { useNavBadges, useStudioSections, type Count } from "./badges";
import { openCommandPalette } from "./overlays";
import { useShellWorkspaces, WorkspaceMenu } from "./WorkspaceMenu";

/** A section as a sub-row: where it goes, whether it's the current page, its count. */
interface SubRow extends Section {
  current: boolean;
  count?: Count;
}

/** Collapsible groups (Your work, Manage, Recent) remember their state on this device; open until someone collapses them. */
const GROUPS_KEY = "bomesh.navGroups";

function useNavGroups(): [Record<string, boolean>, (key: string) => void] {
  const [groups, setGroups] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try {
      setGroups(JSON.parse(window.localStorage.getItem(GROUPS_KEY) ?? "{}") as Record<string, boolean>);
    } catch {
      setGroups({});
    }
  }, []);
  const toggle = useCallback((key: string) => {
    setGroups((g) => {
      const next = { ...g, [key]: g[key] === false };
      window.localStorage.setItem(GROUPS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  return [groups, toggle];
}

function Badge({ count, label }: { count?: Count; label?: string }) {
  if (!count?.n) return null;
  return (
    <span className={`badge badge--${count.tone}`} aria-label={label ?? `${count.n} need attention`}>
      {count.n > 99 ? "99+" : count.n}
    </span>
  );
}

interface NavRowProps {
  item: NavItem;
  active: boolean;
  rail: boolean;
  count?: Count;
  /** The area's sections (shown only when there are at least two). */
  subs: SubRow[];
}

/**
 * One sidebar row (preview `navItem`). While you're in its area and the sidebar is expanded, its sections show as
 * sub-rows that carry the counts; on a sub-row the parent stays marked as the area (`is-ancestor`). In the rail a row
 * with sections opens them as a menu to its right (the row's own page first, when it has one).
 */
function NavRow({ item, active, rail, count, subs }: NavRowProps) {
  const router = useRouter();
  const Icon = item.icon;
  const kids = subs.length > 1 ? subs : [];
  if (rail && kids.length) {
    const inKid = kids.some((k) => k.current);
    const items = [...(item.home ? [{ id: "home", label: item.home, href: item.href, current: active && !inKid, count: undefined, gap: false }] : []), ...kids];
    return (
      <Dropdown>
        <Dropdown.Trigger className="nav-item" id={`nav-${item.id}`} aria-current={active ? "page" : undefined} data-tip={item.label} aria-label={item.label}>
          <Icon className="i" aria-hidden />
          <span className="nav-item__label">{item.label}</span>
          <Badge count={count} />
        </Dropdown.Trigger>
        <Dropdown.Popover placement="right top" offset={8}>
          <Dropdown.Menu aria-label={item.label} onAction={(key) => router.push(items.find((k) => k.id === key)?.href ?? item.href)}>
            <Dropdown.Section selectionMode="single" selectedKeys={items.filter((k) => k.current).map((k) => k.id)}>
              <Header>{item.label}</Header>
              {items.map((k) => (
                <Fragment key={k.id}>
                  <Dropdown.Item id={k.id} textValue={k.label}>
                    <Label className="grow">{k.label}</Label>
                    {k.count?.n ? <span className="menu-item__meta">{k.count.n}</span> : null}
                    <Dropdown.ItemIndicator />
                  </Dropdown.Item>
                  {/* The row's own page (Knowledge → Browse) is set apart from its sections, as in the preview. */}
                  {k.id === "home" ? <Separator /> : null}
                </Fragment>
              ))}
            </Dropdown.Section>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    );
  }
  const shown = active && !rail ? kids : [];
  const inKid = shown.some((k) => k.current);
  return (
    <>
      <Link
        className={clsx("nav-item", inKid && "is-ancestor")}
        id={`nav-${item.id}`}
        href={item.href}
        aria-current={active && !inKid ? "page" : undefined}
        data-tip={rail ? item.label : undefined}
      >
        <Icon className="i" aria-hidden />
        <span className="nav-item__label">{item.label}</span>
        {shown.length ? null : <Badge count={count} />}
      </Link>
      {shown.length ? (
        <div className="nav-sub" role="group" aria-label={item.label}>
          {shown.map((k) => (
            <Link
              key={k.id}
              className={clsx("nav-item nav-item--sub", k.gap && "nav-item--gap")}
              id={`nav-${item.id}-${k.id}`}
              href={k.href}
              aria-current={k.current ? "page" : undefined}
            >
              <span className="nav-item__label">{k.label}</span>
              <Badge count={k.count} />
            </Link>
          ))}
        </div>
      ) : null}
    </>
  );
}

interface NavGroupProps {
  /** Collapsible when set (and the sidebar is expanded). */
  groupKey?: string;
  label: string;
  items: NavItem[];
  route: RouteInfo;
  rail: boolean;
  counts: (item: NavItem) => Count | undefined;
  subs: (item: NavItem) => SubRow[];
  groups?: Record<string, boolean>;
  onToggle?: (key: string) => void;
}

/**
 * A labelled group of rows (preview `navGroup`). With a key it collapses: it stays open while you're on one of its pages,
 * and collapsed it shows a dot when something inside needs attention (red when something is broken). In the rail every
 * group is open and the label becomes a hairline.
 */
function NavGroup({ groupKey, label, items, route, rail, counts, subs, groups = {}, onToggle }: NavGroupProps) {
  if (!items.length) return null;
  const rows = items.map((item) => (
    <NavRow key={item.id} item={item} active={isNavItemActive(item, route)} rail={rail} count={counts(item)} subs={subs(item)} />
  ));
  if (!groupKey || rail)
    return (
      <div className="sidebar__group" role="group" aria-label={label}>
        <div className="sidebar__group-label" aria-hidden>
          {label}
        </div>
        {rows}
      </div>
    );
  const here = items.some((item) => isNavItemActive(item, route));
  const open = here || groups[groupKey] !== false;
  const need = items.map(counts).filter((c): c is Count => Boolean(c?.n));
  const danger = need.some((c) => c.tone === "danger");
  return (
    <div className="sidebar__group" role="group" aria-label={label}>
      <button
        type="button"
        className="sidebar__group-label sidebar__group-toggle"
        aria-expanded={open}
        aria-disabled={here || undefined}
        onClick={() => !here && onToggle?.(groupKey)}
      >
        <span className="sidebar__group-text">{label}</span>
        {!open && need.length ? (
          <span
            className={`badge-dot badge-dot--${danger ? "danger" : "accent"}`}
            role="img"
            aria-label={danger ? "Something needs fixing" : "Something needs you"}
          />
        ) : null}
        {here ? null : <ChevronDown className="i i-xs sidebar__group-chev" aria-hidden />}
      </button>
      {open ? rows : null}
    </div>
  );
}

/** Marks the current sub-row of a section list for the address (`?tab=` on the section's page). */
function markSections(sections: readonly Section[], pathname: string, tab: string | null, fallback?: string, extra?: string): SubRow[] {
  const here = sections.length && pathname === sectionPath(sections[0]) ? sectionOf(sections, tab, fallback) : (extra ?? "");
  return sections.map((s) => ({ ...s, current: s.id === here }));
}

/** "{document} changed" when an answer of the conversation relies on a document that changed since (preview `sidebarRows`). */
function changedLine(conversation: Conversation): string {
  const changed = conversation.outdatedSources ?? [];
  if (changed.length > 1) return `${changed.length} sources changed`;
  return changed.length ? `${changed[0].displayName || "A source"} changed` : "";
}

/** One Recent row (preview `conv-nav`): the title, ⟳ when a source changed (its tooltip says which), ⋯ on hover. */
function RecentRow({ conversation, current }: { conversation: Conversation; current: boolean }) {
  const why = changedLine(conversation);
  return (
    <div className={clsx("conv-nav", current && "is-current")}>
      <Link className="nav-item conv-nav__link" href={`/chat/${resourceId(conversation.name ?? "")}`} aria-current={current ? "page" : undefined}>
        <span className="nav-item__label" translate="no">
          {conversationTitle(conversation)}
        </span>
        {why ? (
          <span className="conv-nav__stale" role="img" data-tip={why} aria-label={why}>
            <RefreshCw className="i i-xs" aria-hidden />
          </span>
        ) : null}
      </Link>
      <span className="conv-nav__more">
        <ConversationMenu conversation={conversation} />
      </span>
    </div>
  );
}

/**
 * Recent (preview `recentGroup`): your conversations, newest first, as the sidebar's last group — the open one is the
 * current row. Collapsible like Your work; not in the icon rail.
 */
function RecentGroup({ groups, onToggle }: { groups: Record<string, boolean>; onToggle: (key: string) => void }) {
  const pathname = usePathname();
  const conversations = useConversations().data ?? [];
  if (!conversations.length) return null;
  const open = groups.recent !== false;
  const openId = pathname.startsWith("/chat/") ? pathname.slice("/chat/".length) : null;
  return (
    <div className="sidebar__group sidebar__group--recent" role="group" aria-label="Recent">
      <button type="button" className="sidebar__group-label sidebar__group-toggle" aria-expanded={open} onClick={() => onToggle("recent")}>
        <span className="sidebar__group-text">Recent</span>
        <ChevronDown className="i i-xs sidebar__group-chev" aria-hidden />
      </button>
      {open
        ? conversations.map((c) => <RecentRow key={c.name} conversation={c} current={resourceId(c.name ?? "") === openId} />)
        : null}
    </div>
  );
}

function WorkspaceNav({ route, rail }: { route: RouteInfo; rail: boolean }) {
  const access = useWorkspace();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = params.get("tab");
  const badges = useNavBadges();
  const studio = useStudioSections();
  const [groups, toggle] = useNavGroups();
  const library = librarySections.filter((s) => s.id !== "files" || Boolean(access.member.personalCollection));
  const counts = (item: NavItem) => (item.badge ? badges.rows[item.badge] : undefined);

  const subs = (item: NavItem): SubRow[] => {
    const kind: NavSections | undefined = item.sections;
    if (kind === "library") return markSections(library, pathname, tab, "saved");
    if (kind === "studio") {
      const s = badges.sections.studio;
      const landing = studioLanding(studio, { documents: s.documents?.n, sources: s.sources?.n });
      const t = pathname === "/studio" ? (studioAddress(Object.fromEntries(params))?.tab ?? tab) : tab;
      const collection = pathname.startsWith("/studio/collections/") ? "collections" : undefined;
      return markSections(studio, pathname, t, landing, collection).map((r) => ({ ...r, count: s[r.id] }));
    }
    if (kind === "people") return markSections(peopleSections, pathname, tab).map((r) => ({ ...r, count: badges.sections.people[r.id] }));
    if (kind === "activity") return markSections(activitySections, pathname, tab);
    if (kind === "settings") return markSections(settingsSections, pathname, tab);
    return [];
  };

  return (
    <>
      <NavGroup label="Workspace" items={memberNav(access)} route={route} rail={rail} counts={counts} subs={subs} />
      <NavGroup
        groupKey="work"
        label="Your work"
        items={yourWorkNav(access, badges.hasContributions, projectsAvailable)}
        route={route}
        rail={rail}
        counts={counts}
        subs={subs}
        groups={groups}
        onToggle={toggle}
      />
      <NavGroup
        groupKey="manage"
        label="Manage"
        items={manageNav(access, studio.length > 0)}
        route={route}
        rail={rail}
        counts={counts}
        subs={subs}
        groups={groups}
        onToggle={toggle}
      />
      {rail ? null : <RecentGroup groups={groups} onToggle={toggle} />}
    </>
  );
}

/** Platform counts; only operators may read platform data. */
function OperatorPlatformNav({ route, rail }: { route: RouteInfo; rail: boolean }) {
  return <PlatformNav route={route} rail={rail} badges={usePlatformNavBadges()} />;
}

interface PlatformBadges {
  indexing?: number;
  health?: number;
  failedJobs?: number;
  workspaces?: number;
}

function PlatformNav({ route, rail, badges = {} }: { route: RouteInfo; rail: boolean; badges?: PlatformBadges }) {
  const { current } = useShellWorkspaces(true);
  const pathname = usePathname();
  const tab = useSearchParams().get("tab");
  const danger = (n?: number): Count | undefined => (n ? { n, tone: "danger" } : undefined);
  const counts = (item: NavItem): Count | undefined =>
    item.badge === "indexing"
      ? danger(badges.indexing)
      : item.badge === "health"
        ? danger(badges.health)
        : item.badge === "platformWorkspaces" && badges.workspaces
          ? { n: badges.workspaces, tone: "accent" }
          : undefined;
  const subs = (item: NavItem): SubRow[] =>
    item.sections === "indexing"
      ? markSections(indexingSections, pathname, tab).map((r) => ({
          ...r,
          count: r.id === "workspaces" ? danger(badges.indexing) : r.id === "jobs" ? danger(badges.failedJobs) : undefined,
        }))
      : [];
  const back: NavItem | null = current ? { id: "back", label: `Back to ${current.displayName}`, icon: ArrowLeft, href: "/home" } : null;
  return (
    <>
      <NavGroup label="Console" items={[...PLATFORM_NAV]} route={route} rail={rail} counts={counts} subs={subs} />
      {back ? <NavGroup label="Workspace" items={[back]} route={route} rail={rail} counts={() => undefined} subs={() => []} /> : null}
    </>
  );
}

/**
 * The sidebar's tooltips (preview `data-tip`): one floating label beside the hovered or focused element — the rail's rows
 * and controls, and Recent's ⟳ marks.
 */
function useSidebarTip(rail: boolean) {
  const [tip, setTip] = useState<{ label: string; top: number; left: number } | null>(null);
  const show = (e: MouseEvent | FocusEvent) => {
    const el = (e.target as Element).closest<HTMLElement>("[data-tip]");
    if (!el) return setTip(null);
    const r = el.getBoundingClientRect();
    setTip({ label: el.dataset.tip ?? "", top: r.top + r.height / 2, left: r.right + 8 });
  };
  const hide = () => setTip(null);
  useEffect(() => setTip(null), [rail]);
  const node =
    tip && typeof document !== "undefined"
      ? createPortal(
          <div className="rail-tip" role="presentation" style={{ top: tip.top, left: tip.left }}>
            {tip.label}
          </div>,
          document.body,
        )
      : null;
  return { node, handlers: { onMouseOver: show, onFocus: show, onMouseLeave: hide, onBlur: hide } };
}

export interface SidebarProps {
  mode: ShellMode;
  route: RouteInfo;
  /** Desktop, collapsed to the 56 px icon rail. */
  rail: boolean;
  /** Below 1024 px: the sidebar is off-canvas. */
  narrow: boolean;
  /** Off-canvas and closed: out of the tab order and the accessibility tree. */
  hidden: boolean;
  onToggle: () => void;
}

/** Permission-aware sidebar (preview `sidebar()`): one shell for every persona and workspace template. */
export function Sidebar({ mode, route, rail, narrow, hidden, onToggle }: SidebarProps) {
  const operator = isPlatformOperator(useSession());
  const tip = useSidebarTip(rail);
  const toggleLabel = narrow ? "Close sidebar" : rail ? "Expand sidebar" : "Collapse sidebar";
  return (
    <aside className={clsx("sidebar", rail && "is-rail")} id="sidebar" aria-label="Main navigation" inert={hidden} {...tip.handlers}>
      <div className="sidebar__header">
        <WorkspaceMenu mode={mode} />
        <span className="sidebar__toggle" data-tip={rail ? toggleLabel : undefined}>
          <IconButton
            icon={narrow ? X : PanelLeft}
            tip={toggleLabel}
            showTip={!rail}
            size="sm"
            onPress={onToggle}
            className="sidebar__toggle-button"
            id="sidebar-toggle"
            ariaExpanded={!rail}
            ariaControls="sidebar"
            ariaKeyShortcuts={narrow ? undefined : "Meta+Backslash Control+Backslash"}
          />
        </span>
      </div>
      <div className="sidebar__search">
        <button
          type="button"
          className="side-search"
          id="side-search"
          aria-label="Search anything (⌘K)"
          aria-keyshortcuts="Meta+K"
          data-tour="search"
          data-tip={rail ? "Search (⌘K)" : undefined}
          onClick={() => openCommandPalette()}
        >
          <Search className="i" aria-hidden />
          <span className="side-search__label">Search anything…</span>
          <Kbd>⌘K</Kbd>
        </button>
      </div>
      <nav className="sidebar__content" aria-label="Pages">
        {mode === "workspace" ? (
          <WorkspaceNav route={route} rail={rail} />
        ) : operator ? (
          <OperatorPlatformNav route={route} rail={rail} />
        ) : (
          <PlatformNav route={route} rail={rail} />
        )}
      </nav>
      <div className="sidebar__footer">
        <AccountMenu mode={mode} />
      </div>
      {tip.node}
    </aside>
  );
}
