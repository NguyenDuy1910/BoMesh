"use client";

import { Button, Checkbox } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";

import { resourceId } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { EmptyState, ErrorState, FileIcon, SearchInput, SkeletonRows } from "@/components/ui";
import { listAllItems, type Item } from "@/modules/knowledge/api";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";
import { useKnowledgeBases } from "@/modules/knowledge/queries";

export interface KnowledgePickerProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** Item IDs already added (left out of the list). */
  exclude: readonly string[];
  /** How many more documents fit. */
  room: number;
  /** Footer text when `room` is 0 ("This message already has 5 files"). */
  roomFullText: string;
  onAdd: (items: Item[]) => void;
}

/**
 * Add from knowledge (preview `wk-pick`): reference readable documents instead
 * of uploading copies, grouped by knowledge base. Used by the composer and by
 * projects ("Add knowledge to …").
 */
export function KnowledgePicker(props: KnowledgePickerProps) {
  if (!props.isOpen) return null;
  return <PickerDialog {...props} />;
}

function PickerDialog({ onOpenChange, title, description, exclude, room, roomFullText, onAdd }: KnowledgePickerProps) {
  const { id: ws, member } = useWorkspace();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Map<string, Item>>(new Map());
  const bases = useKnowledgeBases();
  const docs = useQuery({
    queryKey: [ws, "artifacts", "picker-documents"],
    queryFn: () =>
      // FULL: the grouping needs `ancestors` (BASIC leaves them out).
      listAllItems(ws, { filter: `itemType = "DOCUMENT" AND document.purpose = "KNOWLEDGE" AND document.contentState = "AVAILABLE"`, orderBy: "updateTime desc", view: "FULL" }, 500),
    staleTime: 60_000,
  });

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const skip = new Set(exclude.map((x) => resourceId(x)));
    // Other people's "My files" (readable by admins) aren't offered, like the scope picker.
    const othersPersonal = new Set((bases.data ?? []).filter((b) => b.collection?.kind === "PERSONAL" && b.name !== member.personalCollection).map((b) => b.name));
    const byBase = new Map<string, { key: string; name: string; items: Item[] }>();
    for (const item of docs.data ?? []) {
      if (skip.has(resourceId(item.name)) || item.state === "DELETED") continue;
      if (needle && !(item.displayName ?? "").toLowerCase().includes(needle) && !(item.document?.fileName ?? "").toLowerCase().includes(needle)) continue;
      const root = item.ancestors?.[0];
      const key = root?.name ?? item.parentItem ?? "";
      if (othersPersonal.has(key)) continue;
      const personal = !!member.personalCollection && key === member.personalCollection;
      const group = byBase.get(key) ?? { key, name: personal ? "My files" : root?.displayName || "Knowledge", items: [] };
      group.items.push(item);
      byBase.set(key, group);
    }
    return [...byBase.values()].map((g) => ({ ...g, items: g.items.slice(0, needle ? 20 : 4) }));
  }, [bases.data, docs.data, exclude, member.personalCollection, q]);

  const n = selected.size;
  const close = () => onOpenChange(false);
  const toggle = (item: Item, on: boolean) => {
    const next = new Map(selected);
    if (on) next.set(item.name ?? "", item);
    else next.delete(item.name ?? "");
    setSelected(next);
  };

  return (
    <KnowledgeModal
      isOpen
      onClose={close}
      size="lg"
      title={title}
      description={description}
      footerStart={<span className="t-sm muted">{room <= 0 ? roomFullText : `${n} of ${room} selected`}</span>}
      footer={
        <>
          <Button variant="tertiary" onPress={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            isDisabled={!n}
            onPress={() => {
              onAdd([...selected.values()]);
              close();
            }}
          >
            {n ? `Add ${plural(n, "document")}` : "Add documents"}
          </Button>
        </>
      }
    >
      <SearchInput className="wk-pick__search" value={q} onChange={setQ} placeholder="Search documents you can access" label="Search documents" fullWidth autoFocus />
      {docs.isError ? (
        <ErrorState error={docs.error} onRetry={() => void docs.refetch()} boxed={false} />
      ) : docs.isPending ? (
        <SkeletonRows rows={5} />
      ) : !groups.length ? (
        <EmptyState icon={Search} title="No documents match" description="Try another word." compact />
      ) : (
        groups.map((group) => (
          <div key={group.key} className="wk-pick__group">
            <div className="t-label mb-8" translate="no">
              {group.name}
            </div>
            {group.items.map((item) => {
              const on = selected.has(item.name ?? "");
              return (
                <div key={item.name} className="wk-pick__row">
                  <Checkbox isSelected={on} isDisabled={!on && n >= room} onChange={(value) => toggle(item, value)}>
                    <Checkbox.Content className="checkbox__label">
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                      <FileIcon size="sm" mime={item.document?.mimeType} name={item.document?.fileName} />
                      <span className="grow truncate" translate="no">
                        {item.displayName}
                      </span>
                      <span className="t-xs muted none">{rel(item.updateTime)}</span>
                    </Checkbox.Content>
                  </Checkbox>
                </div>
              );
            })}
          </div>
        ))
      )}
    </KnowledgeModal>
  );
}
