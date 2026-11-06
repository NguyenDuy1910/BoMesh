"use client";

import { Description, Label, ListBox, Select } from "@heroui/react";
import type { ReactNode } from "react";

import type { WorkspaceRole } from "../model";

export interface RoleSelectProps {
  value: string;
  roles: readonly WorkspaceRole[];
  onChange: (role: string) => void;
  /** Visible label; without it `ariaLabel` names the control. */
  label?: string;
  ariaLabel?: string;
  description?: ReactNode;
  isDisabled?: boolean;
  className?: string;
  fullWidth?: boolean;
}

/** Workspace role picker (preview `select({ options: D.roles })`, HeroUI Select). */
export function RoleSelect({ value, roles, onChange, label, ariaLabel, description, isDisabled, className, fullWidth }: RoleSelectProps) {
  return (
    <Select
      aria-label={label ? undefined : ariaLabel}
      value={value}
      onChange={(key) => key && onChange(String(key))}
      isDisabled={isDisabled}
      className={className}
      fullWidth={fullWidth}
    >
      {label ? <Label>{label}</Label> : null}
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      {description ? <Description>{description}</Description> : null}
      <Select.Popover>
        <ListBox>
          {roles.map((role) => (
            <ListBox.Item key={role.name} id={role.name} textValue={role.label}>
              {role.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
