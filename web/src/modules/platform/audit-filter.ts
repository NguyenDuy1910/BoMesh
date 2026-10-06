/**
 * The platform audit log's windows and filters, shared by the Audit log page,
 * its client and the pending export, so the file always holds what the table
 * showed. Kept apart from `api.ts`, which imports the pending implementation,
 * to avoid an import cycle.
 */

import { outcomeStatusKey } from "@/lib/status";
import type { AuditEvent } from "@/modules/manage/access/directory";
import { auditActionArea } from "@/modules/manage/activity/audit-actions";

export type PlatformAuditWindow = "24h" | "7d" | "30d" | "90d";

export const PLATFORM_AUDIT_WINDOW_MS: Record<PlatformAuditWindow, number> = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  "90d": 90 * 86_400_000,
};

/** `workspace_id: "platform"` selects events that belong to no workspace. */
export const PLATFORM_SCOPE = "platform";

export interface PlatformAuditFilter {
  workspace_id?: string;
  /** An `AuditArea` from `audit-actions.ts`. */
  area?: string;
  outcome?: "success" | "failure";
}

export function platformAuditMatches(event: AuditEvent, filter: PlatformAuditFilter): boolean {
  if (filter.workspace_id) {
    const inScope = filter.workspace_id === PLATFORM_SCOPE ? !event.workspace : event.workspace?.id === filter.workspace_id;
    if (!inScope) return false;
  }
  if (filter.area && auditActionArea(event.action) !== filter.area) return false;
  if (filter.outcome && outcomeStatusKey(event.outcome) !== filter.outcome) return false;
  return true;
}
