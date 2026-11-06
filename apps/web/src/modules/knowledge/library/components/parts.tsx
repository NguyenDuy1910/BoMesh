"use client";

import { Button, Dropdown, Header, Label, type Selection } from "@heroui/react";
import { ArrowUpDown, X } from "lucide-react";
import type { ReactNode } from "react";

import { IconButton } from "@/components/ui/IconButton";

/** Sort dropdown (preview ghost "sort" button + `MENUS[…-sort]` with a "Sort by" section). */
export function SortMenu<V extends string>({ value, options, onChange }: { value: V; options: Readonly<Record<V, string>>; onChange: (value: V) => void }) {
  const select = (keys: Selection) => {
    if (keys === "all") return;
    const next = [...keys][0];
    if (next != null) onChange(String(next) as V);
  };
  return (
    <Dropdown>
      <Button size="sm" variant="ghost" aria-label={`Sort: ${options[value]}`}>
        <ArrowUpDown className="i" aria-hidden />
        {options[value]}
      </Button>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label="Sort by" selectionMode="single" selectedKeys={[value]} disallowEmptySelection onSelectionChange={select}>
          <Dropdown.Section>
            <Header>Sort by</Header>
            {(Object.keys(options) as V[]).map((key) => (
              <Dropdown.Item key={key} id={key} textValue={options[key]}>
                <Label>{options[key]}</Label>
                <Dropdown.ItemIndicator />
              </Dropdown.Item>
            ))}
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** Floating bar for the selected rows (preview `bulkBar`). */
export function BulkBar({ count, onClear, children }: { count: number; onClear: () => void; children: ReactNode }) {
  if (!count) return null;
  return (
    <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
      <span className="bulk-bar__count">{count} selected</span>
      {children}
      <IconButton icon={X} tip="Clear selection" size="sm" onPress={onClear} className="button--ghost" />
    </div>
  );
}

/** How long an Undo toast stays (Kit toast default with an action). */
export const UNDO_WINDOW_MS = 6500;
