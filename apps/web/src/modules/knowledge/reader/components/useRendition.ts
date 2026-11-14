"use client";

import { useEffect, useState } from "react";

import type { ItemContent } from "../../api";
import { loadRendition, type DocumentRendition } from "../rendition";

export interface RenditionState {
  /** The rendition, once loaded; absent when the revision has none. */
  doc?: DocumentRendition;
  /** The download failed; refetch the content to re-sign its URL. */
  failed: boolean;
  /** Why the download failed (shown in the error state). */
  error?: unknown;
  /** Content is in hand but its rendition is still downloading. */
  loading: boolean;
  reset: () => void;
}

/**
 * The document blocks of one `ItemContent`: its stored rendition, read straight from storage
 * (never from the search index). Keyed by revision and format version, since every content
 * read re-signs the URL. A revision without a rendition has no blocks; `enabled: false` skips
 * the download when nothing on screen shows the blocks (page images are the canvas).
 */
export function useRendition(itemId: string, content: ItemContent | undefined, { enabled = true }: { enabled?: boolean } = {}): RenditionState {
  const [state, setState] = useState<{ key: string; doc?: DocumentRendition; failed?: boolean; error?: unknown }>();
  const ref = enabled ? content?.rendition : undefined;
  const key = content ? `${content.revision}:${ref?.version ?? "none"}` : "";
  useEffect(() => {
    if (!content || !ref?.uri) return;
    const controller = new AbortController();
    loadRendition(itemId, { uri: ref.uri, version: ref.version ?? 1, revision: content.revision }, controller.signal).then(
      (doc) => setState({ key, doc }),
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ key, failed: true, error });
      },
    );
    return () => controller.abort();
    // `content` is re-read with fresh URLs; `key` names what it holds.
  }, [key, itemId]);
  const loaded = state?.key === key ? state : undefined;
  return {
    doc: loaded?.doc,
    failed: !!loaded?.failed,
    error: loaded?.error,
    loading: !!ref?.uri && !loaded,
    reset: () => setState(undefined),
  };
}
