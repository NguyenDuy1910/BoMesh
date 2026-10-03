"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { Dropdown, DropdownItem, DropdownLabel, DropdownSeparator } from "@/components/ui/Dropdown";
import type { WorkspaceKnowledgeDocument } from "@/modules/knowledge/workspace-repository";
import { pluralize } from "@/modules/workspace-control/format";

interface SelectionGroup {
  label: string;
  ids: string[];
}

/**
 * Selects the documents the list shows, all at once or by what they have in
 * common.
 *
 * The checkbox ticks or clears everything shown; the menu beside it picks a
 * group. Status groups are the backend's own Ingestion statuses, as it
 * reports them, so the menu grows with the backend rather than with a list
 * kept here. Groups only ever draw from the shown rows, so a search or a
 * filter narrows them too, and a group that would select nothing is not
 * offered. Choosing a group replaces the selection.
 */
export function DocumentSelectMenu({
  documents,
  selection,
  onSelect,
}: {
  /** The rows currently shown, after scope, search and filters. */
  documents: WorkspaceKnowledgeDocument[];
  selection: string[];
  onSelect: (ids: string[]) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const selected = new Set(selection);
  const selectedShown = documents.filter((document) => selected.has(document.id)).length;
  const all = selectedShown > 0 && selectedShown === documents.length;
  const mixed = selectedShown > 0 && !all;
  useEffect(() => {
    // Mixed is a DOM property, never an attribute.
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);

  const { statuses, types } = useMemo(() => ({
    // The backend's own Ingestion status, never a label derived here. A
    // document with no Ingestion (written by a connector) has none to group by.
    statuses: groupBy(documents, (document) => document.latestIngestion?.status.replaceAll("_", " ") ?? ""),
    types: groupBy(documents, (document) => document.fileTypeLabel ?? ""),
  }), [documents]);

  const item = (group: SelectionGroup) => (
    <DropdownItem key={group.label} onClick={() => onSelect(group.ids)}>
      <span className="flex-1 first-letter:uppercase">{group.label}</span>
      <span className="text-[var(--text-tertiary)]">{group.ids.length.toLocaleString()}</span>
    </DropdownItem>
  );

  return (
    <span className="knowledge-select-menu">
      <input
        aria-label={`Select all ${pluralize(documents.length, "document")}`}
        checked={all}
        className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-[var(--accent-primary)]"
        // A mixed selection completes to everything shown; only a full one clears.
        onChange={() => onSelect(all ? [] : documents.map((document) => document.id))}
        ref={ref}
        title="Select all shown"
        type="checkbox"
      />
      <Dropdown
        align="left"
        ariaLabel="Select documents by status or type"
        buttonClassName="knowledge-icon-button knowledge-select-menu__trigger"
        label={<ChevronDown aria-hidden="true" size={14} />}
        showChevron={false}
        title="Select by status or type"
      >
        {item({ label: "All shown", ids: documents.map((document) => document.id) })}
        {statuses.length > 0 && (
          <>
            <DropdownSeparator />
            <DropdownLabel>Ingestion status</DropdownLabel>
            {statuses.map(item)}
          </>
        )}
        {types.length > 0 && (
          <>
            <DropdownSeparator />
            <DropdownLabel>Type</DropdownLabel>
            {types.map(item)}
          </>
        )}
        {selection.length > 0 && (
          <>
            <DropdownSeparator />
            <DropdownItem onClick={() => onSelect([])}>None</DropdownItem>
          </>
        )}
      </Dropdown>
    </span>
  );
}

/** The documents sharing each label, largest group first. */
function groupBy(
  documents: WorkspaceKnowledgeDocument[],
  label: (document: WorkspaceKnowledgeDocument) => string,
): SelectionGroup[] {
  const groups = new Map<string, string[]>();
  for (const document of documents) {
    const key = label(document);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), document.id]);
  }
  return [...groups]
    .map(([key, ids]) => ({ label: key, ids }))
    .sort((left, right) => right.ids.length - left.ids.length || left.label.localeCompare(right.label));
}
