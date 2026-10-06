"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { NoAccess } from "@/components/shell/NoAccess";
import { useCurrentWorkspace } from "@/components/shell/useCurrentWorkspace";
import { hasPlatformPermission } from "@/lib/auth/session";

/** The console's pages in sidebar order, with the platform permission each needs. */
const LANDINGS = [
  ["/platform/workspaces", "platform.tenant.read"],
  ["/platform/users", "platform.user.read"],
  ["/platform/audit", "platform.audit.read"],
  ["/platform/health", "platform.health.read"],
] as const;

/** `/platform` opens the first console page the caller may use. */
export default function PlatformLandingRoute() {
  const router = useRouter();
  const { session } = useCurrentWorkspace();
  const target = session ? LANDINGS.find(([, permission]) => hasPlatformPermission(session, permission))?.[0] ?? null : undefined;

  useEffect(() => {
    if (target) router.replace(target);
  }, [router, target]);

  return target === null ? <NoAccess /> : null;
}
