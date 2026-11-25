"use client";

import { useMemo } from "react";

import type { ArtifactSnapshot } from "../api";
import { fileViewOf, type FileView, type Version } from "../model";
import { useRevisionStructure } from "../queries";
import { sheetFromDelimited, type Sheet } from "../sheet";

/** Where a binary version's Structured Document is read (GetItemContent on the artifact's item). */
export interface VersionStructure {
  revision: number;
  version: string;
}

export interface VersionContent {
  view: FileView;
  /** Text versions. `undefined` when withheld (cites sources the reader can't open now). */
  text?: string;
  /** CSV and TSV versions as a grid. */
  sheet?: Sheet;
  /** A binary document version with a Structured Document, shown through the Content View. */
  structure?: VersionStructure;
  imageUri?: string;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
}

/**
 * What one version shows: text from the revision list, an image's signed URL,
 * or for binary documents the snapshot's `structureVersion`, read with
 * GetItemContent (through GetArtifactRevision when the list carries none for
 * that version: only its current revision has one).
 */
export function useVersionContent(artifact: string, version: Version | undefined, fallbackMime: string | undefined, enabled = true): VersionContent {
  const view = fileViewOf(version?.mimeType || fallbackMime);
  const binary = view === "sheet" || view === "document" || view === "image" || view === "other";
  const listed = version?.revision.snapshot;
  const needsGet = enabled && binary && view !== "image" && !!version && !listed?.structureVersion;
  const detail = useRevisionStructure(artifact, version?.n ?? 0, { enabled: needsGet });
  const snapshot: ArtifactSnapshot | undefined = needsGet ? detail.data?.snapshot : listed;

  const sheet = useMemo(() => {
    if (view !== "csv" || version?.text === undefined) return undefined;
    const tsv = (version.mimeType || fallbackMime || "").includes("tab-separated");
    return sheetFromDelimited(version.text, tsv ? "\t" : ",");
  }, [fallbackMime, version, view]);

  if (!binary) {
    return { view, text: version?.text, sheet, isPending: !version, isError: false, error: null, refetch: () => undefined };
  }
  return {
    view,
    structure: version && snapshot?.structureVersion ? { revision: version.n, version: snapshot.structureVersion } : undefined,
    imageUri: view === "image" ? snapshot?.contentUri : undefined,
    isPending: needsGet && detail.isPending,
    isError: detail.isError,
    error: detail.error,
    refetch: () => void detail.refetch(),
  };
}
