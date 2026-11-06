"use client";

import { Skeleton } from "@heroui/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";

import { ErrorState } from "@/components/ui/ErrorState";
import { Page } from "@/components/ui/Page";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { isPlatformOperator, useSession } from "@/lib/session";
import { WorkspaceProvider } from "@/lib/workspace";

import { AppShell } from "./AppShell";
import { NoAccess } from "./NoAccess";

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
          <Skeleton style={{ height: 44, flex: 1, borderRadius: "var(--radius-xl)" }} />
        </div>
        <div className="sidebar__content">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} style={{ height: 28, margin: "4px 0", borderRadius: "var(--radius-lg)" }} />
          ))}
        </div>
      </aside>
      <main className="main">
        <header className="topbar" />
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

/** Signed-out visitors go to Sign in, then come back here. */
function RequireSession({ children }: { children: ReactNode }) {
  const hydrated = useHydrated();
  const session = useSession();
  const href = useCurrentHref();
  if (!hydrated) return <ShellSkeleton />;
  if (!session) return <Redirect to={`/signin?next=${encodeURIComponent(href)}`} />;
  return <>{children}</>;
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
