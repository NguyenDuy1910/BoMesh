"use client";

import { Dropdown, Label } from "@heroui/react";
import type { Selection } from "@heroui/react";
import { ChevronDown, Filter } from "lucide-react";
import clsx from "clsx";
import { fmtNum } from "@/lib/format";

export interface FilterOption {
  value: string;
  label: string;
  /** Matching items for this option (shown muted on the right). */
  count?: number;
}

interface FilterButtonBase {
  /** Facet name ("Type", "Status"). */
  label: string;
  options: readonly FilterOption[];
  className?: string;
}

/** One value or none (`""` = any). Preview `filterButton()`. */
export interface FilterButtonSingleProps extends FilterButtonBase {
  selectionMode?: "single";
  value: string;
  onChange: (value: string) => void;
}

/** Any number of values (empty = any). */
export interface FilterButtonMultipleProps extends FilterButtonBase {
  selectionMode: "multiple";
  value: readonly string[];
  onChange: (value: string[]) => void;
}

export type FilterButtonProps = FilterButtonSingleProps | FilterButtonMultipleProps;

const ANY = "__any__";

/**
 * Filter dropdown for a collection toolbar (preview `filterButton()` + `MENUS.filter`, HeroUI Dropdown).
 * Unset: outline pill with a filter icon. Set: accent-soft pill reading "Type: PDF" (or "Type · 2").
 * Single mode offers "Any {label}" first; options may carry counts.
 */
export function FilterButton(props: FilterButtonProps) {
  const { label, options, className } = props;
  const selected = props.selectionMode === "multiple" ? props.value : props.value ? [props.value] : [];
  const isSet = selected.length > 0;
  const first = options.find((o) => o.value === selected[0]);
  const summary = !isSet ? "" : selected.length === 1 ? `: ${first?.label ?? selected[0]}` : ` · ${selected.length}`;

  const onSelectionChange = (keys: Selection) => {
    const values = keys === "all" ? options.map((o) => o.value) : [...keys].map(String);
    if (props.selectionMode === "multiple") props.onChange(values.filter((v) => v !== ANY));
    else props.onChange(values[0] && values[0] !== ANY ? values[0] : "");
  };

  return (
    <Dropdown>
      <Dropdown.Trigger className={clsx("filter-button", isSet && "is-set", className)} aria-label={isSet ? undefined : `Filter by ${label.toLowerCase()}`}>
        {isSet ? null : <Filter className="i" aria-hidden />}
        {label}
        {summary}
        <ChevronDown className="i" aria-hidden />
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom start">
        <Dropdown.Menu
          aria-label={label}
          selectionMode={props.selectionMode === "multiple" ? "multiple" : "single"}
          selectedKeys={props.selectionMode === "multiple" ? selected : [selected[0] ?? ANY]}
          disallowEmptySelection={props.selectionMode !== "multiple"}
          onSelectionChange={onSelectionChange}
        >
          {props.selectionMode === "multiple" ? null : (
            <Dropdown.Item id={ANY} textValue={`Any ${label.toLowerCase()}`}>
              <Label>{`Any ${label.toLowerCase()}`}</Label>
              <Dropdown.ItemIndicator className="filter-menu__check" />
            </Dropdown.Item>
          )}
          {options.map((option) => (
            <Dropdown.Item key={option.value} id={option.value} textValue={option.label}>
              <Label>{option.label}</Label>
              {option.count != null ? <span className="filter-menu__count">{fmtNum(option.count)}</span> : null}
              <Dropdown.ItemIndicator className="filter-menu__check" />
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
