"use client";

import { Search, X } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";

import { type ControlSize, ui } from "@/components/ui/design-system";
import { cn } from "@/lib/cn";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  size?: Exclude<ControlSize, "lg">;
  /** Delay before `onChange` fires while typing. Clearing is immediate. */
  debounceMs?: number;
  autoFocus?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
}

/**
 * A search field: leading magnifier, Escape or the clear button empties it.
 * Typing is debounced so a list filters once the user pauses.
 */
export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  ariaLabel = "Search",
  className,
  size = "md",
  debounceMs = 250,
  autoFocus = false,
  inputRef,
}: SearchInputProps) {
  const [draft, setDraft] = useState(value);
  // Only text the person typed is ever emitted. When `value` changes from
  // outside (Clear filters, navigation), the pending debounce is dropped so a
  // stale draft can never be written back over the new value.
  const typed = useRef(false);

  useEffect(() => {
    typed.current = false;
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (!typed.current) return;
    const timer = setTimeout(() => {
      typed.current = false;
      if (draft !== value) onChange(draft);
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [debounceMs, draft, onChange, value]);

  const clear = () => {
    typed.current = false;
    setDraft("");
    onChange("");
  };

  return (
    <div className={cn("relative flex items-center", className)}>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-2.75 size-4 text-text-tertiary"
      />
      <input
        aria-label={ariaLabel}
        autoComplete="off"
        autoFocus={autoFocus}
        className={cn(ui.control, ui.controlSize[size], "pl-8.5 [&::-webkit-search-cancel-button]:hidden", draft && "pr-9")}
        name="search"
        onChange={(event) => {
          typed.current = true;
          setDraft(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !draft) return;
          event.preventDefault();
          event.stopPropagation();
          clear();
        }}
        placeholder={placeholder}
        ref={inputRef}
        spellCheck={false}
        type="search"
        value={draft}
      />
      {draft && (
        <button
          aria-label="Clear search"
          className={cn(ui.iconButton, "absolute right-1 size-7 rounded-sm [&_svg]:size-3.5")}
          onClick={clear}
          type="button"
        >
          <X aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
