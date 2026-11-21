import assert from "node:assert/strict";
import test from "node:test";

import { expireTimeAfter, isShareNext, parseTarget, roleWord, shareToken, shareUrl, usesLine } from "../src/modules/shares/model.ts";

test("a share's link is the site origin plus its uri, never its API name", () => {
  assert.equal(shareUrl("https://app.bomesh.io", "/s/abc123"), "https://app.bomesh.io/s/abc123");
  assert.equal(shareUrl("https://app.bomesh.io", "workspaces/w/shares/abc123"), null);
  assert.equal(shareUrl("https://app.bomesh.io", undefined), null);
});

test("targets parse into what they open", () => {
  assert.deepEqual(parseTarget("workspaces/w"), { kind: "workspace", workspace: "w" });
  assert.deepEqual(parseTarget("workspaces/w/items/i"), { kind: "item", workspace: "w", id: "i" });
  assert.deepEqual(parseTarget("workspaces/w/spaces/s"), { kind: "space", workspace: "w", id: "s" });
  assert.deepEqual(parseTarget("workspaces/w/conversations/c"), { kind: "conversation", workspace: "w", id: "c" });
  assert.equal(parseTarget("workspaces/w/conversations/c/snapshots/x"), null);
  assert.equal(parseTarget(undefined), null);
});

test("only /s/{token} counts as a share landing for sign-in's next", () => {
  assert.equal(shareToken("/s/finx-join-7Qm2"), "finx-join-7Qm2");
  assert.equal(shareToken("/s/a%20b"), "a b");
  assert.equal(shareToken("/s/"), null);
  assert.equal(shareToken("/s/a/b"), null);
  assert.equal(isShareNext("/s/tok?x=1"), true);
  assert.equal(isShareNext("/home"), false);
  assert.equal(isShareNext(null), false);
});

test("invite lifetime, uses and roles in words", () => {
  const now = Date.parse("2026-11-19T10:00:00Z");
  assert.equal(expireTimeAfter("7", now), "2026-11-26T10:00:00.000Z");
  assert.equal(expireTimeAfter("", now), undefined);
  assert.equal(usesLine(3, 25), "3 of 25 used");
  assert.equal(usesLine(1, undefined), "Used 1 time");
  assert.equal(usesLine(0, undefined), "Not used yet");
  assert.equal(roleWord("roles/workspaceMember"), "Member");
  assert.equal(roleWord("roles/collectionEditor"), "Editor");
  assert.equal(roleWord("workspaces/w/roles/knowledgeManager"), "Knowledge manager");
});
