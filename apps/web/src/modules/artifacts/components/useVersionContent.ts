"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { loadRendition, type RenditionBlock } from "@/modules/knowledge/reader/rendition";

import type { ArtifactSnapshot } from "../api";
import { fileViewOf, type FileView, type Version } from "../model";
import { useRevisionPreview } from "../queries";
import { sheetFromDelimited, sheetsFromBlocks, type Sheet } from "../sheet";

export interface VersionContent {
  view: FileView;
  /** Text versions. `undefined` when withheld (cites sources the reader can't open now). */
  text?: string;
  sheets?: Sheet[];
  blocks?: RenditionBlock[];
  /** Page images of a binary version without a rendition. */
  pages?: { uri: string; n: number }[];
  imageUri?: string;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
}

/**
 * What one version shows: text from the revision list, or for binary files
 * the server's rendition (read through GetArtifactRevision when the list
 * carries no preview for that version).
 */
export function useVersionContent(artifact: string, version: Version | undefined, fallbackMime: string | undefined, enabled = true): VersionContent {
  const { id } = useWorkspace();
  const view = fileViewOf(version?.mimeType || fallbackMime);
  const binary = view === "sheet" || view === "document" || view === "image" || view === "other";
  const listed = version?.revision.snapshot;
  const needsGet = enabled && binary && !!version && !listed?.rendition?.uri && !listed?.pageAssets?.length;
  const detail = useRevisionPreview(artifact, version?.n ?? 0, { enabled: needsGet });
  const snapshot: ArtifactSnapshot | undefined = needsGet ? detail.data?.snapshot : listed;
  const rendition = snapshot?.rendition;

  const blocks = useQuery({
    queryKey: [id, "artifacts", resourceId(artifact), "rendition", version?.n ?? 0, rendition?.version ?? 0],
    queryFn: async () => (await loadRendition(`artifact:${resourceId(artifact)}`, { uri: rendition!.uri!, version: rendition!.version ?? 0, revision: version?.name })).blocks,
    enabled: enabled && binary && !!rendition?.uri,
    staleTime: Infinity,
    retry: 1,
  });

  const csvSheets = useMemo(() => {
    if (view !== "csv" || version?.text === undefined) return undefined;
    const tsv = (version.mimeType || fallbackMime || "").includes("tab-separated");
    return [sheetFromDelimited(version.text, "Sheet1", tsv ? "\t" : ",")];
  }, [fallbackMime, version, view]);
  const blockSheets = useMemo(() => (view === "sheet" && blocks.data ? sheetsFromBlocks(blocks.data) : undefined), [blocks.data, view]);

  if (!binary) {
    return { view, text: version?.text, sheets: csvSheets, isPending: !version, isError: false, error: null, refetch: () => undefined };
  }
  const pages = (snapshot?.pageAssets ?? []).filter((p) => p.imageUri).map((p) => ({ uri: p.imageUri!, n: p.pageNumber ?? 0 }));
  const isPending = (needsGet && detail.isPending) || (!!rendition?.uri && blocks.isPending);
  return {
    view,
    sheets: blockSheets,
    blocks: blocks.data,
    pages,
    imageUri: view === "image" ? snapshot?.contentUri : undefined,
    isPending: enabled && isPending,
    isError: detail.isError || blocks.isError,
    error: detail.error ?? blocks.error,
    refetch: () => {
      if (detail.isError) void detail.refetch();
      else void blocks.refetch();
    },
  };
}
