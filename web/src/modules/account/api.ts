import { pendingApi } from "@/lib/api/pending";
import * as pendingNotificationPreferences from "@/lib/api/pending/notification-preferences";

/**
 * Email notifications a person can switch on or off. The first two only
 * apply where the person reviews sources or access requests; screens show
 * them to people who hold `source.manage` / `access.manage`.
 */
export interface EmailNotificationPreferences {
  /** A source stops syncing. */
  source_sync_failures: boolean;
  /** Someone requests access to knowledge the person owns. */
  access_requests: boolean;
  /** A source cited in the person's chats is updated or removed. */
  cited_document_changes: boolean;
  /** Weekly summary. */
  weekly_summary: boolean;
}

export interface NotificationPreferences {
  email: EmailNotificationPreferences;
  /** Null until the person saves preferences for the first time. */
  updated_at: string | null;
}

export interface NotificationPreferencesPatch {
  email?: Partial<EmailNotificationPreferences>;
}

/** API pending: `GET /me/notification-preferences` (self). */
export async function getNotificationPreferences(): Promise<NotificationPreferences> {
  return pendingApi("account.notification_prefs", () => pendingNotificationPreferences.getNotificationPreferences());
}

/** API pending: `PATCH /me/notification-preferences` (self). */
export async function updateNotificationPreferences(
  patch: NotificationPreferencesPatch,
): Promise<NotificationPreferences> {
  return pendingApi("account.notification_prefs", () => pendingNotificationPreferences.updateNotificationPreferences(patch));
}
