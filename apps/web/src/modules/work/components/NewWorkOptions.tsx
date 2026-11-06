"use client";

import { Button, Input, TextField } from "@heroui/react";
import { Check, Plus } from "lucide-react";
import { useState } from "react";

import { Callout, ChoiceGroup, Segmented, SwitchRow } from "@/components/ui";

import type { WorkKind } from "../kinds";
import { DEFAULT_CRITERIA, DRAFT_TYPES, LENGTHS, SUGGESTED_CRITERIA, TONES, type DraftType, type Length, type Tone, type WorkOptions } from "../model";

interface Props {
  kind: WorkKind;
  opts: WorkOptions;
  onChange: (patch: Partial<WorkOptions>) => void;
  staffQuiz: boolean;
}

/** Kind-specific options in the new-work flow (preview `kind.options(f, ctx)`). */
export function NewWorkOptions({ kind, opts, onChange, staffQuiz }: Props) {
  if (kind === "EVIDENCE_REVIEW") return <ReviewOptions opts={opts} onChange={onChange} />;
  if (kind === "DRAFT") return <DraftOptions opts={opts} onChange={onChange} />;
  if (kind === "STUDY_GUIDE")
    return (
      <>
        <div className="field">
          <span className="label">Depth</span>
          <Segmented
            label="Depth"
            value={opts.depth ?? "full"}
            options={[
              { value: "quick", label: "Quick summary" },
              { value: "full", label: "Full guide" },
            ]}
            onChange={(depth) => onChange({ depth })}
          />
          <div className="description">{opts.depth === "quick" ? "A paragraph and the key terms." : "Summary, key terms and a worked example."}</div>
        </div>
        <div className="field">
          <SwitchRow
            title="Include check-yourself questions"
            description="A few open questions to test your understanding."
            isSelected={opts.check !== false}
            onChange={(check) => onChange({ check })}
          />
        </div>
      </>
    );
  return (
    <>
      <div className="field">
        <span className="label">Number of questions</span>
        <Segmented
          label="Number of questions"
          value={String(opts.count ?? (staffQuiz ? 8 : 5))}
          options={["5", "8", "10"].map((v) => ({ value: v, label: v }))}
          onChange={(v) => onChange({ count: Number(v) })}
        />
      </div>
      <div className="field">
        <span className="label">Difficulty</span>
        <Segmented
          label="Difficulty"
          value={opts.mix ?? "balanced"}
          options={[
            { value: "easy", label: "Mostly easy" },
            { value: "balanced", label: "Balanced" },
            { value: "hard", label: "Challenging" },
          ]}
          onChange={(mix) => onChange({ mix })}
        />
      </div>
      <div className="field">
        <span className="label">Question type</span>
        <div className="t-sm">Multiple choice · 4 answers · one correct</div>
      </div>
      <div className="field">
        {staffQuiz ? (
          <Callout tone="accent" title="For students — publish when ready" description="You review and edit every question first. Students see nothing until you publish." />
        ) : (
          <Callout title="Private practice" description="Only you see it. Each answer is checked right away, with its source." />
        )}
      </div>
    </>
  );
}

function ReviewOptions({ opts, onChange }: { opts: WorkOptions; onChange: (patch: Partial<WorkOptions>) => void }) {
  const [draft, setDraft] = useState("");
  const criteria = opts.criteria ?? [...DEFAULT_CRITERIA];
  const all = [...new Set([...DEFAULT_CRITERIA, ...SUGGESTED_CRITERIA, ...criteria])];
  const toggle = (label: string) => onChange({ criteria: criteria.includes(label) ? criteria.filter((c) => c !== label) : [...criteria, label] });
  const add = () => {
    const label = draft.trim();
    if (!label) return;
    if (!criteria.some((c) => c.toLowerCase() === label.toLowerCase())) onChange({ criteria: [...criteria, label] });
    setDraft("");
  };
  return (
    <div className="stack gap-16">
      <div className="field">
        <span className="label" id="rv-opt-label">
          Compare sources on
        </span>
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
          <TextField aria-label="Add your own criterion" value={draft} onChange={setDraft} className="grow">
            <Input
              placeholder="Add your own, e.g. Cost"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
            />
          </TextField>
          <Button size="sm" variant="tertiary" onPress={add}>
            Add
          </Button>
        </div>
        <div className="description">Each criterion becomes a column. Every cell cites the passage it comes from.</div>
      </div>
      <div className="field">
        <span className="label">Sources at most</span>
        <Segmented
          label="Sources at most"
          value={String(opts.maxPapers ?? 6)}
          options={["4", "6", "8"].map((v) => ({ value: v, label: v }))}
          onChange={(v) => onChange({ maxPapers: Number(v) })}
        />
      </div>
    </div>
  );
}

function DraftOptions({ opts, onChange }: { opts: WorkOptions; onChange: (patch: Partial<WorkOptions>) => void }) {
  return (
    <div className="stack gap-16">
      <div className="field">
        <span className="label">What are you writing?</span>
        <ChoiceGroup
          label="What are you writing?"
          value={opts.type ?? "email"}
          options={DRAFT_TYPES.map(([value, title, description]) => ({ value, title, description }))}
          onChange={(type: DraftType) => onChange({ type })}
        />
      </div>
      <div className="dr-optrow">
        <div className="field">
          <span className="label">Tone</span>
          <Segmented label="Tone" value={opts.tone ?? "formal"} options={TONES.map(([value, label]) => ({ value, label }))} onChange={(tone: Tone) => onChange({ tone })} />
        </div>
        <div className="field">
          <span className="label">Length</span>
          <Segmented label="Length" value={opts.length ?? "medium"} options={LENGTHS.map(([value, label]) => ({ value, label }))} onChange={(length: Length) => onChange({ length })} />
        </div>
      </div>
    </div>
  );
}
