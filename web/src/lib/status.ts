/**
 * The one status vocabulary.
 *
 * Every state a person reads — a document's processing, a source's sync, an
 * account's grant, a run's outcome — is said here and only here, so "Failed"
 * on one page and "Failed" on another are the same word in the same colour.
 * Copied from the approved prototype (`docs/ux-review.html`, `const STATUS =`);
 * `schedule`, `session` and `account.draft` extend it for backend states the prototype
 * has no row for.
 *
 * Healthy steady states are `plain`: they render as a quiet dot and text, not
 * a pill, because nothing needs doing. `live` marks work still in progress;
 * the label says so too, so motion is never the only signal.
 *
 * Backend enums do not always match these keys one to one. The `*StatusKey`
 * helpers below translate them (`member` keys come from `memberStatus` in
 * `modules/manage/access/directory.ts`); a value with no entry renders neutral with a
 * humanised label rather than inventing a colour for it.
 */

export type StatusTone = "ok" | "warn" | "err" | "info" | "neutral";

export interface StatusSpec {
  tone: StatusTone;
  label: string;
  /** Healthy steady state: quiet dot + text, no pill. */
  plain?: boolean;
  /** Still moving: the dot pulses. */
  live?: boolean;
}

export const STATUS = {
  doc: {
    ready: { tone: "ok", label: "Ready", plain: true },
    processing: { tone: "info", label: "Processing", live: true },
    pending: { tone: "neutral", label: "Waiting" },
    failed: { tone: "err", label: "Failed" },
    outdated: { tone: "warn", label: "Needs update" },
    unsupported: { tone: "neutral", label: "Not searchable" },
  },
  source: {
    healthy: { tone: "ok", label: "Up to date", plain: true },
    syncing: { tone: "info", label: "Syncing", live: true },
    failed: { tone: "err", label: "Sync failed" },
    reconnect: { tone: "err", label: "Reconnect needed" },
    paused: { tone: "neutral", label: "Paused" },
  },
  account: {
    connected: { tone: "ok", label: "Connected", plain: true },
    expired: { tone: "err", label: "Reconnect needed" },
    error: { tone: "warn", label: "Can’t reach" },
    disabled: { tone: "neutral", label: "Disabled" },
    draft: { tone: "neutral", label: "Not verified" },
  },
  run: {
    queued: { tone: "info", label: "Queued", live: true },
    running: { tone: "info", label: "In progress", live: true },
    completed: { tone: "ok", label: "Completed", plain: true },
    partial: { tone: "warn", label: "Completed with issues" },
    failed: { tone: "err", label: "Failed" },
    cancelled: { tone: "neutral", label: "Cancelled" },
  },
  member: {
    active: { tone: "ok", label: "Active", plain: true },
    suspended: { tone: "err", label: "Suspended" },
  },
  request: {
    pending: { tone: "warn", label: "Pending" },
    approved: { tone: "ok", label: "Approved" },
    denied: { tone: "neutral", label: "Denied" },
  },
  outcome: {
    success: { tone: "ok", label: "Succeeded", plain: true },
    failure: { tone: "err", label: "Failed" },
  },
  ws: {
    active: { tone: "ok", label: "Active", plain: true },
    suspended: { tone: "err", label: "Suspended" },
    new: { tone: "info", label: "Setting up" },
  },
  service: {
    operational: { tone: "ok", label: "Operational", plain: true },
    degraded: { tone: "warn", label: "Degraded" },
    down: { tone: "err", label: "Outage" },
  },
  schedule: {
    active: { tone: "ok", label: "Active", plain: true },
    paused: { tone: "neutral", label: "Paused" },
  },
  session: {
    active: { tone: "ok", label: "Active now", live: true },
    ended: { tone: "neutral", label: "Ended", plain: true },
    blocked: { tone: "err", label: "Blocked" },
  },
} as const satisfies Record<string, Record<string, StatusSpec>>;

export type StatusKind = keyof typeof STATUS;
export type StatusValue<K extends StatusKind> = keyof (typeof STATUS)[K] & string;

/** "reauth_required" → "Reauth required". Empty → "Unknown". */
export function humanizeStatus(value: string | null | undefined): string {
  const words = String(value ?? "").trim().replaceAll(/[._-]+/g, " ").replaceAll(/\s+/g, " ").toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unknown";
}

/**
 * How a value of `kind` reads. Unknown values are neutral with a humanised
 * label, never a guessed colour.
 */
export function statusOf<K extends StatusKind>(kind: K, value: StatusValue<K> | (string & {}) | null | undefined): StatusSpec {
  const key = String(value ?? "").trim().toLowerCase();
  const table: Readonly<Record<string, StatusSpec>> = STATUS[kind];
  return Object.hasOwn(table, key) ? table[key] : { tone: "neutral", label: humanizeStatus(key) };
}

/* ── Backend enum → vocabulary key ───────────────────────────────────────
   `DocumentProcessing.state` already uses the `doc` keys. Values these helpers
   do not recognise pass through unchanged, so they still render (neutral,
   humanised) instead of being forced into a wrong state. */

/**
 * An Ingestion Run item is a Document, so it reads in the document's words:
 * queued → Waiting, running → Processing, succeeded → Ready.
 */
export function runItemStatusKey(status: string): string {
  switch (status) {
    case "queued":
      return "pending";
    case "running":
      return "processing";
    case "succeeded":
      return "ready";
    default:
      return status;
  }
}

/**
 * A run that completed with some documents failed is not a failure of the
 * run, but it still needs someone, so it reads as `partial`.
 */
export function runStatusKey(run: { status: string; counts: { failed: number } }): string {
  return run.status === "completed" && run.counts.failed > 0 ? "partial" : run.status;
}

/** `ConnectionStatus` → `account` key. */
export function accountStatusKey(status: string): string {
  switch (status) {
    case "connected":
      return "connected";
    case "expired":
    case "reauth_required":
    case "revoked":
      return "expired";
    case "error":
      return "error";
    case "disconnected":
      return "disabled";
    default:
      return status;
  }
}

/**
 * `SourceStatus` (plus the latest sync, when given) → `source` key. A sync in
 * flight reads as syncing whatever the source's standing.
 */
export function sourceStatusKey(status: string, syncStatus?: string | null): string {
  if (syncStatus === "running") return "syncing";
  switch (status) {
    case "ready":
      return syncStatus === "failed" ? "failed" : "healthy";
    case "connection_required":
      return "reconnect";
    case "paused":
    case "disabled":
      return "paused";
    default:
      return status;
  }
}

/** Tenant status → `ws` key. */
export function workspaceStatusKey(status: string): string {
  switch (status) {
    case "active":
      return "active";
    case "suspended":
    case "disabled":
    case "inactive":
      return "suspended";
    case "pending":
    case "provisioning":
      return "new";
    default:
      return status;
  }
}

/** Health probe status → `service` key. */
export function serviceStatusKey(status: string): string {
  switch (status) {
    case "healthy":
      return "operational";
    case "unhealthy":
      return "down";
    default:
      return status;
  }
}

/** Audit outcome → `outcome` key. */
export function outcomeStatusKey(outcome: string): string {
  return outcome === "success" ? "success" : outcome === "failure" || outcome === "failed" ? "failure" : outcome;
}

/** Access session status → `session` key. */
export function sessionStatusKey(status: string): string {
  switch (status) {
    case "active":
      return "active";
    case "expired":
    case "revoked":
    case "superseded":
      return "ended";
    default:
      return status;
  }
}
