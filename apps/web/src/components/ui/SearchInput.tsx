"use client";

import { SearchField } from "@heroui/react";
import clsx from "clsx";

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Placeholder, also the accessible name unless `label` is given (default "Search"). */
  placeholder?: string;
  /** Accessible name when it differs from the placeholder. */
  label?: string;
  /** Enter pressed. */
  onSubmit?: (value: string) => void;
  /** `sm` (32 px, collection toolbars — default) or `md` (36 px). */
  size?: "sm" | "md";
  /** Stretch instead of the 320 px toolbar width. */
  fullWidth?: boolean;
  autoFocus?: boolean;
  className?: string;
}

/**
 * Collection search (preview `searchField()`, HeroUI SearchField): search icon, clear button,
 * Escape clears. Pairs with `FilterButton`s in a `.toolbar` row.
 */
export function SearchInput({ value, onChange, placeholder = "Search", label, onSubmit, size = "sm", fullWidth, autoFocus, className }: SearchInputProps) {
  return (
    <SearchField
      aria-label={label ?? placeholder}
      value={value}
      onChange={onChange}
      onSubmit={onSubmit}
      autoFocus={autoFocus}
      fullWidth={fullWidth}
      className={clsx("search-input", size === "sm" && "search-input--sm", fullWidth && "search-input--full", className)}
    >
      <SearchField.Group>
        <SearchField.SearchIcon />
        <SearchField.Input placeholder={placeholder} autoComplete="off" />
        <SearchField.ClearButton aria-label="Clear search" />
      </SearchField.Group>
    </SearchField>
  );
}
