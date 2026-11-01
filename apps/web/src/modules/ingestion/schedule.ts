/**
 * Sync schedules as people say them.
 *
 * The API stores a schedule as a cron expression and an IANA time zone. People
 * choose "Daily at 02:00" or "Weekly on Monday at 06:00", and that is all this
 * module offers them: a draft of frequency, day, time and time zone, the cron
 * it becomes, and the sentence it reads as. A cron expression is never shown;
 * one written by another client that is not daily or weekly reads as "Custom
 * schedule" and the editor offers to replace it.
 */

export type ScheduleFrequency = "manual" | "daily" | "weekly";

export const WEEKDAYS = [
  { value: "mon", short: "Mon", label: "Monday", cron: 1 },
  { value: "tue", short: "Tue", label: "Tuesday", cron: 2 },
  { value: "wed", short: "Wed", label: "Wednesday", cron: 3 },
  { value: "thu", short: "Thu", label: "Thursday", cron: 4 },
  { value: "fri", short: "Fri", label: "Friday", cron: 5 },
  { value: "sat", short: "Sat", label: "Saturday", cron: 6 },
  { value: "sun", short: "Sun", label: "Sunday", cron: 0 },
] as const;

export type Weekday = (typeof WEEKDAYS)[number]["value"];

export const FREQUENCY_OPTIONS: readonly { value: ScheduleFrequency; label: string }[] = [
  { value: "manual", label: "Manual" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

/** What a person edits. `time` is "HH:MM" in `timezone`. */
export interface ScheduleDraft {
  frequency: ScheduleFrequency;
  day: Weekday | "";
  time: string;
  timezone: string;
}

/** The fields of an API `Schedule` these helpers read. */
export interface ScheduleFacts {
  cron_expression: string;
  timezone: string | null;
  enabled: boolean;
}

export const DEFAULT_SYNC_TIME = "02:00";
export const DEFAULT_TIMEZONE = "UTC";

/** The time zones offered first; the browser's own and a schedule's own are added when missing. */
export const SCHEDULE_TIMEZONES = [
  "Asia/Ho_Chi_Minh",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Europe/London",
  "America/New_York",
  "UTC",
] as const;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isScheduleTime(value: string): boolean {
  return TIME_PATTERN.test(value);
}

const pad = (value: number) => String(value).padStart(2, "0");

/** What a cron expression means, when it is one this product can say in words. */
export type Cadence =
  | { kind: "daily"; time: string }
  | { kind: "weekly"; day: Weekday; time: string }
  | { kind: "hourly"; every: number };

const CRON_DAY_NAMES: Record<string, Weekday> = {
  sun: "sun",
  mon: "mon",
  tue: "tue",
  wed: "wed",
  thu: "thu",
  fri: "fri",
  sat: "sat",
};

function weekdayFromCron(field: string): Weekday | null {
  const named = CRON_DAY_NAMES[field.toLowerCase()];
  if (named) return named;
  if (!/^[0-7]$/.test(field)) return null;
  const number = Number(field) % 7;
  return WEEKDAYS.find((day) => day.cron === number)?.value ?? null;
}

export function parseCron(expression: string): Cadence | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (dayOfMonth !== "*" || month !== "*") return null;

  if (/^\d{1,2}$/.test(minute) && /^\d{1,2}$/.test(hour)) {
    const m = Number(minute);
    const h = Number(hour);
    if (m > 59 || h > 23) return null;
    const time = `${pad(h)}:${pad(m)}`;
    if (dayOfWeek === "*") return { kind: "daily", time };
    const day = weekdayFromCron(dayOfWeek);
    return day ? { kind: "weekly", day, time } : null;
  }

  if (minute === "0" && dayOfWeek === "*") {
    if (hour === "*") return { kind: "hourly", every: 1 };
    const step = /^\*\/(\d{1,2})$/.exec(hour);
    if (step && Number(step[1]) > 0) return { kind: "hourly", every: Number(step[1]) };
  }
  return null;
}

/** The cron expression a draft is saved as; `null` for manual (no schedule). */
export function cronFor(draft: Pick<ScheduleDraft, "frequency" | "day" | "time">): string | null {
  if (draft.frequency === "manual" || !isScheduleTime(draft.time)) return null;
  const [hour, minute] = draft.time.split(":").map(Number);
  if (draft.frequency === "daily") return `${minute} ${hour} * * *`;
  const day = WEEKDAYS.find((entry) => entry.value === draft.day);
  return day ? `${minute} ${hour} * * ${day.cron}` : null;
}

function weekdayShort(day: Weekday): string {
  return WEEKDAYS.find((entry) => entry.value === day)?.short ?? day;
}

function describeCadence(cadence: Cadence): string {
  switch (cadence.kind) {
    case "daily":
      return `Daily at ${cadence.time}`;
    case "weekly":
      return `Weekly on ${weekdayShort(cadence.day)} at ${cadence.time}`;
    case "hourly":
      return cadence.every === 1 ? "Every hour" : `Every ${cadence.every} hours`;
  }
}

/** "Daily at 02:00", "Weekly on Mon at 06:00", "Manual" — never a cron expression. */
export function describeSchedule(schedule: ScheduleFacts | null | undefined): string {
  if (!schedule) return "Manual";
  const cadence = parseCron(schedule.cron_expression);
  return cadence ? describeCadence(cadence) : "Custom schedule";
}

/** The same sentence for a draft that has not been saved yet. */
export function describeDraft(draft: ScheduleDraft): string {
  if (draft.frequency === "manual") return "Manual";
  if (!isScheduleTime(draft.time)) return draft.frequency === "daily" ? "Daily" : "Weekly";
  if (draft.frequency === "daily") return `Daily at ${draft.time}`;
  return draft.day ? `Weekly on ${weekdayShort(draft.day)} at ${draft.time}` : "Weekly";
}

/**
 * A draft that starts from what is saved. `custom` is set when the saved
 * schedule is not daily or weekly, so the editor can say what it replaces.
 */
export function draftFromSchedule(
  schedule: ScheduleFacts | null | undefined,
  fallbackTimezone: string,
): { draft: ScheduleDraft; custom: boolean } {
  const timezone = schedule?.timezone || fallbackTimezone || DEFAULT_TIMEZONE;
  if (!schedule) {
    return { draft: { frequency: "manual", day: "mon", time: DEFAULT_SYNC_TIME, timezone }, custom: false };
  }
  const cadence = parseCron(schedule.cron_expression);
  if (cadence?.kind === "daily") {
    return { draft: { frequency: "daily", day: "mon", time: cadence.time, timezone }, custom: false };
  }
  if (cadence?.kind === "weekly") {
    return { draft: { frequency: "weekly", day: cadence.day, time: cadence.time, timezone }, custom: false };
  }
  return { draft: { frequency: "daily", day: "mon", time: DEFAULT_SYNC_TIME, timezone }, custom: true };
}

export interface ScheduleErrors {
  day?: string;
  time?: string;
}

export function validateDraft(draft: ScheduleDraft): ScheduleErrors {
  const errors: ScheduleErrors = {};
  if (draft.frequency === "weekly" && !draft.day) errors.day = "Choose a day.";
  if (draft.frequency !== "manual" && !isScheduleTime(draft.time)) errors.time = "Choose a time.";
  return errors;
}

/** On the hour, every hour, plus `include` (a saved time such as 02:30) when it is not one of them. */
export function scheduleTimes(include?: string): string[] {
  const times = Array.from({ length: 24 }, (_, hour) => `${pad(hour)}:00`);
  if (include && isScheduleTime(include) && !times.includes(include)) {
    times.push(include);
    times.sort();
  }
  return times;
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** "GMT+7" for Asia/Ho_Chi_Minh; "UTC" for UTC. Offsets follow daylight saving at `at`. */
export function timezoneOffset(timezone: string, at: Date = new Date()): string {
  if (timezone === "UTC" || timezone === "Etc/UTC") return "UTC";
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "shortOffset" })
      .formatToParts(at)
      .find((entry) => entry.type === "timeZoneName")?.value;
    return part === "GMT" ? "GMT+0" : part ?? timezone;
  } catch {
    return timezone;
  }
}

/** "Ho Chi Minh City" for Asia/Ho_Chi_Minh, "New York" for America/New_York. */
export function timezoneCity(timezone: string): string {
  if (timezone === "UTC" || timezone === "Etc/UTC") return "UTC";
  const city = timezone.split("/").pop()?.replaceAll("_", " ") ?? timezone;
  return city === "Ho Chi Minh" ? "Ho Chi Minh City" : city;
}

/** "Ho Chi Minh City (GMT+7)", or "UTC". */
export function timezoneLabel(timezone: string, at?: Date): string {
  const city = timezoneCity(timezone);
  return city === "UTC" ? "UTC" : `${city} (${timezoneOffset(timezone, at)})`;
}

/** The offered zones, plus any extra valid ones (the browser's, the saved one), without duplicates. */
export function timezoneOptions(
  extra: readonly (string | null | undefined)[] = [],
  at?: Date,
): { value: string; label: string }[] {
  const zones: string[] = [];
  for (const zone of [...extra, ...SCHEDULE_TIMEZONES]) {
    if (zone && !zones.includes(zone) && isTimeZone(zone)) zones.push(zone);
  }
  return zones.map((zone) => ({ value: zone, label: timezoneLabel(zone, at) }));
}

/** The browser's time zone, or UTC. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function plural(count: number, word: string): string {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

/** "Next sync in 3 hours"; null when nothing is scheduled ahead. */
export function nextSyncPhrase(nextRunAt: string | null | undefined, now: number = Date.now()): string | null {
  if (!nextRunAt) return null;
  const at = Date.parse(nextRunAt);
  if (Number.isNaN(at) || at <= now) return null;
  const minutes = Math.max(1, Math.round((at - now) / 60_000));
  if (minutes < 60) return `Next sync in ${plural(minutes, "minute")}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Next sync in ${plural(hours, "hour")}`;
  return `Next sync in ${plural(Math.round(hours / 24), "day")}`;
}
