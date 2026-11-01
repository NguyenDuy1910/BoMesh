/**
 * What only an administrator can fix right now, built from real reads:
 * sources that stopped syncing, people waiting on a decision, and documents
 * that could not be processed. Each item carries exactly one action, linked
 * to the screen that resolves it.
 *
 * A read is made only when the caller holds the permission its fix needs,
 * so nobody is shown a problem they cannot act on.
 */

import { hasSessionPermission, type AuthSession } from "@/lib/auth/session";
import { sourceAttention, sourceName } from "@/modules/ingestion/connection-state";
import { describeConnector } from "@/modules/ingestion/connectors";
import { collectionsApi, connectionsApi, sourcesApi } from "@/modules/ingestion/integrations-api";
import {
  approvalRequestsApi,
  REVIEW_PERMISSION,
  type ApprovalRequest,
  type WorkspaceOverview,
} from "@/modules/manage/access/directory";
import { formatRelative, pluralize } from "@/lib/format";

export type AttentionTone = "err" | "warn" | "info";
export type AttentionIcon = "plug" | "alert" | "people" | "document" | "upload";

export interface AttentionItem {
  id: string;
  tone: AttentionTone;
  icon: AttentionIcon;
  title: string;
  detail: string;
  action: { label: string; href: string };
}

/** "A", "A and B", "A, B and C". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

async function sourceItems(): Promise<AttentionItem[]> {
  const [sources, connections, collections] = await Promise.all([
    sourcesApi.list(),
    connectionsApi.list(),
    collectionsApi.list(),
  ]);
  const connectionById = new Map(connections.items.map((connection) => [connection.id, connection]));
  const collectionTitle = new Map(collections.items.map((collection) => [collection.id, collection.title]));
  // The same rule as the Sources page call-out and the sidebar badge.
  const { reconnect, failed } = sourceAttention(sources.items, connections.items);

  const byConnection = new Map<string, typeof reconnect>();
  for (const source of reconnect) {
    byConnection.set(source.connection_id, [...(byConnection.get(source.connection_id) ?? []), source]);
  }
  const expired = [...byConnection].map(([connectionId, stopped]): AttentionItem => {
    const connection = connectionById.get(connectionId);
    const app = connection ? describeConnector(connection.connector_key, connection.display_name).name : "The app";
    const first = sourceName(stopped[0]);
    const title = stopped.length === 1 ? `${first} stopped syncing` : `${first} and ${pluralize(stopped.length - 1, "other source")} stopped syncing`;
    const when = connection?.last_checked_at ? ` ${formatRelative(connection.last_checked_at)}` : "";
    const destinations = [...new Set(stopped.map((source) => collectionTitle.get(source.collection_id)).filter(Boolean))] as string[];
    const missing = destinations.length
      ? ` · ${joinNames(destinations)} ${destinations.length === 1 ? "isn’t" : "aren’t"} getting updates`
      : "";
    return {
      id: `connection:${connectionId}`,
      tone: "err",
      icon: "plug",
      title,
      detail: `${app} access expired${when}${missing}`,
      action: { label: "Reconnect", href: `/manage/sources?reconnect=${encodeURIComponent(connectionId)}` },
    };
  });
  const broken = failed.map((source): AttentionItem => ({
    id: `source:${source.id}`,
    tone: "err",
    icon: "alert",
    title: `${sourceName(source)} couldn’t sync`,
    detail: source.sync?.error ?? "The last sync failed.",
    action: { label: "Review", href: `/manage/sources?source=${encodeURIComponent(source.id)}` },
  }));
  return [...expired, ...broken];
}

async function requestItems(session: AuthSession): Promise<AttentionItem[]> {
  const page = await approvalRequestsApi.list({ status: "pending" });
  // The server also lists the caller's own requests; only decisions they can make belong here.
  const reviewable = page.items.filter(
    (request) => request.status === "pending" && hasSessionPermission(session, REVIEW_PERMISSION[request.request_type]),
  );
  const items: AttentionItem[] = [];
  const access = reviewable.filter((request) => request.request_type === "resource_access");
  if (access.length) {
    const collections = await collectionsApi.list();
    const title = new Map(collections.items.map((collection) => [collection.id, collection.title]));
    const people = new Set(access.map((request) => request.requester.id));
    const targets = [...new Set(access.map((request) => title.get(request.target_id)).filter(Boolean))] as string[];
    items.push({
      id: "requests:access",
      tone: "info",
      icon: "people",
      title: people.size === 1 ? `${requesterName(access[0])} is waiting for access` : `${people.size} people are waiting for access`,
      detail: targets.length ? `To ${joinNames(targets)}` : pluralize(access.length, "request"),
      action: { label: "Review", href: requestsHref(access) },
    });
  }
  const connectors = reviewable.filter((request) => request.request_type === "plugin_installation");
  if (connectors.length) {
    const names = [...new Set(connectors.map((request) => describeConnector(request.target_id).name))];
    items.push({
      id: "requests:connectors",
      tone: "info",
      icon: "plug",
      title: connectors.length === 1
        ? `${requesterName(connectors[0])} asked to add ${names[0]}`
        : `${connectors.length} connector requests are waiting`,
      detail: connectors.length === 1 ? (connectors[0].reason ? `“${connectors[0].reason}”` : "Decide whether people can connect it.") : joinNames(names),
      action: { label: "Review", href: requestsHref(connectors) },
    });
  }
  return items;
}

function requesterName(request: ApprovalRequest): string {
  return request.requester.display_name?.trim() || request.requester.email;
}

function requestsHref(requests: readonly ApprovalRequest[]): string {
  return requests.length === 1
    ? `/manage/access?tab=requests&request=${encodeURIComponent(requests[0].id)}`
    : "/manage/access?tab=requests";
}

/** Document problems, from the overview's own counts so the two never disagree. */
export function documentAttention(session: AuthSession, overview: WorkspaceOverview): AttentionItem[] {
  const items: AttentionItem[] = [];
  const failed = overview.knowledge.failed;
  if (failed > 0) {
    // Failed documents are retried from the sync that processed them.
    const canRetry = hasSessionPermission(session, "ingestion.read");
    items.push({
      id: "documents:failed",
      tone: "warn",
      icon: "document",
      title: `${pluralize(failed, "document")} couldn’t be processed`,
      detail: "They aren’t used in answers until they’re processed again.",
      action: { label: "Review", href: canRetry ? "/manage/sources?tab=history" : "/knowledge" },
    });
  }
  const uploads = overview.attention.failed_items ?? 0;
  if (uploads > 0) {
    items.push({
      id: "documents:uploads",
      tone: "warn",
      icon: "upload",
      title: `${pluralize(uploads, "upload")} didn’t finish`,
      detail: "Upload the files again from their knowledge base.",
      action: { label: "Review", href: "/knowledge" },
    });
  }
  return items;
}

/** Sources and requests that need an administrator, most urgent first. */
export async function loadAttention(session: AuthSession): Promise<AttentionItem[]> {
  const canManageSources = hasSessionPermission(session, "source.manage");
  const canReview = Object.values(REVIEW_PERMISSION).some((permission) => hasSessionPermission(session, permission));
  const [sources, requests] = await Promise.all([
    canManageSources ? sourceItems() : [],
    canReview ? requestItems(session) : [],
  ]);
  return [...sources, ...requests];
}
