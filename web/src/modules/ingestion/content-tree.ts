/**
 * Choosing what a source reads, from a provider tree loaded one level at a
 * time (`GET /connections/{id}/resources?parent_id=`).
 *
 * Selecting a node covers it and everything under it — a Confluence page is
 * synced with its subtree, a Drive folder with its subfolders — so a selected
 * node's descendants read as checked and cannot be picked on their own, and
 * picking a node drops descendants that were picked before. A node with some
 * picked descendants is mixed. Picking every child individually does not pick
 * the parent: the parent's own pages or files would then be left out, so the
 * tree says exactly what will be synced.
 */

export interface ContentNode {
  /** The provider's `external_id`. */
  id: string;
  name: string;
  resourceType: string;
  parentId: string | null;
  hasChildren: boolean;
}

export interface ContentTree {
  nodes: Readonly<Record<string, ContentNode>>;
  /** Loaded child ids by parent id; top-level nodes are under `ROOT`. */
  children: Readonly<Record<string, readonly string[]>>;
}

export const ROOT = "";
export const EMPTY_TREE: ContentTree = { nodes: {}, children: {} };

export type CheckState = "checked" | "mixed" | "unchecked";

/** Records one loaded level. Nodes keep the parent they were listed under. */
export function addChildren(tree: ContentTree, parentId: string | null, nodes: readonly ContentNode[]): ContentTree {
  const next = { ...tree.nodes };
  for (const node of nodes) next[node.id] = { ...node, parentId: parentId ?? node.parentId };
  return { nodes: next, children: { ...tree.children, [parentId ?? ROOT]: nodes.map((node) => node.id) } };
}

/** Records nodes found by a search without claiming to know their siblings. */
export function addNodes(tree: ContentTree, nodes: readonly ContentNode[]): ContentTree {
  const next = { ...tree.nodes };
  for (const node of nodes) next[node.id] = { ...node, parentId: next[node.id]?.parentId ?? node.parentId };
  return { ...tree, nodes: next };
}

/** Known ancestors, nearest first. */
export function ancestors(tree: ContentTree, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let current = tree.nodes[id]?.parentId ?? null;
  while (current && tree.nodes[current] && !seen.has(current)) {
    seen.add(current);
    out.push(current);
    current = tree.nodes[current].parentId;
  }
  return out;
}

/** The selected ancestor that already covers `id`, if any. */
export function coveringAncestor(tree: ContentTree, selection: readonly string[], id: string): string | null {
  return ancestors(tree, id).find((ancestor) => selection.includes(ancestor)) ?? null;
}

export function checkState(tree: ContentTree, selection: readonly string[], id: string): CheckState {
  if (selection.includes(id) || coveringAncestor(tree, selection, id)) return "checked";
  // Anything picked below it — loaded in the tree or found by a search — makes it mixed.
  return selection.some((selected) => ancestors(tree, selected).includes(id)) ? "mixed" : "unchecked";
}

/**
 * Toggle `id`. A covered node does not change (its ancestor decides); picking
 * a node drops the descendants it now covers.
 */
export function toggleSelection(tree: ContentTree, selection: readonly string[], id: string): string[] {
  if (selection.includes(id)) return selection.filter((selected) => selected !== id);
  if (coveringAncestor(tree, selection, id)) return [...selection];
  return [...selection.filter((selected) => !ancestors(tree, selected).includes(id)), id];
}

/** "Engineering / Runbooks". Unknown ancestors are left out rather than guessed. */
export function pathOf(tree: ContentTree, id: string): string {
  const names = [id, ...ancestors(tree, id)].reverse().map((node) => tree.nodes[node]?.name).filter(Boolean);
  return names.join(" / ");
}

/**
 * A source's name for one picked node. A Confluence page is named with its
 * space ("People Ops — Policies"), a space as "People Ops space"; anything else
 * by its own name. `taken` names already in use get a number.
 */
export function sourceNameFor(
  tree: ContentTree,
  id: string,
  connectorKey: string,
  taken: Iterable<string> = [],
): string {
  const node = tree.nodes[id];
  let name = node?.name ?? "Untitled source";
  if (node && connectorKey === "confluence") {
    const top = ancestors(tree, id).at(-1);
    if (top && top !== id) name = `${tree.nodes[top].name} — ${node.name}`;
    else if (node.resourceType === "space") name = `${node.name} space`;
  }
  const used = new Set(Array.from(taken, (value) => value.toLowerCase()));
  let candidate = name;
  for (let index = 2; used.has(candidate.toLowerCase()); index += 1) candidate = `${name} ${index}`;
  return candidate;
}
