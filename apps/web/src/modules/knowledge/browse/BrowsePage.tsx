"use client";

import { Button, Dropdown, Header, Label, SearchField, Tooltip } from "@heroui/react";
import clsx from "clsx";
import { AlertCircle, ArrowRight, ArrowUpDown, BookOpen, ChevronDown, LayoutGrid, List, Network, Plus, RotateCw, Search, Sparkles, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { IconButton } from "@/components/ui/IconButton";
import { LinkButton } from "@/components/ui/LinkButton";
import { Page } from "@/components/ui/Page";
import { Pager } from "@/components/ui/Pager";
import { Segmented } from "@/components/ui/Segmented";
import { resourceId } from "@/lib/api/client";
import { fmtNum, plural } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";

import type { SearchItemsResult } from "../api";
import { CreateCollectionDialog } from "../bases/components/CreateCollectionDialog";
import { conceptToneProps } from "../components/ConceptTag";
import { ContributeButton, KnowledgeHeader } from "../components/KnowledgeHeader";
import { ResourceCard } from "../components/ResourceCard";
import { ResourceList, ResourceRow } from "../components/ResourceRow";
import { SearchProgress } from "../components/SearchProgress";
import { openCitation } from "../content/open";
import {
  conceptOrder,
  optionPicked,
  pickOption,
  plainSnippet,
  queryWithout,
  referenceOfResult,
  snippetOf,
  SORTS_CATALOG,
  understoodTerms,
  unpickOption,
  type AmbiguityOption,
  type CatalogSort,
  type QueryAmbiguity,
  type Resource,
  type UnderstoodTerm,
} from "../model";
import { openDocumentPreview } from "../preview/store";
import { useKnowledgeBases, useKnowledgeModel, useSavedSearches } from "../queries";
import {
  conceptLabel,
  conceptLineage,
  conceptNameOf,
  conceptTop,
  firstScheme,
  narrowerOf,
  resourceKey,
  schemeByName,
  schemeLabel,
  schemeOfConcept,
  topConcepts,
  type Taxonomy,
} from "../taxonomy";
import { activeCount, browseFacets, browseHref, defaultSort, describeParams, filterLabels, parseBrowseQuery, PER_PAGE, pillConcept, type BrowseFacetId, type BrowseParams } from "./catalog";
import { FilterBar, useFacetName } from "./FilterBar";
import { useFacetLabel } from "./labels";
import { LockedCollection, LockedNote } from "./LockedCollections";
import { useCatalog, type BrowseOption } from "./useCatalog";
import { ViewsMenu } from "./ViewsMenu";

const PILLS = 6;
/** Documents per meaning while an ambiguous term's results are grouped. */
const GROUP_TOP = 6;

/* ═══════════════ Pieces ═══════════════ */

/** One pill. With `concept` it leads with the concept's icon in its family's color and, when chosen, takes a soft wash of
 *  that color (preview `pill`); All stays neutral. Concept names are content: never translated. */
function Pill({ label, on, count, concept, taxonomy, onPress }: { label: string; on: boolean; count?: number; concept?: string; taxonomy: Taxonomy; onPress: () => void }) {
  const tone = concept ? conceptToneProps(taxonomy, concept) : null;
  return (
    <button type="button" className={clsx("cat-pill", tone && "cat-pill--concept", on && "is-on")} style={tone?.style} aria-pressed={on} onClick={onPress}>
      {tone ? (
        <span className="cat-pill__ic" aria-hidden>
          <tone.Icon className="i" />
        </span>
      ) : null}
      <span translate={concept ? "no" : undefined}>{label}</span>
      {count !== undefined ? <span className="cat-pill__n">{fmtNum(count)}</span> : null}
    </button>
  );
}

/**
 * The first classification scheme's pills (preview `conceptBar`): its top concepts that hold results, in the scheme's
 * order, with their counts in one row (the first few, the rest under More); a chosen one reveals its narrower concepts.
 * Counts roll up: a document filed under a narrower concept counts under its top once.
 */
function ConceptBar({ p, options, taxonomy: t, onPick }: { p: BrowseParams; options: BrowseOption[]; taxonomy: Taxonomy; onPick: (id: string) => void }) {
  const m = useMessages();
  const s = firstScheme(t);
  if (!s?.name) return null;
  const counts = new Map(options.map((o) => [o.value, o.count ?? 0]));
  const count = (name: string | undefined) => counts.get(resourceKey(name)) ?? 0;
  const sel = pillConcept(p, t);
  const selName = sel ? conceptNameOf(s.name, sel) : "";
  const selTop = selName ? conceptTop(t, selName) : "";
  const tops = topConcepts(t, s.name).filter((c) => count(c.name) || c.name === selTop);
  if (!tops.length) return null;
  const shown = tops.slice(0, PILLS);
  const rest = tops.slice(PILLS);
  const promoted = rest.findIndex((c) => c.name === selTop);
  if (promoted >= 0) shown.push(rest.splice(promoted, 1)[0]);
  const kids = selTop ? narrowerOf(t, selTop).filter((c) => count(c.name)) : [];
  const lineage = selName ? conceptLineage(t, selName) : [];
  const name = schemeLabel(s);
  return (
    <>
      <div className="cat-pills" role="group" aria-label={name}>
        <Pill label={m.common.all} on={!sel} taxonomy={t} onPress={() => onPick("")} />
        {shown.map((c) => (
          <Pill key={c.name} label={conceptLabel(t, c.name)} on={c.name === selTop} count={count(c.name)} concept={c.name} taxonomy={t} onPress={() => onPick(resourceKey(c.name))} />
        ))}
        {rest.length ? (
          <Dropdown>
            <Dropdown.Trigger className="cat-pill cat-pill--more">
              Thêm
              <ChevronDown className="i i-xs" aria-hidden />
            </Dropdown.Trigger>
            <Dropdown.Popover placement="bottom start">
              <Dropdown.Menu aria-label={name} onAction={(key) => onPick(String(key))}>
                <Dropdown.Section>
                  <Header translate="no">{name}</Header>
                  {rest.map((c) => (
                    <Dropdown.Item key={c.name} id={resourceKey(c.name)} textValue={conceptLabel(t, c.name)}>
                      <Label className="grow" translate="no">
                        {conceptLabel(t, c.name)}
                      </Label>
                      <span className="menu-item__meta">{fmtNum(count(c.name))}</span>
                    </Dropdown.Item>
                  ))}
                </Dropdown.Section>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        ) : null}
      </div>
      {kids.length > 1 ? (
        <div className="cat-pills cat-pills--sub" role="group" aria-label={`Trong ${conceptLabel(t, selTop)}`}>
          <Pill label={`Tất cả ${conceptLabel(t, selTop)}`} on={selName === selTop} taxonomy={t} onPress={() => onPick(resourceKey(selTop))} />
          {kids.map((c) => (
            <Pill
              key={c.name}
              label={conceptLabel(t, c.name)}
              on={lineage.includes(c.name ?? "")}
              count={count(c.name)}
              concept={c.name}
              taxonomy={t}
              onPress={() => onPick(resourceKey(c.name))}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * What the search understood, right above the results (preview `interpLine`): each reading a removable chip in its
 * concept's color (× searches without it); a picked meaning a chip too (× goes back to the choice); a term with several
 * meanings offers one button per meaning — picking one filters to it.
 */
function Interpretation({
  terms,
  picked,
  open,
  taxonomy: t,
  onDrop,
  onUnpick,
  onPick,
}: {
  terms: readonly UnderstoodTerm[];
  picked: readonly AmbiguityOption[];
  open: QueryAmbiguity | undefined;
  taxonomy: Taxonomy;
  onDrop: (term: UnderstoodTerm) => void;
  onUnpick: (option: AmbiguityOption) => void;
  onPick: (option: AmbiguityOption) => void;
}) {
  const chip = (key: string, scheme: string, concepts: readonly string[], onPress: () => void) => {
    const s = schemeLabel(schemeByName(t, scheme));
    const names = concepts.map((c) => conceptLabel(t, c)).join(", ");
    return (
      <button key={key} type="button" className="cat-chip cat-chip--concept" style={conceptToneProps(t, concepts[0]).style} aria-label={`Tìm không theo ${s}: ${names}`} onClick={onPress}>
        <span className="cat-chip__k" translate="no">{`${s}:`}</span>
        <span className="truncate" translate="no">
          {names}
        </span>
        <X className="i i-xs" aria-hidden />
      </button>
    );
  };
  const chips = [
    ...terms.map((term) => chip(term.key, term.scheme, term.concepts, () => onDrop(term))),
    ...picked.map((o) => chip(`pick:${o.scheme}:${o.displayName}`, o.scheme ?? "", o.concepts ?? [], () => onUnpick(o))),
  ];
  const options = (open?.options ?? []).filter((o) => o.concepts?.length);
  if (!chips.length && !options.length) return null;
  return (
    <div className="cat-interp" role="group" aria-label="Cách hệ thống hiểu nội dung bạn tìm">
      {chips.length ? (
        <div className="cat-interp__row">
          <span className="cat-interp__k">Hiểu là</span>
          {chips}
        </div>
      ) : null}
      {open && options.length ? (
        <div className="cat-interp__row">
          <span className="cat-interp__k">{`“${open.text}” có thể là:`}</span>
          {options.map((o) => {
            const tone = conceptToneProps(t, o.concepts![0]);
            const label = o.displayName || `${o.concepts!.map((c) => conceptLabel(t, c)).join(", ")} · ${schemeLabel(schemeByName(t, o.scheme))}`;
            return (
              <button key={`${o.scheme}:${label}`} type="button" className="cat-qopt" style={tone.style} onClick={() => onPick(o)}>
                <tone.Icon className="i i-xs" aria-hidden />
                <span className="truncate" translate="no">
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
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
 * Knowledge › Browse (preview `P.catalog`, features/hub.js): one search field, the first classification scheme's
 * concepts as pills, then the documents with inline filters (the other schemes first), Views, sort and layout. A
 * search is also read for the concepts it names (SearchItems `interpretation`): what it understood shows as removable
 * chips above the results; a term with several meanings offers one button per meaning and splits the results into one
 * group per meaning until one is picked (`pick=all` lists every result without choosing). The URL holds the set.
 */
export function BrowsePage() {
  const router = useRouter();
  const search = useSearchParams();
  const { hasModule } = useWorkspace();
  const { toResource, taxonomy } = useKnowledgeModel();
  const allFacets = useMemo(() => browseFacets(hasModule("spaces"), taxonomy), [hasModule, taxonomy]);
  const p = useMemo(() => parseBrowseQuery(search, allFacets), [search, allFacets]);
  const first = firstScheme(taxonomy);
  const firstId = resourceKey(first?.name);
  /** Filter facets: everything but the first scheme, which the pills own. */
  const facets = useMemo(() => allFacets.filter((f) => f.id !== firstId), [allFacets, firstId]);
  const cat = useCatalog(p, allFacets);
  const views = useSavedSearches();
  const allBases = useKnowledgeBases({ showLocked: true });
  // Owner chips are labelled by the catalog's facets (the search names owners), so no owner is looked up here.
  const label = useFacetLabel({ sources: (p.filters.src ?? []).filter((s) => s !== "upload") });
  const facetName = useFacetName();
  /** Every result in one list without choosing a meaning (preview `pick=all`); new words start over. */
  const all = search.get("pick") === "all";

  const apply = (next: BrowseParams) => {
    const href = browseHref(next);
    router.replace(all && next.q === p.q ? `${href}${href.includes("?") ? "&" : "?"}pick=all` : href, { scroll: false });
  };

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
  const pc = pillConcept(p, taxonomy);
  const landing = !p.q && !n;
  const optLabel = (f: BrowseFacetId, v: string) => cat.facets[f]?.find((o) => o.value === v)?.label ?? label(f, v);
  const labels = filterLabels(p, optLabel, allFacets);

  /* What the search understood (SearchItems `interpretation`). A meaning is picked when its concepts are this search's
     filter; the first ambiguity not picked yet stays open and, unless `pick=all`, groups the results. */
  const interp = p.q ? cat.interpretation : undefined;
  const terms = understoodTerms(interp);
  const ambiguities = interp?.ambiguities ?? [];
  const picked = ambiguities.flatMap((a) => (a.options ?? []).filter((o) => optionPicked(o, p)));
  const pickedValues = new Set(picked.flatMap((o) => (o.concepts ?? []).map((c) => `${resourceKey(o.scheme)}:${resourceKey(c)}`)));
  const open = ambiguities.find((a) => !(a.options ?? []).some((o) => optionPicked(o, p)));
  const groups = open && !all ? (interp?.groups ?? []).filter((g) => g.results?.length && (open.options ?? []).some((o) => o.displayName === g.option)) : [];
  /** × on an understood reading: search without its words (SearchItems can't set a reading aside). */
  const dropTerm = (term: UnderstoodTerm) => {
    const q = queryWithout(p.q, term.text);
    setText(q);
    lastQ.current = q;
    apply({ ...p, q });
  };

  const onPill = (v: string) => {
    if (firstId) apply({ ...p, filters: { ...p.filters, [firstId]: v ? [v] : [] } });
  };
  /** Clear all: every filter, the pill included (the search words stay; they have their own ×). */
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

  /** Click, Enter or Space: the shared document preview (a near-full-screen sheet on phones), at the matching blocks when the search returned a reference. */
  const select = (r: Resource, result: SearchItemsResult) => {
    const match = referenceOfResult(result);
    if (match) openCitation({ ...match.reference, collection: r.base?.name });
    else openDocumentPreview({ item: r.item?.name ?? r.id, listed: r.item, q: p.q });
  };

  const sort = (p.sort || defaultSort(p)) as CatalogSort;
  const def = defaultSort(p);
  const toRows = (results: readonly SearchItemsResult[]) => results.map((x) => ({ x, r: toResource(x.item ?? {}) }));
  const rows = toRows(cat.rows);
  /** The first-scheme concept a document's card would show first. */
  const firstConcept = (r: Resource) => conceptOrder(taxonomy, r.assignments).find((c) => schemeOfConcept(c) === first?.name) ?? "";
  /** A set's documents as the layout draws them; cards leave out the context every card shares (one collection, one concept of the first scheme). */
  const resultSet = (set: { x: SearchItemsResult; r: Resource }[]): ReactNode => {
    if (p.view === "list")
      return (
        <ResourceList>
          {set.map(({ x, r }) => (
            <ResourceRow key={r.id} resource={r} q={p.q} snippet={plainSnippet(snippetOf(x))} onOpen={() => select(r, x)} />
          ))}
        </ResourceList>
      );
    const one = (f: (r: Resource) => string) => set.length > 1 && new Set(set.map(({ r }) => f(r))).size === 1;
    const shared = [one((r) => r.base?.name ?? "") && "kb", one(firstConcept) && "concept"].filter(Boolean) as ("kb" | "concept")[];
    return (
      <div className="cat-cards">
        {set.map(({ x, r }) => {
          const match = referenceOfResult(x);
          return <ResourceCard key={r.id} resource={r} q={p.q} match={match && { text: match.reference.quote, where: match.where }} hide={shared} onOpen={() => select(r, x)} />;
        })}
      </div>
    );
  };
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
      .filter((v) => !(f.id === firstId && v === pc) && !pickedValues.has(`${f.id}:${v}`))
      .map((v) => (
        <button key={`${f.id}:${v}`} type="button" className="cat-chip" aria-label={`Gỡ bộ lọc ${facetName(f)}: ${optLabel(f.id, v)}`} onClick={() => unfilter(f.id, v)}>
          <span className="cat-chip__k" translate={f.scheme ? "no" : undefined}>
            {facetName(f)}
          </span>
          <span className="truncate" translate={(cat.facets[f.id]?.find((o) => o.value === v)?.ui ?? label.ui(f.id, v)) ? undefined : "no"}>
            {optLabel(f.id, v)}
          </span>
          <X className="i i-xs" aria-hidden />
        </button>
      )),
  );

  /** A term with several meanings, none picked (preview `groupedResults`): one section per meaning (its first documents; See
   *  all picks it), then Other matches (See all lists every result without choosing). */
  const grouped = () => {
    const inGroups = new Set(groups.flatMap((g) => (g.results ?? []).map((x) => x.item?.name)));
    const others = rows.filter(({ r }) => !inGroups.has(r.name)).slice(0, GROUP_TOP);
    return (
      <div className="cat-results cat-qgroups">
        {groups.map((g) => {
          const option = open?.options?.find((o) => o.displayName === g.option);
          const set = toRows((g.results ?? []).filter((x) => x.item));
          return (
            <section key={g.option} className="cat-qgroup" aria-label={g.option}>
              <div className="cat-qgroup__head">
                <h3 className="cat-qgroup__title" translate="no">
                  {g.option}
                </h3>
                <span className="cat-count">{fmtNum(set.length)}</span>
                <span className="grow" />
                {option ? (
                  <LinkButton icon={ArrowRight} onPress={() => apply(pickOption(p, option))}>
                    Xem tất cả
                  </LinkButton>
                ) : null}
              </div>
              {resultSet(set)}
            </section>
          );
        })}
        {others.length ? (
          <section className="cat-qgroup" aria-label="Kết quả khác">
            <div className="cat-qgroup__head">
              <h3 className="cat-qgroup__title">Kết quả khác</h3>
              <span className="grow" />
              <LinkButton icon={ArrowRight} href={`${browseHref(p)}${browseHref(p).includes("?") ? "&" : "?"}pick=all`}>
                {`Xem tất cả ${fmtNum(cat.total)}`}
              </LinkButton>
            </div>
            {resultSet(others)}
          </section>
        ) : null}
      </div>
    );
  };

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
  ) : cat.total && groups.length && cat.page === 1 ? (
    grouped()
  ) : cat.total ? (
    <>
      <div className="cat-results">{resultSet(rows)}</div>
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
            <ConceptBar p={p} options={cat.facets[firstId] ?? []} taxonomy={taxonomy} onPick={onPill} />
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
                <SearchField aria-label="Tìm theo tiêu đề, khái niệm và nội dung" value={text} onChange={setText} onClear={clearQ} className="cat-search">
                  <SearchField.Group>
                    <SearchField.SearchIcon>
                      <Search className="i" aria-hidden />
                    </SearchField.SearchIcon>
                    <SearchField.Input ref={inputRef} placeholder="Tìm theo tiêu đề, khái niệm và nội dung" autoComplete="off" />
                    {text ? <SearchField.ClearButton aria-label="Xóa tìm kiếm" /> : null}
                  </SearchField.Group>
                </SearchField>
              }
              end={
                <>
                  <ViewsMenu p={p} views={views.data ?? []} onApply={apply} suggestion={suggestion} summary={describeParams(p, optLabel, allFacets)} />
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
            <Interpretation
              terms={terms}
              picked={picked}
              open={open}
              taxonomy={taxonomy}
              onDrop={dropTerm}
              onUnpick={(o) => apply(unpickOption(p, o))}
              onPick={(o) => apply(pickOption(p, o))}
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
