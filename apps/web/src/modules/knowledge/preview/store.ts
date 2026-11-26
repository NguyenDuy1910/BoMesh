"use client";

import type { Item } from "../api";
import { createOverlayStore } from "../components/dialog-store";
import type { Reference } from "../content/reference";

/**
 * The shared document preview (preview `features/preview.js`, KNOWLEDGE_HUB.md "Document preview"):
 * one quick-reading overlay for every place a document is referenced — Browse cards and rows, search
 * results, Saved, My files, Related, space materials, Home suggestions, chat citations
 * and work/request citations.
 *
 * One rendering of a document, its Original: a citation (a `Reference`) opens the Original of its revision with its
 * Highlights drawn (boxes over PDF pages, cell ranges in the grid) or its quote marked in text, and the reading bar
 * steps through the citations; a plain open shows the current Original.
 * One primary action — Open full document — and one optional secondary — Ask about this document.
 * Saving, editing, sharing and versions live in the Reader, never here.
 */

/** One cited reference of a preview's citation list (chat, search, work/request citations). */
export interface PreviewCitation extends Reference {
  /** The citation marker number in the answer (`[3]`), used to open on the right reference. */
  n?: number;
  /** Root collection the document lives in, when the caller knows it: a locked citation then offers Request access. */
  collection?: string;
}

export interface PreviewRequest {
  /** Item name or bare ID. Ignored when `citations` is given (the list names its own items). */
  item?: string;
  /** `item` as the opening list already has it: the preview draws at once (title, cover as page 1) and
   *  starts reading the content while GetItem refreshes it. */
  listed?: Item;
  /** Search text to highlight and step through (Original). */
  q?: string;
  page?: number;
  /** References spanning one or more documents; the preview opens on their Originals and steps through them. */
  citations?: readonly PreviewCitation[];
  /** Which citation to open on (its `n`); defaults to the first. */
  n?: number;
  /** Where the preview was opened from (a conversation ID or an encoded Reader origin, `reader/links`
   *  `originParam`), so "Open full document" keeps the way back. */
  from?: string;
  /** Root collection of `item`, when the caller knows it: a locked document then offers Request access. */
  collection?: string;
}

const store = createOverlayStore<PreviewRequest>();

/** Opens the shared document preview. Rendered by `<DocumentPreviewHost/>`. */
export function openDocumentPreview(request: PreviewRequest) {
  store.open(request);
}

export const useDocumentPreview = store.useCurrent;
export const closeDocumentPreview = store.close;
