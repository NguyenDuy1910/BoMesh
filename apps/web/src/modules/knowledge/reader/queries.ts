"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { toast } from "@/components/ui/Toast";
import { ApiError, errorMessage, resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { getItem, getItemContent, listContributions, listReadingListEntries, searchItems, testItemPermissions, type ReadingList } from "../api";
import { invalidateKnowledge, knowledgeKeys, useReadingLists } from "../queries";
import { conversationCitations, getPassage, listItemRevisions, processDocument } from "./api";

const SETTLING: Readonly<Record<string, true>> = { PENDING: true, RUNNING: true };

/** The document (FULL view). 403/404 are final; processing documents are re-read until they settle. */
export function useReaderItem(item: string) {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: knowledgeKeys.item(id, item),
    queryFn: () => getItem(id, item),
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    refetchInterval: (query) => (SETTLING[query.state.data?.document?.indexingState ?? ""] ? 10_000 : false),
  });
}

/**
 * Reader content of one revision (current when `revision` is empty). Signed URLs expire, so
 * a failed rendition download refetches this to re-sign them.
 */
export function useReaderContent(item: string, revision: string | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: [...knowledgeKeys.item(id, item), "content", revision ?? ""],
    queryFn: () => getItemContent(id, item, revision),
    enabled,
    staleTime: 4 * 60_000,
    retry: false,
  });
}

export function useRevisions(item: string, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: [...knowledgeKeys.item(id, item), "revisions"], queryFn: () => listItemRevisions(id, item), enabled, staleTime: 60_000 });
}

/** Cited passages (`?passage=`), each resolved through GetPassage; one that no longer resolves is `null`. */
export function usePassages(item: string, passages: readonly string[]) {
  const { id } = useWorkspace();
  const results = useQueries({
    queries: passages.map((passage) => ({
      queryKey: [...knowledgeKeys.item(id, item), "passage", passage],
      queryFn: () => getPassage(id, item, passage).catch((error: unknown) => {
        if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return null;
        throw error;
      }),
      staleTime: 10 * 60_000,
      retry: 1,
    })),
  });
  return {
    isPending: results.some((r) => r.isPending),
    data: results.map((r) => r.data ?? null),
  };
}

/** Passages a conversation cited in this document (`?from=`); none when the conversation can't be read. */
export function useConversationCitations(conversation: string, item: string) {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: [id, "conversations", "citations", conversation, item],
    queryFn: () => conversationCitations(id, conversation, item).catch(() => []),
    enabled: !!conversation,
    staleTime: 60_000,
  });
}

/** Whether the caller may (re)process this document (`ingestionRuns.create`). */
export function useCanProcess(item: string, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  const query = useQuery({
    queryKey: [...knowledgeKeys.itemPermissions(id, item), "process"],
    queryFn: () => testItemPermissions(id, item, ["ingestionRuns.create"]),
    enabled,
    staleTime: 60_000,
  });
  return !!query.data?.includes("ingestionRuns.create");
}

/** Publish now / Try again / Publish update: one ingestion run for this document. */
export function useProcessDocument() {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ item }: { item: string; title: string }) => processDocument(id, item),
    onSuccess: (_run, { title }) => {
      invalidateKnowledge(qc, id);
      toast(`Processing “${title}”`, { description: "It will be readable and searchable in a few minutes." });
    },
    onError: (error) => toast(errorMessage(error), { tone: "danger" }),
  });
}

/** Related documents (SearchItems `relatedItem`). */
export function useRelated(item: string, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: knowledgeKeys.search(id, { relatedItem: `workspaces/${id}/items/${item}`, pageSize: 6 }),
    queryFn: () => searchItems(id, { relatedItem: `workspaces/${id}/items/${item}`, pageSize: 6 }),
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

/**
 * Visible collections (reading lists) that include this document. ListReadingLists has no
 * item filter, so each visible list's entries are read (cached per list).
 */
export function useCollectionsIncluding(item: string, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  const lists = useReadingLists();
  const visible = useMemo(() => (enabled ? (lists.data ?? []).filter((l) => l.type !== "FEATURED").slice(0, 50) : []), [enabled, lists.data]);
  const entries = useQueries({
    queries: visible.map((list) => ({
      queryKey: knowledgeKeys.entries(id, resourceId(list.name)),
      queryFn: () => listReadingListEntries(id, resourceId(list.name)),
      staleTime: 60_000,
    })),
  });
  const data: ReadingList[] = visible.filter((_, i) => entries[i]?.data?.entries.some((e) => resourceId(e.item) === item));
  return {
    data,
    isPending: lists.isPending || entries.some((e) => e.isPending),
    isError: lists.isError || entries.some((e) => e.isError),
    error: lists.error ?? entries.find((e) => e.error)?.error ?? null,
    refetch: () => {
      void lists.refetch();
      entries.forEach((e) => void e.refetch());
    },
  };
}

/** The open (or declined) contribution this document is the candidate of, when the caller can see one. */
export function useSubmission(item: string, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: [...knowledgeKeys.contributions(id), "candidate", item],
    queryFn: async () => {
      const open = await listContributions(id, {
        filter: 'state = "ANALYZING" OR state = "IN_REVIEW" OR state = "CHANGES_REQUESTED" OR state = "REJECTED"',
        view: "FULL",
        pageSize: 500,
      });
      return open.find((c) => resourceId(c.item) === item) ?? null;
    },
    enabled,
    staleTime: 30_000,
  });
}
