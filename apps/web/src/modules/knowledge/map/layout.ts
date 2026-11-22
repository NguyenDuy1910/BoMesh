/**
 * Knowledge Atlas layout (preview `features/atlas.js` › Layout): a tidy left-to-right tree per root collection, territories
 * packed into lanes under the workspace node, rounded orthogonal connectors. Pure and dependency-free so it is unit-tested
 * and benchmarked (`tests/atlas-layout.test.mts`); a few thousand nodes lay out in a few milliseconds.
 *
 * Box sizes depend only on counts the collection list already carries (`collection.documentCount`), never on document
 * titles, so documents load lazily per container without moving anything.
 */

/** World geometry in px at 100 % (preview `G`). */
export const G = {
  pad: 40,
  gapX: 56,
  gapY: 10,
  gapYGroup: 18,
  ws: [208, 64],
  org: [240, 60],
  doc: [264, 38],
  clusterW: 284,
  row: 30,
  band: { padX: 20, top: 48, bottom: 20, gap: 32 },
  lane: { gutter: 38, gap: 40, top: 44 },
} as const;
/** Documents shown in a cluster before "+N more"; fewer than CLUSTER_AT documents are drawn one by one. */
export const CLUSTER_SHOW = 3;
export const CLUSTER_AT = 4;
/** Collections at this depth and deeper start folded (root = 1). */
export const FOLD_DEPTH = 3;
export const clusterHeight = (rows: number) => 40 + rows * G.row + 34;

/** One collection of the workspace's tree (readable ones; locked roots carry no counts or children). */
export interface AtlasCollection {
  /** Full resource name (`workspaces/{w}/items/{i}`). */
  name: string;
  displayName: string;
  description: string;
  /** Root's territory colour (inherited by its subtree). */
  tone: string;
  depth: number;
  locked: boolean;
  /** Published readable documents in the subtree (`collection.documentCount`). */
  count: number;
  /** Documents directly in this collection (count minus its sub-collections' counts). */
  direct: number;
  kids: AtlasCollection[];
}

export interface CollectionInput {
  name: string;
  parentItem?: string;
  displayName?: string;
  description?: string;
  documentCount?: number;
  locked?: boolean;
  personal?: boolean;
  tone: string;
}

const byName = (a: { displayName: string }, b: { displayName: string }) =>
  a.displayName.localeCompare(b.displayName, "vi", {
    numeric: true,
    sensitivity: "base",
  });

/**
 * The workspace's collections as roots with their nested collections. Personal collections are never drawn; collections
 * holding no readable document are dropped (a locked root stays: its count is unknown to the caller). Unreachable parents
 * (missing, cycles) make their collections vanish rather than float.
 */
export function buildCollectionTree(items: readonly CollectionInput[]): {
  roots: AtlasCollection[];
  locked: AtlasCollection[];
} {
  const usable = items.filter((i) => !i.personal);
  const byParent = new Map<string, CollectionInput[]>();
  for (const i of usable) {
    const p = i.parentItem ?? "";
    const list = byParent.get(p);
    if (list) list.push(i);
    else byParent.set(p, [i]);
  }
  const seen = new Set<string>();
  const make = (i: CollectionInput, depth: number, tone: string): AtlasCollection => {
    seen.add(i.name);
    const kids = depth < 12 ? (byParent.get(i.name) ?? []).filter((k) => !seen.has(k.name)).map((k) => make(k, depth + 1, tone)) : [];
    const live = kids.filter((k) => k.count > 0).sort(byName);
    const count = Math.max(
      i.documentCount ?? 0,
      live.reduce((a, k) => a + k.count, 0),
    );
    return {
      name: i.name,
      displayName: i.displayName || "Untitled collection",
      description: i.description ?? "",
      tone,
      depth,
      locked: !!i.locked,
      count,
      direct: Math.max(0, count - live.reduce((a, k) => a + k.count, 0)),
      kids: live,
    };
  };
  const roots = (byParent.get("") ?? []).map((r) => make(r, 1, r.tone)).sort(byName);
  return {
    roots: roots.filter((r) => !r.locked && r.count > 0),
    locked: roots.filter((r) => r.locked),
  };
}

/** What a drawn box is. */
export type NodeKind = "ws" | "root" | "org" | "locked" | "doc" | "cluster";

export interface AtlasNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  tone: string;
  /** Ids of the drawn ancestors, workspace first. */
  anc: string[];
  kids: AtlasNode[];
  /** Collection boxes: the collection; doc/cluster: the container. */
  coll?: AtlasCollection;
  /** Collection boxes: open, has something to open, how many groups are hidden while folded. */
  open?: boolean;
  hasKids?: boolean;
  hidden?: number;
  /** doc: its position among the container's documents (search: the matched document's name). */
  index?: number;
  docName?: string;
  /** cluster: documents in the container, rows shown, all shown. */
  total?: number;
  rows?: number;
  all?: boolean;
  /** Lane spine x (territory roots). */
  spine?: number;
}

export interface Territory {
  id: string;
  coll: AtlasCollection;
  locked: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AtlasLayout {
  ws: AtlasNode;
  territories: Territory[];
  /** Every drawn node, parents before children. */
  nodes: AtlasNode[];
  byId: Map<string, AtlasNode>;
  W: number;
  H: number;
  lanes: number;
}

export interface LayoutOptions {
  /** Explicit fold state per collection name; absent = default (FOLD_DEPTH). */
  collapsed: Readonly<Record<string, boolean>>;
  /** Expand all: nothing folds by default, clusters show everything. */
  expandAll: boolean;
  /** Clusters opened with "+N more". */
  clustersOpen: Readonly<Record<string, boolean>>;
  showDocs: boolean;
  /** Search: matched document names per container (a container listed here shows only those, one by one). */
  matches?: ReadonlyMap<string, readonly string[]> | null;
  /** Canvas width ÷ height, to choose the number of lanes. */
  aspect: number;
  /** Keep this lane count (stable lanes across folding); computed when absent. */
  lanes?: number;
}

export const isFolded = (c: AtlasCollection, o: Pick<LayoutOptions, "collapsed" | "expandAll" | "matches">) =>
  !o.matches && (o.collapsed[c.name] ?? (!o.expandAll && c.depth >= FOLD_DEPTH));

function visual(c: AtlasCollection, o: LayoutOptions): AtlasNode {
  const open = !isFolded(c, o);
  const v: AtlasNode = {
    id: c.name,
    kind: c.depth === 1 ? "root" : "org",
    x: 0,
    y: 0,
    w: G.org[0],
    h: G.org[1],
    tone: c.tone,
    anc: [],
    kids: [],
    coll: c,
    open,
    hidden: 0,
  };
  const matched = o.matches?.get(c.name);
  // Searching: matched documents one by one; a container under a name-matched collection keeps all its documents (search
  // narrowing leaves `direct` at 0 everywhere else).
  const docs = matched ? matched.length : o.matches || o.showDocs ? c.direct : 0;
  v.hasKids = docs > 0 || c.kids.length > 0;
  if (!open) {
    v.hidden = (docs ? 1 : 0) + c.kids.length;
    return v;
  }
  if (matched?.length) matched.forEach((docName, index) => v.kids.push(docNode(c, index, docName)));
  else if (docs && docs < CLUSTER_AT) for (let i = 0; i < docs; i++) v.kids.push(docNode(c, i));
  else if (docs) {
    const all = !!(o.clustersOpen[c.name] || o.expandAll);
    const rows = all ? docs : CLUSTER_SHOW;
    v.kids.push({
      id: `c:${c.name}`,
      kind: "cluster",
      x: 0,
      y: 0,
      w: G.clusterW,
      h: clusterHeight(rows),
      tone: c.tone,
      anc: [],
      kids: [],
      coll: c,
      total: docs,
      rows,
      all,
    });
  }
  for (const k of c.kids) v.kids.push(visual(k, o));
  return v;
}
const docNode = (c: AtlasCollection, index: number, docName?: string): AtlasNode => ({
  id: docName ? `d:${docName}` : `d:${c.name}:${index}`,
  kind: "doc",
  x: 0,
  y: 0,
  w: G.doc[0],
  h: G.doc[1],
  tone: c.tone,
  anc: [],
  kids: [],
  coll: c,
  index,
  docName,
});

const shift = (v: AtlasNode, d: number) => {
  v.y += d;
  for (const k of v.kids) shift(k, d);
};
const move = (v: AtlasNode, dx: number, dy: number) => {
  v.x += dx;
  v.y += dy;
  for (const k of v.kids) move(k, dx, dy);
};
/** Where a box is joined: the middle of its first row (a cluster's header, not its middle), so opening a cluster never moves its parent. */
export const anchorY = (v: Pick<AtlasNode, "y" | "h">) => v.y + Math.min(v.h, G.org[1]) / 2;
/** Places v and its subtree with its top at `top`; returns the subtree's height. A parent sits level with its first child. */
function place(v: AtlasNode, x: number, top: number): number {
  v.x = x;
  if (!v.kids.length) {
    v.y = top;
    return v.h;
  }
  const cx = x + v.w + G.gapX;
  let y = top;
  v.kids.forEach((k, i) => {
    if (i) y += k.kids.length || v.kids[i - 1].kids.length ? G.gapYGroup : G.gapY;
    y += place(k, cx, y);
  });
  const first = v.kids[0];
  v.y = anchorY(first) - v.h / 2;
  if (v.y < top) {
    const d = top - v.y;
    for (const k of v.kids) shift(k, d);
    v.y = top;
    return Math.max(y - top + d, v.h);
  }
  return Math.max(y - top, v.y + v.h - top);
}
function extent(v: AtlasNode, b = { x2: 0, y2: 0 }) {
  b.x2 = Math.max(b.x2, v.x + v.w);
  b.y2 = Math.max(b.y2, v.y + v.h);
  for (const k of v.kids) extent(k, b);
  return b;
}

/** Lanes so the atlas is about as wide as the canvas (territories fill lanes in order: 1st, 2nd … then back to the first). */
export function chooseLanes(sizes: readonly { w: number; h: number }[], aspect: number): number {
  let best = 1;
  let score = Infinity;
  for (let n = 1; n <= Math.min(sizes.length, 6); n++) {
    let W = 0;
    let H = 0;
    for (let l = 0; l < n; l++) {
      const lane = sizes.filter((_, i) => i % n === l);
      W += Math.max(...lane.map((t) => t.w)) + G.lane.gutter + G.lane.gap;
      H = Math.max(
        H,
        lane.reduce((a, t) => a + t.h + G.band.gap, 0),
      );
    }
    const s = Math.abs(Math.log(W / H) - Math.log(Math.max(0.2, aspect)));
    if (s < score) {
      score = s;
      best = n;
    }
  }
  return best;
}

/** The whole atlas: the workspace node at the top left; one territory per root collection, in lanes under it. */
export function layoutAtlas(roots: readonly AtlasCollection[], locked: readonly AtlasCollection[], o: LayoutOptions): AtlasLayout {
  const ws: AtlasNode = {
    id: "ws",
    kind: "ws",
    x: G.pad,
    y: G.pad,
    w: G.ws[0],
    h: G.ws[1],
    tone: "",
    anc: [],
    kids: [],
  };
  const items = [
    ...roots.map((c) => ({ v: visual(c, o), coll: c, locked: false })),
    ...locked.map((c) => ({
      v: {
        id: c.name,
        kind: "locked",
        x: 0,
        y: 0,
        w: G.org[0],
        h: G.org[1],
        tone: "",
        anc: [],
        kids: [],
        coll: c,
      } as AtlasNode,
      coll: c,
      locked: true,
    })),
  ].map((t) => {
    const h = place(t.v, G.band.padX, G.band.top);
    const b = extent(t.v);
    return {
      ...t,
      w: b.x2 + G.band.padX,
      h: Math.max(h, b.y2 - G.band.top) + G.band.top + G.band.bottom,
      x: 0,
      y: 0,
    };
  });
  const lanes = items.length ? Math.min(o.lanes ?? chooseLanes(items, o.aspect), items.length) : 1;
  const top = ws.y + ws.h + G.lane.top;
  let x = ws.x + 20 + G.lane.gutter;
  let H = 0;
  for (let l = 0; l < lanes; l++) {
    const lane = items.filter((_, i) => i % lanes === l);
    // Each lane has a spine in its left gutter; the first lane's spine drops straight from the workspace node.
    const spine = l ? x - G.lane.gutter / 2 : ws.x + 20;
    let y = top;
    for (const t of lane) {
      t.x = x;
      t.y = y;
      move(t.v, x, y);
      t.v.spine = spine;
      y += t.h + G.band.gap;
    }
    H = Math.max(H, y - G.band.gap);
    x += Math.max(0, ...lane.map((t) => t.w)) + G.lane.gap + G.lane.gutter;
  }
  ws.kids = items.map((t) => t.v);
  const nodes: AtlasNode[] = [];
  const byId = new Map<string, AtlasNode>();
  (function walk(v: AtlasNode, anc: string[]) {
    v.anc = anc;
    nodes.push(v);
    byId.set(v.id, v);
    const next = [...anc, v.id];
    for (const k of v.kids) walk(k, next);
  })(ws, []);
  return {
    ws,
    territories: items.map((t) => ({
      id: t.v.id,
      coll: t.coll,
      locked: t.locked,
      x: t.x,
      y: t.y,
      w: t.w,
      h: t.h,
    })),
    nodes,
    byId,
    W: x - G.lane.gap - G.lane.gutter + G.pad,
    H: H + G.pad,
    lanes,
  };
}

/** A polyline through orthogonal points with rounded corners. */
export function roundPath(pts: readonly (readonly [number, number])[], r = 10): string {
  const dedup = pts.filter((q, i) => !i || q[0] !== pts[i - 1][0] || q[1] !== pts[i - 1][1]);
  const p = dedup.filter(
    (q, i, a) =>
      i === 0 || i === a.length - 1 || !((a[i - 1][0] === q[0] && q[0] === a[i + 1][0]) || (a[i - 1][1] === q[1] && q[1] === a[i + 1][1])),
  );
  let d = `M${p[0][0]} ${p[0][1]}`;
  for (let i = 1; i < p.length; i++) {
    const [x, y] = p[i];
    if (i === p.length - 1) {
      d += `L${x} ${y}`;
      break;
    }
    const [px, py] = p[i - 1];
    const [nx, ny] = p[i + 1];
    const rr = Math.min(r, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2);
    d += `L${x - Math.sign(x - px) * rr} ${y - Math.sign(y - py) * rr}Q${x} ${y} ${x + Math.sign(nx - x) * rr} ${y + Math.sign(ny - y) * rr}`;
  }
  return d;
}

/** Connector from a parent's right edge to a child's left edge; from the workspace, a bus down each lane's spine. */
export function edgePath(p: AtlasNode, c: AtlasNode): string {
  if (p.kind === "ws") {
    const x1 = p.x + 20;
    const bus = p.y + p.h + G.lane.top / 2;
    const spine = c.spine ?? x1;
    return roundPath([
      [x1, p.y + p.h],
      [x1, bus],
      [spine, bus],
      [spine, anchorY(c)],
      [c.x, anchorY(c)],
    ]);
  }
  const x1 = p.x + p.w;
  const xm = x1 + G.gapX / 2;
  return roundPath([
    [x1, anchorY(p)],
    [xm, anchorY(p)],
    [xm, anchorY(c)],
    [c.x, anchorY(c)],
  ]);
}

/** The selected node's path and everything under it. */
export function relatedTo(v: AtlasNode | undefined): Set<string> | null {
  if (!v) return null;
  const set = new Set([...v.anc, v.id]);
  (function down(x: AtlasNode) {
    for (const k of x.kids) {
      set.add(k.id);
      down(k);
    }
  })(v);
  return set;
}

/** The workspace's level names by depth (preview `TEMPLATES[t].levels`; the API stores the template, not a vocabulary yet). */
export const LEVELS = {
  CAMPUS: ["Faculty", "Academic department", "Program group", "Major"],
  ENTERPRISE: ["Area", "Section", "Subsection", "Folder"],
} as const;
export const levelOf = (levels: readonly string[], depth: number) => levels[Math.min(depth, levels.length) - 1] ?? "Folder";
