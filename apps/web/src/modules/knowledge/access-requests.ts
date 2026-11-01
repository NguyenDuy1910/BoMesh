"use client";

import { useSyncExternalStore } from "react";

import { apiRevision, subscribeApiData } from "@/lib/api/revision";
import { getAuthSession } from "@/lib/auth/session";
import { useApiQuery } from "@/lib/hooks/useApiQuery";
import type { CollectionRole } from "@/modules/knowledge/knowledge-api";
import { approvalRequestsApi, type ApprovalRequest } from "@/modules/manage/access/directory";

/**
 * Asking for access to a knowledge base, and reviewing those asks, on the one
 * approvals client (`approvalRequestsApi`). A `resource_access` request names
 * the collection and the collection role it asks for; approving it creates
 * exactly that grant on the server.
 */

export type AccessRequest = ApprovalRequest;
export type RequestableRole = Exclude<CollectionRole, "owner">;

/** The collection role a request asks for (`collection_viewer` → `viewer`). */
export function requestedRole(request: Pick<ApprovalRequest, "requested_role">): CollectionRole {
  const code = request.requested_role?.code ?? "";
  return code.endsWith("owner") ? "owner" : code.endsWith("editor") ? "editor" : "viewer";
}

/** "view", "edit" or "own", for "Minh asked to view HR Policies". */
export function requestedVerb(request: Pick<ApprovalRequest, "requested_role">): string {
  return { owner: "own", editor: "edit", viewer: "view" }[requestedRole(request)];
}

export function requestCollectionAccess(
  collectionId: string,
  body: { role: RequestableRole; reason: string },
): Promise<AccessRequest> {
  return approvalRequestsApi.create({
    request_type: "resource_access",
    target_id: collectionId,
    // The server takes the internal collection role code, never a label.
    details: { role: `collection_${body.role}` },
    reason: body.reason.trim(),
  });
}

/** Withdraw one's own pending request. */
export function withdrawAccessRequest(requestId: string): Promise<AccessRequest> {
  return approvalRequestsApi.decide(requestId, { status: "cancelled" });
}

export function decideAccessRequest(requestId: string, status: "approved" | "denied"): Promise<AccessRequest> {
  return approvalRequestsApi.decide(requestId, { status });
}

/** Collection access requests the caller can see: their own, plus all of them for reviewers. */
async function listCollectionRequests(): Promise<AccessRequest[]> {
  const page = await approvalRequestsApi.list({ request_type: "resource_access" });
  return page.items.filter((request) => request.request_type === "resource_access");
}

/**
 * The caller's latest request per collection id, newest first. Reads with
 * the shared API revision, so a request made anywhere shows up here.
 */
export function useMyAccessRequests() {
  const revision = useSyncExternalStore(subscribeApiData, apiRevision, () => 0);
  return useApiQuery<Map<string, AccessRequest>>(async () => {
    const me = getAuthSession()?.user_id;
    const latest = new Map<string, AccessRequest>();
    if (!me) return latest;
    for (const request of await listCollectionRequests()) {
      if (request.requester.id !== me) continue;
      const known = latest.get(request.target_id);
      if (!known || known.created_at < request.created_at) latest.set(request.target_id, request);
    }
    return latest;
  }, revision);
}

/** Pending requests for one collection, oldest first, for its reviewers. */
export function usePendingAccessRequests(collectionId: string, enabled: boolean) {
  const revision = useSyncExternalStore(subscribeApiData, apiRevision, () => 0);
  return useApiQuery<AccessRequest[]>(async () => {
    if (!enabled) return [];
    return (await listCollectionRequests())
      .filter((request) => request.target_id === collectionId && request.status === "pending")
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
  }, `${collectionId}:${enabled}:${revision}`);
}
