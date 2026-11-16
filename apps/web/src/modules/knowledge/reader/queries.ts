"use client";

import { useMutation, useQueries, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { toast } from "@/components/ui/Toast";
import { ApiError, errorMessage, resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { createIngestionRun } from "@/modules/curation/api";

import { getItem, getItemPreview, itemName, listContributions, listReadingListEntries, searchItems, testItemPermissions, type ItemPreview, type ReadingList } from "../api";
import { invalidateKnowledge, knowledgeKeys, useReadingLists } from "../queries";
import { conversationCitations, getPassage, listItemRevisions } from "./api";

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

/** A preview is read again this long before its signed URLs expire, so a view never starts on a dead URL. */
const URL_MARGIN_MS = 30_000;
/** While the preview engine makes the representation (`PREPARING`). */
const PREPARING_POLL_MS = 2_000;

/** A document's preview query, with `refresh()` for a view whose signed URL stopped working. */
export type ItemPreviewQuery = UseQueryResult<ItemPreview> & {
  /** Reads the preview again (fresh signed URLs); resolves to it, or `undefined` when the read failed. */
  refresh: () => Promise<ItemPreview | undefined>;
};

/**
 * How to show one revision of a document (current when `revision` is empty): `GetItemPreview`,
 * independent of processing. Polled every two seconds while PREPARING; fresh until shortly before
 * its signed URLs expire. `refresh()` is for a view whose storage read failed (a 403 from storage
 * means the URL expired).
 */
export function useItemPreview(item: string, revision: string | undefined, { enabled = true }: { enabled?: boolean } = {}): ItemPreviewQuery {
  const { id } = useWorkspace();
  const query = useQuery({
    queryKey: [...knowledgeKeys.item(id, item), "preview", revision ?? ""],
    queryFn: () => getItemPreview(id, item, revision),
    enabled,
    retry: false,
    staleTime: (q) => {
      const expires = Date.parse(q.state.data?.representation?.expireTime ?? q.state.data?.original?.expireTime ?? "");
      return Number.isFinite(expires) ? Math.max(0, expires - Date.now() - URL_MARGIN_MS) : 0;
    },
    refetchInterval: (q) => (q.state.data?.state === "PREPARING" ? PREPARING_POLL_MS : false),
  });
  const { refetch } = query;
  const refresh = useCallback(async () => (await refetch()).data, [refetch]);
  return { ...query, refresh };
}

export function useRevisions(item: string, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: [...knowledgeKeys.item(id, item), "revisions"], queryFn: () => listItemRevisions(id, item), enabled, staleTime: 60_000 });
}

/** Cited passages (`?passage=`), each resolved through GetPassage; one that no longer resolves is `null`. Stable between renders while unchanged. */
export function usePassages(item: string, passages: readonly string[]) {
  const { id } = useWorkspace();
  return useQueries({
    queries: passages.map((passage) => ({
      queryKey: [...knowledgeKeys.item(id, item), "passage", passage],
      queryFn: () => getPassage(id, item, passage).catch((error: unknown) => {
        if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return null;
        throw error;
      }),
      staleTime: 10 * 60_000,
      retry: 1,
    })),
    combine: combinePassages,
  });
}

function combinePassages<T>(results: readonly { isPending: boolean; data?: T | null }[]) {
  return { isPending: results.some((r) => r.isPending), data: results.map((r) => r.data ?? null) };
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

/** Process / Process again / Process the update: one ingestion run for this document (never publishes). */
export function useProcessDocument() {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ item }: { item: string; title: string }) => createIngestionRun(id, { selector: { items: [itemName(id, item)] } }),
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
 * Visible reading lists that include this document. ListReadingLists has no item filter, so each
 * visible list's entries are read (cached per list).
 */
export function useReadingListsIncluding(item: string, { enabled = true }: { enabled?: boolean } = {}) {
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
