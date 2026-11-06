import assert from "node:assert/strict";
import test from "node:test";

import { cronFor, draftDirty, draftFrom, nextSyncAt, scheduleFor, scheduleText, zonedInstant, type ScheduleDraft } from "../src/modules/ingestion/schedule.ts";

const daily: ScheduleDraft = { freq: "daily", day: "Mon", time: "02:00", tz: "Asia/Ho_Chi_Minh" };

test("drafts save as 5-field cron with the time zone; manual saves nothing", () => {
  assert.equal(cronFor(daily), "0 2 * * *");
  assert.equal(cronFor({ ...daily, freq: "weekly", day: "Sun", time: "06:30" }), "30 6 * * 0");
  assert.equal(cronFor({ ...daily, freq: "manual" }), null);
  assert.deepEqual(scheduleFor(daily), { cron: "0 2 * * *", timeZone: "Asia/Ho_Chi_Minh" });
  assert.equal(scheduleFor({ ...daily, freq: "manual" }), undefined);
});

test("saved schedules read back as the form and as words", () => {
  assert.deepEqual(draftFrom({ cron: "0 2 * * *", timeZone: "UTC" }), { draft: { freq: "daily", day: "Mon", time: "02:00", tz: "UTC" }, custom: false });
  assert.deepEqual(draftFrom({ cron: "15 9 * * FRI", timeZone: "Asia/Tokyo" }).draft, { freq: "weekly", day: "Fri", time: "09:15", tz: "Asia/Tokyo" });
  assert.deepEqual(draftFrom({ cron: "0 6 * * 7", timeZone: "UTC" }).draft.day, "Sun");
  assert.equal(draftFrom(undefined).draft.freq, "manual");
  assert.equal(draftFrom({ cron: "*/15 * * * *", timeZone: "UTC" }).custom, true);
  assert.equal(scheduleText({ cron: "0 6 * * 1", timeZone: "UTC" }), "Weekly on Mon at 06:00");
  assert.equal(scheduleText({ cron: "*/15 * * * *", timeZone: "UTC" }), "Custom schedule");
  assert.equal(scheduleText(undefined), "Manual");
});

test("dirty ignores fields that don't apply", () => {
  assert.equal(draftDirty({ ...daily, freq: "manual", tz: "UTC" }, { ...daily, freq: "manual" }), false);
  assert.equal(draftDirty({ ...daily, day: "Fri" }, daily), false);
  assert.equal(draftDirty({ ...daily, freq: "weekly", day: "Fri" }, { ...daily, freq: "weekly" }), true);
  assert.equal(draftDirty({ ...daily, time: "03:00" }, daily), true);
});

test("zoned wall time converts to the right instant", () => {
  // 02:00 in Ho Chi Minh City (GMT+7) is 19:00 UTC the day before.
  assert.equal(new Date(zonedInstant(2026, 11, 5, 2, 0, "Asia/Ho_Chi_Minh")).toISOString(), "2026-11-04T19:00:00.000Z");
  // New York on 2026-07-01 is GMT-4.
  assert.equal(new Date(zonedInstant(2026, 7, 1, 9, 0, "America/New_York")).toISOString(), "2026-07-01T13:00:00.000Z");
});

test("next sync is the next matching wall time in the schedule's zone", () => {
  const now = Date.parse("2026-11-05T03:00:00Z"); // Thu 10:00 in Ho Chi Minh City
  assert.equal(new Date(nextSyncAt(daily, now)!).toISOString(), "2026-11-05T19:00:00.000Z");
  assert.equal(new Date(nextSyncAt({ ...daily, time: "11:00" }, now)!).toISOString(), "2026-11-05T04:00:00.000Z");
  const weekly = nextSyncAt({ ...daily, freq: "weekly", day: "Mon" }, now)!;
  assert.equal(new Date(weekly).toISOString(), "2026-11-08T19:00:00.000Z"); // Mon 02:00 local
  // Today's slot already passed on a weekly schedule → next week.
  assert.equal(new Date(nextSyncAt({ ...daily, freq: "weekly", day: "Thu", time: "09:00" }, now)!).toISOString(), "2026-11-12T02:00:00.000Z");
  assert.equal(nextSyncAt({ ...daily, freq: "manual" }, now), null);
});
