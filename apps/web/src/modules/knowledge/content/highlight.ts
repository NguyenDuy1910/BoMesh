/**
 * Which blocks of a Content View window a reference highlights: blocks are marked by ref, never by matching text.
 *
 * Pure and dependency-free so it runs under `node --test`.
 */

/** The part of a `ContentNode` the highlight reads. */
export interface RefNode {
  readonly ref: string;
  readonly children?: readonly RefNode[];
}

export interface CitedBlocks {
  /** Refs of the blocks to mark: every node (at any depth, list items included) whose ref is cited. */
  marked: ReadonlySet<string>;
  /** The first marked block in reading order (scrolled into view and marked strongest), or `""`. */
  first: string;
}

export const NO_CITED_BLOCKS: CitedBlocks = { marked: new Set(), first: "" };

/** The blocks of `nodes` that `refs` cite. A cited list marks the whole list; a cited list item marks only that item. */
export function citedBlocks(nodes: readonly RefNode[], refs: readonly string[]): CitedBlocks {
  if (!refs.length || !nodes.length) return NO_CITED_BLOCKS;
  const wanted = new Set(refs);
  const marked = new Set<string>();
  let first = "";
  const visit = (list: readonly RefNode[]) => {
    for (const node of list) {
      if (wanted.has(node.ref)) {
        marked.add(node.ref);
        first ||= node.ref;
      }
      if (node.children?.length) visit(node.children);
    }
  };
  visit(nodes);
  return marked.size ? { marked, first } : NO_CITED_BLOCKS;
}
