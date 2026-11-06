import assert from "node:assert/strict";
import test from "node:test";

import {
  actionLabel,
  buildIndexing,
  indexingAlerts,
  jobStatus,
  median,
  newWorkspaceErrors,
  policyDirty,
  policyErrors,
  policyForm,
  policyPatch,
  slugify,
  sortIndexing,
  toCsv,
  unhealthyComponents,
  workspaceIdOf,
} from "../src/modules/platform/model.ts";

const W1 = "11111111-1111-1111-1111-111111111111";
const W2 = "22222222-2222-2222-2222-222222222222";
const W3 = "33333333-3333-3333-3333-333333333333";

test("slugify suggests a web address from a workspace name", () => {
  assert.equal(slugify("Litware Labs"), "litware-labs");
  assert.equal(slugify("  Đại học Bách khoa! "), "dai-hoc-bach-khoa");
  assert.equal(slugify("a".repeat(50)).length, 40);
});

test("newWorkspaceErrors validates name, address and first admin", () => {
  assert.deepEqual(newWorkspaceErrors({ name: "Litware", code: "litware", email: "sam@litware.com" }), {});
  const e = newWorkspaceErrors({ name: "L", code: "-x", email: "sam" });
  assert.equal(e.name, "Use at least 2 characters.");
  assert.equal(e.code, "Use 3–40 lowercase letters, numbers or hyphens.");
  assert.equal(e.email, "Enter a full email address, like sam@litware.com.");
  assert.equal(newWorkspaceErrors({ name: "Litware", code: "litware", email: "a@b.co" }, { displayName: "Litware Labs" }).code, "Already used by Litware Labs. Try another.");
});

test("buildIndexing derives status, queue, throughput, median and retryable failures", () => {
  const now = Date.parse("2026-11-05T12:00:00Z");
  const workspaces = [
    { name: `workspaces/${W1}`, displayName: "One", code: "one", ingestionState: "ACTIVE" as const },
    { name: `workspaces/${W2}`, displayName: "Two", code: "two", ingestionState: "PAUSED" as const },
    { name: `workspaces/${W3}`, displayName: "Three", code: "three", ingestionState: "ACTIVE" as const },
  ];
  const live = [
    { workspace: `workspaces/${W1}`, queuedTaskCount: 3, runningTaskCount: 1 },
    { workspace: `workspaces/${W3}`, queuedTaskCount: 9, runningTaskCount: 0 },
  ];
  const day = [
    {
      workspace: `workspaces/${W1}`,
      throughputPerHour: 2,
      failureRate: 0.2,
      errorClasses: [
        { errorClass: "interrupted", taskCount: 3 },
        { errorClass: "unsupported_format", taskCount: 1 },
        { errorClass: "something_new", taskCount: 1 },
      ],
    },
    { workspace: `workspaces/${W3}`, throughputPerHour: 1, failureRate: 0.01, errorClasses: [{ errorClass: "interrupted", taskCount: 1 }] },
  ];
  const task = (ws: string, start: string, end: string, state: "SUCCEEDED" | "FAILED" = "SUCCEEDED") => ({
    name: `workspaces/${ws}/ingestionRuns/r/tasks/${start}`,
    state,
    startTime: start,
    endTime: end,
  });
  const tasks = [
    task(W1, "2026-11-05T11:00:00Z", "2026-11-05T11:01:00Z"),
    task(W1, "2026-11-05T11:00:00Z", "2026-11-05T11:03:00Z"),
    task(W1, "2026-11-05T11:00:00Z", "2026-11-05T11:10:00Z", "FAILED"),
    task(W1, "2026-11-03T11:00:00Z", "2026-11-03T12:00:00Z"),
  ];
  const rows = buildIndexing(workspaces, live, day, tasks, now);
  const [one, two, three] = rows;
  assert.equal(one.status, "degraded");
  assert.equal(one.queue, 4);
  assert.equal(one.published24, 48);
  assert.equal(one.medianMs, 120_000);
  assert.equal(one.failed, 5);
  assert.equal(one.retryable, 4, "interrupted + unknown classes (internal) are retryable");
  assert.deepEqual(one.errors.map((e) => e.errorClass), ["interrupted", "unsupported_format", "internal"]);
  assert.equal(two.status, "paused");
  assert.equal(two.queue, 0);
  assert.equal(three.status, "healthy");
  assert.equal(indexingAlerts(rows), 2);
  assert.deepEqual(sortIndexing(rows).map((r) => r.workspaceId), [W2, W1, W3]);
});

test("jobStatus holds queued and running work while ingestion is paused", () => {
  assert.equal(jobStatus({ state: "QUEUED" }, false), "queued");
  assert.equal(jobStatus({ state: "RUNNING" }, true), "held");
  assert.equal(jobStatus({ state: "SUCCEEDED" }, true), "done");
  assert.equal(jobStatus({ state: "CANCELLED" }, false), "cancelled");
  assert.equal(median([5, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.equal(workspaceIdOf(`workspaces/${W1}/ingestionRuns/x/tasks/y`), W1);
  assert.equal(workspaceIdOf("workspaces/-/x"), "");
});

test("policy form round-trips the ingestion policy and keeps MIME types outside the groups", () => {
  const policy = {
    allowedMimeTypes: ["application/pdf", "text/csv", "application/x-custom"],
    maxFileSizeBytes: String(200 * 1_048_576),
    ocrScannedPdfs: true,
    parseSpreadsheets: false,
    rejectedRetentionDuration: "2592000s",
    etag: "e1",
  };
  const form = policyForm(policy);
  assert.deepEqual(form, { types: ["pdf", "sheets"], maxMb: "200", ocr: true, sheets: false, retention: "30" });
  assert.equal(policyDirty(form, policyForm(policy)), false);
  const next = { ...form, types: ["pdf" as const, "html" as const], maxMb: "50", retention: "90" };
  assert.equal(policyDirty(next, form), true);
  const patch = policyPatch(next, policy);
  assert.deepEqual(patch.allowedMimeTypes, ["application/x-custom", "application/pdf", "text/html"]);
  assert.equal(patch.maxFileSizeBytes, String(50 * 1_048_576));
  assert.equal(patch.rejectedRetentionDuration, "7776000s");
  assert.equal(patch.etag, "e1");
  assert.deepEqual(Object.keys(policyErrors({ ...form, types: [], maxMb: "0" })).sort(), ["maxMb", "types"]);
  assert.deepEqual(policyErrors({ ...form, maxMb: "2048" }), {});
});

test("actionLabel turns API method names into plain words", () => {
  assert.equal(actionLabel("CreateSession"), "Signed in");
  assert.equal(actionLabel("UpdateWorkspaceSettings"), "Updated workspace settings");
  assert.equal(actionLabel("EnableConnector"), "Turned on connector");
  assert.equal(actionLabel("PauseWorkspaceIngestion"), "Paused workspace ingestion");
  assert.equal(actionLabel(undefined), "Unknown action");
});

test("toCsv quotes cells that need it", () => {
  assert.equal(toCsv([["a", 'b "c"', "d,e"], [1, null, "x\ny"]]), 'a,"b ""c""","d,e"\r\n1,,"x\ny"');
});

test("unhealthyComponents counts degraded and down components only", () => {
  const states = ["HEALTHY", "DEGRADED", "DOWN", "NOT_CONFIGURED"] as const;
  assert.equal(unhealthyComponents(states.map((state) => ({ state }))).length, 2);
});
