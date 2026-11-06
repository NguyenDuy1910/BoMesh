"use client";

import { Description, Label, Switch } from "@heroui/react";
import type { ReactNode } from "react";

export interface SwitchRowProps {
  title: ReactNode;
  /** Muted explanation under the title. */
  description?: ReactNode;
  isSelected: boolean;
  onChange: (isSelected: boolean) => void;
  isDisabled?: boolean;
  /** Accessible name when `title` is not plain text. */
  label?: string;
}

/**
 * Setting row (preview `switchRow()`): title + description on the left, HeroUI Switch on the right;
 * consecutive rows are separated by a line.
 */
export function SwitchRow({ title, description, isSelected, onChange, isDisabled, label }: SwitchRowProps) {
  return (
    <Switch className="switch-row" isSelected={isSelected} onChange={onChange} isDisabled={isDisabled} aria-label={label}>
      {/* Switch.Content is the pressable label: the control must sit inside it to toggle on click. */}
      <Switch.Content>
        <span className="switch-row__text">
          <Label className="medium">{title}</Label>
          {description ? <Description>{description}</Description> : null}
        </span>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
      </Switch.Content>
    </Switch>
  );
}
