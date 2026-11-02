import assert from "node:assert/strict";
import test from "node:test";

import {
  accountStatusKey,
  humanizeStatus,
  outcomeStatusKey,
  runItemStatusKey,
  runStatusKey,
  serviceStatusKey,
  sessionStatusKey,
  sourceStatusKey,
  statusOf,
  workspaceStatusKey,
} from "../src/lib/status.ts";

test("known values read in the prototype's words and tones", () => {
  assert.deepEqual(statusOf("doc", "outdated"), { tone: "warn", label: "Needs update" });
  assert.deepEqual(statusOf("doc", "unsupported"), { tone: "neutral", label: "Not searchable" });
  assert.deepEqual(statusOf("source", "failed"), { tone: "err", label: "Sync failed" });
  assert.deepEqual(statusOf("account", "error"), { tone: "warn", label: "Can’t reach" });
  assert.deepEqual(statusOf("run", "partial"), { tone: "warn", label: "Completed with issues" });
  assert.deepEqual(statusOf("request", "denied"), { tone: "neutral", label: "Denied" });
  assert.deepEqual(statusOf("service", "down"), { tone: "err", label: "Outage" });
});

test("healthy steady states are plain, moving ones live", () => {
  for (const [kind, value] of [
    ["doc", "ready"],
    ["source", "healthy"],
    ["account", "connected"],
    ["run", "completed"],
    ["member", "active"],
    ["outcome", "success"],
    ["ws", "active"],
    ["service", "operational"],
  ] as const) {
    assert.equal(statusOf(kind, value).plain, true, `${kind}.${value}`);
    assert.equal(statusOf(kind, value).tone, "ok", `${kind}.${value}`);
  }
  assert.equal(statusOf("doc", "processing").live, true);
  assert.equal(statusOf("run", "queued").live, true);
  assert.equal(statusOf("source", "failed").plain, undefined);
});

test("unknown values fall back to neutral with a humanised label", () => {
  assert.deepEqual(statusOf("doc", "timed_out"), { tone: "neutral", label: "Timed out" });
  assert.deepEqual(statusOf("account", "REAUTH-required"), { tone: "neutral", label: "Reauth required" });
  assert.deepEqual(statusOf("run", ""), { tone: "neutral", label: "Unknown" });
  assert.deepEqual(statusOf("run", null), { tone: "neutral", label: "Unknown" });
  // Object prototype keys are not statuses.
  assert.deepEqual(statusOf("doc", "constructor"), { tone: "neutral", label: "Constructor" });
  assert.equal(humanizeStatus("  sync.in-progress "), "Sync in progress");
});

test("values are matched case- and whitespace-insensitively", () => {
  assert.equal(statusOf("doc", " Ready ").label, "Ready");
});

test("a completed run with failed documents reads as partial; a stopped run stays failed", () => {
  assert.equal(runStatusKey({ status: "completed", counts: { failed: 0 } }), "completed");
  assert.equal(runStatusKey({ status: "completed", counts: { failed: 1 } }), "partial");
  assert.equal(runStatusKey({ status: "failed", counts: { failed: 1 } }), "failed");
});

test("run items read in the document's words", () => {
  assert.equal(statusOf("doc", runItemStatusKey("queued")).label, "Waiting");
  assert.equal(statusOf("doc", runItemStatusKey("running")).label, "Processing");
  assert.equal(statusOf("doc", runItemStatusKey("succeeded")).label, "Ready");
  assert.equal(statusOf("doc", runItemStatusKey("skipped")).label, "Skipped");
});

test("connection states that need the provider flow all read as Reconnect needed", () => {
  for (const status of ["expired", "reauth_required", "revoked"]) {
    assert.equal(statusOf("account", accountStatusKey(status)).label, "Reconnect needed");
  }
  assert.equal(accountStatusKey("disconnected"), "disabled");
  assert.equal(statusOf("account", accountStatusKey("draft")).label, "Not verified");
});

test("source status: a running sync wins, a failed sync on a ready source fails", () => {
  assert.equal(sourceStatusKey("ready"), "healthy");
  assert.equal(sourceStatusKey("ready", "failed"), "failed");
  assert.equal(sourceStatusKey("failed", "running"), "syncing");
  assert.equal(sourceStatusKey("connection_required"), "reconnect");
  assert.equal(sourceStatusKey("disabled"), "paused");
});

test("other backend enums map onto their kinds", () => {
  assert.equal(workspaceStatusKey("provisioning"), "new");
  assert.equal(serviceStatusKey("unhealthy"), "down");
  assert.equal(serviceStatusKey("healthy"), "operational");
  assert.equal(outcomeStatusKey("failure"), "failure");
  assert.equal(sessionStatusKey("superseded"), "ended");
});
