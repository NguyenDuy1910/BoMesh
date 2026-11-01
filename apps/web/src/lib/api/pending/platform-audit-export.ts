/**
 * Local implementation of `platform.audit_export`. Imported only by
 * `modules/platform/api.ts`.
 *
 * Nothing is seeded: the file is built from the REAL `/platform/audit-logs`,
 * read page by page (newest first, until the window's start, at most 10,000
 * events), filtered with the Audit log page's own rule, and written with the
 * workspace audit export's columns, sentences and CSV quoting plus a
 * Workspace column.
 */

import { ApiError } from "@/lib/api/request";
import { pendingCaller, requirePendingPlatformPermission } from "@/lib/api/pending";
import { AUDIT_CSV_HEADER, auditCsvRow, csvBlob } from "@/lib/api/pending/audit-export";
import { workspaceDirectoryApi, type AuditEvent } from "@/modules/manage/access/directory";
import { readSince } from "@/modules/manage/activity/activity-log";
import { PLATFORM_AUDIT_WINDOW_MS, platformAuditMatches } from "@/modules/platform/audit-filter";
import type { PlatformAuditExportQuery } from "@/modules/platform/api";

/** 100 rows a page: an export stops at 10,000 events rather than reading forever. */
const MAX_PAGES = 100;

/** The workspace audit columns with Workspace after Time. */
const HEADER = [AUDIT_CSV_HEADER[0], "Workspace", ...AUDIT_CSV_HEADER.slice(1)];

function row(event: AuditEvent): string[] {
  const [time, ...rest] = auditCsvRow(event);
  const workspace = event.workspace ? event.workspace.name?.trim() || "Deleted workspace" : "Platform";
  return [time, workspace, ...rest];
}

export const pendingPlatformAuditExport = {
  async csv(query: PlatformAuditExportQuery): Promise<Blob> {
    requirePendingPlatformPermission(pendingCaller(null), "platform.audit.read", "You need platform permission to export the audit log.");
    if (query.format !== "csv") throw new ApiError("Only CSV exports are available.", 422);
    const span = PLATFORM_AUDIT_WINDOW_MS[query.window];
    if (!span) throw new ApiError("Choose a window of 24 hours, 7, 30 or 90 days.", 422);
    const search = query.search?.trim() ?? "";
    const { rows } = await readSince(
      (page) => workspaceDirectoryApi.platform.audit(search, page),
      (event) => event.created_at,
      Date.now() - span,
      MAX_PAGES,
    );
    const events = rows.filter((event) => platformAuditMatches(event, query));
    return csvBlob([HEADER, ...events.map(row)]);
  },
};
