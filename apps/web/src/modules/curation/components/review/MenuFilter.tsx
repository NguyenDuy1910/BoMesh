"use client";

import { Dropdown, Header, Label } from "@heroui/react";
import clsx from "clsx";
import { Check, ChevronDown, Filter, X } from "lucide-react";

export interface MenuFilterSection {
  title: string;
  value: string;
  /** `data`: the label is workspace data (a collection's or topic's name), left as written by the localizer; static
   *  choices like "All collections" are translated. */
  options: readonly { value: string; label: string; meta?: string; data?: boolean }[];
  onChange: (value: string) => void;
}

/**
 * One Filter menu for a short list (preview `MENUS['cur-qfilter']`): a section per facet, the current choice
 * checked, then Clear filters. The trigger reads what's on ("Flagged · Payments") or "Filter".
 */
export function MenuFilter({ label, sections, onClear }: { label: string; sections: readonly MenuFilterSection[]; onClear?: () => void }) {
  const set = !!label;
  const run = (key: string) => {
    if (key === "clear") return onClear?.();
    const [i, ...rest] = key.split(":");
    sections[Number(i)]?.onChange(rest.join(":"));
  };
  return (
    <Dropdown>
      <Dropdown.Trigger className={clsx("filter-button", set && "is-set")}>
        {set ? null : <Filter className="i" aria-hidden />}
        <span className="truncate">{label || "Lọc"}</span>
        <ChevronDown className="i" aria-hidden />
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom start">
        <Dropdown.Menu aria-label="Lọc" onAction={(key) => run(String(key))}>
          <>
            {sections.map((s, i) => (
              <Dropdown.Section key={s.title}>
                <Header>{s.title}</Header>
                {s.options.map((o) => (
                  <Dropdown.Item key={`${i}:${o.value}`} id={`${i}:${o.value}`} textValue={o.label}>
                    <Label translate={o.data ? "no" : undefined}>{o.label}</Label>
                    {o.meta ? <span className="filter-menu__count">{o.meta}</span> : null}
                    {s.value === o.value ? <Check className="i filter-menu__check" aria-label="Đã chọn" /> : null}
                  </Dropdown.Item>
                ))}
              </Dropdown.Section>
            ))}
            {onClear ? (
              <Dropdown.Section>
                <Dropdown.Item id="clear" textValue="Xóa bộ lọc">
                  <X className="i" aria-hidden />
                  <Label>Xóa bộ lọc</Label>
                </Dropdown.Item>
              </Dropdown.Section>
            ) : null}
          </>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
