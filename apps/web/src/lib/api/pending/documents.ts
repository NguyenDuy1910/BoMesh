/**
 * Local implementations of `document.move` (proposed `POST /documents/move`)
 * and `document.restore` (proposed `POST /documents/{document_id}/restore`).
 *
 * Both read real Documents and Collections to mirror authorization (reads
 * are allowed); neither writes to the server. A move is kept in this browser
 * as an overlay (`listLocalDocumentMoves`) that Knowledge screens apply to
 * the real lists. A restore cannot undo a delete the server already applied:
 * it returns a Document that is still live and answers 404 for one that is
 * gone, so the Undo of an archive must defer the real DELETE until its toast
 * closes while this endpoint is pending.
 */
import { ApiError, apiRequest } from "@/lib/api/request";
import { pendingCaller, pendingStore, requirePendingPermission } from "@/lib/api/pending";
import type {
  DocumentMoveFailure,
  DocumentMoveRequest,
  DocumentMoveResult,
  LocalDocumentMove,
} from "@/modules/knowledge/api";
import type { ContractDocument } from "@/modules/knowledge/knowledge-api";

const MOVE_LIMIT = 100;

interface CollectionPermissions {
  id: string;
  permissions: string[];
}

function movesStore() {
  const caller = pendingCaller();
  requirePendingPermission(caller, null, "");
  return pendingStore<Record<string, LocalDocumentMove>>("document.move", caller.accountId, caller.workspaceId, () => ({}));
}

/** Real reads answer 404 for what the caller cannot see; keep that as `null`. */
async function readOrNull<T>(path: string): Promise<T | null> {
  try {
    return await apiRequest<T>(path);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

const collection = (collectionId: string) =>
  readOrNull<CollectionPermissions>(`/collections/${encodeURIComponent(collectionId)}`);

const canUpdate = (value: CollectionPermissions | null) => Boolean(value?.permissions.includes("collection.update"));

export async function moveDocuments(body: DocumentMoveRequest): Promise<DocumentMoveResult> {
  const store = movesStore();
  const documentIds = [...new Set(body.document_ids)];
  if (documentIds.length === 0) throw new ApiError("Choose at least one document to move.", 422);
  if (documentIds.length > MOVE_LIMIT) throw new ApiError(`Move up to ${MOVE_LIMIT} documents at a time.`, 422);
  const target = await collection(body.collection_id);
  if (!target) throw new ApiError("That knowledge base isn't available.", 404);
  if (!canUpdate(target)) throw new ApiError("You can't add documents to that knowledge base.", 403);

  const moved: string[] = [];
  const failed: DocumentMoveFailure[] = [];
  const records: Record<string, LocalDocumentMove> = {};
  const movedAt = new Date().toISOString();
  for (const documentId of documentIds) {
    const document = await readOrNull<ContractDocument>(`/documents/${encodeURIComponent(documentId)}`);
    const current = document ? store.read()[documentId]?.document ?? document : null;
    if (!current) {
      failed.push({ document_id: documentId, reason: "not_found" });
    } else if (current.collection_id === target.id) {
      failed.push({ document_id: documentId, reason: "already_in_collection" });
    } else if (!canUpdate(await collection(current.collection_id))) {
      failed.push({ document_id: documentId, reason: "forbidden" });
    } else {
      moved.push(documentId);
      records[documentId] = {
        document: { ...current, collection_id: target.id, updated_at: movedAt },
        from_collection_id: current.collection_id,
        to_collection_id: target.id,
        moved_at: movedAt,
      };
    }
  }
  store.update((current) => ({ ...current, ...records }));
  return { moved, failed };
}

/** Moves kept in this browser, newest first, for screens to apply to real lists. */
export function listLocalDocumentMoves(): LocalDocumentMove[] {
  return Object.values(movesStore().read()).sort((a, b) => b.moved_at.localeCompare(a.moved_at));
}

export async function restoreDocument(documentId: string): Promise<ContractDocument> {
  requirePendingPermission(pendingCaller(), null, "");
  const document = await readOrNull<ContractDocument>(`/documents/${encodeURIComponent(documentId)}`);
  if (!document) {
    throw new ApiError("This document was already removed. Upload it again to bring it back.", 404);
  }
  if (!canUpdate(await collection(document.collection_id))) {
    throw new ApiError("You can't restore documents in this knowledge base.", 403);
  }
  return movesStore().read()[documentId]?.document ?? document;
}
