/**
 * The connect wizard's content picker: a provider tree loaded one level at a
 * time (`connections/{c}:browseResources?path=`) with tri-state selection.
 *
 * A selected node covers its whole subtree (new files inside it sync too), so
 * the selection is kept as the top-most selected nodes; each becomes one
 * source. Children lists are complete once loaded (the browse call reads every
 * page), so when every child of a node is selected the node itself is selected
 * instead. Pure: no React, no API.
 */

export interface ContentNode {
  /** Provider resource ID. */
  id: string;
  name: string;
  /** Provider resource type (`folder`, `drive`, `space`, `page`, …). */
  type: string;
  /** Browse path for its children. */
  path: string;
  hasChildren: boolean;
}

export interface ContentTree {
  nodes: Readonly<Record<string, ContentNode>>;
  /** Parent ID (ROOT for the top level) → child IDs, once loaded. */
  children: Readonly<Record<string, readonly string[]>>;
  parent: Readonly<Record<string, string>>;
}

export const ROOT = "";
export const EMPTY_TREE: ContentTree = { nodes: {}, children: {}, parent: {} };

export type CheckState = "all" | "some" | "none";

/** Records one loaded level under `parentId` (ROOT for the top). */
export function addChildren(tree: ContentTree, parentId: string, nodes: readonly ContentNode[]): ContentTree {
  const next = { nodes: { ...tree.nodes }, children: { ...tree.children, [parentId]: nodes.map((n) => n.id) }, parent: { ...tree.parent } };
  for (const node of nodes) {
    next.nodes[node.id] = node;
    next.parent[node.id] = parentId;
  }
  return next;
}

/** Known ancestors, nearest first (ROOT excluded). */
export function ancestors(tree: ContentTree, id: string): string[] {
  const out: string[] = [];
  let at = tree.parent[id];
  while (at !== undefined && at !== ROOT) {
    out.push(at);
    at = tree.parent[at];
  }
  return out;
}

function descendants(tree: ContentTree, id: string): string[] {
  const out: string[] = [];
  const walk = (parent: string) => {
    for (const child of tree.children[parent] ?? []) {
      out.push(child);
      walk(child);
    }
  };
  walk(id);
  return out;
}

export function checkState(tree: ContentTree, selection: readonly string[], id: string): CheckState {
  if (selection.includes(id) || ancestors(tree, id).some((a) => selection.includes(a))) return "all";
  return descendants(tree, id).some((d) => selection.includes(d)) ? "some" : "none";
}

/** Replace fully selected sibling sets with their parent, bottom-up. */
function normalize(tree: ContentTree, selection: readonly string[]): string[] {
  let out = [...selection];
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of out) {
      const parent = tree.parent[id];
      if (parent === undefined || parent === ROOT) continue;
      const siblings = tree.children[parent] ?? [];
      if (siblings.length && siblings.every((s) => out.includes(s))) {
        out = [...out.filter((s) => !siblings.includes(s)), parent];
        changed = true;
        break;
      }
    }
  }
  return out;
}

/**
 * Toggle `id`: a fully selected node clears (when an ancestor covers it, that
 * ancestor splits into the node's selected siblings); otherwise it is selected
 * and replaces any selected descendants.
 */
export function toggleSelection(tree: ContentTree, selection: readonly string[], id: string): string[] {
  if (checkState(tree, selection, id) !== "all") {
    const inside = new Set(descendants(tree, id));
    return normalize(tree, [...selection.filter((s) => !inside.has(s)), id]);
  }
  if (selection.includes(id)) return selection.filter((s) => s !== id);
  // Covered by an ancestor: keep everything under it except the path to `id`.
  const chain = [id, ...ancestors(tree, id)];
  const top = chain.findIndex((a) => selection.includes(a));
  const out = selection.filter((s) => s !== chain[top]);
  for (let i = top; i > 0; i--) {
    const keep = chain[i - 1];
    for (const sibling of tree.children[chain[i] ?? ""] ?? []) if (sibling !== keep) out.push(sibling);
  }
  return out;
}

/** "Shared drives / Sales Enablement". */
export function pathOf(tree: ContentTree, id: string): string {
  return [id, ...ancestors(tree, id)]
    .reverse()
    .map((a) => tree.nodes[a]?.name ?? "")
    .filter(Boolean)
    .join(" / ");
}

/** Whether a node or one of its loaded descendants matches the search. */
export function matches(tree: ContentTree, id: string, q: string): boolean {
  if (!q) return true;
  if ((tree.nodes[id]?.name ?? "").toLowerCase().includes(q)) return true;
  return (tree.children[id] ?? []).some((child) => matches(tree, child, q));
}

/**
 * A source's name for one picked node. Confluence pages are named with their
 * space ("People Ops — Policies") and a space as "People Ops space"; anything
 * else by its own name. Names in `taken` get a number ("Pricing 2").
 */
export function sourceNameFor(tree: ContentTree, id: string, app: string, taken: Iterable<string> = []): string {
  const node = tree.nodes[id];
  if (!node) return "";
  let name = node.name;
  if (app === "confluence") {
    const chain = ancestors(tree, id);
    const top = tree.nodes[chain[chain.length - 1] ?? id] ?? node;
    name = top === node ? `${top.name} space` : `${top.name} — ${node.name}`;
  }
  const used = new Set(taken);
  let candidate = name;
  for (let i = 2; used.has(candidate); i++) candidate = `${name} ${i}`;
  return candidate;
}
