"use client";

import { Button, Dropdown, Header, Label, SearchField, ToggleButton, Tooltip } from "@heroui/react";
import clsx from "clsx";
import { AlertCircle, ArrowRight, ArrowUpDown, Bookmark, BookOpen, Check, ChevronDown, LayoutGrid, List, Lock, RotateCw, Search, SlidersVertical, Sparkles, X } from "lucide-react";
import NextLink from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Page } from "@/components/ui/Page";
import { Pager } from "@/components/ui/Pager";
import { Segmented } from "@/components/ui/Segmented";
import { fmtNum, plural } from "@/lib/format";
import { resourceId, type Schema } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import type { SearchItemsResult } from "../api";
import { ContributeButton, KnowledgeHeader } from "../components/KnowledgeHeader";
import { ResourceCard } from "../components/ResourceCard";
import { ResourceList, ResourceRow } from "../components/ResourceRow";
import { passageOf, snippetOf, SORTS_CATALOG, topicTree, type CatalogSort, type Resource } from "../model";
import { useKnowledgeBases, useKnowledgeModel, useSavedSearches, useTopics } from "../queries";
import {
  activeCount,
  browseFacets,
  browseHref,
  defaultSort,
  describeParams,
  filterLabels,
  parseBrowseQuery,
  PER_PAGE,
  pillTopic,
  savedSearchParams,
  setKey,
  type BrowseParams,
} from "./catalog";
import { ContinueReading } from "./ContinueReading";
import { FiltersDrawer } from "./FiltersDrawer";
import { useFacetLabel } from "./labels";
import { QuickPreview, readerHref, type PeekTarget } from "./QuickPreview";
import { SaveViewDialog } from "./SaveViewDialog";
import { useCatalog, type BrowseOption } from "./useCatalog";

const TOPIC_PILLS = 6;
/** Below this width the quick preview adds a step without adding room: cards open the Reader directly. */
const PEEK_MIN_WIDTH = 760;

/** Plain text of an API snippet (highlighting is applied locally). */
const plainSnippet = (s: string | null) => (s ? s.replace(/<\/?(?:b|mark|em|strong)>/gi, "") : null);

/* ═══════════════ Pieces ═══════════════ */

function Pill({ label, on, count, onPress }: { label: string; on: boolean; count?: number; onPress: () => void }) {
  return (
    <ToggleButton className={clsx("cat-pill", on && "is-on")} isSelected={on} onChange={onPress}>
      <span translate="no">{label}</span>
      {count !== undefined ? <span className="cat-pill__n">{fmtNum(count)}</span> : null}
    </ToggleButton>
  );
}

/** Topic shortcuts: domains as one row of pills (the first few, the rest under More); a chosen domain reveals its topics. */
function TopicBar({ p, options, topics, onTopic }: { p: BrowseParams; options: BrowseOption[]; topics: Schema<"Topic">[]; onTopic: (id: string) => void }) {
  const counts = new Map(options.map((o) => [o.value, o.count ?? 0]));
  const tree = topicTree(topics).map((d) => ({ ...d, id: resourceId(d.name) }));
  const domains = tree.filter((d) => counts.get(d.id));
  if (!domains.length) return null;
  const sel = pillTopic(p);
  const selDomain = sel ? (tree.find((d) => d.id === sel || d.children.some((t) => resourceId(t.name) === sel))?.id ?? "") : "";
  const shown = domains.slice(0, TOPIC_PILLS);
  const rest = domains.slice(TOPIC_PILLS);
  const promoted = rest.findIndex((d) => d.id === selDomain);
  if (promoted >= 0) shown.push(rest.splice(promoted, 1)[0]);
  const dm = selDomain ? domains.find((d) => d.id === selDomain) : undefined;
  const kids = dm ? dm.children.map((t) => ({ id: resourceId(t.name), name: t.displayName ?? "" })).filter((t) => counts.get(t.id)) : [];
  return (
    <>
      <div className="cat-pills" role="group" aria-label="Topics">
        <Pill label="All" on={!sel} onPress={() => onTopic("")} />
        {shown.map((d) => (
          <Pill key={d.id} label={d.displayName ?? ""} on={d.id === selDomain} onPress={() => onTopic(d.id)} />
        ))}
        {rest.length ? (
          <Dropdown>
            <Button variant="ghost" className="cat-pill cat-pill--more">
              More
              <ChevronDown className="i i-xs" aria-hidden />
            </Button>
            <Dropdown.Popover placement="bottom start">
              <Dropdown.Menu aria-label="More topics" onAction={(key) => onTopic(String(key))}>
                <Dropdown.Section>
                  <Header>More topics</Header>
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
        <div className="cat-pills cat-pills--sub" role="group" aria-label={`Topics in ${dm.displayName}`}>
          <Pill label={`All ${dm.displayName}`} on={sel === dm.id} onPress={() => onTopic(dm.id)} />
          {kids.map((t) => (
            <Pill key={t.id} label={t.name} on={sel === t.id} count={counts.get(t.id)} onPress={() => onTopic(t.id)} />
          ))}
        </div>
      ) : null}
    </>
  );
}

function LoadingBody() {
  return (
    <>
      <div className="cat-top" aria-busy="true" aria-label="Loading">
        <span className="skeleton cat-skel-search" />
        <div className="cat-pills" aria-hidden>
          {[44, 64, 72, 58, 66].map((w, i) => (
            <span key={i} className="skeleton cat-skel-pill" style={{ width: w }} />
          ))}
        </div>
      </div>
      <div className="cat-cards">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="doc-card" aria-hidden>
            <span className="skeleton cat-skel-media" />
            <div className="doc-card__body">
              <span className="skeleton skeleton--line" style={{ width: "70%" }} />
              <span className="skeleton skeleton--line" style={{ width: "95%", height: 10 }} />
              <span className="skeleton skeleton--line" style={{ width: "40%", height: 10 }} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** Empty Browse: nothing readable yet. */
function EmptyKnowledge() {
  const { can, member } = useWorkspace();
  const canUpload = can("contributions.create") || !!member.personalCollection;
  return (
    <EmptyState
      icon={BookOpen}
      boxed
      title="No knowledge yet"
      description={canUpload ? "Contribute files or connect a source to start the catalog." : "Nothing has been shared with you yet."}
      actions={
        <>
          <ContributeButton variant="primary" />
          <NextLink className="button button--secondary" href="/knowledge/bases">
            Knowledge bases
          </NextLink>
        </>
      }
    />
  );
}

/* ═══════════════ Page ═══════════════ */

/** Knowledge › Browse (preview `P.catalog`, features/hub.js): one search field, topic shortcuts, a document grid; filters and the quick preview are drawers. */
export function BrowsePage() {
  const router = useRouter();
  const search = useSearchParams();
  const p = useMemo(() => parseBrowseQuery(search), [search]);
  const { id: ws, hasModule } = useWorkspace();
  const facets = useMemo(() => browseFacets(hasModule("spaces")), [hasModule]);
  const cat = useCatalog(p);
  const topics = useTopics();
  const views = useSavedSearches();
  const lockedBases = useKnowledgeBases({ showLocked: true });
  const { toResource } = useKnowledgeModel();
  const label = useFacetLabel({ owners: (p.filters.owner ?? []).map((o) => `workspaces/${ws}/members/${o}`), sources: (p.filters.src ?? []).filter((s) => s !== "upload") });

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [peek, setPeek] = useState<PeekTarget | null>(null);

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
  const extra = n - (pt ? 1 : 0);
  const landing = !p.q && !n;
  const key = setKey(p);
  const existing = (views.data ?? []).some((v) => setKey(savedSearchParams(v, topics.data ?? [])) === key);
  const optLabel = (f: keyof BrowseParams["filters"], v: string) => cat.facets[f]?.find((o) => o.value === v)?.label ?? label(f, v);
  const labels = filterLabels(p, optLabel);

  const onTopic = (v: string) => apply({ ...p, filters: { ...p.filters, topic: v ? [v] : [] } });
  /** Clears the advanced filters; the topic shortcut stays, since it is visible and has its own All. */
  const clearFilters = () => apply({ ...p, filters: pt ? { topic: [pt] } : {}, saved: false });
  const unfilter = (f: keyof BrowseParams["filters"] | "saved", v?: string) =>
    f === "saved" ? apply({ ...p, saved: false }) : apply({ ...p, filters: { ...p.filters, [f]: (p.filters[f] ?? []).filter((x) => x !== v) } });

  /** Ask AI: the query (or the filtered set) becomes a cited conversation grounded in these documents. */
  const ask = () => {
    const docs = cat.rows.filter((r) => ["SUCCEEDED", "OUTDATED"].includes(r.item?.document?.indexingState ?? "")).slice(0, 8);
    const scope = labels.length ? ` (${labels.join(", ")})` : "";
    const q = p.q
      ? (/\?\s*$/.test(p.q) ? p.q : `What do these documents say about “${p.q}”?`) + scope
      : `Give me an overview of these documents${scope}: the main points, how they differ and what is most current.`;
    const qs = new URLSearchParams({ q, send: "1" });
    for (const d of docs) qs.append("doc", resourceId(d.item?.name));
    router.push(`/chat?${qs}`);
  };

  /** Click, Enter or Space: quick preview; a narrow window goes straight to the Reader. */
  const select = (r: Resource, result: SearchItemsResult) => {
    if (window.innerWidth < PEEK_MIN_WIDTH) router.push(readerHref(r, p.q));
    else setPeek({ resource: r, passage: passageOf(result) ?? (snippetOf(result) ? { text: plainSnippet(snippetOf(result))! } : null) });
  };

  const sort = (p.sort || defaultSort(p)) as CatalogSort;
  const def = defaultSort(p);
  const rows = cat.rows.map((x) => ({ x, r: toResource(x.item ?? {}) }));
  const shared = (() => {
    if (rows.length < 2) return [] as ("kb" | "topic")[];
    const one = (f: (r: Resource) => string) => new Set(rows.map(({ r }) => f(r))).size === 1;
    return [one((r) => r.base?.name ?? "") && "kb", one((r) => r.topics[0] ?? "") && "topic"].filter(Boolean) as ("kb" | "topic")[];
  })();
  const locked = (lockedBases.data ?? []).some((b) => b.access === "LOCKED");
  const loadingFirst = cat.isPending && !cat.rows.length && !cat.isError;
  const emptyCatalog = cat.poolSize === 0 && landing;

  const title = landing ? "All documents" : p.q ? "Results" : "Documents";
  const suggestion = (() => {
    const name = (labels.join(" · ") || p.q || "My view").slice(0, 60);
    return p.q && labels.length ? `${p.q} · ${name}`.slice(0, 60) : name;
  })();

  return (
    <Page className="cat">
      <PageChrome crumbs={[{ label: "Knowledge" }]} />
      <KnowledgeHeader active="browse" />
      {emptyCatalog ? (
        <EmptyKnowledge />
      ) : loadingFirst && landing && cat.poolSize === null ? (
        <LoadingBody />
      ) : (
        <>
          <div className="cat-top">
            <SearchField aria-label="Search documents" value={text} onChange={setText} onClear={clearQ} className="cat-search">
              <SearchField.Group>
                <SearchField.SearchIcon>
                  <Search className="i" aria-hidden />
                </SearchField.SearchIcon>
                <SearchField.Input ref={inputRef} placeholder={cat.poolSize !== null ? `Search ${fmtNum(cat.poolSize)} documents` : "Search documents"} autoComplete="off" />
                {text ? <SearchField.ClearButton aria-label="Clear search" /> : null}
                {p.q ? (
                  <span className="cat-search__ask">
                    <Tooltip>
                      <Button variant="secondary" size="sm" onPress={ask}>
                        <Sparkles aria-hidden />
                        Ask AI
                      </Button>
                      <Tooltip.Content>Get an answer with sources from these documents</Tooltip.Content>
                    </Tooltip>
                  </span>
                ) : null}
              </SearchField.Group>
            </SearchField>
            <TopicBar p={p} options={cat.facets.topic ?? []} topics={topics.data ?? []} onTopic={onTopic} />
          </div>

          {(() => {
            const chips = facets.flatMap((f) =>
              (p.filters[f.id] ?? [])
                .filter((v) => !(f.id === "topic" && v === pt))
                .map((v) => (
                  <Button key={`${f.id}:${v}`} variant="ghost" className="cat-chip" aria-label={`Remove filter ${f.label}: ${optLabel(f.id, v)}`} onPress={() => unfilter(f.id, v)}>
                    <span className="cat-chip__k">{f.label}</span>
                    <span className="truncate" translate="no">
                      {optLabel(f.id, v)}
                    </span>
                    <X className="i i-xs" aria-hidden />
                  </Button>
                )),
            );
            if (p.saved)
              chips.unshift(
                <Button key="saved" variant="ghost" className="cat-chip" aria-label="Remove filter Saved" onPress={() => unfilter("saved")}>
                  <Bookmark className="i i-xs" fill="currentColor" aria-hidden />
                  <span>Saved by me</span>
                  <X className="i i-xs" aria-hidden />
                </Button>,
              );
            const save = p.q || n ? (
              existing ? (
                <span className="cat-saved-view">
                  <Check className="i i-xs" aria-hidden />
                  View saved
                </span>
              ) : (
                <button type="button" className="link-button" onClick={() => setSaveOpen(true)}>
                  Save view
                  <Bookmark className="i i-sm" aria-hidden />
                </button>
              )
            ) : null;
            if (!chips.length && !save) return null;
            return (
              <div className="cat-chips">
                {chips}
                {chips.length ? (
                  <button type="button" className="link-button" onClick={clearFilters}>
                    Clear all
                  </button>
                ) : null}
                <span className="grow" />
                {save}
              </div>
            );
          })()}

          {landing && cat.page === 1 ? <ContinueReading /> : null}

          <section className="cat-main" aria-label="Documents">
            <div className="cat-head">
              <h2 className="cat-head__title">{title}</h2>
              {!cat.isError ? (
                <span className="cat-count" role="status">
                  {cat.isPending ? "" : plural(cat.total, "document")}
                </span>
              ) : null}
              <span className="grow" />
              {!p.q && n && cat.total ? (
                <Tooltip>
                  <Button variant="ghost" size="sm" onPress={ask}>
                    <Sparkles aria-hidden />
                    Ask about these
                  </Button>
                  <Tooltip.Content>Get an overview with sources from these documents</Tooltip.Content>
                </Tooltip>
              ) : null}
              <Button variant={extra ? "secondary" : "ghost"} size="sm" className={clsx(extra && "is-set")} onPress={() => setFiltersOpen(true)}>
                <SlidersVertical aria-hidden />
                {extra ? `Filters · ${extra}` : "Filters"}
              </Button>
              <Dropdown>
                <Button variant="ghost" size="sm" aria-label={`Sort: ${SORTS_CATALOG[sort]}`}>
                  <ArrowUpDown aria-hidden />
                  {SORTS_CATALOG[sort]}
                  <ChevronDown aria-hidden />
                </Button>
                <Dropdown.Popover placement="bottom end">
                  <Dropdown.Menu
                    aria-label="Sort by"
                    selectionMode="single"
                    selectedKeys={[sort]}
                    onAction={(k) => apply({ ...p, sort: String(k) === def ? "" : (String(k) as CatalogSort) })}
                  >
                    <Dropdown.Section>
                      <Header>Sort by</Header>
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
              <Segmented
                className="cat-layoutsw"
                label="Layout"
                value={p.view}
                onChange={(v) => apply({ ...p, view: v })}
                options={[
                  { value: "grid", label: "Grid", icon: LayoutGrid, iconOnly: true },
                  { value: "list", label: "List", icon: List, iconOnly: true },
                ]}
              />
            </div>
            {cat.isError && !cat.rows.length ? (
              p.q ? (
                <EmptyState
                  icon={AlertCircle}
                  tone="danger"
                  boxed
                  compact
                  title="This didn’t load"
                  description="Searching didn’t work just now. Try again, or clear the search to browse with filters."
                  actions={
                    <>
                      <Button variant="tertiary" onPress={() => void cat.refetch()}>
                        <RotateCw aria-hidden />
                        Try again
                      </Button>
                      <Button variant="secondary" onPress={clearQ}>
                        Clear search
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
                  <div key={i} className="doc-card" aria-hidden>
                    <span className="skeleton cat-skel-media" />
                    <div className="doc-card__body">
                      <span className="skeleton skeleton--line" style={{ width: "70%" }} />
                      <span className="skeleton skeleton--line" style={{ width: "95%", height: 10 }} />
                    </div>
                  </div>
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
            ) : (
              <EmptyState
                icon={Search}
                boxed
                compact
                title={p.q ? `No documents match “${p.q}”` : "No documents match these filters"}
                description={p.q ? "Try other words, or ask the assistant — it can answer from passages a title search misses." : "Try fewer filters."}
                actions={
                  <>
                    {n ? (
                      <Button variant="secondary" onPress={clearFilters}>
                        Clear filters
                      </Button>
                    ) : null}
                    {p.q ? (
                      <>
                        <Button variant="secondary" onPress={clearQ}>
                          Clear search
                        </Button>
                        <Button variant="primary" onPress={ask}>
                          <Sparkles aria-hidden />
                          Ask AI
                        </Button>
                      </>
                    ) : null}
                  </>
                }
              />
            )}
          </section>
          {locked ? (
            <NextLink className="cat-locked" href="/knowledge/bases">
              <Lock className="i i-sm" aria-hidden />
              <span>Some knowledge bases aren’t shared with you</span>
              <ArrowRight className="i i-sm" aria-hidden />
            </NextLink>
          ) : null}
        </>
      )}

      <FiltersDrawer
        isOpen={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        params={p}
        facets={facets}
        options={cat.facets}
        total={cat.total}
        savedCount={cat.savedCount}
        views={views.data ?? []}
        topics={topics.data ?? []}
        onApply={apply}
        onClear={clearFilters}
      />
      <QuickPreview target={peek} q={p.q} onClose={() => setPeek(null)} />
      <SaveViewDialog isOpen={saveOpen} onClose={() => setSaveOpen(false)} params={p} suggestion={suggestion} description={describeParams(p, optLabel)} />
    </Page>
  );
}
