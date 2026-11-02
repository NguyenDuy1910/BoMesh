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

const { getPlatformHealth, getPlatformHealthHistory } = await import("../src/modules/platform/api.ts");
const { ApiError } = await import("../src/lib/api/request.ts");

const WORKSPACE = "11111111-1111-1111-1111-111111111111";

function signIn(platform: string[]) {
  (globals.sessionStorage as MemoryStorage).setItem("bomesh.auth.session", JSON.stringify({
    access_token: "token",
    token_type: "bearer",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    session_id: "session-1",
    user_id: "22222222-2222-2222-2222-222222222222",
    email: "ops@example.com",
    display_name: "Ops",
    active_workspace_id: WORKSPACE,
    permissions: [],
    workspaces: [{ id: WORKSPACE, code: "acme", name: "Acme", role_codes: [], permissions: [] }],
    platform_permissions: platform,
  }));
}

type Status = "healthy" | "unhealthy" | "not_configured";

/** Serve one `/platform/health` report and read it through the client, as System health does. */
async function check(checkedAt: string, chat: Status, errorCategory: string | null = null) {
  globals.fetch = async (input: string | URL) => {
    assert.equal(new URL(String(input)).pathname, "/api/v1/platform/health");
    return new Response(JSON.stringify({
      status: chat === "healthy" ? "healthy" : "unhealthy",
      checked_at: checkedAt,
      duration_ms: 40,
      services: [
        { name: "api", status: "healthy", required: true, latency_ms: 0 },
        { name: "openai_chat", status: chat, required: true, latency_ms: 900, error_category: errorCategory },
        { name: "langfuse", status: "not_configured", required: false, latency_ms: 0, error_category: "not_configured" },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return getPlatformHealth();
}

const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const at = (time: string) => `${yesterday}T${time}:00.000Z`;

beforeEach(() => {
  (globals.localStorage as MemoryStorage).clear();
  (globals.sessionStorage as MemoryStorage).clear();
});

test("history is built from the real checks read in this browser: uptime, days and incidents", async () => {
  signIn(["platform.health.read"]);
  await check(at("10:00"), "unhealthy", "timeout");
  await check(at("11:00"), "healthy");
  await check(at("11:00"), "healthy"); // the same report read twice counts once
  await check(at("12:00"), "unhealthy", "connection_failed");

  const history = await getPlatformHealthHistory({ days: 30 });
  assert.equal(history.days, 30);
  const chat = history.services.find((service) => service.name === "openai_chat");
  const api = history.services.find((service) => service.name === "api");
  const tracing = history.services.find((service) => service.name === "langfuse");
  assert.ok(chat && api && tracing);
  assert.equal(chat.checks, 3);
  assert.equal(chat.uptime_percent, 33.33);
  assert.equal(api.uptime_percent, 100);
  // Not configured is a setting, not an outage: never counted, never an incident.
  assert.equal(tracing.uptime_percent, null);

  assert.equal(chat.daily.length, 30);
  assert.equal(chat.daily.at(-2)?.date, yesterday);
  assert.equal(chat.daily.at(-2)?.status, "issues");
  assert.equal(api.daily.at(-2)?.status, "healthy");
  assert.equal(chat.daily.at(-3)?.status, "no_data");

  assert.deepEqual(
    history.incidents.map(({ service, error_category, started_at, resolved_at }) => ({ service, error_category, started_at, resolved_at })),
    [
      { service: "openai_chat", error_category: "connection_failed", started_at: at("12:00"), resolved_at: null },
      { service: "openai_chat", error_category: "timeout", started_at: at("10:00"), resolved_at: at("11:00") },
    ],
  );
});

test("health history needs platform.health.read, and nothing is recorded without it", async () => {
  signIn(["platform.tenant.read"]);
  await check(at("10:00"), "unhealthy", "timeout");
  await assert.rejects(getPlatformHealthHistory({ days: 30 }), (error: unknown) => error instanceof ApiError && error.status === 403);

  signIn(["platform.health.read"]);
  const history = await getPlatformHealthHistory({ days: 7 });
  assert.equal(history.services.length, 0);
  assert.equal(history.incidents.length, 0);
});
