/**
 * Reading the workspace's real audit trail and sign-ins for one time window.
 *
 * `GET /audit-logs` and `GET /access-sessions` page newest first and take no
 * time window, so a window is read page by page until the first row older
 * than its start. The Activity screen and the CSV export read through the
 * same functions, so the file always holds what the table showed.
 */

import {
  workspaceDirectoryApi,
  type AccessSessionRecord,
  type ActivityWindow,
  type AuditEvent,
} from "@/modules/manage/access/directory";

export const ACTIVITY_WINDOW_MS: Record<ActivityWindow, number> = {
  "24h": 24 * 3_600_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

export interface WindowRead<T> {
  rows: T[];
  /** The read stopped at its page cap before reaching the window's start. */
  truncated: boolean;
}

/**
 * Page newest-first rows until one starts before `since` or the cap is
 * reached. Shared with the platform audit log, which pages the same way.
 */
export async function readSince<T>(
  readPage: (page: number) => Promise<{ items: T[]; total: number }>,
  timeOf: (row: T) => string | null,
  since: number,
  maxPages: number,
): Promise<WindowRead<T>> {
  const rows: T[] = [];
  let seen = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await readPage(page);
    seen += result.items.length;
    for (const row of result.items) {
      const at = Date.parse(timeOf(row) ?? "");
      if (Number.isNaN(at)) continue;
      if (at < since) return { rows, truncated: false };
      rows.push(row);
    }
    if (!result.items.length || seen >= result.total) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/**
 * Audit events since `since`, newest first. 100 a page; the screen reads up
 * to 1,000 events, the export up to 10,000.
 */
export function auditEventsSince(since: number, maxPages = 10): Promise<WindowRead<AuditEvent>> {
  return readSince((page) => workspaceDirectoryApi.auditLogs("", page), (event) => event.created_at, since, maxPages);
}

/** Sign-ins (user sessions) started since `since`, newest first. */
export function signInsSince(since: number, maxPages = 10): Promise<WindowRead<AccessSessionRecord>> {
  return readSince((page) => workspaceDirectoryApi.accessSessions({ page }), (session) => session.started_at, since, maxPages);
}
