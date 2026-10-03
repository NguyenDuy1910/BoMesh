/** The knowledge workspace endpoints: Collections, and the Items inside them. */

import { apiRequest } from "@/lib/api/request";
import type { Ingestion } from "@/modules/knowledge/ingestions-api";
import type { ApiKnowledgeCollection, ApiKnowledgeDocument } from "@/modules/knowledge/view-model";

export interface KnowledgeHome {
  collections: ApiKnowledgeCollection[];
  recent_documents: ApiKnowledgeDocument[];
  personal_collection_id: string | null;
}

export interface KnowledgeCollectionPage {
  collection: ApiKnowledgeCollection;
  /** Every document in the collection, across all of its pages. */
  documents: ApiKnowledgeDocument[];
  total: number;
}

/** The largest page `/documents` serves. */
const DOCUMENT_PAGE_SIZE = 100;

export const knowledgeApi = {
  home: async (): Promise<KnowledgeHome> => {
    const value = await apiRequest<{ collections: ContractCollection[]; recent_documents: ContractDocument[]; personal_collection_id: string | null }>("/knowledge/home");
    return { collections: value.collections.map(toCollection), recent_documents: value.recent_documents.map(toDocument), personal_collection_id: value.personal_collection_id };
  },
  /**
   * A collection and all of its documents. The list is read whole, so
   * selecting "all" selects everything the collection holds, not one page.
   */
  collection: async (collectionId: string): Promise<KnowledgeCollectionPage> => {
    const documentsPage = (page: number) =>
      apiRequest<{ items: ContractDocument[]; total: number }>(
        `/documents?collection_id=${encodeURIComponent(collectionId)}&page=${page}&page_size=${DOCUMENT_PAGE_SIZE}`,
      );
    const [collection, first] = await Promise.all([
      apiRequest<ContractCollection>(`/collections/${encodeURIComponent(collectionId)}`),
      documentsPage(1),
    ]);
    const remaining = Math.max(0, Math.ceil(first.total / DOCUMENT_PAGE_SIZE) - 1);
    const rest = await Promise.all(Array.from({ length: remaining }, (_, index) => documentsPage(index + 2)));
    const documents = [first, ...rest].flatMap((page) => page.items);
    return { collection: toCollection(collection), documents: documents.map(toDocument), total: first.total };
  },
  /**
   * Index a document again from its stored content: a new run of its
   * Ingestion. Refused (409) while one is queued or running, and for a
   * document a connector wrote — its source's sync re-indexes it.
   */
  reindex: (documentId: string) =>
    apiRequest<Ingestion>(`/documents/${encodeURIComponent(documentId)}/ingestions`, { method: "POST" }),
  createCollection: (title: string, description?: string) =>
    apiRequest<{ id: string; title: string }>("/collections", {
      method: "POST",
      body: JSON.stringify({ title, description }),
    }),
  ensurePersonalCollection: () =>
    apiRequest<{ id: string; title: string }>("/collections/personal", {
      method: "PUT",
  }),
};

interface ContractCollection { id: string; title: string; description: string | null; parent_collection_id: string | null; document_count: number; source_count: number; updated_at: string; }
export interface ContractDocument {
  id: string;
  name: string;
  content_type: string;
  status: "pending_content" | "available" | "failed";
  /** Null when a connector wrote it, or its content never arrived. */
  latest_ingestion: Ingestion | null;
  updated_at: string;
}

const toCollection = (v: ContractCollection): ApiKnowledgeCollection => ({ ...v, parent_item_id: v.parent_collection_id });

/**
 * Where a document is, read from the document and the last time the pipeline
 * took it in. Available content with no ingestion behind it was written by a
 * connector, inside its source's sync, so it is already indexed.
 */
export function documentStatus(v: ContractDocument): ApiKnowledgeDocument["status"] {
  if (v.status === "pending_content") return "pending";
  if (v.status === "failed") return "failed";
  switch (v.latest_ingestion?.status) {
    case undefined:
    case "completed":
      return "ready";
    case "pending":
      return "pending";
    case "running":
      return "processing";
    default:
      return "failed";
  }
}

const toDocument = (v: ContractDocument): ApiKnowledgeDocument => ({
  id: v.id,
  title: v.name,
  content_type: v.content_type,
  document_type: null,
  status: documentStatus(v),
  updated_at: v.updated_at,
  latest_ingestion: v.latest_ingestion,
});
