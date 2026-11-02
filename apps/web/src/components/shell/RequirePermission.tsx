"use client";

import { NoAccess } from "@/components/shell/NoAccess";
import { useCurrentWorkspace } from "@/components/shell/useCurrentWorkspace";
import { hasAnySessionPermission, hasPlatformPermission } from "@/lib/auth/session";

/**
 * Renders a page only for callers holding any one of its permissions; anyone
 * else gets the shared no-access page. Presentation only — the API enforces
 * the same permissions on every request.
 */
export function RequirePermission({
  anyOf,
  platformAnyOf,
  children,
}: {
  /** Workspace permissions; any one of them opens the page. */
  anyOf?: readonly string[];
  /** Platform permissions; any one of them opens the page. */
  platformAnyOf?: readonly string[];
  children: React.ReactNode;
}) {
  const { session } = useCurrentWorkspace();
  // The shell only renders after AuthGate found a session; until the hook has
  // read it, render nothing rather than flash the refusal.
  if (!session) return null;
  const allowed = (!anyOf || hasAnySessionPermission(session, anyOf))
    && (!platformAnyOf || platformAnyOf.some((permission) => hasPlatformPermission(session, permission)));
  return allowed ? <>{children}</> : <NoAccess />;
}
