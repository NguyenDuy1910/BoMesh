"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

import { ApiError } from "@/lib/api/request";
import { apiRevision, subscribeApiData } from "@/lib/api/revision";
import { useApiQuery } from "@/lib/hooks/useApiQuery";
import { afterVisibleDelay } from "@/lib/hooks/usePolling";
import { sourcesApi, type Source } from "@/modules/ingestion/integrations-api";
import { listDiscoverableCollections, type DiscoverableCollection } from "@/modules/knowledge/api";
import {
  knowledgeApi,
  type Collection,
  type CollectionGrant,
  type ContractDocument,
} from "@/modules/knowledge/knowledge-api";
import { memberName, workspaceDirectoryApi } from "@/modules/manage/access/directory";

/** How long after an answer a list with documents in processing is read again. */
const REFRESH_MS = 3000;

function useRevision() {
  return useSyncExternalStore(subscribeApiData, apiRevision, () => 0);
}

/** The caller's readable knowledge bases and their private one (`GET /knowledge/home`). */
export function useKnowledgeHome() {
  const revision = useRevision();
  return useApiQuery(() => knowledgeApi.home(), revision);
}

/** Knowledge bases the caller has met but cannot read (`collection.discovery`, pending). */
export function useDiscoverableCollections(enabled: boolean) {
  const revision = useRevision();
  return useApiQuery<DiscoverableCollection[]>(
    async () => (enabled ? (await listDiscoverableCollections()).items : []),
    `${enabled}:${revision}`,
  );
}

export type CollectionView =
  | { kind: "ready"; collection: Collection; documents: ContractDocument[] | null; documentsError: string | null }
  /** 404: it does not exist, was archived, or is not shared with the caller. */
  | { kind: "unavailable" };

/**
 * One knowledge base and all of its documents. A collection the caller
 * cannot read answers 404 (never 403), and reads as `unavailable`.
 */
export function useCollectionView(collectionId: string) {
  const revision = useRevision();
  const query = useApiQuery<CollectionView>(async () => {
    const [collection, documents] = await Promise.allSettled([
      knowledgeApi.collection(collectionId),
      knowledgeApi.documents(collectionId),
    ]);
    if (collection.status === "rejected") {
      const cause = collection.reason;
      if (cause instanceof ApiError && (cause.status === 404 || cause.status === 403)) return { kind: "unavailable" };
      throw cause;
    }
    return {
      kind: "ready",
      collection: collection.value,
      documents: documents.status === "fulfilled" ? documents.value : null,
      documentsError: documents.status === "rejected"
        ? documents.reason instanceof Error ? documents.reason.message : "Documents didn’t load."
        : null,
    };
  }, `${collectionId}:${revision}`);

  const view = query.data;
  const processing = view?.kind === "ready"
    && Boolean(view.documents?.some((document) => document.processing.state === "processing"));
  useRefreshWhile(processing, view, query.reload);
  return query;
}

/**
 * Read again `REFRESH_MS` after each answer while `active`, and once more when
 * it stops: the read that saw the last work finish may predate the result.
 */
export function useRefreshWhile(active: boolean, data: unknown, reload: () => void) {
  const wasActive = useRef(false);
  useEffect(() => {
    if (active) {
      wasActive.current = true;
      return afterVisibleDelay(REFRESH_MS, reload);
    }
    if (wasActive.current) {
      wasActive.current = false;
      reload();
    }
  }, [active, data, reload]);
}

/** Sources whose destination is this knowledge base, as far as the caller may see them. */
export function useCollectionSources(collectionId: string, enabled: boolean) {
  const revision = useRevision();
  return useApiQuery<Source[]>(async () => {
    if (!enabled) return [];
    const page = await sourcesApi.list();
    return page.items.filter((source) => source.collection_id === collectionId);
  }, `${collectionId}:${enabled}:${revision}`);
}

/** Who can open this knowledge base, and as what (`collection.share`). */
export function useCollectionGrants(collectionId: string, enabled: boolean) {
  const revision = useRevision();
  return useApiQuery<CollectionGrant[]>(
    async () => (enabled ? knowledgeApi.access(collectionId) : []),
    `${collectionId}:${enabled}:${revision}`,
  );
}

export interface Principal {
  key: string;
  type: "user" | "group";
  id: string;
  name: string;
  /** Email for a person, member count for a group. */
  detail: string;
}

export const principalKey = (grant: Pick<CollectionGrant, "principal_type" | "principal_id">) =>
  `${grant.principal_type}:${grant.principal_id}`;

/**
 * The workspace's active people and groups, for sharing. Each list needs its
 * own directory permission; `null` means neither could be read.
 */
export function usePrincipals(enabled: boolean) {
  return useApiQuery<Principal[] | null>(async () => {
    if (!enabled) return [];
    const [groups, members] = await Promise.allSettled([workspaceDirectoryApi.groups(), workspaceDirectoryApi.members()]);
    if (groups.status === "rejected" && members.status === "rejected") return null;
    return [
      ...(groups.status === "fulfilled"
        ? groups.value.items
          .filter((group) => group.status === "active")
          .map((group) => ({
            key: `group:${group.id}`,
            type: "group" as const,
            id: group.id,
            name: group.display_name,
            detail: `${group.member_count.toLocaleString()} ${group.member_count === 1 ? "member" : "members"}`,
          }))
        : []),
      ...(members.status === "fulfilled"
        ? members.value.items
          .filter((member) => member.status === "active")
          .map((member) => ({
            key: `user:${member.id}`,
            type: "user" as const,
            id: member.id,
            name: memberName(member),
            detail: member.email,
          }))
        : []),
    ];
  }, String(enabled));
}
