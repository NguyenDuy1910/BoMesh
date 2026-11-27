"use client";

import { Button, Dropdown, Label } from "@heroui/react";
import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { Archive, ArrowRight, ArrowUpDown, ChevronDown, CircleCheck, CircleX, Clock, Eye, EyeOff, Files, Pencil, Play, ShieldCheck, Upload, X, type LucideIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import {
  BulkBar,
  ClearFilters,
  DataTable,
  EmptyState,
  ErrorState,
  FileIcon,
  FilterButton,
  LinkButton as TextAction,
  NoMatches,
  PageHeader,
  Pager,
  SearchInput,
  SectionTabs,
  SkeletonRows,
  Tip,
  toast,
  type DataTableColumn,
  type DataTableSort,
} from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { fmtDateTime, fmtNum, plural, rel } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";
import { useSources } from "@/modules/ingestion/queries";
import { getSource, listAllItems, listItems, type DocumentConcept, type Item } from "@/modules/knowledge/api";
import { ConceptTag } from "@/modules/knowledge/components/ConceptTag";
import { openContribute } from "@/modules/knowledge/components/contribute-store";
import { ProcessingChip } from "@/modules/knowledge/components/LifecycleChip";
import { DOC_TYPES, docTypeOptions, type DocTypeId } from "@/modules/knowledge/model";
import { knowledgeKeys, useItem, useKnowledgeBases, useKnowledgeModel, useMemberNames } from "@/modules/knowledge/queries";
import { classSchemes, conceptLabel, conceptsOf, conceptState, docAssignments, schemeLabel, schemeOfConcept } from "@/modules/knowledge/taxonomy";

import { pageContributionsOf, type IngestionRun } from "../api";
import { conceptParam, DOC_FACETS, docQueryOf, documentFilter, listFilter, type DocFacet, type DocQuery } from "../docFilter";
import { canProcess, isCandidate, PROCESSING_ORDER, type PublicationKey } from "../lifecycle";
import {
  canUnpublishRow,
  DOC_VIEWS,
  docView,
  isRowFix,
  opsFor,
  processingLine,
  QUALITY_PARTS,
  qualityCount,
  qualityOf,
  rowOf,
  viewCount,
  type DocCounts,
  type DocRow,
  type DocView,
  type QualityPart,
} from "../model";
import { curationKeys, useContributionsOf, useDocCounts } from "../queries";
import { DocumentDrawer } from "./DocumentDrawer";
import { DemoChip, LinkButton, SourceName } from "./parts";
import { ProcessDialog, type ProcessRequest } from "./ProcessDialog";
import { ProcessingStrip } from "./ProcessingStrip";
import { DetailsQueue } from "./review/DetailsQueue";
import { DuplicatesQueue } from "./review/DuplicatesQueue";
import { MenuFilter } from "./review/MenuFilter";
import { ProcessingQueue } from "./review/ProcessingQueue";
import { ReverifyQueue } from "./review/ReverifyQueue";
import { SubmissionsQueue } from "./review/SubmissionsQueue";
import { OP_META, useDocOps } from "./useDocOps";

const PER = 25;
/** "All matching" Publish / Unpublish / Archive read the matching documents first, at most this many. */
const MATCHING_MAX = 1000;

/**
 * Knowledge Studio → Documents (preview `P.studio` documents): every document in the collections the caller
 * reviews, in three views as page tabs (`?view=`), in the order work flows: All (the registry, with its Quality
 * filter `?quality=reverify|details|duplicates`), Processing (what isn't processed yet: new documents' submissions
 * first — the assistant classifies them for review — then documents nobody processed, failed or changed at their
 * source) and Review (submissions ready to decide). Without a `?view=` it opens on Review while it has entries (or
 * `?sel=` names a submission), else Processing while something there waits on the caller, else All. Processing
 * counts quietly, Review what waits for a decision; All carries no count. The header's one action is Add documents
 * (secondary in Processing and Review, whose own primaries are Process and the decision bar). All and Processing
 * show the processing strip while a run is in flight.
 */
export function DocumentsSection() {
  const { can } = useWorkspace();
  const m = useMessages();
  const params = useSearchParams();
  const counts = useDocCounts();
  const c = counts.data;
  const asked = params.get("view");
  const explicit = DOC_VIEWS.some((v) => v === asked);
  const view: DocView | null = c || explicit ? docView({ view: asked, sel: params.get("sel") }, c ?? ZERO) : null;
  const kb = params.get("kb") ?? "";

  /** A view's address: this one with `view=` set; the open document and the view's own filters stay behind. */
  const viewHref = (v: DocView) => {
    const next = new URLSearchParams(params.toString());
    for (const k of ["sel", "quality", "state", "processing"]) next.delete(k);
    next.set("tab", "documents");
    next.set("view", v);
    return `/studio?${next.toString()}`;
  };

  const upload = can("contributions.create") ? (
    <Button variant={view === "all" ? "primary" : "secondary"} onPress={() => openContribute(kb ? { collection: kb } : {})}>
      <Upload className="i" aria-hidden />
      Thêm tài liệu
    </Button>
  ) : null;
  const tabs = DOC_VIEWS.map((id) => {
    const n = c ? viewCount(c, id) : 0;
    return { id, label: m.studio.documentViews[id], href: viewHref(id), count: n || null, alert: id === "review" };
  });
  const header = (
    <PageHeader title={m.nav.documents} chips={<DemoChip />} actions={upload}>
      {view ? <SectionTabs items={tabs} active={view} label={m.studio.documentViews.label} /> : null}
    </PageHeader>
  );
  if (!view) {
    return (
      <>
        {header}
        <SkeletonRows rows={8} />
      </>
    );
  }

  const done = <ViewDone view={view} counts={c ?? ZERO} href={viewHref} />;
  const quality = view === "all" ? qualityOf(params.get("quality")) : "";
  return (
    <>
      {header}
      {view === "all" || view === "processing" ? <ProcessingStrip showThem={view === "all"} /> : null}
      {view === "review" ? (
        <SubmissionsQueue kb={kb} done={done} />
      ) : view === "processing" ? (
        <ProcessingQueue kb={kb} state={params.get("state") ?? ""} done={done} />
      ) : quality ? (
        <QualityList part={quality} counts={c} />
      ) : (
        <AllView counts={c} />
      )}
    </>
  );
}

const ZERO: DocCounts = { review: 0, processing: 0, waiting: 0, submissions: 0, reverify: 0, details: 0, duplicates: 0 };

/** A view that's done: say so, and point at the step that has something (preview `viewDone`). */
function ViewDone({ view, counts, href }: { view: DocView; counts: DocCounts; href: (v: DocView) => string }) {
  const next = (label: string, v: DocView) => (
    <LinkButton href={href(v)} icon={ArrowRight} variant="secondary">
      {label}
    </LinkButton>
  );
  const all = (
    <LinkButton href={href("all")} variant="secondary">
      Xem tất cả tài liệu
    </LinkButton>
  );
  if (view === "processing") {
    return (
      <EmptyState
        icon={CircleCheck}
        tone="success"
        boxed
        title="Mọi tài liệu đã được xử lý"
        description="Tài liệu chờ duyệt và tài liệu chưa xử lý sẽ hiện ở đây. Sau khi xử lý xong, tài liệu chờ duyệt chuyển sang mục Chờ duyệt."
        actions={counts.review ? next("Đến mục Chờ duyệt", "review") : all}
      />
    );
  }
  const n = counts.submissions;
  return (
    <EmptyState
      icon={CircleCheck}
      tone="success"
      boxed
      title="Không có gì cần duyệt"
      description={
        n
          ? `${plural(n, "submission")} đang chờ xử lý. Hãy xử lý trước: trợ lý sẽ phân loại để bạn duyệt.`
          : "Tài liệu chờ duyệt đã xử lý và phiên bản mới sẽ hiện ở đây, mỗi mục một quyết định."
      }
      actions={n ? next("Đến mục Đang xử lý", "processing") : all}
    />
  );
}

/**
 * All filtered by quality (preview `qualityList`): one of the lists that keep published knowledge right, each row with
 * its fix — Verify, add details, Compare. Show all documents clears it.
 */
function QualityList({ part, counts }: { part: QualityPart; counts: DocCounts | undefined }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const quality = useMessages().studio.quality;
  const setQuality = (v: string) => {
    const next = new URLSearchParams(params.toString());
    next.delete("sel");
    if (v) next.set("quality", v);
    else next.delete("quality");
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };
  const pills = QUALITY_PARTS.map((id) => ({ id, label: quality[id], count: counts?.[id] || null }));
  return (
    <>
      <div className="cur-quality">
        <SectionTabs items={pills} active={part} variant="primary" label={quality.label} onChange={setQuality} />
        <TextAction size="sm" onPress={() => setQuality("")}>
          Hiển thị mọi tài liệu
        </TextAction>
      </div>
      {part === "reverify" ? <ReverifyQueue /> : part === "details" ? <DetailsQueue /> : <DuplicatesQueue />}
    </>
  );
}

const FACET_LABEL: Readonly<Record<DocFacet, string>> = { kb: "Kho tài liệu", pub: "Công bố", src: "Nguồn gốc", type: "Loại", concept: "Khái niệm" };
const NO_QUERY: Record<keyof DocQuery, string> = { processing: "", kb: "", pub: "", src: "", type: "", concept: "", q: "" };

/** Publication as a quiet line with its icon (preview `pubCell`). */
const PUB_ICON: Readonly<Record<PublicationKey, LucideIcon>> = { published: Eye, unpublished: EyeOff, review: Clock, changes: Pencil, rejected: CircleX };

const settled = (r: DocRow) => r.publication === "published" || r.publication === "unpublished";

/**
 * Documents → All (preview `documentsTab`): the one administrative registry of every document in the collections
 * the caller looks after, whatever its origin, read a page at a time from ListItems with the filters as its AIP-160
 * `filter` (`../docFilter`). Search and Collection, Publication, Origin, Type, Concept and Processing in the toolbar, and
 * the Quality menu (Re-verification due · Missing details · Possible duplicates, with counts) that switches All to that
 * list (`?quality=`). Selecting rows offers Process · Publish · Unpublish · Archive; with the whole page selected,
 * "Select all matching" makes the filter the selection.
 * URL: `?view=all &processing= &kb= &pub= &src= &type= &concept= &q= &quality= &sel=`.
 */
function AllView({ counts }: { counts: DocCounts | undefined }) {
  const { id: ws } = useWorkspace();
  const msg = useMessages();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const bases = useKnowledgeBases();
  const sources = useSources();
  const { ctx, taxonomy } = useKnowledgeModel();
  const ops = useDocOps();

  /* ── URL state → the filter ── */
  const query = docQueryOf((k) => params.get(k));
  const scopeBases = useMemo(() => (bases.data ?? []).filter((b) => b.itemType !== "PERSONAL" && (b.access === "EDITOR" || b.access === "OWNER")), [bases.data]);
  const scope = scopeBases.map((b) => b.name ?? "");
  const documents = documentFilter(query, { workspace: ws, scope });
  const filter = listFilter(documents);
  const filtered = Object.values({ ...query }).some(Boolean);
  const selId = params.get("sel") ?? "";

  const [sort, setSort] = useState<DataTableSort>({ column: "updated", direction: "descending" });
  const orderBy = sort.column === "name" ? `displayName${sort.direction === "descending" ? " desc" : ""}` : `updateTime${sort.direction === "ascending" ? "" : " desc"}`;
  const [page, setPage] = useState(1);
  const [tokens, setTokens] = useState<string[]>([""]);
  /** Checked rows by ID, on any page. */
  const [selected, setSelected] = useState<ReadonlyMap<string, DocRow>>(new Map());
  const [allMatching, setAllMatching] = useState(false);
  const [processing, setProcessing] = useState<ProcessRequest | null>(null);
  // A new filter or order starts over: page 1, nothing selected.
  const listKey = `${filter}|${orderBy}`;
  const [at, setAt] = useState(listKey);
  if (at !== listKey) {
    setAt(listKey);
    setPage(1);
    setTokens([""]);
    setSelected(new Map());
    setAllMatching(false);
  }

  const setParam = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    next.set("tab", "documents");
    next.set("view", "all");
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  const token = tokens[page - 1] ?? "";
  const list = useQuery({
    queryKey: curationKeys.documents(ws, filter, orderBy, token),
    queryFn: () => listItems(ws, { filter, orderBy, pageSize: PER, pageToken: token || undefined, view: "FULL" }),
    enabled: !!bases.data && scope.length > 0,
    placeholderData: keepPreviousData,
  });

  const baseNames = ctx.collectionNames ?? new Map<string, string>();
  const pageItems = list.data?.items ?? [];
  const pageContributions = useContributionsOf(pageItems.map((it) => it.name ?? ""));
  const toRow = (it: Item) => rowOf(it, pageContributions.data?.get(it.name ?? "") ?? null, baseNames);
  const rows = pageItems.map(toRow);
  const opened = rows.find((r) => r.id === selId);
  const selItem = useItem(selId && !opened ? selId : null);
  const selContribution = useContributionsOf(selItem.data?.name ? [selItem.data.name] : []);
  const open = opened ?? (selItem.data ? rowOf(selItem.data, selContribution.data?.get(selItem.data.name ?? "") ?? null, baseNames) : null);

  const memberNames = useMemberNames(rows.flatMap((r) => [r.contributor]));
  const pageSources = [...new Set(rows.flatMap((r) => (r.source ? [r.source] : [])))];
  const sourceNames = useSourceNames(pageSources);

  if (bases.isPending || (scope.length > 0 && list.isPending)) return <SkeletonRows rows={8} />;
  if (bases.isError || list.isError) {
    return (
      <ErrorState
        error={bases.error ?? list.error}
        onRetry={() => {
          void bases.refetch();
          void list.refetch();
        }}
      />
    );
  }
  const total = list.data?.totalSize;
  if (!scope.length || (!filtered && !rows.length && page === 1)) {
    return <EmptyState icon={Files} boxed title="Chưa có tài liệu" description="Tài liệu được thêm vào các kho tài liệu bạn phụ trách sẽ hiển thị ở đây, dù đến từ đâu." />;
  }

  /* ── Facets: Collection only when there's more than one ── */
  const memberName = (r: DocRow) => memberNames.get(r.contributor ?? "") || "";
  const originName = (r: DocRow) => (r.source ? sourceNames.get(r.source) || "Đồng bộ nguồn dữ liệu" : memberName(r));
  const kbOpts = scopeBases.map((b) => [resourceId(b.name), b.displayName || "Kho tài liệu"] as [string, string]).sort((a, b) => a[1].localeCompare(b[1]));
  const allSources = new Map<string, string>((sources.data ?? []).map((s) => [s.name ?? "", s.displayName ?? ""]));
  for (const s of pageSources) if (!allSources.has(s)) allSources.set(s, sourceNames.get(s) || "Đồng bộ nguồn dữ liệu");
  const originOpts: [string, string][] = [
    ["upload", "Tệp tải lên và tài liệu đã gửi"],
    ...[...allSources].map(([s, label]) => [resourceId(s), label || "Đồng bộ nguồn dữ liệu"] as [string, string]).sort((a, b) => a[1].localeCompare(b[1])),
  ];
  // Type: the file class (`itemType`), derived from the file; any class a document can have.
  const typeOpts = docTypeOptions(Object.keys(DOC_TYPES) as DocTypeId[]);
  // Concept: the published concepts of the classification schemes, by scheme (named when there are several), then by name.
  const classification = classSchemes(taxonomy);
  const conceptOpts: [string, string][] = classification.flatMap((s) =>
    conceptsOf(taxonomy, s.name ?? "")
      .filter((c) => conceptState(c) === "PUBLISHED")
      .map((c) => [c.name ?? "", conceptLabel(taxonomy, c.name)] as const)
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([name, label]) => [conceptParam(name), classification.length > 1 ? `${schemeLabel(s)} · ${label}` : label] as [string, string]),
  );
  const facetOpts: Readonly<Record<DocFacet, [string, string][]>> = {
    kb: kbOpts,
    pub: [
      ["published", msg.state.publication.published.label],
      ["unpublished", msg.state.publication.unpublished.label],
    ],
    src: originOpts,
    type: typeOpts,
    concept: conceptOpts,
  };
  const facetValue = (k: DocFacet) => (k === "concept" ? conceptParam(query.concept) : resourceId(query[k]) || query[k]);
  const facets = DOC_FACETS.filter((k) => facetOpts[k].length > 1 || query[k]).map((k) => [k, FACET_LABEL[k], facetOpts[k]] as const);
  const nSet = DOC_FACETS.filter((k) => query[k]).length;
  const clearFacets = () => setParam({ kb: "", pub: "", src: "", type: "", concept: "", processing: "" });
  const sortLabel = sort.column === "name" ? "Tên" : "Mới cập nhật";
  const procOpts = PROCESSING_ORDER.map((k) => ({ value: k, label: msg.state.processing[k].label }));
  const qualityTotal = counts ? qualityCount(counts) : 0;

  const columns: DataTableColumn<DocRow>[] = [
    {
      id: "name",
      header: "Tên",
      primary: true,
      sortValue: (r) => r.title.toLowerCase(),
      cell: (r) => {
        const where = (r.item?.ancestors?.map((a) => a.displayName ?? "").filter(Boolean) ?? [r.baseName]).join(" › ");
        const from = originName(r);
        return (
          <div className="row gap-12">
            <FileIcon name={r.fileName} mime={r.mime} />
            <div className="grow min-w-0">
              <div className="cell-title truncate" title={r.title} translate="no">
                {r.title}
              </div>
              <div className="cell-sub truncate">
                <span translate="no">{where}</span>
                {from ? (
                  <>
                    <span aria-hidden="true"> · </span>
                    <span translate="no">{r.source ? <SourceName source={r.source} /> : from}</span>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      id: "processing",
      header: "Trạng thái xử lý",
      cell: (r) => {
        if (!settled(r) && !isCandidate(r.contribution)) return <span className="cell-sub">—</span>;
        const line = processingLine(r);
        return (
          <div className="stack gap-2">
            <ProcessingChip state={r.processing} />
            <span className={`cell-sub truncate${r.processing === "failed" || r.processing === "outdated" ? " cur-ix--bad" : ""}`} title={line}>
              {line}
            </span>
          </div>
        );
      },
    },
    {
      id: "publication",
      header: "Công bố",
      hideOnMobile: true,
      cell: (r) => {
        const Icon = PUB_ICON[r.publication];
        return (
          <span className={`cur-pub cur-pub--${r.publication}`}>
            <Icon className="i i-xs" aria-hidden />
            <span className="truncate">{msg.state.publication[r.publication].label}</span>
          </span>
        );
      },
    },
    {
      id: "concepts",
      header: "Phân loại",
      hideOnMobile: true,
      cell: (r) => {
        // Its classification and who chose it (preview `conceptCell`): the primary concept of the first scheme as its tag,
        // +n for the rest (names in the tooltip). A submission's is the assistant's once it's processed.
        const inReview = r.publication === "review" || r.publication === "changes";
        const classified = !inReview || r.processing === "ready";
        const order = classification.map((s) => s.name ?? "");
        const schemeOf = (a: DocumentConcept) => a.scheme ?? schemeOfConcept(a.concept ?? "");
        const list = (classified ? docAssignments(taxonomy, r.assignments) : [])
          .filter((a) => !a.section && order.includes(schemeOf(a)))
          .sort((a, b) => order.indexOf(schemeOf(a)) - order.indexOf(schemeOf(b)) || Number(!!b.primary) - Number(!!a.primary));
        if (!list.length) {
          const none =
            r.processing === "failed" ? "Chưa phân loại: không có văn bản để đọc" : r.processing === "pending" ? "Phân loại khi được xử lý" : inReview ? "Đang phân loại…" : "Chưa có khái niệm";
          return <span className="cur-concept-cell is-none">{none}</span>;
        }
        const by = inReview
          ? "Được đề xuất"
          : list.some((a) => a.state === "SUGGESTED")
            ? "Chờ duyệt"
            : list.every((a) => a.source !== "HUMAN")
              ? "Trợ lý"
              : "Do người chọn";
        const rest = list.slice(1).map((a) => conceptLabel(taxonomy, a.concept));
        return (
          <div className="stack gap-2 cur-concept-cell">
            <span className="cur-concept-tags">
              <ConceptTag taxonomy={taxonomy} concept={list[0].concept ?? ""} />
              {rest.length ? <span className="cur-concept-more" title={rest.join(", ")}>{`+${rest.length}`}</span> : null}
            </span>
            <span className="cell-sub">{by}</span>
          </div>
        );
      },
    },
    {
      id: "updated",
      header: "Đã cập nhật",
      sortValue: (r) => r.updated,
      cell: (r) => (
        <Tip content={fmtDateTime(r.updated)}>
          <span className="muted cur-nowrap">{rel(r.updated)}</span>
        </Tip>
      ),
    },
  ];

  /* ── Selection: checked rows (any page), or every matching document ── */
  const selectedRows = () => [...selected.values()].filter((r) => !!r.item);
  const allPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const more = !!list.data?.nextPageToken || page > 1;
  const clearSelection = () => {
    setSelected(new Map());
    setAllMatching(false);
  };
  /** Publish, Unpublish and Archive act on rows; "all matching" reads the matching documents first, then their latest
   *  contributions a page's worth of documents per read (like the page itself). */
  const actOn = async (act: (rows: DocRow[], done: () => void) => Promise<void>) => {
    if (!allMatching) return act(selectedRows(), clearSelection);
    const items = await listAllItems(ws, { filter, view: "FULL" }, MATCHING_MAX);
    if (items.length >= MATCHING_MAX) toast(`Chỉ bao gồm ${fmtNum(MATCHING_MAX)} tài liệu khớp đầu tiên`, { tone: "warning" });
    const pages = Array.from({ length: Math.ceil(items.length / PER) }, (_, i) => items.slice(i * PER, (i + 1) * PER).map((it) => it.name ?? ""));
    const latest = new Map((await Promise.all(pages.map((names) => pageContributionsOf(ws, names)))).flatMap((m) => [...m]));
    return act(
      items.map((it) => rowOf(it, latest.get(it.name ?? "") ?? null, baseNames)),
      clearSelection,
    );
  };
  const process = () => {
    if (allMatching) {
      setProcessing({ rows: [], filter: documents, collections: query.kb ? [`workspaces/${ws}/items/${resourceId(query.kb)}`] : scope });
      return;
    }
    const picked = selectedRows();
    const todo = picked.filter((r) => canProcess({ item: r.item, contribution: settled(r) ? null : r.contribution }));
    if (!todo.length) {
      toast(
        picked.some((r) => r.processing === "processing")
          ? "Các tài liệu này đang được xử lý"
          : picked.some((r) => r.processing === "unsupported")
            ? "Không xử lý được hình ảnh và tệp nén."
            : "Không tài liệu nào xử lý được",
        { tone: "danger" },
      );
      return;
    }
    setProcessing({ rows: todo, collections: [...new Set(todo.map((r) => r.base).filter(Boolean))] });
  };
  const started = (run: IngestionRun, n: number | null) => {
    setProcessing(null);
    clearSelection();
    const count = run.counts?.totalCount ?? n;
    toast(count != null ? `Đang xử lý ${plural(count, "document")}` : "Đang xử lý các tài liệu khớp", {
      tone: "accent",
      action: { label: "Xem các tài liệu này", onPress: () => setParam({ processing: "processing" }) },
    });
  };

  return (
    <>
      <div className="toolbar cur-toolbar">
        <SearchInput value={query.q} onChange={(v) => setParam({ q: v })} placeholder="Tìm kiếm tài liệu" />
        <div className="cur-filters--wide">
          {facets.map(([key, label, opts]) => (
            <FilterButton key={key} label={label} options={opts.map(([value, l]) => ({ value, label: l }))} value={facetValue(key)} onChange={(v) => setParam({ [key]: v })} />
          ))}
          <FilterButton label="Trạng thái xử lý" options={procOpts} value={query.processing} onChange={(v) => setParam({ processing: v })} />
          <ClearFilters isActive={!!nSet || !!query.processing} onClear={clearFacets} />
        </div>
        <div className="cur-filters--narrow">
          <MenuFilter
            label={nSet || query.processing ? `Bộ lọc · ${nSet + (query.processing ? 1 : 0)}` : ""}
            sections={[
              ...facets.map(([key, label, opts]) => ({
                title: label,
                value: facetValue(key),
                options: [
                  { value: "", label: "Bất kỳ" },
                  // Collection, concept and source names are workspace data; "Uploads and contributions" and the
                  // "Source sync" fallback are UI copy.
                  ...opts.map(([value, l]) => ({ value, label: l, data: key === "kb" || key === "concept" || (key === "src" && value !== "upload" && l !== "Đồng bộ nguồn dữ liệu") })),
                ],
                onChange: (v: string) => setParam({ [key]: v }),
              })),
              { title: "Trạng thái xử lý", value: query.processing, options: [{ value: "", label: "Bất kỳ" }, ...procOpts], onChange: (v: string) => setParam({ processing: v }) },
            ]}
            onClear={nSet || query.processing ? clearFacets : undefined}
          />
        </div>
        {qualityTotal ? (
          <Dropdown>
            <Button variant="ghost" size="sm" className="cur-qbtn">
              <ShieldCheck className="i" aria-hidden />
              <span>{msg.studio.quality.label}</span>
              <span className="badge">{fmtNum(qualityTotal)}</span>
              <ChevronDown className="i" aria-hidden />
            </Button>
            <Dropdown.Popover placement="bottom start">
              <Dropdown.Menu aria-label={msg.studio.quality.label} onAction={(key) => setParam({ quality: String(key), sel: "" })}>
                <Dropdown.Section>
                  {QUALITY_PARTS.map((id) => (
                    <Dropdown.Item key={id} id={id} textValue={msg.studio.quality[id]}>
                      <Label>{msg.studio.quality[id]}</Label>
                      <span className="muted num">{fmtNum(counts?.[id] ?? 0)}</span>
                    </Dropdown.Item>
                  ))}
                </Dropdown.Section>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        ) : null}
        <div className="toolbar__end cur-sortmenu">
          <Dropdown>
            <Button variant="ghost" size="sm" aria-label={`Sắp xếp: ${sortLabel}`}>
              <ArrowUpDown className="i" aria-hidden />
              <span>{sortLabel}</span>
            </Button>
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu
                aria-label="Sắp xếp theo"
                selectionMode="single"
                selectedKeys={new Set([sort.column === "name" ? "name" : "updated"])}
                onAction={(key) => setSort(key === "name" ? { column: "name", direction: "ascending" } : { column: "updated", direction: "descending" })}
              >
                <Dropdown.Section>
                  <Dropdown.Item id="updated" textValue="Mới cập nhật">
                    <Label>Mới cập nhật</Label>
                    <Dropdown.ItemIndicator />
                  </Dropdown.Item>
                  <Dropdown.Item id="name" textValue="Tên">
                    <Label>Tên</Label>
                    <Dropdown.ItemIndicator />
                  </Dropdown.Item>
                </Dropdown.Section>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </div>
      </div>
      {nSet ? (
        <div className="cur-fchips cur-filters--narrow">
          {facets
            .filter(([key]) => query[key])
            .map(([key, label, opts]) => (
              <button key={key} type="button" className="chip chip--soft chip--accent cur-fchip" aria-label={`Gỡ bộ lọc: ${label}`} onClick={() => setParam({ [key]: "" })}>
                {opts.find(([v]) => v === facetValue(key))?.[1] ?? query[key]}
                <X className="i i-xs" aria-hidden />
              </button>
            ))}
        </div>
      ) : null}
      {!rows.length ? (
        <NoMatches what="tài liệu" onClear={() => setParam(NO_QUERY)} />
      ) : (
        <div className="cur-all">
          <DataTable
            label="Tất cả tài liệu"
            rows={rows}
            columns={columns}
            getRowId={(r) => r.id}
            sort={sort}
            onSortChange={setSort}
            selectedIds={new Set(selected.keys())}
            onSelectionChange={(ids) => {
              // The page's checkboxes change only this page; rows checked on other pages stay.
              const next = new Map([...selected].filter(([id]) => !rows.some((r) => r.id === id)));
              for (const r of rows) if (ids.has(r.id)) next.set(r.id, r);
              setSelected(next);
              setAllMatching(false);
            }}
            rowLabel={(r) => r.title}
            onRowAction={(r) => setParam({ sel: r.id })}
            rowActionLead={(r) => {
              const { main } = opsFor(r);
              if (!isRowFix(main)) return null;
              const meta = OP_META[main];
              const Icon = meta.icon;
              return (
                <Button variant="secondary" size="sm" onPress={() => ops.run(main, r)}>
                  <Icon className="i" aria-hidden />
                  {meta.label}
                </Button>
              );
            }}
            rowActions={(r) => ops.menu(r, "row")}
            footer={
              <Pager
                page={page}
                pageSize={PER}
                total={total ?? undefined}
                pageCount={rows.length}
                hasNext={!!list.data?.nextPageToken}
                onPageChange={(p) => {
                  if (p > page && list.data?.nextPageToken) setTokens((t) => [...t.slice(0, page), list.data!.nextPageToken!]);
                  setPage(p);
                }}
              />
            }
          />
          <BulkBar count={selected.size} label={allMatching ? "Đã chọn tất cả tài liệu khớp" : ""} onClear={clearSelection}>
            {allPage && more && !allMatching ? (
              <TextAction size="sm" onPress={() => setAllMatching(true)}>
                Chọn tất cả tài liệu khớp
              </TextAction>
            ) : null}
            <Button variant="secondary" size="sm" onPress={process}>
              <Play className="i" aria-hidden />
              Xử lý
            </Button>
            <Button variant="ghost" size="sm" onPress={() => void actOn(ops.bulkPublish)}>
              <Eye className="i" aria-hidden />
              Công bố
            </Button>
            <Button variant="ghost" size="sm" onPress={() => void actOn((list, done) => ops.unpublish(list.filter(canUnpublishRow), done))}>
              <EyeOff className="i" aria-hidden />
              Ngừng công bố
            </Button>
            <Button variant="ghost" size="sm" onPress={() => void actOn(ops.archive)}>
              <Archive className="i" aria-hidden />
              Lưu trữ
            </Button>
          </BulkBar>
        </div>
      )}
      <ProcessDialog request={processing} onClose={() => setProcessing(null)} onStarted={started} />
      <DocumentDrawer row={open} onClose={() => setParam({ sel: "" })} contributorName={open && !open.source ? memberName(open) || "—" : ""} />
    </>
  );
}

/** Source display names (readable to source managers; else "Source sync"). */
function useSourceNames(sources: readonly string[]): ReadonlyMap<string, string> {
  const { id: ws } = useWorkspace();
  const named = useQueries({
    queries: sources.map((s) => ({ queryKey: knowledgeKeys.source(ws, resourceId(s)), queryFn: () => getSource(ws, s), staleTime: 10 * 60_000, retry: false })),
  });
  const key = named.map((n) => n.data?.displayName ?? "").join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures the loaded names
  return useMemo(() => new Map(sources.map((s, i) => [s, named[i]?.data?.displayName ?? ""])), [key, sources]);
}
