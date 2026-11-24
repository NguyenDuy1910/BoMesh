import assert from "node:assert/strict";
import test from "node:test";

import { isLinkNext, joinCode } from "../src/modules/auth/next.ts";
import { expireTimeAfter, parseTarget, roleWord, shareToken, shareUrl, usesLine } from "../src/modules/shares/model.ts";

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

test("share landings and join links count as links someone was sent for sign-in's next", () => {
  assert.equal(shareToken("/s/finx-join-7Qm2"), "finx-join-7Qm2");
  assert.equal(shareToken("/s/a%20b"), "a b");
  assert.equal(shareToken("/s/"), null);
  assert.equal(shareToken("/s/a/b"), null);
  assert.equal(joinCode("/w/ute"), "ute");
  assert.equal(joinCode("/w/"), null);
  assert.equal(joinCode("/w/ute/x"), null);
  assert.equal(isLinkNext("/s/tok?x=1"), true);
  assert.equal(isLinkNext("/w/ute"), true);
  assert.equal(isLinkNext("/home"), false);
  assert.equal(isLinkNext(null), false);
});

test("invite lifetime, uses and roles in words", () => {
  const now = Date.parse("2026-11-19T10:00:00Z");
  assert.equal(expireTimeAfter("7", now), "2026-11-26T10:00:00.000Z");
  assert.equal(expireTimeAfter("", now), undefined);
  assert.equal(usesLine(3, 25), "Đã dùng 3/25");
  assert.equal(usesLine(1, undefined), "Đã dùng 1 lần");
  assert.equal(usesLine(0, undefined), "Chưa được dùng");
  assert.equal(roleWord("roles/workspaceMember"), "Thành viên");
  assert.equal(roleWord("roles/collectionEditor"), "Người chỉnh sửa");
  assert.equal(roleWord("workspaces/w/roles/knowledgeManager"), "Knowledge manager");
});
