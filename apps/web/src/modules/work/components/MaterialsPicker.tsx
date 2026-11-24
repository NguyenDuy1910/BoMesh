"use client";

import { Checkbox } from "@heroui/react";
import { Files } from "lucide-react";
import type { ReactNode } from "react";

import { EmptyState, ErrorState, FileIcon, Pager, SearchInput, SkeletonRows, StatusChip } from "@/components/ui";
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
  /** How many sources the workflow can use at once; the counter says so ("3 selected · up to 8"). */
  max?: number;
  /** The server page shown (the picker lists one page of documents at a time). */
  pager: { page: number; pageSize: number; total?: number; hasNext: boolean; onPageChange: (page: number) => void };
}

/** Search appears from this many documents, or while a search is in use (preview `needsTools`). */
const TOOLS_MIN = 7;

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
export function MaterialsPicker({ groups, isPending, error, onRetry, selected, onChange, q, onQ, spaceName, max, pager }: Props) {
  if (isPending) return <SkeletonRows rows={4} />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (!groups?.length && !q)
    return (
      <EmptyState
        icon={Files}
        title="Chưa có tài liệu ở đây"
        description={spaceName ? `${spaceName} không có tài liệu bạn có thể đọc.` : "Hãy thêm tài liệu vào kho tài liệu trước."}
        boxed
        compact
      />
    );

  const needle = q.trim().toLowerCase();
  const shown = (groups ?? []).map((g) => ({ ...g, docs: g.docs.filter((d) => !needle || (d.displayName ?? "").toLowerCase().includes(needle)) })).filter((g) => g.docs.length);
  const pickable = shown.flatMap((g) => g.docs).filter(isUsableDoc);
  const n = selected.size;
  const over = !!max && n > max;
  const count = max ? `${n ? `Đã chọn ${fmtNum(n)}` : "Chưa chọn"} · tối đa ${fmtNum(max)}` : n ? `Đã chọn ${fmtNum(n)}` : "Chưa chọn";
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
  else body = <div className="t-sm muted work-pick__none">{`Không có tài liệu khớp với “${q}”.`}</div>;

  return (
    <div className="work-pick">
      <div className="work-pick__bar">
        {(pager.total ?? 0) >= TOOLS_MIN || pager.hasNext || q ? <SearchInput value={q} onChange={onQ} placeholder="Tìm kiếm tài liệu" label="Tìm kiếm tài liệu" /> : null}
        <span className="grow" />
        <span className={`t-sm num ${over ? "work-pick__over" : "muted"}`} aria-live="polite">
          {count}
        </span>
      </div>
      {pickable.length ? (
        <div className="work-pick__all">
          <Checkbox isSelected={!!on && on === pickable.length} isIndeterminate={!!on && on < pickable.length} onChange={toggleAll}>
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              <span className="checkbox__label">{needle ? "Chọn tất cả kết quả khớp" : "Chọn tất cả"}</span>
            </Checkbox.Content>
          </Checkbox>
        </div>
      ) : null}
      {body}
      {pager.page > 1 || pager.hasNext ? <Pager page={pager.page} pageSize={pager.pageSize} total={pager.total} hasNext={pager.hasNext} onPageChange={pager.onPageChange} /> : null}
    </div>
  );
}
