"use client";

import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useMemo } from "react";

import { resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import {
  approveRequest,
  countUnreadNotifications,
  denyRequest,
  dismissNotification,
  getContribution,
  getRequest,
  listNotificationPage,
  markAllNotificationsRead,
  markNotificationRead,
  restoreNotification,
  type Contribution,
  type Notification,
  type NotificationPage,
  type Request,
} from "./api";
import { targetOf } from "./model";

export const inboxKeys = {
  all: (ws: string) => [ws, "notifications"] as const,
  unread: (ws: string) => [ws, "notifications", "unread"] as const,
  list: (ws: string) => [ws, "notifications", "list"] as const,
  request: (ws: string, id: string) => [ws, "requests", "one", id] as const,
  contribution: (ws: string, id: string) => [ws, "contributions", "one", id, "inbox"] as const,
};

/** The bell's unread count: one `pageSize=1` read, refreshed every minute while the tab is visible (never in the background). */
export function useUnreadNotificationCount() {
  const { id, memberId } = useWorkspace();
  return useQuery({ queryKey: inboxKeys.unread(id), queryFn: () => countUnreadNotifications(id, memberId), staleTime: 30_000, refetchInterval: 60_000 });
}

/** The inbox list, newest first, a page at a time; mounted only while the inbox is open. */
export function useNotificationList() {
  const { id, memberId } = useWorkspace();
  const query = useInfiniteQuery({
    queryKey: inboxKeys.list(id),
    queryFn: ({ pageParam }) => listNotificationPage(id, memberId, pageParam),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextPageToken || undefined,
    staleTime: 30_000,
  });
  const notifications = useMemo(() => query.data?.pages.flatMap((p) => p.notifications), [query.data]);
  return { ...query, notifications };
}

/** Notification kinds whose row depends on the request behind it (Approve while open, Reply when it needs info). */
const REQUEST_KINDS: Readonly<Record<string, true>> = { access_request: true, request_updated: true };

/**
 * Requests and contributions behind the loaded rows (for Approve / Reply / Revise); failures just leave the plain Open.
 * Neither ListRequests nor ListContributions filters by `name`, so each subject is one cached Get, and only for the
 * kinds that use it on the rows the inbox has loaded (a page at a time).
 */
export function useNotificationSubjects(notifications: readonly Notification[]) {
  const { id } = useWorkspace();
  const idsOf = (kind: (n: Notification) => boolean, type: string) => [
    ...new Set(
      notifications
        .filter(kind)
        .map(targetOf)
        .filter((t) => t.type === type)
        .map((t) => t.id),
    ),
  ];
  const requestIds = idsOf((n) => REQUEST_KINDS[n.kind ?? ""] === true, "requests");
  const contributionIds = idsOf((n) => n.kind === "contribution_reviewed", "contributions");
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

type ListData = InfiniteData<NotificationPage, string>;

/**
 * Read / dismiss / restore / mark-all: the loaded rows and the bell's count change at once (optimistically), then both
 * are read again so the count stays the server's.
 */
export function useInboxMutations() {
  const { id, memberId } = useWorkspace();
  const qc = useQueryClient();
  const patchRows = (fn: (rows: Notification[]) => Notification[]) =>
    qc.setQueryData<ListData>(inboxKeys.list(id), (data) => data && { ...data, pages: data.pages.map((p) => ({ ...p, notifications: fn(p.notifications) })) });
  const shiftCount = (by: number | ((n: number) => number)) =>
    qc.setQueryData<number>(inboxKeys.unread(id), (n) => (n === undefined ? n : Math.max(0, typeof by === "number" ? n + by : by(n))));
  /** Stops a refetch in flight from overwriting the optimistic state. */
  const hold = () => qc.cancelQueries({ queryKey: inboxKeys.all(id) });
  const refresh = () => void qc.invalidateQueries({ queryKey: inboxKeys.all(id) });
  return {
    markRead: useMutation({
      mutationFn: (n: Notification) => markNotificationRead(id, memberId, n.name ?? ""),
      onMutate: async (n) => {
        await hold();
        if (!n.read) shiftCount(-1);
        patchRows((rows) => rows.map((r) => (r.name === n.name ? { ...r, read: true } : r)));
      },
      onSettled: refresh,
    }),
    markAllRead: useMutation({
      mutationFn: () => markAllNotificationsRead(id, memberId),
      onMutate: async () => {
        await hold();
        shiftCount(() => 0);
        patchRows((rows) => rows.map((r) => ({ ...r, read: true })));
      },
      onSettled: refresh,
    }),
    dismiss: useMutation({
      mutationFn: (n: Notification) => dismissNotification(id, memberId, n.name ?? ""),
      onMutate: async (n) => {
        await hold();
        if (!n.read) shiftCount(-1);
        patchRows((rows) => rows.filter((r) => r.name !== n.name));
      },
      onSettled: refresh,
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
