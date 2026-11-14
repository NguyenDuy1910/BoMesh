"use client";

import { Button, Checkbox } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, CheckCircle2, ChevronDown, CircleAlert, Plus, Search } from "lucide-react";
import { Fragment, useMemo, useState } from "react";

import { resourceId } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { EmptyState, ErrorState, FileIcon, SearchInput, SkeletonRows } from "@/components/ui";
import { listAllItems, type Item } from "@/modules/knowledge/api";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";
import { useKnowledgeBases } from "@/modules/knowledge/queries";

/** Rows a collection shows before "Show N more" (preview `PICK_FEW`). */
const PICK_FEW = 5;

export interface KnowledgePickerProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** Item IDs already added (left out of the list). */
  exclude: readonly string[];
  /** How many more documents fit (`Infinity`: no limit, no counter in the footer). */
  room: number;
  /** Footer text when `room` is 0 ("This message already has 5 files."). */
  roomFullText: string;
  onAdd: (items: Item[]) => void;
  /** Shared knowledge only: My files are not offered (Home's featured documents). */
  sharedOnly?: boolean;
}

/**
 * Add from knowledge (preview `wk-pick`): reference readable documents instead
 * of uploading copies, grouped by collection. Used by the composer and by
 * projects ("Add knowledge to …").
 */
export function KnowledgePicker(props: KnowledgePickerProps) {
  if (!props.isOpen) return null;
  return <PickerDialog {...props} />;
}

function PickerDialog({ onOpenChange, title, description, exclude, room, roomFullText, onAdd, sharedOnly }: KnowledgePickerProps) {
  const { id: ws, member } = useWorkspace();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Map<string, Item>>(new Map());
  const [more, setMore] = useState<ReadonlySet<string>>(new Set());
  const [tried, setTried] = useState(false);
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
    const byBase = new Map<string, { key: string; name: string; personal: boolean; items: Item[] }>();
    for (const item of docs.data ?? []) {
      if (skip.has(resourceId(item.name)) || item.state === "DELETED") continue;
      if (needle && !(item.displayName ?? "").toLowerCase().includes(needle) && !(item.document?.fileName ?? "").toLowerCase().includes(needle)) continue;
      const root = item.ancestors?.[0];
      const key = root?.name ?? item.parentItem ?? "";
      if (othersPersonal.has(key)) continue;
      const personal = !!member.personalCollection && key === member.personalCollection;
      if (personal && sharedOnly) continue;
      const group = byBase.get(key) ?? { key, name: personal ? "My files" : root?.displayName || "Knowledge", personal, items: [] };
      group.items.push(item);
      byBase.set(key, group);
    }
    // My files first, like the preview's collection order.
    return [...byBase.values()].sort((a, b) => Number(b.personal) - Number(a.personal));
  }, [bases.data, docs.data, exclude, member.personalCollection, q, sharedOnly]);

  const n = selected.size;
  const close = () => onOpenChange(false);
  const toggle = (item: Item, on: boolean) => {
    const next = new Map(selected);
    if (on) next.set(item.name ?? "", item);
    else next.delete(item.name ?? "");
    setSelected(next);
    setTried(false);
  };
  const add = () => {
    if (!n) {
      setTried(true);
      return;
    }
    onAdd([...selected.values()]);
    close();
  };
  const searching = !!q.trim();
  const left = Math.max(0, room - n);
  const footerStart =
    tried && !n ? (
      <span className="field-error" role="alert">
        <CircleAlert className="i" aria-hidden />
        <span>Select at least one document.</span>
      </span>
    ) : room <= 0 ? (
      <span className="muted">{roomFullText}</span>
    ) : Number.isFinite(room) ? (
      <span className="muted">{n ? (left ? `${n} selected · you can add ${left} more` : `${n} selected · that’s the limit`) : `You can add ${room} more`}</span>
    ) : null;

  return (
    <KnowledgeModal
      isOpen
      onClose={close}
      size="lg"
      icon={BookOpen}
      title={title}
      description={description}
      footerStart={footerStart}
      footer={
        <>
          <Button variant="ghost" onPress={close}>
            Cancel
          </Button>
          <Button variant="primary" onPress={add}>
            <Plus className="i" aria-hidden />
            {n ? `Add ${plural(n, "document")}` : "Add documents"}
          </Button>
        </>
      }
    >
      <div className="wk-pick">
        <SearchInput className="wk-pick__search" value={q} onChange={setQ} placeholder="Search documents you can access" label="Search documents" fullWidth autoFocus />
        {docs.isError ? (
          <ErrorState error={docs.error} onRetry={() => void docs.refetch()} boxed={false} />
        ) : docs.isPending ? (
          <SkeletonRows rows={5} />
        ) : !groups.length ? (
          searching ? (
            <EmptyState
              icon={Search}
              title="No documents match"
              description="Try another word, or clear the search to browse by collection."
              actions={
                <Button variant="ghost" size="sm" onPress={() => setQ("")}>
                  Clear search
                </Button>
              }
              compact
            />
          ) : sharedOnly ? (
            <EmptyState icon={BookOpen} title="No published documents to add" description="Documents published to a collection show up here." compact />
          ) : (
            <EmptyState icon={CheckCircle2} title="Nothing left to add" description="Every document you can access is already here." compact />
          )
        ) : (
          <div className="option-list wk-pick__list" role="group" aria-label="Documents">
            {groups.map((group) => {
              const all = searching || more.has(group.key) || group.items.length <= PICK_FEW + 1;
              const shown = all ? group.items : group.items.slice(0, PICK_FEW);
              return (
                <Fragment key={group.key}>
                  <div className="wk-pick__kb" role="presentation" translate={group.personal ? undefined : "no"}>
                    {group.name}
                    <span className="num">{group.items.length}</span>
                  </div>
                  {shown.map((item) => {
                    const on = selected.has(item.name ?? "");
                    return (
                      <Checkbox key={item.name} isSelected={on} isDisabled={!on && n >= room} onChange={(value) => toggle(item, value)}>
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
                    );
                  })}
                  {all ? null : (
                    <button type="button" className="wk-pick__more" onClick={() => setMore(new Set(more).add(group.key))}>
                      <ChevronDown className="i i-sm" aria-hidden />
                      <span>Show {group.items.length - PICK_FEW} more</span>
                    </button>
                  )}
                </Fragment>
              );
            })}
          </div>
        )}
      </div>
    </KnowledgeModal>
  );
}
