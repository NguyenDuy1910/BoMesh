"use client";

import { ToggleButton, ToggleButtonGroup } from "@heroui/react";
import type { Selection } from "@heroui/react";
import type { LucideIcon } from "lucide-react";
import clsx from "clsx";

export interface SegmentedOption<V extends string = string> {
  value: V;
  /** Visible label; with `iconOnly` it becomes the accessible name. */
  label: string;
  icon?: LucideIcon;
  /** Show only the icon (the label stays as the accessible name). */
  iconOnly?: boolean;
  isDisabled?: boolean;
}

export interface SegmentedProps<V extends string = string> {
  value: V;
  options: readonly SegmentedOption<V>[];
  onChange: (value: V) => void;
  /** Accessible name of the group ("View", "Theme"). */
  label: string;
  /** Stretch segments across the container (preview `toggle-group--full`). */
  full?: boolean;
  className?: string;
}

/**
 * Segmented control for mutually exclusive view options (preview `seg()`, HeroUI ToggleButtonGroup):
 * a gray track with the selected segment raised.
 */
export function Segmented<V extends string = string>({ value, options, onChange, label, full, className }: SegmentedProps<V>) {
  const onSelectionChange = (keys: Selection) => {
    const next = keys === "all" ? undefined : [...keys][0];
    if (next !== undefined) onChange(String(next) as V);
  };
  return (
    <ToggleButtonGroup
      aria-label={label}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      onSelectionChange={onSelectionChange}
      fullWidth={full}
      className={clsx("segmented", full && "segmented--full", className)}
    >
      {options.map((option) => {
        const Icon = option.icon;
        return (
          <ToggleButton key={option.value} id={option.value} isDisabled={option.isDisabled} aria-label={option.iconOnly ? option.label : undefined} isIconOnly={option.iconOnly}>
            {Icon ? <Icon className="i i-sm" aria-hidden /> : null}
            {option.iconOnly ? null : option.label}
          </ToggleButton>
        );
      })}
    </ToggleButtonGroup>
  );
}
