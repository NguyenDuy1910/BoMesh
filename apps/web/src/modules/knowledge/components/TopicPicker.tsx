"use client";

import { ListBox, Select } from "@heroui/react";
import clsx from "clsx";
import { X } from "lucide-react";
import { useMemo, useState } from "react";

import { useLazyOptions } from "@/components/ui/useLazyOptions";

import type { Topic } from "../api";
import { topicLooks, topicTree } from "../model";
import { topicToneProps } from "./TopicTag";

export interface TopicPickerProps {
  /** Chosen topic names. */
  value: readonly string[];
  onChange: (next: string[]) => void;
  /** The workspace's topics (active ones are offered, grouped by domain). */
  topics: readonly Topic[];
  /** Accessible name of the group ("Selected topics"). */
  label: string;
  /** Shown when nothing is chosen. */
  empty?: string;
  /** Also offer whole domains ("{domain} · all topics" adds every topic under it). */
  domains?: boolean;
  /** Show this many chips and a "+N more" toggle (0 = all). */
  limit?: number;
  /** Neutral chips (a setting, not the document's own metadata). */
  quiet?: boolean;
  isDisabled?: boolean;
}

/**
 * Topics as removable chips beside an "Add topic…" select (preview `topicPicker`, core/catalog.js): Contribute's
 * details and the Process dialog. Offers active topics as "{domain} · {topic}"; with `domains`, a domain with more
 * than one topic left adds them all at once.
 */
export function TopicPicker({ value, onChange, topics, label, empty = "", domains = false, limit = 0, quiet = false, isDisabled }: TopicPickerProps) {
  const [expanded, setExpanded] = useState(false);
  const tree = useMemo(() => topicTree(topics), [topics]);
  const names = useMemo(() => new Map(topics.map((t) => [t.name ?? "", t.displayName ?? "Chủ đề chưa đặt tên"])), [topics]);
  const looks = useMemo(() => topicLooks(topics), [topics]);
  const shown = limit && !expanded && value.length > limit + 1 ? value.slice(0, limit) : value;
  const options = tree.flatMap((d) => {
    const left = d.children.filter((t) => !value.includes(t.name ?? ""));
    return [
      ...(domains && left.length > 1 ? [[`domain:${d.name}`, `${d.displayName} · tất cả chủ đề`] as const] : []),
      ...left.map((t) => [t.name ?? "", `${d.displayName} · ${t.displayName}`] as const),
    ];
  });
  // The trigger never shows a choice, but a Select with no items refuses to open (and so never asks for its options):
  // keep the first option built while closed.
  const [offered, onOpenChange] = useLazyOptions(options, (o) => o === options[0]);
  const add = (key: string) => {
    const picked = key.startsWith("domain:") ? (tree.find((d) => d.name === key.slice(7))?.children ?? []).map((t) => t.name ?? "") : [key];
    onChange([...new Set([...value, ...picked])]);
  };

  return (
    <div className={clsx("topic-pick", quiet && "topic-pick--quiet")} role="group" aria-label={label}>
      {shown.length ? (
        shown.map((t) => {
          const name = names.get(t) ?? "Chủ đề chưa đặt tên";
          const { style, Icon } = topicToneProps(looks.get(t));
          return (
            <span key={t} className="topic-pick__chip" style={style}>
              <Icon className="i i-xs" aria-hidden />
              <span className="truncate" translate="no" title={name}>
                {name}
              </span>
              <button type="button" className="topic-pick__x" aria-label={`Gỡ ${name}`} disabled={isDisabled} onClick={() => onChange(value.filter((x) => x !== t))}>
                <X className="i i-xs" aria-hidden />
              </button>
            </span>
          );
        })
      ) : empty ? (
        <span className="t-sm muted">{empty}</span>
      ) : null}
      {shown.length < value.length ? (
        <button type="button" className="topic-pick__more" onClick={() => setExpanded(true)}>
          {`+${value.length - shown.length} nữa`}
        </button>
      ) : null}
      {options.length ? (
        <Select aria-label="Thêm chủ đề" className="topic-pick__add" placeholder="Thêm chủ đề…" value={null} isDisabled={isDisabled} onChange={(v) => v && add(String(v))} onOpenChange={onOpenChange}>
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
