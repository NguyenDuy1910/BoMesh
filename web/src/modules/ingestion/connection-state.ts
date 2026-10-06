import { accountStatusKey, sourceStatusKey, statusOf } from "@/lib/status";
import { RECONNECT_STATUSES, type Connection, type Source, type SourceSync } from "@/modules/ingestion/integrations-api";
import type { IngestionRun } from "@/modules/ingestion/runs-api";

/**
 * A connection's and a source's standing, as `lib/status.ts` keys, and the
 * one rule for which sources need someone.
 *
 * The API's vocabulary is precise and internal: `reauth_required` is the right
 * name for a grant that no longer authenticates, and the wrong thing to show a
 * person. Render `value` with `<StatusBadge kind="account" | "source">`.
 */
export interface StateKey {
  value: string;
  /** Anything but a healthy steady state. A healthy connection needs no badge. */
  attention: boolean;
}

export function connectionState(connection: Connection): StateKey {
  const value = accountStatusKey(connection.status);
  return { value, attention: !statusOf("account", value).plain };
}

/** Whether only a person signing in again can fix this account. */
export function needsReconnect(connection: Connection | null | undefined): boolean {
  return Boolean(connection && RECONNECT_STATUSES.includes(connection.status));
}

/**
 * What a connection is, in one line: the account, and the site if there is one.
 *
 * An Atlassian grant is bound to a site, so "duy@company.com · galaxyfinx"
 * distinguishes two connections that are otherwise the same account.
 */
export function accountLine(connection: Connection): string {
  const { label, resource_label: site } = connection.account;
  return [label, site].filter(Boolean).join(" · ") || connection.display_name;
}

/** A source's name as people gave it. */
export function sourceName(source: Source): string {
  return source.display_name?.trim() || "Untitled source";
}

/** A run is processing this source's documents right now. */
export function activeRunFor(source: Source, runs: readonly IngestionRun[]): IngestionRun | null {
  return (
    runs.find(
      (run) => run.scope.source_id === source.id && (run.status === "queued" || run.status === "running"),
    ) ?? null
  );
}

/**
 * The source's `source` status key. A sync is two things on the server —
 * finding changes, then a run that makes them searchable — and either one in
 * flight reads as "Syncing". A paused source stays paused whatever its account
 * says; otherwise an account that needs signing in again outranks the rest.
 */
export function sourceStatus(
  source: Source,
  connection: Connection | null | undefined,
  activeRun: IngestionRun | null = null,
): string {
  const key = sourceStatusKey(source.status, source.sync?.status);
  if (key === "syncing" || activeRun) return "syncing";
  if (key === "paused") return "paused";
  if (needsReconnect(connection)) return "reconnect";
  return key;
}

export interface SourceAttention {
  /** Stopped because their account must sign in again. */
  reconnect: Source[];
  /** Their last sync failed for another reason. */
  failed: Source[];
}

/**
 * Which sources need someone. The Sources page's call-outs, the sidebar badge
 * and the overview read this one rule, so they always agree. Paused sources
 * were stopped on purpose and are left out.
 */
export function sourceAttention(sources: readonly Source[], connections: readonly Connection[]): SourceAttention {
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  const result: SourceAttention = { reconnect: [], failed: [] };
  for (const source of sources) {
    const key = sourceStatus(source, byId.get(source.connection_id));
    if (key === "reconnect") result.reconnect.push(source);
    else if (key === "failed") result.failed.push(source);
  }
  return result;
}

/** `sourceAttention` as one list, reconnect first. */
export function sourcesNeedingAttention(sources: readonly Source[], connections: readonly Connection[]): Source[] {
  const { reconnect, failed } = sourceAttention(sources, connections);
  return [...reconnect, ...failed];
}

/** How the latest finished sync went, for the "Last sync" column's icon. */
export type SyncResult = "completed" | "partial" | "failed";

export function lastSyncResult(sync: SourceSync | null | undefined): SyncResult | null {
  if (!sync || sync.status === "running") return null;
  if (sync.status === "failed") return "failed";
  return sync.failed > 0 ? "partial" : "completed";
}

/** "3 added · 5 updated · 1 failed", or "No changes". */
export function syncChangesText(sync: Pick<SourceSync, "added" | "updated" | "removed" | "failed">): string {
  const parts = [
    sync.added && `${sync.added.toLocaleString()} added`,
    sync.updated && `${sync.updated.toLocaleString()} updated`,
    sync.removed && `${sync.removed.toLocaleString()} removed`,
    sync.failed && `${sync.failed.toLocaleString()} failed`,
  ].filter(Boolean);
  return parts.join(" · ") || "No changes";
}
