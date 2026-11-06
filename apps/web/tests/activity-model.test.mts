import assert from "node:assert/strict";
import test from "node:test";

import { areaLabel, auditFilter, describeAction, quote, targetOf } from "../src/modules/activity/model.ts";

test("describeAction reads audit codes as plain sentences, never the raw code", () => {
  assert.equal(describeAction("CreateSession"), "Signed in");
  assert.equal(describeAction("UpdateWorkspaceSettings"), "Changed the workspace setup");
  assert.equal(describeAction("CreateSpace"), "Created a space");
  assert.equal(describeAction("DeleteGroup"), "Deleted a group");
  assert.equal(describeAction("UpdateIngestionSchedule"), "Updated a processing schedule");
  assert.equal(describeAction("ArchiveItem"), "Archived an item");
  assert.equal(describeAction("Frobnicate"), "Frobnicate");
  assert.equal(describeAction(""), "Did something");
  assert.equal(describeAction(undefined), "Did something");
});

test("auditFilter quotes values and joins facets with AND", () => {
  const since = new Date("2026-11-01T00:00:00.000Z");
  assert.equal(auditFilter({ since }), 'createTime >= "2026-11-01T00:00:00.000Z"');
  assert.equal(
    auditFilter({ since, category: "SIGN_IN", actor: "users/u1", outcome: "FAILED" }),
    'createTime >= "2026-11-01T00:00:00.000Z" AND category = "SIGN_IN" AND actor = "users/u1" AND outcome = "FAILED"',
  );
  assert.equal(quote('a "b" \\ c'), '"a \\"b\\" \\\\ c"');
});

test("targetOf names the resource kind and its bare id", () => {
  assert.deepEqual(targetOf("workspaces/w/members/m1"), { kind: "member", id: "m1" });
  assert.deepEqual(targetOf("workspaces/w/items/i1/permissions/p"), { kind: "item", id: "i1" });
  assert.deepEqual(targetOf("workspaces/w/settings"), { kind: "settings", id: "settings" });
  assert.deepEqual(targetOf("workspaces/w"), { kind: "workspace", id: "w" });
  assert.deepEqual(targetOf("users/u1"), { kind: "user", id: "u1" });
  assert.deepEqual(targetOf(null), { kind: "other", id: "" });
});

test("areaLabel maps categories and falls back to Other", () => {
  assert.equal(areaLabel("PEOPLE"), "People & access");
  assert.equal(areaLabel("SIGN_IN"), "Sign-in");
  assert.equal(areaLabel("NOPE"), "Other");
});
