"use client";

import { Button, Input, TextArea, TextField } from "@heroui/react";
import { Archive, ArrowLeft, GitCompare, ListTree, Plus, Tag, Trash2, X } from "lucide-react";
import NextLink from "next/link";
import { useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

import { Callout, EditableTitle, EmptyState, IconButton, StatusChip, toast } from "@/components/ui";
import { fmtNum, plural } from "@/lib/format";
import { conceptIcon } from "@/modules/home/domainIcon";
import type { Concept, ConceptScheme } from "@/modules/knowledge/api";
import { conceptHref } from "@/modules/knowledge/model";
import {
  conceptLabel,
  conceptLabels,
  conceptLook,
  conceptPathText,
  conceptsOf,
  conceptState,
  ancestorsOf,
  descendantsOf,
  isClassification,
  normLabel,
  resourceKey,
  schemeIconName,
  schemeOfConcept,
  type Taxonomy,
} from "@/modules/knowledge/taxonomy";

import { cleanLabel, depthOf, nameClash, relatedOf } from "../../governance";
import { taxonomyHref } from "../../model";
import { useConceptRules } from "../../queries";
import type { ConceptLabel, ConceptMapping } from "../../taxonomyApi";
import { PlainSelect } from "../parts";
import { ActionsMenu } from "../shared";
import { ColorPicker, DOT, IconPicker, Sec, useEditConcept, useRuleWhen, type TaxonomyAccess } from "./parts";

const LANGS = [
  ["vi", "vi"],
  ["en", "en"],
] as const;
const MATCH: readonly (readonly [ConceptMapping["match"], string])[] = [
  ["EXACT", "Khớp chính xác"],
  ["CLOSE", "Khớp gần"],
  ["BROAD", "Khớp rộng hơn"],
  ["NARROW", "Khớp hẹp hơn"],
];
const MAX_PATTERNS = 20;

/** What a concept's ⋯ asks the scheme view to do (dialogs and held decisions live there). */
export interface ConceptActions {
  onSelect: (id: string) => void;
  onNew: (broader: string) => void;
  onReplace: (c: Concept, mode: "merge" | "split") => void;
  onRetire: (c: Concept) => void;
  onDeleteDraft: (c: Concept) => void;
}

/** Parents in the concept's own scheme. */
const parentsIn = (t: Taxonomy, c: Concept) => (c.broader ?? []).filter((b) => t.byName.has(b) && schemeOfConcept(b) === schemeOfConcept(c.name ?? ""));
const nodeHref = (name: string) => taxonomyHref(resourceKey(schemeOfConcept(name)), { node: resourceKey(name) });

function Back({ onBack }: { onBack: () => void }) {
  return (
    <div className="tx-back">
      <Button variant="ghost" size="sm" onPress={onBack}>
        <ArrowLeft className="i" aria-hidden />
        Tất cả khái niệm
      </Button>
    </div>
  );
}

/**
 * A concept's detail (preview `detail()`): header (icon, preferred name to click and rename, where it sits, documents,
 * notation, ⋯), a retired concept's replacement, Definition, Scope, Labels, Relations, Mappings, Recognition patterns
 * (document types), the rules that file documents here and a top concept's color. Every edit applies at once with Undo;
 * without edit rights (or retired) it reads only.
 */
export function ConceptDetail({ taxonomy: t, scheme, concept: c, access, actions }: { taxonomy: Taxonomy; scheme: ConceptScheme; concept: Concept | null; access: TaxonomyAccess; actions: ConceptActions }) {
  const back = <Back onBack={() => actions.onSelect("")} />;
  if (!c) {
    const empty = !conceptsOf(t, scheme.name ?? "").length;
    return (
      <div className="tx-detail">
        {back}
        <EmptyState
          icon={Tag}
          title="Chọn một khái niệm"
          description={access.create ? "Chọn một khái niệm trong danh sách, hoặc thêm khái niệm đầu tiên." : "Chọn một khái niệm trong danh sách để xem."}
          compact
          actions={
            access.create && empty ? (
              <Button variant="secondary" onPress={() => actions.onNew("")}>
                <Plus className="i" aria-hidden />
                Khái niệm mới
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }
  const ro = !access.update || conceptState(c) === "DEPRECATED";
  const top = !parentsIn(t, c).length;
  const docTypes = resourceKey(scheme.name) === "document-type";
  return (
    <div className="tx-detail">
      {back}
      <Head taxonomy={t} scheme={scheme} concept={c} ro={ro} access={access} actions={actions} />
      {conceptState(c) === "DEPRECATED" ? <RetiredNote taxonomy={t} concept={c} /> : null}
      <TextSec concept={c} field="definition" ro={ro} />
      <TextSec concept={c} field="scopeNote" ro={ro} />
      <LabelsSec taxonomy={t} concept={c} ro={ro} />
      <RelationsSec taxonomy={t} scheme={scheme} concept={c} ro={ro} />
      <MappingsSec concept={c} ro={ro} />
      {docTypes || c.matchPatterns?.length ? <PatternsSec concept={c} ro={ro} /> : null}
      <RulesSec taxonomy={t} concept={c.name ?? ""} />
      {!ro && top ? <ColorSec concept={c} /> : null}
    </div>
  );
}

/* ── Header: icon, preferred name (click to rename), where it sits, documents, notation, ⋯ ── */

function Head({ taxonomy: t, scheme, concept: c, ro, access, actions }: { taxonomy: Taxonomy; scheme: ConceptScheme; concept: Concept; ro: boolean; access: TaxonomyAccess; actions: ConceptActions }) {
  const edit = useEditConcept();
  const name = c.name ?? "";
  const look = conceptLook(t, name);
  const ps = parentsIn(t, c);
  const st = conceptState(c);
  const n = c.documentCount ?? 0;
  const vi = c.prefLabels?.find((l) => l.languageCode === "vi")?.text ?? conceptLabel(t, name);
  const Icon = conceptIcon(look.icon);
  const rename = async (raw: string) => {
    const label = cleanLabel(raw);
    if (!label || label === vi) return;
    if (nameClash(t, scheme.name ?? "", label, name)) return `${scheme.displayName ?? ""} đã có “${label}”.`;
    await edit(c, { prefLabels: [...(c.prefLabels ?? []).filter((l) => l.languageCode !== "vi"), { languageCode: "vi", text: label }] }, `Đã đổi tên thành “${label}”`);
  };
  const canAddUnder = access.create && st !== "DEPRECATED" && depthOf(t, name) < (scheme.maxDepth || 9);
  const menu =
    access.update && st !== "DEPRECATED"
      ? [
          ...(canAddUnder ? [{ id: "under", label: "Thêm khái niệm bên dưới", icon: Plus, onAction: () => actions.onNew(name) }] : []),
          ...(st === "DRAFT"
            ? access.remove
              ? [{ id: "delete", label: "Xóa bản nháp", icon: Trash2, danger: true, separated: true, onAction: () => actions.onDeleteDraft(c) }]
              : []
            : [
                { id: "merge", label: "Gộp vào…", icon: GitCompare, onAction: () => actions.onReplace(c, "merge") },
                { id: "split", label: "Tách…", icon: ListTree, onAction: () => actions.onReplace(c, "split") },
                { id: "retire", label: "Ngừng dùng", icon: Archive, danger: true, separated: true, onAction: () => actions.onRetire(c) },
              ]),
        ]
      : [];
  return (
    <header className="tx-head">
      {ro ? (
        <span className="item-icon item-icon--tone" style={{ "--tone": look.color } as CSSProperties} aria-hidden="true">
          <Icon className="i" />
        </span>
      ) : (
        <IconPicker
          shown={look.icon}
          color={look.color}
          value={c.icon || (ps.length ? "" : schemeIconName(scheme.name))}
          onPick={(icon) => {
            if (icon !== (c.icon ?? "")) void edit(c, { icon }, "Đã đổi biểu tượng");
          }}
          onReset={ps.length && c.icon ? () => void edit(c, { icon: "" }, "Đang dùng biểu tượng của khái niệm cha") : undefined}
        />
      )}
      <div className="tx-head__main">
        <div className="tx-head__title-row">
          {ro ? (
            <h2 className="tx-head__title" translate="no">
              {conceptLabel(t, name)}
            </h2>
          ) : (
            <EditableTitle value={vi} onCommit={rename} label="Đổi tên khái niệm" className="tx-head__title" as="h2" maxLength={120} />
          )}
          {st === "DRAFT" ? <StatusChip label="Nháp" size="sm" tone="accent" dot={false} tooltip="Chưa được dùng để phân loại cho đến khi bạn công bố trục phân loại" /> : null}
          {st === "DEPRECATED" ? <StatusChip label="Ngừng dùng" size="sm" dot={false} /> : null}
        </div>
        <p className="tx-head__meta">
          {ps.length ? <span translate="no">{conceptPathText(t, ps[0])}</span> : <span>Khái niệm gốc</span>}
          {DOT}
          {n && isClassification(scheme) ? (
            <NextLink className="link" href={conceptHref(name)}>
              {plural(n, "document")}
            </NextLink>
          ) : (
            <span>{n ? plural(n, "document") : "Chưa có tài liệu"}</span>
          )}
          {DOT}
          <span className="tx-notation" translate="no" title="Ký hiệu: mã của khái niệm trong tệp xuất và API. Không bao giờ thay đổi.">
            {resourceKey(name)}
          </span>
        </p>
      </div>
      <div className="tx-head__acts">
        <ActionsMenu label="Thao tác khác cho khái niệm này" actions={menu} />
      </div>
    </header>
  );
}

/** A retired concept: what replaced it, and that it takes effect at the next publish while pending. */
function RetiredNote({ taxonomy: t, concept: c }: { taxonomy: Taxonomy; concept: Concept }) {
  const by = (c.replacedBy ?? []).filter((r) => t.byName.has(r));
  return (
    <Callout
      icon={Archive}
      description={
        <>
          {by.length ? (
            <>
              <span>Được thay bằng</span>{" "}
              {by.map((r, i) => (
                <span key={r}>
                  {i ? ", " : null}
                  <NextLink className="link" href={nodeHref(r)} translate="no">
                    {conceptLabel(t, r)}
                  </NextLink>
                </span>
              ))}
              .
            </>
          ) : (
            <span>Ngừng dùng, không có khái niệm thay thế.</span>
          )}
          {c.deprecationPending ? <span> Có hiệu lực khi bạn công bố.</span> : null}
        </>
      }
    />
  );
}

/* ── Definition and scope note: applied when the person leaves the field ── */

const TEXTS = {
  definition: {
    title: "Định nghĩa",
    desc: "Ý nghĩa của khái niệm. Mọi người thấy khi chọn khái niệm; trợ lý đọc nó. Bắt buộc để công bố.",
    placeholder: "Khái niệm này bao gồm những gì, trong một hai câu",
    rows: 3,
    done: "Đã cập nhật định nghĩa",
  },
  scopeNote: { title: "Phạm vi", desc: "Ranh giới của khái niệm, cho những tài liệu khó xếp.", placeholder: "Bao gồm … / Không bao gồm …", rows: 2, done: "Đã cập nhật phạm vi" },
} as const;

function TextSec({ concept: c, field, ro }: { concept: Concept; field: keyof typeof TEXTS; ro: boolean }) {
  const edit = useEditConcept();
  const t = TEXTS[field];
  const saved = c[field] ?? "";
  const [v, setV] = useState(saved);
  if (ro) return <Sec title={t.title}>{saved ? <p className="tx-text" translate="no">{saved}</p> : <p className="tx-sec__empty">Chưa thiết lập</p>}</Sec>;
  const commit = () => {
    const next = v.trim();
    if (next !== saved) void edit(c, { [field]: next }, t.done);
  };
  return (
    <Sec title={t.title} desc={t.desc}>
      <TextField value={v} onChange={setV} maxLength={1000} aria-label={t.title}>
        <TextArea rows={t.rows} placeholder={t.placeholder} onBlur={commit} />
      </TextField>
    </Sec>
  );
}

/* ── Labels: preferred per language, alternative and hidden chips with their language ── */

function Chip({ lang, text, code = false, onRemove }: { lang?: string; text: ReactNode; code?: boolean; onRemove?: () => void }) {
  return (
    <span className={`tx-chip${code ? " tx-chip--code" : ""}`}>
      {lang ? (
        <span className="tx-chip__lang" translate="no">
          {lang}
        </span>
      ) : null}
      {code ? <code className="tx-chip__text">{text}</code> : <span className="tx-chip__text" translate="no">{text}</span>}
      {onRemove ? (
        <button type="button" className="tx-chip__x" aria-label={`Gỡ ${typeof text === "string" ? text : ""}`} onClick={onRemove}>
          <X className="i i-xs" aria-hidden />
        </button>
      ) : null}
    </span>
  );
}

/** A small field, optionally its language, and + (preview `adder`). Enter adds too. */
function Adder({ placeholder, withLang, onAdd, code = false }: { placeholder: string; withLang?: boolean; onAdd: (text: string, lang: string) => boolean | void; code?: boolean }) {
  const [text, setText] = useState("");
  const [lang, setLang] = useState("vi");
  const add = () => {
    if (!text.trim()) return;
    if (onAdd(text, lang) !== false) setText("");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    add();
  };
  return (
    <span className="tx-add">
      <TextField value={text} onChange={setText} aria-label={placeholder} className="tx-add__field">
        <Input className={`tx-add__input${code ? " tx-add__input--code" : ""}`} placeholder={placeholder} spellCheck={false} maxLength={255} onKeyDown={onKeyDown} />
      </TextField>
      {withLang ? <PlainSelect label="Ngôn ngữ" className="tx-add__lang" value={lang} options={LANGS} onChange={setLang} /> : null}
      <IconButton icon={Plus} tip="Thêm" size="sm" onPress={add} />
    </span>
  );
}

function LabelsSec({ taxonomy: t, concept: c, ro }: { taxonomy: Taxonomy; concept: Concept; ro: boolean }) {
  const edit = useEditConcept();
  const name = conceptLabel(t, c.name);
  const has = (lang: string, text: string) => conceptLabels(c).some((l) => l.languageCode === lang && normLabel(l.text) === normLabel(text));
  const add = (field: "prefLabels" | "altLabels" | "hiddenLabels", raw: string, lang: string) => {
    const text = cleanLabel(raw);
    if (!text) return false;
    if (has(lang, text)) {
      toast(`“${text}” đã là nhãn của ${name}`, { tone: "accent" });
      return false;
    }
    void edit(c, { [field]: [...(c[field] ?? []), { languageCode: lang, text }] }, `Đã thêm “${text}”`);
  };
  const remove = (field: "prefLabels" | "altLabels" | "hiddenLabels", l: ConceptLabel) =>
    void edit(c, { [field]: (c[field] ?? []).filter((x) => !(x.languageCode === l.languageCode && x.text === l.text)) }, `Đã gỡ “${l.text}”`);
  const prefs = [...(c.prefLabels ?? [])].sort((a, b) => Number(b.languageCode === "vi") - Number(a.languageCode === "vi"));
  const none = <span className="muted">Không có</span>;
  const row = (label: string, hint: string, body: ReactNode) => (
    <div className="tx-labels__row">
      <div className="tx-labels__kind">
        <span className="medium">{label}</span>
        <span className="tx-labels__hint">{hint}</span>
      </div>
      <div className="tx-labels__chips">{body}</div>
    </div>
  );
  const list = (field: "altLabels" | "hiddenLabels", placeholder: string) => {
    const chips = (c[field] ?? []).map((l) => <Chip key={`${l.languageCode}:${l.text}`} lang={l.languageCode} text={l.text} onRemove={ro ? undefined : () => remove(field, l)} />);
    return ro ? (chips.length ? chips : none) : [...chips, <Adder key="add" placeholder={placeholder} withLang onAdd={(text, lang) => add(field, text, lang)} />];
  };
  return (
    <Sec title="Nhãn" desc="Phân loại và tìm kiếm nhận ra khái niệm qua mọi nhãn của nó.">
      <div className="tx-labels">
        {row(
          "Nhãn chính",
          "Tên của khái niệm, mỗi ngôn ngữ một tên",
          <>
            {prefs.map((l) => (
              <Chip key={l.languageCode} lang={l.languageCode} text={l.text} onRemove={ro || l.languageCode === "vi" ? undefined : () => remove("prefLabels", l)} />
            ))}
            {!ro && !prefs.some((l) => l.languageCode === "en") ? <Adder placeholder="Tên tiếng Anh" onAdd={(text) => add("prefLabels", text, "en")} /> : null}
          </>,
        )}
        {row("Nhãn thay thế", "Các tên khác mọi người hay dùng", list("altLabels", "Thêm nhãn"))}
        {row("Nhãn ẩn", "Lỗi chính tả và viết tắt: tìm được nhưng không hiển thị", list("hiddenLabels", "Thêm nhãn ẩn"))}
      </div>
    </Sec>
  );
}

/* ── Relations: broader (several) and related ── */

function RelationsSec({ taxonomy: t, scheme, concept: c, ro }: { taxonomy: Taxonomy; scheme: ConceptScheme; concept: Concept; ro: boolean }) {
  const edit = useEditConcept();
  const name = c.name ?? "";
  const below = new Set(descendantsOf(t, name));
  const above = new Set(ancestorsOf(t, name));
  const rel = relatedOf(t, c);
  const broader = (c.broader ?? []).filter((b) => t.byName.has(b));
  const all = conceptsOf(t, scheme.name ?? "").filter((o) => o.name !== name && !below.has(o.name ?? ""));
  const opts = (list: readonly Concept[]) => list.map((o) => [o.name ?? "", conceptPathText(t, o.name ?? "")] as const);
  const broaderC = all.filter((o) => !broader.includes(o.name ?? ""));
  const relatedC = all.filter((o) => !above.has(o.name ?? "") && !rel.includes(o.name ?? ""));
  const label = (x: string) => conceptLabel(t, x);
  const chip = (x: string, onRemove?: () => void) => (
    <Chip
      key={x}
      text={
        <NextLink className="link" href={nodeHref(x)}>
          {label(x)}
        </NextLink>
      }
      onRemove={ro ? undefined : onRemove}
    />
  );
  const unrelate = (x: string) => {
    if (c.related?.includes(x)) void edit(c, { related: c.related.filter((r) => r !== x) }, `Không còn liên quan với ${label(x)}`);
    else {
      const o = t.byName.get(x);
      if (o) void edit(o, { related: (o.related ?? []).filter((r) => r !== name) }, `Không còn liên quan với ${label(x)}`);
    }
  };
  const pick = (placeholder: string, list: readonly Concept[], onPick: (x: string) => void) =>
    ro || !list.length ? null : <PlainSelect label={placeholder} placeholder={placeholder} className="tx-add__pick" value="" options={opts(list)} onChange={(x) => x && onPick(x)} />;
  const row = (title: string, hint: string, body: ReactNode) => (
    <div className="tx-labels__row">
      <div className="tx-labels__kind">
        <span className="medium">{title}</span>
        <span className="tx-labels__hint">{hint}</span>
      </div>
      <div className="tx-labels__chips">{body}</div>
    </div>
  );
  return (
    <Sec title="Quan hệ">
      <div className="tx-labels">
        {row(
          "Thuộc",
          "Khái niệm nằm dưới từng khái niệm này",
          <>
            {broader.length ? broader.map((b) => chip(b, () => void edit(c, { broader: broader.filter((x) => x !== b) }, `Không còn nằm dưới ${label(b)}`))) : <span className="muted">Không có: khái niệm gốc</span>}
            {pick("Thêm khái niệm cha…", broaderC, (x) => void edit(c, { broader: [...broader, x] }, `Giờ cũng nằm dưới ${label(x)}`))}
          </>,
        )}
        {row(
          "Liên quan",
          "Gần nghĩa, không ở trên cũng không ở dưới",
          <>
            {rel.length ? rel.map((r) => chip(r, () => unrelate(r))) : ro ? <span className="muted">Không có</span> : null}
            {pick("Thêm khái niệm liên quan…", relatedC, (x) => void edit(c, { related: [...(c.related ?? []), x] }, `Đã liên kết với ${label(x)}`))}
          </>,
        )}
      </div>
    </Sec>
  );
}

/* ── Mappings: system · code · label · match ── */

function MappingsSec({ concept: c, ro }: { concept: Concept; ro: boolean }) {
  const edit = useEditConcept();
  const maps = c.mappings ?? [];
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ system: "", code: "", label: "", match: "EXACT" as ConceptMapping["match"] });
  const [err, setErr] = useState("");
  const add = () => {
    const system = cleanLabel(f.system).toLowerCase();
    const code = cleanLabel(f.code);
    const problem = !system || !code ? "Nhập hệ thống và mã." : maps.some((m) => m.system === system && m.code === code) ? "Khái niệm đã có ánh xạ này." : "";
    setErr(problem);
    if (problem) return;
    const label = cleanLabel(f.label);
    void edit(c, { mappings: [...maps, { system, code, match: f.match, ...(label ? { label } : {}) }] }, `Đã ánh xạ tới ${system} ${code}`);
    setF({ system: "", code: "", label: "", match: "EXACT" });
    setOpen(false);
  };
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    add();
  };
  const field = (key: "system" | "code" | "label", placeholder: string, autoFocus = false) => (
    <TextField value={f[key]} onChange={(v) => setF({ ...f, [key]: v })} aria-label={placeholder} autoFocus={autoFocus}>
      <Input placeholder={placeholder} spellCheck={false} onKeyDown={onEnter} />
    </TextField>
  );
  return (
    <Sec title="Ánh xạ" desc="Cùng ý nghĩa trong một danh mục bên ngoài, ví dụ mã của Bộ.">
      {maps.length ? (
        <ul className="tx-maps">
          {maps.map((m, i) => (
            <li key={`${m.system}:${m.code}`} className="tx-map">
              <span className="tx-map__sys" translate="no">
                {m.system}
              </span>
              <span className="tx-map__code" translate="no">
                {m.code}
              </span>
              <span className="tx-map__label" translate="no">
                {m.label ?? ""}
              </span>
              <StatusChip label={MATCH.find(([k]) => k === m.match)?.[1] ?? m.match} size="sm" dot={false} />
              {ro ? null : <IconButton icon={X} tip="Xóa ánh xạ" size="sm" onPress={() => void edit(c, { mappings: maps.filter((_, j) => j !== i) }, "Đã xóa ánh xạ")} />}
            </li>
          ))}
        </ul>
      ) : ro ? (
        <p className="tx-sec__empty">Không có</p>
      ) : null}
      {!ro && open ? (
        <div className="tx-map-form">
          {field("system", "Hệ thống, ví dụ moet-program", true)}
          {field("code", "Mã")}
          {field("label", "Nhãn (không bắt buộc)")}
          <PlainSelect label="Mức khớp" value={f.match} options={MATCH} onChange={(v) => setF({ ...f, match: v as ConceptMapping["match"] })} />
          <Button variant="ghost" size="sm" onPress={() => (setOpen(false), setErr(""))}>
            Hủy
          </Button>
          <Button variant="secondary" size="sm" onPress={add}>
            Thêm
          </Button>
          {err ? (
            <div className="field-error" role="alert">
              {err}
            </div>
          ) : null}
        </div>
      ) : null}
      {!ro && !open ? (
        <Button variant="ghost" size="sm" onPress={() => setOpen(true)}>
          <Plus className="i" aria-hidden />
          Thêm ánh xạ
        </Button>
      ) : null}
    </Sec>
  );
}

/* ── Recognition patterns (document types): regular expressions over the title and number ── */

function PatternsSec({ concept: c, ro }: { concept: Concept; ro: boolean }) {
  const edit = useEditConcept();
  const pats = c.matchPatterns ?? [];
  const [err, setErr] = useState("");
  const add = (raw: string) => {
    const v = raw.trim();
    let ok = true;
    try {
      new RegExp(v, "iu");
    } catch {
      ok = false;
    }
    const problem = !ok ? "Mẫu này không hợp lệ." : pats.includes(v) ? "Khái niệm đã có mẫu này." : "";
    setErr(problem);
    if (problem) return false;
    void edit(c, { matchPatterns: [...pats, v] }, `Đã thêm mẫu ${v}`);
  };
  return (
    <Sec title="Mẫu nhận diện" desc="Tiêu đề hoặc số hiệu khớp một trong các mẫu này thuộc loại này, không cần hỏi trợ lý.">
      <div className="tx-labels__chips">
        {pats.map((p, i) => (
          <Chip key={p} code text={p} onRemove={ro ? undefined : () => void edit(c, { matchPatterns: pats.filter((_, j) => j !== i) }, "Đã xóa mẫu")} />
        ))}
        {!pats.length && ro ? <span className="muted">Không có</span> : null}
        {!ro && pats.length < MAX_PATTERNS ? <Adder code placeholder="ví dụ /QĐ- hoặc ^QUY CHẾ" onAdd={add} /> : null}
      </div>
      {err ? (
        <div className="field-error" role="alert">
          {err}
        </div>
      ) : null}
    </Sec>
  );
}

/* ── Rules that file documents here (read-only: they belong to collections and sources) ── */

function RulesSec({ taxonomy: t, concept }: { taxonomy: Taxonomy; concept: string }) {
  const rules = useConceptRules(concept).data ?? [];
  const when = useRuleWhen(t, rules);
  if (!rules.length) return null;
  return (
    <Sec title="Quy tắc" desc="“Luôn luôn” quyết định ngay mà không hỏi trợ lý; “Dễ được chọn hơn” chỉ làm nghiêng cán cân.">
      <ul className="tx-rulexs">
        {rules.map((r) => (
          <li key={r.name} className="tx-rulex">
            <span className="tx-rulex__eff">{r.effect === "IMPLIES" ? "Luôn luôn" : "Dễ được chọn hơn"}</span>
            <span>{when(r)}</span>
            {r.effect === "PRIOR" && r.weight != null ? <span className="muted">{`· ${fmtNum(Math.round(r.weight * 100))}%`}</span> : null}
          </li>
        ))}
      </ul>
    </Sec>
  );
}

/* ── A top concept's color (display only; narrower concepts inherit it) ── */

function ColorSec({ concept: c }: { concept: Concept }) {
  const edit = useEditConcept();
  return (
    <Sec title="Màu" desc="Các khái niệm bên dưới cũng dùng màu này: trong danh sách này, trên thẻ tài liệu và trong Tra cứu.">
      <ColorPicker
        value={c.color ?? ""}
        onChange={(color) => {
          if (color !== (c.color ?? "").toLowerCase()) void edit(c, { color }, "Đã đổi màu");
        }}
      />
    </Sec>
  );
}
