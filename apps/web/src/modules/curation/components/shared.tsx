"use client";

import { Button, Dropdown, Header, Label, Separator } from "@heroui/react";
import { ChevronDown, MoreHorizontal, Tag, type LucideIcon } from "lucide-react";
import { Fragment, useMemo, useState, type ReactNode } from "react";

import { FileIcon, IconButton, toast, type DataTableSort, type RowAction } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { updateItem, type DocumentConcept } from "@/modules/knowledge/api";
import { conceptToneProps } from "@/modules/knowledge/components/ConceptTag";
import type { Resource } from "@/modules/knowledge/model";
import { useTaxonomy } from "@/modules/knowledge/queries";
import { assignableConcepts, classSchemes, conceptLabel, conceptPathText, schemeByName, schemeLabel, schemeOfConcept } from "@/modules/knowledge/taxonomy";

import { toCsv } from "../conceptSheet";
import { useInvalidateCuration } from "../queries";

/** Saves rows as a CSV file in the browser. */
export function saveCsv(fileName: string, rows: readonly (readonly string[])[]) {
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/** One ⋯ entry; `separated` starts a new group (a separator above it, as the preview's `{ sep: true }`). */
export type MenuAction = RowAction & { separated?: boolean };

/** A menu of actions behind an icon button (⋯ by default): the drawer head, rows outside a DataTable. */
export function ActionsMenu({ actions, label = "Thao tác khác", icon = MoreHorizontal }: { actions: readonly MenuAction[]; label?: string; icon?: LucideIcon }) {
  if (!actions.length) return null;
  return (
    <Dropdown>
      <IconButton icon={icon} tip={label} size="sm" showTip={false} />
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label={label} onAction={(key) => actions.find((a) => a.id === key)?.onAction()} disabledKeys={actions.filter((a) => a.isDisabled).map((a) => a.id)}>
          {actions.map((action, i) => {
            const Icon = action.icon;
            return (
              <Fragment key={action.id}>
                {action.separated && i > 0 ? <Separator /> : null}
                <Dropdown.Item id={action.id} textValue={action.label} variant={action.danger ? "danger" : "default"}>
                  {Icon ? <Icon className="i" aria-hidden /> : null}
                  <Label>{action.label}</Label>
                </Dropdown.Item>
              </Fragment>
            );
          })}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** Client-side sort of rows (a whole list before paging, or one server page). */
export function sortRows<T>(rows: readonly T[], sort: DataTableSort | null, getters: Readonly<Record<string, (row: T) => string | number>>): T[] {
  const get = sort ? getters[sort.column] : undefined;
  if (!sort || !get) return [...rows];
  const sign = sort.direction === "ascending" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    return sign * (typeof x === "string" && typeof y === "string" ? x.localeCompare(y) : Number(x) - Number(y));
  });
}

/** A document table's server order (ListItems `orderBy`): Document by name, else Updated, newest first by default. */
export const orderByOf = (sort: DataTableSort | null) =>
  sort?.column === "name" ? `displayName${sort.direction === "descending" ? " desc" : ""}` : `updateTime${sort?.column === "updated" && sort.direction === "ascending" ? "" : " desc"}`;

/** Keeps a selection in step with rows that still exist (rows vanish once fixed). */
export function useLiveSelection(valid: readonly string[]) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const key = valid.join("|");
  const selected = useMemo(() => {
    const ok = new Set(valid);
    return new Set([...picked].filter((id) => ok.has(id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures `valid`
  }, [picked, key]);
  return [selected, setPicked] as const;
}

/** Document cell: file tile, title, collection (workspace content stays untranslated). */
export function DocCell({ r, sub, size = "md", className = "row gap-12" }: { r: Resource; sub?: ReactNode; size?: "sm" | "md"; className?: string }) {
  return (
    <div className={className}>
      <FileIcon name={r.fileName} mime={r.mime} size={size} />
      <div className="grow kh-min">
        <div className="cell-title truncate" title={r.title} translate="no">
          {r.title}
        </div>
        <div className="cell-sub truncate" title={r.base?.displayName}>
          {sub ?? <span translate="no">{r.base?.displayName}</span>}
        </div>
      </div>
    </div>
  );
}

/** A document's accepted whole-document concepts as UpdateItem entries (primary kept). */
const acceptedEntries = (r: Resource): DocumentConcept[] =>
  r.assignments.filter((a) => a.state !== "SUGGESTED" && a.concept && !a.section).map((a) => ({ concept: a.concept, primary: !!a.primary }));

/**
 * Files documents under a concept, in its scheme (preview `applyConcept`): a scheme that takes at most n concepts drops
 * its oldest to make room, the others keep theirs. UpdateItem `document.concepts` sets the whole-document set, so every
 * accepted concept of the other schemes goes along. Undo restores each document's accepted concepts.
 */
export function useApplyConcept() {
  const { id: ws } = useWorkspace();
  const invalidate = useInvalidateCuration();
  const { data: taxonomy } = useTaxonomy();
  return async (docs: readonly Resource[], concept: string, onDone?: () => void) => {
    const label = conceptLabel(taxonomy, concept);
    const scheme = schemeOfConcept(concept);
    const max = schemeByName(taxonomy, scheme)?.cardinality?.max;
    const targets = docs.filter((r) => r.editable && !r.concepts.includes(concept));
    if (!targets.length) {
      toast(`Đã được xếp vào “${label}”`, { tone: "accent" });
      return;
    }
    const next = (r: Resource): DocumentConcept[] => {
      const entries = acceptedEntries(r);
      const mine = entries.filter((e) => schemeOfConcept(e.concept ?? "") === scheme);
      const keep = max ? mine.slice(Math.max(0, mine.length - max + 1)) : mine;
      return [...entries.filter((e) => schemeOfConcept(e.concept ?? "") !== scheme), ...keep, { concept, primary: false }];
    };
    const setConcepts = (r: Resource, concepts: DocumentConcept[]) =>
      updateItem(ws, r.name, { document: { purpose: r.item.document?.purpose ?? "KNOWLEDGE", concepts } }, ["document.concepts"]);
    try {
      await Promise.all(targets.map((r) => setConcepts(r, next(r))));
      invalidate();
      onDone?.();
      toast(targets.length === 1 ? `Đã xếp “${targets[0].title}” vào “${label}”` : `Đã xếp ${plural(targets.length, "document")} vào “${label}”`, {
        undo: () =>
          void Promise.all(targets.map((r) => setConcepts(r, acceptedEntries(r)))).then(invalidate, (error: unknown) => {
            invalidate();
            toast(errorMessage(error), { tone: "danger" });
          }),
      });
    } catch (error) {
      invalidate();
      toast(errorMessage(error), { tone: "danger" });
    }
  };
}

/** "Thêm khái niệm" menu (preview `MENUS['kh-concept']`): the assignable concepts of each scheme `docs` miss, by scheme. */
export function ConceptMenu({
  label,
  docs,
  onPick,
  variant = "tertiary",
  chevron = false,
}: {
  label: string;
  docs: readonly Resource[];
  onPick: (concept: string) => void;
  variant?: "tertiary" | "ghost" | "secondary";
  chevron?: boolean;
}) {
  const { data: taxonomy } = useTaxonomy();
  // The schemes none of `docs` has an accepted concept in (each one's missing classification), with what they offer.
  const groups = useMemo(
    () =>
      classSchemes(taxonomy)
        .filter((s) => docs.some((r) => !acceptedEntries(r).some((e) => schemeOfConcept(e.concept ?? "") === s.name)))
        .map((s) => ({ scheme: s, concepts: assignableConcepts(taxonomy, s.name ?? "") }))
        .filter((g) => g.concepts.length),
    [docs, taxonomy],
  );
  return (
    <Dropdown>
      <Button size="sm" variant={variant}>
        <Tag className="i" aria-hidden />
        {label}
        {chevron ? <ChevronDown className="i" aria-hidden /> : null}
      </Button>
      <Dropdown.Popover placement="bottom end">
        {groups.length ? (
          <Dropdown.Menu aria-label={label} onAction={(key) => onPick(String(key))}>
            {groups.map((g) => (
              <Dropdown.Section key={g.scheme.name}>
                <Header translate="no">{schemeLabel(g.scheme)}</Header>
                {g.concepts.map((c) => {
                  const name = c.name ?? "";
                  const { Icon } = conceptToneProps(taxonomy, name);
                  const path = conceptPathText(taxonomy, name);
                  return (
                    <Dropdown.Item key={name} id={name} textValue={path}>
                      <Icon className="i" aria-hidden />
                      <Label translate="no">{path}</Label>
                    </Dropdown.Item>
                  );
                })}
              </Dropdown.Section>
            ))}
          </Dropdown.Menu>
        ) : (
          <Dropdown.Menu aria-label={label} disabledKeys={["none"]}>
            <Dropdown.Item id="none" textValue="Chưa có khái niệm">
              <Label>Chưa có khái niệm</Label>
            </Dropdown.Item>
          </Dropdown.Menu>
        )}
      </Dropdown.Popover>
    </Dropdown>
  );
}
