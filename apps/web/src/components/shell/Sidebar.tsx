"use client";

import { Button, Tooltip } from "@heroui/react";
import { ArrowLeft, Search } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { resourceId } from "@/lib/api/client";
import {
  isNavItemActive,
  manageNav,
  memberNav,
  PLATFORM_NAV,
  SPACES_NAV,
  type NavBadge,
  type NavItem,
  type RouteInfo,
  type ShellMode,
} from "@/lib/navigation";
import { isPlatformOperator, useSession } from "@/lib/session";
import { useWorkspace } from "@/lib/workspace";
import { usePlatformNavBadges } from "@/modules/platform/queries";
import { SidebarConversations } from "@/modules/projects/components/SidebarConversations";
import { spaceColor, useMySpaces } from "@/modules/spaces";

import { AccountMenu } from "./AccountMenu";
import { useNavBadges } from "./badges";
import { openCommandPalette } from "./overlays";
import { useShellWorkspaces, WorkspaceMenu } from "./WorkspaceMenu";

const SIDEBAR_SPACES = 8;

function NavLink({ item, active, count }: { item: NavItem; active: boolean; count?: number }) {
  const Icon = item.icon;
  return (
    <Link className="nav-item" href={item.href} aria-current={active ? "page" : undefined}>
      <Icon className="i" aria-hidden />
      <span className="nav-item__label">{item.label}</span>
      {count ? (
        <span className={item.alert ? "badge badge--danger" : "badge"} aria-label={`${count} need attention`}>
          {count}
        </span>
      ) : null}
    </Link>
  );
}

/** Spaces the caller belongs to (preview `mySpaces()`); shares the Spaces module's list cache. */
function SpacesGroup({ route }: { route: RouteInfo }) {
  const pathname = usePathname();
  const { data } = useMySpaces();
  const mine = (data ?? []).slice(0, SIDEBAR_SPACES);
  return (
    <div className="sidebar__group">
      <div className="sidebar__group-label">
        <span>Spaces</span>
        <Link href={SPACES_NAV.href} aria-current={route.nav === "spaces" ? "page" : undefined}>
          All
        </Link>
      </div>
      {data && !mine.length ? (
        <Link className="nav-item nav-item--recent" href={SPACES_NAV.href}>
          <span className="nav-item__label">Find or create a space</span>
        </Link>
      ) : (
        mine.map((s) => {
          const href = `/space/${resourceId(s.name)}`;
          return (
            <Link key={s.name} className="nav-item" href={href} aria-current={pathname === href ? "page" : undefined} title={s.displayName}>
              <span className="space-dot" style={{ background: spaceColor(s) }} aria-hidden />
              <span className="nav-item__label" translate="no">
                {s.displayName}
              </span>
            </Link>
          );
        })
      )}
    </div>
  );
}

function WorkspaceNav({ route }: { route: RouteInfo }) {
  const access = useWorkspace();
  const badges = useNavBadges();
  const manage = manageNav(access);
  const count = (b?: NavBadge) => (b ? badges[b] : undefined);
  return (
    <>
      <div className="sidebar__group">
        {memberNav(access).map((item) => (
          <NavLink key={item.id} item={item} active={isNavItemActive(item, route)} count={count(item.badge)} />
        ))}
      </div>
      <SidebarConversations />
      {access.hasModule("spaces") && <SpacesGroup route={route} />}
      {manage.length > 0 && (
        <div className="sidebar__group">
          <div className="sidebar__group-label">Manage</div>
          {manage.map((item) => (
            <NavLink key={item.id} item={item} active={isNavItemActive(item, route)} count={count(item.badge)} />
          ))}
        </div>
      )}
    </>
  );
}

/** Indexing and health counts; only operators may read platform data. */
function OperatorPlatformNav({ route }: { route: RouteInfo }) {
  return <PlatformNav route={route} badges={usePlatformNavBadges()} />;
}

function PlatformNav({ route, badges = {} }: { route: RouteInfo; badges?: { indexing?: number; health?: number } }) {
  const { current } = useShellWorkspaces(true);
  return (
    <>
      <div className="sidebar__group">
        {PLATFORM_NAV.map((item) => (
          <NavLink
            key={item.id}
            item={item}
            active={isNavItemActive(item, route)}
            count={item.badge === "indexing" || item.badge === "health" ? badges[item.badge] : undefined}
          />
        ))}
      </div>
      {current && (
        <div className="sidebar__group">
          <div className="sidebar__group-label">Workspace</div>
          <Link className="nav-item" href="/home">
            <ArrowLeft className="i" aria-hidden />
            <span className="nav-item__label">
              Back to <span translate="no">{current.displayName}</span>
            </span>
          </Link>
        </div>
      )}
    </>
  );
}

/** Permission-aware sidebar (preview `sidebar()`): one shell for every persona and workspace template. */
export function Sidebar({ mode, route }: { mode: ShellMode; route: RouteInfo }) {
  const operator = isPlatformOperator(useSession());
  return (
    <aside className="sidebar" aria-label="Main navigation">
      <div className="sidebar__header">
        <WorkspaceMenu mode={mode} />
        <Tooltip>
          <Button isIconOnly size="sm" variant="ghost" className="button--muted" aria-label="Search  ⌘K" data-tour="search" onPress={() => openCommandPalette()}>
            <Search className="i" aria-hidden />
          </Button>
          <Tooltip.Content>Search ⌘K</Tooltip.Content>
        </Tooltip>
      </div>
      <nav className="sidebar__content">
        {mode === "workspace" ? (
          <WorkspaceNav route={route} />
        ) : operator ? (
          <OperatorPlatformNav route={route} />
        ) : (
          <PlatformNav route={route} />
        )}
      </nav>
      <div className="sidebar__footer">
        <AccountMenu mode={mode} />
      </div>
    </aside>
  );
}
