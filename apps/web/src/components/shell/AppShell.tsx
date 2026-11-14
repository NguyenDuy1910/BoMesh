"use client";

import clsx from "clsx";
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { useLanguage } from "@/lib/i18n";
import { useOpened } from "@/lib/lazy";
import { matchRoute, routeGate, studioSections, type RouteInfo, type ShellMode } from "@/lib/navigation";
import { useSession } from "@/lib/session";
import { useOptionalWorkspace, useWorkspace } from "@/lib/workspace";
import { closeInbox } from "@/modules/inbox";
import { ContributeHost, DocumentPreviewHost, KnowledgeDialogsHost } from "@/modules/knowledge/components/hosts";

import { ModuleOff } from "./ModuleOff";
import { NoAccess } from "./NoAccess";
import { closeOverlay, openCommandPalette, useShellOverlays } from "./overlays";
import { useStudioAccess } from "./badges";
import { CompactHeader } from "./CompactHeader";
import { PageChromeProvider, usePageChrome } from "./page-chrome";
import { usePreferencesSync } from "./preferences";
import { Sidebar } from "./Sidebar";
import { useTourAutoStart } from "./tour";

/* Shell overlays load on first open (none is on screen at first paint); `useOpened` keeps them mounted afterwards so they animate closed. */
const CommandPalette = dynamic(() => import("./CommandPalette").then((m) => m.CommandPalette), { ssr: false });
const PreferencesDialog = dynamic(() => import("./PreferencesDialog").then((m) => m.PreferencesDialog), { ssr: false });
const AppearanceDrawer = dynamic(() => import("./AppearanceDrawer").then((m) => m.AppearanceDrawer), { ssr: false });
const ShortcutsDialog = dynamic(() => import("./ShortcutsDialog").then((m) => m.ShortcutsDialog), { ssr: false });
const ProductTour = dynamic(() => import("./ProductTour").then((m) => m.ProductTour), { ssr: false });

const COLLAPSED_KEY = "bomesh.sidebarCollapsed";
/** Below this width the sidebar is an off-canvas sheet (layout.css `@container app (max-width: 1023px)`). */
const OFF_CANVAS = 1024;
/** Scrollers that carry a page's content (most pages scroll #scroll; chat, work items and the reader scroll their own pane). */
const PAGE_SCROLLERS = "#scroll, #chat-scroll, #work-scroll, #rdr-scroll";

/**
 * CompactHeader state from the page's scroll (preview `syncHeader`): `is-scrolled` once content passes under the top row
 * (a hairline unless a sticky ContextualToolbar sits right below it), `is-past-hero` once an entity page's identity block
 * (`#page-hero`) has left the view (the top row then shows its title). Pages without a hero (the Reader) set it themselves.
 */
function syncHeader() {
  const main = document.getElementById("main");
  if (!main) return;
  main.classList.toggle("is-scrolled", [...document.querySelectorAll(PAGE_SCROLLERS)].some((s) => s.scrollTop > 2));
  const hero = document.getElementById("page-hero");
  const sc = hero?.closest("[data-keep-scroll]");
  if (!hero || !sc) return;
  main.classList.toggle("is-past-hero", hero.getBoundingClientRect().bottom <= sc.getBoundingClientRect().top + 8);
}

/** Workspace routes the caller may not open, or whose module is off, render a state instead of the page. */
function WorkspaceGate({ route, children }: { route: RouteInfo; children: ReactNode }) {
  const access = useWorkspace();
  const studio = useStudioAccess();
  const gate = routeGate(route, access);
  if (gate === "permission") return <NoAccess />;
  if (gate === "module" && route.module) return <ModuleOff module={route.module} />;
  // Knowledge Studio has no single permission: it opens for whoever has at least one of its sections.
  if (route.nav === "studio" && !studio.pending && !studioSections(studio).length) return <NoAccess />;
  return <>{children}</>;
}

/**
 * The app shell (preview `render()` for workspace and platform modes): sidebar, the CompactHeader and the scrolling main
 * area, plus the shell overlays. Desktop: expanded or a 56 px icon rail (⌘\, remembered); below 1024 px the sidebar is
 * off-canvas with a backdrop, Escape closes it and focus stays on the control that toggles it.
 */
function Shell({ mode, children }: { mode: Exclude<ShellMode, "auth">; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const route = matchRoute(pathname);
  const chrome = usePageChrome();
  const overlays = useShellOverlays();
  const paletteOpened = useOpened(overlays.open === "palette");
  const preferencesOpened = useOpened(overlays.open === "preferences");
  const appearanceOpened = useOpened(overlays.open === "appearance");
  const shortcutsOpened = useOpened(overlays.open === "shortcuts");
  const [collapsed, setCollapsed] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const toggled = useRef(false);
  usePreferencesSync();
  const [language] = useLanguage();
  const ws = useOptionalWorkspace();
  const user = useSession()?.user.name;
  useTourAutoStart(pathname, mode === "workspace" ? user : undefined, ws?.id);

  useEffect(() => {
    setCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === "1");
    const measure = () => setNarrow(document.body.clientWidth < OFF_CANVAS);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // A new address closes the off-canvas sidebar, any shell overlay and the Inbox, and starts at the top.
  useEffect(() => {
    setNavOpen(false);
    closeOverlay();
    closeInbox();
    document.getElementById("scroll")?.scrollTo({ top: 0 });
    document.getElementById("main")?.classList.remove("is-scrolled", "is-past-hero");
  }, [pathname]);

  useEffect(() => {
    const onScroll = (e: Event) => {
      if ((e.target as Element).matches?.(PAGE_SCROLLERS)) syncHeader();
    };
    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, []);

  const title = chrome.title || route.title;
  useEffect(() => {
    document.title = `${title} · BoMesh`;
  }, [title]);

  // Focus stays on the control that toggles the sidebar: its own button when it opens, the menu button when it closes.
  useEffect(() => {
    if (!toggled.current) return;
    toggled.current = false;
    document.getElementById(narrow && !navOpen ? "topbar-menu" : "sidebar-toggle")?.focus();
  }, [navOpen, collapsed, narrow]);

  const toggleNav = useCallback(() => {
    toggled.current = true;
    if (document.body.clientWidth < OFF_CANVAS) setNavOpen((open) => !open);
    else
      setCollapsed((c) => {
        window.localStorage.setItem(COLLAPSED_KEY, c ? "0" : "1");
        return !c;
      });
  }, []);
  const closeNav = useCallback(() => {
    toggled.current = true;
    setNavOpen(false);
  }, []);

  // ⌘K search, ⌘⇧O new chat, ⌘\ sidebar, Escape closes the off-canvas sidebar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && k === "k") {
        e.preventDefault();
        if (overlays.open === "palette") closeOverlay();
        else openCommandPalette();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && k === "o") {
        e.preventDefault();
        if (mode === "workspace") router.push("/chat");
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        if (!overlays.open) toggleNav();
        return;
      }
      if (e.key === "Escape" && navOpen && !overlays.open && !e.defaultPrevented) closeNav();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [overlays.open, navOpen, mode, router, toggleNav, closeNav]);

  const rail = collapsed && !narrow;
  return (
    <>
      <div className={clsx("app", rail && "is-collapsed", navOpen && "is-nav-open")}>
        <Sidebar mode={mode} route={route} rail={rail} narrow={narrow} hidden={narrow && !navOpen} onToggle={toggleNav} />
        <main className="main" id="main">
          <CompactHeader mode={mode} route={route} navOpen={navOpen} onToggleNav={toggleNav} />
          {/* Keyed by language: pages re-render their counts and dates (`plural`, `rel`, `fmtDate`) in the new
              language, and switching back to English leaves nothing Vietnamese behind. Overlays keep their state. */}
          <div key={language} className={clsx("main__scroll", route.bare && "main__scroll--bare")} id="scroll" data-keep-scroll>
            {mode === "workspace" ? <WorkspaceGate route={route}>{children}</WorkspaceGate> : children}
          </div>
        </main>
        {navOpen && <div className="sidebar-backdrop" onClick={closeNav} aria-hidden />}
      </div>
      {paletteOpened && <CommandPalette mode={mode} />}
      {preferencesOpened && <PreferencesDialog />}
      {appearanceOpened && <AppearanceDrawer />}
      {shortcutsOpened && <ShortcutsDialog />}
      {mode === "workspace" && (
        <>
          {overlays.tour != null && <ProductTour onStart={closeNav} />}
          <ContributeHost />
          <KnowledgeDialogsHost />
          <DocumentPreviewHost />
        </>
      )}
    </>
  );
}

/** The shell with the page-chrome store its pages declare their header into. */
export function AppShell({ mode, children }: { mode: Exclude<ShellMode, "auth">; children: ReactNode }) {
  return (
    <PageChromeProvider>
      <Shell mode={mode}>{children}</Shell>
    </PageChromeProvider>
  );
}
