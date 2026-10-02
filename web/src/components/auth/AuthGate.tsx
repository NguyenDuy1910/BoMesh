"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { AuthPromptProvider } from "@/components/auth/AuthPrompt";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import { getStoredAuthSession, isGuestSession } from "@/lib/auth/session";
import { useAuthSession } from "@/lib/hooks/useAuthSession";
import { createSession } from "@/modules/auth/api";

const publicPathPrefix = "/auth/";

/**
 * Keeps protected application views unmounted until browser-held session state
 * has been checked. API authorization remains enforced by the backend.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const session = useAuthSession();
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [requiredPrompt, setRequiredPrompt] = useState<{
    reason: string;
    requestId: number;
  }>();
  const isPublicRoute = pathname.startsWith(publicPathPrefix);

  useEffect(() => {
    if (isPublicRoute) return;
    if (getStoredAuthSession()) {
      setChecking(false);
      return;
    }
    let mounted = true;
    setChecking(true);
    setError(null);
    void createSession()
      .catch((cause: unknown) => {
        if (mounted) {
          setError(cause instanceof Error ? cause.message : "Guest access could not be started.");
        }
      })
      .finally(() => { if (mounted) setChecking(false); });
    return () => { mounted = false; };
  }, [isPublicRoute, retryCount]);

  useEffect(() => {
    if (!isGuestSession(session)) {
      setRequiredPrompt(undefined);
      return;
    }
    const reason = protectedRouteReason(pathname);
    if (!reason) return;
    setRequiredPrompt((current) => ({
      reason,
      requestId: (current?.requestId ?? 0) + 1,
    }));
    router.replace("/app");
  }, [pathname, router, session]);

  if (isPublicRoute) return <>{children}</>;
  if (!checking && session) {
    return (
      <AuthPromptProvider
        requiredReason={requiredPrompt?.reason}
        requiredRequestId={requiredPrompt?.requestId}
      >
        {children}
      </AuthPromptProvider>
    );
  }
  if (error) {
    return (
      <ErrorState
        actionLabel="Try again"
        description={error}
        onAction={() => {
          setError(null);
          setRetryCount((value) => value + 1);
        }}
        title="Workspace could not be opened"
      />
    );
  }
  return <RouteLoading pathname={pathname} />;
}

function RouteLoading({ pathname }: { pathname: string }) {
  if (pathname === "/app") return <LoadingPage label="Loading chat" />;
  if (pathname === "/library") return <LoadingPage label="Loading library" />;
  if (pathname === "/workspaces") return <LoadingPage label="Loading workspaces" />;
  if (pathname === "/workspace-control" || pathname.startsWith("/workspace-control/")) {
    return <LoadingPage label="Loading workspace control" />;
  }
  return <LoadingPage label="Checking session" centered />;
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

function protectedRouteReason(pathname: string): string | undefined {
  if (pathname === "/library") return "Sign in to upload and keep private files.";
  if (pathname === "/workspaces") return "Sign in to open private workspaces.";
  if (pathname === "/workspace-control" || pathname.startsWith("/workspace-control/")) {
    return "Sign in to manage agents, knowledge, and workspace settings.";
  }
  return undefined;
}
