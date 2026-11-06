/**
 * Interface formatters (port of the preview's `scripts/core/util.js`).
 *
 * The locale follows the interface language: `<html lang="vi">` → Vietnamese,
 * anything else → English. Reading `document.documentElement.lang` at call time
 * keeps every formatter in step with the language switch; on the server (no
 * `document`) English is used. Date inputs accept ISO strings, epoch
 * milliseconds or `Date`; missing or invalid values render as "—".
 */

import { uiNoun } from "@/lib/i18n";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Accepted date input: ISO-8601 string (API timestamps), epoch ms or Date. */
export type DateInput = string | number | Date | null | undefined;

const isVi = () => typeof document !== "undefined" && document.documentElement.lang.toLowerCase().startsWith("vi");
const uiLocale = () => (isVi() ? "vi-VN" : "en-US");

function toMs(value: DateInput): number | null {
  if (value === null || value === undefined || value === "") return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Locale-grouped number: `1,234` (en) / `1.234` (vi). */
export function fmtNum(n: number | null | undefined): string {
  return Number(n ?? 0).toLocaleString(uiLocale());
}

/** Compact count: `999`, `1.2k`, `12k`, `3.4M`, `12M`. */
export function fmtCompact(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1e4) return Math.round(n / 1e3) + "k";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

/**
 * Count with noun: `1 document`, `12 documents`. Vietnamese nouns don't inflect;
 * the singular is looked up in the interface noun dictionary (`uiNoun`).
 */
export function plural(n: number, one: string, many = `${one}s`): string {
  if (isVi()) return `${fmtNum(n)} ${uiNoun(one) ?? one}`;
  return `${fmtNum(n)} ${n === 1 ? one : many}`;
}

/** Whole percentage of `a` in `b` (0 when `b` is 0). */
export function pct(a: number, b: number): number {
  return b ? Math.round((a / b) * 100) : 0;
}

/** Byte size: `512 B`, `48 KB`, `2.4 MB`, `1.1 GB`. Accepts the API's int64 strings. */
export function fmtSize(bytes: number | string | null | undefined): string {
  const b = Number(bytes ?? 0);
  if (!Number.isFinite(b)) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1_048_576) return `${Math.round(b / 1024)} KB`;
  if (b < 1_073_741_824) return `${(b / 1_048_576).toFixed(1)} MB`;
  return `${(b / 1_073_741_824).toFixed(1)} GB`;
}

/** Relative past time: `Just now`, `5 min ago`, `3 h ago`, `Yesterday`, `4 days ago`, then a date. */
export function rel(value: DateInput): string {
  const ts = toMs(value);
  if (ts === null) return "—";
  const d = Date.now() - ts;
  const vi = isVi();
  if (d < MIN) return vi ? "Vừa xong" : "Just now";
  if (d < HOUR) return Math.round(d / MIN) + (vi ? " phút trước" : " min ago");
  if (d < DAY) return Math.round(d / HOUR) + (vi ? " giờ trước" : " h ago");
  if (d < 2 * DAY) return vi ? "Hôm qua" : "Yesterday";
  if (d < 7 * DAY) return Math.floor(d / DAY) + (vi ? " ngày trước" : " days ago");
  return fmtDate(ts);
}

/** Relative future time: `in 5 min`, `in 3 h`, `in 2 days`. */
export function relFuture(value: DateInput): string {
  const ts = toMs(value);
  if (ts === null) return "—";
  const d = ts - Date.now();
  const vi = isVi();
  if (d < HOUR) {
    const m = Math.max(1, Math.round(d / MIN));
    return vi ? `sau ${m} phút` : `in ${m} min`;
  }
  if (d < DAY) return vi ? `sau ${Math.round(d / HOUR)} giờ` : `in ${Math.round(d / HOUR)} h`;
  return vi ? `sau ${Math.round(d / DAY)} ngày` : `in ${Math.round(d / DAY)} days`;
}

/** Short date: `Mar 4` this year, `Mar 4, 2025` otherwise. */
export function fmtDate(value: DateInput): string {
  const ts = toMs(value);
  if (ts === null) return "—";
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(uiLocale(), { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
}

/** Date and time: `Mar 4, 3:20 PM`. */
export function fmtDateTime(value: DateInput): string {
  const ts = toMs(value);
  if (ts === null) return "—";
  return new Date(ts).toLocaleString(uiLocale(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Time of day: `3:20 PM`. */
export function fmtTime(value: DateInput): string {
  const ts = toMs(value);
  if (ts === null) return "—";
  return new Date(ts).toLocaleTimeString(uiLocale(), { hour: "numeric", minute: "2-digit" });
}

/** Duration from milliseconds: `42s`, `3m 12s`, `2h 5m`. */
export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
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
