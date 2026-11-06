import assert from "node:assert/strict";
import test from "node:test";

import "./support/register-aliases.mjs";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

const listeners: Array<(event: unknown) => void> = [];
Object.assign(globalThis, {
  window: {
    localStorage: new MemoryStorage(),
    addEventListener: (_: string, l: (event: unknown) => void) =>
      listeners.push(l),
    removeEventListener: () => undefined,
  },
});

const { devProjectsAdapter: dev } =
  await import("../src/modules/projects/dev-adapter.ts");
const { MAX_PROJECT_REFERENCES, ProjectNotFoundError } =
  await import("../src/modules/projects/types.ts");
const { answerFirstLine } =
  await import("../src/modules/projects/conversations.ts");

const scope = { workspace: "w1", user: "users/u1" };
const conv = (id: string) => `workspaces/w1/conversations/${id}`;

test("dev projects are private per user and workspace", async () => {
  await dev.create(scope, { displayName: "Mine" });
  assert.equal(
    (await dev.list({ workspace: "w1", user: "users/u2" })).length,
    0,
  );
  assert.equal(
    (await dev.list({ workspace: "w2", user: "users/u1" })).length,
    0,
  );
  assert.ok((await dev.list(scope)).some((p) => p.displayName === "Mine"));
});

test("a conversation lives in at most one project", async () => {
  const a = await dev.create(scope, {
    displayName: "A",
    conversations: [conv("c1")],
  });
  const b = await dev.create(scope, { displayName: "B" });
  await dev.setConversationProject(scope, conv("c1"), b.id);
  const all = await dev.list(scope);
  assert.deepEqual(all.find((p) => p.id === a.id)?.conversations, []);
  assert.deepEqual(all.find((p) => p.id === b.id)?.conversations, [conv("c1")]);
  await dev.setConversationProject(scope, conv("c1"), null);
  assert.ok(
    (await dev.list(scope)).every((p) => !p.conversations.includes(conv("c1"))),
  );
  // Creating a project with a conversation moves it out of its old project.
  await dev.setConversationProject(scope, conv("c2"), a.id);
  const c = await dev.create(scope, {
    displayName: "C",
    conversations: [conv("c2")],
  });
  const after = await dev.list(scope);
  assert.deepEqual(after.find((p) => p.id === a.id)?.conversations, []);
  assert.deepEqual(after.find((p) => p.id === c.id)?.conversations, [
    conv("c2"),
  ]);
});

test("delete hides a project; undelete restores conversations not filed elsewhere since", async () => {
  const p = await dev.create(scope, {
    displayName: "Gone",
    conversations: [conv("d1"), conv("d2")],
  });
  await dev.delete(scope, p.id);
  assert.ok(!(await dev.list(scope)).some((x) => x.id === p.id));
  await assert.rejects(
    dev.update(scope, p.id, { displayName: "x" }),
    ProjectNotFoundError,
  );
  const other = await dev.create(scope, { displayName: "Other" });
  await dev.setConversationProject(scope, conv("d2"), other.id);
  const restored = await dev.undelete(scope, p.id);
  assert.deepEqual(restored.conversations, [conv("d1")]);
});

test("references are deduplicated and capped", async () => {
  const p = await dev.create(scope, { displayName: "Refs" });
  const refs = Array.from(
    { length: 14 },
    (_, i) => `workspaces/w1/items/i${i % 12}`,
  );
  const updated = await dev.update(scope, p.id, { references: refs });
  assert.equal(updated.references.length, MAX_PROJECT_REFERENCES);
  assert.equal(new Set(updated.references).size, updated.references.length);
});

test("answerFirstLine reads the first plain line of an answer", () => {
  assert.equal(answerFirstLine(undefined), "");
  assert.equal(
    answerFirstLine("## Refund policy\n\nDetails [1]"),
    "Refund policy",
  );
  assert.equal(
    answerFirstLine(
      "\n\n**Enterprise** customers get refunds [2] within 30 days:",
    ),
    "Enterprise customers get refunds  within 30 days",
  );
  assert.equal(
    answerFirstLine("```\ncode\n```\n- See [the policy](https://x)"),
    "See the policy",
  );
  assert.equal(answerFirstLine("---\n> Quoted"), "Quoted");
});
