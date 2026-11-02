/**
 * The inbox: what changed that the signed-in person should look at.
 *
 * Proposed contract: `GET /notifications`, `PATCH /notifications/{id}`,
 * `POST /notifications/read-all` (`api_contract.md#proposed-notifications-inbox`).
 * Until it exists the pending layer answers with product notices plus items
 * derived from real state the caller can already read (sources that stopped
 * syncing, accounts that need reconnecting, access requests).
 */

import { invalidateApiData } from "@/lib/api/revision";
import { pendingApi } from "@/lib/api/pending";
import { pendingNotifications } from "@/lib/api/pending/notifications";

export type NotificationKind =
  /** Something new in the product. */
  | "product_notice"
  /** A source's last sync failed, or it waits for its account. */
  | "source_failed"
  /** An account must be signed in to again before its sources can sync. */
  | "connection_reconnect"
  /** Someone asked for access the caller can decide. */
  | "access_request"
  /** The caller's own request is still waiting. */
  | "access_request_pending"
  /** The caller's own request was approved. */
  | "access_request_approved"
  /** The caller's own request was denied. */
  | "access_request_denied";

export interface Notification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  created_at: string;
  read: boolean;
  /** Where the item is resolved, as an app route (`/manage/sources?source=…`). */
  href: string;
}

export interface NotificationList {
  items: Notification[];
  /** Unread across the whole inbox, whatever the filter. */
  unread_count: number;
}

/** Newest first. */
export function listNotifications(query: { unread_only?: boolean } = {}): Promise<NotificationList> {
  return pendingApi("notifications.inbox", () => pendingNotifications.list(query));
}

export async function markNotification(id: string, body: { read: boolean }): Promise<Notification> {
  const notification = await pendingApi("notifications.inbox", () => pendingNotifications.mark(id, body));
  invalidateApiData();
  return notification;
}

export async function markAllNotificationsRead(): Promise<{ updated: number }> {
  const result = await pendingApi("notifications.inbox", () => pendingNotifications.markAllRead());
  invalidateApiData();
  return result;
}
