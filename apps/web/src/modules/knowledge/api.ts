"use client";

import { api, ApiError, ApiUnreachableError, call, listAll, rawFetch, requestId, resourceId, toApiError, type Schema } from "@/lib/api/client";
import { getApiUrl } from "@/lib/api/config";
import { handleUnauthenticated, sessionToken } from "@/lib/session";

/**
 * Knowledge API (`/api/v1`, openapi.yaml "Knowledge" + "Library"): items, search,
 * the member library (saved, recent, saved searches), contributions,
 * topics, uploads and space materials. Every function takes the bare workspace ID;
 * item/list/contribution arguments accept a bare ID or a full resource name.
 */

export type Item = Schema<"Item">;
export type DocumentFacet = Schema<"DocumentFacet">;
export type DocumentCover = Schema<"DocumentCover">;
export type SearchItemsRequest = Schema<"SearchItemsRequest">;
export type SearchItemsResponse = Schema<"SearchItemsResponse">;
export type SearchItemsResult = Schema<"SearchItemsResult">;
export type SearchItemsFacet = Schema<"SearchItemsFacet">;
export type SavedItem = Schema<"SavedItem">;
export type RecentItem = Schema<"RecentItem">;
export type SavedSearch = Schema<"SavedSearch">;
export type Contribution = Schema<"Contribution">;
export type Topic = Schema<"Topic">;
export type Member = Schema<"Member">;
export type Space = Schema<"Space">;
export type Material = Schema<"Material">;
export type Source = Schema<"Source">;
export type ItemView = "BASIC" | "FULL";

/** Item-level permissions the UI tests with `items:testIamPermissions` (item_model.md §8). */
export const ITEM_PERMISSIONS = [
  "items.update",
  "items.publish",
  "items.verify",
  "items.move",
  "items.delete",
  "items.undelete",
  "items.create",
  "items.getIamPolicy",
  "items.setIamPolicy",
  "contributions.review",
  "itemShortcuts.create",
  "ingestionRuns.create",
] as const;
export type ItemPermission = (typeof ITEM_PERMISSIONS)[number];

const ws = (workspace: string) => ({ workspace });
const it = (workspace: string, item: string) => ({ workspace, item: resourceId(item) });
const me = (workspace: string) => ({ workspace, member: "me" });

/** Full item name for a bare ID or a name. */
export function itemName(workspace: string, item: string): string {
  return item.includes("/") ? item : `workspaces/${workspace}/items/${item}`;
}

/* ═══════════════ Items ═══════════════ */

export type ItemPreview = Schema<"ItemPreview">;

/**
 * How to show one revision of a document (`GetItemPreview`, document_viewer.md): the preview engine's
 * representation (one of six kinds, made once per revision) and the signed original. Independent of
 * processing; answers PREPARING until the representation is made. `revision` = an older revision name or number.
 */
export function getItemPreview(workspace: string, item: string, revision?: string): Promise<ItemPreview> {
  return call(
    api.GET("/api/v1/workspaces/{workspace}/items/{item}/preview", {
      params: { path: it(workspace, item), query: revision ? { revision } : undefined },
    }),
  );
}

export function getItem(workspace: string, item: string, view: ItemView = "FULL"): Promise<Item> {
  return call(api.GET("/api/v1/workspaces/{workspace}/items/{item}", { params: { path: it(workspace, item), query: { view } } }));
}

export interface ListItemsOptions {
  /** AIP-160 filter (`name`, `parentItem`, `ancestors:`, `itemKind`, `itemType`, `document.*`, `updateTime`). */
  filter?: string;
  orderBy?: string;
  pageSize?: number;
  pageToken?: string;
  showDeleted?: boolean;
  showLocked?: boolean;
  view?: ItemView;
}

export function listItems(workspace: string, options: ListItemsOptions = {}): Promise<Schema<"ListItemsResponse">> {
  return call(api.GET("/api/v1/workspaces/{workspace}/items", { params: { path: ws(workspace), query: options } }));
}

/** Every item matching the options (follows page tokens, up to `limit`). */
export function listAllItems(workspace: string, options: Omit<ListItemsOptions, "pageToken"> = {}, limit = 1000): Promise<Item[]> {
  return listAll((pageToken) => listItems(workspace, { pageSize: 200, ...options, pageToken }), (page) => page.items, limit);
}

/** Names per batch read: `name = "…"` terms stay under the server's 4096-character filter limit. */
const BATCH_NAMES = 35;

/**
 * Many items by name in one ListItems call per {@link BATCH_NAMES} names (`name = … OR …`).
 * Items the caller can't read under the visibility rule, deleted ones and missing ones are simply
 * absent (never the reviewer exception: candidates under review are GetItem-only). `showLocked`
 * returns named discoverable roots the caller can't read as LOCKED, as GetItem does.
 */
export async function batchGetItems(
  workspace: string,
  items: readonly string[],
  { view = "BASIC", showLocked }: { view?: ItemView; showLocked?: boolean } = {},
): Promise<Item[]> {
  const names = [...new Set(items.filter(Boolean).map((i) => itemName(workspace, i)))];
  const chunks: string[][] = [];
  for (let i = 0; i < names.length; i += BATCH_NAMES) chunks.push(names.slice(i, i + BATCH_NAMES));
  const pages = await Promise.all(
    chunks.map((chunk) => listItems(workspace, { filter: chunk.map((n) => `name = ${quote(n)}`).join(" OR "), pageSize: chunk.length, view, showLocked })),
  );
  return pages.flatMap((page) => page.items ?? []);
}

/** AIP-160 string literal. */
export const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Children of a collection (`parentItem = …`), collections first. */
export function listChildren(workspace: string, parentItem: string, options: Omit<ListItemsOptions, "filter"> & { filter?: string } = {}) {
  const parent = `parentItem = ${quote(itemName(workspace, parentItem))}`;
  return listItems(workspace, { orderBy: "itemKind,displayName", ...options, filter: options.filter ? `${parent} AND (${options.filter})` : parent });
}

/**
 * Root collections (the access boundaries): the shared ones plus the caller's own `personalCollection` ("My files"),
 * never other members' (one per member, so it would grow with the people; admins can read them). `showLocked` adds
 * discoverable collections the caller can't read.
 */
export function listRootCollections(workspace: string, options: { showLocked?: boolean; personalCollection?: string } = {}): Promise<Item[]> {
  const kinds = options.personalCollection ? `(itemType = STANDARD OR name = ${quote(options.personalCollection)})` : "itemType = STANDARD";
  return listAllItems(workspace, { filter: `parentItem = "" AND itemKind = COLLECTION AND ${kinds}`, orderBy: "displayName", showLocked: options.showLocked });
}

/** How long a search may take before the client gives up (the server's own deadline answers sooner). */
const SEARCH_DEADLINE_MS = 25_000;

/**
 * SearchItems. `signal` cancels it (react-query passes one per query); past {@link SEARCH_DEADLINE_MS} it fails with
 * DEADLINE_EXCEEDED like the server's deadline, so a stuck search ends in a retryable error, never an endless wait.
 */
export async function searchItems(workspace: string, request: SearchItemsRequest, { signal }: { signal?: AbortSignal } = {}): Promise<SearchItemsResponse> {
  const deadline = AbortSignal.timeout(SEARCH_DEADLINE_MS);
  try {
    return await call(
      api.POST("/api/v1/workspaces/{workspace}/items:search", {
        params: { path: ws(workspace) },
        body: request,
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      }),
    );
  } catch (error) {
    if (deadline.aborted && !signal?.aborted) throw new ApiError("Tìm kiếm mất quá nhiều thời gian. Hãy thử lại.", 504, "DEADLINE_EXCEEDED");
    throw error;
  }
}

/** PATCH with an explicit update mask (`displayName`, `document.topics`, `document.summary`, …). `keepalive`: the
 *  request outlives the page (a held change sent while the person reloads or leaves). */
export function updateItem(workspace: string, item: string, patch: Item, updateMask: readonly string[], { keepalive }: { keepalive?: boolean } = {}): Promise<Item> {
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/items/{item}", {
      params: { path: it(workspace, item), query: { updateMask: updateMask.join(",") } },
      body: patch,
      keepalive,
    }),
  );
}

export function publishItem(workspace: string, item: string, etag?: string): Promise<Item> {
  return call(api.POST("/api/v1/workspaces/{workspace}/items/{item}:publish", { params: { path: it(workspace, item) }, body: { etag } }));
}

export function unpublishItem(workspace: string, item: string, etag?: string): Promise<Item> {
  return call(api.POST("/api/v1/workspaces/{workspace}/items/{item}:unpublish", { params: { path: it(workspace, item) }, body: { etag } }));
}

export function verifyItem(workspace: string, item: string, etag?: string): Promise<Item> {
  return call(api.POST("/api/v1/workspaces/{workspace}/items/{item}:verify", { params: { path: it(workspace, item) }, body: { etag } }));
}

/** Soft delete ("Archive" in the UI); restorable for 30 days with `undeleteItem`. */
export function deleteItem(workspace: string, item: string, options: { etag?: string; force?: boolean } = {}): Promise<Item> {
  return call(api.DELETE("/api/v1/workspaces/{workspace}/items/{item}", { params: { path: it(workspace, item), query: options } }));
}

export function undeleteItem(workspace: string, item: string, etag?: string): Promise<Item> {
  return call(api.POST("/api/v1/workspaces/{workspace}/items/{item}:undelete", { params: { path: it(workspace, item) }, body: { etag } }));
}

/** Moves an item under another collection (full name) or the workspace name (collections only). */
export function moveItem(workspace: string, item: string, destinationParent: string, etag?: string): Promise<Item> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/items/{item}:move", { params: { path: it(workspace, item) }, body: { destinationParent, etag } }),
  );
}

/** The subset of `permissions` the caller holds on the item. */
export async function testItemPermissions(workspace: string, item: string, permissions: readonly string[] = ITEM_PERMISSIONS): Promise<string[]> {
  const res = await call(
    api.POST("/api/v1/workspaces/{workspace}/items/{item}:testIamPermissions", {
      params: { path: it(workspace, item) },
      body: { permissions: [...permissions] },
    }),
  );
  return res.permissions ?? [];
}

export function completeUpload(workspace: string, item: string, etag?: string): Promise<Item> {
  return call(api.POST("/api/v1/workspaces/{workspace}/items/{item}:completeUpload", { params: { path: it(workspace, item) }, body: { etag } }));
}

/** API path of a document's original (`?alt=media` → 302 to a short-lived signed URL). */
export function mediaPath(workspace: string, item: string): string {
  return `/api/v1/workspaces/${workspace}/items/${resourceId(item)}?alt=media`;
}

/**
 * Downloads a document's original through the authorized API (the redirect
 * target is a signed URL, so the browser follows it without credentials).
 */
export async function downloadItem(workspace: string, item: string, fileName: string): Promise<void> {
  const response = await rawFetch(mediaPath(workspace, item));
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/* ═══════════════ Uploads ═══════════════ */

export interface UploadDocumentInput {
  /** Collection name (full) the document goes into. */
  parentItem: string;
  file: File;
  /** Defaults to the file name without its extension. */
  displayName?: string;
  document?: Partial<Omit<DocumentFacet, "purpose">>;
  purpose?: DocumentFacet["purpose"];
}

/** Best MIME type for a file (browsers leave `type` empty for .md and some Office files). */
export function mimeOf(file: { name: string; type?: string }): string {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME[ext] ?? "application/octet-stream";
}

const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  rst: "text/x-rst",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  jsonl: "application/jsonl",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  html: "text/html",
  htm: "text/html",
  log: "text/plain",
  sql: "application/sql",
  zip: "application/zip",
};

/**
 * One-call upload (`POST /upload/api/v1/…/items`, multipart) with upload progress.
 * XMLHttpRequest because fetch exposes no upload progress. The document comes
 * back `contentState: AVAILABLE`; nothing is processed (document_contract.md).
 */
export function uploadDocument(
  workspace: string,
  input: UploadDocumentInput,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<Item> {
  const metadata: Item = {
    itemKind: "DOCUMENT",
    displayName: input.displayName ?? input.file.name.replace(/\.[^.]+$/, ""),
    parentItem: input.parentItem,
    document: { ...input.document, fileName: input.file.name, mimeType: mimeOf(input.file), purpose: input.purpose ?? "KNOWLEDGE" },
  };
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  form.append("file", input.file, input.file.name);
  const token = sessionToken();
  const authorization = token ? `Bearer ${token}` : null;
  return new Promise<Item>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${getApiUrl() ?? ""}/upload/api/v1/workspaces/${workspace}/items?requestId=${requestId()}`);
    if (authorization) xhr.setRequestHeader("Authorization", authorization);
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status === 401) handleUnauthenticated(authorization);
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve(xhr.response as Item);
      } else reject(toApiError(xhr.status, xhr.response));
    };
    xhr.onerror = () => reject(new ApiUnreachableError());
    xhr.onabort = () => reject(new DOMException("Đã hủy tải lên", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

/* ═══════════════ Member library (members/me) ═══════════════ */

export function listSavedItems(workspace: string): Promise<SavedItem[]> {
  return listAll(
    (pageToken) =>
      call(api.GET("/api/v1/workspaces/{workspace}/members/{member}/savedItems", { params: { path: me(workspace), query: { pageSize: 500, pageToken } } })),
    (page) => page.savedItems,
  );
}

export function createSavedItem(workspace: string, item: string): Promise<SavedItem> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/members/{member}/savedItems", {
      params: { path: me(workspace), query: { savedItemId: resourceId(item), requestId: requestId() } },
      body: { item: itemName(workspace, item) },
    }),
  );
}

export async function deleteSavedItem(workspace: string, item: string): Promise<void> {
  await call(
    api.DELETE("/api/v1/workspaces/{workspace}/members/{member}/savedItems/{savedItem}", {
      params: { path: { ...me(workspace), savedItem: resourceId(item) } },
    }),
  );
}

export async function listRecentItems(workspace: string, pageSize = 50): Promise<RecentItem[]> {
  const page = await call(
    api.GET("/api/v1/workspaces/{workspace}/members/{member}/recentItems", { params: { path: me(workspace), query: { pageSize } } }),
  );
  return page.recentItems ?? [];
}

/** Records a view (the Reader calls it on open). */
export function recordRecentItem(workspace: string, item: string): Promise<RecentItem> {
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/members/{member}/recentItems/{recentItem}", {
      params: { path: { ...me(workspace), recentItem: resourceId(item) }, query: { allowMissing: true } },
      body: { item: itemName(workspace, item) },
    }),
  );
}

export function listSavedSearches(workspace: string): Promise<SavedSearch[]> {
  return listAll(
    (pageToken) =>
      call(api.GET("/api/v1/workspaces/{workspace}/members/{member}/savedSearches", { params: { path: me(workspace), query: { pageSize: 200, pageToken } } })),
    (page) => page.savedSearches,
  );
}

export function createSavedSearch(workspace: string, search: SavedSearch): Promise<SavedSearch> {
  return call(api.POST("/api/v1/workspaces/{workspace}/members/{member}/savedSearches", { params: { path: me(workspace) }, body: search }));
}

export function updateSavedSearch(workspace: string, name: string, search: SavedSearch, updateMask: readonly string[]): Promise<SavedSearch> {
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/members/{member}/savedSearches/{savedSearch}", {
      params: { path: { ...me(workspace), savedSearch: resourceId(name) }, query: { updateMask: updateMask.join(",") } },
      body: search,
    }),
  );
}

export async function deleteSavedSearch(workspace: string, name: string): Promise<void> {
  await call(
    api.DELETE("/api/v1/workspaces/{workspace}/members/{member}/savedSearches/{savedSearch}", {
      params: { path: { ...me(workspace), savedSearch: resourceId(name) } },
    }),
  );
}

/* ═══════════════ Contributions ═══════════════ */

export function createContribution(workspace: string, contribution: Contribution): Promise<Contribution> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/contributions", {
      params: { path: ws(workspace), query: { requestId: requestId() } },
      body: contribution,
    }),
  );
}

export function getContribution(workspace: string, contribution: string, view: ItemView = "FULL"): Promise<Contribution> {
  return call(
    api.GET("/api/v1/workspaces/{workspace}/contributions/{contribution}", {
      params: { path: { workspace, contribution: resourceId(contribution) }, query: { view } },
    }),
  );
}

export function withdrawContribution(workspace: string, contribution: string, etag?: string): Promise<Contribution> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/contributions/{contribution}:withdraw", {
      params: { path: { workspace, contribution: resourceId(contribution) } },
      body: { etag },
    }),
  );
}

export function resubmitContribution(workspace: string, contribution: string, body: Schema<"ResubmitContributionRequest">): Promise<Contribution> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/contributions/{contribution}:resubmit", {
      params: { path: { workspace, contribution: resourceId(contribution) } },
      body,
    }),
  );
}

export async function deleteContribution(workspace: string, contribution: string): Promise<void> {
  await call(
    api.DELETE("/api/v1/workspaces/{workspace}/contributions/{contribution}", {
      params: { path: { workspace, contribution: resourceId(contribution) } },
    }),
  );
}

/* ═══════════════ Topics ═══════════════ */

/** Active topics and domains, ordered by name, in the BASIC view (no classification signals, evidence or review counts). */
export function listTopics(workspace: string, options: { filter?: string } = {}): Promise<Topic[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/topics", {
          params: { path: ws(workspace), query: { pageSize: 500, orderBy: "displayName", filter: options.filter ?? "state = ACTIVE", view: "BASIC", pageToken } },
        }),
      ),
    (page) => page.topics,
  );
}

/* ═══════════════ People, sources, spaces (lookups the knowledge UI shows) ═══════════════ */

export function getMember(workspace: string, member: string): Promise<Member> {
  return call(api.GET("/api/v1/workspaces/{workspace}/members/{member}", { params: { path: { workspace, member: resourceId(member) } } }));
}

/** Many members by ID or name in one ListMembers call per {@link BATCH_NAMES} names; missing ones are simply absent. */
export async function batchGetMembers(workspace: string, members: readonly string[]): Promise<Member[]> {
  const names = [...new Set(members.map((m) => resourceId(m)).filter(Boolean))].map((m) => `workspaces/${workspace}/members/${m}`);
  const chunks: string[][] = [];
  for (let i = 0; i < names.length; i += BATCH_NAMES) chunks.push(names.slice(i, i + BATCH_NAMES));
  const pages = await Promise.all(
    chunks.map((chunk) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/members", {
          params: { path: ws(workspace), query: { filter: chunk.map((n) => `name = ${quote(n)}`).join(" OR "), pageSize: chunk.length } },
        }),
      ),
    ),
  );
  return pages.flatMap((page) => page.members ?? []);
}

export function getSource(workspace: string, source: string): Promise<Source> {
  return call(api.GET("/api/v1/workspaces/{workspace}/sources/{source}", { params: { path: { workspace, source: resourceId(source) } } }));
}

export async function testSpacePermissions(workspace: string, space: string, permissions: readonly string[]): Promise<string[]> {
  const res = await call(
    api.POST("/api/v1/workspaces/{workspace}/spaces/{space}:testIamPermissions", {
      params: { path: { workspace, space: resourceId(space) } },
      body: { permissions: [...permissions] },
    }),
  );
  return res.permissions ?? [];
}

/** The space's materials pinning any of `items` (one ListMaterials read filtered by `item`; at most one per item). */
export async function materialsOf(workspace: string, space: string, items: readonly string[]): Promise<Material[]> {
  if (!items.length) return [];
  const page = await call(
    api.GET("/api/v1/workspaces/{workspace}/spaces/{space}/materials", {
      params: { path: { workspace, space: resourceId(space) }, query: { filter: items.map((it) => `item = ${quote(itemName(workspace, it))}`).join(" OR "), pageSize: items.length } },
    }),
  );
  return page.materials ?? [];
}

/** The material pinning `item` in a space, if any (one ListMaterials read filtered by `item`). */
export async function findMaterial(workspace: string, space: string, item: string): Promise<Material | null> {
  const page = await call(
    api.GET("/api/v1/workspaces/{workspace}/spaces/{space}/materials", {
      params: { path: { workspace, space: resourceId(space) }, query: { filter: `item = ${quote(itemName(workspace, item))}`, pageSize: 1 } },
    }),
  );
  return page.materials?.[0] ?? null;
}

export function createMaterial(workspace: string, space: string, item: string): Promise<Material> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/spaces/{space}/materials", {
      params: { path: { workspace, space: resourceId(space) }, query: { requestId: requestId() } },
      body: { item: itemName(workspace, item) },
    }),
  );
}

export async function deleteMaterial(workspace: string, material: string): Promise<void> {
  const [, , , space, , id] = material.split("/");
  await call(
    api.DELETE("/api/v1/workspaces/{workspace}/spaces/{space}/materials/{material}", {
      params: { path: { workspace, space, material: id } },
    }),
  );
}
