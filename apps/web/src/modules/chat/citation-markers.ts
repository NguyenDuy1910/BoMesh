/**
 * Inline citation markers inside a rendered answer.
 *
 * The backend replaces its internal `[[cite:ref_1]]` with the reader-facing
 * `[1]` at the exact position the model placed it, so the marker arrives as
 * ordinary text and needs no offset arithmetic on the client. This module finds
 * those markers after Markdown has been parsed, which keeps a chip inside
 * whatever inline context it belongs to — a list item, a bold run, a heading —
 * instead of splitting the Markdown source at a character offset.
 */

const MARKER_PATTERN = /\[(\d{1,3})\]/g;

/** Elements whose text is literal and must never become a citation chip. */
const OPAQUE_ELEMENTS = new Set(["code", "pre", "a", "cite"]);

/** The element a marker becomes; `components.cite` renders it. */
export const CITATION_ELEMENT = "cite";

/**
 * The citation number's two spellings.
 *
 * Hast names a data attribute in camel case; the JSX runtime hands the same
 * attribute to a component under its hyphenated DOM name.
 */
export const CITATION_NUMBER_PROPERTY = "dataCitationNumber";
export const CITATION_NUMBER_PROP = "data-citation-number";

export type CitationSegment =
  | { type: "text"; value: string }
  | { type: "citation"; number: number; value: string };

/**
 * Split one text run into its literal and citation parts, in order.
 *
 * Numbering is not validated here: an answer's own citation set decides which
 * numbers resolve, and an unresolved one falls back to its literal text.
 */
export function splitCitationMarkers(text: string): CitationSegment[] {
  const segments: CitationSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(MARKER_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ type: "text", value: text.slice(lastIndex, index) });
    }
    segments.push({
      type: "citation",
      number: Number(match[1]),
      value: match[0],
    });
    lastIndex = index + match[0].length;
  }
  if (!segments.length) return [{ type: "text", value: text }];
  if (lastIndex < text.length) {
    segments.push({ type: "text", value: text.slice(lastIndex) });
  }
  return segments;
}

/**
 * Build the number-to-source lookup a rendered answer resolves chips against.
 *
 * Only numbers this answer actually cited are present, so a `[n]` the model
 * merely wrote in prose cannot become a clickable citation. A document cited
 * under several numbers (answers saved before numbering was per document)
 * resolves each number to that document, opened at the passage it marked.
 */
export function citationRenderingSources<
  T extends { index: number; chunkId?: string; passages?: readonly { number: number; chunkId: string; page?: number; locator?: string }[] },
>(sources: readonly T[]): ReadonlyMap<number, T> {
  const resolved = new Map<number, T>();
  for (const source of sources) {
    resolved.set(source.index, source);
    for (const passage of source.passages ?? []) {
      if (resolved.has(passage.number)) continue;
      resolved.set(passage.number, {
        ...source,
        chunkId: passage.chunkId,
        page: passage.page,
        locator: passage.locator,
      });
    }
  }
  return resolved;
}

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * Rehype plugin turning `[n]` text into a citation element.
 *
 * It is a module constant with no per-message state, so the plugin list stays
 * stable across renders and Markdown is not reparsed on every commit. Which
 * numbers actually resolve is decided by the renderer from React context.
 */
export function rehypeCitationMarkers() {
  return (tree: HastNode) => transform(tree);
}

function transform(node: HastNode): void {
  const children = node.children;
  if (!children?.length) return;
  if (node.tagName && OPAQUE_ELEMENTS.has(node.tagName)) return;

  let replaced: HastNode[] | undefined;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child.type === "element") {
      transform(child);
      continue;
    }
    if (child.type !== "text" || typeof child.value !== "string") continue;
    if (!child.value.includes("[")) continue;
    const segments = splitCitationMarkers(child.value);
    if (segments.length === 1 && segments[0].type === "text") continue;
    replaced ??= children.slice();
    replaced.splice(
      replaced.indexOf(child),
      1,
      ...segments.map((segment) => (
        segment.type === "text"
          ? { type: "text", value: segment.value }
          : {
            type: "element",
            tagName: CITATION_ELEMENT,
            properties: { [CITATION_NUMBER_PROPERTY]: String(segment.number) },
            children: [{ type: "text", value: segment.value }],
          }
      )),
    );
  }
  if (replaced) node.children = replaced;
}
