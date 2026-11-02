/**
 * Local implementation of `notifications.inbox`. Imported only by
 * `modules/notifications/api.ts`.
 *
 * Two kinds of item:
 * - product notices, seeded here (they describe the product, never a record);
 * - items derived from REAL state the caller can already read: sources whose
 *   sync failed and accounts that need reconnecting (`source.manage`), and
 *   approval requests (reviewable ones, and the caller's own).
 * Only read/unread state is stored. A derived read that fails is skipped, so
 * the inbox still answers with what it has.
 */

import { ApiError, apiRequest, type Paginated } from "@/lib/api/request";
import { pendingCaller, pendingStore, requirePendingPermission, type PendingCaller } from "@/lib/api/pending";
import { connectorByKey } from "@/modules/ingestion/connectors";
import { RECONNECT_STATUSES, collectionsApi, connectionsApi, sourcesApi } from "@/modules/ingestion/integrations-api";
import type { Notification, NotificationKind, NotificationList } from "@/modules/notifications/api";

interface Notice {
  id: string;
  hoursAgo: number;
  /** Starts read, so a first visit is not a wall of unread. */
  read: boolean;
  /** Shown only to callers holding this workspace permission. */
  audience: string | null;
  title: string;
  body: string;
  href: string;
}

const NOTICES: readonly Notice[] = [
  {
    id: "notice-inbox",
    hoursAgo: 1,
    read: false,
    audience: null,
    title: "Your inbox is here",
    body: "Sync problems, access requests and product news collect here, each linked to where you resolve it.",
    href: "/chat",
  },
  {
    id: "notice-ask-selection",
    hoursAgo: 26,
    read: false,
    audience: null,
    title: "Ask about any passage",
    body: "Select text in a document to ask about it, or copy it with its source.",
    href: "/knowledge",
  },
  {
    id: "notice-knowledge-gaps",
    hoursAgo: 50,
    read: true,
    audience: "tenant.manage",
    title: "See what knowledge couldn’t answer",
    body: "Overview now lists frequent questions without a good answer, with a way to add the missing documents.",
    href: "/manage/overview",
  },
];

interface InboxState {
  /** When this inbox was first opened; notices are dated from it. */
  opened_at: string | null;
  /** Notification id → read. Absent means unread. */
  read: Record<string, true>;
}

/** `GET /approval-requests` items, as far as the inbox reads them (OpenAPI `ApprovalRequest`). */
interface ApprovalRequestRow {
  id: string;
  request_type: "resource_access" | "plugin_installation";
  target_id: string;
  status: "pending" | "approved" | "denied" | "cancelled";
  requester: { id: string; email: string | null; display_name: string | null };
  reason: string | null;
  decision_note: string | null;
  decided_at: string | null;
  created_at: string;
}

type Derived = Omit<Notification, "read">;

const HOUR = 3_600_000;

function inboxStore(caller: PendingCaller) {
  return pendingStore<InboxState>("notifications.inbox", caller.accountId, caller.workspaceId, () => ({
    opened_at: null,
    read: Object.fromEntries(NOTICES.filter((notice) => notice.read).map((notice) => [notice.id, true] as const)),
  }));
}

async function settled<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

async function sourceItems(openedAt: string): Promise<Derived[]> {
  const [connections, sources] = await Promise.all([
    settled(() => connectionsApi.list()),
    settled(() => sourcesApi.list()),
  ]);
  const items: Derived[] = [];
  for (const connection of connections?.items ?? []) {
    if (!RECONNECT_STATUSES.includes(connection.status)) continue;
    items.push({
      id: `connection:${connection.id}:${connection.status}`,
      kind: "connection_reconnect",
      title: `Reconnect ${connection.display_name}`,
      body: connection.status_detail ?? "Its sources can’t sync until someone signs in to the account again.",
      created_at: connection.last_checked_at ?? connection.updated_at,
      href: `/manage/sources?tab=accounts&connection=${encodeURIComponent(connection.id)}`,
    });
  }
  for (const source of sources?.items ?? []) {
    const failed = source.status === "failed" || source.sync?.status === "failed";
    if (!failed) continue;
    const name = source.display_name ?? source.external_resource_id ?? "A source";
    items.push({
      id: `source:${source.id}:${source.sync?.last_synced_at ?? source.status}`,
      kind: "source_failed",
      title: `${name} stopped syncing`,
      body: source.sync?.error ?? "Open the source to see what happened.",
      created_at: source.sync?.last_synced_at ?? openedAt,
      href: `/manage/sources?source=${encodeURIComponent(source.id)}`,
    });
  }
  return items;
}

async function requestItems(caller: PendingCaller): Promise<Derived[]> {
  const page = await settled(() =>
    apiRequest<Paginated<ApprovalRequestRow>>("/approval-requests?page_size=100"),
  );
  const requests = page?.items ?? [];
  if (!requests.length) return [];
  const collections = requests.some((request) => request.request_type === "resource_access")
    ? (await settled(() => collectionsApi.list()))?.items ?? []
    : [];
  const targetName = (request: ApprovalRequestRow) =>
    request.request_type === "plugin_installation"
      ? `the ${connectorByKey(request.target_id)?.name ?? "requested"} connector`
      : collections.find((collection) => collection.id === request.target_id)?.title ?? "a knowledge base";
  const canReview = (request: ApprovalRequestRow) =>
    caller.permissions.includes(request.request_type === "resource_access" ? "access.manage" : "source.manage");

  const items: Derived[] = [];
  for (const request of requests) {
    const target = targetName(request);
    if (request.requester.id === caller.accountId) {
      if (request.status === "cancelled") continue;
      const kind: NotificationKind = request.status === "approved"
        ? "access_request_approved"
        : request.status === "denied" ? "access_request_denied" : "access_request_pending";
      const titles: Record<typeof kind, string> = {
        access_request_approved: `You can now open ${target}`,
        access_request_denied: `Your request for ${target} was declined`,
        access_request_pending: `Your request for ${target} is waiting for a decision`,
      };
      items.push({
        id: `my-request:${request.id}:${request.status}`,
        kind,
        title: titles[kind],
        body: request.decision_note
          ?? (request.status === "pending" ? "You’ll get a notification when it’s decided." : "Decided by a workspace admin."),
        created_at: request.decided_at ?? request.created_at,
        href: request.request_type === "resource_access" && request.status === "approved"
          ? `/knowledge/${encodeURIComponent(request.target_id)}`
          : "/knowledge",
      });
    } else if (request.status === "pending" && canReview(request)) {
      const who = request.requester.display_name?.trim() || request.requester.email || "Someone";
      items.push({
        id: `request:${request.id}`,
        kind: "access_request",
        title: request.request_type === "plugin_installation"
          ? `${who} asked to add ${target}`
          : `${who} asked for access to ${target}`,
        body: request.reason ? `“${request.reason}”` : "Review it in People & access.",
        created_at: request.created_at,
        href: "/manage/access?tab=requests",
      });
    }
  }
  return items;
}

async function inbox(caller: PendingCaller) {
  const store = inboxStore(caller);
  let state = store.read();
  if (!state.opened_at) state = store.write({ ...state, opened_at: new Date().toISOString() });
  const opened = Date.parse(state.opened_at!);
  const notices: Derived[] = NOTICES
    .filter((notice) => !notice.audience || caller.permissions.includes(notice.audience))
    .map((notice) => ({
      id: notice.id,
      kind: "product_notice",
      title: notice.title,
      body: notice.body,
      created_at: new Date(opened - notice.hoursAgo * HOUR).toISOString(),
      href: notice.href,
    }));
  const [sources, requests] = await Promise.all([
    caller.permissions.includes("source.manage") ? sourceItems(state.opened_at!) : [],
    requestItems(caller),
  ]);
  const items: Notification[] = [...notices, ...sources, ...requests]
    .map((item) => ({ ...item, read: Boolean(state.read[item.id]) }))
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  return { store, items };
}

/** Keep read marks only for items that still exist, so the store does not grow forever. */
function readMarks(items: readonly Notification[], read: (item: Notification) => boolean): Record<string, true> {
  return Object.fromEntries(items.filter(read).map((item) => [item.id, true] as const));
}

function signedIn(): PendingCaller {
  const caller = pendingCaller();
  requirePendingPermission(caller, null, "");
  return caller;
}

export const pendingNotifications = {
  async list(query: { unread_only?: boolean }): Promise<NotificationList> {
    const { items } = await inbox(signedIn());
    return {
      items: query.unread_only ? items.filter((item) => !item.read) : items,
      unread_count: items.filter((item) => !item.read).length,
    };
  },

  async mark(id: string, body: { read: boolean }): Promise<Notification> {
    if (typeof body?.read !== "boolean") throw new ApiError("Say whether the notification is read.", 422);
    const { store, items } = await inbox(signedIn());
    const target = items.find((item) => item.id === id);
    if (!target) throw new ApiError("This notification no longer exists.", 404);
    store.update((state) => ({
      ...state,
      read: readMarks(items, (item) => (item.id === id ? body.read : item.read)),
    }));
    return { ...target, read: body.read };
  },

  async markAllRead(): Promise<{ updated: number }> {
    const { store, items } = await inbox(signedIn());
    const updated = items.filter((item) => !item.read).length;
    store.update((state) => ({ ...state, read: readMarks(items, () => true) }));
    return { updated };
  },
};
