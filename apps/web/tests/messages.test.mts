import assert from "node:assert/strict";
import test from "node:test";

// Resolves the catalog's extensionless imports; the modules below must load after it.
import "./support/register-aliases.mjs";

const { messagesFor, languageOf } = await import("../src/i18n/messages/index.ts");

/** Sample parameters for message functions: a name for strings, a count for numbers. */
const SAMPLE = new Proxy({} as Record<string, unknown>, { get: (_, key) => (key === "count" ? 3 : "Quy chế đào tạo") });

/** Every string of a catalog with its key path; functions are called with sample parameters. */
function strings(node: unknown, path = ""): [path: string, text: string][] {
  if (typeof node === "string") return [[path, node]];
  if (typeof node === "function") return [[`${path}()`, String(node(SAMPLE))]];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
}

/** Key paths and value kinds ("string" | "function"), to compare the two languages' shapes. */
function shape(node: unknown, path = ""): string[] {
  if (typeof node !== "object" || node === null) return [`${path}:${typeof node}`];
  return Object.entries(node).flatMap(([k, v]) => shape(v, path ? `${path}.${k}` : k));
}

/**
 * Vietnamese terms retired by product-language-guidelines §2.7 (and localization §9: no “thất bại”, “không thành công”,
 * “Vui lòng” in routine copy, “bởi” passives). Matched case-insensitively anywhere in a value.
 */
const RETIRED = [
  "bộ sưu tập",
  "duyệt tìm",
  "kiểm duyệt",
  "xuất bản",
  "knowledge studio",
  "hộp thư",
  "biên tập viên",
  "mọi người",
  "đóng góp",
  "bài gửi",
  "cuộc trò chuyện mới",
  "công việc của bạn",
  "trò chuyện ai",
  "đã thay đổi tại nguồn",
  "thất bại",
  "không thành công",
  "có thể tìm kiếm",
  "đến hạn rà soát",
  "đến hạn xác minh lại",
  "độ tin cậy",
  "đang phân tích",
  "đã phân tích",
  "đã yêu cầu chỉnh sửa",
  "hủy liên kết",
  "bỏ liên kết",
  "vui lòng",
  "xin lỗi",
  " bởi ",
  "prompt phân loại",
];

/** Whole labels retired as names: the old Activity, Manage and connector names. */
const RETIRED_LABELS = ["Hoạt động", "Quản lý", "Nguồn"];

const vi = messagesFor("vi");
const en = messagesFor("en");
const fold = (s: string) => s.normalize("NFC").toLocaleLowerCase("vi");

test("the Vietnamese catalog uses no retired term (product language §2.7)", () => {
  const found = strings(vi).flatMap(([path, text]) => RETIRED.filter((term) => fold(text).includes(fold(term))).map((term) => `${path}: “${term}” in “${text}”`));
  assert.deepEqual(found, []);
  const labels = strings(vi).filter(([, text]) => RETIRED_LABELS.includes(text.trim()));
  assert.deepEqual(labels, []);
  // Space is “cộng đồng”; “không gian” alone is only ever part of “không gian làm việc”.
  const space = strings(vi).filter(([, text]) => /không gian(?! làm việc)/.test(fold(text)));
  assert.deepEqual(space, []);
});

test("Vietnamese labels and places carry no “của bạn” (localization §9.12)", () => {
  const labels = strings(vi).filter(([path]) => path.startsWith("nav.") || /\.label(\(\))?$/.test(path));
  assert.deepEqual(
    labels.filter(([, text]) => fold(text).includes("của bạn")),
    [],
  );
});

test("the glossary's new terms are the catalog's (product language §2.1, §2.4)", () => {
  assert.equal(vi.nav.studio, "Quản trị tài liệu");
  assert.equal(vi.nav.collections, "Kho tài liệu");
  assert.equal(vi.nav.sources, "Nguồn dữ liệu");
  assert.equal(vi.nav.browse, "Tra cứu");
  assert.equal(vi.nav.inbox, "Thông báo");
  assert.equal(vi.state.publication.published.label, "Đã công bố");
  assert.equal(vi.state.processing.failed.label, "Không xử lý được");
  assert.equal(vi.state.processing.outdated.label, "Nguồn đã thay đổi");
  assert.equal(vi.state.verification.review.label, "Cần xác minh lại");
  assert.equal(vi.state.lifecycle.stored.label, "Đã tải lên, chưa tra cứu được");
  assert.equal(vi.knowledge.browse.facets.trust, "Xác minh");
  // English follows PL §2's English column where it changed.
  assert.equal(en.knowledge.browse.facets.trust, "Verification");
  assert.equal(en.state.verification.review.label, "Re-verification due");
  assert.equal(en.state.lifecycle.stored.label, "Uploaded, not searchable");
  assert.equal(en.state.lifecycle.analyzing.label, "Processing");
});

test("English has exactly Vietnamese's keys and parameterized messages", () => {
  assert.deepEqual(shape(en), shape(vi));
});

test("an unknown or missing language is Vietnamese", () => {
  assert.equal(languageOf(undefined), "vi");
  assert.equal(languageOf("fr"), "vi");
  assert.equal(languageOf("en"), "en");
});
