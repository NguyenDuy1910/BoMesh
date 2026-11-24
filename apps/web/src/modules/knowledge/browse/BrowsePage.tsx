"use client";

import { Button, Dropdown, Header, Label, SearchField, Tooltip } from "@heroui/react";
import clsx from "clsx";
import { AlertCircle, ArrowUpDown, BookOpen, ChevronDown, LayoutGrid, List, Network, Plus, RotateCw, Search, Sparkles, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { IconButton } from "@/components/ui/IconButton";
import { LinkButton } from "@/components/ui/LinkButton";
import { Page } from "@/components/ui/Page";
import { Pager } from "@/components/ui/Pager";
import { Segmented } from "@/components/ui/Segmented";
import { resourceId, type Schema } from "@/lib/api/client";
import { fmtNum, plural } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";

import type { SearchItemsResult } from "../api";
import { CreateCollectionDialog } from "../bases/components/CreateCollectionDialog";
import { ContributeButton, KnowledgeHeader } from "../components/KnowledgeHeader";
import { ResourceCard } from "../components/ResourceCard";
import { topicToneProps } from "../components/TopicTag";
import { ResourceList, ResourceRow } from "../components/ResourceRow";
import { SearchProgress } from "../components/SearchProgress";
import { passageOf, snippetOf, SORTS_CATALOG, topicTree, type CatalogSort, type Resource, type TopicLook } from "../model";
import { openDocumentPreview } from "../preview/store";
import { useKnowledgeBases, useKnowledgeModel, useSavedSearches, useTopics } from "../queries";
import { activeCount, browseFacets, browseHref, defaultSort, describeParams, filterLabels, parseBrowseQuery, PER_PAGE, pillTopic, type BrowseFacetId, type BrowseParams } from "./catalog";
import { FilterBar } from "./FilterBar";
import { useFacetLabel } from "./labels";
import { LockedCollection, LockedNote } from "./LockedCollections";
import { useCatalog, type BrowseOption } from "./useCatalog";
import { ViewsMenu } from "./ViewsMenu";

const TOPIC_PILLS = 6;

/** Plain text of an API snippet (highlighting is applied locally). */
const plainSnippet = (s: string | null) => (s ? s.replace(/<\/?(?:b|mark|em|strong)>/gi, "") : null);

/* ═══════════════ Pieces ═══════════════ */

/** One topic shortcut. With `look` it leads with the topic's icon in its color and, when chosen, takes a soft wash of
 *  that color (preview `pill`); All stays neutral. */
function Pill({ label, on, count, look, onPress }: { label: string; on: boolean; count?: number; look?: TopicLook; onPress: () => void }) {
  const tone = look ? topicToneProps(look) : null;
  return (
    <button type="button" className={clsx("cat-pill", tone && "cat-pill--topic", on && "is-on")} style={tone?.style} aria-pressed={on} onClick={onPress}>
      {tone ? (
        <span className="cat-pill__ic" aria-hidden>
          <tone.Icon className="i" />
        </span>
      ) : null}
      <span translate="no">{label}</span>
      {count !== undefined ? <span className="cat-pill__n">{fmtNum(count)}</span> : null}
    </button>
  );
}

/** Topic shortcuts (the only topic control): domains as one row of pills (the first few, the rest under More); a chosen domain reveals its topics. */
function TopicBar({ p, options, topics, onTopic }: { p: BrowseParams; options: BrowseOption[]; topics: Schema<"Topic">[]; onTopic: (id: string) => void }) {
  const m = useMessages();
  const { ctx } = useKnowledgeModel();
  const counts = new Map(options.map((o) => [o.value, o.count ?? 0]));
  const tree = topicTree(topics).map((d) => ({ ...d, id: resourceId(d.name) }));
  const domains = tree.filter((d) => counts.get(d.id));
  const sel = pillTopic(p);
  if (!domains.length) return null;
  const selDomain = sel ? (tree.find((d) => d.id === sel || d.children.some((t) => resourceId(t.name) === sel))?.id ?? "") : "";
  const shown = domains.slice(0, TOPIC_PILLS);
  const rest = domains.slice(TOPIC_PILLS);
  const promoted = rest.findIndex((d) => d.id === selDomain);
  if (promoted >= 0) shown.push(rest.splice(promoted, 1)[0]);
  const dm = selDomain ? domains.find((d) => d.id === selDomain) : undefined;
  const kids = dm ? dm.children.map((t) => ({ id: resourceId(t.name), topic: t.name ?? "", name: t.displayName ?? "" })).filter((t) => counts.get(t.id)) : [];
  return (
    <>
      <div className="cat-pills" role="group" aria-label="Chủ đề">
        <Pill label={m.common.all} on={!sel} onPress={() => onTopic("")} />
        {shown.map((d) => (
          <Pill key={d.id} label={d.displayName ?? ""} on={d.id === selDomain} look={ctx.topicLooks?.get(d.name ?? "")} onPress={() => onTopic(d.id)} />
        ))}
        {rest.length ? (
          <Dropdown>
            <Dropdown.Trigger className="cat-pill cat-pill--more">
              Thêm
              <ChevronDown className="i i-xs" aria-hidden />
            </Dropdown.Trigger>
            <Dropdown.Popover placement="bottom start">
              <Dropdown.Menu aria-label="Chủ đề khác" onAction={(key) => onTopic(String(key))}>
                <Dropdown.Section>
                  <Header>Chủ đề khác</Header>
                  {rest.map((d) => (
                    <Dropdown.Item key={d.id} id={d.id} textValue={d.displayName ?? ""}>
                      <Label className="grow" translate="no">
                        {d.displayName}
                      </Label>
                      <span className="menu-item__meta">{fmtNum(counts.get(d.id) ?? 0)}</span>
                    </Dropdown.Item>
                  ))}
                </Dropdown.Section>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        ) : null}
      </div>
      {dm && kids.length > 1 ? (
        <div className="cat-pills cat-pills--sub" role="group" aria-label={`Chủ đề trong ${dm.displayName}`}>
          <Pill label={`Tất cả ${dm.displayName}`} on={sel === dm.id} onPress={() => onTopic(dm.id)} />
          {kids.map((t) => (
            <Pill key={t.id} label={t.name} on={sel === t.id} count={counts.get(t.id)} look={ctx.topicLooks?.get(t.topic)} onPress={() => onTopic(t.id)} />
          ))}
        </div>
      ) : null}
    </>
  );
}

const CardSkeleton = () => (
  <div className="doc-card" aria-hidden>
    <span className="skeleton cat-skel-media" />
    <div className="doc-card__body">
      <span className="skeleton skeleton--line" style={{ width: "70%" }} />
      <span className="skeleton skeleton--line" style={{ width: "95%", height: 10 }} />
      <span className="skeleton skeleton--line" style={{ width: "40%", height: 10 }} />
    </div>
  </div>
);

function LoadingBody() {
  return (
    <>
      <div className="cat-top" aria-busy="true" aria-label="Đang tải">
        <div className="cat-pills" aria-hidden>
          {[44, 64, 72, 58, 66].map((w, i) => (
            <span key={i} className="skeleton cat-skel-pill" style={{ width: w }} />
          ))}
        </div>
      </div>
      <div className="cat-bar" aria-hidden>
        <span className="skeleton cat-skel-search" />
      </div>
      <div className="cat-cards">
        {Array.from({ length: 6 }, (_, i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
    </>
  );
}

/** Empty Browse: nothing readable yet (preview `emptyKnowledge`). */
function EmptyKnowledge() {
  const { can, member } = useWorkspace();
  const [creating, setCreating] = useState(false);
  const canUpload = can("contributions.create") || !!member.personalCollection;
  const canCreate = can("items.create");
  return (
    <>
      <EmptyState
        icon={BookOpen}
        boxed
        title="Chưa có tài liệu"
        description={canUpload ? "Tài liệu sẽ hiện ở đây sau khi được duyệt và xử lý. Hãy gửi tệp để duyệt hoặc kết nối một nguồn dữ liệu." : "Chưa có gì được chia sẻ với bạn."}
        actions={
          <>
            <ContributeButton variant="primary" />
            {canCreate ? (
              <Button variant="tertiary" onPress={() => setCreating(true)}>
                <Plus aria-hidden />
                Tạo kho tài liệu
              </Button>
            ) : null}
          </>
        }
      />
      {canCreate ? <CreateCollectionDialog isOpen={creating} onClose={() => setCreating(false)} /> : null}
    </>
  );
}

/* ═══════════════ Page ═══════════════ */

/**
 * Knowledge › Browse (preview `P.catalog`, features/hub.js): one search field, topic shortcuts, then the documents
 * with inline filters, Views, sort and layout. The URL holds the set.
 */
export function BrowsePage() {
  const router = useRouter();
  const search = useSearchParams();
  const p = useMemo(() => parseBrowseQuery(search), [search]);
  const { id: ws, hasModule } = useWorkspace();
  const allFacets = useMemo(() => browseFacets(hasModule("spaces")), [hasModule]);
  /** Filter facets: everything but topic, which the pills own. */
  const facets = useMemo(() => allFacets.filter((f) => f.id !== "topic"), [allFacets]);
  const cat = useCatalog(p);
  const topics = useTopics();
  const views = useSavedSearches();
  const allBases = useKnowledgeBases({ showLocked: true });
  const { toResource } = useKnowledgeModel();
  // Owner chips are labelled by the catalog's facets (the search names owners), so no owner is looked up here.
  const label = useFacetLabel({ sources: (p.filters.src ?? []).filter((s) => s !== "upload") });
  const facetName = useMessages().knowledge.browse.facets;

  const apply = (next: BrowseParams) => router.replace(browseHref(next), { scroll: false });

  /* Search: typing searches documents (debounced into the URL). */
  const [text, setText] = useState(p.q);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastQ = useRef(p.q);
  useEffect(() => {
    if (p.q !== lastQ.current) {
      lastQ.current = p.q;
      setText(p.q);
    }
  }, [p.q]);
  /* Arriving from Home's "Find a document" card: focus the search field, retrying briefly while the
     first load's skeleton (no input yet) is still showing; then drop the marker from the URL. */
  useEffect(() => {
    if (search.get("focus") !== "1") return;
    const qs = new URLSearchParams(search);
    qs.delete("focus");
    router.replace(`/knowledge${qs.toString() ? `?${qs}` : ""}`, { scroll: false });
    const deadline = Date.now() + 2000;
    const tryFocus = () => {
      if (inputRef.current) inputRef.current.focus();
      else if (Date.now() < deadline) setTimeout(tryFocus, 50);
    };
    tryFocus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on arrival
  }, []);
  useEffect(() => {
    if (text.trim() === p.q) return;
    const t = setTimeout(() => {
      lastQ.current = text.trim();
      apply({ ...p, q: text.trim() });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debounce on text only
  }, [text]);
  const clearQ = () => {
    setText("");
    lastQ.current = "";
    apply({ ...p, q: "" });
    inputRef.current?.focus();
  };

  const n = activeCount(p);
  const pt = pillTopic(p);
  const landing = !p.q && !n;
  const optLabel = (f: BrowseFacetId, v: string) => cat.facets[f]?.find((o) => o.value === v)?.label ?? label(f, v);
  const labels = filterLabels(p, optLabel);

  const onTopic = (v: string) => apply({ ...p, filters: { ...p.filters, topic: v ? [v] : [] } });
  /** Clear all: every filter, the topic included (the search words stay; they have their own ×). */
  const clearFilters = () => apply({ ...p, filters: {} });
  const unfilter = (f: BrowseFacetId, v: string) => apply({ ...p, filters: { ...p.filters, [f]: (p.filters[f] ?? []).filter((x) => x !== v) } });

  /** Ask AI: the query (or the filtered set) becomes a cited conversation grounded in these documents. */
  const ask = () => {
    const docs = cat.rows.filter((r) => ["SUCCEEDED", "OUTDATED"].includes(r.item?.document?.indexingState ?? "")).slice(0, 8);
    const scope = labels.length ? ` (${labels.join(", ")})` : "";
    const q = p.q
      ? (/\?\s*$/.test(p.q) ? p.q : `Các tài liệu này nói gì về “${p.q}”?`) + scope
      : `Cho tôi tổng quan về các tài liệu này${scope}: các ý chính, điểm khác nhau và thông tin nào mới nhất.`;
    const qs = new URLSearchParams({ q, send: "1" });
    for (const d of docs) qs.append("doc", resourceId(d.item?.name));
    router.push(`/chat?${qs}`);
  };

  /** Click, Enter or Space: the shared document preview (a near-full-screen sheet on phones). */
  const select = (r: Resource, result: SearchItemsResult) => {
    const passage = passageOf(result);
    const item = r.item?.name ?? r.id;
    openDocumentPreview({
      item,
      listed: r.item,
      q: p.q,
      passages: passage?.passage ? [passage.passage] : undefined,
      // No resolvable passage name: show the snippet the search returned, so the match is still visible.
      citations: !passage?.passage && (passage?.text || snippetOf(result)) ? [{ item, excerpt: passage?.text ?? plainSnippet(snippetOf(result)) ?? undefined }] : undefined,
    });
  };

  const sort = (p.sort || defaultSort(p)) as CatalogSort;
  const def = defaultSort(p);
  const rows = cat.rows.map((x) => ({ x, r: toResource(x.item ?? {}) }));
  /** Context every result on the page shares (one collection, one topic) — said once by the filters, not on every card. */
  const shared = (() => {
    if (rows.length < 2) return [] as ("kb" | "topic")[];
    const one = (f: (r: Resource) => string) => new Set(rows.map(({ r }) => f(r))).size === 1;
    return [one((r) => r.base?.name ?? "") && "kb", one((r) => r.topics[0] ?? "") && "topic"].filter(Boolean) as ("kb" | "topic")[];
  })();
  const lockedBases = (allBases.data ?? []).filter((b) => b.access === "LOCKED");
  const lockedFilter = (p.filters.kb ?? []).map((id) => lockedBases.find((b) => resourceId(b.name) === id)).find((b) => !!b);
  const loadingFirst = cat.isPending && !cat.rows.length && !cat.isError;
  const emptyCatalog = cat.poolSize === 0 && landing;

  const title = landing ? "Tất cả tài liệu" : p.q ? "Kết quả" : "Tài liệu";
  const suggestion = (() => {
    const name = (labels.join(" · ") || p.q || "Chế độ xem của tôi").slice(0, 60);
    return p.q && labels.length ? `${p.q} · ${name}`.slice(0, 60) : name;
  })();

  const chips = allFacets.flatMap((f) =>
    (p.filters[f.id] ?? [])
      .filter((v) => !(f.id === "topic" && v === pt))
      .map((v) => (
        <button key={`${f.id}:${v}`} type="button" className="cat-chip" aria-label={`Gỡ bộ lọc ${facetName[f.id]}: ${optLabel(f.id, v)}`} onClick={() => unfilter(f.id, v)}>
          <span className="cat-chip__k">{facetName[f.id]}</span>
          <span className="truncate" translate={(cat.facets[f.id]?.find((o) => o.value === v)?.ui ?? label.ui(f.id, v)) ? undefined : "no"}>
            {optLabel(f.id, v)}
          </span>
          <X className="i i-xs" aria-hidden />
        </button>
      )),
  );

  const results = cat.isError && !cat.rows.length ? (
    p.q ? (
      <EmptyState
        icon={AlertCircle}
        tone="danger"
        boxed
        compact
        title="Không tải được nội dung này"
        description="Vừa rồi không tìm kiếm được. Hãy thử lại, hoặc xóa từ khóa để xem theo bộ lọc."
        actions={
          <>
            <Button variant="tertiary" onPress={() => void cat.refetch()}>
              <RotateCw aria-hidden />
              Thử lại
            </Button>
            <Button variant="tertiary" onPress={clearQ}>
              Xóa tìm kiếm
            </Button>
          </>
        }
      />
    ) : (
      <ErrorState error={cat.error} onRetry={cat.refetch} compact />
    )
  ) : cat.isPending && !cat.rows.length ? (
    <div className="cat-cards" aria-busy="true">
      {Array.from({ length: 6 }, (_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  ) : cat.total ? (
    <>
      <div className="cat-results">
        {p.view === "list" ? (
          <ResourceList>
            {rows.map(({ x, r }) => (
              <ResourceRow key={r.id} resource={r} q={p.q} snippet={plainSnippet(snippetOf(x))} onOpen={() => select(r, x)} />
            ))}
          </ResourceList>
        ) : (
          <div className="cat-cards">
            {rows.map(({ x, r }) => (
              <ResourceCard key={r.id} resource={r} q={p.q} passage={passageOf(x)} hide={shared} onOpen={() => select(r, x)} />
            ))}
          </div>
        )}
      </div>
      {cat.total > PER_PAGE ? (
        <Pager
          page={cat.page}
          pageSize={PER_PAGE}
          total={cat.total}
          onPageChange={(n2) => {
            cat.setPage(n2);
            window.scrollTo({ top: 0 });
          }}
        />
      ) : null}
    </>
  ) : lockedFilter ? (
    // Filtered to a collection the caller can't read: say so and offer Request access, never an empty result.
    <LockedCollection base={lockedFilter} />
  ) : (
    <EmptyState
      icon={Search}
      boxed
      compact
      title={p.q ? `Không có tài liệu nào khớp với “${p.q}”` : "Không có tài liệu nào khớp với các bộ lọc này"}
      description={p.q ? "Thử từ khác, hoặc hỏi trợ lý — trợ lý có thể trả lời từ những đoạn mà tìm kiếm theo tiêu đề bỏ sót." : "Thử bớt bộ lọc."}
      actions={
        <>
          {n ? (
            <Button variant="tertiary" onPress={clearFilters}>
              Xóa bộ lọc
            </Button>
          ) : null}
          {p.q ? (
            <>
              <Button variant="tertiary" onPress={clearQ}>
                Xóa tìm kiếm
              </Button>
              <Button variant="primary" onPress={ask}>
                <Sparkles aria-hidden />
                Hỏi AI
              </Button>
            </>
          ) : null}
        </>
      }
    />
  );

  return (
    <Page width="wide" className="cat">
      <KnowledgeHeader
        actions={
          <>
            <IconButton icon={Network} tip="Bản đồ tài liệu" href="/knowledge/map" size="sm" />
            <ContributeButton />
          </>
        }
      />
      {emptyCatalog ? (
        <EmptyKnowledge />
      ) : loadingFirst && landing && cat.poolSize === null ? (
        <LoadingBody />
      ) : (
        <>
          <div className="cat-top">
            <TopicBar p={p} options={cat.facets.topic ?? []} topics={topics.data ?? []} onTopic={onTopic} />
          </div>

          <section className="cat-main" aria-label="Tài liệu">
            <FilterBar
              p={p}
              options={cat.facets}
              onApply={apply}
              facets={facets}
              total={cat.total}
              search={
                /* One compact field: search is one more way to narrow these results; Ask AI sits in the results header. */
                <SearchField aria-label="Tìm kiếm tài liệu" value={text} onChange={setText} onClear={clearQ} className="cat-search">
                  <SearchField.Group>
                    <SearchField.SearchIcon>
                      <Search className="i" aria-hidden />
                    </SearchField.SearchIcon>
                    <SearchField.Input ref={inputRef} placeholder="Tìm kiếm tài liệu" autoComplete="off" />
                    {text ? <SearchField.ClearButton aria-label="Xóa tìm kiếm" /> : null}
                  </SearchField.Group>
                </SearchField>
              }
              end={
                <>
                  <ViewsMenu p={p} views={views.data ?? []} topics={topics.data ?? []} onApply={apply} suggestion={suggestion} summary={describeParams(p, optLabel)} />
                  <Dropdown>
                    <Button variant="ghost" size="sm" className="cat-sort" aria-label={`Sắp xếp: ${SORTS_CATALOG[sort]}`}>
                      <ArrowUpDown aria-hidden className="i" />
                      <span>{SORTS_CATALOG[sort]}</span>
                      <ChevronDown aria-hidden className="i" />
                    </Button>
                    <Dropdown.Popover placement="bottom end">
                      <Dropdown.Menu
                        aria-label="Sắp xếp theo"
                        selectionMode="single"
                        selectedKeys={[sort]}
                        onAction={(k) => apply({ ...p, sort: String(k) === def ? "" : (String(k) as CatalogSort) })}
                      >
                        <Dropdown.Section>
                          <Header>Sắp xếp theo</Header>
                          {(Object.keys(SORTS_CATALOG) as CatalogSort[])
                            .filter((k) => k !== "relevance" || p.q)
                            .map((k) => (
                              <Dropdown.Item key={k} id={k} textValue={SORTS_CATALOG[k]}>
                                <Label>{SORTS_CATALOG[k]}</Label>
                                <Dropdown.ItemIndicator />
                              </Dropdown.Item>
                            ))}
                        </Dropdown.Section>
                      </Dropdown.Menu>
                    </Dropdown.Popover>
                  </Dropdown>
                  <span className="cat-layoutsw">
                    <Segmented
                      label="Bố cục"
                      value={p.view}
                      onChange={(v) => apply({ ...p, view: v })}
                      options={[
                        { value: "grid", label: "Lưới", icon: LayoutGrid, iconOnly: true },
                        { value: "list", label: "Danh sách", icon: List, iconOnly: true },
                      ]}
                    />
                  </span>
                </>
              }
            />
            {/* The result count with the choices that produced it. */}
            <div className="cat-head">
              <h2 className="cat-head__title">{title}</h2>
              {!cat.isError && !cat.isPending ? (
                <span className="cat-count" role="status">
                  <span aria-hidden>{fmtNum(cat.total)}</span>
                  <span className="sr-only">{plural(cat.total, "document")}</span>
                </span>
              ) : null}
              {chips.length ? (
                <div className="cat-chips">
                  {chips}
                  <LinkButton onPress={clearFilters}>Xóa tất cả</LinkButton>
                </div>
              ) : null}
              <span className="grow" />
              {/* Search narrows the set; Ask AI turns it into a cited answer — two clearly named actions, never one control. */}
              {(p.q || n) && cat.total ? (
                <Tooltip>
                  <Button variant="ghost" size="sm" onPress={ask}>
                    <Sparkles aria-hidden />
                    {p.q ? "Hỏi AI" : "Hỏi về các tài liệu này"}
                  </Button>
                  <Tooltip.Content>{p.q ? "Nhận câu trả lời có nguồn từ các tài liệu này" : "Nhận tổng quan có nguồn từ các tài liệu này"}</Tooltip.Content>
                </Tooltip>
              ) : null}
            </div>
            <SearchProgress active={cat.isSearching} />
            {results}
          </section>
          {lockedBases.length && !lockedFilter ? <LockedNote bases={lockedBases} /> : null}
        </>
      )}
    </Page>
  );
}
