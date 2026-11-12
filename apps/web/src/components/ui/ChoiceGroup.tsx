"use client";

import { Radio, RadioGroup } from "@heroui/react";
import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface Choice<V extends string = string> {
  value: V;
  title: ReactNode;
  description?: ReactNode;
  isDisabled?: boolean;
  /** An icon tile in place of the radio dot (preview `choice--icon`); three or more icon choices in a row read as tiles. */
  icon?: LucideIcon;
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
 * each option is a bordered card with a radio (or an icon tile), title and description; the selected card gets an accent ring.
 */
export function ChoiceGroup<V extends string = string>({ value, options, onChange, label, columns = 1, name, isDisabled }: ChoiceGroupProps<V>) {
  const tiles = columns >= 3 && options.some((o) => o.icon);
  return (
    <RadioGroup
      aria-label={label}
      name={name}
      value={value}
      onChange={(next) => onChange(next as V)}
      isDisabled={isDisabled}
      className={clsx("choice-group", tiles && "choice-group--tiles")}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {options.map(({ value: v, title, description, isDisabled: off, icon: Icon }) => (
        <Radio key={v} value={v} isDisabled={off} className={clsx("choice", Icon && "choice--icon")}>
          <Radio.Content className="choice__content">
            {Icon ? (
              <span className="choice__icon" aria-hidden="true">
                <Icon className="i" />
              </span>
            ) : (
              <Radio.Control>
                <Radio.Indicator />
              </Radio.Control>
            )}
            <span className="grow">
              <span className="choice__title">{title}</span>
              {description ? <span className="choice__desc">{description}</span> : null}
            </span>
          </Radio.Content>
        </Radio>
      ))}
    </RadioGroup>
  );
}
