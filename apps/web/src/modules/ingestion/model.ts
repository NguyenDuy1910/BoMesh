import { appOf } from "@/components/ui";
import { plural } from "@/lib/format";
import { resourceId } from "@/lib/api/client";
import { ShieldCheck, Zap, type LucideIcon } from "lucide-react";

import type { Connection, Connector, PublishingPolicy, Source, Sync } from "./api";

/**
 * Plain-language vocabulary for ingestion resources: the preview's source,
 * account and run states (Kit `STATUS`) mapped from the API's enums.
 */

/** Kit `AppIcon` key for a connector name (`connectors/google_drive` → `gdrive`). */
export function appKey(connector: string | undefined | null): string {
  const key = resourceId(connector);
  return key === "google_drive" ? "gdrive" : key;
}

/** "Google Drive" — the Kit registry name, else the catalog's display name. */
export function appName(connector: string | undefined | null, catalog?: readonly Connector[]): string {
  const known = appOf(appKey(connector))?.name;
  if (known) return known;
  return catalog?.find((c) => c.name === connector)?.displayName ?? "Ứng dụng";
}

/** Who runs the sign-in ("Google", "Atlassian"). */
export function providerOf(connector: string | undefined | null): string {
  return appOf(appKey(connector))?.provider ?? "nhà cung cấp";
}

/* ═══════════════ Sources ═══════════════ */

export type SourceStatus = "healthy" | "syncing" | "failed" | "reconnect" | "paused";

export function sourceStatus(source: Source): SourceStatus {
  if (source.lastSync?.state === "RUNNING") return "syncing";
  switch (source.state) {
    case "PAUSED":
      return "paused";
    case "REAUTHORIZATION_REQUIRED":
      return "reconnect";
    case "FAILED":
      return "failed";
    default:
      return "healthy";
  }
}

export const sourceName = (source: Source) => source.displayName || source.externalResource?.displayName || "Nguồn";
/** What the source reads ("Shared drives / Sales Enablement"). */
export const scopeText = (source: Source) => source.externalResource?.displayName || "Tất cả";

/** Studio → Sources with the source drawer open. */
export const sourceHref = (source: string | undefined) => `/studio?tab=sources&open=${resourceId(source)}`;

export const isReviewFirst = (source: Pick<Source, "publishingPolicy">) => source.publishingPolicy !== "AUTO_PUBLISH";

/** Pause needs an ACTIVE source, Resume a PAUSED one (a FAILED or expired one can do neither). */
export const canTogglePause = (source: Pick<Source, "state">) => source.state === "ACTIVE" || source.state === "PAUSED";

/** The source's running sync is its first one (trigger CREATION), from the sync list. */
export function isFirstSync(source: Source, syncs: ReadonlyMap<string, Sync>): boolean {
  return source.lastSync?.state === "RUNNING" && syncs.get(source.lastSync.sync ?? "")?.trigger === "CREATION";
}

/** A finished sync where some files couldn't be read (preview `srcState` "partial"). */
export const syncedWithIssues = (source: Source) => sourceStatus(source) === "healthy" && source.lastSync?.state === "SUCCEEDED" && (source.lastSync.failedCount ?? 0) > 0;

/** The one visible row action (preview `rowActKind`): the row's fix, else what it's doing, else a quiet Sync now. */
export type RowActionKind = "reconnect" | "retry" | "resume" | "process" | "sync" | "";

export function rowActionKind(source: Source, connection: Connection | undefined): RowActionKind {
  const status = sourceStatus(source);
  if (status === "syncing") return "";
  if (status === "reconnect") return "reconnect";
  if (status === "failed") return "retry";
  if (status === "paused") return "resume";
  if ((source.pendingDocumentCount ?? 0) > 0) return "process";
  if (connection?.state === "ACTIVE") return "sync";
  return "";
}

/** The last sync in a few words: "3 added · 5 updated", "4 sent to review", "Failed". */
export function lastSyncText(source: Source): string {
  const last = source.lastSync;
  if (!last) return "";
  if (last.state === "FAILED") return "Lỗi";
  const added = last.addedCount ?? 0;
  const updated = last.updatedCount ?? 0;
  const failed = last.failedCount ?? 0;
  if (isReviewFirst(source) && added + updated > 0) return [`Đã gửi ${added + updated} để duyệt`, failed && `${failed} lỗi`].filter(Boolean).join(" · ");
  return [added && `Đã thêm ${added}`, updated && `Đã cập nhật ${updated}`, last.removedCount && `Đã gỡ ${last.removedCount}`, failed && `${failed} lỗi`].filter(Boolean).join(" · ") || "Không có thay đổi";
}

/** Publishing policy for new and changed files. */
export const POLICY: Readonly<Record<PublishingPolicy, { label: string; short: string; icon: LucideIcon; desc: string; css: "auto" | "review" }>> = {
  AUTO_PUBLISH: {
    label: "Tự động công bố",
    short: "Tự động công bố",
    icon: Zap,
    desc: "Dành cho hệ thống tin cậy. Mọi tệp được công bố sau mỗi lần đồng bộ; trợ lý tự phân loại.",
    css: "auto",
  },
  REVIEW_FIRST: {
    label: "Duyệt tất cả",
    short: "Duyệt tất cả",
    icon: ShieldCheck,
    desc: "Dành cho nguồn dữ liệu chưa tin cậy hoặc nhỏ. Mọi tệp mới hoặc thay đổi đều phải chờ duyệt.",
    css: "review",
  },
};
export const policyOf = (source: Pick<Source, "publishingPolicy">): PublishingPolicy => (isReviewFirst(source) ? "REVIEW_FIRST" : "AUTO_PUBLISH");
export const POLICY_CHOICES = (["AUTO_PUBLISH", "REVIEW_FIRST"] as const).map((value) => ({ value, title: POLICY[value].label, description: POLICY[value].desc }));

/* ═══════════════ Accounts ═══════════════ */

export type AccountStatus = "connected" | "expired" | "error" | "authorizing";

export function accountStatus(connection: Connection): AccountStatus {
  switch (connection.state) {
    case "ACTIVE":
      return "connected";
    case "REAUTHORIZATION_REQUIRED":
      return "expired";
    case "FAILED":
      return "error";
    default:
      return "authorizing";
  }
}

/** "ana@northwind.com" — the signed-in account, else the connection's name. */
export function accountLabel(connection: Connection | undefined | null): string {
  if (!connection) return "";
  return connection.account?.displayName || connection.displayName || `Tài khoản ${appName(connection.connector)}`;
}

/** The email a token-based (Confluence) connection signs in with; not a secret. */
function tokenUser(connection: Connection | undefined | null): string | undefined {
  const user = (connection?.config as Record<string, unknown> | undefined)?.username;
  return typeof user === "string" && user ? user : undefined;
}

/** Secondary line: "Confluence · northwind.atlassian.net" or "Confluence · ana@northwind.com". */
export function accountSub(connection: Connection): string {
  const label = accountLabel(connection);
  const extra = connection.account?.resourceLabel || tokenUser(connection);
  return [appName(connection.connector), extra && extra !== label ? extra : null].filter(Boolean).join(" · ");
}

/** Who to sign in as when reconnecting. */
export const accountUser = (connection: Connection | undefined | null) =>
  connection?.account?.displayName || tokenUser(connection) || accountLabel(connection) || "chủ sở hữu tài khoản";

/* ═══════════════ Syncs ═══════════════ */

export type RunStatus = "running" | "completed" | "partial" | "failed";

export function syncStatus(sync: Sync): RunStatus {
  if (sync.state === "RUNNING") return "running";
  if (sync.state === "FAILED") return "failed";
  return sync.failedCount ? "partial" : "completed";
}

export const RUN_STATUS_OPTIONS: readonly { value: RunStatus; label: string }[] = [
  { value: "running", label: "Đang xử lý" },
  { value: "completed", label: "Đã hoàn thành" },
  { value: "partial", label: "Đã hoàn tất nhưng có sự cố" },
  { value: "failed", label: "Lỗi" },
];

export const TRIGGER_LABEL: Readonly<Record<NonNullable<Sync["trigger"]>, string>> = {
  MANUAL: "Thủ công",
  SCHEDULED: "Theo lịch",
  CREATION: "Đồng bộ lần đầu",
};

export function syncTotals(sync: Sync) {
  return { added: sync.addedCount ?? 0, updated: sync.updatedCount ?? 0, removed: sync.removedCount ?? 0, failed: sync.failedCount ?? 0 };
}

/** "3 added · 5 updated · 1 failed"; "12 documents so far" while running. */
export function syncDeltaText(sync: Sync): string {
  const t = syncTotals(sync);
  if (sync.state === "RUNNING") return `${plural(t.added + t.updated, "document")} cho đến nay`;
  if (sync.state === "FAILED" && !t.added && !t.updated && !t.removed) return "Chưa đồng bộ mục nào";
  return [t.added && `Đã thêm ${t.added}`, t.updated && `Đã cập nhật ${t.updated}`, t.removed && `Đã gỡ ${t.removed}`, t.failed && `${t.failed} lỗi`].filter(Boolean).join(" · ") || "Không có thay đổi";
}

export function syncDuration(sync: Sync, now = Date.now()): number {
  const start = sync.startTime ? Date.parse(sync.startTime) : NaN;
  if (Number.isNaN(start)) return 0;
  const end = sync.endTime ? Date.parse(sync.endTime) : now;
  return Math.max(0, end - start);
}
