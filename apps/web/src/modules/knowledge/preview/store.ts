"use client";

import { createOverlayStore } from "../components/dialog-store";

/**
 * The shared document preview (preview `features/preview.js`, KNOWLEDGE_HUB.md "Document preview"):
 * one quick-reading overlay for every place a document is referenced — Browse cards and rows, search
 * results, My library and collection lists, Related, space materials, Home suggestions, chat citations
 * and work/request citations.
 *
 * Preview first, open full later: the document's own pages render inside a centred modal over the page
 * the caller came from, with the cited passage or the matching words highlighted and scrolled into view.
 * One primary action — Open full document — and one optional secondary — Ask about this document.
 * Saving, collections, editing, sharing and versions live in the Reader, never here.
 */

/** One cited passage of a preview's citation list (chat and work/request citations). */
export interface PreviewCitation {
  /** Item name or bare ID the passage belongs to. */
  item: string;
  /** Passage name or bare ID (resolved against the API for its text and location). */
  passage?: string;
  /** The quoted text, when it is already in hand (shown verbatim if the document can't be read). */
  excerpt?: string;
  page?: number;
  /** The citation marker number in the answer (`[3]`), used to open on the right passage. */
  n?: number;
}

export interface PreviewRequest {
  /** Item name or bare ID. Ignored when `citations` is given (the list names its own items). */
  item?: string;
  /** Search text to highlight and step through. */
  q?: string;
  page?: number;
  /** Passages to highlight in `item` (a single document's citations). */
  passages?: readonly string[];
  /** Citations spanning one or more documents; the preview steps "Passage n of m" across them. */
  citations?: readonly PreviewCitation[];
  /** Which citation to open on (its `n`); defaults to the first. */
  n?: number;
  /** Conversation the preview was opened from, so "Open full document" keeps the back link. */
  from?: string;
}

const store = createOverlayStore<PreviewRequest>();

/** Opens the shared document preview. Rendered by `<DocumentPreviewHost/>`. */
export function openDocumentPreview(request: PreviewRequest) {
  store.open(request);
}

export const useDocumentPreview = store.useCurrent;
export const closeDocumentPreview = store.close;
