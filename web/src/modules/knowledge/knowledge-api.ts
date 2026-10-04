/** The knowledge workspace endpoints: Collections, and the Items inside them. */

import { apiRequest } from "@/lib/api/request";
import type { DocumentProcessing } from "@/modules/ingestion/runs-api";
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
  createCollection: (title: string, description?: string) =>
    apiRequest<{ id: string; title: string }>("/collections", {
      method: "POST",
      body: JSON.stringify({ title, description }),
    }),
  ensurePersonalCollection: () =>
    apiRequest<{ id: string; title: string }>("/collections/personal", {
      method: "PUT",
  }),
  /** Who can open this collection, and as what. Needs `collection.share`. */
  collectionAccess: async (collectionId: string): Promise<CollectionGrant[]> =>
    (await apiRequest<{ items: CollectionGrant[] }>(
      `/collections/${encodeURIComponent(collectionId)}/access?page_size=100`,
    )).items,
  setCollectionAccess: (
    collectionId: string,
    grant: Pick<CollectionGrant, "principal_type" | "principal_id" | "role">,
  ) =>
    apiRequest<CollectionGrant>(
      `/collections/${encodeURIComponent(collectionId)}/access/${grant.principal_type}/${encodeURIComponent(grant.principal_id)}`,
      { method: "PUT", body: JSON.stringify({ role: grant.role }) },
    ),
  removeCollectionAccess: (
    collectionId: string,
    grant: Pick<CollectionGrant, "principal_type" | "principal_id">,
  ) =>
    apiRequest<void>(
      `/collections/${encodeURIComponent(collectionId)}/access/${grant.principal_type}/${encodeURIComponent(grant.principal_id)}`,
      { method: "DELETE" },
    ),
};

export type CollectionRole = "owner" | "editor" | "viewer";

/** One person or group holding a role on a collection (`CollectionAccess`). */
export interface CollectionGrant {
  collection_id: string;
  principal_type: "user" | "group";
  principal_id: string;
  principal_name: string | null;
  role: CollectionRole;
}

interface ContractCollection {
  id: string;
  title: string;
  description: string | null;
  parent_collection_id: string | null;
  document_count: number;
  source_count: number;
  updated_at: string;
  permissions: string[];
}

export interface ContractDocument {
  id: string;
  collection_id: string;
  name: string;
  content_type: string;
  size_bytes: number;
  processing: DocumentProcessing;
  updated_at: string;
}

/** What uploading a file answers: the Document it registered, pending. */
export interface DocumentCreateResult {
  document: ContractDocument;
  created: boolean;
}

const toCollection = (v: ContractCollection): ApiKnowledgeCollection => ({ ...v, parent_item_id: v.parent_collection_id });

const toDocument = (v: ContractDocument): ApiKnowledgeDocument => ({
  id: v.id,
  title: v.name,
  collection_id: v.collection_id,
  content_type: v.content_type,
  document_type: null,
  processing: v.processing,
  size_bytes: v.size_bytes,
  updated_at: v.updated_at,
});
