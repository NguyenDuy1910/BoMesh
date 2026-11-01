import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

import "./support/register-aliases.mjs";

/** The browser storage the pending layer and the auth session read. */
class MemoryStorage {
  #values = new Map<string, string>();
  getItem(key: string) { return this.#values.get(key) ?? null; }
  setItem(key: string, value: string) { this.#values.set(key, String(value)); }
  removeItem(key: string) { this.#values.delete(key); }
  clear() { this.#values.clear(); }
}

const localStorage = new MemoryStorage();
const sessionStorage = new MemoryStorage();
for (const [name, value] of Object.entries({ localStorage, sessionStorage, window: globalThis })) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
// No API is reachable under test; pending calls resolve without delay.
delete process.env.NEXT_PUBLIC_BOMESH_API_URL;
globalThis.__BOMESH_PENDING_LATENCY__ = 0;

// `[pending-api] <key>` development logs are expected; keep the test output readable.
mock.method(console, "info", () => {});

const { ApiError } = await import("../src/lib/api/request.ts");
const { requestPasswordReset, completePasswordReset } = await import("../src/modules/auth/api.ts");
const { getAssistantSettings, updateAssistantSettings } = await import("../src/modules/manage/assistant/api.ts");
const { createArtifactRevision, deleteArtifactRevision, listLocalArtifactRevisions } = await import("../src/modules/chat/api.ts");

const WORKSPACE_ID = "workspace-1";

function signIn(permissions: string[]) {
  sessionStorage.setItem("bomesh.auth.session", JSON.stringify({
    access_token: "token",
    token_type: "bearer",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    session_id: "session-1",
    user_id: "user-1",
    email: "linh@example.com",
    display_name: "Linh Tran",
    active_workspace_id: WORKSPACE_ID,
    permissions,
    workspaces: [{ id: WORKSPACE_ID, code: "northwind", name: "Northwind", role_codes: [], permissions }],
    platform_permissions: [],
  }));
}

async function rejectsWith(promise: Promise<unknown>, status: number) {
  await assert.rejects(promise, (error: unknown) => error instanceof ApiError && error.status === status);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

test("a password reset link sets a new password once", async (t) => {
  const info = t.mock.method(console, "info", () => {});
  const accepted = await requestPasswordReset({ email: " Linh@Example.com " });
  assert.deepEqual(accepted, { status: "accepted", expires_in_minutes: 30 });

  // The pending layer delivers the "email" to the developer console.
  const link = info.mock.calls
    .flatMap((call) => call.arguments)
    .find((value): value is string => typeof value === "string" && value.includes("/auth/password-reset/"));
  assert.ok(link, "the reset link is written to the console");
  const token = link.split("/auth/password-reset/")[1]!;

  await rejectsWith(completePasswordReset(token, { password: "short" }), 422);
  assert.deepEqual(await completePasswordReset(token, { password: "a-new-password" }), { status: "completed" });
  await rejectsWith(completePasswordReset(token, { password: "a-new-password" }), 404);
  await rejectsWith(completePasswordReset("unknown-token", { password: "a-new-password" }), 404);
  await rejectsWith(requestPasswordReset({ email: "not-an-email" }), 422);
});

test("assistant settings round-trip through get and patch, within limits", async () => {
  signIn(["tenant.read", "tenant.manage"]);
  const seeded = await getAssistantSettings(WORKSPACE_ID);
  assert.equal(seeded.welcome_message, "What can I help you find?");
  assert.equal(seeded.starter_prompts.length, 3);
  assert.equal(seeded.knowledge_search_always_on, true);
  assert.equal(seeded.updated_at, null);

  const saved = await updateAssistantSettings(WORKSPACE_ID, {
    welcome_message: "  Ask about Northwind  ",
    answer_length: "concise",
    capabilities: { charts: false },
    starter_prompts: [{ title: "Find a policy", prompt: "Where is the leave policy?" }],
  });
  assert.equal(saved.welcome_message, "Ask about Northwind");
  assert.deepEqual(await getAssistantSettings(WORKSPACE_ID), saved);
  assert.equal(saved.answer_length, "concise");
  assert.deepEqual(saved.capabilities, { ...seeded.capabilities, charts: false });
  assert.equal(saved.instructions, seeded.instructions, "omitted fields are kept");
  assert.deepEqual(saved.updated_by, { id: "user-1", display_name: "Linh Tran" });

  const starter = { title: "Starter", prompt: "Ask something" };
  await rejectsWith(updateAssistantSettings(WORKSPACE_ID, { starter_prompts: [starter, starter, starter, starter] }), 422);
  await rejectsWith(updateAssistantSettings(WORKSPACE_ID, { instructions: "x".repeat(2001) }), 422);
  assert.ok(await updateAssistantSettings(WORKSPACE_ID, { instructions: "x".repeat(2000) }));
  assert.deepEqual((await getAssistantSettings(WORKSPACE_ID)).starter_prompts, saved.starter_prompts);
});

test("members read assistant settings but only workspace managers change them", async () => {
  signIn(["tenant.read", "knowledge.read"]);
  assert.equal((await getAssistantSettings(WORKSPACE_ID)).welcome_message, "What can I help you find?");
  await rejectsWith(updateAssistantSettings(WORKSPACE_ID, { welcome_message: "Hello" }), 403);
  await rejectsWith(getAssistantSettings("another-workspace"), 404);
  sessionStorage.clear();
  await rejectsWith(getAssistantSettings(WORKSPACE_ID), 401);
});

test("a hand-made revision takes the next number and a restore records its origin", async () => {
  signIn(["knowledge.read"]);
  const edited = await createArtifactRevision("artifact-1", { content: "# Plan\n\nEdited by hand", summary: "Fixed the intro" });
  assert.equal(edited.revision, 2);
  assert.equal(edited.restored_from, null);
  assert.equal(edited.size_bytes, new TextEncoder().encode("# Plan\n\nEdited by hand").byteLength);

  await createArtifactRevision("artifact-1", { content: "# Plan\n\nSecond pass", summary: "Second pass" });
  const restored = await createArtifactRevision("artifact-1", { summary: "Restored version 2", restored_from: 2 });
  assert.equal(restored.revision, 4);
  assert.equal(restored.restored_from, 2);
  assert.equal(listLocalArtifactRevisions("artifact-1").at(-1)?.content, "# Plan\n\nEdited by hand");

  await rejectsWith(createArtifactRevision("artifact-1", { summary: "Missing", restored_from: 9 }), 404);
  await rejectsWith(createArtifactRevision("artifact-1", { content: "x", summary: "  " }), 422);
});

test("undo takes back only the newest hand-made revision", async () => {
  signIn(["knowledge.read"]);
  await createArtifactRevision("artifact-3", { content: "First edit", summary: "First edit" });
  await createArtifactRevision("artifact-3", { content: "Second edit", summary: "Second edit" });

  await rejectsWith(deleteArtifactRevision("artifact-3", 2), 409);
  await deleteArtifactRevision("artifact-3", 3);
  assert.deepEqual(listLocalArtifactRevisions("artifact-3").map((revision) => revision.revision), [2]);
  await rejectsWith(deleteArtifactRevision("artifact-3", 3), 404);
});

test("the development failure switch makes a pending call reject", async () => {
  signIn(["tenant.manage"]);
  localStorage.setItem("bomesh.pending.fail", "workspace.assistant_settings");
  await rejectsWith(getAssistantSettings(WORKSPACE_ID), 503);
  assert.ok(await createArtifactRevision("artifact-2", { content: "text", summary: "Unaffected" }), "unlisted keys still work");
  localStorage.setItem("bomesh.pending.fail", "all");
  await rejectsWith(createArtifactRevision("artifact-2", { content: "text", summary: "Fails" }), 503);
  localStorage.removeItem("bomesh.pending.fail");
  assert.ok(await getAssistantSettings(WORKSPACE_ID));
});
