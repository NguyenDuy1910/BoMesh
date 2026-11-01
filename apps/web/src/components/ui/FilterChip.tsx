"use client";

import { ChevronDown, Plus } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Menu, MenuCheckboxItem, MenuRadioItem, MenuSeparator, type MenuTriggerProps } from "@/components/ui/Menu";
import { cn } from "@/lib/cn";

export interface FilterOption {
  value: string;
  label: string;
}

interface FilterChipBase {
  /** The dimension, in sentence case: "Status", "Type". */
  label: string;
  options: readonly FilterOption[];
  className?: string;
}

interface SingleFilterChipProps extends FilterChipBase {
  multiple?: false;
  /** `""` means any. */
  value: string;
  onChange: (value: string) => void;
}

interface MultiFilterChipProps extends FilterChipBase {
  multiple: true;
  /** Empty means any. */
  value: readonly string[];
  onChange: (value: string[]) => void;
}

export type FilterChipProps = SingleFilterChipProps | MultiFilterChipProps;

/**
 * A list filter. Unset it reads "+ Status" on a dashed outline; set, it shows
 * the choice — "Status: Failed" — on the accent tint, so a filtered list is
 * never mistaken for the whole list. The menu starts with "Any status".
 */
export function FilterChip(props: FilterChipProps) {
  const { label, options, className } = props;
  const selected = props.multiple ? props.value : props.value ? [props.value] : [];
  const labelOf = (value: string) => options.find((option) => option.value === value)?.label ?? value;
  const summary =
    selected.length === 0
      ? null
      : selected.length === 1
        ? labelOf(selected[0])
        : `${labelOf(selected[0])} +${selected.length - 1}`;
  const clear = () => (props.multiple ? props.onChange([]) : props.onChange(""));

  return (
    <Menu
      ariaLabel={`Filter by ${label.toLowerCase()}`}
      trigger={(trigger: MenuTriggerProps) => (
        <button
          {...trigger}
          className={cn(
            "inline-flex h-[var(--control-sm)] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] border px-2.5",
            "text-[13px] font-medium transition-colors duration-[var(--duration-fast)]",
            "focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
            summary
              ? "border-solid border-[var(--accent-primary)] bg-[var(--accent-soft)] text-[var(--text-accent)]"
              : "border-dashed border-[var(--border-strong)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
            className,
          )}
        >
          {!summary && <Plus aria-hidden="true" size={14} />}
          <span className="max-w-[220px] truncate">{summary ? `${label}: ${summary}` : label}</span>
          {summary && <ChevronDown aria-hidden="true" size={14} />}
        </button>
      )}
    >
      <MenuRadioItem checked={selected.length === 0} onSelect={clear}>
        {`Any ${label.toLowerCase()}`}
      </MenuRadioItem>
      <MenuSeparator />
      {props.multiple
        ? options.map((option) => (
            <MenuCheckboxItem
              checked={props.value.includes(option.value)}
              key={option.value}
              onCheckedChange={(checked) =>
                props.onChange(
                  checked
                    ? [...props.value, option.value]
                    : props.value.filter((value) => value !== option.value),
                )
              }
            >
              {option.label}
            </MenuCheckboxItem>
          ))
        : options.map((option) => (
            <MenuRadioItem checked={props.value === option.value} key={option.value} onSelect={() => props.onChange(option.value)}>
              {option.label}
            </MenuRadioItem>
          ))}
    </Menu>
  );
}

/**
 * "Clear filters", shown only while something narrows the list (search
 * included). Pair with the no-results state's own Clear filters button.
 */
export function ClearFilters({ active, onClear }: { active: boolean; onClear: () => void }) {
  if (!active) return null;
  return (
    <Button onClick={onClear} size="sm" variant="ghost">
      Clear filters
    </Button>
  );
}
