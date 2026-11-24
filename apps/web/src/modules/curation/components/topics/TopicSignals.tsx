"use client";

import { Button, Description, Input, Label, TextField } from "@heroui/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowRight, Plus, X } from "lucide-react";
import NextLink from "next/link";
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";

import { FileIcon, IconButton, SearchInput } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { useSources } from "@/modules/ingestion/queries";
import { batchGetItems, listAllItems, listItems, quote, type Item } from "@/modules/knowledge/api";
import { fold } from "@/modules/knowledge/model";
import { useKnowledgeModel } from "@/modules/knowledge/queries";

import type { Topic, TopicRule } from "../../api";
import { cleanName } from "../../governance";
import { PlainSelect } from "../parts";

/**
 * A topic's classification signals in Topics' detail (preview `masterdata.js` termsSec, rulesSec, examplesSec): one
 * keyword chip list, rules on where a document is or comes from, and example documents. Pure editors over the node's
 * draft; saving is the detail's.
 */

/** Contract limits (openapi `Topic`). */
export const MAX_TERMS = 50;
export const MAX_RULES = 20;
export const MAX_EXAMPLES = 5;
export const GUIDANCE_MAX = 2000;

/** A detail section: title, an aside, a muted description, the body. */
export function Sec({ title, desc, aside, children }: { title: string; desc?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="tx-sec">
      <div className="tx-sec__head">
        <h3 className="tx-sec__title">{title}</h3>
        {aside}
      </div>
      {desc ? <p className="tx-sec__desc">{desc}</p> : null}
      {children}
    </section>
  );
}

/* ═══════════════ Keywords ═══════════════ */

export type TermList = "keywords" | "synonyms";
export interface Terms {
  keywords: string[];
  synonyms: string[];
}

/** Typed text → terms: split on commas, semicolons, pipes and line breaks; cleaned; no repeats. */
export function splitTerms(s: string): string[] {
  const out: string[] = [];
  for (const raw of s.split(/[,;|\n]+/)) {
    const t = cleanName(raw).slice(0, 100);
    if (t && !out.some((x) => fold(x) === fold(t))) out.push(t);
  }
  return out;
}

/** `list` plus the typed terms neither list already has (case-insensitive), at most {@link MAX_TERMS}. */
export function addTerms(terms: Terms, list: TermList, typed: string): string[] {
  const have = new Set([...terms.keywords, ...terms.synonyms].map(fold));
  return [...terms[list], ...splitTerms(typed).filter((k) => !have.has(fold(k)))].slice(0, MAX_TERMS);
}

/** The lists with what's still typed in the keyword input: nobody expects Save to drop what they typed. */
export function withTyped(terms: Terms, typed: string): Terms {
  return { keywords: addTerms(terms, "keywords", typed), synonyms: terms.synonyms };
}

/** Multi-line text (guidance): each line cleaned, line breaks kept, at most one blank line in a row. */
export const cleanBlock = (s: string) =>
  s
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(cleanName)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export interface TermsDraft extends Terms {
  keywordsIn: string;
}

/**
 * One chip list: keywords and synonyms count the same for classification, so people keep one list of words. Each chip
 * stays in its list (an import or a merged proposal may have set synonyms); what's typed becomes keywords.
 */
export function TermsEditor({ value, onChange }: { value: TermsDraft; onChange: (patch: Partial<TermsDraft>) => void }) {
  const commit = (typed: string) => onChange({ keywords: addTerms(value, "keywords", typed), keywordsIn: "" });
  const n = value.keywords.length;
  return (
    <Sec title="Từ khóa" desc="Những từ trong tiêu đề hoặc nội dung cho thấy tài liệu thuộc về đây, kể cả các tên gọi khác mọi người dùng.">
      <ChipField
        label="Từ khóa"
        placeholder="Thêm từ khóa rồi nhấn Enter"
        chips={[...value.keywords, ...value.synonyms]}
        typed={value.keywordsIn}
        onType={(v) => (/[,;]/.test(v) ? commit(v) : onChange({ keywordsIn: v }))}
        onCommit={() => commit(value.keywordsIn)}
        onRemove={(i) => onChange(i < n ? { keywords: value.keywords.filter((_, j) => j !== i) } : { synonyms: value.synonyms.filter((_, j) => j !== i - n) })}
      />
    </Sec>
  );
}

/**
 * Chips with an input that adds on Enter (`onCommit`). In the detail it sits under its section's heading (the label is
 * for screen readers); `form` renders it as a regular form field (label, optional mark, description), as in the New
 * topic dialog.
 */
export function ChipField({
  label,
  placeholder,
  form = false,
  optional = false,
  description,
  chips,
  typed,
  onType,
  onCommit,
  onRemove,
}: {
  label: string;
  placeholder: string;
  form?: boolean;
  optional?: boolean;
  description?: string;
  chips: readonly string[];
  typed: string;
  onType: (v: string) => void;
  onCommit: () => void;
  onRemove: (i: number) => void;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    onCommit();
  };
  // The whole group is the text field, so its label names the input inside the chip box.
  return (
    <TextField value={typed} onChange={onType} className={form ? "field" : "tx-chipfield"}>
      <Label className={form ? undefined : "sr-only"}>
        {label}
        {optional ? (
          <>
            {" "}
            <span className="label__opt">(không bắt buộc)</span>
          </>
        ) : null}
      </Label>
      <div className="tx-chips">
        {chips.map((k, i) => (
          <span key={`${k}-${i}`} className="tx-chip">
            <span className="tx-chip__text" translate="no">
              {k}
            </span>
            <button type="button" className="tx-chip__x" aria-label={`Gỡ ${k}`} onClick={() => onRemove(i)}>
              <X className="i i-xs" aria-hidden />
            </button>
          </span>
        ))}
        {chips.length < MAX_TERMS ? (
          <Input className="tx-chips__input" placeholder={placeholder} spellCheck={false} autoComplete="off" maxLength={300} onKeyDown={onKeyDown} />
        ) : null}
      </div>
      {description ? <Description>{description}</Description> : null}
    </TextField>
  );
}

/* ═══════════════ Rules ═══════════════ */

/** A rule row: documents in a collection's subtree, or documents a source registered. */
export interface RuleDraft {
  kind: "collection" | "source";
  value: string;
}

export const rulesOf = (t: Topic | null | undefined): RuleDraft[] =>
  (t?.rules ?? []).map((r) => (r.collection ? { kind: "collection", value: r.collection } : { kind: "source", value: r.source ?? "" }));

/** Filled rows as the API takes them (empty ones are dropped). */
export const rulesToApi = (rules: readonly RuleDraft[]): TopicRule[] => rules.filter((r) => r.value).map((r) => (r.kind === "collection" ? { collection: r.value } : { source: r.value }));

export type Options = readonly (readonly [string, string])[];

/** What rules (and the test box) pick from, with names → labels. */
export interface RuleOptions {
  /** Collection item name → "Collection / Folder". */
  collections: Options;
  /** Source name → display name. */
  sources: Options;
  collectionName: (name: string) => string;
  sourceName: (name: string) => string;
}

/**
 * Every readable shared collection with its path ("Collection / Folder"), and the workspace's sources (bounded
 * workspace configuration, read whole).
 */
export function useRuleOptions(): RuleOptions {
  const { id: ws } = useWorkspace();
  // Shared collections only (`itemType = STANDARD`): one personal collection per member would grow with the people.
  const all = useQuery({ queryKey: [ws, "items", "sharedCollections"], queryFn: () => listAllItems(ws, { filter: "itemKind = COLLECTION AND itemType = STANDARD" }), staleTime: 5 * 60_000 });
  const sources = useSources();
  return useMemo(() => {
    const byName = new Map((all.data ?? []).map((c) => [c.name ?? "", c] as const));
    const chain = (c: Item): Item[] => {
      const out = [c];
      for (let p = byName.get(c.parentItem ?? ""); p && out.length < 16; p = byName.get(p.parentItem ?? "")) out.unshift(p);
      return out;
    };
    const collections: [string, string][] = [];
    for (const c of all.data ?? []) {
      const path = chain(c);
      collections.push([c.name ?? "", path.map((x) => x.displayName || "Kho tài liệu chưa đặt tên").join(" / ")]);
    }
    collections.sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true, sensitivity: "base" }));
    const srcs: [string, string][] = (sources.data ?? []).map((s) => [s.name ?? "", s.displayName || resourceId(s.name)] as [string, string]).sort((a, b) => a[1].localeCompare(b[1]));
    const label = (opts: Options, name: string) => opts.find(([k]) => k === name)?.[1] ?? resourceId(name);
    return {
      collections: collections as Options,
      sources: srcs as Options,
      collectionName: (name: string) => label(collections, name),
      sourceName: (name: string) => label(srcs, name),
    };
  }, [all.data, sources.data]);
}

/** "documents in “Chargebacks”" — a rule in words (the prompt drawer). */
export const ruleText = (r: TopicRule, o: RuleOptions) => (r.collection ? `tài liệu trong “${o.collectionName(r.collection)}”` : `tài liệu từ “${o.sourceName(r.source ?? "")}”`);

/** A stored value the lists don't hold (an unreadable collection, a source not listed yet) still shows. */
const withValue = (opts: Options, value: string): Options => (!value || opts.some(([k]) => k === value) ? opts : [[value, resourceId(value)], ...opts]);

export function RulesEditor({ rules, options, onChange }: { rules: readonly RuleDraft[]; options: RuleOptions; onChange: (rules: RuleDraft[]) => void }) {
  const add = (kind: RuleDraft["kind"]) => onChange([...rules, { kind, value: "" }]);
  return (
    <Sec title="Luôn xếp vào đây" desc="Tài liệu trong kho tài liệu hoặc từ nguồn dữ liệu bạn chọn luôn nhận chủ đề này, không cần hỏi trợ lý.">
      {rules.length ? (
        <ul className="tx-rules">
          {rules.map((r, i) => (
            <li key={i} className="tx-rule">
              <span className="tx-rule__word">{r.kind === "collection" ? "Tài liệu trong" : "Tài liệu từ"}</span>
              <PlainSelect
                className="tx-rule__value"
                label={r.kind === "collection" ? "Kho tài liệu" : "Nguồn"}
                placeholder={r.kind === "collection" ? "Chọn kho tài liệu" : "Chọn một nguồn dữ liệu"}
                value={r.value}
                options={withValue(r.kind === "collection" ? options.collections : options.sources, r.value)}
                onChange={(value) => onChange(rules.map((x, j) => (j === i ? { ...x, value } : x)))}
              />
              <span className="tx-rule__word">
                <ArrowRight className="i i-xs" aria-hidden />
                <span>xếp vào đây</span>
              </span>
              <IconButton icon={X} tip="Gỡ quy tắc" size="sm" onPress={() => onChange(rules.filter((_, j) => j !== i))} />
            </li>
          ))}
        </ul>
      ) : null}
      {rules.length < MAX_RULES ? (
        <div className="tx-rules__add">
          <Button variant="ghost" size="sm" onPress={() => add("collection")}>
            <Plus className="i" aria-hidden />
            Tài liệu trong một kho tài liệu
          </Button>
          <Button variant="ghost" size="sm" onPress={() => add("source")}>
            <Plus className="i" aria-hidden />
            Tài liệu từ một nguồn dữ liệu
          </Button>
        </div>
      ) : null}
    </Sec>
  );
}

/* ═══════════════ Examples ═══════════════ */

const PUBLISHED_DOCS = "itemKind = DOCUMENT AND document.publicationState = PUBLISHED";

/** Waits for typing to pause before a value is used (search requests). */
function useSettled(value: string, ms = 250) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/**
 * Up to five published documents that clearly belong here, as chips linking to them. The picker searches published
 * documents by title; with nothing typed it suggests documents already tagged with the topic.
 */
export function ExamplesEditor({ topic, examples, onChange }: { topic: string | null; examples: readonly string[]; onChange: (examples: string[]) => void }) {
  const { id: ws } = useWorkspace();
  const { toResource } = useKnowledgeModel();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const term = useSettled(q.trim());
  const sorted = [...examples].sort();
  const chosen = useQuery({
    queryKey: [ws, "items", "topicExamples", sorted],
    queryFn: () => batchGetItems(ws, sorted, { view: "FULL" }),
    enabled: examples.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const room = examples.length < MAX_EXAMPLES;
  const picking = room && (open || !examples.length);
  // `*` and `?` are the filter's wildcards; typed ones are literal characters, so they go.
  const needle = term.replace(/[*?]/g, " ").trim();
  const filter = needle ? `${PUBLISHED_DOCS} AND displayName = ${quote(`*${needle}*`)}` : topic ? `${PUBLISHED_DOCS} AND document.topics:${quote(topic)}` : "";
  const picks = useQuery({
    queryKey: [ws, "items", "topicExamplePicks", filter],
    queryFn: () => listItems(ws, { filter, pageSize: 12, view: "FULL" }),
    enabled: picking && !!filter,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  // A document just picked is already known from the picker, so its chip never flashes while the batch read refreshes.
  const byName = new Map([...(picks.data?.items ?? []), ...(chosen.data ?? [])].map((it) => [it.name ?? "", toResource(it)] as const));
  const cands = (picks.data?.items ?? [])
    .map((it) => toResource(it))
    .filter((r) => !r.isPersonal && !examples.includes(r.name))
    .slice(0, needle ? 5 : 3);

  const remove = (name: string) => onChange(examples.filter((x) => x !== name));
  const add = (name: string) => {
    if (examples.includes(name) || !room) return;
    onChange([...examples, name]);
    setQ("");
  };

  return (
    <Sec title="Ví dụ" desc="Hai hoặc ba tài liệu rõ ràng thuộc về đây. Trợ lý so sánh tài liệu mới với chúng.">
      {examples.length ? (
        <div className="tx-chips tx-chips--docs">
          {examples.map((name) => {
            const r = byName.get(name);
            if (!r)
              return (
                <span key={name} className="tx-chip tx-chip--doc">
                  <span className="tx-chip__text muted">{chosen.isPending || chosen.isPlaceholderData ? "…" : "Một tài liệu bạn không mở được"}</span>
                  <button type="button" className="tx-chip__x" aria-label="Gỡ" onClick={() => remove(name)}>
                    <X className="i i-xs" aria-hidden />
                  </button>
                </span>
              );
            return (
              <span key={name} className="tx-chip tx-chip--doc">
                <FileIcon name={r.fileName} mime={r.mime} size="sm" />
                <NextLink className="tx-chip__text link" href={`/doc/${r.id}`} translate="no">
                  {r.title}
                </NextLink>
                <button type="button" className="tx-chip__x" aria-label={`Gỡ ${r.title}`} onClick={() => remove(name)}>
                  <X className="i i-xs" aria-hidden />
                </button>
              </span>
            );
          })}
        </div>
      ) : null}
      {picking ? (
        <div className="tx-expick">
          <SearchInput value={q} onChange={setQ} placeholder="Tìm tài liệu đã công bố" fullWidth autoFocus={open} />
          {!needle && cands.length ? <div className="tx-picks__label">Gợi ý: đã được gắn chủ đề này</div> : null}
          {cands.length ? (
            <ul className="tx-picks" aria-label={needle ? "Tài liệu khớp" : "Tài liệu gợi ý"}>
              {cands.map((r) => (
                <li key={r.name}>
                  <button type="button" className="tx-pick" onClick={() => add(r.name)}>
                    <FileIcon name={r.fileName} mime={r.mime} size="sm" />
                    <span className="tx-pick__name truncate" translate="no">
                      {r.title}
                    </span>
                    <span className="tx-pick__meta truncate" translate="no">
                      {r.base?.displayName ?? ""}
                    </span>
                    <Plus className="i i-sm" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : picks.isFetching ? null : (
            <p className="tx-sec__empty">{needle ? "Không có tài liệu đã công bố nào khớp." : "Tìm một tài liệu đã công bố tiêu biểu cho chủ đề này."}</p>
          )}
        </div>
      ) : room ? (
        <Button variant="ghost" size="sm" onPress={() => setOpen(true)}>
          <Plus className="i" aria-hidden />
          Thêm ví dụ
        </Button>
      ) : null}
    </Sec>
  );
}
