import assert from "node:assert/strict";
import test from "node:test";

import {
  compareSortValues,
  isConfirmationSatisfied,
  nextMenuIndex,
  nextSort,
  pagerRange,
  selectionState,
  toggleAllSelection,
  typeaheadIndex,
} from "../src/components/ui/interaction.ts";

test("menu arrows wrap, Home/End jump, and an unfocused menu starts at the matching end", () => {
  assert.equal(nextMenuIndex("ArrowDown", 2, 3), 0);
  assert.equal(nextMenuIndex("ArrowUp", 0, 3), 2);
  assert.equal(nextMenuIndex("ArrowDown", -1, 3), 0);
  assert.equal(nextMenuIndex("ArrowUp", -1, 3), 2);
  assert.equal(nextMenuIndex("End", 0, 4), 3);
  assert.equal(nextMenuIndex("Home", 3, 4), 0);
  assert.equal(nextMenuIndex("Enter", 1, 4), null);
  assert.equal(nextMenuIndex("ArrowDown", -1, 0), null);
});

test("type-ahead moves past the current item, wraps, and cycles on a repeated letter", () => {
  const labels = ["Delete", "Duplicate", "Rename", "Download"];
  assert.equal(typeaheadIndex(labels, "d", 0), 1);
  assert.equal(typeaheadIndex(labels, "d", 3), 0);
  assert.equal(typeaheadIndex(labels, "dd", 1), 3);
  assert.equal(typeaheadIndex(labels, "do", -1), 3);
  // A multi-letter query may stay on the current item when it still matches.
  assert.equal(typeaheadIndex(labels, "re", 2), 2);
  assert.equal(typeaheadIndex(labels, "x", 0), -1);
});

test("pager clamps the page and reports human row numbers", () => {
  assert.deepEqual(pagerRange(2, 20, 45), {
    pageCount: 3,
    page: 2,
    start: 20,
    end: 40,
    from: 21,
    to: 40,
    hasPrevious: true,
    hasNext: true,
  });
  const last = pagerRange(9, 20, 45);
  assert.equal(last.page, 3);
  assert.equal(last.to, 45);
  assert.equal(last.hasNext, false);
  const empty = pagerRange(1, 20, 0);
  assert.equal(empty.pageCount, 1);
  assert.equal(empty.from, 0);
  assert.equal(empty.hasNext, false);
  assert.equal(empty.hasPrevious, false);
});

test("header checkbox selects the visible page and keeps selections from other pages", () => {
  assert.equal(selectionState(["a", "b"], []), "none");
  assert.equal(selectionState(["a", "b"], ["a", "z"]), "some");
  assert.equal(selectionState(["a", "b"], ["b", "a"]), "all");
  assert.equal(selectionState([], ["a"]), "none");
  assert.deepEqual(toggleAllSelection(["a", "b"], ["z", "a"]).sort(), ["a", "b", "z"]);
  assert.deepEqual(toggleAllSelection(["a", "b"], ["z", "a", "b"]), ["z"]);
});

test("sorting cycles ascending, descending, unsorted and restarts on a new column", () => {
  const ascending = nextSort(null, "name");
  assert.deepEqual(ascending, { columnId: "name", direction: "asc" });
  const descending = nextSort(ascending, "name");
  assert.deepEqual(descending, { columnId: "name", direction: "desc" });
  assert.equal(nextSort(descending, "name"), null);
  assert.deepEqual(nextSort(descending, "updated"), { columnId: "updated", direction: "asc" });
});

test("sort values compare numbers numerically, text naturally, and put blanks last", () => {
  assert.ok(compareSortValues(9, 10) < 0);
  assert.ok(compareSortValues("file 9", "file 10") < 0);
  assert.ok(compareSortValues("alpha", "Beta") < 0);
  assert.ok(compareSortValues(null, "a") > 0);
  assert.ok(compareSortValues("a", undefined) < 0);
  assert.ok(compareSortValues(new Date(2026, 0, 2), new Date(2026, 0, 1)) > 0);
});

test("typed confirmation needs the exact text when one is required", () => {
  assert.equal(isConfirmationSatisfied(undefined, ""), true);
  assert.equal(isConfirmationSatisfied("northwind", "northwind"), true);
  assert.equal(isConfirmationSatisfied("northwind", "Northwind"), false);
  assert.equal(isConfirmationSatisfied("northwind", "northwind "), false);
  assert.equal(isConfirmationSatisfied("northwind", ""), false);
});
