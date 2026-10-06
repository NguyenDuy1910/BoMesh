/**
 * The knowledge endpoints the Knowledge pages call: Collections ("knowledge
 * bases" to people), their ACL, and the Documents inside them. Shapes follow
 * OpenAPI `Collection`, `CollectionAccess`, `Document` and `KnowledgeHome`.
 */

import { apiRequest, queryString } from "@/lib/api/request";
import type { DocumentProcessing } from "@/modules/ingestion/runs-api";
import { uploadCollectionFile } from "@/lib/api/upload";

/** OpenAPI `Collection`, as the caller may see it. */
export interface Collection {
  id: string;
  title: string;
  description: string | null;
  parent_collection_id: string | null;
  status?: "active" | "archived";
  document_count: number;
  source_count: number;
  created_at?: string;
  updated_at: string;
  /** What the caller may do here (`collection.update`, `collection.share`, `ingestion.run`, …). */
  permissions: string[];
}

/** OpenAPI `Document`. */
export interface ContractDocument {
  id: string;
  collection_id: string;
  name: string;
  content_type: string;
  size_bytes: number;
  purpose?: "knowledge" | "conversation_attachment";
  processing: DocumentProcessing;
  created_at?: string;
  updated_at: string;
}

/** What uploading a file answers: the Document it registered, pending. */
export interface DocumentCreateResult {
  document: ContractDocument;
  created: boolean;
}

/** OpenAPI `KnowledgeHome`: the caller's readable collections and their own private one. */
export interface KnowledgeHome {
  collections: Collection[];
  recent_documents: ContractDocument[];
  personal_collection_id: string | null;
}

export type CollectionRole = "owner" | "editor" | "viewer";

/** One person or group holding a role on a collection (OpenAPI `CollectionAccess`). */
export interface CollectionGrant {
  collection_id: string;
  principal_type: "user" | "group";
  principal_id: string;
  /** Group name, else the person's name or email; null once they are gone. */
  principal_name: string | null;
  role: CollectionRole;
  created_at?: string;
  updated_at?: string;
}

export type GrantTarget = Pick<CollectionGrant, "principal_type" | "principal_id">;

/** The largest page `/documents` and `/collections/{id}/access` serve. */
const PAGE_SIZE = 100;

const collectionPath = (collectionId: string) => `/collections/${encodeURIComponent(collectionId)}`;
const grantPath = (collectionId: string, grant: GrantTarget) =>
  `${collectionPath(collectionId)}/access/${grant.principal_type}/${encodeURIComponent(grant.principal_id)}`;

export const knowledgeApi = {
  home: () => apiRequest<KnowledgeHome>("/knowledge/home"),

  /** 404 when it does not exist or is not shared with the caller; the API does not say which. */
  collection: (collectionId: string) => apiRequest<Collection>(collectionPath(collectionId)),

  /**
   * Every Document in a collection, across all of its pages, so filtering,
   * sorting and "select all" act on the whole knowledge base.
   */
  async documents(collectionId: string): Promise<ContractDocument[]> {
    const page = (number: number) =>
      apiRequest<{ items: ContractDocument[]; total: number }>(
        `/documents${queryString({ collection_id: collectionId, page: number, page_size: PAGE_SIZE })}`,
      );
    const first = await page(1);
    const remaining = Math.max(0, Math.ceil(first.total / PAGE_SIZE) - 1);
    const rest = await Promise.all(Array.from({ length: remaining }, (_, index) => page(index + 2)));
    return [first, ...rest].flatMap((result) => result.items);
  },

  /** Needs `knowledge.manage`; the creator becomes its owner. */
  createCollection: (body: { title: string; description?: string | null }) =>
    apiRequest<Collection>("/collections", { method: "POST", body: JSON.stringify(body) }),

  /** Needs `collection.update`. */
  updateCollection: (collectionId: string, body: { title?: string; description?: string | null }) =>
    apiRequest<Collection>(collectionPath(collectionId), { method: "PATCH", body: JSON.stringify(body) }),

  /** Tombstones the collection and its documents (`collection.delete`). */
  deleteCollection: (collectionId: string) =>
    apiRequest<void>(collectionPath(collectionId), { method: "DELETE" }),

  /** The caller's private collection ("My files"), created on first use. */
  ensurePersonalCollection: () =>
    apiRequest<{ id: string; title: string }>("/collections/personal", { method: "PUT" }),

  /** Who can open this collection, and as what. Needs `collection.share`. */
  async access(collectionId: string): Promise<CollectionGrant[]> {
    const page = await apiRequest<{ items: CollectionGrant[] }>(
      `${collectionPath(collectionId)}/access${queryString({ page_size: PAGE_SIZE })}`,
    );
    return page.items;
  },

  setAccess: (collectionId: string, grant: GrantTarget & { role: CollectionRole }) =>
    apiRequest<CollectionGrant>(grantPath(collectionId, grant), {
      method: "PUT",
      body: JSON.stringify({ role: grant.role }),
    }),

  removeAccess: (collectionId: string, grant: GrantTarget) =>
    apiRequest<void>(grantPath(collectionId, grant), { method: "DELETE" }),

  /** Stores one file as a pending Document; nothing is processed until a run asks. */
  uploadDocument: (collectionId: string, file: File, onProgress?: (fraction: number) => void) =>
    uploadCollectionFile<DocumentCreateResult>(collectionId, file, {
      idempotencyKey: crypto.randomUUID(),
      onProgress,
    }),

  /** Takes a Document out of normal use (tombstone); it stops appearing in answers. */
  deleteDocument: (documentId: string) =>
    apiRequest<void>(`/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" }),
};
