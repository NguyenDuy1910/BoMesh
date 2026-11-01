"use client";

import { useMemo } from "react";

import { FormField } from "@/components/ui/FormField";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Select } from "@/components/ui/Select";
import {
  browserTimezone,
  describeDraft,
  FREQUENCY_OPTIONS,
  scheduleTimes,
  timezoneCity,
  timezoneOptions,
  WEEKDAYS,
  type ScheduleDraft,
  type ScheduleErrors,
  type ScheduleFrequency,
} from "@/modules/ingestion/schedule";

/**
 * How often a source syncs: Manual, Daily or Weekly, then the day, time and
 * time zone. Shared by the connect wizard and the source drawer so both say
 * the same thing the same way.
 */
export function ScheduleFields({
  idBase,
  label,
  draft,
  onChange,
  errors = {},
  replaces,
}: {
  idBase: string;
  /** Visible name of the frequency choice. */
  label: string;
  draft: ScheduleDraft;
  onChange: (draft: ScheduleDraft) => void;
  errors?: ScheduleErrors;
  /** What saving replaces when the saved schedule is not daily or weekly, e.g. "Every 6 hours". */
  replaces?: string;
}) {
  const times = useMemo(() => scheduleTimes(draft.time).map((time) => ({ value: time, label: time })), [draft.time]);
  const zones = useMemo(() => timezoneOptions([draft.timezone, browserTimezone()]), [draft.timezone]);
  const preview =
    draft.frequency === "manual"
      ? "Syncs only when someone clicks Sync now."
      : !errors.day && !errors.time && (draft.frequency === "daily" || draft.day)
        ? `${describeDraft(draft)} (${timezoneCity(draft.timezone)} time)`
        : null;

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <span className="text-[0.84375rem] font-medium text-text-primary" id={`${idBase}-frequency`}>
          {label}
        </span>
        <SegmentedControl<ScheduleFrequency>
          ariaLabel={label}
          className="w-max"
          onChange={(frequency) => onChange({ ...draft, frequency })}
          options={FREQUENCY_OPTIONS}
          value={draft.frequency}
        />
      </div>
      {draft.frequency !== "manual" && (
        <div className={draft.frequency === "weekly" ? "grid gap-3 sm:grid-cols-3" : "grid gap-3 sm:grid-cols-2"}>
          {draft.frequency === "weekly" && (
            <FormField error={errors.day} htmlFor={`${idBase}-day`} label="Day" required>
              <Select
                onChange={(event) => onChange({ ...draft, day: event.target.value as ScheduleDraft["day"] })}
                options={WEEKDAYS.map((day) => ({ value: day.value, label: day.label }))}
                placeholder="Choose a day"
                value={draft.day}
              />
            </FormField>
          )}
          <FormField error={errors.time} htmlFor={`${idBase}-time`} label="Time" required>
            <Select
              onChange={(event) => onChange({ ...draft, time: event.target.value })}
              options={times}
              placeholder="Choose a time"
              value={draft.time}
            />
          </FormField>
          <FormField htmlFor={`${idBase}-timezone`} label="Time zone" required>
            <Select
              onChange={(event) => onChange({ ...draft, timezone: event.target.value })}
              options={zones}
              value={draft.timezone}
            />
          </FormField>
        </div>
      )}
      {replaces && draft.frequency !== "manual" && (
        <p className="text-meta text-text-secondary">Saving replaces the current schedule ({replaces}).</p>
      )}
      {preview && <p className="text-meta text-text-tertiary">{preview}</p>}
    </div>
  );
}
