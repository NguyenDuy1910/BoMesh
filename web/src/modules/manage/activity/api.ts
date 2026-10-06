/**
 * Activity export. The lists themselves are real (`/audit-logs`,
 * `/access-sessions`, `/workspaces/{id}/activity`; read in `activity-log.ts`);
 * only the file is pending.
 *
 * Proposed contract: `GET /audit-logs/export?format=csv`
 * (`api_contract.md#proposed-audit-export`). Until it exists the pending layer
 * builds the same file in the browser from the real audit list.
 */

import { pendingApi } from "@/lib/api/pending";
import { pendingAuditExport } from "@/lib/api/pending/audit-export";
import type { ActivityWindow } from "@/modules/manage/access/directory";
import type { AuditFilters } from "@/modules/manage/activity/audit-actions";

/** The Activity list's own filters (`AuditFilters`), plus the file format and window. */
export interface AuditExportQuery extends AuditFilters {
  format: "csv";
  window: ActivityWindow;
}

/** The workspace's changes as CSV, filtered exactly like the list. Needs `audit.read`. */
export function exportAuditLogs(query: AuditExportQuery): Promise<Blob> {
  return pendingApi("audit.export", () => pendingAuditExport.csv(query));
}
