"use client";

import { Check } from "lucide-react";

import { cn } from "@/lib/cn";
import { describeAccess } from "@/modules/workspace-control/capabilities";
import type { Group, Role } from "@/modules/workspace-control/directory";

/**
 * Choose the one role someone has in this workspace. Each choice says what
 * it allows, so nobody has to know what "Workspace Administrator" means.
 * Disabled roles are not offered, except the one already held.
 */
export function RolePicker({
  roles,
  value,
  onChange,
  disabled = false,
  name,
}: {
  roles: Role[];
  value: string;
  onChange: (roleId: string) => void;
  disabled?: boolean;
  name: string;
}) {
  const choices = roles
    .filter((role) => role.status === "active" || role.id === value)
    .sort((a, b) => a.permission_codes.length - b.permission_codes.length);

  return (
    <div className="grid gap-2" role="radiogroup">
      {choices.map((role) => {
        const selected = role.id === value;
        return (
          <label
            className={cn(
              "flex items-start gap-3 rounded-[var(--radius-md)] border px-3 py-2.5 transition-colors",
              disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer",
              selected
                ? "border-[var(--border-strong)] bg-[var(--surface-selected)]"
                : "border-[var(--border-subtle)] hover:bg-[var(--surface-hover)]",
            )}
            key={role.id}
          >
            <input
              checked={selected}
              className="mt-1 accent-[var(--accent-primary)]"
              disabled={disabled}
              name={name}
              onChange={() => onChange(role.id)}
              type="radio"
              value={role.id}
            />
            <span className="grid gap-0.5">
              <span className="text-[length:var(--text-size-ui)] font-medium text-[var(--text-primary)]">
                {role.display_name}
                {role.status !== "active" && <span className="font-normal text-[var(--text-tertiary)]"> · disabled</span>}
              </span>
              <span className="text-[length:var(--text-size-meta)] text-[var(--text-secondary)]">
                {describeAccess(role.permission_codes)}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** Put someone in any number of groups by tapping their names. */
export function GroupPicker({
  groups,
  value,
  onChange,
}: {
  groups: Group[];
  value: string[];
  onChange: (groupIds: string[]) => void;
}) {
  const active = groups.filter((group) => group.status === "active" || value.includes(group.id));
  if (!active.length) {
    return (
      <p className="text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">
        No groups yet. Create one in the Groups tab to give a whole team the same access.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      {active.map((group) => {
        const selected = value.includes(group.id);
        return (
          <button
            aria-pressed={selected}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[length:var(--text-size-meta)] font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]",
              selected
                ? "border-[var(--border-strong)] bg-[var(--surface-selected)] text-[var(--text-primary)]"
                : "border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]",
            )}
            key={group.id}
            onClick={() => onChange(selected ? value.filter((id) => id !== group.id) : [...value, group.id])}
            type="button"
          >
            {selected && <Check aria-hidden="true" size={12} />}
            {group.display_name}
          </button>
        );
      })}
    </div>
  );
}
