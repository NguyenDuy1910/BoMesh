"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { usePendingFeature } from "@/lib/api/pending";
import { ApiError } from "@/lib/api/request";
import { blockText, loadRendition, type RenditionBlock } from "@/modules/knowledge/rendition";
import type { KnowledgePreview } from "@/modules/knowledge/types";

import {
  applyLocalArtifactChanges,
  getArtifact,
  getArtifactContent,
  listLocalArtifactRevisions,
  type ArtifactDetail,
} from "../../api";
import {
  delimiterOf,
  fileKindOf,
  isDelimitedText,
  mergeFileRevisions,
  type FileKind,
  type FileRevision,
} from "./file-model";
import { sheetFromDelimited, sheetsFromBlocks, type Sheet } from "./sheet";

export interface FileDetail {
  id: string;
  title: string;
  fileName: string;
  mimeType: string;
  kind: FileKind;
  conversationId: string | null;
  revisions: FileRevision[];
}

export type LoadFailure = { message: string; gone: boolean };

/**
 * One version's identity for caching. A number alone is not enough: an
 * undone hand-made version frees its number for the next one.
 */
export function revisionKey(fileId: string, revision: FileRevision): string {
  return `${fileId}:${revision.revision}:${revision.local ? `local:${revision.createdAt ?? ""}` : "server"}`;
}

function failureOf(cause: unknown, fallback: string): LoadFailure {
  const gone = cause instanceof ApiError && (cause.status === 403 || cause.status === 404);
  return { message: cause instanceof Error && cause.message ? cause.message : fallback, gone };
}

/**
 * The file and its versions. The detail is re-read on every open and after
 * every change: download URLs are short-lived, and the assistant may have
 * added a version since.
 */
export function useFileDetail(artifactId: string) {
  const manualRevisions = usePendingFeature("artifact.manual_revision");
  const rename = usePendingFeature("artifact.rename");
  const [state, setState] = useState<{ detail?: FileDetail; failure?: LoadFailure; loading: boolean }>({ loading: true });

  const read = useCallback(
    async (signal?: AbortSignal) => {
      const real = await getArtifact(artifactId, signal);
      // Normalizes local numbering first, so the local list below agrees with it.
      const applied: ArtifactDetail = manualRevisions || rename ? applyLocalArtifactChanges(real) : real;
      const local = manualRevisions ? listLocalArtifactRevisions(artifactId) : [];
      const current = real.revisions.find((revision) => revision.revision === real.revision) ?? {
        revision: real.revision,
        summary: null,
        size_bytes: real.size_bytes,
        created_at: real.updated_at,
        download_url: real.download_url,
      };
      return {
        id: real.id,
        title: rename ? applied.title : real.title,
        fileName: real.file_name,
        mimeType: real.mime_type,
        kind: fileKindOf(real.mime_type, real.file_name),
        conversationId: real.conversation_id,
        revisions: mergeFileRevisions(real.revisions, local, current),
      } satisfies FileDetail;
    },
    [artifactId, manualRevisions, rename],
  );

  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true });
    read(controller.signal)
      .then((detail) => setState({ detail, loading: false }))
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setState({ failure: failureOf(cause, "This file didn’t load."), loading: false });
      });
    return () => controller.abort();
  }, [read]);

  /** Re-read after a change; keeps showing the current detail meanwhile. */
  const reload = useCallback(async () => {
    const detail = await read();
    setState({ detail, loading: false });
    return detail;
  }, [read]);

  const retry = useCallback(() => {
    setState({ loading: true });
    read()
      .then((detail) => setState({ detail, loading: false }))
      .catch((cause: unknown) => setState({ failure: failureOf(cause, "This file didn’t load."), loading: false }));
  }, [read]);

  return { ...state, reload, retry };
}

/** One version's bytes as the panel needs them. */
export interface RevisionContent {
  mimeType: string;
  /** A text version's text (empty for binary files). */
  text: string;
  truncated: boolean;
  /** The server's preview (page images, rendition, signed original) of a non-Markdown version. */
  preview: KnowledgePreview | null;
}

/** What two versions are compared on. */
export type RevisionModel =
  | { kind: "sheets"; sheets: Sheet[]; truncated: boolean }
  | { kind: "markdown"; text: string; truncated: boolean }
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "blocks"; blocks: string[]; truncated: boolean }
  | { kind: "none" };

/** Reads of one file's versions, shared by the preview, the changes and the editor. */
export interface RevisionContents {
  content(revision: FileRevision): Promise<RevisionContent>;
  model(revision: FileRevision): Promise<RevisionModel>;
  /** Forget a version so the next read issues fresh signed URLs. */
  forget(revision: FileRevision): void;
}

/**
 * Content per version, read once while the panel is open. A retry forgets
 * the version, so its signed URLs are issued again.
 */
export function useRevisionContents(detail: FileDetail | undefined): RevisionContents {
  const contents = useRef(new Map<string, Promise<RevisionContent>>());
  const models = useRef(new Map<string, Promise<RevisionModel>>());

  const content = useCallback(
    (revision: FileRevision): Promise<RevisionContent> => {
      if (!detail) return Promise.reject(new Error("The file is not loaded."));
      const key = revisionKey(detail.id, revision);
      let pending = contents.current.get(key);
      if (!pending) {
        pending = revision.local
          ? Promise.resolve({ mimeType: revision.mimeType ?? detail.mimeType, text: revision.content ?? "", truncated: false, preview: null })
          : getArtifactContent(detail.id, revision.revision).then((value) => ({
              mimeType: value.mime_type,
              text: value.content,
              truncated: value.truncated,
              preview: value.preview ?? null,
            }));
        pending.catch(() => contents.current.delete(key));
        contents.current.set(key, pending);
      }
      return pending;
    },
    [detail],
  );

  const model = useCallback(
    (revision: FileRevision): Promise<RevisionModel> => {
      if (!detail) return Promise.reject(new Error("The file is not loaded."));
      const key = revisionKey(detail.id, revision);
      let pending = models.current.get(key);
      if (!pending) {
        pending = content(revision).then((value) => modelOf(detail, value));
        pending.catch(() => models.current.delete(key));
        models.current.set(key, pending);
      }
      return pending;
    },
    [content, detail],
  );

  const forget = useCallback((revision: FileRevision) => {
    if (!detail) return;
    const key = revisionKey(detail.id, revision);
    contents.current.delete(key);
    models.current.delete(key);
  }, [detail]);

  return { content, model, forget };
}

async function modelOf(detail: FileDetail, value: RevisionContent): Promise<RevisionModel> {
  const rendition = value.preview?.rendition;
  const blocks = async (): Promise<{ blocks: RenditionBlock[]; truncated: boolean } | null> => {
    if (!rendition) return null;
    const document = await loadRendition(`artifact:${detail.id}`, rendition);
    return { blocks: document.blocks, truncated: document.truncated || rendition.truncated };
  };
  switch (detail.kind) {
    case "sheet": {
      // A cut CSV text is a cut sheet; the rendition holds the whole one when there is one.
      if (isDelimitedText(value.mimeType, detail.fileName) && (!value.truncated || !rendition)) {
        return {
          kind: "sheets",
          sheets: [sheetFromDelimited(value.text, detail.title, delimiterOf(value.mimeType, detail.fileName))],
          truncated: value.truncated,
        };
      }
      const read = await blocks();
      return read ? { kind: "sheets", sheets: sheetsFromBlocks(read.blocks), truncated: read.truncated } : { kind: "none" };
    }
    case "markdown":
      return { kind: "markdown", text: value.text, truncated: value.truncated };
    case "text":
      return { kind: "text", text: value.text, truncated: value.truncated };
    case "document":
    case "pdf": {
      const read = await blocks();
      if (!read) return { kind: "none" };
      return { kind: "blocks", blocks: read.blocks.flatMap(readableBlocks), truncated: read.truncated };
    }
    default:
      return { kind: "none" };
  }
}

/** A rendition block as compared text: headings keep their level, table rows stand alone. */
function readableBlocks(block: RenditionBlock): string[] {
  if (block.kind === "heading") return [`${"#".repeat(Math.min(Math.max(block.level, 1), 4) + 1)} ${block.text}`];
  if (block.kind === "table") return [block.columns.join(" · "), ...block.rows.map((row) => row.join(" · "))].filter((line) => line.trim());
  const text = blockText(block).trim();
  return text ? [text] : [];
}

/** Resolve a promise into render state, re-running when `key` changes. */
export function useAsync<T>(key: string | null, run: () => Promise<T>) {
  const [state, setState] = useState<{ key: string | null; value?: T; failure?: LoadFailure }>({ key: null });
  const [attempt, setAttempt] = useState(0);
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });

  useEffect(() => {
    if (key === null) return;
    let active = true;
    runRef
      .current()
      .then((value) => active && setState({ key, value }))
      .catch((cause: unknown) => active && setState({ key, failure: failureOf(cause, "This version didn’t load.") }));
    return () => {
      active = false;
    };
  }, [key, attempt]);

  const current = state.key === key ? state : { key };
  return {
    value: "value" in current ? current.value : undefined,
    failure: "failure" in current ? current.failure : undefined,
    loading: key !== null && !("value" in current) && !("failure" in current),
    retry: () => {
      setState({ key: null });
      setAttempt((value) => value + 1);
    },
  };
}
