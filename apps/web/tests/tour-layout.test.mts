import assert from "node:assert/strict";
import test from "node:test";

import { placeCard, resolveStep, revealBy, stepAfter, type Box } from "../src/components/shell/tourLayout.ts";

const ORDER = ["ask", "start", "picks", "domains", "chat", "search"];
const VIEW: Box = { left: 0, top: 0, right: 1440, bottom: 900 };
const CARD = { width: 320, height: 200 };

const overlaps = (at: { left: number; top: number }, t: Box) =>
  at.left < t.right && at.left + CARD.width > t.left && at.top < t.bottom && at.top + CARD.height > t.top;

test("resolveStep keeps the current step while its target is on screen", () => {
  assert.equal(resolveStep(ORDER, ["ask", "start", "domains"], "start"), "start");
});

test("resolveStep moves to the next step on screen when the current target went away", () => {
  // Picked for you disappeared: Explore by domain comes next, not the start of the tour.
  assert.equal(resolveStep(ORDER, ["ask", "start", "domains", "chat"], "picks"), "domains");
});

test("resolveStep falls back to the last step before it, and to nothing when no step is on screen", () => {
  assert.equal(resolveStep(ORDER, ["ask", "start"], "search"), "start");
  assert.equal(resolveStep(ORDER, [], "ask"), null);
});

test("stepAfter skips steps that aren't on screen and ends past either end", () => {
  const shown = ["ask", "start", "domains", "search"];
  assert.equal(stepAfter(shown, "start", 1), "domains");
  assert.equal(stepAfter(shown, "domains", -1), "start");
  assert.equal(stepAfter(shown, "search", 1), null);
  assert.equal(stepAfter(shown, "ask", -1), null);
});

test("placeCard puts the card to the right of a sidebar item, vertically centred on it", () => {
  const navItem: Box = { left: 8, top: 300, right: 252, bottom: 336 };
  const at = placeCard(navItem, CARD, VIEW, "sidebar");
  assert.equal(at.left, navItem.right + 12);
  assert.equal(at.top, 318 - CARD.height / 2);
  assert.equal(overlaps(at, navItem), false);
});

test("placeCard puts the card below a main-content target even when it would fit beside it, off the sidebar", () => {
  // Home's Ask box at 1440 px: there is room on its left, but that is the sidebar.
  const composer: Box = { left: 478, top: 262, right: 1210, bottom: 444 };
  const at = placeCard(composer, CARD, VIEW, "main");
  assert.equal(at.top, composer.bottom + 12);
  assert.ok(at.left >= 260, "not over the sidebar");
  assert.equal(overlaps(at, composer), false);
});

test("placeCard puts the card above a main-content target near the bottom of the view", () => {
  const section: Box = { left: 300, top: 600, right: 1300, bottom: 860 };
  const at = placeCard(section, CARD, VIEW, "main");
  assert.equal(at.top, section.top - 12 - CARD.height);
  assert.equal(overlaps(at, section), false);
});

test("placeCard puts the card beside a main-content target only when neither below nor above fits", () => {
  const tall: Box = { left: 300, top: 100, right: 900, bottom: 800 };
  const at = placeCard(tall, CARD, VIEW, "main");
  assert.equal(at.left, tall.right + 12);
  assert.equal(overlaps(at, tall), false);
});

test("placeCard stays in view and covers as little as it can when nothing fits", () => {
  const huge: Box = { left: 100, top: 20, right: 1400, bottom: 880 };
  const at = placeCard(huge, CARD, VIEW, "main");
  assert.ok(at.left >= 12 && at.left + CARD.width <= VIEW.right - 12);
  assert.ok(at.top >= 12 && at.top + CARD.height <= VIEW.bottom - 12);
  // Left of the target is the narrowest overlap: only 100 − 12 px of the card are beside it.
  assert.equal(at.left, 12);
});

test("revealBy leaves a visible target alone, centres one that fits and top-aligns a taller one", () => {
  assert.equal(revealBy({ left: 0, top: 200, right: 10, bottom: 400 }, 100, 800), 0);
  assert.equal(revealBy({ left: 0, top: 900, right: 10, bottom: 1100 }, 100, 800), 900 - (100 + 250));
  assert.equal(revealBy({ left: 0, top: 900, right: 10, bottom: 2000 }, 100, 800), 800);
});
