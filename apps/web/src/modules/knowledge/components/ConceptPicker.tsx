"use client";

import { ListBox, Select } from "@heroui/react";
import clsx from "clsx";
import { X } from "lucide-react";
import { useMemo, useState } from "react";

import { useLazyOptions } from "@/components/ui/useLazyOptions";

import {
  assignableConcepts,
  classSchemes,
  conceptLabel,
  conceptPathText,
  descendantsOf,
  narrowerOf,
  schemeByName,
  schemeLabel,
  schemeOfConcept,
  topConcepts,
  type Taxonomy,
} from "../taxonomy";
import { conceptToneProps } from "./ConceptTag";

export interface ConceptPickerProps {
  /** Chosen concept names. */
  value: readonly string[];
  onChange: (next: string[]) => void;
  taxonomy: Taxonomy;
  /** Limit to one scheme (name or ID); else every classification scheme, options prefixed with the scheme. */
  scheme?: string;
  /** Accessible name of the group. */
  label: string;
  /** Shown when nothing is chosen. */
  empty?: string;
  /** Also offer whole branches (“{top} · tất cả” adds every assignable concept under a top concept). */
  broad?: boolean;
  /** Show this many chips and a “+N nữa” toggle (0 = all). */
  limit?: number;
  /** Neutral chips (a setting, not the document's own metadata). */
  quiet?: boolean;
  /** Chosen concepts the classifier proposed and nobody confirmed yet: dashed, marked “Chờ duyệt”. */
  suggested?: readonly string[];
  isDisabled?: boolean;
}

/**
 * Concepts as removable chips beside an “Thêm…” select (preview `conceptPicker`, core/catalog.js): Contribute's details,
 * Edit details and the Process dialog. Offers assignable (published) concepts by their path.
 */
export function ConceptPicker({ value, onChange, taxonomy, scheme, label, empty = "", broad = false, limit = 0, quiet = false, suggested = [], isDisabled }: ConceptPickerProps) {
  const [expanded, setExpanded] = useState(false);
  const shown = limit && !expanded && value.length > limit + 1 ? value.slice(0, limit) : value;
  const one = scheme ? schemeByName(taxonomy, scheme) : undefined;
  const options = useMemo(() => {
    const schemes = scheme ? (one ? [one] : []) : classSchemes(taxonomy);
    return schemes.flatMap((s) => {
      const pre = scheme ? "" : `${schemeLabel(s)} · `;
      const assignable = assignableConcepts(taxonomy, s.name ?? "");
      const tops = broad
        ? topConcepts(taxonomy, s.name ?? "")
            .filter((t) => narrowerOf(taxonomy, t.name ?? "").length > 1 && !value.includes(t.name ?? ""))
            .map((t) => [`top:${t.name}`, `${pre}${conceptLabel(taxonomy, t.name)} · tất cả`] as const)
        : [];
      return [...tops, ...assignable.filter((c) => !value.includes(c.name ?? "")).map((c) => [c.name ?? "", pre + conceptPathText(taxonomy, c.name ?? "")] as const)];
    });
  }, [taxonomy, scheme, one, broad, value]);
  // The trigger never shows a choice, but a Select with no items refuses to open (and so never asks for its options):
  // keep the first option built while closed.
  const [offered, onOpenChange] = useLazyOptions(options, (o) => o === options[0]);
  const add = (key: string) => {
    let picked = [key];
    if (key.startsWith("top:")) {
      const top = key.slice(4);
      const ok = new Set(assignableConcepts(taxonomy, schemeOfConcept(top)).map((c) => c.name));
      picked = [top, ...descendantsOf(taxonomy, top)].filter((n) => ok.has(n));
    }
    onChange([...new Set([...value, ...picked])]);
  };
  const addLabel = one ? `Thêm ${schemeLabel(one)}` : "Thêm khái niệm";

  return (
    <div className={clsx("concept-pick", quiet && "concept-pick--quiet")} role="group" aria-label={label}>
      {shown.length ? (
        shown.map((c) => {
          const name = conceptLabel(taxonomy, c);
          const sug = suggested.includes(c);
          const { style, Icon } = conceptToneProps(taxonomy, c);
          return (
            <span key={c} className={clsx("concept-pick__chip", sug && "concept-pick__chip--suggested")} style={style} title={conceptPathText(taxonomy, c)}>
              <Icon className="i i-xs" aria-hidden />
              <span className="truncate" translate="no">
                {name}
              </span>
              {sug ? <span className="concept-pick__state">Chờ duyệt</span> : null}
              <button type="button" className="concept-pick__x" aria-label={`Gỡ ${name}`} disabled={isDisabled} onClick={() => onChange(value.filter((x) => x !== c))}>
                <X className="i i-xs" aria-hidden />
              </button>
            </span>
          );
        })
      ) : empty ? (
        <span className="t-sm muted">{empty}</span>
      ) : null}
      {shown.length < value.length ? (
        <button type="button" className="concept-pick__more" onClick={() => setExpanded(true)}>
          {`+${value.length - shown.length} nữa`}
        </button>
      ) : null}
      {options.length ? (
        <Select aria-label={addLabel} className="concept-pick__add" placeholder={`${addLabel}…`} value={null} isDisabled={isDisabled} onChange={(v) => v && add(String(v))} onOpenChange={onOpenChange}>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {offered.map(([key, text]) => (
                <ListBox.Item key={key} id={key} textValue={text}>
                  {text}
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      ) : null}
    </div>
  );
}
