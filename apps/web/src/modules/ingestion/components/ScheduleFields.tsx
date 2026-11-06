"use client";

import { Label, ListBox, Select } from "@heroui/react";
import clsx from "clsx";

import { Segmented } from "@/components/ui";

import { DAYS, FREQUENCIES, TIMES, timeZoneOptions, type Day, type ScheduleDraft } from "../schedule";

/** Labelled HeroUI Select over `[value, label]` pairs. */
export function OptionSelect<V extends string>({
  label,
  value,
  options,
  onChange,
  isInvalid,
  placeholder,
}: {
  label: string;
  value: V | "";
  options: readonly (readonly [V, string])[];
  onChange: (value: V) => void;
  isInvalid?: boolean;
  placeholder?: string;
}) {
  return (
    <Select className="field" value={value || null} onChange={(v) => v != null && onChange(String(v) as V)} isInvalid={isInvalid} placeholder={placeholder} fullWidth>
      <Label>{label}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map(([v, text]) => (
            <ListBox.Item key={v} id={v} textValue={text}>
              {text}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

/** Manual · Daily · Weekly, then day (weekly), time and time zone (preview `schedForm` / wizard step 4). */
export function ScheduleFields({ draft, onChange, label }: { draft: ScheduleDraft; onChange: (draft: ScheduleDraft) => void; label: string }) {
  return (
    <>
      <Segmented label={label} value={draft.freq} options={FREQUENCIES} onChange={(freq) => onChange({ ...draft, freq })} full />
      {draft.freq !== "manual" ? (
        <div className={clsx("src-sched-grid", draft.freq === "weekly" && "src-sched-grid--3")}>
          {draft.freq === "weekly" ? <OptionSelect<Day> label="Day" value={draft.day} options={DAYS} onChange={(day) => onChange({ ...draft, day })} /> : null}
          <OptionSelect label="Time" value={draft.time} options={TIMES.map((t) => [t, t] as const)} onChange={(time) => onChange({ ...draft, time })} />
          <OptionSelect label="Time zone" value={draft.tz} options={timeZoneOptions(draft.tz)} onChange={(tz) => onChange({ ...draft, tz })} />
        </div>
      ) : null}
    </>
  );
}
