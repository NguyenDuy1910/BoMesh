import { api, call, listAll, resourceId, type Schema } from "@/lib/api/client";

/**
 * The caller's notifications (`members/{member}/notifications`) and the few
 * decisions the inbox can take inline (access requests). Path params are bare IDs.
 */
export type Notification = Schema<"Notification">;
export type Request = Schema<"Request">;
export type Contribution = Schema<"Contribution">;

const path = (workspace: string, member: string) => ({ workspace, member });

/** Every live (not dismissed) notification, newest first. */
export function listNotifications(workspace: string, member: string): Promise<Notification[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/members/{member}/notifications", {
          params: { path: path(workspace, member), query: { pageSize: 200, pageToken, orderBy: "createTime desc" } },
        }),
      ),
    (page) => page.notifications,
    500,
  );
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

export function getRequest(workspace: string, request: string): Promise<Request> {
  return call(api.GET("/api/v1/workspaces/{workspace}/requests/{request}", { params: { path: { workspace, request: resourceId(request) } } }));
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

export function getContribution(workspace: string, contribution: string): Promise<Contribution> {
  return call(
    api.GET("/api/v1/workspaces/{workspace}/contributions/{contribution}", {
      params: { path: { workspace, contribution: resourceId(contribution) }, query: { view: "BASIC" } },
    }),
  );
}
