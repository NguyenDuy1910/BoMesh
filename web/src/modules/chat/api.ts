import { getApiConfiguration, requestIdentityHeaders } from "@/lib/api/config";
import { pendingApi } from "@/lib/api/pending";
import * as pendingArtifacts from "@/lib/api/pending/artifacts";
import * as pendingConversationShares from "@/lib/api/pending/conversation-shares";
import { ApiError, apiRequest, queryString } from "@/lib/api/request";
import { invalidateApiData } from "@/lib/api/revision";
import { ingestionRunsApi } from "@/modules/ingestion/runs-api";
import type { KnowledgePreview } from "@/modules/knowledge/types";
import { uploadCollectionFile } from "@/lib/api/upload";
import { StreamEventDeduplicator } from "./stream-deduplicator";
import type {
  AgentHistoryMessage,
  ConversationDocument,
  ResponseStreamEvent,
} from "./types";

const uploadIdempotencyKeys = new WeakMap<File, string>();

export class ChatConfigurationError extends Error {
  constructor() {
    super(
      "Chat is unavailable. Sign in, or configure the explicit local development identity."
    );
  }
}

export async function streamAgentResponse(
  message: string,
  options: {
    conversationId?: string | null;
    history: AgentHistoryMessage[];
    attachmentIds?: string[];
    collectionItemIds?: string[];
    signal: AbortSignal;
    onEvent: (event: ResponseStreamEvent) => void;
  }
): Promise<void> {
  const configuration = getApiConfiguration();
  if (!configuration) throw new ChatConfigurationError();

  const response = await fetch(`${configuration.apiUrl}/api/v1/agent/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...requestIdentityHeaders(configuration),
    },
    signal: options.signal,
    body: JSON.stringify({
      message,
      conversation_id: options.conversationId ?? null,
      history: options.history,
      attachment_ids: options.attachmentIds ?? [],
      collection_ids: options.collectionItemIds ?? [],
    }),
  });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `Chat request failed (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deduplicator = new StreamEventDeduplicator();

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = done ? "" : lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        const event = JSON.parse(payload) as ResponseStreamEvent;
        if (!deduplicator.shouldAccept(event)) continue;
        options.onEvent(event);
      } catch {
        throw new Error("Received an invalid agent stream event.");
      }
    }
    if (done) break;
  }
}

interface DocumentCreateResult {
  upload?: DocumentUploadTarget | null;
  document: DocumentResponse;
}

interface DocumentUploadTarget {
  mode: "presigned";
  url: string;
  method: string;
  headers: Record<string, string>;
  expires_at: string;
}

interface DocumentResponse {
  id: string;
  name: string;
  content_type: string;
  size_bytes: number;
  status: "pending_content" | "available" | "failed";
}

/**
 * Where an upload stands: reserving the document, sending bytes (with the
 * fraction sent), then the server reading what arrived.
 */
export type UploadStage = "starting" | "uploading" | "reading";

export async function uploadConversationDocument(
  file: File,
  options: {
    signal: AbortSignal;
    onProgress?: (stage: UploadStage, fraction?: number) => void;
  },
): Promise<ConversationDocument> {
  const configuration = getApiConfiguration();
  if (!configuration) throw new ChatConfigurationError();
  options.onProgress?.("starting");
  const identityHeaders = requestIdentityHeaders(configuration);
  const collectionResponse = await fetch(`${configuration.apiUrl}/api/v1/collections/personal`, {
    method: "PUT",
    headers: identityHeaders,
    signal: options.signal,
  });
  if (!collectionResponse.ok) throw await responseError(collectionResponse, "Could not prepare document collection.");
  const collection = await collectionResponse.json() as { id: string };
  const startResponse = await fetch(`${configuration.apiUrl}/api/v1/collections/${encodeURIComponent(collection.id)}/documents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": uploadIdempotencyKey(file),
      ...identityHeaders,
    },
    signal: options.signal,
    body: JSON.stringify({
      name: file.name,
      content_type: file.type || "application/octet-stream",
      size_bytes: file.size,
      purpose: "conversation_attachment",
    }),
  });
  if (!startResponse.ok) {
    throw await responseError(startResponse, "Could not start document upload.");
  }
  const started = await startResponse.json() as DocumentCreateResult;
  if (!started.upload) return documentFromResponse(started.document);

  options.onProgress?.("uploading", 0);
  const uploadStatus = await uploadToTarget(
    started.upload,
    file,
    options.signal,
    (fraction) => options.onProgress?.("uploading", fraction),
  );
  if (uploadStatus < 200 || uploadStatus >= 300) {
    throw new Error("Storage refused the file. Try again.");
  }

  options.onProgress?.("reading");
  const completeResponse = await fetch(
    `${configuration.apiUrl}/api/v1/documents/${encodeURIComponent(started.document.id)}/content`,
    {
      method: "PUT",
      headers: identityHeaders,
      signal: options.signal,
    },
  );
  if (!completeResponse.ok) {
    throw await responseError(completeResponse, "Could not validate the uploaded document.");
  }
  const completed = await completeResponse.json() as { document: DocumentResponse };
  return documentFromResponse(completed.document);
}

export async function releaseConversationDocument(documentId: string): Promise<void> {
  const configuration = getApiConfiguration();
  if (!configuration) throw new ChatConfigurationError();
  const response = await fetch(
    `${configuration.apiUrl}/api/v1/documents/${encodeURIComponent(documentId)}`,
    {
      method: "DELETE",
      headers: requestIdentityHeaders(configuration),
    },
  );
  if (!response.ok && response.status !== 404) {
    throw await responseError(response, "Could not remove the document.");
  }
}

/**
 * Whether the caller can still open a cited document. Saved chats outlive
 * access changes, so citations are re-checked against the document itself:
 * the API hides an unreadable document as 404.
 */
export async function getDocumentAccess(
  documentId: string,
  signal?: AbortSignal,
): Promise<"readable" | "unreadable"> {
  try {
    await apiRequest(`/documents/${encodeURIComponent(documentId)}`, { signal });
    return "readable";
  } catch (cause) {
    if (cause instanceof ApiError && (cause.status === 403 || cause.status === 404)) return "unreadable";
    throw cause;
  }
}

/** A document the caller can read, as the "Add from knowledge" picker lists it. */
export interface KnowledgeDocumentChoice {
  id: string;
  name: string;
  collection_id: string;
  content_type: string;
  size_bytes: number;
  updated_at: string;
}

/**
 * Documents the caller can read, newest first, optionally matching `search`.
 * Conversation uploads are not knowledge and are left out.
 */
export async function listKnowledgeDocuments(
  search: string,
  signal?: AbortSignal,
): Promise<KnowledgeDocumentChoice[]> {
  const page = await apiRequest<{ items: (KnowledgeDocumentChoice & { purpose?: string })[] }>(
    `/documents${queryString({ search: search.trim(), page_size: 100 })}`,
    { signal },
  );
  return page.items.filter((document) => document.purpose !== "conversation_attachment");
}

/**
 * Save an answer as a Markdown document in the caller's personal knowledge
 * base ("My files"), then ask for it to be processed so it becomes
 * searchable. Processing is best effort: the document is saved either way.
 */
export async function saveAnswerToPersonalFiles(
  fileName: string,
  markdown: string,
): Promise<{ collectionId: string; documentId: string }> {
  const collection = await apiRequest<{ id: string }>("/collections/personal", { method: "PUT" });
  const file = new File([markdown], fileName, { type: "text/markdown" });
  const created = await uploadCollectionFile<{ document: { id: string } }>(collection.id, file, {
    idempotencyKey: crypto.randomUUID(),
  });
  await ingestionRunsApi.create({ document_ids: [created.document.id], trigger: "manual" }).catch(() => undefined);
  invalidateApiData();
  return { collectionId: collection.id, documentId: created.document.id };
}

/** One readable document, for "Ask about this document" (`/chat?doc=`). */
export async function getKnowledgeDocument(
  documentId: string,
  signal?: AbortSignal,
): Promise<KnowledgeDocumentChoice> {
  return apiRequest<KnowledgeDocumentChoice>(`/documents/${encodeURIComponent(documentId)}`, { signal });
}

export interface ArtifactRevision {
  revision: number;
  summary: string | null;
  size_bytes: number;
  created_at: string | null;
  download_url: string | null;
  /** The revision this one restored (proposed `artifact.manual_revision`); absent or null otherwise. */
  restored_from?: number | null;
  /** Who made it (proposed with `artifact.manual_revision`): the agent or a person; absent until the server reports it. */
  author?: "assistant" | "user" | null;
}

export interface ArtifactDetail {
  id: string;
  title: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  revision: number;
  revision_count: number;
  conversation_id: string | null;
  source_document_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  download_url: string | null;
  revisions: ArtifactRevision[];
}

export interface ArtifactContent {
  artifact_id: string;
  revision: number;
  mime_type: string;
  content: string;
  truncated: boolean;
  /** The document viewer's preview of the current revision of a binary file. */
  preview?: KnowledgePreview | null;
}

/** A Collection the caller may read — the publish destination picker's options. */
export interface Collection {
  id: string;
  title: string;
  parent_collection_id: string | null;
}

export interface ArtifactPublishResult {
  artifact_id: string;
  revision: number;
  item_id: string;
  collection_id: string;
  title: string;
  status: string;
  created: boolean;
}

/** Download URLs are short-lived, so the detail is fetched when it is acted on. */
export async function getArtifact(
  artifactId: string,
  signal?: AbortSignal,
): Promise<ArtifactDetail> {
  return artifactRequest<ArtifactDetail>(
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}`,
    { signal },
    "Could not load the document.",
  );
}

export async function getArtifactContent(
  artifactId: string,
  revision: number,
  signal?: AbortSignal,
): Promise<ArtifactContent> {
  return artifactRequest<ArtifactContent>(
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/revisions/${revision}/content`,
    { signal },
    "Could not load the document content.",
  );
}

/**
 * The Collections the caller may publish an artifact into.
 *
 * Reuses the same listing the chat knowledge-scope picker uses — there is no
 * separate "template library" kind of Collection to enumerate; any Collection
 * the caller can write to is a valid publish destination.
 */
export async function listCollections(signal?: AbortSignal): Promise<Collection[]> {
  const result = await artifactRequest<{ items: Collection[] }>(
    "/api/v1/collections?page_size=100",
    { signal },
    "Could not load your collections.",
  );
  return result.items;
}

export async function publishArtifact(
  artifactId: string,
  collectionId: string,
  options: { title?: string | null } = {},
): Promise<ArtifactPublishResult> {
  return artifactRequest<ArtifactPublishResult>(
    `/api/v1/artifacts/${encodeURIComponent(artifactId)}/publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collection_id: collectionId, ...(options.title ? { title: options.title } : {}) }),
    },
    "Could not publish the document to the Knowledge Base.",
  );
}

/**
 * A hand-made revision (`artifact.manual_revision`). `content` is required
 * unless `restored_from` names the revision whose content to copy.
 */
export interface ArtifactRevisionCreate {
  content?: string | null;
  summary: string;
  restored_from?: number | null;
}

/** A revision kept in this browser while `artifact.manual_revision` is pending. */
export interface LocalArtifactRevision extends ArtifactRevision {
  restored_from: number | null;
  content: string;
  mime_type: string;
}

export interface ArtifactUpdate {
  title: string;
}

export type ArtifactExportFormat = "csv" | "pdf" | "md";

/** API pending: `POST /artifacts/{artifact_id}/revisions` (artifact owner). */
export async function createArtifactRevision(
  artifactId: string,
  body: ArtifactRevisionCreate,
): Promise<ArtifactRevision> {
  return pendingApi("artifact.manual_revision", () => pendingArtifacts.createArtifactRevision(artifactId, body));
}

/**
 * API pending (part of `artifact.manual_revision`): `DELETE
 * /artifacts/{artifact_id}/revisions/{revision}` — the Undo after a hand edit
 * or restore. Only the current revision, only one a person made.
 */
export async function deleteArtifactRevision(artifactId: string, revision: number): Promise<void> {
  return pendingApi("artifact.manual_revision", () => pendingArtifacts.deleteArtifactRevision(artifactId, revision));
}

/**
 * Part of `artifact.manual_revision` / `artifact.rename`: hand-made revisions
 * (with their content) kept in this browser for one artifact, oldest first.
 * Delete with the pending implementation once the server keeps them.
 */
export function listLocalArtifactRevisions(artifactId: string): LocalArtifactRevision[] {
  return pendingArtifacts.listLocalArtifactRevisions(artifactId);
}

/**
 * Part of `artifact.manual_revision` / `artifact.rename`: the real detail
 * with this browser's title and hand-made revisions merged in. Apply it to
 * every `getArtifact` result while those features are pending.
 */
export function applyLocalArtifactChanges(detail: ArtifactDetail): ArtifactDetail {
  return pendingArtifacts.applyLocalArtifactChanges(detail);
}

/** Fired on `window` after a file is renamed in this browser. */
export const ARTIFACT_RENAMED_EVENT = "bomesh:artifact-renamed";

/** API pending: `PATCH /artifacts/{artifact_id}` `{ title }` (artifact owner). */
export async function renameArtifact(artifactId: string, body: ArtifactUpdate): Promise<ArtifactDetail> {
  const renamed = await pendingApi("artifact.rename", () => pendingArtifacts.renameArtifact(artifactId, body));
  window.dispatchEvent(new Event(ARTIFACT_RENAMED_EVENT));
  return renamed;
}

/**
 * Part of `artifact.rename`: this browser's title for a file, or null. File
 * cards in a thread show it in place of the title the answer recorded.
 */
export function localArtifactTitle(artifactId: string): string | null {
  return pendingArtifacts.localArtifactTitle(artifactId);
}

/** API pending: `GET /artifacts/{artifact_id}/revisions/{revision}/export?format=` (artifact read). */
export async function exportArtifactRevision(
  artifactId: string,
  revision: number,
  format: ArtifactExportFormat,
): Promise<Blob> {
  return pendingApi("artifact.export_formats", () => pendingArtifacts.exportArtifactRevision(artifactId, revision, format));
}

export type ConversationShareAudience = "workspace" | "people";

/** One cited document of a shared answer: the `[n]` marker it answers to. */
export interface ConversationShareSource {
  number: number;
  document_id: string;
  /** The passage the reader lands on in the document reader. */
  chunk_id: string;
  title: string;
}

/** One message as the share keeps it; sources are filtered per recipient. */
export interface ConversationShareMessage {
  role: "user" | "assistant";
  content: string;
  /** Documents the message cites; recipients only see the ones they can read. */
  sources?: ConversationShareSource[];
}

/**
 * A cited document as a recipient sees it: readable ones keep their identity,
 * the rest are bare markers with no title or id.
 */
export type SharedConversationSource =
  | (ConversationShareSource & { available: true })
  | { number: number; available: false };

/** A shared chat as its recipient reads it (`GET /conversation-shares/{share_id}`). */
export interface SharedConversation {
  id: string;
  title: string;
  audience: ConversationShareAudience;
  created_at: string;
  created_by: { id: string; display_name: string | null };
  messages: { role: "user" | "assistant"; content: string; sources: SharedConversationSource[] }[];
}

/** Conversations are device-local, so a share carries what it shows. */
export interface ConversationShareSnapshot {
  title: string;
  messages: ConversationShareMessage[];
}

export interface ConversationShareCreate {
  audience: ConversationShareAudience;
  /**
   * Required (one or more) when `audience` is `people`: members of this
   * workspace by email. People know each other's addresses, while member ids
   * need the member directory (`user.manage`), which most members don't have.
   */
  emails?: string[];
  snapshot: ConversationShareSnapshot;
}

export interface ConversationShare {
  id: string;
  conversation_id: string;
  audience: ConversationShareAudience;
  /** The members a `people` share is for, normalized to lower case. */
  emails: string[];
  /** App-relative link: `/s/<id>`. */
  url: string;
  message_count: number;
  created_at: string;
  created_by: { id: string; display_name: string | null };
  revoked_at: string | null;
}

/** API pending: `POST /conversations/{conversation_id}/shares` (conversation owner). */
export async function createConversationShare(
  conversationId: string,
  body: ConversationShareCreate,
): Promise<ConversationShare> {
  return pendingApi("chat.share", () => pendingConversationShares.createConversationShare(conversationId, body));
}

/** API pending: `GET /conversations/{conversation_id}/shares` — active links (conversation owner). */
export async function listConversationShares(conversationId: string): Promise<ConversationShare[]> {
  return pendingApi("chat.share", () => pendingConversationShares.listConversationShares(conversationId));
}

/**
 * API pending: `GET /conversation-shares/{share_id}` — the snapshot, for a
 * workspace member (`workspace` audience) or a listed person (`people`).
 */
export async function getConversationShare(shareId: string): Promise<SharedConversation> {
  return pendingApi("chat.share", () => pendingConversationShares.getConversationShare(shareId));
}

/** API pending: `DELETE /conversations/{conversation_id}/shares/{share_id}` (conversation owner). */
export async function revokeConversationShare(conversationId: string, shareId: string): Promise<void> {
  return pendingApi("chat.share", () => pendingConversationShares.revokeConversationShare(conversationId, shareId));
}

async function artifactRequest<T>(
  path: string,
  init: RequestInit,
  fallback: string,
): Promise<T> {
  const configuration = getApiConfiguration();
  if (!configuration) throw new ChatConfigurationError();
  const response = await fetch(`${configuration.apiUrl}${path}`, {
    ...init,
    cache: "no-store",
    headers: { ...(init.headers ?? {}), ...requestIdentityHeaders(configuration) },
  });
  if (!response.ok) throw await responseError(response, fallback);
  return await response.json() as T;
}

/**
 * Send the bytes to the presigned target. XHR, not fetch: only XHR reports
 * upload progress. Resolves with the storage response status.
 */
function uploadToTarget(
  target: DocumentUploadTarget,
  file: File,
  signal: AbortSignal,
  onFraction: (fraction: number) => void,
): Promise<number> {
  // The target lib predates Promise.withResolvers, so the executor form it is.
  return new Promise<number>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Upload cancelled.", "AbortError"));
      return;
    }
    const request = new XMLHttpRequest();
    request.open(target.method, target.url);
    for (const [name, value] of Object.entries(target.headers)) request.setRequestHeader(name, value);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onFraction(event.loaded / event.total);
    };
    request.onload = () => resolve(request.status);
    request.onerror = () => reject(new Error("The upload couldn’t reach storage. Check your connection and try again."));
    request.onabort = () => reject(new DOMException("Upload cancelled.", "AbortError"));
    signal.addEventListener("abort", () => request.abort(), { once: true });
    request.send(file);
  });
}

function uploadIdempotencyKey(file: File): string {
  const existing = uploadIdempotencyKeys.get(file);
  if (existing) return existing;
  const created = crypto.randomUUID();
  uploadIdempotencyKeys.set(file, created);
  return created;
}

function documentFromResponse(value: DocumentResponse): ConversationDocument {
  const directTypes = new Set([
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
  ]);
  const direct = value.size_bytes <= 20 * 1024 * 1024 && (
    directTypes.has(value.content_type)
  );
  return {
    id: value.id,
    fileName: value.name,
    contentType: value.content_type,
    sizeBytes: value.size_bytes,
    mode: direct ? "direct" : "indexed",
    status: value.status === "available" ? "available" : "failed",
  };
}

/** The server's message, keeping the HTTP status so callers can tell "gone" from "failed". */
async function responseError(response: Response, fallback: string) {
  try {
    const value = await response.json() as { detail?: unknown };
    if (typeof value.detail === "string" && value.detail) return new ApiError(value.detail, response.status);
  } catch {
    // The caller still receives a stable fallback for non-JSON errors.
  }
  return new ApiError(fallback, response.status);
}
