/**
 * Local implementation of `audit.export`. Imported only by
 * `modules/manage/activity/api.ts`.
 *
 * Nothing here is seeded: the file is built from the REAL audit trail, read
 * page by page through the same reader the Activity list uses (newest first,
 * until the window's start), then filtered with the list's own rule.
 */

import { ApiError } from "@/lib/api/request";
import { pendingCaller, requirePendingPermission } from "@/lib/api/pending";
import { STATUS, outcomeStatusKey } from "@/lib/status";
import type { AuditEvent } from "@/modules/manage/access/directory";
import { ACTIVITY_WINDOW_MS, auditEventsSince } from "@/modules/manage/activity/activity-log";
import {
  auditActorName,
  auditEventMatches,
  describeAuditAction,
  describeAuditTarget,
} from "@/modules/manage/activity/audit-actions";
import type { AuditExportQuery } from "@/modules/manage/activity/api";
import { titleCase } from "@/lib/format";

/** 100 rows a page: an export stops at 10,000 events rather than reading forever. */
const MAX_PAGES = 100;

export const AUDIT_CSV_HEADER = ["Time", "Actor", "Action", "Target", "Outcome", "IP address"];

function detailText(details: Record<string, unknown>, key: string): string | null {
  const value = details[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** One event as a CSV row, in `AUDIT_CSV_HEADER` order. Shared with the platform audit export. */
export function auditCsvRow(event: AuditEvent): string[] {
  const details = event.details ?? {};
  const outcomeKey = outcomeStatusKey(event.outcome) as keyof typeof STATUS.outcome;
  return [
    event.created_at ?? "",
    auditActorName(event.actor),
    describeAuditAction(event.action, details),
    describeAuditTarget(event),
    STATUS.outcome[outcomeKey]?.label ?? titleCase(event.outcome),
    detailText(details, "ip_address") ?? detailText(details, "ip") ?? "",
  ];
}

/**
 * RFC 4180 quoting, plus a leading apostrophe on anything a spreadsheet would
 * run as a formula: actor names and targets are written by people.
 */
function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** The file: quoted cells, CRLF lines, and a byte-order mark so spreadsheet apps read accented names correctly. */
export function csvBlob(lines: readonly (readonly string[])[]): Blob {
  const text = lines.map((values) => values.map(cell).join(",")).join("\r\n");
  return new Blob([`\uFEFF${text}\r\n`], { type: "text/csv;charset=utf-8" });
}

export const pendingAuditExport = {
  async csv(query: AuditExportQuery): Promise<Blob> {
    requirePendingPermission(pendingCaller(), "audit.read", "You need permission to view activity to export it.");
    if (query.format !== "csv") throw new ApiError("Only CSV exports are available.", 422);
    const span = ACTIVITY_WINDOW_MS[query.window];
    if (!span) throw new ApiError("Choose a window of 24 hours, 7 days or 30 days.", 422);
    const { rows } = await auditEventsSince(Date.now() - span, MAX_PAGES);
    const events = rows.filter((event) => auditEventMatches(event, query));
    return csvBlob([AUDIT_CSV_HEADER, ...events.map(auditCsvRow)]);
  },
};
