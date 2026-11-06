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
  return catalog?.find((c) => c.name === connector)?.displayName ?? "App";
}

/** Who runs the sign-in ("Google", "Atlassian"). */
export function providerOf(connector: string | undefined | null): string {
  return appOf(appKey(connector))?.provider ?? "the provider";
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

export const sourceName = (source: Source) => source.displayName || source.externalResource?.displayName || "Source";
/** What the source reads ("Shared drives / Sales Enablement"). */
export const scopeText = (source: Source) => source.externalResource?.displayName || "Everything";

export const isReviewFirst = (source: Pick<Source, "publishingPolicy">) => source.publishingPolicy !== "AUTO_PUBLISH";

/** Pause needs an ACTIVE source, Resume a PAUSED one (a FAILED or expired one can do neither). */
export const canTogglePause = (source: Pick<Source, "state">) => source.state === "ACTIVE" || source.state === "PAUSED";

/** The last sync in a few words: "3 added · 5 updated", "4 sent to review", "Failed". */
export function lastSyncText(source: Source): string {
  const last = source.lastSync;
  if (!last) return "";
  if (last.state === "FAILED") return "Failed";
  const added = last.addedCount ?? 0;
  const updated = last.updatedCount ?? 0;
  const failed = last.failedCount ?? 0;
  if (isReviewFirst(source) && added + updated > 0) return [`${added + updated} sent to review`, failed && `${failed} failed`].filter(Boolean).join(" · ");
  return [added && `${added} added`, updated && `${updated} updated`, last.removedCount && `${last.removedCount} removed`, failed && `${failed} failed`].filter(Boolean).join(" · ") || "No changes";
}

/** Publishing policy for new and changed files. */
export const POLICY: Readonly<Record<PublishingPolicy, { label: string; short: string; icon: LucideIcon; desc: string; css: "auto" | "review" }>> = {
  AUTO_PUBLISH: {
    label: "Publish automatically",
    short: "Publishes automatically",
    icon: Zap,
    desc: "For trusted systems. New and changed files become searchable without a review.",
    css: "auto",
  },
  REVIEW_FIRST: {
    label: "Send to review first",
    short: "Review first",
    icon: ShieldCheck,
    desc: "A reviewer of the knowledge base approves each new or changed file before it’s published.",
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
  return connection.account?.displayName || connection.displayName || `${appName(connection.connector)} account`;
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
  connection?.account?.displayName || tokenUser(connection) || accountLabel(connection) || "the account owner";

/* ═══════════════ Syncs ═══════════════ */

export type RunStatus = "running" | "completed" | "partial" | "failed";

export function syncStatus(sync: Sync): RunStatus {
  if (sync.state === "RUNNING") return "running";
  if (sync.state === "FAILED") return "failed";
  return sync.failedCount ? "partial" : "completed";
}

export const RUN_STATUS_OPTIONS: readonly { value: RunStatus; label: string }[] = [
  { value: "running", label: "In progress" },
  { value: "completed", label: "Completed" },
  { value: "partial", label: "Completed with issues" },
  { value: "failed", label: "Failed" },
];

export const TRIGGER_LABEL: Readonly<Record<NonNullable<Sync["trigger"]>, string>> = {
  MANUAL: "Manual",
  SCHEDULED: "Scheduled",
  CREATION: "First sync",
};

export function syncTotals(sync: Sync) {
  return { added: sync.addedCount ?? 0, updated: sync.updatedCount ?? 0, removed: sync.removedCount ?? 0, failed: sync.failedCount ?? 0 };
}

/** "3 added · 5 updated · 1 failed"; "12 documents so far" while running. */
export function syncDeltaText(sync: Sync): string {
  const t = syncTotals(sync);
  if (sync.state === "RUNNING") return `${plural(t.added + t.updated, "document")} so far`;
  if (sync.state === "FAILED" && !t.added && !t.updated && !t.removed) return "Nothing synced";
  return [t.added && `${t.added} added`, t.updated && `${t.updated} updated`, t.removed && `${t.removed} removed`, t.failed && `${t.failed} failed`].filter(Boolean).join(" · ") || "No changes";
}

export function syncDuration(sync: Sync, now = Date.now()): number {
  const start = sync.startTime ? Date.parse(sync.startTime) : NaN;
  if (Number.isNaN(start)) return 0;
  const end = sync.endTime ? Date.parse(sync.endTime) : now;
  return Math.max(0, end - start);
}
