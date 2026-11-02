import { getApiConfiguration, requestIdentityHeaders } from "@/lib/api/config";
import { apiRequest } from "@/lib/api/request";
import type {
  KnowledgeCitationResponse,
  KnowledgeItemViewer,
} from "./types";
import type { ContractDocument } from "./knowledge-api";
import { pendingApi } from "@/lib/api/pending";
import * as pendingDocuments from "@/lib/api/pending/documents";
import * as pendingCollections from "@/lib/api/pending/collections";

/** `GET /documents/{document_id}`: the Document's metadata and processing state. */
export function getDocument(documentId: string, signal?: AbortSignal): Promise<ContractDocument> {
  return apiRequest<ContractDocument>(`/documents/${encodeURIComponent(documentId)}`, { signal });
}

/** A viewer request failed before any source content was exposed. */
export class KnowledgeViewerRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function getKnowledgeItemViewer(
  itemId: string,
  chunkId?: string,
  signal?: AbortSignal,
): Promise<KnowledgeItemViewer> {
  const configuration = getApiConfiguration();
  if (!configuration) throw new Error("Knowledge viewer is not configured.");
  const query = chunkId ? `?chunk=${encodeURIComponent(chunkId)}` : "";
  const response = await fetch(
    `${configuration.apiUrl}/api/v1/knowledge/documents/${encodeURIComponent(itemId)}${query}`,
    {
      cache: "no-store",
      headers: requestIdentityHeaders(configuration),
      signal,
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new KnowledgeViewerRequestError(
      response.status,
      detail || `Could not open this knowledge item (${response.status}).`,
    );
  }
  return await response.json() as KnowledgeItemViewer;
}

/** Where one cited passage sits in a document: its spans, pages and section. */
export function getKnowledgeCitation(
  documentId: string,
  chunkId: string,
  signal?: AbortSignal,
): Promise<KnowledgeCitationResponse> {
  return apiRequest<KnowledgeCitationResponse>(
    `/knowledge/documents/${encodeURIComponent(documentId)}/citations/${encodeURIComponent(chunkId)}`,
    { signal },
  );
}

export interface DocumentMoveRequest {
  document_ids: string[];
  /** The destination knowledge base (Collection). */
  collection_id: string;
}

export type DocumentMoveFailureReason = "not_found" | "forbidden" | "already_in_collection";

export interface DocumentMoveFailure {
  document_id: string;
  reason: DocumentMoveFailureReason;
}

export interface DocumentMoveResult {
  moved: string[];
  failed: DocumentMoveFailure[];
}

/** A move kept in this browser while `document.move` is pending. */
export interface LocalDocumentMove {
  /** The Document as it reads after the move. */
  document: ContractDocument;
  from_collection_id: string;
  to_collection_id: string;
  moved_at: string;
}

/** API pending: `POST /documents/move` (`collection.update` on source and target). */
export async function moveDocuments(body: DocumentMoveRequest): Promise<DocumentMoveResult> {
  return pendingApi("document.move", () => pendingDocuments.moveDocuments(body));
}

/**
 * Part of `document.move`: moves kept in this browser, newest first. Knowledge
 * lists apply them to real rows (drop from the source, add to the target)
 * until the endpoint exists; delete this with the pending implementation.
 */
export function listLocalDocumentMoves(): LocalDocumentMove[] {
  return pendingDocuments.listLocalDocumentMoves();
}

/** API pending: `POST /documents/{document_id}/restore` (`collection.update`). */
export async function restoreDocument(documentId: string): Promise<ContractDocument> {
  return pendingApi("document.restore", () => pendingDocuments.restoreDocument(documentId));
}

/** Who can find and read a knowledge base besides the people and groups it is shared with. */
export type GeneralAccess = "workspace" | "restricted";

export interface CollectionGeneralAccess {
  collection_id: string;
  general_access: GeneralAccess;
  updated_at: string | null;
}

/**
 * API pending: `PUT /collections/{collection_id}/access/workspace/{workspace_id}`
 * `{ role: "viewer" }` for `workspace`, `DELETE` of that grant for
 * `restricted` (`collection.share`).
 */
export async function setCollectionGeneralAccess(
  collectionId: string,
  body: { general_access: GeneralAccess },
): Promise<CollectionGeneralAccess> {
  return pendingApi("collection.general_access", () =>
    pendingCollections.setGeneralAccess(collectionId, body.general_access));
}

/**
 * Part of `collection.general_access`: general access set in this browser,
 * by collection id. Collection reads will carry `general_access`; until then
 * a collection without an entry is restricted, which is what the server holds.
 */
export function localCollectionGeneralAccess(): Record<string, CollectionGeneralAccess> {
  return pendingCollections.localGeneralAccess();
}

/** A knowledge base the caller may ask to join but cannot read (no content). */
export interface DiscoverableCollection {
  id: string;
  /** Null when the caller has never been told its name. */
  title: string | null;
  description: string | null;
  general_access: GeneralAccess;
  /** "Owned by Legal"; null when unknown. */
  owner_label: string | null;
}

export interface DiscoverableCollectionPage {
  items: DiscoverableCollection[];
  total: number;
}

/** API pending: `GET /collections?visibility=discoverable` (`knowledge.read`). */
export async function listDiscoverableCollections(): Promise<DiscoverableCollectionPage> {
  return pendingApi("collection.discovery", () => pendingCollections.listDiscoverable());
}

/**
 * Part of `collection.discovery`: remember a real collection id that
 * answered 404 to the caller, so it can be listed as locked. Forget it once
 * it opens, or when asking for access shows it does not exist.
 */
export function rememberUnreadableCollection(collectionId: string): void {
  pendingCollections.rememberUnreadable(collectionId);
}

export function forgetUnreadableCollection(collectionId: string): void {
  pendingCollections.forgetUnreadable(collectionId);
}
