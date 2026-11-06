/**
 * Artifacts (`/api/v1/workspaces/{workspace}/artifacts`): files the assistant
 * makes and Work outputs, with immutable revisions. Shared by the chat file
 * panel and the Work slice.
 *
 * Every function takes the bare workspace ID; `artifact` / `revision` accept a
 * bare ID or a full resource name (`workspaces/w/artifacts/a/revisions/3`).
 */
import { api, call, listAll, rawFetch, requestId, resourceId, type Schema } from "@/lib/api/client";

import type { ExportMimeType } from "./model";

export type Artifact = Schema<"Artifact">;
export type ArtifactKind = NonNullable<Artifact["kind"]>;
export type ArtifactState = NonNullable<Artifact["state"]>;
export type ArtifactRevision = Schema<"ArtifactRevision">;
export type ArtifactSnapshot = Schema<"ArtifactSnapshot">;
export type Operation = Schema<"Operation">;
export type ReviseArtifactRequest = Schema<"ReviseArtifactRequest">;
export type CommitArtifactRequest = Schema<"CommitArtifactRequest">;

const path = (workspace: string, artifact: string) => ({ workspace, artifact: resourceId(artifact) });
const revPath = (workspace: string, artifact: string, revision: string | number) => ({
  ...path(workspace, artifact),
  revision: resourceId(String(revision)),
});

/** `workspaces/w/artifacts/a` for a bare artifact ID. */
export function artifactName(workspace: string, artifact: string): string {
  return artifact.includes("/") ? artifact : `workspaces/${workspace}/artifacts/${artifact}`;
}

/* ═══════════════ Artifacts ═══════════════ */

export interface ListArtifactsOptions {
  /** AIP-160 on `kind`, `space`, `owner`, `conversation`, `state`. */
  filter?: string;
  orderBy?: string;
  pageSize?: number;
  pageToken?: string;
  showDeleted?: boolean;
  view?: "BASIC" | "FULL";
}

export function listArtifacts(workspace: string, options: ListArtifactsOptions = {}): Promise<Schema<"ListArtifactsResponse">> {
  return call(api.GET("/api/v1/workspaces/{workspace}/artifacts", { params: { path: { workspace }, query: options } }));
}

export function listAllArtifacts(workspace: string, options: Omit<ListArtifactsOptions, "pageToken"> = {}, limit = 1000): Promise<Artifact[]> {
  return listAll((pageToken) => listArtifacts(workspace, { pageSize: 200, ...options, pageToken }), (page) => page.artifacts, limit);
}

export async function getArtifact(workspace: string, artifact: string, view: "BASIC" | "FULL" = "FULL"): Promise<Artifact> {
  const data = await call(api.GET("/api/v1/workspaces/{workspace}/artifacts/{artifact}", { params: { path: path(workspace, artifact), query: { view } } }));
  // The media binding shares this path; without `alt=media` the body is always the Artifact.
  if (typeof data === "string") throw new Error("Unexpected artifact response.");
  return data;
}

/** CreateArtifact → Operation (`response` is the Artifact when done; the artifact exists at once, GENERATING). */
export function createArtifact(workspace: string, artifact: Artifact, idempotencyKey: string = requestId()): Promise<Operation> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/artifacts", {
      params: { path: { workspace }, query: { requestId: idempotencyKey } },
      body: artifact,
    }),
  );
}

/** UpdateArtifact: `displayName`, `audience`, `space`, `evidenceReview.options|criteria`. Put `etag` in `patch`. */
export function updateArtifact(workspace: string, artifact: string, patch: Artifact, updateMask: readonly string[]): Promise<Artifact> {
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/artifacts/{artifact}", {
      params: { path: path(workspace, artifact), query: { updateMask: updateMask.join(",") } },
      body: patch,
    }),
  );
}

export function deleteArtifact(workspace: string, artifact: string, etag?: string): Promise<Artifact> {
  return call(
    api.DELETE("/api/v1/workspaces/{workspace}/artifacts/{artifact}", { params: { path: path(workspace, artifact), query: etag ? { etag } : {} } }),
  );
}

export function undeleteArtifact(workspace: string, artifact: string, etag?: string): Promise<Artifact> {
  return call(api.POST("/api/v1/workspaces/{workspace}/artifacts/{artifact}:undelete", { params: { path: path(workspace, artifact) }, body: { etag } }));
}

/** ReviseArtifact ("Ask for changes") → Operation; the assistant writes a new revision. */
export function reviseArtifact(workspace: string, artifact: string, body: ReviseArtifactRequest): Promise<Operation> {
  return call(api.POST("/api/v1/workspaces/{workspace}/artifacts/{artifact}:revise", { params: { path: path(workspace, artifact) }, body }));
}

/** CommitArtifact: a person's edit of a text artifact becomes a USER revision. */
export function commitArtifact(workspace: string, artifact: string, body: CommitArtifactRequest): Promise<Artifact> {
  return call(api.POST("/api/v1/workspaces/{workspace}/artifacts/{artifact}:commit", { params: { path: path(workspace, artifact) }, body }));
}

/** PublishArtifact: a new PUBLISHED document in `collection` (full item name); returns the new item's name. */
export async function publishArtifact(workspace: string, artifact: string, collection: string, etag?: string): Promise<string> {
  const res = await call(
    api.POST("/api/v1/workspaces/{workspace}/artifacts/{artifact}:publish", {
      params: { path: path(workspace, artifact), query: { requestId: requestId() } },
      body: { collection, etag },
    }),
  );
  return res.item ?? "";
}

/* ═══════════════ Revisions ═══════════════ */

/** Every revision, newest first (text revisions carry their `snapshot.text`). */
export function listRevisions(workspace: string, artifact: string): Promise<ArtifactRevision[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/artifacts/{artifact}/revisions", {
          params: { path: path(workspace, artifact), query: { pageSize: 200, pageToken } },
        }),
      ),
    (page) => page.revisions,
  );
}

/** One revision with its snapshot and viewer preview (`pageAssets`, `rendition`). */
export function getRevision(workspace: string, artifact: string, revision: string | number): Promise<ArtifactRevision> {
  return call(api.GET("/api/v1/workspaces/{workspace}/artifacts/{artifact}/revisions/{revision}", { params: { path: revPath(workspace, artifact, revision) } }));
}

/** Deletes the newest USER revision (only within 10 minutes): the Undo of an edit. */
export async function deleteRevision(workspace: string, artifact: string, revision: string | number): Promise<void> {
  await call(api.DELETE("/api/v1/workspaces/{workspace}/artifacts/{artifact}/revisions/{revision}", { params: { path: revPath(workspace, artifact, revision) } }));
}

/** RollbackArtifact ("Restore"): a new revision copying `revision`; returns the artifact. */
export function rollbackRevision(workspace: string, artifact: string, revision: string | number, etag?: string): Promise<Artifact> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/artifacts/{artifact}/revisions/{revision}:rollback", {
      params: { path: revPath(workspace, artifact, revision) },
      body: { etag },
    }),
  );
}

/* ═══════════════ Content and downloads ═══════════════ */

export interface DownloadedFile {
  blob: Blob;
  /** From Content-Disposition when the browser can read it, else `fallbackName`. */
  fileName: string;
}

function fileNameFrom(response: Response, fallback: string): string {
  const header = response.headers.get("Content-Disposition") ?? "";
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  return match ? decodeURIComponent(match[1]) : fallback;
}

/** ExportArtifact: a revision (default current) rendered as CSV, PDF, Markdown or DOCX. */
export async function exportArtifact(
  workspace: string,
  artifact: string,
  mimeType: ExportMimeType,
  options: { revision?: string; fallbackName?: string } = {},
): Promise<DownloadedFile> {
  const query = new URLSearchParams({ mimeType });
  if (options.revision) query.set("revision", options.revision);
  const response = await rawFetch(`/api/v1/workspaces/${workspace}/artifacts/${resourceId(artifact)}:export?${query}`);
  return { blob: await response.blob(), fileName: fileNameFrom(response, options.fallbackName ?? "file") };
}

/** GetArtifact `alt=media`: the current revision's bytes exactly as stored. */
export async function downloadArtifactMedia(workspace: string, artifact: string, fallbackName = "file"): Promise<DownloadedFile> {
  const response = await rawFetch(`/api/v1/workspaces/${workspace}/artifacts/${resourceId(artifact)}?alt=media`);
  return { blob: await response.blob(), fileName: fileNameFrom(response, fallbackName) };
}

/** Hands a downloaded file to the browser. */
export function saveFile({ blob, fileName }: DownloadedFile): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/* ═══════════════ Operations ═══════════════ */

export function getOperation(name: string): Promise<Operation> {
  return call(api.GET("/api/v1/operations/{operation}", { params: { path: { operation: resourceId(name) } } }));
}

/**
 * Polls an operation until `done` (or the signal aborts). Resolves with the
 * finished operation; a failed one still resolves — check `error`.
 */
export async function waitForOperation(
  operation: Operation,
  { signal, intervalMs = 1500 }: { signal?: AbortSignal; intervalMs?: number } = {},
): Promise<Operation> {
  let current = operation;
  while (!current.done) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, intervalMs);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
    current = await getOperation(current.name);
  }
  return current;
}

/** The artifact name an artifact operation acts on (`metadata.artifact`). */
export function operationArtifact(operation: Operation): string | null {
  const value = operation.metadata?.artifact;
  return typeof value === "string" ? value : null;
}
