"use client";

import { Skeleton } from "@heroui/react";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import { ErrorState } from "@/components/ui/ErrorState";
import { Page } from "@/components/ui/Page";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { useOpened } from "@/lib/lazy";
import { isPlatformOperator, useSession, useSessionExpired } from "@/lib/session";
import { WorkspaceProvider } from "@/lib/workspace";
import { signInHref } from "@/modules/auth/next";

import { AppShell } from "./AppShell";
import { NoAccess } from "./NoAccess";

/** Loads once a session expires (it carries the sign-in form); stays mounted afterwards so it animates closed. */
const SessionExpiredDialog = dynamic(() => import("./SessionExpiredDialog").then((m) => m.SessionExpiredDialog), { ssr: false });

const subscribeNever = () => () => undefined;

/** `true` once the browser has hydrated (the stored session is readable only then). */
function useHydrated(): boolean {
  return useSyncExternalStore(subscribeNever, () => true, () => false);
}

/** The current address, for `?next=` after sign-in or workspace choice. */
function useCurrentHref(): string {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  return search ? `${pathname}?${search}` : pathname;
}

/** Placeholder shell while the session and workspace load. */
export function ShellSkeleton() {
  return (
    <div className="app" aria-busy="true" aria-label="Loading">
      <aside className="sidebar" aria-hidden>
        <div className="sidebar__header">
          <Skeleton style={{ height: 32, flex: 1, borderRadius: "var(--radius-lg)" }} />
        </div>
        <div className="sidebar__search">
          <Skeleton style={{ height: 32, borderRadius: "var(--radius-lg)" }} />
        </div>
        <div className="sidebar__content">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} style={{ height: 28, margin: "4px 0", borderRadius: "var(--radius-lg)" }} />
          ))}
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="topbar__inner" />
        </header>
        <div className="main__scroll">
          <Page>
            <SkeletonRows rows={5} />
          </Page>
        </div>
      </main>
    </div>
  );
}

function Redirect({ to }: { to: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(to);
  }, [router, to]);
  return <ShellSkeleton />;
}

/** Another account signed in over this page: a full load of Home, so nothing of the previous one stays in memory. */
function SwitchAccount() {
  useEffect(() => {
    window.location.replace("/home");
  }, []);
  return <ShellSkeleton />;
}

/**
 * Signed-out visitors go to Sign in, then come back here. A session that expires while
 * the page is open keeps the page (and its client state) behind `SessionExpiredDialog`;
 * one already expired when the page loads has nothing to keep, so Sign in explains instead.
 */
function RequireSession({ children }: { children: ReactNode }) {
  const hydrated = useHydrated();
  const session = useSession();
  const expired = useSessionExpired();
  const href = useCurrentHref();
  const expiredOpened = useOpened(expired);
  // The user this page is rendered for: whoever had a working session when it first rendered.
  const [owner, setOwner] = useState<string | null>(null);
  if (hydrated && session && !expired && owner === null) setOwner(session.user.name);
  if (!hydrated) return <ShellSkeleton />;
  if (!session) return <Redirect to={signInHref(href)} />;
  if (owner === null) return expired ? <Redirect to={signInHref(href, "expired")} /> : <ShellSkeleton />;
  if (session.user.name !== owner) return <SwitchAccount />;
  return (
    <>
      {children}
      {expiredOpened ? <SessionExpiredDialog session={expired ? session : null} href={href} /> : null}
    </>
  );
}

/** `(app)` layout body: session → active workspace → workspace shell. */
export function WorkspaceShell({ children }: { children: ReactNode }) {
  const href = useCurrentHref();
  return (
    <RequireSession>
      <WorkspaceProvider
        loading={<ShellSkeleton />}
        chooser={<Redirect to={`/workspaces?next=${encodeURIComponent(href)}`} />}
        failed={(error, retry) => (
          <div className="app" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
            <main className="main">
              <div className="main__scroll">
                <Page>
                  <ErrorState error={error} title="This workspace couldn’t be opened" onRetry={retry} />
                </Page>
              </div>
            </main>
          </div>
        )}
      >
        <AppShell mode="workspace">{children}</AppShell>
      </WorkspaceProvider>
    </RequireSession>
  );
}

/** `p/` layout body: session → platform role → platform console shell. */
export function PlatformShell({ children }: { children: ReactNode }) {
  const session = useSession();
  return (
    <RequireSession>
      <AppShell mode="platform">{isPlatformOperator(session) ? children : <NoAccess />}</AppShell>
    </RequireSession>
  );
}
