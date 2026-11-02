import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import "./support/register-aliases.mjs";

class MemoryStorage {
  #items = new Map<string, string>();
  getItem(key: string) { return this.#items.get(key) ?? null; }
  setItem(key: string, value: string) { this.#items.set(key, String(value)); }
  removeItem(key: string) { this.#items.delete(key); }
  clear() { this.#items.clear(); }
}

const globals = globalThis as Record<string, unknown>;
globals.window = globalThis;
globals.localStorage = new MemoryStorage();
globals.sessionStorage = new MemoryStorage();
globals.__BOMESH_PENDING_LATENCY__ = 0;
process.env.NEXT_PUBLIC_BOMESH_API_URL = "http://api.test";
console.info = () => {};

const { applyMoves, lastOwnerProblem, nameError, sortCollections, uploadProblem } = await import("../src/modules/knowledge/model.ts");
const {
  listDiscoverableCollections,
  localCollectionGeneralAccess,
  rememberUnreadableCollection,
  setCollectionGeneralAccess,
} = await import("../src/modules/knowledge/api.ts");
const { ApiError } = await import("../src/lib/api/request.ts");

const WORKSPACE = "11111111-1111-1111-1111-111111111111";
const ME = "22222222-2222-2222-2222-222222222222";

function signIn() {
  (globals.sessionStorage as MemoryStorage).setItem("bomesh.auth.session", JSON.stringify({
    access_token: "token",
    token_type: "bearer",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    session_id: "session-1",
    user_id: ME,
    email: "me@example.com",
    display_name: "Me",
    active_workspace_id: WORKSPACE,
    permissions: ["knowledge.read"],
    workspaces: [{ id: WORKSPACE, code: "acme", name: "Acme", role_codes: [], permissions: ["knowledge.read"] }],
    platform_permissions: [],
  }));
}

/** Answers `/api/v1<path>` from a table; anything else is a 404, as the API would say. */
function serve(routes: Record<string, () => unknown>) {
  globals.fetch = async (input: string | URL) => {
    const path = new URL(String(input)).pathname.replace(/^\/api\/v1/, "");
    const route = routes[path];
    if (!route) return new Response(JSON.stringify({ detail: "Not found" }), { status: 404 });
    return new Response(JSON.stringify(route()), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

const document = (id: string, collectionId: string) => ({
  id,
  collection_id: collectionId,
  name: `${id}.pdf`,
  content_type: "application/pdf",
  size_bytes: 10,
  processing: { state: "ready" as const, error: null, run_id: null },
  updated_at: "2026-10-01T00:00:00Z",
});

beforeEach(() => {
  (globals.localStorage as MemoryStorage).clear();
  (globals.sessionStorage as MemoryStorage).clear();
  signIn();
  serve({});
});

test("a pending move drops a document from its old knowledge base, marks it in the new one, and a move back reads as real", () => {
  const moved = { document: document("d1", "kb-b"), to_collection_id: "kb-b" };
  assert.deepEqual(applyMoves("kb-a", [document("d1", "kb-a"), document("d2", "kb-a")], [moved]).map((row) => row.document.id), ["d2"]);
  assert.deepEqual(applyMoves("kb-b", [document("d3", "kb-b")], [moved]).map((row) => [row.document.id, row.movedHere]), [["d3", false], ["d1", true]]);
  // Moved back: the newest record wins and the real row in kb-a is not marked.
  const back = { document: document("d1", "kb-a"), to_collection_id: "kb-a" };
  assert.deepEqual(applyMoves("kb-a", [document("d1", "kb-a")], [back, moved]).map((row) => [row.document.id, row.movedHere]), [["d1", false]]);
  assert.deepEqual(applyMoves("kb-b", [], [back, moved]), []);
});

test("uploads refuse unreadable types, archives in My files, empty and oversized files", () => {
  assert.equal(uploadProblem({ name: "Handbook.PDF", size: 2_000 }, { personal: false }), null);
  assert.match(uploadProblem({ name: "video.mov", size: 2_000 }, { personal: false }) ?? "", /can’t be searched/);
  assert.equal(uploadProblem({ name: "Archive.zip", size: 2_000 }, { personal: false }), null);
  assert.match(uploadProblem({ name: "Archive.zip", size: 2_000 }, { personal: true }) ?? "", /shared knowledge base/);
  assert.match(uploadProblem({ name: "notes.txt", size: 0 }, { personal: false }) ?? "", /empty/);
  assert.match(uploadProblem({ name: "big.pdf", size: 100 * 1024 * 1024 + 1 }, { personal: false }) ?? "", /100 MB/);
});

test("knowledge base names are required, short, and unique regardless of case and accents", () => {
  const others = [{ id: "a", title: "Chính sách" }];
  assert.equal(nameError("  ", others), "Enter a name.");
  assert.match(nameError("x".repeat(61), others) ?? "", /60 characters/);
  assert.match(nameError("chinh SACH", others) ?? "", /already exists/);
  assert.equal(nameError("Chính sách", others, "a"), null);
});

test("My files stays first whatever the sort", () => {
  const list = [
    { id: "b", title: "Beta", updated_at: "2026-10-03T00:00:00Z", document_count: 9 },
    { id: "me", title: "My files", updated_at: "2026-01-01T00:00:00Z", document_count: 0 },
    { id: "a", title: "alpha", updated_at: "2026-10-01T00:00:00Z", document_count: 30 },
  ];
  assert.deepEqual(sortCollections(list, "updated", "me").map((item) => item.id), ["me", "b", "a"]);
  assert.deepEqual(sortCollections(list, "name", "me").map((item) => item.id), ["me", "a", "b"]);
  assert.deepEqual(sortCollections(list, "documents", "me").map((item) => item.id), ["me", "a", "b"]);
});

test("the last owner can be neither demoted nor removed", () => {
  const owner = { collection_id: "kb", principal_type: "user" as const, principal_id: "u1", principal_name: "An", role: "owner" as const };
  const editor = { ...owner, principal_id: "u2", role: "editor" as const };
  assert.match(lastOwnerProblem([owner, editor], owner, "editor") ?? "", /needs an owner/);
  assert.match(lastOwnerProblem([owner, editor], owner, null) ?? "", /last owner/);
  assert.equal(lastOwnerProblem([owner, { ...editor, role: "owner" }], owner, null), null);
  assert.equal(lastOwnerProblem([owner, editor], editor, null), null);
});

test("general access needs the share permission, never opens My files, and restricted clears the local record", async () => {
  serve({
    "/collections/kb-view": () => ({ id: "kb-view", permissions: ["collection.read"] }),
    "/collections/kb-own": () => ({ id: "kb-own", permissions: ["collection.read", "collection.share"] }),
    "/collections/kb-mine": () => ({ id: "kb-mine", permissions: ["collection.read", "collection.share"] }),
    "/knowledge/home": () => ({ collections: [], recent_documents: [], personal_collection_id: "kb-mine" }),
  });
  await assert.rejects(setCollectionGeneralAccess("kb-view", { general_access: "workspace" }), (error) => error instanceof ApiError && error.status === 403);
  await assert.rejects(setCollectionGeneralAccess("kb-gone", { general_access: "workspace" }), (error) => error instanceof ApiError && error.status === 404);
  await assert.rejects(setCollectionGeneralAccess("kb-mine", { general_access: "workspace" }), (error) => error instanceof ApiError && error.status === 422);

  await setCollectionGeneralAccess("kb-own", { general_access: "workspace" });
  assert.equal(localCollectionGeneralAccess()["kb-own"]?.general_access, "workspace");
  await setCollectionGeneralAccess("kb-own", { general_access: "restricted" });
  assert.equal(localCollectionGeneralAccess()["kb-own"], undefined);
});

test("discoverable knowledge bases are only real ids the caller met and cannot read", async () => {
  const request = (id: string, target: string, status: string, requester = ME) => ({
    id,
    request_type: "resource_access",
    target_id: target,
    status,
    requester: { id: requester, email: "x@example.com", display_name: null },
    created_at: "2026-10-01T00:00:00Z",
  });
  serve({
    "/knowledge/home": () => ({ collections: [{ id: "kb-open" }], recent_documents: [], personal_collection_id: null }),
    "/approval-requests": () => ({
      items: [
        request("r1", "kb-pending", "pending"),
        request("r2", "kb-denied", "denied"),
        request("r3", "kb-approved", "approved"),
        request("r4", "kb-other", "pending", "someone-else"),
        request("r5", "kb-open", "pending"),
      ],
      total: 5,
    }),
  });
  rememberUnreadableCollection("kb-met");
  rememberUnreadableCollection("kb-open");

  const { items } = await listDiscoverableCollections();
  assert.deepEqual(items.map((item) => item.id).sort(), ["kb-denied", "kb-met", "kb-pending"]);
  assert.ok(items.every((item) => item.title === null && item.general_access === "restricted"));
});
