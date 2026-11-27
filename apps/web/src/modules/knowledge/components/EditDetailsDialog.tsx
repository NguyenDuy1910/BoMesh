"use client";

import { Autocomplete, Button, Description, FieldError, Input, Label, ListBox, SearchField, Select, TextArea, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, FileText, Pencil, SlidersHorizontal, Tag, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Disclosure } from "@/components/ui/Disclosure";
import { FileIcon } from "@/components/ui/FileIcon";
import { IconButton } from "@/components/ui/IconButton";
import { toast } from "@/components/ui/Toast";
import { errorMessage } from "@/lib/api/client";
import { SEARCH_PAUSE_MS, useDebounced } from "@/lib/debounce";
import { fmtDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { quote, updateItem, type DocumentApplicability, type DocumentConcept, type DocumentIssuance, type Item } from "../api";
import { useShareMemberSearch } from "../bases/queries";
import { LANGS, languageName, toResource } from "../model";
import { invalidateKnowledge, knowledgeKeys, useItem, useItemsByName, useKnowledgeModel, useListItems, useMember } from "../queries";
import {
  acceptedConcepts,
  APPLICABILITY_LEVELS,
  assignmentsByScheme,
  authoritySchemes,
  classSchemes,
  conceptLabel,
  conceptPathText,
  conceptsOf,
  schemeByName,
  schemeLabel,
  suggestedConcepts,
  type Taxonomy,
} from "../taxonomy";
import { ConceptPicker } from "./ConceptPicker";
import { KnowledgeModal } from "./KnowledgeModal";

/** People the owner picker lists per search (one ListMembers page). */
const OWNER_OPTIONS = 20;

export interface EditDetailsDialogProps {
  item: string;
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Edit details (preview `M['res-edit']`): title, summary, the classification (one concept picker per classification
 * scheme; suggestions stay marked “Chờ duyệt”), Thông tin văn bản (number, issuing unit, dates, who it applies to and
 * what it replaces) where documents are issued by units, then language and owner. Editors only (`items.update`).
 */
export function EditDetailsDialog({ item, isOpen, onClose }: EditDetailsDialogProps) {
  const query = useItem(item);
  return query.data ? <EditDetailsForm key={query.data.etag} item={query.data} isOpen={isOpen} onClose={onClose} /> : null;
}

type Level = NonNullable<DocumentApplicability["level"]> | "";

/** Per classification scheme (name): its concepts, accepted (primary first) then the suggestions. */
const schemeConcepts = (t: Taxonomy, doc: Item["document"]) =>
  Object.fromEntries(assignmentsByScheme(t, doc?.concepts).map(({ scheme, items }) => [scheme.name ?? "", items.map((a) => a.concept!)]));

/** `document.concepts` input: every chosen concept; the first of a scheme that has a primary is it. */
function conceptEntries(t: Taxonomy, bySchemeName: Readonly<Record<string, readonly string[]>>): DocumentConcept[] {
  return classSchemes(t).flatMap((s) => (bySchemeName[s.name ?? ""] ?? []).map((concept, i) => ({ concept, primary: !!s.cardinality?.primary && i === 0 })));
}

/** Drop unset fields, so equal facts compare equal and empty ones are cleared. */
function compact<T extends object>(o: T): T | undefined {
  const out = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && !v.length))) as T;
  return Object.keys(out).length ? out : undefined;
}

/** A plain single-choice select (label, options as `[value, text]`; "" is a choice too). */
function PlainSelect({ label, value, options, onChange, isDisabled }: { label: string; value: string; options: readonly (readonly [string, string])[]; onChange: (v: string) => void; isDisabled?: boolean }) {
  return (
    <Select value={value || "__none"} onChange={(v) => onChange(v === "__none" ? "" : String(v))} isDisabled={isDisabled}>
      <Label>{label}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map(([v, text]) => (
            <ListBox.Item key={v || "__none"} id={v || "__none"} textValue={text}>
              {text}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="field">
    <span className="label">{label}</span>
    {children}
  </div>
);

function EditDetailsForm({ item, isOpen, onClose }: { item: Item; isOpen: boolean; onClose: () => void }) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const { ctx, taxonomy: t } = useKnowledgeModel();
  const r = toResource(item, ctx);
  const doc = item.document;
  const [ownerQ, setOwnerQ] = useState("");
  // The owner picker: the current owner, then one page of active members matching the search (name or email).
  const found = useShareMemberSearch(useDebounced(ownerQ, SEARCH_PAUSE_MS), OWNER_OPTIONS, { enabled: isOpen });
  // People edit the title; the file keeps its extension (the format badge already says PDF/MD).
  const ext = /\.[a-z0-9]{1,5}$/i.exec(item.displayName ?? "")?.[0] ?? "";
  const [title, setTitle] = useState((item.displayName ?? "").slice(0, (item.displayName ?? "").length - ext.length));
  const [lang, setLang] = useState(r.language.split("-")[0]);
  const [owner, setOwner] = useState(doc?.owner ?? "");
  const [summary, setSummary] = useState(doc?.summary ?? "");
  // Classification: what it's filed under, then what awaits review (both editable; suggestions stay marked).
  const [start] = useState(() => schemeConcepts(t, doc));
  const [concepts, setConcepts] = useState<Record<string, string[]>>(start);
  const [suggested, setSuggested] = useState(() => suggestedConcepts(doc?.concepts));
  const attention = !r.concepts.length || suggested.length > 0;
  // Thông tin văn bản.
  const iss = doc?.issuance;
  const app = doc?.applicability;
  const [number, setNumber] = useState(iss?.number ?? "");
  const [issued, setIssued] = useState(iss?.issueDate ?? "");
  const [effective, setEffective] = useState(iss?.effectiveDate ?? "");
  const [issuer, setIssuer] = useState(iss?.issuer ?? "");
  const [level, setLevel] = useState<Level>(app?.level ?? "");
  const [units, setUnits] = useState<string[]>(app?.units ?? []);
  const [programs, setPrograms] = useState<string[]>(app?.programs ?? []);
  const [cohorts, setCohorts] = useState((app?.cohorts ?? []).join(", "));
  const [supersedes, setSupersedes] = useState<string[]>(iss?.supersedes ?? []);
  const [factsOpen, setFactsOpen] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const titleError = touched && !title.trim() ? "Nhập tiêu đề." : "";

  const langs: [string, string][] = Object.entries(LANGS);
  if (!langs.some(([code]) => code === lang)) langs.push([lang, languageName(lang)]);
  const schemes = classSchemes(t);
  const names = schemes.flatMap((s) => concepts[s.name ?? ""] ?? []).map((c) => conceptLabel(t, c));
  const conceptSummary = names.length ? names.slice(0, 2).join(", ") + (names.length > 2 ? ` +${names.length - 2}` : "") : "Chưa có";
  /** Document facts are offered where documents are issued by units (the workspace has authority schemes), or when this one already carries them. */
  const factsOffered = authoritySchemes(t).length > 0 || !!iss || !!app;
  const orgScheme = schemeByName(t, "org-unit");
  const progScheme = schemeByName(t, "program");
  const orgs = orgScheme?.name ? conceptsOf(t, orgScheme.name) : [];
  const progs = progScheme?.name ? conceptsOf(t, progScheme.name) : [];
  const levels: [string, string][] = [
    ["", "Chưa thiết lập"],
    ["INSTITUTION", APPLICABILITY_LEVELS.INSTITUTION],
    ...(orgs.length ? ([["UNIT", APPLICABILITY_LEVELS.UNIT]] as [string, string][]) : []),
    ...(progs.length ? ([["PROGRAM", APPLICABILITY_LEVELS.PROGRAM], ["COHORT", APPLICABILITY_LEVELS.COHORT]] as [string, string][]) : []),
  ];
  const factSummary = [number, issued && fmtDate(new Date(`${issued}T00:00:00`))].filter(Boolean).join(" · ") || "Chưa có";
  // What it may replace: the documents of its own collection (read when the section opens), by title.
  const pool = useListItems(
    { filter: r.base ? `ancestors:${quote(r.base.name)} AND itemKind = DOCUMENT` : "itemKind = DOCUMENT", orderBy: "displayName", pageSize: 200, view: "BASIC" },
    { enabled: isOpen && factsOffered && factsOpen },
  );
  const chosen = useItemsByName(supersedes, { view: "BASIC", enabled: supersedes.length > 0 });
  const titleOf = (name: string) => {
    const known = chosen.items.get(name) ?? pool.data?.items?.find((i) => i.name === name);
    return known ? toResource(known, ctx).title : "Tài liệu";
  };
  const candidates = (pool.data?.items ?? []).filter((i) => i.name && i.name !== item.name && !supersedes.includes(i.name));

  const current = useMember(owner || null).data;
  const ownerName = current?.displayName;
  const ownerOptions = [...(current ? [current] : []), ...(found.data ?? []).filter((m) => m.name !== current?.name)];
  const moreSummary = [languageName(lang), ownerName].filter(Boolean).join(" · ");

  /** A scheme that holds at most `max` concepts swaps its last when full (preview `res-edit-concept-add`). */
  const setScheme = (scheme: string, next: string[]) => {
    const max = schemeByName(t, scheme)?.cardinality?.max;
    const added = next.filter((c) => !(concepts[scheme] ?? []).includes(c));
    setConcepts({ ...concepts, [scheme]: max && next.length > max ? [...next.slice(0, Math.max(0, max - 1)), ...added.slice(-1)] : next });
    if (added.length) setSuggested(suggested.filter((c) => !added.includes(c)));
  };

  async function save() {
    if (busy) return;
    setTouched(true);
    if (!title.trim()) return;
    const changedConcepts = schemes.some((s) => String(start[s.name ?? ""] ?? []) !== String(concepts[s.name ?? ""] ?? []));
    const issuance = compact<DocumentIssuance>({
      ...iss,
      number: number.trim(),
      issueDate: issued || undefined,
      effectiveDate: effective || undefined,
      issuer: issuer || undefined,
      supersedes,
    });
    const applicability: DocumentApplicability | undefined = level
      ? {
          level,
          units: level === "UNIT" ? units : [],
          programs: level === "PROGRAM" || level === "COHORT" ? programs : [],
          cohorts: level === "COHORT" ? [...new Set(cohorts.split(/\D+/).filter(Boolean).map(Number).filter((y) => y >= 1900 && y <= 2100))] : [],
        }
      : undefined;
    const next = {
      displayName: title.trim() + ext,
      languageCode: lang,
      owner: owner || undefined,
      summary: summary.trim(),
      concepts: conceptEntries(t, concepts),
      issuance,
      applicability,
    };
    const mask: string[] = [];
    if (next.displayName !== item.displayName) mask.push("displayName");
    if (lang !== (doc?.languageCode ?? "")) mask.push("document.languageCode");
    if (owner !== (doc?.owner ?? "")) mask.push("document.owner");
    if (next.summary !== (doc?.summary ?? "")) mask.push("document.summary");
    // Every scheme's whole-document concepts are set at once: what is listed is accepted, the rest rejected.
    if (changedConcepts) mask.push("document.concepts");
    if (factsOffered && JSON.stringify(issuance ?? null) !== JSON.stringify((iss && compact(iss)) ?? null)) mask.push("document.issuance");
    if (factsOffered && JSON.stringify(compact(applicability ?? {}) ?? null) !== JSON.stringify(compact(app ?? {}) ?? null)) mask.push("document.applicability");
    if (!mask.length) return onClose();
    const patchOf = (v: typeof next, etag: string | undefined): Item => ({
      displayName: v.displayName,
      etag,
      document: {
        purpose: doc?.purpose ?? "KNOWLEDGE",
        languageCode: v.languageCode,
        owner: v.owner,
        summary: v.summary,
        concepts: v.concepts,
        issuance: v.issuance,
        applicability: v.applicability,
      },
    });
    // Undo restores what it was filed under (the suggestions it had awaiting review can't be restored as suggestions).
    const accepted = new Set(acceptedConcepts(doc?.concepts));
    const prev = {
      displayName: item.displayName ?? "",
      languageCode: doc?.languageCode ?? "",
      owner: doc?.owner,
      summary: doc?.summary ?? "",
      concepts: (doc?.concepts ?? []).filter((a) => a.concept && accepted.has(a.concept)).map((a) => ({ concept: a.concept, primary: a.primary })),
      issuance: iss,
      applicability: app,
    };
    const refresh = () => {
      invalidateKnowledge(qc, ws);
      void qc.invalidateQueries({ queryKey: knowledgeKeys.item(ws, r.id) });
    };
    setBusy(true);
    try {
      const saved = await updateItem(ws, item.name ?? "", patchOf(next, item.etag), mask);
      refresh();
      onClose();
      toast("Đã lưu thông tin", {
        undo: () => void updateItem(ws, item.name ?? "", patchOf(prev, saved.etag), mask).then(refresh, (e: unknown) => toast(errorMessage(e), { tone: "danger" })),
      });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <KnowledgeModal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      guard={busy}
      title="Sửa chi tiết"
      icon={Pencil}
      description="Những gì mọi người thấy trong kết quả tìm kiếm, bản xem trước và trình đọc."
      footerStart="Thay đổi hiển thị cho mọi người ngay lập tức."
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Hủy
          </Button>
          <Button variant="primary" onPress={() => void save()} isPending={busy}>
            <Check className="i" aria-hidden />
            Lưu thay đổi
          </Button>
        </>
      }
    >
      <div className="kn-form">
        <TextField
          value={title}
          onChange={(v) => {
            setTitle(v);
            if (v.trim()) setTouched(false);
          }}
          isRequired
          isInvalid={!!titleError}
          isDisabled={busy}
          maxLength={160}
          autoFocus
        >
          <Label>Tiêu đề</Label>
          {/* On the Input (native event): React Aria's TextField onKeyDown stops propagation, so Esc never reached the modal. */}
          <Input onKeyDown={(e) => e.key === "Enter" && void save()} />
          <FieldError>{titleError}</FieldError>
        </TextField>
        <TextField value={summary} onChange={setSummary} maxLength={280} isDisabled={busy}>
          <Label>
            Tóm tắt <span className="label__opt">(không bắt buộc)</span>
          </Label>
          <TextArea rows={2} />
          <Description>Một hoặc hai câu hiển thị trong kết quả và bản xem trước.</Description>
        </TextField>
        <div className="stack gap-8">
          {schemes.length ? (
            <Disclosure title="Phân loại" icon={Tag} summary={<span translate="no">{conceptSummary}</span>} defaultOpen={attention}>
              <div className="res-schemes">
                {schemes.map((s) => (
                  <div key={s.name} className="res-scheme">
                    <span className="res-scheme__label" translate="no">
                      {schemeLabel(s)}
                    </span>
                    <ConceptPicker
                      value={concepts[s.name ?? ""] ?? []}
                      onChange={(v) => setScheme(s.name ?? "", v)}
                      taxonomy={t}
                      scheme={s.name}
                      label={schemeLabel(s)}
                      suggested={suggested}
                      isDisabled={busy}
                    />
                  </div>
                ))}
              </div>
            </Disclosure>
          ) : null}
          {factsOffered ? (
            <Disclosure title="Thông tin văn bản" icon={FileText} summary={<span translate="no">{factSummary}</span>} onOpenChange={(o: boolean) => o && setFactsOpen(true)}>
              <div className="kn-form res-facts-form">
                <div className="grid cols-2 res-more">
                  <TextField value={number} onChange={setNumber} maxLength={128} isDisabled={busy}>
                    <Label>Số hiệu</Label>
                    <Input placeholder="VD: 123/QĐ-ĐHCNKT-ĐT" />
                  </TextField>
                  {orgs.length ? (
                    <PlainSelect
                      label="Đơn vị ban hành"
                      value={issuer}
                      onChange={setIssuer}
                      isDisabled={busy}
                      options={[["", "Chưa thiết lập"], ...orgs.map((c) => [c.name ?? "", conceptPathText(t, c.name ?? "")] as const)]}
                    />
                  ) : null}
                  <TextField value={issued} onChange={setIssued} isDisabled={busy}>
                    <Label>Ngày ban hành</Label>
                    <Input type="date" />
                  </TextField>
                  <TextField value={effective} onChange={setEffective} isDisabled={busy}>
                    <Label>Ngày hiệu lực</Label>
                    <Input type="date" />
                  </TextField>
                </div>
                {orgs.length || progs.length ? (
                  <Field label="Phạm vi áp dụng">
                    <div className="stack gap-8">
                      <PlainSelect label="Phạm vi áp dụng" value={level} onChange={(v) => setLevel(v as Level)} isDisabled={busy} options={levels} />
                      {level === "UNIT" && orgScheme?.name ? (
                        <ConceptPicker value={units} onChange={setUnits} taxonomy={t} scheme={orgScheme.name} label={APPLICABILITY_LEVELS.UNIT} quiet isDisabled={busy} />
                      ) : (level === "PROGRAM" || level === "COHORT") && progScheme?.name ? (
                        <ConceptPicker value={programs} onChange={setPrograms} taxonomy={t} scheme={progScheme.name} label={APPLICABILITY_LEVELS.PROGRAM} quiet isDisabled={busy} />
                      ) : null}
                      {level === "COHORT" ? (
                        <TextField value={cohorts} onChange={setCohorts} maxLength={60} isDisabled={busy} aria-label="Khóa">
                          <Input placeholder="Năm nhập học, VD: 2022, 2023" />
                        </TextField>
                      ) : null}
                    </div>
                  </Field>
                ) : null}
                {supersedes.length || candidates.length ? (
                  <Field label="Thay thế">
                    <div className="stack gap-8">
                      {supersedes.length ? (
                        <ul className="res-sups">
                          {supersedes.map((name) => {
                            const known = chosen.items.get(name) ?? pool.data?.items?.find((i) => i.name === name);
                            return (
                              <li key={name} className="res-sup">
                                <FileIcon name={known?.document?.fileName || known?.displayName} mime={known?.document?.mimeType} size="sm" />
                                <span className="grow truncate" translate="no">
                                  {titleOf(name)}
                                </span>
                                <IconButton icon={X} tip={`Gỡ ${titleOf(name)}`} size="sm" onPress={() => setSupersedes(supersedes.filter((x) => x !== name))} isDisabled={busy} />
                              </li>
                            );
                          })}
                        </ul>
                      ) : null}
                      {candidates.length ? (
                        <Select
                          aria-label="Thêm văn bản bị thay thế"
                          className="res-sup__add"
                          placeholder="Thêm văn bản bị thay thế…"
                          value={null}
                          isDisabled={busy}
                          onChange={(v) => v && setSupersedes([...supersedes, String(v)])}
                        >
                          <Select.Trigger>
                            <Select.Value />
                            <Select.Indicator />
                          </Select.Trigger>
                          <Select.Popover>
                            <ListBox>
                              {candidates.map((i) => (
                                <ListBox.Item key={i.name} id={i.name ?? ""} textValue={toResource(i, ctx).title}>
                                  {toResource(i, ctx).title}
                                </ListBox.Item>
                              ))}
                            </ListBox>
                          </Select.Popover>
                        </Select>
                      ) : null}
                    </div>
                  </Field>
                ) : null}
              </div>
            </Disclosure>
          ) : null}
          <Disclosure title="Ngôn ngữ và chủ sở hữu" icon={SlidersHorizontal} summary={moreSummary}>
            <div className="grid cols-2 res-more">
              <Select value={lang} onChange={(v) => setLang(String(v))} isDisabled={busy}>
                <Label>Ngôn ngữ</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {langs.map(([code, label]) => (
                      <ListBox.Item key={code} id={code} textValue={label}>
                        {label}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
              <Select value={owner || "none"} onChange={(v) => setOwner(v === "none" ? "" : String(v))} isDisabled={busy}>
                <Label>
                  Chủ sở hữu <span className="label__opt">(không bắt buộc)</span>
                </Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Description>Người giữ cho tài liệu luôn chính xác.</Description>
                <Select.Popover>
                  <Autocomplete.Filter inputValue={ownerQ} onInputChange={setOwnerQ}>
                    <SearchField aria-label="Tìm kiếm người" autoFocus fullWidth className="search-input search-input--sm search-input--full">
                      <SearchField.Group>
                        <SearchField.SearchIcon />
                        <SearchField.Input placeholder="Tìm kiếm người" autoComplete="off" />
                        <SearchField.ClearButton aria-label="Xóa tìm kiếm" />
                      </SearchField.Group>
                    </SearchField>
                    <ListBox>
                      <ListBox.Item id="none" textValue="Chưa có chủ sở hữu">
                        Chưa có chủ sở hữu
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                      {ownerOptions.map((m) => (
                        <ListBox.Item key={m.name} id={m.name ?? ""} textValue={m.displayName ?? m.email ?? ""}>
                          {m.displayName ?? m.email}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Autocomplete.Filter>
                </Select.Popover>
              </Select>
            </div>
          </Disclosure>
        </div>
      </div>
    </KnowledgeModal>
  );
}
