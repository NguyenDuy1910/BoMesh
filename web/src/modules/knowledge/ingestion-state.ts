import type { StatusTone } from "@/components/ui/StatusPill";
import type {
  Ingestion,
  IngestionEvent,
  IngestionPhase,
  IngestionStatus,
  IngestionWindow,
} from "@/modules/knowledge/ingestions-api";
import { documentKind } from "@/modules/knowledge/view-model";
import type { KnowledgeDocumentKind } from "@/modules/knowledge/workspace-repository";

/**
 * How an ingestion is said out loud.
 *
 * The contract names every state precisely; a person reads "Embedding 24 of 60
 * chunks". Each phrase is derived once, here, so the activity feed, the lanes,
 * the detail panel and a document's own failure notice cannot describe the
 * same moment differently.
 */

export const ACTIVE_STATUSES: readonly IngestionStatus[] = ["pending", "running"];
export const RETRYABLE_STATUSES: readonly IngestionStatus[] = ["failed", "cancelled", "timed_out"];

/** What the Activity filter menu offers, as the contract's statuses. */
export const STATUS_FILTER: Record<string, readonly IngestionStatus[]> = {
  complete: ["completed"],
  running: ["pending", "running"],
  failed: ["failed", "timed_out", "cancelled"],
};

export const WINDOW_LABEL: Record<IngestionWindow, string> = {
  "1h": "last hour",
  "24h": "last 24 hours",
  "7d": "last 7 days",
};

export const isActive = (ingestion: Pick<Ingestion, "status">) =>
  ACTIVE_STATUSES.includes(ingestion.status);

export const canRetry = (ingestion: Pick<Ingestion, "status">) =>
  RETRYABLE_STATUSES.includes(ingestion.status);

/**
 * What kind of work this is, which decides its pipeline. An archive is a
 * document ingestion whose only job is to unpack itself into documents.
 */
export type IngestionShape = "document" | "archive" | "source";

export function ingestionShape(ingestion: Ingestion): IngestionShape {
  if (ingestion.kind === "source") return "source";
  if (ingestion.progress?.phase === "expanding") return "archive";
  return ingestionFileKind(ingestion) === "archive" ? "archive" : "document";
}

/** The file format, from the file name, for the same mark the document list shows. */
export function ingestionFileKind(ingestion: Ingestion): KnowledgeDocumentKind {
  return documentKind({
    id: ingestion.document_id ?? ingestion.id,
    title: ingestion.title ?? "",
    content_type: null,
    document_type: null,
    status: "ready",
    updated_at: ingestion.updated_at,
  });
}

export function ingestionTitle(ingestion: Ingestion): string {
  if (ingestion.title) return ingestion.title;
  return ingestion.kind === "source" ? "Removed source" : "Untitled document";
}

export interface IngestionStatusLabel {
  label: string;
  tone: StatusTone;
  pulse: boolean;
}

const RUNNING_LABEL: Record<IngestionShape, string> = {
  document: "Indexing",
  archive: "Extracting",
  source: "Syncing",
};

export function ingestionStatus(ingestion: Ingestion): IngestionStatusLabel {
  switch (ingestion.status) {
    case "pending":
      return { label: "Queued", tone: "neutral", pulse: false };
    case "running":
      return { label: RUNNING_LABEL[ingestionShape(ingestion)], tone: "info", pulse: true };
    case "completed":
      return { label: "Completed", tone: "success", pulse: false };
    case "failed":
      return { label: "Failed", tone: "danger", pulse: false };
    case "timed_out":
      return { label: "Timed out", tone: "danger", pulse: false };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral", pulse: false };
    default:
      return { label: "Unknown", tone: "warning", pulse: false };
  }
}

export const PHASE_LABEL: Record<IngestionPhase, string> = {
  queued: "Queued",
  downloading: "Downloading",
  parsing: "Parsing",
  contextualizing: "Contextualizing",
  embedding: "Embedding",
  storing: "Storing",
  expanding: "Extracting files",
  syncing: "Syncing",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const TRIGGER_LABEL: Record<Ingestion["trigger_type"], string> = {
  manual: "Started manually",
  scheduled: "Scheduled",
  webhook: "Changed in source",
  initial: "First sync",
  upload: "Uploaded",
  retry: "Retry",
};

export function triggerLabel(ingestion: Ingestion): string {
  return TRIGGER_LABEL[ingestion.trigger_type] ?? "";
}

/* ── Pipeline tracks ─────────────────────────────────────────────────────── */

interface TrackStep {
  label: string;
  phases: readonly IngestionPhase[];
}

/**
 * The steps a lane draws. Downloading is part of getting started, not a step
 * of its own: it is short, and a sixth segment would make every document lane
 * harder to read for the sake of a moment nobody waits on.
 */
const TRACKS: Record<IngestionShape, readonly TrackStep[]> = {
  document: [
    { label: "Queued", phases: ["queued", "downloading"] },
    { label: "Parsing", phases: ["parsing"] },
    { label: "Contextualizing", phases: ["contextualizing"] },
    { label: "Embedding", phases: ["embedding"] },
    { label: "Storing", phases: ["storing"] },
  ],
  archive: [
    { label: "Queued", phases: ["queued", "downloading"] },
    { label: "Extracting", phases: ["expanding"] },
  ],
  source: [
    { label: "Queued", phases: ["queued"] },
    { label: "Syncing", phases: ["syncing"] },
  ],
};

export interface LaneSegment {
  label: string;
  state: "done" | "active" | "todo";
  /** How far through the active step, 0–1, when the pipeline counts it. */
  ratio: number | null;
}

/** Counted progress through the current phase, when there is something to count. */
function phaseRatio(ingestion: Ingestion): number | null {
  const progress = ingestion.progress;
  if (!progress || progress.discovered_count <= 0) return null;
  const done = progress.phase === "storing" ? progress.indexed_count : progress.processed_count;
  switch (progress.phase) {
    case "embedding":
    case "storing":
    case "expanding":
    case "syncing":
      return Math.min(1, Math.max(0, done / progress.discovered_count));
    default:
      return null;
  }
}

export function laneSegments(ingestion: Ingestion): LaneSegment[] {
  const track = TRACKS[ingestionShape(ingestion)];
  const phase = ingestion.progress?.phase;
  let current = phase ? track.findIndex((step) => step.phases.includes(phase)) : -1;
  if (current < 0) {
    // No phase reported yet: waiting is the first step, and running without
    // a reported phase is the first step past waiting.
    current = ingestion.status === "pending" ? 0 : ingestion.status === "running" ? 1 : track.length;
  }
  const ratio = phaseRatio(ingestion);
  return track.map((step, index) => ({
    label: step.label,
    state: index < current ? "done" : index === current ? "active" : "todo",
    ratio: index === current ? ratio : null,
  }));
}

const COUNTED_UNIT: Partial<Record<IngestionPhase, [verb: string, unit: string]>> = {
  embedding: ["Embedding", "chunks"],
  storing: ["Storing", "chunks"],
  expanding: ["Extracting", "files"],
  syncing: ["Syncing", "items"],
};

/** "Embedding 24 of 60 chunks", or the phase alone when nothing is counted. */
export function progressLabel(ingestion: Ingestion): string {
  if (ingestion.status === "pending") {
    return ingestion.attempt > 1 ? "Waiting to try again" : "Waiting to start";
  }
  const progress = ingestion.progress;
  if (!progress) return ingestionStatus(ingestion).label;
  const counted = COUNTED_UNIT[progress.phase];
  if (counted && progress.discovered_count > 0) {
    const done = progress.phase === "storing" ? progress.indexed_count : progress.processed_count;
    return `${counted[0]} ${done.toLocaleString()} of ${progress.discovered_count.toLocaleString()} ${counted[1]}`;
  }
  return PHASE_LABEL[progress.phase];
}

/** "Failed after 3 attempts", "Timed out", "Cancelled". */
export function failureHeadline(ingestion: Ingestion): string {
  const head = ingestion.status === "timed_out"
    ? "Timed out"
    : ingestion.status === "cancelled"
      ? "Cancelled"
      : "Failed";
  return ingestion.attempt > 1 ? `${head} after ${ingestion.attempt} attempts` : head;
}

/** "Failed after 3 attempts: the file is password protected". */
export function failureLine(ingestion: Ingestion): string {
  const head = failureHeadline(ingestion);
  return ingestion.error ? `${head}: ${ingestion.error}` : head;
}

/* ── Timeline ────────────────────────────────────────────────────────────── */

export interface EventLabel {
  label: string;
  tone: "neutral" | "info" | "success" | "danger" | "warning";
}

export function eventLabel(event: IngestionEvent): EventLabel {
  switch (event.type) {
    case "queued":
      return { label: "Queued", tone: "neutral" };
    case "started":
      return {
        label: event.attempt && event.attempt > 1 ? `Attempt ${event.attempt} started` : "Started",
        tone: "info",
      };
    case "phase":
      return { label: event.phase ? PHASE_LABEL[event.phase] : "Step finished", tone: "neutral" };
    case "retrying":
      return {
        label: event.attempt ? `Trying again · attempt ${event.attempt}` : "Trying again",
        tone: "warning",
      };
    case "completed":
      return { label: "Completed", tone: "success" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "timed_out":
      return { label: "Timed out", tone: "danger" };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral" };
    default:
      return { label: "Update", tone: "neutral" };
  }
}

/* ── Numbers ─────────────────────────────────────────────────────────────── */

/** "850 ms", "4.2s", "3m 5s", "1h 12m". */
export function formatDuration(ms: number | null | undefined, { precise = true } = {}): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const value = Math.max(0, ms);
  if (precise && value < 1000) return `${Math.round(value)} ms`;
  const seconds = value / 1000;
  if (seconds < 60) {
    return precise && seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = Math.floor(seconds % 60);
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/**
 * How long a live ingestion has been going, measured on the server's clock.
 *
 * `duration_ms` is elapsed time as of the response; adding what the local
 * clock has counted since the response arrived keeps a lane ticking without
 * trusting that this machine's clock agrees with the server's.
 */
export function liveElapsed(ingestion: Ingestion, receivedAt: number, now: number): number | null {
  const base = ingestion.duration_ms
    ?? (ingestion.started_at ? receivedAt - Date.parse(ingestion.started_at) : null);
  if (base === null || Number.isNaN(base)) return null;
  return Math.max(0, base + (ingestion.status === "running" ? now - receivedAt : 0));
}

/** How long a queued ingestion has been waiting, by the same reasoning. */
export function liveWaiting(ingestion: Ingestion, receivedAt: number, now: number): number | null {
  const created = Date.parse(ingestion.created_at);
  if (Number.isNaN(created)) return null;
  return Math.max(0, receivedAt - created + (now - receivedAt));
}
