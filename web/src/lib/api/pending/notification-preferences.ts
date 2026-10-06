/**
 * Local implementation of `account.notification_prefs` (proposed
 * `GET`/`PATCH /me/notification-preferences`). Preferences belong to the
 * account, not a workspace, so the store is per account and workspace-free.
 */
import { ApiError } from "@/lib/api/request";
import { pendingCaller, pendingStore, requirePendingPermission } from "@/lib/api/pending";
import type {
  EmailNotificationPreferences,
  NotificationPreferences,
  NotificationPreferencesPatch,
} from "@/modules/account/api";

function store() {
  const caller = pendingCaller();
  requirePendingPermission(caller, null, "");
  return pendingStore<NotificationPreferences>("account.notification_prefs", caller.accountId, null, () => ({
    email: {
      source_sync_failures: true,
      access_requests: true,
      cited_document_changes: true,
      weekly_summary: true,
    },
    updated_at: null,
  }));
}

export function getNotificationPreferences(): NotificationPreferences {
  return store().read();
}

export function updateNotificationPreferences(patch: NotificationPreferencesPatch): NotificationPreferences {
  const preferences = store();
  const current = preferences.read();
  const email: EmailNotificationPreferences = { ...current.email, ...patch.email };
  for (const [name, value] of Object.entries(email)) {
    if (!(name in current.email) || typeof value !== "boolean") {
      throw new ApiError("Turn each notification on or off.", 422);
    }
  }
  return preferences.write({ email, updated_at: new Date().toISOString() });
}
