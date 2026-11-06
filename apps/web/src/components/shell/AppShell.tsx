"use client";

import clsx from "clsx";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { useLanguage } from "@/lib/i18n";
import { matchRoute, routeGate, type RouteInfo, type ShellMode } from "@/lib/navigation";
import { useWorkspace } from "@/lib/workspace";
import { ContributeHost, KnowledgeDialogsHost } from "@/modules/knowledge/components/hosts";

import { AppearanceDrawer } from "./AppearanceDrawer";
import { CommandPalette } from "./CommandPalette";
import { ModuleOff } from "./ModuleOff";
import { NoAccess } from "./NoAccess";
import { closeOverlay, openCommandPalette, useShellOverlays } from "./overlays";
import { PageChromeProvider } from "./page-chrome";
import { PreferencesDialog } from "./PreferencesDialog";
import { usePreferencesSync } from "./preferences";
import { ProductTour } from "./ProductTour";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

const COLLAPSED_KEY = "bomesh.sidebarCollapsed";
/** Below this width the sidebar is an off-canvas sheet (layout.css `@container app (max-width: 1023px)`). */
const OFF_CANVAS = 1024;

/** Workspace routes the caller may not open, or whose module is off, render a state instead of the page. */
function WorkspaceGate({ route, children }: { route: RouteInfo; children: ReactNode }) {
  const access = useWorkspace();
  const gate = routeGate(route, access);
  if (gate === "permission") return <NoAccess />;
  if (gate === "module" && route.module) return <ModuleOff module={route.module} />;
  return <>{children}</>;
}

/**
 * The app shell (preview `render()` for workspace and platform modes):
 * sidebar, topbar and the scrolling main area, plus the shell overlays.
 * Collapsible on desktop; off-canvas with a backdrop below 1024 px.
 */
export function AppShell({ mode, children }: { mode: Exclude<ShellMode, "auth">; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const route = matchRoute(pathname);
  const overlays = useShellOverlays();
  const [collapsed, setCollapsed] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  usePreferencesSync();
  const [language] = useLanguage();

  useEffect(() => {
    setCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === "1");
  }, []);

  // A new address closes the off-canvas sidebar and any shell overlay (preview render on path change).
  useEffect(() => {
    setNavOpen(false);
    closeOverlay();
    document.getElementById("scroll")?.scrollTo({ top: 0 });
  }, [pathname]);

  useEffect(() => {
    document.title = `${route.title} · BoMesh`;
  }, [route.title]);

  const toggleNav = useCallback(() => {
    if (document.body.clientWidth < OFF_CANVAS) setNavOpen((open) => !open);
    else
      setCollapsed((c) => {
        window.localStorage.setItem(COLLAPSED_KEY, c ? "0" : "1");
        return !c;
      });
  }, []);
  const closeNav = useCallback(() => setNavOpen(false), []);

  // ⌘K search, ⌘⇧O new chat, Escape closes the off-canvas sidebar.
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
      if (e.key === "Escape" && navOpen && !overlays.open) setNavOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [overlays.open, navOpen, mode, router]);

  return (
    <PageChromeProvider>
      <div className={clsx("app", collapsed && "is-collapsed", navOpen && "is-nav-open")}>
        <Sidebar mode={mode} route={route} />
        <main className="main" id="main">
          <Topbar route={route} onToggleNav={toggleNav} />
          {/* Keyed by language: pages re-render their counts and dates (`plural`, `rel`, `fmtDate`) in the new
              language, and switching back to English leaves nothing Vietnamese behind. Overlays keep their state. */}
          <div key={language} className={clsx("main__scroll", route.bare && "main__scroll--bare")} id="scroll">
            {mode === "workspace" ? <WorkspaceGate route={route}>{children}</WorkspaceGate> : children}
          </div>
        </main>
        {navOpen && <div className="sidebar-backdrop" onClick={closeNav} aria-hidden />}
      </div>
      <CommandPalette mode={mode} />
      <PreferencesDialog />
      <AppearanceDrawer />
      <ShortcutsDialog />
      {mode === "workspace" && (
        <>
          <ProductTour onStart={closeNav} />
          <ContributeHost />
          <KnowledgeDialogsHost />
        </>
      )}
    </PageChromeProvider>
  );
}
