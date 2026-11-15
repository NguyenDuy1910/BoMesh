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
    "tab=documents&view=quality&part=details",
    "tab=topics&view=suggestions",
    "tab=topics&node=t1",
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

test("old problems addresses land on Documents → Issues", () => {
  assert.equal(at("tab=review&queue=problems&kb=k1"), "tab=documents&kb=k1&view=issues");
  assert.equal(at("queue=issues"), "tab=documents&view=issues");
  assert.equal(at("tab=documents&life=attention"), "tab=documents&view=issues");
  assert.equal(at("tab=flow&stage=issue"), "tab=documents&view=issues");
});

test("the retired ?life= stage filter lands on a view or All's processing and publication filters", () => {
  assert.equal(at("tab=documents&view=all&life=publishing&kb=k1"), "tab=documents&view=all&kb=k1&processing=processing");
  assert.equal(at("tab=documents&view=all&life=published"), "tab=documents&view=all&pub=published");
  assert.equal(at("tab=documents&life=closed"), "tab=documents&view=all&pub=unpublished");
  assert.equal(at("tab=documents&life=rejected"), "tab=documents&view=all");
});

test("old Quality, Upkeep and Knowledge health addresses land on Documents → Quality with their part", () => {
  assert.equal(at("tab=quality"), "tab=documents&view=quality");
  assert.equal(at("tab=quality&seg=duplicates"), "tab=documents&view=quality&part=duplicates");
  assert.equal(at("tab=review&queue=reverify"), "tab=documents&view=quality&part=reverify");
  assert.equal(at("tab=review&queue=quality"), "tab=documents&view=quality");
  assert.equal(at("queue=upkeep"), "tab=documents&view=quality");
  assert.equal(at("tab=details"), "tab=documents&view=quality&part=details");
  assert.equal(at("tab=duplicates"), "tab=documents&view=quality&part=duplicates");
  assert.equal(at("tab=flow&queue=review"), "tab=documents&view=quality&part=reverify");
});

test("old Taxonomy, Master data and classification rules land on Topics; corrections on Suggestions", () => {
  assert.equal(at("tab=taxonomy"), "tab=topics&view=topics");
  assert.equal(at("tab=taxonomy&import=1"), "tab=topics&import=1&view=topics");
  assert.equal(at("tab=taxonomy&node=t1"), "tab=topics&node=t1&view=topics");
  assert.equal(at("tab=master"), "tab=topics&view=topics");
  assert.equal(at("tab=flow&mode=rules"), "tab=topics&view=topics");
  assert.equal(at("tab=flow&queue=classify"), "tab=topics&view=suggestions");
  assert.equal(at("queue=confirm"), "tab=topics&view=suggestions");
  assert.equal(at("tab=taxonomy&node=__learn"), "tab=topics&view=suggestions");
  assert.equal(at("tab=taxonomy&node=__proposed"), "tab=topics&view=suggestions");
  assert.equal(at("tab=topics&node=__proposed"), "tab=topics&view=suggestions");
});

test("other old addresses land on Documents → All or Collections", () => {
  assert.equal(at("tab=flow"), "tab=documents&view=all");
  assert.equal(at("tab=all&kb=k1"), "tab=documents&kb=k1&view=all");
  assert.equal(at("tab=library"), "tab=documents&view=all");
  assert.equal(at("tab=bases"), "tab=collections");
});
