import assert from "node:assert/strict";
import test from "node:test";

import "./support/register-aliases.mjs";

import {
  actionLabel,
  buildIndexing,
  indexingAlerts,
  jobStatus,
  mergeAuditPage,
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

const { userFilter } = await import("../src/modules/platform/api.ts");

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
  assert.equal(e.name, "Dùng ít nhất 2 ký tự.");
  assert.equal(e.code, "Dùng 3–40 chữ thường, số hoặc dấu gạch ngang.");
  assert.equal(e.email, "Nhập địa chỉ email đầy đủ, ví dụ sam@litware.com.");
  assert.equal(newWorkspaceErrors({ name: "Litware", code: "litware", email: "a@b.co" }, { displayName: "Litware Labs" }).code, "Đã được Litware Labs sử dụng. Hãy thử tên khác.");
});

test("buildIndexing derives status, queue, throughput, median and retryable failures from the summaries", () => {
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
      medianProcessingDuration: "120s",
    },
    { workspace: `workspaces/${W3}`, throughputPerHour: 1, failureRate: 0.01, errorClasses: [{ errorClass: "interrupted", taskCount: 1 }], medianProcessingDuration: "12.5s" },
  ];
  const rows = buildIndexing(workspaces, live, day);
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
  assert.equal(two.medianMs, null, "no summary: no median");
  assert.equal(three.status, "healthy");
  assert.equal(three.medianMs, 12_500);
  assert.equal(indexingAlerts(rows), 2);
  assert.deepEqual(sortIndexing(rows).map((r) => r.workspaceId), [W2, W1, W3]);
});

test("jobStatus holds queued and running work while ingestion is paused", () => {
  assert.equal(jobStatus({ state: "QUEUED" }, false), "queued");
  assert.equal(jobStatus({ state: "RUNNING" }, true), "held");
  assert.equal(jobStatus({ state: "SUCCEEDED" }, true), "done");
  assert.equal(jobStatus({ state: "CANCELLED" }, false), "cancelled");
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

test("actionLabel turns API method names into plain sentences", () => {
  assert.equal(actionLabel("CreateSession"), "Đã đăng nhập");
  assert.equal(actionLabel("UpdateWorkspaceSettings"), "Đã thay đổi thiết lập không gian làm việc");
  assert.equal(actionLabel("EnableConnector"), "Đã bật một trình kết nối");
  assert.equal(actionLabel("PauseWorkspaceIngestion"), "Đã tạm dừng lập chỉ mục");
  assert.equal(actionLabel("SuspendWorkspace"), "Đã tạm ngưng không gian làm việc");
  assert.equal(actionLabel("UpdateIngestionPolicy"), "Đã cập nhật chính sách lập chỉ mục");
  assert.equal(actionLabel(undefined), "Hành động không xác định");
});

test("toCsv quotes cells that need it", () => {
  assert.equal(toCsv([["a", 'b "c"', "d,e"], [1, null, "x\ny"]]), 'a,"b ""c""","d,e"\r\n1,,"x\ny"');
});

test("unhealthyComponents counts degraded and down components only", () => {
  const states = ["HEALTHY", "DEGRADED", "DOWN", "NOT_CONFIGURED"] as const;
  assert.equal(unhealthyComponents(states.map((state) => ({ state }))).length, 2);
});

test("userFilter turns the Users page's search and filters into one ListUsers filter", () => {
  assert.equal(userFilter({}), "");
  assert.equal(userFilter({ search: "  sam " }), '(displayName = "*sam*" OR email = "*sam*")');
  assert.equal(userFilter({ search: 'a"b', platformRole: "ADMIN", state: "SUSPENDED" }), '(displayName = "*a\\"b*" OR email = "*a\\"b*") AND platformRole = ADMIN AND state = SUSPENDED');
});

test("mergeAuditPage merges both streams newest first and pages past events sharing a timestamp", () => {
  const ev = (name: string, createTime: string) => ({ name, createTime });
  const platform = [ev("p1", "2026-11-05T10:00:03Z"), ev("p2", "2026-11-05T10:00:01Z"), ev("p3", "2026-11-05T10:00:01Z")];
  const workspace = [ev("w1", "2026-11-05T10:00:02Z"), ev("w2", "2026-11-05T10:00:01Z")];
  const first = mergeAuditPage(platform, workspace, null, 3, false);
  assert.deepEqual([first.platform.map((e) => e.name), first.workspace.map((e) => e.name)], [["p1", "p2"], ["w1"]]);
  // The next page reads at or before the last shown instant, skipping what was shown at it.
  assert.deepEqual(first.next, { before: "2026-11-05T10:00:01Z", seen: ["p2"] });
  const second = mergeAuditPage(platform.slice(1), workspace.slice(1), first.next, 3, false);
  assert.deepEqual([second.platform.map((e) => e.name), second.workspace.map((e) => e.name)], [["p3"], ["w2"]]);
  assert.equal(second.next, null, "nothing beyond: the last page");
  // A stream with more beyond what it returned keeps paging, and the seen list carries over at the same instant.
  const more = mergeAuditPage(platform.slice(1), [], first.next, 1, true);
  assert.deepEqual(more.next, { before: "2026-11-05T10:00:01Z", seen: ["p2", "p3"] });
});
