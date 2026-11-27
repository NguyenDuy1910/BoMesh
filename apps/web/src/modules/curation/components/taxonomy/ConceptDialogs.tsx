"use client";

import { Button, Checkbox, Description, FieldError, Input, Label, TextArea, TextField } from "@heroui/react";
import { CircleAlert, GitCompare, ListTree, Plus, Tag } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import type { Concept, ConceptScheme } from "@/modules/knowledge/api";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";
import { conceptLabel, conceptLabels, conceptPathText, conceptsOf, descendantsOf, normLabel, schemeLabel, schemeOfConcept, type Taxonomy } from "@/modules/knowledge/taxonomy";

import { cleanLabel, depthOf, nameClash } from "../../governance";
import { PlainSelect } from "../parts";

/** Concepts a new or accepted concept may sit under: those of the scheme that leave room for one more level. */
export const parentOptions = (t: Taxonomy, scheme: ConceptScheme) =>
  conceptsOf(t, scheme.name ?? "")
    .filter((c) => depthOf(t, c.name ?? "") < (scheme.maxDepth || 9))
    .map((c) => [c.name ?? "", conceptPathText(t, c.name ?? "")] as const);

const UNDER_TOP = [["", "Không: khái niệm gốc"]] as const;

/** What New concept and Accept the proposal create: a name, where it sits, a definition. */
export interface ConceptDraft {
  name: string;
  broader: string;
  definition: string;
}

/**
 * New concept (preview `M['tx-new']`) and Accept the proposal (`M['tx-accept']`): name, Under, Definition; a name the
 * scheme already has stays open with why. `onSubmit` creates the draft (the dialog closes once it resolves true).
 */
export function ConceptDraftDialog({
  taxonomy,
  scheme,
  initial,
  title,
  description,
  submitLabel,
  icon = Plus,
  onSubmit,
  onClose,
}: {
  taxonomy: Taxonomy;
  scheme: ConceptScheme;
  initial: ConceptDraft;
  title: string;
  description: string;
  submitLabel: string;
  icon?: typeof Plus;
  onSubmit: (draft: ConceptDraft) => Promise<boolean>;
  onClose: () => void;
}) {
  const [f, setF] = useState(initial);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = cleanLabel(f.name);
  const clash = name ? nameClash(taxonomy, scheme.name ?? "", name) : undefined;
  const err = !tried ? "" : !name ? "Nhập tên." : clash ? `${schemeLabel(scheme)} đã có “${name}”.` : "";
  const submit = async () => {
    setTried(true);
    if (!name || clash) return;
    setBusy(true);
    const done = await onSubmit({ name, broader: f.broader, definition: f.definition.trim() });
    setBusy(false);
    if (done) onClose();
  };
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    void submit();
  };
  const Icon = icon;
  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      guard={busy}
      size="sm"
      icon={icon}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Hủy
          </Button>
          <Button variant="primary" onPress={() => void submit()} isPending={busy}>
            {busy ? null : <Icon className="i" aria-hidden />}
            {submitLabel}
          </Button>
        </>
      }
    >
      <TextField className="field" value={f.name} onChange={(name) => setF({ ...f, name })} isRequired isInvalid={!!err} isDisabled={busy} maxLength={120} autoFocus>
        <Label>Tên</Label>
        <Input onKeyDown={onEnter} />
        <FieldError>{err}</FieldError>
      </TextField>
      <div className="field">
        <span className="label">Nằm dưới</span>
        <PlainSelect label="Nằm dưới" value={f.broader} options={[...UNDER_TOP, ...parentOptions(taxonomy, scheme)]} onChange={(broader) => setF({ ...f, broader })} />
      </div>
      <TextField className="field" value={f.definition} onChange={(definition) => setF({ ...f, definition })} isDisabled={busy} maxLength={1000}>
        <Label>
          Định nghĩa <span className="label__opt">(không bắt buộc)</span>
        </Label>
        <TextArea rows={2} />
        <Description>Bắt buộc trước khi công bố.</Description>
      </TextField>
    </KnowledgeModal>
  );
}

/**
 * Merge into one concept, or split into several (preview `M['tx-replace']`): the concept is retired and replaced; its
 * documents follow when the scheme is published. Merge can keep its name as an alternative label of the target.
 */
export function ReplaceDialog({
  taxonomy,
  concept: c,
  mode,
  onConfirm,
  onClose,
}: {
  taxonomy: Taxonomy;
  concept: Concept;
  mode: "merge" | "split";
  onConfirm: (targets: string[], keepName: boolean) => void;
  onClose: () => void;
}) {
  const [into, setInto] = useState("");
  const [picks, setPicks] = useState<string[]>([]);
  const [keep, setKeep] = useState(true);
  const [err, setErr] = useState("");
  const name = c.name ?? "";
  const label = conceptLabel(taxonomy, name);
  const below = new Set(descendantsOf(taxonomy, name));
  const cands = conceptsOf(taxonomy, schemeOfConcept(name)).filter((o) => o.name !== name && !below.has(o.name ?? ""));
  const merge = mode === "merge";
  const go = () => {
    const targets = merge ? [into].filter(Boolean) : picks;
    const problem = merge ? (targets.length ? "" : "Chọn khái niệm để gộp vào.") : targets.length < 2 ? "Chọn ít nhất hai khái niệm." : "";
    setErr(problem);
    if (problem) return;
    onConfirm(targets, merge && keep);
    onClose();
  };
  const error = err ? (
    <div className="field-error" role="alert">
      <CircleAlert className="i" aria-hidden />
      <span>{err}</span>
    </div>
  ) : null;
  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      size="md"
      icon={merge ? GitCompare : ListTree}
      title={merge ? `Gộp “${label}”` : `Tách “${label}”`}
      description={
        merge
          ? "Khái niệm sẽ ngừng dùng và tài liệu của nó chuyển sang khái niệm bạn chọn khi công bố. Không tài liệu nào phải phân loại lại."
          : "Khái niệm sẽ ngừng dùng, và khi công bố, tài liệu của nó được phân loại lại giữa các khái niệm bạn chọn."
      }
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>
            Hủy
          </Button>
          <Button variant="primary" onPress={go}>
            {merge ? "Gộp" : "Tách"}
          </Button>
        </>
      }
    >
      <div className="stack gap-12">
        {merge ? (
          <>
            <div className="field">
              <span className="label">Gộp vào</span>
              <PlainSelect
                label="Gộp vào"
                placeholder="Chọn một khái niệm"
                value={into}
                options={cands.map((o) => [o.name ?? "", conceptPathText(taxonomy, o.name ?? "")] as const)}
                onChange={(v) => (setInto(v), setErr(""))}
              />
              {error}
            </div>
            <Checkbox isSelected={keep} onChange={setKeep}>
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                Giữ tên của nó làm nhãn thay thế ở đó
              </Checkbox.Content>
            </Checkbox>
          </>
        ) : (
          <div className="field">
            <span className="label">Tách thành</span>
            <ul className="tx-picklist" aria-label="Tách thành">
              {cands.map((o) => {
                const on = picks.includes(o.name ?? "");
                return (
                  <li key={o.name}>
                    <Checkbox isSelected={on} onChange={() => (setPicks((p) => (on ? p.filter((x) => x !== o.name) : [...p, o.name ?? ""])), setErr(""))}>
                      <Checkbox.Content>
                        <Checkbox.Control>
                          <Checkbox.Indicator />
                        </Checkbox.Control>
                        <span translate="no">{conceptPathText(taxonomy, o.name ?? "")}</span>
                      </Checkbox.Content>
                    </Checkbox>
                  </li>
                );
              })}
            </ul>
            {error}
            <p className="description">Chọn từ hai khái niệm trở lên. Thêm các khái niệm mới trước nếu chưa có.</p>
          </div>
        )}
      </div>
    </KnowledgeModal>
  );
}

/** Move a label to another concept of the scheme (preview `M['tx-move-label']`): the ones without that label already. */
export function MoveLabelDialog({
  taxonomy,
  concept,
  text,
  onMove,
  onClose,
}: {
  taxonomy: Taxonomy;
  concept: string;
  text: string;
  onMove: (to: Concept) => void;
  onClose: () => void;
}) {
  const [to, setTo] = useState("");
  const [err, setErr] = useState("");
  const k = normLabel(text);
  const cands = conceptsOf(taxonomy, schemeOfConcept(concept)).filter((o) => o.name !== concept && !conceptLabels(o).some((l) => normLabel(l.text) === k));
  const go = () => {
    const target = cands.find((o) => o.name === to);
    if (!target) {
      setErr("Chọn một khái niệm.");
      return;
    }
    onMove(target);
    onClose();
  };
  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      size="sm"
      icon={Tag}
      title={`Di chuyển “${text}”`}
      description={
        <>
          <span>Từ</span> <span translate="no">{conceptLabel(taxonomy, concept)}</span>
        </>
      }
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>
            Hủy
          </Button>
          <Button variant="primary" onPress={go}>
            Chuyển nhãn
          </Button>
        </>
      }
    >
      <div className="field">
        <span className="label">Di chuyển đến</span>
        <PlainSelect
          label="Di chuyển đến"
          placeholder="Chọn một khái niệm"
          value={to}
          options={cands.map((o) => [o.name ?? "", conceptPathText(taxonomy, o.name ?? "")] as const)}
          onChange={(v) => (setTo(v), setErr(""))}
        />
        {err ? <div className="field-error">{err}</div> : null}
      </div>
    </KnowledgeModal>
  );
}
