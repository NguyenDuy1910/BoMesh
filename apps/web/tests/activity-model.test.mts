import assert from "node:assert/strict";
import test from "node:test";

import { areaLabel, auditFilter, describeAction, quote, signInMethod, targetOf } from "../src/modules/activity/model.ts";

test("describeAction reads audit codes as plain sentences, never the raw code", () => {
  assert.equal(describeAction("CreateSession"), "Đã đăng nhập");
  assert.equal(describeAction("UpdateWorkspaceSettings"), "Đã thay đổi thiết lập không gian làm việc");
  assert.equal(describeAction("CreateSpace"), "Đã tạo một cộng đồng");
  assert.equal(describeAction("DeleteGroup"), "Đã xóa một nhóm");
  assert.equal(describeAction("UpdateIngestionSchedule"), "Đã cập nhật một lịch xử lý");
  assert.equal(describeAction("ArchiveItem"), "Đã lưu trữ một mục");
  assert.equal(describeAction("CreateItem", "kho tài liệu"), "Đã tạo một kho tài liệu");
  assert.equal(describeAction("DeleteArtifact"), "Đã xóa một mục công việc");
  assert.equal(describeAction("DeleteConnection"), "Đã xóa một tài khoản đã kết nối");
  assert.equal(describeAction("ClearRecentItems"), "Đã xóa các mục gần đây");
  assert.equal(describeAction("TestSpaceIamPermissions"), "Đã kiểm tra quyền truy cập cộng đồng");
  assert.equal(describeAction("UpdateUserPreferences"), "Đã cập nhật tùy chọn người dùng");
  assert.equal(describeAction("SendBackRequest"), "Đã gửi trả yêu cầu");
  assert.equal(describeAction("PauseWorkspaceIngestion"), "Đã tạm dừng xử lý cho không gian làm việc");
  assert.equal(describeAction("Frobnicate"), "Đã thực hiện một thao tác");
  assert.equal(describeAction("CreateFrobnicator"), "Đã tạo một mục");
  assert.equal(describeAction(""), "Đã thực hiện một thao tác");
  assert.equal(describeAction(undefined), "Đã thực hiện một thao tác");
});

test("auditFilter quotes values and joins facets with AND", () => {
  const since = new Date("2026-11-01T00:00:00.000Z");
  assert.equal(auditFilter({ since }), 'createTime >= "2026-11-01T00:00:00.000Z"');
  assert.equal(
    auditFilter({ since, category: "SIGN_IN", actor: "users/u1", outcome: "FAILED" }),
    'createTime >= "2026-11-01T00:00:00.000Z" AND category = "SIGN_IN" AND actor = "users/u1" AND outcome = "FAILED"',
  );
  assert.equal(quote('a "b" \\ c'), '"a \\"b\\" \\\\ c"');
  assert.equal(auditFilter({ since, exclude: "SIGN_IN" }), 'createTime >= "2026-11-01T00:00:00.000Z" AND category != "SIGN_IN"');
  assert.equal(auditFilter({ since, category: "PEOPLE", exclude: "SIGN_IN" }), 'createTime >= "2026-11-01T00:00:00.000Z" AND category = "PEOPLE"');
});

test("signInMethod reads the method from the fixed sentence", () => {
  assert.equal(signInMethod("Signed in with Google"), "Google");
  assert.equal(signInMethod("Signed in with a password."), "Mật khẩu");
  assert.equal(signInMethod(undefined), "—");
  assert.equal(signInMethod("Create session (session)"), "—");
});

test("targetOf names the resource kind and its bare id", () => {
  assert.deepEqual(targetOf("workspaces/w/members/m1"), { kind: "member", id: "m1" });
  assert.deepEqual(targetOf("workspaces/w/items/i1/permissions/p"), { kind: "item", id: "i1" });
  assert.deepEqual(targetOf("workspaces/w/settings"), { kind: "settings", id: "settings" });
  assert.deepEqual(targetOf("workspaces/w"), { kind: "workspace", id: "w" });
  assert.deepEqual(targetOf("users/u1"), { kind: "user", id: "u1" });
  assert.deepEqual(targetOf("workspaces/w/artifacts/a1"), { kind: "artifact", id: "a1" });
  assert.deepEqual(targetOf(null), { kind: "other", id: "" });
});

test("areaLabel maps categories and falls back to Khác", () => {
  assert.equal(areaLabel("PEOPLE"), "Người dùng & phân quyền");
  assert.equal(areaLabel("SIGN_IN"), "Đăng nhập");
  assert.equal(areaLabel("NOPE"), "Khác");
});
