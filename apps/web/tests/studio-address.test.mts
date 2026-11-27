import assert from "node:assert/strict";
import test from "node:test";

import "./support/register-aliases.mjs";

const { studioAddress } = await import("../src/lib/navigation.ts");

const at = (qs: string) => {
  const next = studioAddress(Object.fromEntries(new URLSearchParams(qs)));
  return next && new URLSearchParams(next).toString();
};

test("current Studio addresses stay as they are", () => {
  for (const qs of [
    "tab=documents",
    "tab=documents&view=all&processing=pending",
    "tab=documents&view=all&pub=unpublished",
    "tab=documents&view=all&quality=details",
    "tab=documents&view=processing&state=failed",
    "tab=taxonomy",
    "tab=taxonomy&view=suggestions",
    "tab=taxonomy&view=domain&node=cntt",
    "tab=taxonomy&import=1",
    "tab=collections",
    "tab=sources&view=history",
    "",
  ]) {
    assert.equal(at(qs), null, qs);
  }
});

test("old Review, Knowledge flow and Needs you addresses land on Documents → Review", () => {
  assert.equal(at("tab=flow&mode=needs&queue=publish"), "tab=documents&view=review");
  assert.equal(at("tab=review"), "tab=documents&view=review");
  assert.equal(at("tab=review&queue=submissions&kb=k1"), "tab=documents&kb=k1&view=review");
  assert.equal(at("tab=review&sel=c1"), "tab=documents&sel=c1&view=review");
  assert.equal(at("tab=documents&stage=decide"), "tab=documents&view=review");
  assert.equal(at("tab=documents&life=review"), "tab=documents&view=review");
  assert.equal(at("tab=documents&life=changes"), "tab=documents&view=review");
  assert.equal(at("queue=batches"), "tab=documents&view=review");
});

test("old Issues and problems addresses land on Documents → Processing", () => {
  assert.equal(at("tab=review&queue=problems&kb=k1"), "tab=documents&kb=k1&view=processing");
  assert.equal(at("queue=issues"), "tab=documents&view=processing");
  assert.equal(at("tab=documents&life=attention"), "tab=documents&view=processing");
  assert.equal(at("tab=flow&stage=issue"), "tab=documents&view=processing");
  assert.equal(at("tab=documents&view=issues&kb=k1"), "tab=documents&view=processing&kb=k1");
});

test("the retired ?life= stage filter lands on a view or All's processing and publication filters", () => {
  assert.equal(at("tab=documents&view=all&life=publishing&kb=k1"), "tab=documents&view=all&kb=k1&processing=processing");
  assert.equal(at("tab=documents&view=all&life=published"), "tab=documents&view=all&pub=published");
  assert.equal(at("tab=documents&life=closed"), "tab=documents&view=all&pub=unpublished");
  assert.equal(at("tab=documents&life=rejected"), "tab=documents&view=all");
});

test("old Quality, Upkeep and Knowledge health addresses land on All filtered by their quality list", () => {
  assert.equal(at("tab=quality"), "tab=documents&view=all&quality=reverify");
  assert.equal(at("tab=quality&seg=duplicates"), "tab=documents&view=all&quality=duplicates");
  assert.equal(at("tab=review&queue=reverify"), "tab=documents&view=all&quality=reverify");
  assert.equal(at("tab=review&queue=quality"), "tab=documents&view=all&quality=reverify");
  assert.equal(at("queue=upkeep"), "tab=documents&view=all&quality=reverify");
  assert.equal(at("tab=details"), "tab=documents&view=all&quality=details");
  assert.equal(at("tab=duplicates"), "tab=documents&view=all&quality=duplicates");
  assert.equal(at("tab=flow&queue=review"), "tab=documents&view=all&quality=reverify");
  assert.equal(at("tab=documents&view=quality&part=details"), "tab=documents&view=all&quality=details");
});

test("old Master data and classification rules land on Classification; corrections and proposals on Suggestions", () => {
  assert.equal(at("tab=master"), "tab=taxonomy");
  assert.equal(at("tab=master&view=rules"), "tab=taxonomy");
  assert.equal(at("tab=flow&mode=rules"), "tab=taxonomy");
  assert.equal(at("tab=flow&queue=classify"), "tab=taxonomy&view=suggestions");
  assert.equal(at("queue=confirm"), "tab=taxonomy&view=suggestions");
  assert.equal(at("tab=taxonomy&node=__learn"), "tab=taxonomy&view=suggestions");
  assert.equal(at("tab=taxonomy&node=__proposed"), "tab=taxonomy&view=suggestions");
});

test("other old addresses land on Documents → All or Collections", () => {
  assert.equal(at("tab=flow"), "tab=documents&view=all");
  assert.equal(at("tab=all&kb=k1"), "tab=documents&kb=k1&view=all");
  assert.equal(at("tab=library"), "tab=documents&view=all");
  assert.equal(at("tab=bases"), "tab=collections");
});
