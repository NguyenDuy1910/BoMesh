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
  child_collections: ApiKnowledgeCollection[];
  documents: ApiKnowledgeDocument[];
  total: number;
  page: number;
  page_size: number;
}

export const knowledgeApi = {
  home: async (): Promise<KnowledgeHome> => {
    const value = await apiRequest<{ collections: ContractCollection[]; recent_documents: ContractDocument[]; personal_collection_id: string | null }>("/knowledge/home");
    return { collections: value.collections.map(toCollection), recent_documents: value.recent_documents.map(toDocument), personal_collection_id: value.personal_collection_id };
  },
  collection: async (collectionId: string, page = 1): Promise<KnowledgeCollectionPage> => {
    const [collection, documents] = await Promise.all([
      apiRequest<ContractCollection>(`/collections/${encodeURIComponent(collectionId)}`),
      apiRequest<{ items: ContractDocument[]; total: number; page: number; page_size: number }>(`/documents?collection_id=${encodeURIComponent(collectionId)}&page=${page}&page_size=100`),
    ]);
    return { collection: toCollection(collection), child_collections: [], documents: documents.items.map(toDocument), total: documents.total, page: documents.page, page_size: documents.page_size };
  },
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
interface ContractDocument {
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
function documentStatus(v: ContractDocument): ApiKnowledgeDocument["status"] {
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
