/**
 * Local implementations of `artifact.manual_revision`
 * (proposed `POST /artifacts/{artifact_id}/revisions`), `artifact.rename`
 * (proposed `PATCH /artifacts/{artifact_id}`) and `artifact.export_formats`
 * (proposed `GET /artifacts/{artifact_id}/revisions/{revision}/export`).
 *
 * Real artifacts are read (to mirror authorization and number revisions);
 * nothing is written to the server. Hand-made revisions and titles are kept
 * in this browser per account and workspace, keyed by artifact id, and
 * merged into the real detail by `applyLocalArtifactChanges`.
 */
import { ApiError, apiRequest } from "@/lib/api/request";
import { pendingCaller, pendingStore, requirePendingPermission } from "@/lib/api/pending";
import { exportBlob, type ExportSource } from "@/lib/api/pending/artifact-export";
import { loadRendition } from "@/modules/knowledge/rendition";
import type {
  ArtifactContent,
  ArtifactDetail,
  ArtifactExportFormat,
  ArtifactRevision,
  ArtifactRevisionCreate,
  ArtifactUpdate,
  LocalArtifactRevision,
} from "@/modules/chat/api";

const SUMMARY_MAX = 200;
const TITLE_MAX = 200;
const EXPORT_FORMATS: Record<ArtifactExportFormat, true> = { csv: true, pdf: true, md: true };

interface LocalArtifactState {
  title: string | null;
  revisions: LocalArtifactRevision[];
}

type LocalArtifacts = Record<string, LocalArtifactState>;

function artifactsStore(requireSignIn: boolean) {
  const caller = pendingCaller();
  if (requireSignIn) requirePendingPermission(caller, null, "");
  return pendingStore<LocalArtifacts>("artifact.manual_revision", caller.accountId, caller.workspaceId, () => ({}));
}

const artifactPath = (artifactId: string) => `/artifacts/${encodeURIComponent(artifactId)}`;

/**
 * The real artifact, or null when the API cannot be reached at all. A 403/404
 * still throws: the caller may not touch an artifact they cannot read.
 */
async function realArtifact(artifactId: string): Promise<ArtifactDetail | null> {
  try {
    return await apiRequest<ArtifactDetail>(artifactPath(artifactId));
  } catch (error) {
    if (error instanceof ApiError && error.status === undefined) return null;
    throw error;
  }
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|x-ndjson|yaml|x-yaml|csv)\b)/i;

function toRevisionDto(revision: LocalArtifactRevision): ArtifactRevision {
  const { revision: number, summary, size_bytes, created_at, download_url, restored_from } = revision;
  return { revision: number, summary, size_bytes, created_at, download_url, restored_from };
}

export async function createArtifactRevision(
  artifactId: string,
  body: ArtifactRevisionCreate,
): Promise<ArtifactRevision> {
  const store = artifactsStore(true);
  const summary = body.summary.trim();
  if (!summary) throw new ApiError("Describe what changed in this version.", 422);
  if (summary.length > SUMMARY_MAX) throw new ApiError(`Keep the description to ${SUMMARY_MAX} characters.`, 422);

  const real = await realArtifact(artifactId);
  const local = store.read()[artifactId] ?? { title: null, revisions: [] };
  const realNumbers = real ? [real.revision, ...real.revisions.map((revision) => revision.revision)] : [1];
  const latest = Math.max(...realNumbers, ...local.revisions.map((revision) => revision.revision));
  const mimeType = local.revisions.at(-1)?.mime_type ?? real?.mime_type ?? "text/markdown";

  const restoredFrom = body.restored_from ?? null;
  if (restoredFrom !== null) {
    const known = Number.isInteger(restoredFrom) && restoredFrom >= 1 && restoredFrom <= latest
      && (!real || realNumbers.includes(restoredFrom) || local.revisions.some((revision) => revision.revision === restoredFrom));
    if (!known) throw new ApiError("That version doesn't exist.", 404);
  }
  let content = body.content ?? null;
  if (content === null) {
    if (restoredFrom === null) throw new ApiError("Add the content for the new version.", 422);
    content = await revisionText(artifactId, restoredFrom, local);
  } else if (!TEXT_TYPES.test(mimeType)) {
    throw new ApiError("Files of this type can't be edited by hand yet. Ask the assistant for changes instead.", 415);
  }

  const revision: LocalArtifactRevision = {
    revision: latest + 1,
    summary,
    size_bytes: new TextEncoder().encode(content).byteLength,
    created_at: new Date().toISOString(),
    download_url: null,
    restored_from: restoredFrom,
    content,
    mime_type: mimeType,
  };
  store.update((current) => ({
    ...current,
    [artifactId]: { title: current[artifactId]?.title ?? null, revisions: [...(current[artifactId]?.revisions ?? []), revision] },
  }));
  return toRevisionDto(revision);
}

/** How long a hand-made revision can still be taken back (the Undo toast). */
const UNDO_WINDOW_MS = 10 * 60_000;

/**
 * Undo a hand edit or restore: drop the newest revision when a person made it
 * in the last ten minutes. Anything else is history and stays (409).
 */
export async function deleteArtifactRevision(artifactId: string, revision: number): Promise<void> {
  const store = artifactsStore(true);
  const local = store.read()[artifactId];
  const newest = local?.revisions.at(-1);
  if (!local?.revisions.some((candidate) => candidate.revision === revision)) {
    throw new ApiError("That version doesn't exist.", 404);
  }
  const createdAt = Date.parse(newest?.created_at ?? "");
  if (newest?.revision !== revision || !(Date.now() - createdAt <= UNDO_WINDOW_MS)) {
    throw new ApiError("Only the newest version you made in the last few minutes can be undone.", 409);
  }
  store.update((current) => ({
    ...current,
    [artifactId]: { title: current[artifactId]?.title ?? null, revisions: (current[artifactId]?.revisions ?? []).slice(0, -1) },
  }));
}

/** A stored revision's text, for restoring it; binary revisions cannot be copied here. */
async function revisionText(artifactId: string, revision: number, local: LocalArtifactState): Promise<string> {
  const stored = local.revisions.find((candidate) => candidate.revision === revision);
  if (stored) return stored.content;
  const real = await apiRequest<ArtifactContent>(`${artifactPath(artifactId)}/revisions/${revision}/content`);
  if (!TEXT_TYPES.test(real.mime_type) || real.truncated) {
    throw new ApiError("This version can't be restored here yet. Download it and upload it again instead.", 415);
  }
  return real.content;
}

export async function renameArtifact(artifactId: string, body: ArtifactUpdate): Promise<ArtifactDetail> {
  const store = artifactsStore(true);
  const title = body.title.trim();
  if (!title) throw new ApiError("Enter a name.", 422);
  if (title.length > TITLE_MAX) throw new ApiError(`Keep the name to ${TITLE_MAX} characters.`, 422);
  // Renaming needs the real artifact: there is nothing to return without it.
  const real = await apiRequest<ArtifactDetail>(artifactPath(artifactId));
  store.update((current) => ({
    ...current,
    [artifactId]: { title, revisions: current[artifactId]?.revisions ?? [] },
  }));
  return applyLocalArtifactChanges(real);
}

/** Part of `artifact.rename`: the title this browser gave the file, if any. */
export function localArtifactTitle(artifactId: string): string | null {
  return artifactsStore(false).read()[artifactId]?.title ?? null;
}

export function listLocalArtifactRevisions(artifactId: string): LocalArtifactRevision[] {
  return artifactsStore(false).read()[artifactId]?.revisions ?? [];
}

/**
 * The real artifact with this browser's title and hand-made revisions applied.
 * A local revision whose number the server has since used (the assistant made
 * a new revision) moves after the real ones, keeping its relative order.
 */
export function applyLocalArtifactChanges(detail: ArtifactDetail): ArtifactDetail {
  const store = artifactsStore(false);
  const local = store.read()[detail.id];
  if (!local) return detail;
  const realLatest = Math.max(detail.revision, ...detail.revisions.map((revision) => revision.revision));
  let revisions = local.revisions;
  if (revisions.length && revisions[0]!.revision <= realLatest) {
    const renumbered = new Map(revisions.map((revision, index) => [revision.revision, realLatest + index + 1]));
    revisions = revisions.map((revision) => ({
      ...revision,
      revision: renumbered.get(revision.revision)!,
      restored_from: revision.restored_from === null ? null : renumbered.get(revision.restored_from) ?? revision.restored_from,
    }));
    store.update((current) => ({ ...current, [detail.id]: { ...local, revisions } }));
  }
  const current = revisions.at(-1);
  return {
    ...detail,
    title: local.title ?? detail.title,
    revisions: [...detail.revisions, ...revisions.map(toRevisionDto)],
    revision: current?.revision ?? detail.revision,
    revision_count: detail.revision_count + revisions.length,
    size_bytes: current?.size_bytes ?? detail.size_bytes,
    updated_at: current?.created_at ?? detail.updated_at,
    // The real download URL is for a real revision; a local one is exported instead.
    download_url: current ? null : detail.download_url,
  };
}

export async function exportArtifactRevision(
  artifactId: string,
  revision: number,
  format: ArtifactExportFormat,
): Promise<Blob> {
  const store = artifactsStore(true);
  if (!EXPORT_FORMATS[format]) throw new ApiError("Choose CSV, PDF or Markdown.", 422);
  const local = store.read()[artifactId];
  const stored = local?.revisions.find((candidate) => candidate.revision === revision);
  if (stored) {
    const title = local?.title ?? (await realArtifact(artifactId))?.title ?? `Version ${revision}`;
    return exportBlob({ kind: "text", mime_type: stored.mime_type, text: stored.content }, format, title);
  }
  const [detail, content] = await Promise.all([
    apiRequest<ArtifactDetail>(artifactPath(artifactId)),
    apiRequest<ArtifactContent>(`${artifactPath(artifactId)}/revisions/${revision}/content`),
  ]);
  if (content.truncated) {
    throw new ApiError("This version is too large to convert here. Download the original file instead.", 422);
  }
  let source: ExportSource;
  if (TEXT_TYPES.test(content.mime_type)) {
    source = { kind: "text", mime_type: content.mime_type, text: content.content };
  } else if (content.preview?.rendition) {
    const rendition = await loadRendition(`${artifactId}:${revision}`, content.preview.rendition);
    if (rendition.truncated) {
      throw new ApiError("This version is too large to convert here. Download the original file instead.", 422);
    }
    source = { kind: "blocks", blocks: rendition.blocks };
  } else {
    throw new ApiError("This file can't be converted yet. Download the original file instead.", 415);
  }
  return exportBlob(source, format, local?.title ?? detail.title);
}
