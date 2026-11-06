"use client";

import type { ReactNode } from "react";

import { useWorkspace, type WorkspacePermission } from "@/lib/workspace";

import { NoAccess } from "./NoAccess";

/**
 * Renders children only when the caller holds the workspace permission;
 * otherwise the no-access state, without loading any data. (The shell already
 * gates whole routes from `lib/navigation.ts`; use this for in-page regions.)
 */
export function RequirePermission({ permission, children }: { permission: WorkspacePermission; children: ReactNode }) {
  const { can } = useWorkspace();
  return can(permission) ? <>{children}</> : <NoAccess />;
}
