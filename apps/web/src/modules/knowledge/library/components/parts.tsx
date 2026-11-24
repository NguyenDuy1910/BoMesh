"use client";

import { Button, Dropdown, Header, Label, type Selection } from "@heroui/react";
import { ArrowUpDown } from "lucide-react";

/** Sort dropdown (preview ghost "sort" button + `MENUS[…-sort]` with a "Sort by" section). */
export function SortMenu<V extends string>({ value, options, onChange }: { value: V; options: Readonly<Record<V, string>>; onChange: (value: V) => void }) {
  const select = (keys: Selection) => {
    if (keys === "all") return;
    const next = [...keys][0];
    if (next != null) onChange(String(next) as V);
  };
  return (
    <Dropdown>
      <Button size="sm" variant="ghost" aria-label={`Sắp xếp: ${options[value]}`}>
        <ArrowUpDown className="i" aria-hidden />
        {options[value]}
      </Button>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label="Sắp xếp theo" selectionMode="single" selectedKeys={[value]} disallowEmptySelection onSelectionChange={select}>
          <Dropdown.Section>
            <Header>Sắp xếp theo</Header>
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

/** Search, sort, filters and bulk selection appear once a list holds this many items (preview core `TOOLS_MIN`). */
export const TOOLS_MIN = 7;

/** A list's tools show when it is long enough to need them, or while one is in use (preview `longOr`). */
export const needsTools = (count: number, inUse: unknown) => count >= TOOLS_MIN || !!inUse;

/** How long an Undo toast stays (Kit toast default with an action). */
export const UNDO_WINDOW_MS = 6500;
