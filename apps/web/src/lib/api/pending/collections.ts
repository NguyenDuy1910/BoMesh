/**
 * Local implementations of `collection.general_access` (proposed
 * `PUT|DELETE /collections/{id}/access/workspace/{workspace_id}`, plus
 * `general_access` on Collection reads) and `collection.discovery` (proposed
 * `GET /collections?visibility=discoverable`).
 *
 * Both read real Collections and approval requests to mirror authorization
 * and never write to the server. General access is kept per workspace in this
 * browser and changes nothing about who the server lets read a collection.
 * Discovery never invents collections: it only lists real collection ids the
 * caller has already met but cannot read — addresses that answered 404 on
 * the knowledge base page, and the targets of the caller's own access
 * requests that are pending or were denied. Their titles are unknown here.
 */
import { ApiError, apiRequest } from "@/lib/api/request";
import { pendingCaller, pendingStore, requirePendingPermission } from "@/lib/api/pending";
import type {
  CollectionGeneralAccess,
  DiscoverableCollection,
  DiscoverableCollectionPage,
  GeneralAccess,
} from "@/modules/knowledge/api";
import { approvalRequestsApi } from "@/modules/manage/access/directory";

interface CollectionRead {
  id: string;
  permissions: string[];
}

function generalAccessStore() {
  const caller = pendingCaller();
  requirePendingPermission(caller, null, "");
  // A property of the collection, so it is shared by everyone in the workspace.
  return pendingStore<Record<string, CollectionGeneralAccess>>(
    "collection.general_access",
    null,
    caller.workspaceId,
    () => ({}),
  );
}

function metStore() {
  const caller = pendingCaller();
  return pendingStore<Record<string, { met_at: string }>>(
    "collection.discovery",
    caller.accountId,
    caller.workspaceId,
    () => ({}),
  );
}

async function readCollection(collectionId: string): Promise<CollectionRead | null> {
  try {
    return await apiRequest<CollectionRead>(`/collections/${encodeURIComponent(collectionId)}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function setGeneralAccess(
  collectionId: string,
  generalAccess: GeneralAccess,
): Promise<CollectionGeneralAccess> {
  const store = generalAccessStore();
  if (generalAccess !== "workspace" && generalAccess !== "restricted") {
    throw new ApiError("Choose who can see it: everyone in the workspace, or only people added.", 422);
  }
  const collection = await readCollection(collectionId);
  if (!collection) throw new ApiError("That knowledge base isn't available.", 404);
  if (!collection.permissions.includes("collection.share")) {
    throw new ApiError("Only the owners can change who can see this knowledge base.", 403);
  }
  const home = await apiRequest<{ personal_collection_id: string | null }>("/knowledge/home");
  if (home.personal_collection_id === collectionId) {
    throw new ApiError("My files stay private. Share a knowledge base instead.", 422);
  }
  const record: CollectionGeneralAccess = {
    collection_id: collectionId,
    general_access: generalAccess,
    updated_at: new Date().toISOString(),
  };
  store.update((current) => {
    const next = { ...current };
    // Restricted is what the server holds today, so it needs no local record.
    if (generalAccess === "restricted") delete next[collectionId];
    else next[collectionId] = record;
    return next;
  });
  return record;
}

/** General access set in this browser, by collection id. */
export function localGeneralAccess(): Record<string, CollectionGeneralAccess> {
  try {
    return generalAccessStore().read();
  } catch {
    return {};
  }
}

export function rememberUnreadable(collectionId: string): void {
  metStore().update((current) => ({ ...current, [collectionId]: { met_at: new Date().toISOString() } }));
}

export function forgetUnreadable(collectionId: string): void {
  metStore().update((current) => {
    const next = { ...current };
    delete next[collectionId];
    return next;
  });
}

export async function listDiscoverable(): Promise<DiscoverableCollectionPage> {
  const caller = pendingCaller();
  requirePendingPermission(caller, "knowledge.read", "You can't browse knowledge in this workspace.");
  const [home, requests] = await Promise.all([
    apiRequest<{ collections: { id: string }[] }>("/knowledge/home"),
    approvalRequestsApi.list({ request_type: "resource_access" }),
  ]);
  const readable = new Set(home.collections.map((collection) => collection.id));
  const met = metStore().read();
  const ids = new Set(Object.keys(met));
  for (const request of requests.items) {
    if (
      request.request_type === "resource_access"
      && request.requester.id === caller.accountId
      && (request.status === "pending" || request.status === "denied")
    ) ids.add(request.target_id);
  }
  const items: DiscoverableCollection[] = [...ids]
    .filter((id) => !readable.has(id))
    .map((id) => ({ id, title: null, description: null, general_access: "restricted", owner_label: null }));
  return { items, total: items.length };
}
