"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { getItemIamPolicy, listAccessRequests, listActiveMembers, listGroups } from "./api";
import { isOwner, isPendingRequest, type AccessRequest, type Item, type Policy } from "./model";

/** Keys live under `[ws, "items"]` so every knowledge invalidation refreshes them too. */
export const basesKeys = {
  /** Shared with `useWhoCanSee` (ResourceDetails). */
  policy: (ws: string, id: string) => [ws, "items", "policy", id] as const,
  requests: (ws: string) => [ws, "requests", "collectionAccess"] as const,
  people: (ws: string) => [ws, "members", "shareable"] as const,
  groups: (ws: string) => [ws, "groups"] as const,
};

/** The base's own IAM policy; owners only (`items.getIamPolicy`). */
export function useBasePolicy(base: Item | null | undefined) {
  const { id } = useWorkspace();
  const baseId = resourceId(base?.name);
  return useQuery({
    queryKey: basesKeys.policy(id, baseId),
    queryFn: () => getItemIamPolicy(id, baseId),
    enabled: !!baseId && isOwner(base),
    retry: false,
    staleTime: 60_000,
  });
}

/** Policies of every base the caller owns (list cards' access chips), keyed by item name. */
export function useBasePolicies(bases: readonly Item[]) {
  const { id } = useWorkspace();
  const owned = bases.filter((b) => isOwner(b) && b.collection?.kind !== "PERSONAL" && b.name);
  const results = useQueries({
    queries: owned.map((b) => ({
      queryKey: basesKeys.policy(id, resourceId(b.name)),
      queryFn: () => getItemIamPolicy(id, resourceId(b.name)),
      retry: false,
      staleTime: 60_000,
    })),
  });
  const key = results.map((r) => r.data?.etag ?? "").join("|");
  return useMemo(() => {
    const out = new Map<string, Policy>();
    results.forEach((r, i) => {
      if (r.data) out.set(owned[i].name ?? "", r.data);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures the loaded policies
  }, [key]);
}

/** COLLECTION_ACCESS requests the caller filed or decides (Requests module on). */
export function useAccessRequests({ enabled = true }: { enabled?: boolean } = {}) {
  const { id, hasModule } = useWorkspace();
  return useQuery({
    queryKey: basesKeys.requests(id),
    queryFn: () => listAccessRequests(id),
    enabled: enabled && hasModule("requests"),
    staleTime: 30_000,
  });
}

/** Pending requests other people sent for this base (its owners decide them). */
export function usePendingRequestsFor(base: Item | null | undefined) {
  const { member } = useWorkspace();
  const all = useAccessRequests({ enabled: isOwner(base) });
  const data = useMemo(
    () => (all.data ?? []).filter((r) => r.collection === base?.name && r.requester !== member.name && isPendingRequest(r)),
    [all.data, base?.name, member.name],
  );
  return { ...all, data };
}

/** The caller's pending request for a base (`null` when none). */
export function useMyAccessRequest(baseName: string | null | undefined) {
  const { member } = useWorkspace();
  const all = useAccessRequests({ enabled: !!baseName });
  const data: AccessRequest | null = useMemo(
    () => (all.data ?? []).find((r) => r.collection === baseName && r.requester === member.name && isPendingRequest(r)) ?? null,
    [all.data, baseName, member.name],
  );
  return { ...all, data };
}

/** Active members and groups a base can be shared with. */
export function useSharePrincipals({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  const members = useQuery({ queryKey: basesKeys.people(id), queryFn: () => listActiveMembers(id), enabled, staleTime: 5 * 60_000 });
  const groups = useQuery({ queryKey: basesKeys.groups(id), queryFn: () => listGroups(id), enabled, staleTime: 5 * 60_000 });
  return { members, groups };
}
