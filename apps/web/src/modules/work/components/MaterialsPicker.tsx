"use client";

import { Checkbox } from "@heroui/react";
import { Files } from "lucide-react";
import type { ReactNode } from "react";

import { EmptyState, ErrorState, FileIcon, SearchInput, SkeletonRows, StatusChip } from "@/components/ui";
import { fmtNum, fmtSize } from "@/lib/format";
import type { Item } from "@/modules/knowledge/api";

import { docStatus, isUsableDoc, type DocGroup } from "../queries";

interface Props {
  groups: DocGroup[] | undefined;
  isPending: boolean;
  error: unknown;
  onRetry: () => void;
  /** Selected document names. */
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  q: string;
  onQ: (q: string) => void;
  spaceName?: string;
}

function DocCheckbox({ doc, isSelected, onToggle }: { doc: Item; isSelected: boolean; onToggle: () => void }) {
  const ok = isUsableDoc(doc);
  const status = docStatus(doc);
  return (
    <div className={`work-pick__doc${isSelected ? " is-on" : ""}`}>
      <Checkbox isSelected={isSelected} isDisabled={!ok} onChange={onToggle}>
        <Checkbox.Content>
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
          <span className="checkbox__label">
            <span className="work-pick__name">
              <FileIcon mime={doc.document?.mimeType} name={doc.document?.fileName} size="sm" />
              <span className="truncate" translate="no">
                {doc.displayName}
              </span>
            </span>
          </span>
        </Checkbox.Content>
      </Checkbox>
      <span className="work-pick__meta">{status === "ready" ? fmtSize(doc.document?.sizeBytes) : <StatusChip kind="doc" value={status} />}</span>
    </div>
  );
}

/** Checklist of documents grouped by collection, with search and Select all (preview `sourcePicker`). */
export function MaterialsPicker({ groups, isPending, error, onRetry, selected, onChange, q, onQ, spaceName }: Props) {
  if (isPending) return <SkeletonRows rows={4} />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (!groups?.length)
    return (
      <EmptyState
        icon={Files}
        title="No materials here yet"
        description={spaceName ? `${spaceName} has no documents you can read.` : "Add documents to a knowledge base first."}
        boxed
        compact
      />
    );

  const needle = q.trim().toLowerCase();
  const shown = groups.map((g) => ({ ...g, docs: g.docs.filter((d) => !needle || (d.displayName ?? "").toLowerCase().includes(needle)) })).filter((g) => g.docs.length);
  const pickable = shown.flatMap((g) => g.docs).filter(isUsableDoc);
  const n = groups.flatMap((g) => g.docs).filter((d) => selected.has(d.name ?? "")).length;
  const on = pickable.filter((d) => selected.has(d.name ?? "")).length;
  const toggle = (name: string) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange(next);
  };
  const toggleAll = () => {
    const next = new Set(selected);
    const all = on === pickable.length;
    for (const d of pickable) {
      if (all) next.delete(d.name ?? "");
      else next.add(d.name ?? "");
    }
    onChange(next);
  };

  let body: ReactNode;
  if (shown.length)
    body = shown.map((g) => (
      <div key={g.collection} className="work-pick__group">
        <div className="t-label" translate="no">
          {g.label}
        </div>
        <div className="work-pick__list">
          {g.docs.map((d) => (
            <DocCheckbox key={d.name} doc={d} isSelected={selected.has(d.name ?? "")} onToggle={() => toggle(d.name ?? "")} />
          ))}
        </div>
      </div>
    ));
  else body = <div className="t-sm muted work-pick__none">No documents match “{q}”.</div>;

  return (
    <div className="work-pick">
      <div className="work-pick__bar">
        <SearchInput value={q} onChange={onQ} placeholder="Search documents" label="Search documents" />
        <span className="grow" />
        <span className="t-sm muted num">{n ? `${fmtNum(n)} selected` : "None selected"}</span>
      </div>
      {pickable.length ? (
        <div className="work-pick__all">
          <Checkbox isSelected={!!on && on === pickable.length} isIndeterminate={!!on && on < pickable.length} onChange={toggleAll}>
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              <span className="checkbox__label">{needle ? "Select all matches" : "Select all"}</span>
            </Checkbox.Content>
          </Checkbox>
        </div>
      ) : null}
      {body}
    </div>
  );
}
