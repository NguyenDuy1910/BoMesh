"use client";

import { Dropdown, Header, Label, Separator } from "@heroui/react";
import { Check, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface MenuEntry {
  id: string;
  label: string;
  icon?: LucideIcon;
  danger?: boolean;
  /** Radio-like current choice (role menus). */
  checked?: boolean;
  run: () => void;
}
export type MenuNode = MenuEntry | { sep: string } | { section: string; items: MenuEntry[] };

export interface MenuProps {
  /** Accessible name of the menu. */
  label: string;
  /** The trigger: a HeroUI Button. */
  children: ReactNode;
  nodes: readonly MenuNode[];
  placement?: "bottom end" | "bottom start";
}

/** Dropdown menu for the preview's `MENUS[...]` (entries, separators, titled sections). */
export function Menu({ label, children, nodes, placement = "bottom end" }: MenuProps) {
  const entries = new Map<string, MenuEntry>();
  for (const n of nodes) {
    if ("run" in n) entries.set(n.id, n);
    if ("section" in n) for (const e of n.items) entries.set(e.id, e);
  }
  const item = (e: MenuEntry) => (
    <Dropdown.Item key={e.id} id={e.id} textValue={e.label} variant={e.danger ? "danger" : undefined}>
      {e.icon ? <e.icon className="i" aria-hidden /> : null}
      <Label>{e.label}</Label>
      {e.checked ? <Check className="i i-sm" aria-label="Current" style={{ marginLeft: "auto" }} /> : null}
    </Dropdown.Item>
  );
  return (
    <Dropdown>
      {children}
      <Dropdown.Popover placement={placement}>
        <Dropdown.Menu aria-label={label} onAction={(key) => entries.get(String(key))?.run()}>
          {nodes.map((n) =>
            "sep" in n ? (
              <Separator key={`sep-${n.sep}`} />
            ) : "section" in n ? (
              <Dropdown.Section key={`section-${n.section}`}>
                <Header>{n.section}</Header>
                {n.items.map(item)}
              </Dropdown.Section>
            ) : (
              item(n)
            ),
          )}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
