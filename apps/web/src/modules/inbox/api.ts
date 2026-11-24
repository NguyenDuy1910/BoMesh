import { api, call, resourceId, type Schema } from "@/lib/api/client";

/**
 * The caller's notifications (`members/{member}/notifications`) and the few
 * decisions the inbox can take inline (access requests). Path params are bare IDs.
 */
export type Notification = Schema<"Notification">;
export type Request = Schema<"Request">;
export type Contribution = Schema<"Contribution">;

const path = (workspace: string, member: string) => ({ workspace, member });

/** How many notifications the inbox reads at a time (newest first); older ones load as the list scrolls. */
export const NOTIFICATIONS_PAGE = 30;

/** The caller's unread, live notifications: the bell's count, one `pageSize=1` read of `totalSize`. */
export async function countUnreadNotifications(workspace: string, member: string): Promise<number> {
  const page = await call(
    api.GET("/api/v1/workspaces/{workspace}/members/{member}/notifications", {
      params: { path: path(workspace, member), query: { pageSize: 1, filter: "read = false" } },
    }),
  );
  return page.totalSize ?? 0;
}

export interface NotificationPage {
  notifications: Notification[];
  nextPageToken: string;
}

/** One page of live (not dismissed) notifications, newest first. */
export async function listNotificationPage(workspace: string, member: string, pageToken: string): Promise<NotificationPage> {
  const page = await call(
    api.GET("/api/v1/workspaces/{workspace}/members/{member}/notifications", {
      params: { path: path(workspace, member), query: { pageSize: NOTIFICATIONS_PAGE, pageToken: pageToken || undefined, orderBy: "createTime desc" } },
    }),
  );
  return { notifications: page.notifications ?? [], nextPageToken: page.nextPageToken ?? "" };
}

export function markNotificationRead(workspace: string, member: string, notification: string, read = true): Promise<Notification> {
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/members/{member}/notifications/{notification}", {
      params: { path: { ...path(workspace, member), notification: resourceId(notification) }, query: { updateMask: "read" } },
      body: { read },
    }),
  );
}

/** Marks every unread notification read; returns how many changed. */
export async function markAllNotificationsRead(workspace: string, member: string): Promise<number> {
  const res = await call(
    api.POST("/api/v1/workspaces/{workspace}/members/{member}/notifications:markRead", {
      params: { path: path(workspace, member) },
      body: { filter: "read = false" },
    }),
  );
  return res.updatedCount ?? 0;
}

/** Dismiss (soft delete; restorable until `purgeTime`). */
export function dismissNotification(workspace: string, member: string, notification: string): Promise<Notification> {
  return call(
    api.DELETE("/api/v1/workspaces/{workspace}/members/{member}/notifications/{notification}", {
      params: { path: { ...path(workspace, member), notification: resourceId(notification) } },
    }),
  );
}

export function restoreNotification(workspace: string, member: string, notification: string): Promise<Notification> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/members/{member}/notifications/{notification}:undelete", {
      params: { path: { ...path(workspace, member), notification: resourceId(notification) } },
      body: {},
    }),
  );
}

/* ── Subjects the inbox needs to choose an inline action ── */

const byNames = (workspace: string, collection: string, ids: readonly string[]) =>
  ids.map((i) => `name = "workspaces/${workspace}/${collection}/${resourceId(i)}"`).join(" OR ");

/** Many requests by ID in one ListRequests read (one inbox page's subjects); ones the caller can't see are absent. */
export async function batchGetRequests(workspace: string, ids: readonly string[]): Promise<Request[]> {
  const page = await call(api.GET("/api/v1/workspaces/{workspace}/requests", { params: { path: { workspace }, query: { filter: byNames(workspace, "requests", ids), pageSize: ids.length } } }));
  return page.requests ?? [];
}

export function approveRequest(workspace: string, request: Request): Promise<Request> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/requests/{request}:approve", {
      params: { path: { workspace, request: resourceId(request.name) } },
      body: { etag: request.etag },
    }),
  );
}

export function denyRequest(workspace: string, request: Request): Promise<Request> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/requests/{request}:deny", {
      params: { path: { workspace, request: resourceId(request.name) } },
      body: { etag: request.etag },
    }),
  );
}

/** Many contributions by ID in one ListContributions read (one inbox page's subjects); ones the caller can't see are absent. */
export async function batchGetContributions(workspace: string, ids: readonly string[]): Promise<Contribution[]> {
  const page = await call(
    api.GET("/api/v1/workspaces/{workspace}/contributions", { params: { path: { workspace }, query: { filter: byNames(workspace, "contributions", ids), pageSize: ids.length } } }),
  );
  return page.contributions ?? [];
}
