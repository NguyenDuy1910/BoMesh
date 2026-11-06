import assert from "node:assert/strict";
import test from "node:test";

import { addChildren, checkState, EMPTY_TREE, matches, pathOf, ROOT, sourceNameFor, toggleSelection, type ContentNode } from "../src/modules/ingestion/content-tree.ts";

const node = (id: string, name: string, type = "folder", hasChildren = false): ContentNode => ({ id, name, type, path: id, hasChildren });

let tree = addChildren(EMPTY_TREE, ROOT, [node("my", "My Drive", "drive", true), node("sd", "Shared drives", "drive", true)]);
tree = addChildren(tree, "sd", [node("sales", "Sales Enablement", "folder", true), node("legal", "Legal")]);
tree = addChildren(tree, "sales", [node("decks", "Pitch decks"), node("price", "Pricing")]);

test("selecting a node covers its subtree and replaces selected descendants", () => {
  let sel = toggleSelection(tree, [], "decks");
  assert.deepEqual(sel, ["decks"]);
  assert.equal(checkState(tree, sel, "sales"), "some");
  assert.equal(checkState(tree, sel, "sd"), "some");
  sel = toggleSelection(tree, sel, "sales");
  assert.deepEqual(sel, ["sales"]);
  assert.equal(checkState(tree, sel, "price"), "all");
  assert.equal(checkState(tree, sel, "my"), "none");
});

test("selecting every child selects the parent instead", () => {
  let sel = toggleSelection(tree, [], "decks");
  sel = toggleSelection(tree, sel, "price");
  assert.deepEqual(sel, ["sales"]);
  sel = toggleSelection(tree, sel, "legal");
  assert.deepEqual(sel, ["sd"]);
});

test("clearing a node under a selected ancestor keeps its siblings", () => {
  const sel = toggleSelection(tree, ["sd"], "decks");
  assert.deepEqual(sel.sort(), ["legal", "price"]);
  assert.equal(checkState(tree, sel, "sales"), "some");
  assert.deepEqual(toggleSelection(tree, ["sales"], "sales"), []);
});

test("paths, search and source names", () => {
  assert.equal(pathOf(tree, "price"), "Shared drives / Sales Enablement / Pricing");
  assert.equal(matches(tree, "sd", "pitch"), true);
  assert.equal(matches(tree, "my", "pitch"), false);
  assert.equal(sourceNameFor(tree, "price", "gdrive", ["Pricing"]), "Pricing 2");

  let wiki = addChildren(EMPTY_TREE, ROOT, [node("po", "People Ops", "space", true)]);
  wiki = addChildren(wiki, "po", [node("pol", "Policies", "page")]);
  assert.equal(sourceNameFor(wiki, "po", "confluence"), "People Ops space");
  assert.equal(sourceNameFor(wiki, "pol", "confluence"), "People Ops — Policies");
});
