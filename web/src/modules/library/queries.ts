"use client";

import { useSyncExternalStore } from "react";

import { apiRevision, subscribeApiData } from "@/lib/api/revision";
import { useApiQuery } from "@/lib/hooks/useApiQuery";
import { knowledgeApi } from "@/modules/knowledge/knowledge-api";
import { knowledgeActions, useRefreshWhile } from "@/modules/knowledge/queries";
import { toWorkspaceDocument } from "@/modules/knowledge/view-model";
import type { WorkspaceKnowledgeDocument } from "@/modules/knowledge/workspace-repository";

export interface LibrarySnapshot {
  collectionId: string | null;
  collectionTitle: string;
  /** Whether the caller may run processing in their own Collection. */
  canProcess: boolean;
  documents: WorkspaceKnowledgeDocument[];
}

/**
 * The caller's own documents.
 *
 * Every workspace gives each member one private Collection, which is where
 * their uploads and the documents a conversation produced are kept. That
 * Collection is the library: there is no second place personal files live.
 * While a run is at work (`processing`) or a document is processing, the list
 * is read again so states move on their own.
 */
export function useLibrary(processing: boolean) {
  const revision = useSyncExternalStore(subscribeApiData, apiRevision, () => 0);
  const query = useApiQuery<LibrarySnapshot>(async () => {
    const home = await knowledgeApi.home();
    const collectionId = home.personal_collection_id;
    if (!collectionId) {
      return { collectionId: null, collectionTitle: "My documents", canProcess: true, documents: [] };
    }
    const page = await knowledgeApi.collection(collectionId);
    return {
      collectionId,
      collectionTitle: page.collection.title,
      canProcess: page.collection.permissions.includes("ingestion.run"),
      documents: page.documents.map((document) =>
        toWorkspaceDocument(document, page.collection.title),
      ),
    };
  }, revision);
  const { data, reload } = query;
  useRefreshWhile(
    processing || (data?.documents.some((document) => document.state === "processing") ?? false),
    data,
    reload,
  );
  return query;
}

export const libraryActions = {
  /** Store files in the caller's own Collection, creating it on first use. */
  async upload(files: File[], collectionId: string | null) {
    const target = collectionId ?? (await knowledgeApi.ensurePersonalCollection()).id;
    return knowledgeActions.upload(files, target);
  },
};
