import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * The legacy English-keyed dictionaries (web `src/i18n/vi.ts`, UX preview `scripts/i18n/vi.js`) must use the standard
 * Vietnamese terminology until every screen moves to the catalog (product-language-guidelines §2.7, localization §9).
 */
const ENTRY = /^\s*("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*"),?\s*$/;

function entries(path: string, end: string): Map<string, string> {
  const text = readFileSync(new URL(path, import.meta.url), "utf8").split(end)[0]!;
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = ENTRY.exec(line);
    if (m) out.set(JSON.parse(m[1]!) as string, JSON.parse(m[2]!) as string);
  }
  return out;
}

const web = entries("../src/i18n/vi.ts", "export const VI_NOUNS");
const preview = entries("../../ux_preview/scripts/i18n/vi.js", "const I18N_VI_NOUNS");

/** Retired Vietnamese terms that have no legitimate use anywhere in interface copy (matched case-insensitively). */
const RETIRED = [
  "bộ sưu tập",
  "duyệt tìm",
  "kiểm duyệt",
  "xuất bản",
  "knowledge studio",
  "hộp thư",
  "biên tập viên",
  "bài gửi",
  "đóng góp",
  "trò chuyện ai",
  "thất bại",
  "không thành công",
  "đến hạn rà soát",
  "đến hạn xác minh lại",
  "đang phân tích",
  "hủy liên kết",
  "bỏ liên kết",
  "vui lòng",
  "xin lỗi",
  " bởi ",
  "prompt phân loại",
  /không gian(?! làm việc)/, // Space is “cộng đồng”; “không gian” alone is only ever part of “không gian làm việc”
];

const matches = (vi: string, term: string | RegExp) =>
  typeof term === "string" ? ` ${vi.toLowerCase()} `.includes(term) : term.test(vi.toLowerCase());

/** Placeholders a translation must keep; one glued to an English word ("job{1}") is a plural suffix the translator drops. */
const placeholders = (s: string, key = s) =>
  [...s.matchAll(/\{\d+\}/g)]
    .map((m) => m[0])
    .filter((p) => !new RegExp(`[a-z]${p.replace(/[{}]/g, "\\$&")}`).test(key))
    .sort()
    .join(",");

for (const [name, dict] of [["web", web], ["preview", preview]] as const) {
  test(`${name} dictionary uses no retired Vietnamese term`, () => {
    const hits = [...dict].flatMap(([key, vi]) =>
      RETIRED.filter((term) => matches(vi, term)).map((term) => `${key} → ${vi} (“${String(term).trim()}”)`),
    );
    assert.deepEqual(hits, []);
  });

  test(`${name} dictionary keeps every placeholder of its English key`, () => {
    const broken = [...dict].filter(([key, vi]) => placeholders(key) !== placeholders(vi, key)).map(([key]) => key);
    assert.deepEqual(broken, []);
  });
}

test("web and preview translate a shared English string the same way", () => {
  const differ = [...web].filter(([key, vi]) => preview.has(key) && preview.get(key) !== vi).map(([key]) => key);
  assert.deepEqual(differ, []);
});
