"use client";

import { useId, useRef } from "react";

import { cn } from "@/lib/cn";
import { useRouteState } from "@/lib/hooks/useRouteState";

export interface TabItem<T extends string = string> {
  id: T;
  label: string;
  /** A count someone can act on; shown beside the label when given. */
  count?: number;
}

export interface TabsProps<T extends string = string> {
  tabs: readonly TabItem<T>[];
  activeTab: T;
  onChange: (tabId: T) => void;
  ariaLabel: string;
  /** Ids become `${idBase}-${tab}` / `${idBase}-${tab}-panel`; pair with `TabPanel`. */
  idBase?: string;
  /** `sm` (32px) for a tab row inside a panel; `md` (40px) for page sections. */
  size?: "sm" | "md";
  className?: string;
}

/**
 * Page sections. Bind the active tab to `?tab=` with `useTabParam` so every
 * tab is deep-linkable; a tab row inside a dialog may keep local state.
 *
 * Roving focus: one Tab stop for the row; arrows, Home and End move focus,
 * Enter or Space selects — so arrowing past a tab never navigates to it.
 */
export function Tabs<T extends string>({
  tabs,
  activeTab,
  onChange,
  ariaLabel,
  idBase,
  size = "md",
  className,
}: TabsProps<T>) {
  const fallbackId = useId();
  const base = idBase ?? fallbackId;
  const listRef = useRef<HTMLDivElement | null>(null);

  const focusTab = (index: number) => {
    const target = (index + tabs.length) % tabs.length;
    listRef.current?.querySelectorAll<HTMLButtonElement>("[role='tab']")[target]?.focus();
  };

  return (
    <div
      aria-label={ariaLabel}
      className={cn(
        "flex gap-[22px] overflow-x-auto border-b border-[var(--border-subtle)] [scrollbar-width:none]",
        className,
      )}
      ref={listRef}
      role="tablist"
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === activeTab;
        return (
          <button
            aria-controls={idBase ? `${base}-${tab.id}-panel` : undefined}
            aria-selected={selected}
            className={cn(
              "-mb-px inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 font-medium",
              "transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
              "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent-primary)]",
              size === "sm" ? "h-8 text-[length:var(--text-size-meta)]" : "h-10 text-[length:var(--text-size-body)]",
              selected
                ? "border-[var(--text-primary)] text-[var(--text-primary)]"
                : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
            )}
            id={`${base}-${tab.id}`}
            key={tab.id}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              const moves: Record<string, number> = {
                ArrowLeft: index - 1,
                ArrowRight: index + 1,
                Home: 0,
                End: tabs.length - 1,
              };
              if (event.key in moves) {
                event.preventDefault();
                focusTab(moves[event.key]);
              }
            }}
            role="tab"
            tabIndex={selected ? 0 : -1}
            type="button"
          >
            {tab.label}
            {tab.count !== undefined && (
              <span
                className={cn(
                  "rounded-[var(--radius-full)] bg-[var(--surface-inset)] px-[7px] py-px text-[length:var(--text-size-caption)] font-medium",
                  selected ? "text-[var(--text-secondary)]" : "text-[var(--text-tertiary)]",
                )}
              >
                {tab.count.toLocaleString()}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The panel a `Tabs` row with the same `idBase` controls. */
export function TabPanel({
  idBase,
  tab,
  className,
  children,
}: {
  idBase: string;
  tab: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div aria-labelledby={`${idBase}-${tab}`} className={className} id={`${idBase}-${tab}-panel`} role="tabpanel">
      {children}
    </div>
  );
}

/**
 * The active tab, read from and written to `?tab=`. Values outside `allowed`
 * (a stale link, a tab the caller may not see) fall back to `fallback`.
 */
export function useTabParam<T extends string>(allowed: readonly T[], fallback: T): [T, (tab: T) => void] {
  const [value, setValue] = useRouteState("tab", fallback);
  const tab = (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
  return [tab, setValue];
}
