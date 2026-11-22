import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCollectionTree,
  CLUSTER_SHOW,
  layoutAtlas,
  type CollectionInput,
  type LayoutOptions,
} from "../src/modules/knowledge/map/layout.ts";
import { narrowTree } from "../src/modules/knowledge/map/match.ts";

const opts = (o: Partial<LayoutOptions> = {}): LayoutOptions => ({
  collapsed: {},
  expandAll: false,
  clustersOpen: {},
  showDocs: true,
  aspect: 1.6,
  ...o,
});
const c = (name: string, parentItem: string, documentCount: number, extra: Partial<CollectionInput> = {}): CollectionInput => ({
  name,
  parentItem,
  displayName: name,
  documentCount,
  tone: "#336699",
  ...extra,
});

/** A generated workspace: `roots` roots, each `fan` children per level, `depth` levels, `docs` documents directly in every collection. */
function workspace(roots: number, fan: number, depth: number, docs: number): CollectionInput[] {
  const out: CollectionInput[] = [];
  const grow = (name: string, parent: string, level: number): number => {
    let total = docs;
    if (level < depth) for (let i = 0; i < fan; i++) total += grow(`${name}.${i}`, name, level + 1);
    out.push(c(name, parent, total));
    return total;
  };
  for (let r = 0; r < roots; r++) grow(`r${r}`, "", 1);
  return out;
}

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test("the tree drops personal and empty collections, keeps locked roots apart and derives direct counts", () => {
  const { roots, locked } = buildCollectionTree([
    c("a", "", 10),
    c("a1", "a", 4),
    c("a2", "a", 0),
    c("mine", "", 7, { personal: true }),
    c("empty", "", 0),
    c("hr", "", 0, { locked: true }),
    c("orphan", "missing", 3),
  ]);
  assert.deepEqual(
    roots.map((r) => r.name),
    ["a"],
  );
  assert.deepEqual(
    roots[0].kids.map((k) => k.name),
    ["a1"],
  );
  assert.equal(roots[0].direct, 6);
  assert.deepEqual(
    locked.map((r) => r.name),
    ["hr"],
  );
});

test("boxes never overlap and folders from level 3 start folded", () => {
  const { roots, locked } = buildCollectionTree(workspace(5, 3, 4, 5));
  const L = layoutAtlas(roots, locked, opts());
  const boxes = L.nodes.filter((n) => n.kind !== "ws");
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlaps(boxes[i], boxes[j]), `${boxes[i].id} overlaps ${boxes[j].id}`);
  const depth3 = L.nodes.filter((n) => n.coll?.depth === 3 && (n.kind === "org" || n.kind === "root"));
  assert.ok(depth3.length > 0 && depth3.every((n) => !n.open && n.kids.length === 0));
  for (const t of L.territories) for (const u of L.territories) if (t !== u) assert.ok(!overlaps(t, u), "territories overlap");
});

test("many documents in one place become a cluster; opening it grows the box, never moves the parent", () => {
  const items = [c("a", "", 40), c("a1", "a", 2)];
  const { roots } = buildCollectionTree(items);
  const closed = layoutAtlas(roots, [], opts({ lanes: 1 }));
  const cluster = closed.byId.get("c:a");
  assert.equal(cluster?.total, 38);
  assert.equal(cluster?.rows, CLUSTER_SHOW);
  const opened = layoutAtlas(roots, [], opts({ lanes: 1, clustersOpen: { a: true } }));
  assert.equal(opened.byId.get("c:a")?.rows, 38);
  assert.deepEqual([opened.byId.get("a")?.x, opened.byId.get("a")?.y], [closed.byId.get("a")?.x, closed.byId.get("a")?.y]);
  assert.equal(layoutAtlas(roots, [], opts({ lanes: 1 })).byId.get("d:a1:1")?.kind, "doc");
});

test("search draws only matched documents, one by one, under every container on their path", () => {
  const { roots } = buildCollectionTree([c("a", "", 40), c("a1", "a", 20), c("b", "", 5)]);
  const matches = new Map([["a1", ["doc-7", "doc-9"]]]);
  const shown = roots.map((r) => narrowTree(r, ["zzz"], matches)).filter((r) => r !== null);
  assert.deepEqual(
    shown.map((r) => r.name),
    ["a"],
  );
  const L = layoutAtlas(shown, [], opts({ matches }));
  assert.ok(L.byId.has("d:doc-7") && L.byId.has("d:doc-9"));
  assert.ok(![...L.byId.keys()].some((id) => id.startsWith("c:")));
});

test("search keeps every document under a collection whose name matches", () => {
  const { roots } = buildCollectionTree([c("a", "", 40), c("a1", "a", 20), c("b", "", 5)]);
  const shown = roots.map((r) => narrowTree(r, ["a1"], new Map())).filter((r) => r !== null);
  const L = layoutAtlas(shown, [], opts({ matches: new Map() }));
  assert.ok(L.byId.has("c:a1"), "a1's 20 documents stay as a cluster");
});

test("lanes spread many territories sideways on a wide canvas", () => {
  const { roots } = buildCollectionTree(workspace(9, 2, 2, 3));
  const wide = layoutAtlas(roots, [], opts({ aspect: 2.4 })).lanes;
  const tall = layoutAtlas(roots, [], opts({ aspect: 0.3 })).lanes;
  assert.ok(wide > tall, `${wide} lanes on a wide canvas, ${tall} on a tall one`);
});

test("a large workspace lays out fast enough to recompute on every interaction", () => {
  // 8 roots × 5³ — about 1,250 collections; Expand all draws every collection and every cluster.
  const items = workspace(8, 5, 4, 6);
  const t0 = performance.now();
  const { roots, locked } = buildCollectionTree(items);
  const L = layoutAtlas(roots, locked, opts({ expandAll: true }));
  const ms = performance.now() - t0;
  assert.ok(L.nodes.length > 2000, `${L.nodes.length} nodes`);
  assert.ok(ms < 120, `layout took ${ms.toFixed(1)} ms`);
});
