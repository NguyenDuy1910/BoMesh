"use client";

import { Button, Input, TextField } from "@heroui/react";
import { Check, Plus } from "lucide-react";
import { useState } from "react";

import { Callout, ChoiceGroup, Segmented, SwitchRow } from "@/components/ui";

import type { WorkKind } from "../kinds";
import { criteriaFor, DRAFT_TYPES, LENGTHS, suggestionsFor, TONES, type DraftType, type Length, type Tone, type WorkOptions } from "../model";

interface Props {
  kind: WorkKind;
  opts: WorkOptions;
  onChange: (patch: Partial<WorkOptions>) => void;
  staffQuiz: boolean;
  /** The chosen space's type: a review's criteria follow it until the person picks their own. */
  spaceType?: string;
}

/** Kind-specific options in the new-work flow (preview `kind.options(f, ctx)`). */
export function NewWorkOptions({ kind, opts, onChange, staffQuiz, spaceType }: Props) {
  if (kind === "EVIDENCE_REVIEW") return <ReviewOptions opts={opts} onChange={onChange} spaceType={spaceType} />;
  if (kind === "DRAFT") return <DraftOptions opts={opts} onChange={onChange} />;
  if (kind === "STUDY_GUIDE")
    return (
      <>
        <div className="field">
          <span className="label">Độ chi tiết</span>
          <Segmented
            label="Độ chi tiết"
            value={opts.depth ?? "full"}
            options={[
              { value: "quick", label: "Tóm tắt nhanh" },
              { value: "full", label: "Hướng dẫn đầy đủ" },
            ]}
            onChange={(depth) => onChange({ depth })}
          />
          <div className="description">{opts.depth === "quick" ? "Một đoạn văn và các thuật ngữ chính." : "Tóm tắt, thuật ngữ chính và một ví dụ minh họa."}</div>
        </div>
        <div className="field">
          <SwitchRow
            title="Kèm câu hỏi tự kiểm tra"
            description="Một vài câu hỏi mở để kiểm tra mức độ hiểu bài."
            isSelected={opts.check !== false}
            onChange={(check) => onChange({ check })}
          />
        </div>
      </>
    );
  return (
    <>
      <div className="field">
        <span className="label">Số câu hỏi</span>
        <Segmented
          label="Số câu hỏi"
          value={String(opts.count ?? (staffQuiz ? 8 : 5))}
          options={["5", "8", "10"].map((v) => ({ value: v, label: v }))}
          onChange={(v) => onChange({ count: Number(v) })}
        />
      </div>
      <div className="field">
        <span className="label">Độ khó</span>
        <Segmented
          label="Độ khó"
          value={opts.mix ?? "balanced"}
          options={[
            { value: "easy", label: "Phần lớn dễ" },
            { value: "balanced", label: "Cân bằng" },
            { value: "hard", label: "Thử thách" },
          ]}
          onChange={(mix) => onChange({ mix })}
        />
      </div>
      <div className="field">
        <span className="label">Loại câu hỏi</span>
        <div className="t-sm">Trắc nghiệm · 4 đáp án · một đáp án đúng</div>
      </div>
      <div className="field">
        {staffQuiz ? (
          <Callout tone="accent" title="Dành cho sinh viên — công bố khi sẵn sàng" description="Bạn duyệt và chỉnh sửa từng câu hỏi trước. Sinh viên sẽ không thấy gì cho đến khi bạn công bố." />
        ) : (
          <Callout title="Luyện tập riêng" description="Chỉ bạn nhìn thấy. Mỗi câu trả lời được chấm ngay, kèm nguồn." />
        )}
      </div>
    </>
  );
}

function ReviewOptions({ opts, onChange, spaceType }: { opts: WorkOptions; onChange: (patch: Partial<WorkOptions>) => void; spaceType?: string }) {
  const [draft, setDraft] = useState("");
  const criteria = opts.criteria ?? criteriaFor(spaceType);
  const all = [...new Set([...criteriaFor(spaceType), ...suggestionsFor(spaceType), ...criteria])];
  const toggle = (label: string) => onChange({ criteria: criteria.includes(label) ? criteria.filter((c) => c !== label) : [...criteria, label] });
  const add = () => {
    const label = draft.trim();
    if (!label) return;
    if (!criteria.some((c) => c.toLowerCase() === label.toLowerCase())) onChange({ criteria: [...criteria, label] });
    setDraft("");
  };
  return (
    <div className="field">
      <span className="label" id="rv-opt-label">
        So sánh các nguồn theo
      </span>
      <div className="description">Mỗi tiêu chí thành một cột. Mỗi ô đều trích dẫn đoạn văn gốc.</div>
      <div className="rv-chips" role="group" aria-labelledby="rv-opt-label">
        {all.map((label) => {
          const on = criteria.includes(label);
          return (
            <button key={label} type="button" className="rv-chip" aria-pressed={on} onClick={() => toggle(label)}>
              {on ? <Check className="i i-sm" aria-hidden /> : <Plus className="i i-sm" aria-hidden />}
              {label}
            </button>
          );
        })}
      </div>
      <div className="row gap-8 mt-8">
        <TextField aria-label="Tự thêm tiêu chí" value={draft} onChange={setDraft} className="grow">
          <Input
            placeholder="Tự thêm, ví dụ: Thời gian chuyển đổi"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
        </TextField>
        <Button size="sm" onPress={add}>
          Thêm
        </Button>
      </div>
    </div>
  );
}

function DraftOptions({ opts, onChange }: { opts: WorkOptions; onChange: (patch: Partial<WorkOptions>) => void }) {
  return (
    <div className="stack gap-16">
      <div className="field">
        <span className="label">Bạn đang viết gì?</span>
        <ChoiceGroup
          label="Bạn đang viết gì?"
          value={opts.type ?? "email"}
          options={DRAFT_TYPES.map(([value, title, description]) => ({ value, title, description }))}
          onChange={(type: DraftType) => onChange({ type })}
        />
      </div>
      <div className="dr-optrow">
        <div className="field">
          <span className="label">Giọng điệu</span>
          <Segmented label="Giọng điệu" value={opts.tone ?? "formal"} options={TONES.map(([value, label]) => ({ value, label }))} onChange={(tone: Tone) => onChange({ tone })} />
        </div>
        <div className="field">
          <span className="label">Độ dài</span>
          <Segmented label="Độ dài" value={opts.length ?? "medium"} options={LENGTHS.map(([value, label]) => ({ value, label }))} onChange={(length: Length) => onChange({ length })} />
        </div>
      </div>
    </div>
  );
}
