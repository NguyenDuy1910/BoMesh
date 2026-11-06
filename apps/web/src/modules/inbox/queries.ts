"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import {
  approveRequest,
  denyRequest,
  dismissNotification,
  getContribution,
  getRequest,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  restoreNotification,
  type Contribution,
  type Notification,
  type Request,
} from "./api";
import { targetOf } from "./model";

export const inboxKeys = {
  all: (ws: string) => [ws, "notifications"] as const,
  request: (ws: string, id: string) => [ws, "requests", "one", id] as const,
  contribution: (ws: string, id: string) => [ws, "contributions", "one", id, "inbox"] as const,
};

export function useNotifications() {
  const { id, memberId } = useWorkspace();
  return useQuery({ queryKey: inboxKeys.all(id), queryFn: () => listNotifications(id, memberId) });
}

/** Requests and contributions the notifications point at (for Approve / Reply / Revise); failures just leave the plain Open. */
export function useNotificationSubjects(notifications: readonly Notification[]) {
  const { id } = useWorkspace();
  const requestIds = [...new Set(notifications.map(targetOf).filter((t) => t.type === "requests").map((t) => t.id))];
  const contributionIds = [
    ...new Set(
      notifications
        .filter((n) => n.kind === "contribution_reviewed")
        .map(targetOf)
        .filter((t) => t.type === "contributions")
        .map((t) => t.id),
    ),
  ];
  const requests = useQueries({
    queries: requestIds.map((r) => ({ queryKey: inboxKeys.request(id, r), queryFn: () => getRequest(id, r), retry: false, staleTime: 30_000 })),
  });
  const contributions = useQueries({
    queries: contributionIds.map((c) => ({ queryKey: inboxKeys.contribution(id, c), queryFn: () => getContribution(id, c), retry: false, staleTime: 30_000 })),
  });
  const requestData = requests.map((q) => q.data);
  const contributionData = contributions.map((q) => q.data);
  const requestKey = requestData.map((r) => `${r?.name}:${r?.state}`).join("|");
  const contributionKey = contributionData.map((c) => `${c?.name}:${c?.state}`).join("|");
  return useMemo(() => {
    const byId = <T extends { name?: string }>(rows: (T | undefined)[]) => new Map(rows.filter((r): r is T => !!r).map((r) => [resourceId(r.name), r]));
    return { requests: byId<Request>(requestData), contributions: byId<Contribution>(contributionData) };
    // The keys capture the loaded subjects; the arrays are new on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, contributionKey]);
}

/** Read / dismiss / restore / mark-all, updating the cached list in place so rows react at once. */
export function useInboxMutations() {
  const { id, memberId } = useWorkspace();
  const qc = useQueryClient();
  const key = inboxKeys.all(id);
  const patch = (fn: (rows: Notification[]) => Notification[]) => qc.setQueryData<Notification[]>(key, (rows) => (rows ? fn(rows) : rows));
  const refresh = () => void qc.invalidateQueries({ queryKey: key });
  return {
    markRead: useMutation({
      mutationFn: (n: Notification) => markNotificationRead(id, memberId, n.name ?? ""),
      onMutate: (n) => patch((rows) => rows.map((r) => (r.name === n.name ? { ...r, read: true } : r))),
      onError: refresh,
    }),
    markAllRead: useMutation({
      mutationFn: () => markAllNotificationsRead(id, memberId),
      onSuccess: () => patch((rows) => rows.map((r) => ({ ...r, read: true }))),
      onSettled: refresh,
    }),
    dismiss: useMutation({
      mutationFn: (n: Notification) => dismissNotification(id, memberId, n.name ?? ""),
      onMutate: (n) => patch((rows) => rows.filter((r) => r.name !== n.name)),
      onError: refresh,
    }),
    restore: useMutation({
      mutationFn: (n: Notification) => restoreNotification(id, memberId, n.name ?? ""),
      onSettled: refresh,
    }),
    decide: useMutation({
      mutationFn: ({ request, approve }: { request: Request; approve: boolean }) => (approve ? approveRequest(id, request) : denyRequest(id, request)),
      onSuccess: (r) => {
        qc.setQueryData(inboxKeys.request(id, resourceId(r.name)), r);
        void qc.invalidateQueries({ queryKey: [id, "requests"] });
        void qc.invalidateQueries({ queryKey: [id, "shell-badge"] });
      },
    }),
  };
}
