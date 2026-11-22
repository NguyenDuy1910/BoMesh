"use client";

import { ListBox, Select } from "@heroui/react";
import clsx from "clsx";

import { useLazyOptions } from "@/components/ui/useLazyOptions";

export interface InlineSelectProps<V extends string> {
  value: V;
  options: readonly (readonly [V, string])[];
  onChange: (value: V) => void;
  /** Accessible name (the control sits in a row without a visible label). */
  label: string;
  isDisabled?: boolean;
  className?: string;
}

/** Compact select inside a list row (preview `select({ size: 'sm', cls: 'kb-select' })`). */
export function InlineSelect<V extends string>({ value, options, onChange, label, isDisabled, className }: InlineSelectProps<V>) {
  const [shown, onOpenChange] = useLazyOptions(options, ([v]) => v === value);
  return (
    <Select aria-label={label} className={clsx("kb-select", className)} value={value} onChange={(v) => v != null && onChange(String(v) as V)} onOpenChange={onOpenChange} isDisabled={isDisabled}>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {shown.map(([v, l]) => (
            <ListBox.Item key={v} id={v} textValue={l}>
              {l}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
