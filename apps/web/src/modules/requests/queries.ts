"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { useSpaces } from "@/modules/spaces";
import { getMember, type Member } from "@/modules/knowledge/api";
import { knowledgeKeys } from "@/modules/knowledge/queries";
import { listRequestTypes, testSpacePermissions } from "@/modules/spaces/api";
import { spacesKeys } from "@/modules/spaces/queries";

import {
  answerRequest,
  approveRequest,
  closeRequest,
  createRequest,
  createRequestMessage,
  denyRequest,
  getRequest,
  getRequestType,
  listRequestMessages,
  listRequests,
  sendBackRequest,
  setAssignee,
  withdrawRequest,
} from "./api";
import { isActionable, type Request, type RequestType, type Space } from "./model";

/** Query keys; every key starts with the workspace ID and `"requests"`. */
export const requestsKeys = {
  all: (ws: string) => [ws, "requests"] as const,
  list: (ws: string) => [ws, "requests", "list"] as const,
  one: (ws: string, id: string) => [ws, "requests", "one", id] as const,
  messages: (ws: string, id: string) => [ws, "requests", "messages", id] as const,
  type: (ws: string, name: string) => [ws, "requests", "type", name] as const,
  decider: (ws: string, space: string) => [ws, "requests", "decider", space] as const,
};

/** What a decider may do on a space's requests (`spaces/{space}:testIamPermissions`). */
export const DECIDER_PERMISSIONS = ["requests.get", "requests.update", "requests.approve", "requests.deny", "requests.sendBack", "requests.answer", "requests.close"] as const;
export type DeciderPermission = (typeof DECIDER_PERMISSIONS)[number];

/** All SERVICE/QUESTION requests the caller filed or may decide (one shared list). */
export function useRequests() {
  const { id, hasModule } = useWorkspace();
  return useQuery({ queryKey: requestsKeys.list(id), queryFn: () => listRequests(id), enabled: hasModule("requests"), staleTime: 30_000 });
}

export function useRequest(requestId: string) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: requestsKeys.one(id, requestId), queryFn: () => getRequest(id, requestId), retry: false });
}

export function useRequestMessages(requestId: string, enabled = true) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: requestsKeys.messages(id, requestId), queryFn: () => listRequestMessages(id, requestId), enabled });
}

/** A request type by name (labels, fields, SLA); soft-deleted types still resolve. */
export function useRequestType(name: string | undefined) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: requestsKeys.type(id, name ?? ""), queryFn: () => getRequestType(name ?? ""), enabled: !!name, staleTime: 5 * 60_000, retry: false });
}

/** Request types by name for many requests at once. */
export function useRequestTypeMap(names: readonly (string | undefined)[]): Map<string, RequestType> {
  const { id } = useWorkspace();
  const unique = [...new Set(names.filter((n): n is string => !!n))];
  const results = useQueries({
    queries: unique.map((name) => ({ queryKey: requestsKeys.type(id, name), queryFn: () => getRequestType(name), staleTime: 5 * 60_000, retry: false })),
  });
  const key = results.map((r) => r.data?.name ?? "").join("|");
  return useMemo(() => {
    const out = new Map<string, RequestType>();
    for (const r of results) if (r.data?.name) out.set(r.data.name, r.data);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures the resolved types
  }, [key]);
}

/** Workspace members by name (display name and email for rows), sharing the knowledge core's member cache. */
export function useMemberMap(members: readonly (string | undefined)[]): Map<string, Member> {
  const { id } = useWorkspace();
  const unique = [...new Set(members.map((m) => resourceId(m)).filter(Boolean))];
  const results = useQueries({
    queries: unique.map((memberId) => ({ queryKey: knowledgeKeys.member(id, memberId), queryFn: () => getMember(id, memberId), staleTime: 10 * 60_000, retry: false })),
  });
  const key = results.map((r) => r.data?.name ?? "").join("|");
  return useMemo(() => {
    const out = new Map<string, Member>();
    for (const r of results) if (r.data?.name) out.set(r.data.name, r.data);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures the resolved members
  }, [key]);
}

/** Spaces by resource name (all visible ACTIVE spaces, shared with the Spaces module). */
export function useSpaceMap(): Map<string, Space> {
  const spaces = useSpaces();
  return useMemo(() => new Map((spaces.data ?? []).map((s) => [s.name ?? "", s])), [spaces.data]);
}

/** Decider abilities on a space; `can(p)` is false until loaded. */
export function useDecider(space: string | undefined) {
  const { id } = useWorkspace();
  const spaceId = resourceId(space);
  const query = useQuery({
    queryKey: requestsKeys.decider(id, spaceId),
    queryFn: () => testSpacePermissions(id, spaceId, DECIDER_PERMISSIONS),
    enabled: !!spaceId,
    staleTime: 60_000,
  });
  const held = useMemo(() => new Set(query.data ?? []), [query.data]);
  return { ...query, can: (p: DeciderPermission) => held.has(p) };
}

export interface CatalogGroup {
  space: Space;
  types: RequestType[];
}

/**
 * The catalog: every visible space with active request types, offices first then by name
 * (preview `catalogGroups`), plus the spaces whose requests the caller decides (`staff`).
 */
export function useCatalog() {
  const { id, hasModule } = useWorkspace();
  const spaces = useSpaces();
  const list = spaces.data ?? [];
  const typeQueries = useQueries({
    queries: list.map((s) => ({
      queryKey: spacesKeys.requestTypes(id, resourceId(s.name)),
      queryFn: () => listRequestTypes(id, resourceId(s.name)),
      enabled: hasModule("requests"),
    })),
  });
  const withTypes = list.filter((_, i) => (typeQueries[i]?.data ?? []).some((t) => t.state !== "DELETED"));
  const permQueries = useQueries({
    queries: withTypes.map((s) => ({
      queryKey: requestsKeys.decider(id, resourceId(s.name)),
      queryFn: () => testSpacePermissions(id, resourceId(s.name), DECIDER_PERMISSIONS),
      staleTime: 60_000,
    })),
  });
  const key = typeQueries.map((q) => q.dataUpdatedAt).join("|") + "#" + permQueries.map((q) => q.data?.join(",") ?? "").join("|");
  const groups = useMemo<CatalogGroup[]>(
    () =>
      list
        .map((space, i) => ({ space, types: (typeQueries[i]?.data ?? []).filter((t) => t.state !== "DELETED") }))
        .filter((g) => g.types.length > 0)
        .sort((a, b) => Number(a.space.spaceType !== "office") - Number(b.space.spaceType !== "office") || a.space.displayName.localeCompare(b.space.displayName)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures every sub-query
    [spaces.data, key],
  );
  const staffSpaces = useMemo(
    () => withTypes.filter((_, i) => (permQueries[i]?.data ?? []).includes("requests.get")),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures every sub-query
    [spaces.data, key],
  );
  const typesPending = typeQueries.some((q) => q.isPending && q.fetchStatus !== "idle");
  const typesError = typeQueries.find((q) => q.isError)?.error;
  return {
    groups,
    staffSpaces,
    isPending: spaces.isPending || typesPending,
    isError: spaces.isError || !!typesError,
    error: spaces.error ?? typesError,
    refetch: () => {
      void spaces.refetch();
      for (const q of typeQueries) void q.refetch();
    },
    permsPending: permQueries.some((q) => q.isPending),
  };
}

/**
 * Requests nav badge (preview `X.requestsBadge`): staff — open requests filed by others
 * that wait on them; requester — their own requests that need a reply.
 */
export function useRequestsBadge(): number | undefined {
  const { member } = useWorkspace();
  const requests = useRequests();
  return useMemo(
    () => requests.data?.filter((r) => (r.requester === member.name ? r.state === "NEEDS_INFO" : isActionable(r))).length,
    [requests.data, member.name],
  );
}

/* ═══════════════ Mutations ═══════════════ */

export type RequestAction =
  | { type: "message"; text: string }
  | { type: "approve"; message?: string }
  | { type: "deny"; message: string }
  | { type: "sendBack"; message: string }
  | { type: "answer"; answer: string; publishToCollection?: string }
  | { type: "close" }
  | { type: "withdraw" }
  | { type: "assign"; assignee: string | null };

/** Refreshes the request, its thread, the lists and the Spaces views built on requests. */
export function useInvalidateRequests() {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: requestsKeys.all(id) });
    void qc.invalidateQueries({ queryKey: [id, "spaces", "queue"] });
    void qc.invalidateQueries({ queryKey: [id, "spaces", "upNext"] });
    void qc.invalidateQueries({ queryKey: [id, "shell-badge", "requests"] });
  };
}

/** Every request transition and message, then refresh. */
export function useRequestAction(request: string) {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  const invalidate = useInvalidateRequests();
  return useMutation({
    mutationFn: async (action: RequestAction): Promise<Request | null> => {
      switch (action.type) {
        case "message":
          await createRequestMessage(id, request, action.text);
          return null;
        case "approve":
          return approveRequest(id, request, action.message);
        case "deny":
          return denyRequest(id, request, action.message);
        case "sendBack":
          return sendBackRequest(id, request, action.message);
        case "answer":
          return answerRequest(id, request, action.answer, action.publishToCollection);
        case "close":
          return closeRequest(id, request);
        case "withdraw":
          return withdrawRequest(id, request);
        case "assign":
          return setAssignee(id, request, action.assignee);
      }
    },
    onSuccess: (updated) => {
      if (updated) qc.setQueryData(requestsKeys.one(id, resourceId(request)), updated);
      invalidate();
    },
  });
}

/** CreateRequest (SERVICE or QUESTION). */
export function useCreateRequest() {
  const { id } = useWorkspace();
  const invalidate = useInvalidateRequests();
  return useMutation({
    mutationFn: (body: Request) => createRequest(id, body),
    onSuccess: invalidate,
  });
}

/** Assign several requests (queue bulk bar); resolves with the ones that changed. */
export function useBulkAssign() {
  const { id } = useWorkspace();
  const invalidate = useInvalidateRequests();
  return useMutation({
    mutationFn: (items: { request: string; assignee: string | null }[]) => Promise.all(items.map((x) => setAssignee(id, x.request, x.assignee))),
    onSettled: invalidate,
  });
}
