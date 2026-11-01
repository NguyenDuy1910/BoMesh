"use client";

import { Menu as MenuIcon, Plus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { PaletteProvider } from "@/components/shell/CommandPalette";
import { InboxDrawer, useInbox } from "@/components/shell/InboxDrawer";
import { PreferencesDialog } from "@/components/shell/PreferencesDialog";
import { ProductTour, useFirstRunTour } from "@/components/shell/ProductTour";
import { ShortcutsDialog } from "@/components/shell/ShortcutsDialog";
import { Sidebar } from "@/components/shell/Sidebar";
import { usePalette } from "@/components/shell/usePalette";
import { useCurrentWorkspace, WorkspaceProvider } from "@/components/shell/useCurrentWorkspace";
import { WorkspaceMark } from "@/components/patterns/WorkspaceMark";
import { ButtonLink, Button } from "@/components/ui/Button";
import { ToastProvider } from "@/components/ui/Toast";
import { APPEARANCE_CHANGE_EVENT } from "@/lib/appearance";
import { isPlatformPath } from "@/lib/navigation";

const RAIL_QUERY = "(max-width: 1100px)";

function subscribeRail(onChange: () => void) {
  const query = window.matchMedia(RAIL_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Pages that fill the sheet edge to edge and own their scrolling (chat, the document reader). */
function isBarePath(pathname: string): boolean {
  return pathname === "/chat" || pathname.startsWith("/chat/") || pathname.startsWith("/documents/");
}

/**
 * The one product shell (prototype `#app`): the canvas, the sidebar and the
 * rounded sheet every page renders on. Route children replace only the sheet;
 * the sidebar, palette, inbox, dialogs and toasts stay mounted.
 */
export function ProductShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const platform = isPlatformPath(pathname);
  return (
    <WorkspaceProvider>
      <ToastProvider>
        <PaletteProvider platform={platform}>
          <ShellFrame platform={platform} pathname={pathname}>{children}</ShellFrame>
        </PaletteProvider>
      </ToastProvider>
    </WorkspaceProvider>
  );
}

type Layer = "preferences" | "shortcuts" | null;

function ShellFrame({ children, platform, pathname }: { children: React.ReactNode; platform: boolean; pathname: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const palette = usePalette();
  const { workspace } = useCurrentWorkspace();
  const narrow = useSyncExternalStore(subscribeRail, () => window.matchMedia(RAIL_QUERY).matches, () => false);
  const [expanded, setExpanded] = useState(false);
  const [layer, setLayer] = useState<Layer>(null);
  const [preferencesSection, setPreferencesSection] = useState<"profile" | "notifications">("profile");
  const [inboxOpen, setInboxOpen] = useState(false);
  const inbox = useInbox();
  const tour = useFirstRunTour();

  // Leaving the narrow layout or moving to another page closes the overlay rail.
  useEffect(() => {
    if (!narrow) setExpanded(false);
  }, [narrow]);
  useEffect(() => {
    setExpanded(false);
  }, [pathname]);

  // `?action=search` on any product route opens the palette, then leaves the address.
  const action = searchParams.get("action");
  useEffect(() => {
    if (action !== "search") return;
    const next = new URLSearchParams(searchParams.toString());
    next.delete("action");
    const query = next.get("q") ?? "";
    if (pathname !== "/chat") next.delete("q");
    palette.open(query);
    router.replace(next.size ? `${pathname}?${next}` : pathname, { scroll: false });
  }, [action, palette, pathname, router, searchParams]);

  // ⌘⇧O starts a new chat (prototype shortcut list).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        router.push("/chat");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  // The "Workspace brand" accent depends on the workspace and on being outside
  // the platform console; the boot script re-resolves it on this event.
  useEffect(() => {
    window.dispatchEvent(new Event(APPEARANCE_CHANGE_EVENT));
  }, [workspace?.id, platform]);

  const openPreferences = useCallback((section: "profile" | "notifications" = "profile") => {
    setPreferencesSection(section);
    setLayer("preferences");
  }, []);

  const bare = isBarePath(pathname);
  return (
    <div className="app-shell">
      <header className="app-mobile-bar">
        <Button aria-label="Open menu" icon={<MenuIcon aria-hidden="true" />} iconOnly onClick={() => setExpanded(true)} size="md" variant="ghost" />
        {platform ? (
          <span className="ws-name flex-1">Platform <span className="mode-chip">Console</span></span>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <WorkspaceMark className="size-6 rounded-[6px] text-[10px] font-semibold" name={workspace?.name ?? "Workspace"} />
            <span className="ws-name">{workspace?.name ?? "Workspace"}</span>
          </span>
        )}
        {!platform && <ButtonLink aria-label="New chat" href="/chat" icon={<Plus aria-hidden="true" />} iconOnly size="md" variant="ghost" />}
      </header>

      <Sidebar
        expanded={expanded}
        inboxOpen={inboxOpen}
        inboxUnread={inbox.list?.unread_count ?? 0}
        onCollapse={() => setExpanded(false)}
        onExpand={() => setExpanded(true)}
        onOpenInbox={() => setInboxOpen(true)}
        onOpenPalette={() => palette.open()}
        onOpenPreferences={() => openPreferences("profile")}
        onOpenShortcuts={() => setLayer("shortcuts")}
        onStartTour={tour.start}
        platform={platform}
        railCollapsed={narrow && !expanded}
      />

      <div className="app-main">
        <main className="app-sheet" data-bare={bare ? "" : undefined} id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>

      <InboxDrawer
        inbox={inbox}
        onClose={() => setInboxOpen(false)}
        onOpenSettings={() => {
          setInboxOpen(false);
          openPreferences("notifications");
        }}
        open={inboxOpen}
      />
      <PreferencesDialog
        onClose={() => setLayer(null)}
        open={layer === "preferences"}
        section={preferencesSection}
      />
      <ShortcutsDialog onClose={() => setLayer(null)} open={layer === "shortcuts"} />
      <ProductTour controller={tour} />
    </div>
  );
}
