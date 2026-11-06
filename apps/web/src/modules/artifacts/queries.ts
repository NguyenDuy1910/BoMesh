"use client";

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { listRootCollections, testItemPermissions, type Item } from "@/modules/knowledge/api";

import { getArtifact, getRevision, listRevisions } from "./api";
import { versionsOf } from "./model";

export const artifactKeys = {
  all: (ws: string) => [ws, "artifacts"] as const,
  one: (ws: string, artifact: string) => [ws, "artifacts", resourceId(artifact)] as const,
  revisions: (ws: string, artifact: string) => [ws, "artifacts", resourceId(artifact), "revisions"] as const,
  revision: (ws: string, artifact: string, n: number) => [ws, "artifacts", resourceId(artifact), "revisions", n] as const,
  publishTargets: (ws: string) => [ws, "artifacts", "publish-targets"] as const,
};

/** Refresh an artifact and its versions after a change. */
export function invalidateArtifact(qc: QueryClient, ws: string, artifact: string) {
  return qc.invalidateQueries({ queryKey: artifactKeys.one(ws, artifact) });
}

/** The artifact; polled while the assistant is writing it (GENERATING). */
export function useArtifact(artifact: string | null | undefined) {
  const { id } = useWorkspace();
  const key = resourceId(artifact);
  return useQuery({
    queryKey: artifactKeys.one(id, key),
    queryFn: () => getArtifact(id, key),
    enabled: !!key,
    refetchInterval: (query) => (query.state.data?.state === "GENERATING" ? 2000 : false),
  });
}

/** Every version, oldest first. Re-read whenever the artifact's current revision moves. */
export function useVersions(artifact: string | null | undefined, current: string | undefined) {
  const { id } = useWorkspace();
  const key = resourceId(artifact);
  const query = useQuery({
    queryKey: [...artifactKeys.revisions(id, key), current ?? ""],
    queryFn: () => listRevisions(id, key),
    enabled: !!key,
  });
  const versions = useMemo(() => versionsOf(query.data ?? []), [query.data]);
  return { ...query, versions };
}

/**
 * One version with its viewer preview (`pageAssets`, `rendition`). The list
 * carries a preview only for the current version, so binary files read
 * other versions here.
 */
export function useRevisionPreview(artifact: string, n: number, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: artifactKeys.revision(id, artifact, n),
    queryFn: () => getRevision(id, artifact, n),
    enabled: enabled && n > 0,
    staleTime: 5 * 60_000,
  });
}

export interface PublishTarget {
  item: Item;
  personal: boolean;
}

/** Knowledge bases the caller may add documents to (`items.create`), plus "My files". */
export function usePublishTargets({ enabled = true }: { enabled?: boolean } = {}) {
  const { id, member } = useWorkspace();
  return useQuery({
    queryKey: artifactKeys.publishTargets(id),
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<PublishTarget[]> => {
      // Other people's "My files" (an admin may write to them) aren't offered, like the knowledge picker.
      const roots = (await listRootCollections(id)).filter(
        (base) => base.access !== "LOCKED" && base.state !== "DELETED" && (base.collection?.kind !== "PERSONAL" || base.name === member.personalCollection),
      );
      const allowed = await Promise.all(
        roots.map(async (base) => (await testItemPermissions(id, resourceId(base.name), ["items.create"]).catch((): string[] => [])).includes("items.create")),
      );
      const targets = roots.filter((_, i) => allowed[i]).map((item) => ({ item, personal: item.collection?.kind === "PERSONAL" }));
      const personal = member.personalCollection;
      if (personal && !targets.some((t) => t.item.name === personal)) {
        targets.push({ item: { name: personal, displayName: "My files", itemType: "COLLECTION", collection: { kind: "PERSONAL" } }, personal: true });
      }
      return targets.sort((a, b) => Number(a.personal) - Number(b.personal));
    },
  });
}
