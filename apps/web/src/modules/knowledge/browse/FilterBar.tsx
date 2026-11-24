"use client";

import { Button, Checkbox, Drawer, Popover, Pressable, Radio, RadioGroup } from "@heroui/react";
import clsx from "clsx";
import { ChevronDown, SlidersHorizontal, X, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { fmtNum, plural } from "@/lib/format";
import { useMessages } from "@/lib/i18n";

import { INLINE_FACETS, type BrowseFacetDef, type BrowseFacetId, type BrowseParams } from "./catalog";
import type { BrowseOption } from "./useCatalog";

const FACET_TOP = 6;

type Options = Partial<Record<BrowseFacetId, BrowseOption[]>>;

interface FacetProps {
  p: BrowseParams;
  options: Options;
  onApply: (next: BrowseParams) => void;
}

function OptionLabel({ option }: { option: BrowseOption }) {
  return (
    <>
      <span className="cat-opt__label" translate={option.ui ? undefined : "no"}>
        {option.label}
      </span>
      {option.count !== null ? <span className="cat-opt__n">{fmtNum(option.count)}</span> : null}
    </>
  );
}

function OptionBox({ option, onToggle }: { option: BrowseOption; onToggle: () => void }) {
  return (
    <div className={clsx("cat-opt", option.count === 0 && "is-zero")}>
      <Checkbox isSelected={option.on} onChange={onToggle} aria-label={option.label} className="checkbox">
        <Checkbox.Content className="cat-opt__content">
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
          <OptionLabel option={option} />
        </Checkbox.Content>
      </Checkbox>
    </div>
  );
}

/** One facet's choices (preview `facetBody`): checkboxes with live counts (the first six, then Show all), or the Updated radio list. */
function FacetBody({ facet: f, p, options, onApply }: FacetProps & { facet: BrowseFacetDef }) {
  const [more, setMore] = useState(false);
  const name = useMessages().knowledge.browse.facets[f.id];
  const opts = options[f.id] ?? [];
  if (f.single) {
    const on = opts.find((o) => o.on)?.value ?? "";
    const rows: BrowseOption[] = [{ value: "", label: "Mọi lúc", ui: true, count: null, on: !on }, ...opts];
    return (
      <RadioGroup aria-label={name} value={on || "any"} onChange={(v) => onApply({ ...p, filters: { ...p.filters, [f.id]: v === "any" ? [] : [v] } })}>
        {rows.map((o) => (
          <Radio key={o.value || "any"} value={o.value || "any"} className={clsx("cat-opt", o.count === 0 && "is-zero")}>
            <Radio.Content className="cat-radio cat-opt__content">
              <Radio.Control>
                <Radio.Indicator />
              </Radio.Control>
              <OptionLabel option={o} />
            </Radio.Content>
          </Radio>
        ))}
      </RadioGroup>
    );
  }
  if (!opts.length) return <p className="cat-none">Chưa có gì để lọc ở đây.</p>;
  const toggle = (v: string) => {
    const now = p.filters[f.id] ?? [];
    onApply({ ...p, filters: { ...p.filters, [f.id]: now.includes(v) ? now.filter((x) => x !== v) : [...now, v] } });
  };
  const shown = more ? opts : opts.filter((o, i) => i < FACET_TOP || o.on);
  return (
    <>
      {shown.map((o) => (
        <OptionBox key={o.value} option={o} onToggle={() => toggle(o.value)} />
      ))}
      {opts.length > FACET_TOP ? (
        <button type="button" className="cat-more" onClick={() => setMore(!more)}>
          {more ? "Thu gọn" : `Hiện tất cả ${fmtNum(opts.length)}`}
        </button>
      ) : null}
    </>
  );
}

function FacetGroup(props: FacetProps & { facet: BrowseFacetDef }) {
  const name = useMessages().knowledge.browse.facets[props.facet.id];
  return (
    <section className="cat-group" aria-label={name}>
      <h3 className="cat-group__title">{name}</h3>
      <div className="cat-opts">
        <FacetBody {...props} />
      </div>
    </section>
  );
}

const nOn = (p: BrowseParams, list: readonly BrowseFacetDef[]) => list.reduce((n, f) => n + (p.filters[f.id]?.length ?? 0), 0);
const clearFacets = (p: BrowseParams, list: readonly BrowseFacetDef[]): BrowseParams => ({ ...p, filters: { ...p.filters, ...Object.fromEntries(list.map((f) => [f.id, []])) } });

/** The live result count in a popover's footer, so each tick's effect shows without closing it. */
const LiveCount = ({ total }: { total: number }) => (
  <span className="cat-pop__n" role="status">
    {plural(total, "document")}
  </span>
);

/** A filter button (preview `popBtn`) opening its light popover of choices; the popover stays open while ticking. */
function FilterPopover({ label, title, set, className, icon: Icon, footer, children }: { label: ReactNode; title: string; set: boolean; className?: string; icon?: LucideIcon; footer: ReactNode; children: ReactNode }) {
  return (
    <Popover>
      <Pressable>
        <button type="button" className={clsx("filter-button", set && "is-set", className)}>
          {Icon ? <Icon className="i" aria-hidden /> : null}
          <span className="truncate">{label}</span>
          <ChevronDown className="i" aria-hidden />
        </button>
      </Pressable>
      <Popover.Content placement="bottom start" className="cat-popover">
        <Popover.Dialog>
          <div className="popover__header">
            <Popover.Heading className="popover__title">{title}</Popover.Heading>
            <Button slot="close" isIconOnly size="sm" variant="ghost" aria-label="Đóng" className="popover__close">
              <X aria-hidden />
            </Button>
          </div>
          <div className="popover__body">{children}</div>
          <div className="popover__footer">{footer}</div>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

export interface FilterBarProps extends FacetProps {
  /** Filter facets (everything but topic, which the pills own). */
  facets: readonly BrowseFacetDef[];
  total: number;
  /** The search field (left start): one more way to narrow the same results. */
  search: ReactNode;
  /** Views menu, sort and layout (right end). */
  end: ReactNode;
}

/**
 * The bar right above the results (preview `filterBar`): the search field, then Type · Updated · Trust · Owner as
 * their own buttons, the facets that can still narrow under More filters; on phones one Filters button opens them
 * all as a bottom sheet.
 */
export function FilterBar({ p, options, onApply, facets, total, search, end }: FilterBarProps) {
  const [sheet, setSheet] = useState(false);
  const names = useMessages().knowledge.browse.facets;
  const inline = INLINE_FACETS.map((id) => facets.find((f) => f.id === id)).filter((f): f is BrowseFacetDef => !!f);
  /** More filters: the remaining facets that can still narrow the set (two or more values) or hold a selection. */
  const more = facets.filter((f) => !INLINE_FACETS.includes(f.id) && ((options[f.id]?.length ?? 0) > 1 || (p.filters[f.id]?.length ?? 0) > 0));
  const all = [...inline, ...more];
  const nMore = nOn(p, more);
  const nAll = nOn(p, facets);
  const clear = (list: readonly BrowseFacetDef[]) =>
    nOn(p, list) ? (
      <Button variant="ghost" size="sm" onPress={() => onApply(clearFacets(p, list))}>
        Xóa
      </Button>
    ) : null;
  const props = { p, options, onApply };

  return (
    <div className="cat-bar" role="group" aria-label="Tìm, lọc và sắp xếp">
      {search}
      <div className="cat-bar__filters">
        {inline.map((f) => {
          const on = p.filters[f.id] ?? [];
          const name = names[f.id];
          const one = on.length === 1 ? options[f.id]?.find((o) => o.value === on[0]) : undefined;
          // Separate nodes so the legacy localizer touches the value only when it's UI vocabulary.
          const text =
            on.length === 1 ? (
              <>
                {name}
                {": "}
                <span translate={one?.ui ? undefined : "no"}>{one?.label ?? on[0]}</span>
              </>
            ) : on.length ? (
              `${name} · ${on.length}`
            ) : (
              name
            );
          return (
            <FilterPopover
              key={f.id}
              label={text}
              title={name}
              set={on.length > 0}
              className={`cat-fb cat-fb--${f.id}`}
              footer={
                <>
                  {clear([f])}
                  <LiveCount total={total} />
                </>
              }
            >
              <div className="cat-pop">
                <FacetBody facet={f} {...props} />
              </div>
            </FilterPopover>
          );
        })}
        {more.length ? (
          <FilterPopover
            label={nMore ? `Bộ lọc khác · ${nMore}` : "Bộ lọc khác"}
            title="Bộ lọc khác"
            set={nMore > 0}
            className="cat-fb"
            footer={
              <>
                {clear(more)}
                <LiveCount total={total} />
              </>
            }
          >
            <div className="cat-pop cat-pop--groups">
              {more.map((f) => (
                <FacetGroup key={f.id} facet={f} {...props} />
              ))}
            </div>
          </FilterPopover>
        ) : null}
      </div>
      <button type="button" className={clsx("filter-button cat-fb-all", nAll > 0 && "is-set")} aria-haspopup="dialog" onClick={() => setSheet(true)}>
        <SlidersHorizontal className="i" aria-hidden />
        <span className="truncate">{nAll ? `Bộ lọc · ${nAll}` : "Bộ lọc"}</span>
        <ChevronDown className="i" aria-hidden />
      </button>
      <div className="cat-bar__end">{end}</div>

      <Drawer.Backdrop isOpen={sheet} onOpenChange={setSheet}>
        <Drawer.Content placement="bottom" className="cat-sheet">
          <Drawer.Dialog aria-label="Bộ lọc">
            <Drawer.Header>
              <Drawer.Heading>Bộ lọc</Drawer.Heading>
            </Drawer.Header>
            <Drawer.Body>
              <div className="cat-pop cat-pop--groups">
                {all.map((f) => (
                  <FacetGroup key={f.id} facet={f} {...props} />
                ))}
              </div>
            </Drawer.Body>
            <Drawer.Footer>
              <LiveCount total={total} />
              {clear(all)}
              <Button slot="close" variant="primary" className="popover__done">
                Xong
              </Button>
            </Drawer.Footer>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </div>
  );
}
