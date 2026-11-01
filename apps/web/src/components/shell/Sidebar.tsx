"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, PanelLeft } from "lucide-react";
import { useRef } from "react";

import { AccountMenu } from "@/components/shell/AccountMenu";
import { RailTip } from "@/components/shell/RailTip";
import { useCurrentWorkspace, type WorkspaceAttention } from "@/components/shell/useCurrentWorkspace";
import { WorkspaceMenu } from "@/components/shell/WorkspaceMenu";
import { Kbd } from "@/components/ui/Kbd";
import { isPendingFeatureEnabled } from "@/lib/api/pending";
import { useModalLayer } from "@/lib/hooks/useModalLayer";
import {
  MANAGE_NAV,
  PLATFORM_NAV,
  WORKSPACE_NAV,
  isNavItemActive,
  visibleNavItems,
  type NavBadge,
  type NavItem,
} from "@/lib/navigation";
import { useConversationList } from "@/modules/chat/hooks/useConversationList";

const RECENT_LIMIT = 12;

export interface SidebarProps {
  platform: boolean;
  /** The ≤1100px icon rail is showing (not expanded as an overlay). */
  railCollapsed: boolean;
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  onOpenPalette: () => void;
  onOpenInbox: () => void;
  inboxOpen: boolean;
  inboxUnread: number;
  onOpenPreferences: () => void;
  onOpenShortcuts: () => void;
  onStartTour: () => void;
}

function badgeCount(badge: NavBadge | undefined, attention: WorkspaceAttention, inboxUnread: number): number {
  if (badge === "inbox") return inboxUnread;
  return badge ? attention[badge] : 0;
}

/** The accessible name a nav row reads with, and the rail tooltip it shows. */
function itemName(item: NavItem, count: number): string {
  if (!count) return item.label;
  if (item.badge === "inbox") return `${item.label}, ${count} unread`;
  if (item.badge === "outages") return `${item.label}, ${count} not operational`;
  return `${item.label}, ${count} need${count === 1 ? "s" : ""} attention`;
}

/**
 * The one product sidebar (prototype `sidebar()`): workspace switcher, New
 * chat, Inbox, Search, Knowledge, the Manage items the caller may open,
 * recent chats and the account menu. In the platform console the same rail
 * lists platform items and offers the way back to the workspace.
 */
export function Sidebar(props: SidebarProps) {
  const { platform, railCollapsed, expanded, onExpand, onCollapse } = props;
  const pathname = usePathname();
  const { session, workspace, attention } = useCurrentWorkspace();
  const panelRef = useRef<HTMLElement | null>(null);

  // Expanded over the page (tablet/phone): Escape closes it and focus returns to the opener.
  useModalLayer({ open: expanded, onClose: onCollapse, panelRef, initialFocusRef: false, modal: false });

  const manage = visibleNavItems(MANAGE_NAV, session, isPendingFeatureEnabled);
  const backHref = manage[0]?.href ?? "/chat";

  const row = (item: NavItem) => {
    const count = badgeCount(item.badge, attention, props.inboxUnread);
    const name = itemName(item, count);
    const Icon = item.icon;
    const content = (
      <>
        <Icon aria-hidden="true" />
        <span className="side-grow hide-collapsed truncate">{item.label}</span>
        {item.shortcut && <Kbd className="hide-collapsed">{item.shortcut}</Kbd>}
        {count > 0 && (
          <span aria-hidden="true" className="nav-count" data-tone={item.badge === "inbox" ? "quiet" : undefined}>
            {count}
          </span>
        )}
      </>
    );
    if (item.id === "search" || item.id === "inbox") {
      const open = item.id === "inbox" ? props.inboxOpen : false;
      return (
        <RailTip enabled={railCollapsed} key={item.id} label={name}>
          <button
            aria-expanded={item.id === "inbox" ? open : undefined}
            aria-haspopup="dialog"
            aria-label={name}
            className="nav-item"
            data-tour={item.id}
            onClick={item.id === "inbox" ? props.onOpenInbox : props.onOpenPalette}
            type="button"
          >
            {content}
          </button>
        </RailTip>
      );
    }
    return (
      <RailTip enabled={railCollapsed} key={item.id} label={name}>
        <Link
          aria-current={isNavItemActive(item, pathname) ? "page" : undefined}
          aria-label={name}
          className={item.id === "new-chat" ? "new-chat" : "nav-item"}
          data-tour={item.id}
          href={item.href ?? "/"}
          onClick={expanded ? onCollapse : undefined}
        >
          {content}
        </Link>
      </RailTip>
    );
  };

  return (
    <>
      <button
        aria-hidden="true"
        className="app-scrim"
        data-open={expanded ? "" : undefined}
        onClick={onCollapse}
        tabIndex={-1}
        type="button"
      />
      <nav aria-label="Main" className="side" data-expanded={expanded ? "" : undefined} ref={panelRef}>
        <WorkspaceMenu collapsed={railCollapsed} platform={platform} />

        <RailTip className="only-collapsed" enabled={railCollapsed} label="Expand sidebar">
          <button aria-expanded={false} aria-label="Expand sidebar" className="nav-item" onClick={onExpand} type="button">
            <PanelLeft aria-hidden="true" />
          </button>
        </RailTip>

        {platform ? (
          <>
            {visibleNavItems(PLATFORM_NAV, session, isPendingFeatureEnabled).map(row)}
            <div className="side-spacer" />
            <RailTip enabled={railCollapsed} label={`Back to ${workspace?.name ?? "workspace"}`}>
              <Link aria-label={`Back to ${workspace?.name ?? "workspace"}`} className="nav-item" href={backHref} onClick={expanded ? onCollapse : undefined}>
                <ArrowLeft aria-hidden="true" />
                <span className="side-grow hide-collapsed truncate">Back to {workspace?.name ?? "workspace"}</span>
              </Link>
            </RailTip>
          </>
        ) : (
          <>
            {visibleNavItems(WORKSPACE_NAV, session, isPendingFeatureEnabled).map(row)}
            {manage.length > 0 && (
              <>
                <div className="nav-label"><span className="hide-collapsed">Manage</span></div>
                {manage.map(row)}
              </>
            )}
            <RecentChats onNavigate={expanded ? onCollapse : undefined} pathname={pathname} />
            <div className="side-spacer only-collapsed" />
          </>
        )}

        <div className="side-foot">
          <AccountMenu
            collapsed={railCollapsed}
            onOpenPreferences={props.onOpenPreferences}
            onOpenShortcuts={props.onOpenShortcuts}
            onStartTour={props.onStartTour}
          />
        </div>
      </nav>
    </>
  );
}

/** The newest chats on this device (conversation_loop.md: chats are not synced across devices). */
function RecentChats({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  const { conversations, loading } = useConversationList();
  const recent = conversations.slice(0, RECENT_LIMIT);
  return (
    <>
      <div className="nav-label hide-collapsed">
        <span id="recent-chats-label">Recent chats</span>
        <Link aria-current={pathname === "/chats" ? "page" : undefined} href="/chats" onClick={onNavigate}>View all</Link>
      </div>
      <div aria-labelledby="recent-chats-label" className="recents hide-collapsed" role="list">
        {recent.map((conversation) => (
          <div key={conversation.id} role="listitem">
            <Link
              aria-current={pathname === `/chat/${conversation.id}` ? "page" : undefined}
              className="recent"
              href={`/chat/${conversation.id}`}
              onClick={onNavigate}
              title={conversation.title}
            >
              {conversation.title}
            </Link>
          </div>
        ))}
        {!loading && recent.length === 0 && (
          <p className="px-2.5 py-1.5 text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">Your chats will appear here.</p>
        )}
      </div>
    </>
  );
}
