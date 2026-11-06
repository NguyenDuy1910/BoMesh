"use client";

import { Button, Dropdown, Header, Label } from "@heroui/react";
import { useQueries } from "@tanstack/react-query";
import { ChevronDown, Tag } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { FileIcon, toast, type DataTableSort } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { testItemPermissions, updateItem } from "@/modules/knowledge/api";
import { topicTree, type Resource } from "@/modules/knowledge/model";
import { knowledgeKeys, useKnowledgeModel } from "@/modules/knowledge/queries";

import { inScope } from "../../governance";
import { useAllTopics, useCuratedItems, useInvalidateCuration } from "../../queries";

/** Abilities Quality checks per document beyond `ITEM_PERMISSIONS`: republish (sync) and merge (archive). */
const QUALITY_PERMISSIONS = ["ingestionRuns.create", "items.delete"] as const;
export type QualityPermission = (typeof QUALITY_PERMISSIONS)[number];

/** `can(item, permission)` from `items:testIamPermissions`, false until loaded. */
export function useQualityAbilities(items: readonly string[]) {
  const { id: ws } = useWorkspace();
  const results = useQueries({
    queries: items.map((name) => ({
      queryKey: [...knowledgeKeys.itemPermissions(ws, resourceId(name)), "quality"],
      queryFn: () => testItemPermissions(ws, name, QUALITY_PERMISSIONS),
      staleTime: 60_000,
    })),
  });
  const key = results.map((r) => (r.data ?? []).join(",")).join("|");
  return useMemo(() => {
    const granted = new Map(items.map((name, i) => [name, new Set(results[i]?.data ?? [])]));
    return (item: string, permission: QualityPermission) => granted.get(item)?.has(permission) ?? false;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures the resolved permissions
  }, [key, items.join("|")]);
}

/** Client-side sort of a whole list before paging (the table only sees one page). */
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

/** Curated documents as resources: `pool` = in scope (published, editable, shared), `visible` = every curated one by name. */
export function useQualityPool() {
  const items = useCuratedItems();
  const { toResource } = useKnowledgeModel();
  const data = useMemo(() => {
    if (!items.data) return undefined;
    const all = items.data.map((it) => toResource(it));
    return { pool: all.filter(inScope), visible: new Map(all.map((r) => [r.name, r])) };
  }, [items.data, toResource]);
  return { ...items, data };
}

/** Document cell: file tile, title, knowledge base (workspace content stays untranslated). */
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
    const label = topics.data?.find((t) => t.name === topic)?.displayName ?? "the topic";
    const targets = docs.filter((r) => r.editable && !r.topics.includes(topic));
    if (!targets.length) {
      toast(`Already tagged with “${label}”`, { tone: "accent" });
      return;
    }
    const setTopics = (r: Resource, next: string[]) =>
      updateItem(ws, r.name, { document: { purpose: r.item.document?.purpose ?? "KNOWLEDGE", topics: next } }, ["document.topics"]);
    try {
      await Promise.all(targets.map((r) => setTopics(r, [...r.topics, topic])));
      invalidate();
      onDone?.();
      toast(targets.length === 1 ? `Added “${label}” to ${targets[0].title}` : `Added “${label}” to ${plural(targets.length, "document")}`, {
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
            <Dropdown.Item id="none" textValue="No topics yet">
              <Label>No topics yet</Label>
            </Dropdown.Item>
          </Dropdown.Menu>
        )}
      </Dropdown.Popover>
    </Dropdown>
  );
}
