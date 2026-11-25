"use client";

import { openDocumentPreview, type PreviewCitation } from "../preview/store";

/**
 * The one way every surface opens a citation (preview `X.openCitation`): the shared preview in Content View at
 * the cited blocks. The list is stepped document by document, in the order each document is first cited;
 * `n` (a marker number) picks the citation to open on.
 */
export function openCitation(citations: PreviewCitation | readonly PreviewCitation[], { n, from }: { n?: number; from?: string } = {}) {
  const list = (Array.isArray(citations) ? citations : [citations as PreviewCitation]).filter((c) => c.item && c.refs.length);
  if (!list.length) return;
  const order = [...new Set(list.map((c) => c.item))];
  const sorted = list.map((c, k) => ({ c, k })).sort((a, b) => order.indexOf(a.c.item) - order.indexOf(b.c.item) || a.k - b.k).map((x) => x.c);
  openDocumentPreview({ citations: sorted, n, from });
}
