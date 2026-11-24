/**
 * Interface formatters (port of the preview's `scripts/core/util.js`), in Vietnamese (`vi-VN`) on the server and in
 * the browser alike, so the first paint and hydration agree. Date inputs accept ISO strings, epoch milliseconds or
 * `Date`; missing or invalid values render as "—".
 */

import { uiNoun } from "@/lib/i18n";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Accepted date input: ISO-8601 string (API timestamps), epoch ms or Date. */
export type DateInput = string | number | Date | null | undefined;

const LOCALE = "vi-VN";

function toMs(value: DateInput): number | null {
  if (value === null || value === undefined || value === "") return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Locale-grouped number: `1.234`. */
export function fmtNum(n: number | null | undefined): string {
  return Number(n ?? 0).toLocaleString(LOCALE);
}

/** Compact count: `999`, `1.2k`, `12k`, `3.4M`, `12M`. */
export function fmtCompact(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1e4) return Math.round(n / 1e3) + "k";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

/**
 * Count with noun: `12 tài liệu`. Vietnamese nouns don't inflect: the singular English noun a caller names is looked
 * up in the counter nouns (`src/i18n/nouns.ts`); a noun already in Vietnamese passes through.
 */
export function plural(n: number, one: string): string {
  return `${fmtNum(n)} ${uiNoun(one) ?? one}`;
}

/** Whole percentage of `a` in `b` (0 when `b` is 0). */
export function pct(a: number, b: number): number {
  return b ? Math.round((a / b) * 100) : 0;
}

/** Byte size: `512 B`, `48 KB`, `2,4 MB`, `1,1 GB`. Accepts the API's int64 strings. */
export function fmtSize(bytes: number | string | null | undefined): string {
  const b = Number(bytes ?? 0);
  if (!Number.isFinite(b)) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1_048_576) return `${Math.round(b / 1024)} KB`;
  const oneDecimal = (n: number) => n.toLocaleString(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (b < 1_073_741_824) return `${oneDecimal(b / 1_048_576)} MB`;
  return `${oneDecimal(b / 1_073_741_824)} GB`;
}

/** Relative past time: `Vừa xong`, `5 phút trước`, `3 giờ trước`, `Hôm qua`, `4 ngày trước`, then a date. */
export function rel(value: DateInput): string {
  const ts = toMs(value);
  if (ts === null) return "—";
  const d = Date.now() - ts;
  if (d < MIN) return "Vừa xong";
  if (d < HOUR) return `${Math.floor(d / MIN)} phút trước`;
  if (d < DAY) return `${Math.floor(d / HOUR)} giờ trước`;
  if (d < 2 * DAY) return "Hôm qua";
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} ngày trước`;
  return fmtDate(ts);
}

/** `rel()` inside a sentence ("Đã gửi hôm qua"): the word-only values lose their capital. */
export function relInline(value: DateInput): string {
  const s = rel(value);
  return /^(Vừa xong|Hôm qua)$/.test(s) ? s.toLocaleLowerCase("vi") : s;
}

/** Relative future time: `sau 5 phút`, `sau 3 giờ`, `sau 2 ngày`. */
export function relFuture(value: DateInput): string {
  const ts = toMs(value);
  if (ts === null) return "—";
  const d = ts - Date.now();
  if (d < HOUR) return `sau ${Math.max(1, Math.round(d / MIN))} phút`;
  if (d < DAY) return `sau ${Math.round(d / HOUR)} giờ`;
  return `sau ${Math.round(d / DAY)} ngày`;
}

/** Short date: `4 thg 3` this year, `4 thg 3, 2025` otherwise. */
export function fmtDate(value: DateInput): string {
  const ts = toMs(value);
  if (ts === null) return "—";
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(LOCALE, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
}

/** Date and time: `15:20 4 thg 3`. */
export function fmtDateTime(value: DateInput): string {
  const ts = toMs(value);
  if (ts === null) return "—";
  return new Date(ts).toLocaleString(LOCALE, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Time of day: `15:20`. */
export function fmtTime(value: DateInput): string {
  const ts = toMs(value);
  if (ts === null) return "—";
  return new Date(ts).toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" });
}

/** Duration from milliseconds: `42 giây`, `3 phút 12 giây`, `2 giờ 5 phút`. */
export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} giây`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} phút ${s % 60} giây`;
  return `${Math.floor(m / 60)} giờ ${m % 60} phút`;
}

/** Up to two initials, upper-cased: `Linh Tran` → `LT`. */
export function initials(name: string | null | undefined): string {
  return (
    String(name || "?")
      .trim()
      .split(/\s+/)
      .map((w) => w[0] ?? "")
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}

/** Stable 32-bit hash of a string (preview `hashOf`), for name-stable tones. */
export function hashOf(value: string): number {
  let h = 7;
  for (const c of String(value)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
