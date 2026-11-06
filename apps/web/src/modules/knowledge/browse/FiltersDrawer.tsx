"use client";

import { Button, Checkbox, Disclosure, Drawer, Radio, RadioGroup } from "@heroui/react";
import clsx from "clsx";
import { ChevronDown, ChevronRight, ChevronUp, Filter } from "lucide-react";
import NextLink from "next/link";
import { useState } from "react";

import { fmtNum, plural } from "@/lib/format";
import { resourceId } from "@/lib/api/client";

import type { SavedSearch, Topic } from "../api";
import { topicTree } from "../model";
import { activeCount, savedSearchParams, setKey, type BrowseFacetDef, type BrowseFacetId, type BrowseParams } from "./catalog";
import type { BrowseOption } from "./useCatalog";

const FACET_TOP = 6;
/** Facet groups open on first visit; the rest open when they hold a selection or the user opens them. */
const OPEN_BY_DEFAULT: readonly BrowseFacetId[] = ["topic", "kind", "trust"];

/** Folds, "Show all" and topic twists survive closing the drawer (preview `ui('cat')`). */
export interface DrawerUi {
  fold: Partial<Record<BrowseFacetId, boolean>>;
  more: Partial<Record<BrowseFacetId, boolean>>;
  open: Record<string, boolean>;
}

export interface FiltersDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  params: BrowseParams;
  facets: readonly BrowseFacetDef[];
  options: Partial<Record<BrowseFacetId, BrowseOption[]>>;
  total: number;
  savedCount: number;
  views: readonly SavedSearch[];
  topics: readonly Topic[];
  onApply: (next: BrowseParams) => void;
  onClear: () => void;
}

function OptionLabel({ option }: { option: BrowseOption }) {
  return (
    <>
      <span className="cat-opt__label" translate="no">
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

/** Filters drawer (preview `DR['cat-filters']`): saved views, "Only documents I saved", then every facet with disjunctive counts. */
export function FiltersDrawer({ isOpen, onClose, params: p, facets, options, total, savedCount, views, topics, onApply, onClear }: FiltersDrawerProps) {
  const [ui, setUi] = useState<DrawerUi>({ fold: {}, more: {}, open: {} });
  const n = activeCount(p);
  const key = setKey(p);

  const toggle = (f: BrowseFacetDef, v: string) => {
    const now = p.filters[f.id] ?? [];
    const next = f.single ? (!v || now.includes(v) ? [] : [v]) : now.includes(v) ? now.filter((x) => x !== v) : [...now, v];
    onApply({ ...p, filters: { ...p.filters, [f.id]: next } });
  };

  const checkOpts = (f: BrowseFacetDef, opts: BrowseOption[]) => {
    const more = ui.more[f.id];
    const shown = more ? opts : opts.filter((o, i) => i < FACET_TOP || o.on);
    return (
      <>
        {shown.map((o) => (
          <OptionBox key={o.value} option={o} onToggle={() => toggle(f, o.value)} />
        ))}
        {opts.length > FACET_TOP ? (
          <button type="button" className="cat-more" onClick={() => setUi({ ...ui, more: { ...ui.more, [f.id]: !more } })}>
            {more ? "Show less" : `Show all ${fmtNum(opts.length)}`}
          </button>
        ) : null}
      </>
    );
  };

  const radioOpts = (f: BrowseFacetDef, opts: BrowseOption[]) => {
    const on = opts.find((o) => o.on)?.value ?? "";
    const rows: BrowseOption[] = [{ value: "", label: "Any time", count: null, on: !on }, ...opts];
    return (
      <RadioGroup aria-label={f.label} value={on || "any"} onChange={(v) => onApply({ ...p, filters: { ...p.filters, [f.id]: v === "any" ? [] : [v] } })}>
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
  };

  /** Topic facet as a tree: domain → topics. Domains open when they (or a topic) are selected. */
  const topicOpts = (f: BrowseFacetDef, opts: BrowseOption[]) => {
    const by = new Map(opts.map((o) => [o.value, o]));
    return topicTree(topics).map((dm) => {
      const id = resourceId(dm.name);
      const kids = dm.children.map((t) => by.get(resourceId(t.name))).filter((x): x is BrowseOption => !!x);
      const d = by.get(id) ?? (kids.length ? { value: id, label: dm.displayName ?? "", count: 0, on: false } : null);
      if (!d) return null;
      const open = ui.open[id] ?? (d.on || kids.some((k) => k.on));
      const name = dm.displayName ?? "";
      return (
        <div className="cat-tree" key={id}>
          <div className="cat-tree__row">
            {kids.length ? (
              <button
                type="button"
                className="cat-twist"
                aria-expanded={open}
                aria-label={`${open ? "Hide" : "Show"} topics in ${name}`}
                onClick={() => setUi({ ...ui, open: { ...ui.open, [id]: !open } })}
              >
                {open ? <ChevronDown className="i i-sm" aria-hidden /> : <ChevronRight className="i i-sm" aria-hidden />}
              </button>
            ) : (
              <span className="cat-twist" aria-hidden />
            )}
            <OptionBox option={d} onToggle={() => toggle(f, d.value)} />
          </div>
          {open && kids.length ? (
            <div className="cat-tree__kids">
              {kids.map((k) => (
                <OptionBox key={k.value} option={k} onToggle={() => toggle(f, k.value)} />
              ))}
            </div>
          ) : null}
        </div>
      );
    });
  };

  const apply = (v: SavedSearch) => {
    onApply(savedSearchParams(v, topics));
    onClose();
  };

  return (
    <Drawer.Backdrop isOpen={isOpen} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Content placement="right">
        <Drawer.Dialog aria-label="Filters">
          <Drawer.CloseTrigger aria-label="Close" />
          <Drawer.Header>
            <Drawer.Heading>Filters</Drawer.Heading>
            <p className="drawer__description">{n ? `${plural(n, "filter")} applied` : "Narrow the documents by any detail"}</p>
          </Drawer.Header>
          <Drawer.Body>
            <div className="cat-rail">
              <section className="cat-group">
                <div className="cat-group__head">
                  <h3 className="cat-group__title">Saved views</h3>
                  {views.length ? (
                    <NextLink className="link-button" href="/knowledge/library?tab=views" onClick={onClose}>
                      Manage
                    </NextLink>
                  ) : null}
                </div>
                {views.length ? (
                  <div className="cat-views">
                    {views.map((v) => {
                      const on = setKey(savedSearchParams(v, topics)) === key;
                      return (
                        <button type="button" key={v.name} className={clsx("cat-view", on && "is-on")} aria-current={on || undefined} onClick={() => apply(v)}>
                          <Filter className="i i-sm" aria-hidden />
                          <span className="truncate" translate="no">
                            {v.displayName}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="cat-none">Save a search or a set of filters to come back to it.</p>
                )}
                <OptionBox
                  option={{ value: "saved", label: "Only documents I saved", count: savedCount, on: !!p.saved }}
                  onToggle={() => onApply({ ...p, saved: !p.saved })}
                />
              </section>
              {facets.map((f) => {
                const opts = options[f.id] ?? [];
                const nOn = p.filters[f.id]?.length ?? 0;
                if (!opts.length && f.id !== "upd") return null;
                const open = ui.fold[f.id] ?? (OPEN_BY_DEFAULT.includes(f.id) || nOn > 0);
                return (
                  <Disclosure
                    key={f.id}
                    className="cat-group"
                    isExpanded={open}
                    onExpandedChange={(x) => setUi({ ...ui, fold: { ...ui.fold, [f.id]: x } })}
                  >
                    <Disclosure.Heading>
                      <Button slot="trigger" variant="ghost" className="cat-group__toggle">
                        <span className="cat-group__title">{f.label}</span>
                        {nOn ? <span className="badge badge--accent">{nOn}</span> : null}
                        <span className="grow" />
                        {open ? <ChevronUp className="i i-sm" aria-hidden /> : <ChevronDown className="i i-sm" aria-hidden />}
                      </Button>
                    </Disclosure.Heading>
                    <Disclosure.Content>
                      <div className="cat-opts">{f.id === "topic" ? topicOpts(f, opts) : f.single ? radioOpts(f, opts) : checkOpts(f, opts)}</div>
                    </Disclosure.Content>
                  </Disclosure>
                );
              })}
            </div>
          </Drawer.Body>
          <Drawer.Footer>
            {n ? (
              <div className="drawer__footer-start row gap-8">
                <Button variant="ghost" onPress={onClear}>
                  Clear all
                </Button>
              </div>
            ) : null}
            <Button variant="primary" onPress={onClose}>
              Show {plural(total, "document")}
            </Button>
          </Drawer.Footer>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
