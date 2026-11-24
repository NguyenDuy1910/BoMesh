"use client";

import { Button, Checkbox } from "@heroui/react";
import { useInfiniteQuery, useQueries } from "@tanstack/react-query";
import { BookOpen, CheckCircle2, ChevronDown, CircleAlert, Plus, Search } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";

import { resourceId } from "@/lib/api/client";
import { SEARCH_PAUSE_MS, useDebounced } from "@/lib/debounce";
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { EmptyState, ErrorState, FileIcon, SearchInput, SkeletonRows } from "@/components/ui";
import { nameSearch } from "@/modules/curation/docFilter";
import { listItems, quote, type Item } from "@/modules/knowledge/api";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";
import { knowledgeKeys, useKnowledgeBases } from "@/modules/knowledge/queries";

/** Rows a collection shows before "Show N more" (preview `PICK_FEW`). */
const PICK_FEW = 5;
/** Documents read per collection at a time (one ListItems page). */
const GROUP_PAGE = 25;
const PICKABLE = "itemKind = DOCUMENT AND document.purpose = KNOWLEDGE AND document.contentState = AVAILABLE";

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
 * projects ("Add knowledge to …"). Each collection reads one page of its documents
 * (newest first, the search matching names) and the next page on "Show more".
 */
export function KnowledgePicker(props: KnowledgePickerProps) {
  if (!props.isOpen) return null;
  return <PickerDialog {...props} />;
}

function PickerDialog({ onOpenChange, title, description, exclude, room, roomFullText, onAdd, sharedOnly }: KnowledgePickerProps) {
  const { id: ws, member } = useWorkspace();
  const [q, setQ] = useState("");
  const search = nameSearch(useDebounced(q, SEARCH_PAUSE_MS));
  const [selected, setSelected] = useState<Map<string, Item>>(new Map());
  const [tried, setTried] = useState(false);
  const bases = useKnowledgeBases();
  // Other people's "My files" (readable by admins) aren't offered, like the scope picker; My files first, like the preview's collection order.
  const roots = (bases.data ?? [])
    .filter((b) => b.state !== "DELETED" && (b.itemType !== "PERSONAL" || (!sharedOnly && b.name === member.personalCollection)))
    .sort((a, b) => Number(b.itemType === "PERSONAL") - Number(a.itemType === "PERSONAL"))
    .map((b) => ({ root: b, filter: [PICKABLE, `ancestors:${quote(b.name ?? "")}`, search].filter(Boolean).join(" AND ") }));
  const firstPages = useQueries({
    // FULL: the rows show the file type (BASIC leaves `document` details out).
    queries: roots.map(({ filter }) => ({
      queryKey: [...knowledgeKeys.items(ws), "picker", filter],
      queryFn: () => listItems(ws, { filter, orderBy: "updateTime desc", view: "FULL", pageSize: GROUP_PAGE }),
      staleTime: 60_000,
    })),
  });
  const skip = new Set(exclude.map((x) => resourceId(x)));
  const groups = roots.flatMap(({ root, filter }, i) => {
    const page = firstPages[i]?.data;
    if (!page) return [];
    const personal = root.itemType === "PERSONAL";
    const total = (page.totalSize ?? 0) - (page.items ?? []).filter((d) => skip.has(resourceId(d.name))).length;
    return total > 0 ? [{ name: personal ? "Tệp của tôi" : root.displayName || "Tài liệu", personal, filter, page, total }] : [];
  });
  const failed = firstPages.find((p) => p.isError);
  const loading = bases.isPending || firstPages.some((p) => p.isPending);

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
  const searching = !!search;
  const left = Math.max(0, room - n);
  const footerStart =
    tried && !n ? (
      <span className="field-error" role="alert">
        <CircleAlert className="i" aria-hidden />
        <span>Chọn ít nhất một tài liệu.</span>
      </span>
    ) : room <= 0 ? (
      <span className="muted">{roomFullText}</span>
    ) : Number.isFinite(room) ? (
      <span className="muted">{n ? (left ? `Đã chọn ${n} · bạn có thể thêm ${left} tài liệu nữa` : `Đã chọn ${n} · đã đạt giới hạn`) : `Bạn có thể thêm ${room} tài liệu nữa`}</span>
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
            Hủy
          </Button>
          <Button variant="primary" onPress={add}>
            <Plus className="i" aria-hidden />
            {n ? `Thêm ${plural(n, "document")}` : "Thêm tài liệu"}
          </Button>
        </>
      }
    >
      <div className="wk-pick">
        <SearchInput className="wk-pick__search" value={q} onChange={setQ} placeholder="Tìm kiếm tài liệu bạn có quyền truy cập" label="Tìm kiếm tài liệu" fullWidth autoFocus />
        {failed || bases.isError ? (
          <ErrorState error={failed?.error ?? bases.error} onRetry={() => void (failed ? failed.refetch() : bases.refetch())} boxed={false} />
        ) : loading && !groups.length ? (
          <SkeletonRows rows={5} />
        ) : !groups.length ? (
          searching ? (
            <EmptyState
              icon={Search}
              title="Không có tài liệu phù hợp"
              description="Hãy thử từ khác, hoặc xóa tìm kiếm để tra cứu theo kho tài liệu."
              actions={
                <Button variant="ghost" size="sm" onPress={() => setQ("")}>
                  Xóa tìm kiếm
                </Button>
              }
              compact
            />
          ) : sharedOnly ? (
            <EmptyState icon={BookOpen} title="Chưa có tài liệu đã công bố để thêm" description="Tài liệu được công bố vào một kho tài liệu sẽ hiển thị ở đây." compact />
          ) : (
            <EmptyState icon={CheckCircle2} title="Không còn gì để thêm" description="Mọi tài liệu bạn có quyền truy cập đều đã có ở đây." compact />
          )
        ) : (
          <div className="option-list wk-pick__list" role="group" aria-label="Tài liệu">
            {groups.map((group) => (
              <PickerGroup key={group.filter} {...group} searching={searching} skip={skip}>
                {(item) => {
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
                }}
              </PickerGroup>
            ))}
          </div>
        )}
      </div>
    </KnowledgeModal>
  );
}

interface PickerGroupProps {
  name: string;
  personal: boolean;
  filter: string;
  /** The collection's first page (read with the others, so empty collections stay hidden). */
  page: { items?: Item[]; nextPageToken?: string };
  /** Matching documents in the collection, without the excluded ones. */
  total: number;
  searching: boolean;
  skip: ReadonlySet<string>;
  children: (item: Item) => ReactNode;
}

/** One collection's rows: the first few, then "Show N more" reveals the page and reads the next ones one page at a time. */
function PickerGroup({ name, personal, filter, page, total, searching, skip, children }: PickerGroupProps) {
  const { id: ws } = useWorkspace();
  const [opened, setOpened] = useState(false);
  const rest = useInfiniteQuery({
    queryKey: [...knowledgeKeys.items(ws), "picker", filter, "rest"],
    queryFn: ({ pageParam }) => listItems(ws, { filter, orderBy: "updateTime desc", view: "FULL", pageSize: GROUP_PAGE, pageToken: pageParam }),
    initialPageParam: page.nextPageToken ?? "",
    getNextPageParam: (last) => last.nextPageToken || undefined,
    enabled: opened && !!page.nextPageToken,
    staleTime: 60_000,
  });
  const items = [...(page.items ?? []), ...(rest.data?.pages.flatMap((p) => p.items ?? []) ?? [])].filter((d) => !skip.has(resourceId(d.name)));
  const all = searching || opened || total <= PICK_FEW + 1;
  const shown = all ? items : items.slice(0, PICK_FEW);
  const left = Math.max(0, total - shown.length);
  const more = () => {
    if (!opened) setOpened(true);
    else void rest.fetchNextPage();
  };
  return (
    <>
      <div className="wk-pick__kb" role="presentation" translate={personal ? undefined : "no"}>
        {name}
        <span className="num">{total}</span>
      </div>
      {shown.map((item) => (
        <Fragment key={item.name}>{children(item)}</Fragment>
      ))}
      {left > 0 && !rest.isFetching ? (
        <button type="button" className="wk-pick__more" onClick={more}>
          <ChevronDown className="i i-sm" aria-hidden />
          <span>Hiển thị {left} more</span>
        </button>
      ) : null}
    </>
  );
}
