/**
 * Finding documents the caller may read: by name, by content, or recently
 * updated. Every request goes through the permission-filtered Document APIs,
 * so a result is never something the caller could not open.
 */

import { apiRequest, queryString } from "@/lib/api/request";
import type { ProcessingState } from "@/modules/ingestion/runs-api";
import { type ContractDocument, knowledgeApi } from "@/modules/knowledge/knowledge-api";

/** Where a found passage sits in its document. */
export interface DocumentMatch {
  chunkId: string;
  excerpt: string;
  page?: number;
  section?: string;
}

export interface FoundDocument {
  id: string;
  name: string;
  collectionId: string | null;
  updatedAt: string | null;
  status: ProcessingState;
  /** The passage that matched a content search, strongest first. */
  match?: DocumentMatch;
}

interface ContractSearchResult {
  document_id: string;
  collection_id: string;
  name: string;
  excerpt: string;
  metadata?: {
    chunk_id?: string;
    section_path?: string[];
    citation?: { page_start?: number | null; section?: string | null };
  };
}

const NAME_RESULT_LIMIT = 6;
const CONTENT_RESULT_LIMIT = 20;

/** Documents whose name contains the query. Fast enough to run while typing. */
export async function findDocumentsByName(
  query: string,
  signal?: AbortSignal,
): Promise<FoundDocument[]> {
  const page = await apiRequest<{ items: ContractDocument[] }>(
    `/documents${queryString({ search: query, page_size: NAME_RESULT_LIMIT })}`,
    { signal },
  );
  return page.items.map((document) => ({
    id: document.id,
    name: document.name,
    collectionId: document.collection_id,
    updatedAt: document.updated_at,
    status: document.processing.state,
  }));
}

/**
 * Documents whose processed content answers the query, one entry per document.
 *
 * The search ranks passages; a document keeps its strongest passage, so the
 * list reads as documents while still showing why each one was found.
 */
export async function findDocumentsByContent(
  query: string,
  signal?: AbortSignal,
): Promise<FoundDocument[]> {
  const result = await apiRequest<{ items: ContractSearchResult[] }>(
    "/documents/search",
    {
      method: "POST",
      body: JSON.stringify({ query, top_k: CONTENT_RESULT_LIMIT }),
      signal,
    },
  );
  const documents = new Map<string, FoundDocument>();
  for (const item of result.items) {
    if (documents.has(item.document_id)) continue;
    const citation = item.metadata?.citation;
    const section = citation?.section ?? item.metadata?.section_path?.at(-1);
    documents.set(item.document_id, {
      id: item.document_id,
      name: item.name,
      collectionId: item.collection_id,
      updatedAt: null,
      // Only processed content can match, so every content result is ready.
      status: "ready",
      match: item.metadata?.chunk_id
        ? {
            chunkId: item.metadata.chunk_id,
            excerpt: item.excerpt,
            page: citation?.page_start ?? undefined,
            section: section ?? undefined,
          }
        : undefined,
    });
  }
  return [...documents.values()];
}

/** What the caller worked with most recently, for an empty search. */
export async function recentDocuments(): Promise<FoundDocument[]> {
  const home = await knowledgeApi.home();
  return home.recent_documents.map((document) => ({
    id: document.id,
    name: document.title,
    collectionId: document.collection_id,
    updatedAt: document.updated_at,
    status: document.processing.state,
  }));
}
