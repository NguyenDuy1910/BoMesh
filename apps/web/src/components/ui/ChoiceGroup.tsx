"use client";

import { Radio, RadioGroup } from "@heroui/react";
import type { ReactNode } from "react";

export interface Choice<V extends string = string> {
  value: V;
  title: ReactNode;
  description?: ReactNode;
  isDisabled?: boolean;
}

export interface ChoiceGroupProps<V extends string = string> {
  value: V;
  options: readonly Choice<V>[];
  onChange: (value: V) => void;
  /** Accessible name of the group. */
  label: string;
  /** Grid columns (default 1). */
  columns?: number;
  name?: string;
  isDisabled?: boolean;
}

/**
 * Radio cards for consequential choices (preview `choiceGroup()`, HeroUI RadioGroup):
 * each option is a bordered card with radio, title and description; the selected card gets an accent ring.
 */
export function ChoiceGroup<V extends string = string>({ value, options, onChange, label, columns = 1, name, isDisabled }: ChoiceGroupProps<V>) {
  return (
    <RadioGroup
      aria-label={label}
      name={name}
      value={value}
      onChange={(next) => onChange(next as V)}
      isDisabled={isDisabled}
      className="choice-group"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {options.map((option) => (
        <Radio key={option.value} value={option.value} isDisabled={option.isDisabled} className="choice">
          <Radio.Content className="choice__content">
            <Radio.Control>
              <Radio.Indicator />
            </Radio.Control>
            <span className="grow">
              <span className="choice__title">{option.title}</span>
              {option.description ? <span className="choice__desc">{option.description}</span> : null}
            </span>
          </Radio.Content>
        </Radio>
      ))}
    </RadioGroup>
  );
}
