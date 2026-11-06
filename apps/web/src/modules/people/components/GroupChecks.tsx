"use client";

import { Checkbox } from "@heroui/react";

import type { Group } from "../api";

/** Two-column group checkboxes (preview `.ppl-checks`). Values are group resource names. */
export function GroupChecks({ groups, value, onChange, isDisabled }: { groups: readonly Group[]; value: readonly string[]; onChange: (next: string[]) => void; isDisabled?: boolean }) {
  return (
    <div className="ppl-checks">
      {groups.map((g) => {
        const name = g.name ?? "";
        return (
          <Checkbox
            key={name}
            isSelected={value.includes(name)}
            isDisabled={isDisabled}
            onChange={(on) => onChange(on ? [...value, name] : value.filter((v) => v !== name))}
          >
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              <span translate="no">{g.displayName}</span>
            </Checkbox.Content>
          </Checkbox>
        );
      })}
    </div>
  );
}
