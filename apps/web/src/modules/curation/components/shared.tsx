"use client";

import { Button, Dropdown, Header, Label, Separator } from "@heroui/react";
import { ChevronDown, MoreHorizontal, Tag, type LucideIcon } from "lucide-react";
import { Fragment, useMemo, useState, type ReactNode } from "react";

import { FileIcon, IconButton, toast, type DataTableSort, type RowAction } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { updateItem } from "@/modules/knowledge/api";
import { topicTree, type Resource } from "@/modules/knowledge/model";

import { useAllTopics, useInvalidateCuration } from "../queries";
import { toCsv } from "../topicSheet";

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

/** Adds a topic to documents (keeps their other topics). Undo restores each document's previous topics. */
export function useApplyTopic() {
  const { id: ws } = useWorkspace();
  const invalidate = useInvalidateCuration();
  const topics = useAllTopics();
  return async (docs: readonly Resource[], topic: string, onDone?: () => void) => {
    const label = topics.data?.find((t) => t.name === topic)?.displayName ?? "chủ đề";
    const targets = docs.filter((r) => r.editable && !r.topics.includes(topic));
    if (!targets.length) {
      toast(`Đã gắn thẻ “${label}”`, { tone: "accent" });
      return;
    }
    const setTopics = (r: Resource, next: string[]) =>
      updateItem(ws, r.name, { document: { purpose: r.item.document?.purpose ?? "KNOWLEDGE", topics: next } }, ["document.topics"]);
    try {
      await Promise.all(targets.map((r) => setTopics(r, [...r.topics, topic])));
      invalidate();
      onDone?.();
      toast(targets.length === 1 ? `Đã thêm “${label}” vào ${targets[0].title}` : `Đã thêm “${label}” vào ${plural(targets.length, "document")}`, {
        undo: () =>
          void Promise.all(targets.map((r) => setTopics(r, r.topics))).then(invalidate, (error: unknown) => {
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

/** "Add topic" / "Apply topic" menu: active topics grouped by domain (preview `MENUS['kh-topic']`). */
export function TopicMenu({ label, onPick, variant = "tertiary", chevron = false }: { label: string; onPick: (topic: string) => void; variant?: "tertiary" | "ghost"; chevron?: boolean }) {
  const topics = useAllTopics();
  const tree = useMemo(() => topicTree(topics.data ?? []).filter((d) => d.children.length), [topics.data]);
  return (
    <Dropdown>
      <Button size="sm" variant={variant}>
        <Tag className="i" aria-hidden />
        {label}
        {chevron ? <ChevronDown className="i" aria-hidden /> : null}
      </Button>
      <Dropdown.Popover placement="bottom end">
        {tree.length ? (
          <Dropdown.Menu aria-label={label} onAction={(key) => onPick(String(key))}>
            {tree.map((d) => (
              <Dropdown.Section key={d.name}>
                <Header translate="no">{d.displayName}</Header>
                {d.children.map((t) => (
                  <Dropdown.Item key={t.name} id={t.name ?? ""} textValue={t.displayName}>
                    <Tag className="i" aria-hidden />
                    <Label translate="no">{t.displayName}</Label>
                  </Dropdown.Item>
                ))}
              </Dropdown.Section>
            ))}
          </Dropdown.Menu>
        ) : (
          <Dropdown.Menu aria-label={label} disabledKeys={["none"]}>
            <Dropdown.Item id="none" textValue="Chưa có chủ đề">
              <Label>Chưa có chủ đề</Label>
            </Dropdown.Item>
          </Dropdown.Menu>
        )}
      </Dropdown.Popover>
    </Dropdown>
  );
}
