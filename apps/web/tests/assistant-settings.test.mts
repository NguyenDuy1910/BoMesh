import assert from "node:assert/strict";
import test from "node:test";

import { MAX_INSTRUCTIONS, draftErrors, draftKey, moveStarter, rolesOf, toDraft, toPatch } from "../src/modules/assistant-settings/model.ts";

const PUBLISHED = {
  instructions: "Be brief.",
  answerLength: "CONCISE" as const,
  capabilities: { webSearch: false, fileWork: true, charts: true },
  welcomeMessage: "Hi there",
  starterPrompts: [
    { title: "Policies", prompt: "Find a policy", roles: ["roles/workspaceMember"] },
    { title: "Audit", prompt: "Show audit", roles: ["roles/workspaceAdmin", "roles/workspaceMember"] },
  ],
  etag: "e1",
};

test("toDraft groups starters per role and round-trips through toPatch", () => {
  const d = toDraft(PUBLISHED);
  assert.deepEqual(rolesOf(d), ["roles/workspaceMember", "roles/workspaceAdmin"]);
  assert.equal(d.starters["roles/workspaceMember"].length, 2);
  const { body, updateMask } = toPatch(d, PUBLISHED);
  assert.equal(updateMask, "instructions,answerLength,capabilities,welcomeMessage,starterPrompts");
  assert.equal(body.etag, "e1");
  assert.equal(body.starterPrompts?.length, 3);
  assert.deepEqual(body.capabilities, { webSearch: false, charts: true, fileWork: true });
  assert.equal(draftKey(toDraft({ ...PUBLISHED, starterPrompts: body.starterPrompts })), draftKey(d));
});

test("an assistant without starters shares one empty list", () => {
  const d = toDraft({ welcomeMessage: "Hello" });
  assert.equal(rolesOf(d), null);
  assert.deepEqual(d.starters, { "": [] });
  assert.equal(d.style, "BALANCED");
});

test("draftErrors flags missing welcome, long instructions and empty starter fields", () => {
  const d = toDraft(PUBLISHED);
  d.welcome = "  ";
  d.instructions = "x".repeat(MAX_INSTRUCTIONS + 5);
  d.starters["roles/workspaceAdmin"][0].prompt = "";
  const e = draftErrors(d);
  assert.equal(e.welcome, "Enter a welcome message.");
  assert.equal(e.instructions, "Shorten by 5 characters.");
  assert.equal(e["roles/workspaceAdmin-st0p"], "Add the prompt it sends.");
  assert.equal(Object.keys(e).length, 3);
});

test("moveStarter swaps neighbours and ignores out-of-range moves", () => {
  const list = [
    { title: "a", prompt: "1" },
    { title: "b", prompt: "2" },
  ];
  assert.deepEqual(moveStarter(list, 0, 1).map((s) => s.title), ["b", "a"]);
  assert.deepEqual(moveStarter(list, 0, -1).map((s) => s.title), ["a", "b"]);
});
