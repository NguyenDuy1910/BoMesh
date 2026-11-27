"use client";

import { openCitation } from "@/modules/knowledge/content/open";
import { referenceOfWire } from "@/modules/knowledge/content/reference";
import { openDocumentPreview, type PreviewCitation } from "@/modules/knowledge/preview/store";

import { sourceLookup } from "./citations";
import type { AnswerSource, FoundSource } from "./turn";

/**
 * A marker `[n]` of an answer (preview `chat.js` → `X.openCitation`): the shared preview opens on its document's
 * cited blocks and steps through every reference of the answer's sources. An old per-citation number (an alias)
 * opens the document it belongs to. A document the answer cites without openable blocks opens as itself.
 */
export function openAnswerCitation(sources: readonly AnswerSource[], n: number, from?: string) {
  const source = sourceLookup(sources).get(n);
  if (!source?.available) return;
  if (!source.references.length) {
    openDocumentPreview({ item: source.item, from });
    return;
  }
  const citations: PreviewCitation[] = sources.filter((s) => s.available).flatMap((s) => s.references.map((r) => ({ ...r, n: s.n })));
  openCitation(citations, { n: source.n, from });
}

/** A document a work step found opens at its best match; without one, as itself. */
export function openFoundSource(source: FoundSource, from?: string) {
  const reference = referenceOfWire(source);
  if (reference) openCitation(reference, { from });
  else openDocumentPreview({ item: source.item, from });
}
