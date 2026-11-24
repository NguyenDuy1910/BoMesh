import assert from "node:assert/strict";
import test from "node:test";

import {
  TEMPLATES,
  canLeaveWorkspace,
  identityDirty,
  identityErrors,
  identityPatch,
  joinLink,
  logoFileError,
  logoToast,
  mapBgFileError,
  mapBgPlan,
  mapBgSize,
  mapBgToast,
  moduleChanged,
  resetBody,
  setupBody,
  setupChanges,
  setupOf,
  spaceTypeKeys,
  spaceTypesWith,
  strengthOf,
  toggled,
  workflowsWith,
} from "../src/modules/workspace-settings/model.ts";

const CURRENT = { name: "Northwind", code: "northwind" };
const label = (key: string) => ({ displayName: key[0].toUpperCase() + key.slice(1), icon: "users" });

test("identity validation follows the preview copy and skips an unchanged code", () => {
  assert.deepEqual(identityErrors(CURRENT, CURRENT), {});
  assert.deepEqual(identityErrors({ name: " ", code: "" }, CURRENT), { name: "Nhập tên không gian làm việc.", code: "Nhập địa chỉ web." });
  assert.equal(identityErrors({ name: "x".repeat(61), code: "northwind" }, CURRENT).name, "Tên tối đa 60 ký tự.");
  assert.equal(identityErrors({ name: "N", code: "ab" }, CURRENT).code, "Dùng 3–32 ký tự.");
  assert.equal(
    identityErrors({ name: "N", code: "-bad-" }, CURRENT).code,
    "Dùng chữ thường, số và dấu gạch nối. Bắt đầu và kết thúc bằng chữ hoặc số.",
  );
  assert.equal(identityErrors({ name: "N", code: "Upper" }, CURRENT).code !== undefined, true);
  assert.deepEqual(identityErrors({ name: "N", code: "north-wind-2" }, CURRENT), {});
});

test("identityPatch sends only changed fields", () => {
  assert.equal(identityDirty({ name: "Northwind ", code: "northwind" }, CURRENT), false);
  assert.deepEqual(identityPatch({ name: "Northwind Co", code: "northwind" }, CURRENT), { displayName: "Northwind Co", updateMask: "displayName" });
  assert.deepEqual(identityPatch({ name: "Northwind", code: "nw" }, CURRENT), { code: "nw", updateMask: "code" });
});

test("setupOf reads the API defaults: absent modules are on, an empty workflow list offers all", () => {
  const setup = setupOf({ modules: { work: false }, spaceTypes: [{ key: "team", displayName: "Team", enabled: true }, { key: "course", displayName: "Course", enabled: false }] });
  assert.deepEqual(setup.modules, { spaces: true, work: false, requests: true });
  assert.deepEqual(setup.spaceTypes, ["team"]);
  assert.deepEqual(setup.workflows, ["STUDY_GUIDE", "QUIZ", "EVIDENCE_REVIEW", "DRAFT"]);
  assert.deepEqual(setupOf({ workflows: [{ key: "DRAFT", enabled: true }, { key: "QUIZ", enabled: false }] }).workflows, ["DRAFT"]);
});

test("template comparison counts changed settings and offers a reset", () => {
  const enterprise = TEMPLATES.ENTERPRISE;
  const defaults = setupOf({
    modules: { spaces: false, work: false, requests: false },
    workflows: workflowsWith(enterprise.workflows),
  });
  assert.equal(setupChanges(defaults, enterprise), 0);
  const allOn = setupOf({});
  assert.equal(moduleChanged(allOn, enterprise, "spaces"), true);
  // 3 modules, 2 space types missing, 2 extra workflows.
  assert.equal(setupChanges(allOn, enterprise), 7);
  assert.equal(setupChanges(setupOf({ spaceTypes: [{ key: "course", displayName: "C", enabled: true }] }), TEMPLATES.CAMPUS), 2);
});

test("space type lists keep custom keys, labels and icons and add missing known types", () => {
  const settings = { spaceTypes: [{ key: "team", displayName: "Squad", icon: "users", enabled: true }, { key: "lab", displayName: "Lab", icon: "flask", enabled: true }] };
  assert.deepEqual(spaceTypeKeys(settings), ["course", "research", "office", "team", "project", "lab"]);
  assert.deepEqual(spaceTypesWith(settings, ["team", "course"], label), [
    { key: "course", displayName: "Course", icon: "users", enabled: true },
    { key: "team", displayName: "Squad", icon: "users", enabled: true },
    { key: "lab", displayName: "Lab", icon: "flask", enabled: false },
  ]);
});

test("toggled refuses to empty a list; reset and undo bodies cover the whole setup", () => {
  assert.deepEqual(toggled(["a", "b"], "a"), ["b"]);
  assert.deepEqual(toggled(["a"], "b"), ["a", "b"]);
  assert.equal(toggled(["a"], "a"), null);
  const reset = resetBody({}, TEMPLATES.ENTERPRISE, label);
  assert.equal(reset.updateMask, "modules,spaceTypes,workflows");
  assert.deepEqual(reset.body.modules, { spaces: false, work: false, requests: false });
  assert.deepEqual(reset.body.spaceTypes?.map((t) => t.key), ["team", "project"]);
  assert.deepEqual(reset.body.workflows?.filter((w) => w.enabled).map((w) => w.key), ["EVIDENCE_REVIEW", "DRAFT"]);
  assert.deepEqual(setupBody({ modules: { spaces: true } }).body, { modules: { spaces: true }, spaceTypes: [], workflows: [] });
});

test("map background: accepted files, upload size and strength follow the preview", () => {
  assert.equal(mapBgFileError({ type: "image/svg+xml", size: 1000 }), null);
  assert.equal(mapBgFileError({ type: "image/gif", size: 1000 }), "Hãy dùng ảnh JPG, PNG, WebP hoặc SVG.");
  assert.equal(mapBgFileError({ type: "image/jpeg", size: 10 * 1024 * 1024 + 1 }), "Ảnh lớn hơn 10 MB. Hãy chọn ảnh nhỏ hơn.");
  assert.deepEqual(mapBgSize(3264, 1836, false), { w: 1920, h: 1080 });
  assert.deepEqual(mapBgSize(800, 600, false), { w: 800, h: 600 });
  assert.deepEqual(mapBgSize(800, 450, true), { w: 1920, h: 1080 });
  assert.equal(strengthOf(undefined), 25);
  assert.equal(strengthOf(140), 100);
  assert.equal(strengthOf("35"), 35);
  assert.equal(strengthOf(0), 0);
});

test("logo: PNG, JPEG or WebP up to 1 MB; the toast says what changed", () => {
  assert.equal(logoFileError({ type: "image/png", size: 1024 * 1024 }), null);
  assert.equal(logoFileError({ type: "image/webp", size: 10 }), null);
  assert.equal(logoFileError({ type: "image/gif", size: 10 }), "Hãy dùng ảnh PNG, JPEG hoặc WebP.");
  assert.equal(logoFileError({ type: "image/svg+xml", size: 10 }), "Hãy dùng ảnh PNG, JPEG hoặc WebP.");
  assert.equal(logoFileError({ type: "image/png", size: 3 * 1024 * 1024 }), "Logo phải có dung lượng tối đa 1 MB. Hãy chọn ảnh nhỏ hơn.");
  assert.equal(logoToast(false, true), "Đã thêm logo");
  assert.equal(logoToast(true, true), "Đã cập nhật logo");
  assert.equal(logoToast(true, false), "Đã xóa logo");
});

test("map background save plan: remove, upload then strength only when it differs, or nothing", () => {
  const saved = { fileName: "campus.jpg", strength: 40 };
  assert.equal(mapBgPlan(undefined, null, 25), null);
  assert.equal(mapBgPlan(saved, { isNew: false }, 40), null);
  assert.deepEqual(mapBgPlan(saved, { isNew: false }, 60), { remove: false, upload: false, strength: 60 });
  assert.deepEqual(mapBgPlan(saved, null, 40), { remove: true, upload: false, strength: null });
  assert.deepEqual(mapBgPlan(saved, { isNew: true }, 40), { remove: false, upload: true, strength: null });
  assert.deepEqual(mapBgPlan(undefined, { isNew: true }, 25), { remove: false, upload: true, strength: null });
  assert.deepEqual(mapBgPlan(undefined, { isNew: true }, 50), { remove: false, upload: true, strength: 50 });
  assert.equal(mapBgToast(undefined, saved), "Đã thêm ảnh nền bản đồ");
  assert.equal(mapBgToast(saved, saved), "Đã cập nhật ảnh nền bản đồ");
  assert.equal(mapBgToast(saved, undefined), "Đã gỡ ảnh nền bản đồ");
});

test("anyone but the last active workspace admin may leave; unknown hides Leave", () => {
  const admin = ["roles/workspaceAdmin"];
  assert.equal(canLeaveWorkspace(["roles/workspaceMember"], undefined), true);
  assert.equal(canLeaveWorkspace(admin, 2), true);
  assert.equal(canLeaveWorkspace(admin, 1), false);
  assert.equal(canLeaveWorkspace(admin, undefined), null);
  assert.equal(canLeaveWorkspace(undefined, 3), null);
});

test("a public workspace's join link is its /w/{code} page", () => {
  assert.equal(joinLink("https://app.bomesh.io", "ute"), "https://app.bomesh.io/w/ute");
});
