"use client";

import { Tabs } from "@heroui/react";
import type { Key } from "@heroui/react";
import type { LucideIcon } from "lucide-react";
import clsx from "clsx";
import { fmtNum } from "@/lib/format";

export interface SectionTab {
  id: string;
  label: string;
  /** Count after the label (muted number; an accent badge when `alert`). Hidden when null/undefined. */
  count?: number | null;
  /** Show the count as an accent badge (something waits on the caller). */
  alert?: boolean;
  icon?: LucideIcon;
  /** Explicit link; defaults to `${base}?tab=${id}` when `base` is given. */
  href?: string;
}

export interface SectionTabsProps {
  items: readonly SectionTab[];
  /** Id of the current tab. */
  active: string;
  /** Path the `?tab=` links are built on (deep-linkable sections). */
  base?: string;
  /** Button tabs instead of links (in-content filters that don't touch the URL). */
  onChange?: (id: string) => void;
  /** `secondary` (underline) for page sections — the default; `primary` (pill) for in-content filters. */
  variant?: "primary" | "secondary";
  /** Accessible name (default "Sections"). */
  label?: string;
  className?: string;
}

/**
 * Section tabs (preview `tabs(items, active, base, { variant })`, HeroUI Tabs).
 * Tabs are links by default so every section is deep-linkable (`?tab=`); pass `onChange` for button tabs.
 */
export function SectionTabs({ items, active, base, onChange, variant = "secondary", label = "Sections", className }: SectionTabsProps) {
  return (
    <Tabs
      variant={variant}
      selectedKey={active}
      onSelectionChange={onChange ? (key: Key) => onChange(String(key)) : undefined}
      className={clsx("section-tabs", `section-tabs--${variant}`, className)}
    >
      <Tabs.ListContainer>
        <Tabs.List aria-label={label}>
          {items.map((tab) => {
            const Icon = tab.icon;
            const href = onChange ? undefined : (tab.href ?? (base ? `${base}?tab=${tab.id}` : undefined));
            return (
              <Tabs.Tab key={tab.id} id={tab.id} href={href}>
                {Icon ? <Icon className="i i-sm" aria-hidden /> : null}
                {tab.label}
                {tab.count != null ? <span className={tab.alert ? "tabs__badge" : "tabs__count"}>{fmtNum(tab.count)}</span> : null}
                <Tabs.Indicator />
              </Tabs.Tab>
            );
          })}
        </Tabs.List>
      </Tabs.ListContainer>
    </Tabs>
  );
}
