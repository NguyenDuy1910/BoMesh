"use client";

import { ArrowLeft, ChevronRight, Menu, Search } from "lucide-react";
import Link from "next/link";
import { Fragment } from "react";

import { IconButton } from "@/components/ui/IconButton";
import type { RouteInfo, ShellMode } from "@/lib/navigation";
import { InboxBell } from "@/modules/inbox";

import { openCommandPalette } from "./overlays";
import { usePageChrome } from "./page-chrome";

export interface CompactHeaderProps {
  mode: Exclude<ShellMode, "auth">;
  route: RouteInfo;
  /** The off-canvas sidebar is open (below 1024 px). */
  navOpen: boolean;
  onToggleNav: () => void;
}

/**
 * CompactHeader (preview `topbar()`): the app's one 48 px top row, its inner row aligned with the page column.
 * Left: the menu button (off-canvas only), then the page's context — Back on phones for sub-pages, its parents as a
 * quiet trail, its title (the page's H1 for index pages; entity and reading pages carry their own H1, so the title
 * peeks in once that header scrolls away: `is-past-hero` on `#main`), its chips and a short status line.
 * Right: the page's actions (compact; icon-only on phones), then search (only while the sidebar is off-canvas) and Inbox.
 */
export function CompactHeader({ mode, route, navOpen, onToggleNav }: CompactHeaderProps) {
  const chrome = usePageChrome();
  const list = chrome.crumbs ?? [];
  // The last crumb without a link is the current page; the rest are parents.
  const parents = list.length && !list[list.length - 1].href ? list.slice(0, -1) : list;
  const title = chrome.title || (list.length && !list[list.length - 1].href ? list[list.length - 1].label : "") || route.title;
  const own = !chrome.hero;
  const near = [...parents].reverse().find((c) => c.href);

  return (
    <header className="topbar">
      <div className="topbar__inner">
        <IconButton
          icon={Menu}
          tip="Open sidebar"
          showTip={false}
          size="sm"
          className="topbar__menu"
          id="topbar-menu"
          ariaControls="sidebar"
          ariaExpanded={navOpen}
          onPress={onToggleNav}
        />
        <div className="topbar__context">
          {near?.href ? (
            <Link className="button button--ghost button--icon-only button--sm button--muted topbar__back" href={near.href} aria-label={`Back to ${near.label}`}>
              <ArrowLeft className="i" aria-hidden />
            </Link>
          ) : null}
          {parents.length ? (
            <nav className="topbar__trail" aria-label="Breadcrumb">
              {parents.map((c, i) => (
                <Fragment key={`${i}:${c.label}`}>
                  {c.href ? (
                    <Link className="topbar__crumb" href={c.href}>
                      {c.label}
                    </Link>
                  ) : (
                    <span className="topbar__crumb">{c.label}</span>
                  )}
                  <ChevronRight className="i i-xs topbar__chev" aria-hidden />
                </Fragment>
              ))}
            </nav>
          ) : null}
          {title ? (
            own ? (
              <h1 className="topbar__title truncate">{title}</h1>
            ) : (
              <span className="topbar__title topbar__title--peek truncate" aria-hidden translate="no">
                {title}
              </span>
            )
          ) : null}
          {own && chrome.extra ? <span className="topbar__extra">{chrome.extra}</span> : null}
          {own && chrome.meta ? <span className="topbar__meta truncate">{chrome.meta}</span> : null}
        </div>
        <div className="topbar__end" id="topbar-end">
          {chrome.actions ? <div className="topbar__actions">{chrome.actions}</div> : null}
          <div className="topbar__global">
            <IconButton
              icon={Search}
              tip="Search anything"
              size="sm"
              className="topbar-search"
              id="topbar-search"
              ariaKeyShortcuts="Meta+K"
              onPress={() => openCommandPalette()}
            />
            {mode === "workspace" ? <InboxBell /> : null}
          </div>
        </div>
      </div>
    </header>
  );
}
