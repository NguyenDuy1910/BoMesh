/**
 * Sync schedules as people say them ("Daily at 02:00", "Weekly on Mon at 06:00").
 *
 * The API stores a 5-field cron expression plus an IANA time zone
 * (`Source.schedule {cron, timeZone}`); no schedule means Manual. This module
 * converts between that and the preview's form (Manual / Daily / Weekly, day,
 * time on the hour, time zone) and works out the next sync time in the
 * source's own zone. Pure: no React, no API.
 */

export type Frequency = "manual" | "daily" | "weekly";
export type Day = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

export interface ScheduleDraft {
  freq: Frequency;
  day: Day;
  /** "HH:MM", wall time in `tz`. */
  time: string;
  tz: string;
}

/** The API's schedule fields this module reads and writes. */
export interface ScheduleValue {
  cron?: string;
  timeZone?: string;
}

export const DAYS: readonly (readonly [Day, string])[] = [
  ["Mon", "Monday"],
  ["Tue", "Tuesday"],
  ["Wed", "Wednesday"],
  ["Thu", "Thursday"],
  ["Fri", "Friday"],
  ["Sat", "Saturday"],
  ["Sun", "Sunday"],
];

export const TIME_ZONES: readonly (readonly [string, string])[] = [
  ["Asia/Ho_Chi_Minh", "Ho Chi Minh City (GMT+7)"],
  ["Asia/Singapore", "Singapore (GMT+8)"],
  ["Asia/Tokyo", "Tokyo (GMT+9)"],
  ["Europe/London", "London (GMT+1)"],
  ["America/New_York", "New York (GMT−4)"],
  ["UTC", "UTC"],
];

/** Every hour, "00:00" … "23:00". */
export const TIMES: readonly string[] = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);

export const FREQUENCIES: readonly { value: Frequency; label: string }[] = [
  { value: "manual", label: "Manual" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

export const DEFAULT_DRAFT: ScheduleDraft = { freq: "daily", day: "Mon", time: "02:00", tz: "Asia/Ho_Chi_Minh" };

/* Cron day-of-week: 0 or 7 = Sunday, 1 = Monday … 6 = Saturday. */
const CRON_DOW: Readonly<Record<Day, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DOW_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const DAY_BY_DOW: readonly Day[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad = (n: number) => String(n).padStart(2, "0");

function dayFromCron(field: string): Day | null {
  const upper = field.toUpperCase();
  const named = DOW_NAMES.indexOf(upper);
  if (named >= 0) return DAY_BY_DOW[named] ?? null;
  if (!/^\d$/.test(field)) return null;
  return DAY_BY_DOW[Number(field) % 7] ?? null;
}

/** The cron expression a draft saves as; `null` for Manual (no schedule). */
export function cronFor(draft: Pick<ScheduleDraft, "freq" | "day" | "time">): string | null {
  if (draft.freq === "manual") return null;
  const [h = 0, m = 0] = draft.time.split(":").map(Number);
  return draft.freq === "daily" ? `${m} ${h} * * *` : `${m} ${h} * * ${CRON_DOW[draft.day]}`;
}

/** The API schedule for a draft; `undefined` for Manual. */
export function scheduleFor(draft: ScheduleDraft): ScheduleValue | undefined {
  const cron = cronFor(draft);
  return cron ? { cron, timeZone: draft.tz } : undefined;
}

/**
 * The form state for a saved schedule. `custom` is true when the cron isn't one
 * this form can show (it then starts from the defaults).
 */
export function draftFrom(schedule: ScheduleValue | undefined | null): { draft: ScheduleDraft; custom: boolean } {
  const tz = schedule?.timeZone || DEFAULT_DRAFT.tz;
  if (!schedule?.cron) return { draft: { ...DEFAULT_DRAFT, freq: "manual", tz }, custom: false };
  const parts = schedule.cron.trim().split(/\s+/);
  const [min, hour, dom, mon, dow] = parts;
  const simple = parts.length === 5 && /^\d{1,2}$/.test(min ?? "") && /^\d{1,2}$/.test(hour ?? "") && dom === "*" && mon === "*";
  if (!simple || Number(hour) > 23 || Number(min) > 59) return { draft: { ...DEFAULT_DRAFT, tz }, custom: true };
  const time = `${pad(Number(hour))}:${pad(Number(min))}`;
  if (dow === "*") return { draft: { ...DEFAULT_DRAFT, freq: "daily", time, tz }, custom: false };
  const day = dayFromCron(dow ?? "");
  if (!day) return { draft: { ...DEFAULT_DRAFT, tz }, custom: true };
  return { draft: { freq: "weekly", day, time, tz }, custom: false };
}

/** "Manual", "Daily at 02:00", "Weekly on Mon at 06:00", or "Custom schedule". */
export function draftText(draft: ScheduleDraft): string {
  if (draft.freq === "manual") return "Manual";
  if (draft.freq === "daily") return `Daily at ${draft.time}`;
  return `Weekly on ${draft.day} at ${draft.time}`;
}

export function scheduleText(schedule: ScheduleValue | undefined | null): string {
  const { draft, custom } = draftFrom(schedule);
  return custom ? "Custom schedule" : draftText(draft);
}

/** Whether the form differs from what's saved (time zone and day only count when they apply). */
export function draftDirty(form: ScheduleDraft, saved: ScheduleDraft): boolean {
  if (form.freq !== saved.freq) return true;
  if (form.freq === "manual") return false;
  return form.time !== saved.time || form.tz !== saved.tz || (form.freq === "weekly" && form.day !== saved.day);
}

/* ═══════════════ Time zones ═══════════════ */

/** The offered zones plus any other valid zone (a saved one) the list lacks. */
export function timeZoneOptions(extra?: string | null): readonly (readonly [string, string])[] {
  if (!extra || TIME_ZONES.some(([tz]) => tz === extra) || !isTimeZone(extra)) return TIME_ZONES;
  return [...TIME_ZONES, [extra, extra.replace(/_/g, " ")] as const];
}

/** "Ho Chi Minh City" — the label without its offset. */
export function tzShort(tz: string): string {
  return (TIME_ZONES.find(([value]) => value === tz)?.[1] ?? tz).replace(/ \(.*\)$/, "");
}

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday. */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** The wall clock in `tz` at instant `t`. */
export function wallClock(t: number, tz: string): WallClock {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(tz).formatToParts(new Date(t))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? ""),
  };
}

/** Offset of `tz` from UTC at instant `t`, in ms. */
function offsetAt(t: number, tz: string): number {
  const w = wallClock(t, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, new Date(t).getUTCSeconds());
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** The instant a wall time in `tz` happens (month is 1-based; day may overflow). */
export function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetAt(guess, tz);
  return guess - offsetAt(first, tz);
}

/** The next sync after `now` for a draft, or `null` for Manual. */
export function nextSyncAt(draft: ScheduleDraft, now: number = Date.now()): number | null {
  if (draft.freq === "manual") return null;
  const tz = isTimeZone(draft.tz) ? draft.tz : "UTC";
  const [h = 0, m = 0] = draft.time.split(":").map(Number);
  const today = wallClock(now, tz);
  const want = CRON_DOW[draft.day];
  for (let i = 0; i <= 7; i++) {
    if (draft.freq === "weekly" && (today.weekday + i) % 7 !== want) continue;
    const at = zonedInstant(today.year, today.month, today.day + i, h, m, tz);
    if (at > now) return at;
  }
  return null;
}
