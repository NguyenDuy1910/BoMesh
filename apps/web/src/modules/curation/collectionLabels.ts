"use client";

import { useMemo } from "react";

import { useCollectionPaths, useKnowledgeModel } from "@/modules/knowledge/queries";

/**
 * What the review and processing views call a collection: a root by its name ("My files" and members' files
 * included), a folder by its path ("Root › Folder"). Contributions and crawls often target folders, which the
 * knowledge model doesn't know; every name is read in one batch (roots too, so the request doesn't change once
 * the roots load).
 */
export function useCollectionLabels(names: readonly (string | undefined | null)[]): ReadonlyMap<string, string> {
  const { ctx } = useKnowledgeModel();
  const roots = ctx.collectionNames;
  const paths = useCollectionPaths(names);
  return useMemo(() => new Map([...paths, ...(roots ?? [])]), [paths, roots]);
}
