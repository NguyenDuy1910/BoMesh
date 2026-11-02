"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import { getStoredAuthSession } from "@/lib/auth/session";
import { useAuthSession } from "@/lib/hooks/useAuthSession";

const publicPathPrefix = "/auth/";

/**
 * Keeps protected application views unmounted until browser-held session state
 * has been checked. Nobody reaches them without signing in; the sign-in page
 * returns the caller to the route they asked for. API authorization remains
 * enforced by the backend.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const session = useAuthSession();
  const [checking, setChecking] = useState(true);
  const isPublicRoute = pathname.startsWith(publicPathPrefix);

  useEffect(() => {
    if (isPublicRoute) return;
    if (getStoredAuthSession()) {
      setChecking(false);
      return;
    }
    const next = `${pathname}${window.location.search}`;
    router.replace(`/auth/login?next=${encodeURIComponent(next)}`);
  }, [isPublicRoute, pathname, router, session]);

  if (isPublicRoute) return <>{children}</>;
  if (!checking && session) return <>{children}</>;
  return <RouteLoading pathname={pathname} />;
}

const LOADING_LABELS: readonly [prefix: string, label: string][] = [
  ["/chats", "Loading chats"],
  ["/chat", "Loading chat"],
  ["/knowledge", "Loading knowledge"],
  ["/documents", "Loading document"],
  ["/manage", "Loading workspace management"],
  ["/platform", "Loading platform console"],
  ["/workspaces", "Loading workspaces"],
];

function RouteLoading({ pathname }: { pathname: string }) {
  const label = LOADING_LABELS.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`))?.[1];
  return label ? <LoadingPage label={label} /> : <LoadingPage label="Checking session" centered />;
}

/* Nothing is known yet — not even which shell will render — so this is the
   only place a heading and control row are placeholders too. */
function LoadingPage({ label, centered = false }: { label: string; centered?: boolean }) {
  return (
    <div className={centered ? "grid min-h-dvh place-content-center bg-[var(--surface-canvas)]" : "min-h-full"}>
      <PageLoadingSkeleton
        className="mx-auto w-[min(48rem,100vw)] px-[var(--page-gutter)] pt-[var(--space-5)]"
        controls
        heading
        label={label}
      />
    </div>
  );
}
