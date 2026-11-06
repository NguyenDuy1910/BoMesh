"use client";

import { useEffect, useState } from "react";

import type { ItemContent } from "../../api";
import { elementsRendition, loadRendition, type DocumentRendition } from "../rendition";

export interface RenditionState {
  /** The rendition (or the reader elements laid out as one), once loaded. */
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
 * The document blocks of one `ItemContent`: its stored rendition read from storage, or its
 * reader elements when the revision has none. Keyed by revision and format version, since
 * every content read re-signs the URL.
 */
export function useRendition(itemId: string, content: ItemContent | undefined): RenditionState {
  const [state, setState] = useState<{ key: string; doc?: DocumentRendition; failed?: boolean; error?: unknown }>();
  const ref = content?.rendition;
  const key = content ? `${content.revision}:${ref?.version ?? "elements"}` : "";
  useEffect(() => {
    if (!content) return;
    if (!ref?.uri) {
      setState({ key, doc: elementsRendition(content.elements ?? []) });
      return;
    }
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
  return { doc: loaded?.doc, failed: !!loaded?.failed, error: loaded?.error, loading: !!content && !loaded, reset: () => setState(undefined) };
}
