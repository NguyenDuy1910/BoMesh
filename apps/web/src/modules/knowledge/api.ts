"use client";

import { api, ApiError, ApiUnreachableError, call, listAll, rawFetch, requestId, resourceId, toApiError, type Schema } from "@/lib/api/client";
import { getApiUrl } from "@/lib/api/config";
import { handleUnauthenticated, sessionToken } from "@/lib/session";

/**
 * Knowledge API (`/api/v1`, openapi.yaml "Knowledge" + "Library"): items, search,
 * the member library (saved, recent, saved searches), reading lists, contributions,
 * topics, uploads and space materials. Every function takes the bare workspace ID;
 * item/list/contribution arguments accept a bare ID or a full resource name.
 */

export type Item = Schema<"Item">;
export type DocumentFacet = Schema<"DocumentFacet">;
export type SearchItemsRequest = Schema<"SearchItemsRequest">;
export type SearchItemsResponse = Schema<"SearchItemsResponse">;
export type SearchItemsResult = Schema<"SearchItemsResult">;
export type SearchItemsFacet = Schema<"SearchItemsFacet">;
export type SavedItem = Schema<"SavedItem">;
export type RecentItem = Schema<"RecentItem">;
export type SavedSearch = Schema<"SavedSearch">;
export type ReadingList = Schema<"ReadingList">;
export type ReadingListEntry = Schema<"ReadingListEntry">;
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
  "itemLinks.create",
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

export type ItemContent = Schema<"ItemContent">;

/** Reader representation (elements with page numbers, page images); `REVISION_NOT_RENDERED` until processed. `revision` = an older revision name/ID. */
export function getItemContent(workspace: string, item: string, revision?: string): Promise<ItemContent> {
  return call(
    api.GET("/api/v1/workspaces/{workspace}/items/{item}/content", {
      params: { path: it(workspace, item), query: revision ? { revision } : undefined },
    }),
  );
}

export function getItem(workspace: string, item: string, view: ItemView = "FULL"): Promise<Item> {
  return call(api.GET("/api/v1/workspaces/{workspace}/items/{item}", { params: { path: it(workspace, item), query: { view } } }));
}

export interface ListItemsOptions {
  /** AIP-160 filter (`parentItem`, `ancestors:`, `itemType`, `document.*`, `updateTime`). */
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

/** AIP-160 string literal. */
export const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Children of a collection (`parentItem = …`), collections first. */
export function listChildren(workspace: string, parentItem: string, options: Omit<ListItemsOptions, "filter"> & { filter?: string } = {}) {
  const parent = `parentItem = ${quote(itemName(workspace, parentItem))}`;
  return listItems(workspace, { orderBy: "itemType,displayName", ...options, filter: options.filter ? `${parent} AND (${options.filter})` : parent });
}

/** Root collections ("knowledge bases"); `showLocked` adds discoverable bases the caller can't read. */
export function listRootCollections(workspace: string, options: { showLocked?: boolean } = {}): Promise<Item[]> {
  return listAllItems(workspace, { filter: 'parentItem = "" AND itemType = COLLECTION', orderBy: "displayName", showLocked: options.showLocked });
}

export function searchItems(workspace: string, request: SearchItemsRequest): Promise<SearchItemsResponse> {
  return call(api.POST("/api/v1/workspaces/{workspace}/items:search", { params: { path: ws(workspace) }, body: request }));
}

/** PATCH with an explicit update mask (`displayName`, `document.documentType`, `document.topics`, …). */
export function updateItem(workspace: string, item: string, patch: Item, updateMask: readonly string[]): Promise<Item> {
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/items/{item}", {
      params: { path: it(workspace, item), query: { updateMask: updateMask.join(",") } },
      body: patch,
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
    itemType: "DOCUMENT",
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
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
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

export async function deleteRecentItem(workspace: string, item: string): Promise<void> {
  await call(
    api.DELETE("/api/v1/workspaces/{workspace}/members/{member}/recentItems/{recentItem}", {
      params: { path: { ...me(workspace), recentItem: resourceId(item) } },
    }),
  );
}

export async function clearRecentItems(workspace: string): Promise<void> {
  await call(api.POST("/api/v1/workspaces/{workspace}/members/{member}/recentItems:clear", { params: { path: me(workspace) }, body: {} }));
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

/* ═══════════════ Reading lists ("Collections" in the UI) ═══════════════ */

/** The workspace's FEATURED list (Home "Featured"). */
export const FEATURED_LIST = "featured";

export function listReadingLists(workspace: string, options: { filter?: string; orderBy?: string; showDeleted?: boolean } = {}): Promise<ReadingList[]> {
  return listAll(
    (pageToken) =>
      call(api.GET("/api/v1/workspaces/{workspace}/readingLists", { params: { path: ws(workspace), query: { pageSize: 200, ...options, pageToken } } })),
    (page) => page.readingLists,
  );
}

export function getReadingList(workspace: string, list: string): Promise<ReadingList> {
  return call(api.GET("/api/v1/workspaces/{workspace}/readingLists/{readingList}", { params: { path: { workspace, readingList: resourceId(list) } } }));
}

export function createReadingList(workspace: string, list: ReadingList, readingListId?: string): Promise<ReadingList> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/readingLists", {
      params: { path: ws(workspace), query: { readingListId, requestId: requestId() } },
      body: list,
    }),
  );
}

export function updateReadingList(workspace: string, list: string, patch: ReadingList, updateMask: readonly string[]): Promise<ReadingList> {
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/readingLists/{readingList}", {
      params: { path: { workspace, readingList: resourceId(list) }, query: { updateMask: updateMask.join(",") } },
      body: patch,
    }),
  );
}

export function deleteReadingList(workspace: string, list: string, etag?: string): Promise<ReadingList> {
  return call(
    api.DELETE("/api/v1/workspaces/{workspace}/readingLists/{readingList}", {
      params: { path: { workspace, readingList: resourceId(list) }, query: { etag } },
    }),
  );
}

export function undeleteReadingList(workspace: string, list: string): Promise<ReadingList> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/readingLists/{readingList}:undelete", {
      params: { path: { workspace, readingList: resourceId(list) } },
      body: {},
    }),
  );
}

export function copyReadingList(workspace: string, list: string, displayName?: string): Promise<ReadingList> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/readingLists/{readingList}:copy", {
      params: { path: { workspace, readingList: resourceId(list) } },
      body: { displayName },
    }),
  );
}

export interface ReadingListEntries {
  entries: ReadingListEntry[];
  hiddenItemCount: number;
}

export async function listReadingListEntries(workspace: string, list: string): Promise<ReadingListEntries> {
  let hidden = 0;
  const entries = await listAll(
    async (pageToken) => {
      const page = await call(
        api.GET("/api/v1/workspaces/{workspace}/readingLists/{readingList}/entries", {
          params: { path: { workspace, readingList: resourceId(list) }, query: { pageSize: 500, pageToken } },
        }),
      );
      hidden += page.hiddenItemCount ?? 0;
      return page;
    },
    (page) => page.entries,
  );
  return { entries, hiddenItemCount: hidden };
}

export function createReadingListEntry(workspace: string, list: string, item: string, note?: string): Promise<ReadingListEntry> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/readingLists/{readingList}/entries", {
      params: { path: { workspace, readingList: resourceId(list) }, query: { entryId: resourceId(item) } },
      body: { item: itemName(workspace, item), note },
    }),
  );
}

export function updateReadingListEntry(
  workspace: string,
  list: string,
  item: string,
  patch: Pick<ReadingListEntry, "note" | "position">,
  updateMask: readonly ("note" | "position")[],
): Promise<ReadingListEntry> {
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/readingLists/{readingList}/entries/{entry}", {
      params: { path: { workspace, readingList: resourceId(list), entry: resourceId(item) }, query: { updateMask: updateMask.join(",") } },
      body: patch,
    }),
  );
}

export async function deleteReadingListEntry(workspace: string, list: string, item: string): Promise<void> {
  await call(
    api.DELETE("/api/v1/workspaces/{workspace}/readingLists/{readingList}/entries/{entry}", {
      params: { path: { workspace, readingList: resourceId(list), entry: resourceId(item) } },
    }),
  );
}

/** Adds an item to the FEATURED list, creating the list on first use. */
export async function featureItem(workspace: string, item: string): Promise<void> {
  try {
    await createReadingListEntry(workspace, FEATURED_LIST, item);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
    await createReadingList(workspace, { displayName: "Featured on Home", audience: "WORKSPACE" }, FEATURED_LIST);
    await createReadingListEntry(workspace, FEATURED_LIST, item);
  }
}

/** Item IDs on the FEATURED list (empty when the list doesn't exist yet). */
export async function featuredItemIds(workspace: string): Promise<string[]> {
  try {
    const { entries } = await listReadingListEntries(workspace, FEATURED_LIST);
    return entries.map((e) => resourceId(e.item));
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) return [];
    throw error;
  }
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

export function listContributions(
  workspace: string,
  options: { filter?: string; orderBy?: string; view?: ItemView; pageSize?: number } = {},
): Promise<Contribution[]> {
  return listAll(
    (pageToken) =>
      call(api.GET("/api/v1/workspaces/{workspace}/contributions", { params: { path: ws(workspace), query: { pageSize: 200, ...options, pageToken } } })),
    (page) => page.contributions,
  );
}

/** The caller's own contributions, newest activity first. */
export function listMyContributions(workspace: string, options: { filter?: string; view?: ItemView } = {}): Promise<Contribution[]> {
  const mine = `contributor = ${quote(`workspaces/${workspace}/members/me`)}`;
  return listContributions(workspace, { orderBy: "updateTime desc", view: options.view, filter: options.filter ? `${mine} AND (${options.filter})` : mine });
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

/** Active topics and domains, ordered by name. */
export function listTopics(workspace: string, options: { filter?: string } = {}): Promise<Topic[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/topics", {
          params: { path: ws(workspace), query: { pageSize: 500, orderBy: "displayName", filter: options.filter ?? "state = ACTIVE", pageToken } },
        }),
      ),
    (page) => page.topics,
  );
}

/* ═══════════════ People, sources, spaces (lookups the knowledge UI shows) ═══════════════ */

export function getMember(workspace: string, member: string): Promise<Member> {
  return call(api.GET("/api/v1/workspaces/{workspace}/members/{member}", { params: { path: { workspace, member: resourceId(member) } } }));
}

export function getSource(workspace: string, source: string): Promise<Source> {
  return call(api.GET("/api/v1/workspaces/{workspace}/sources/{source}", { params: { path: { workspace, source: resourceId(source) } } }));
}

export function listSpaces(workspace: string): Promise<Space[]> {
  return listAll(
    (pageToken) => call(api.GET("/api/v1/workspaces/{workspace}/spaces", { params: { path: ws(workspace), query: { pageSize: 200, pageToken } } })),
    (page) => page.spaces,
  );
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

export function listMaterials(workspace: string, space: string): Promise<Material[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/spaces/{space}/materials", {
          params: { path: { workspace, space: resourceId(space) }, query: { pageSize: 1000, pageToken } },
        }),
      ),
    (page) => page.materials,
  );
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
