"use client";

import { Button, Dropdown, Label } from "@heroui/react";
import { useQueries } from "@tanstack/react-query";
import { Archive, ArrowUpDown, ChevronRight, EyeOff, Files, Upload, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useMemo, useState } from "react";

import { AppIcon, ClearFilters, DataTable, EmptyState, ErrorState, FileIcon, FilterButton, NoMatches, PageHeader, Pager, paginate, SearchInput, SkeletonRows, Tip, type DataTableColumn, type DataTableSort } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { fmtDateTime, fmtNum, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { getSource } from "@/modules/knowledge/api";
import { openContribute } from "@/modules/knowledge/components/contribute-store";
import { LifecycleChip } from "@/modules/knowledge/components/LifecycleChip";
import { SourceIcon } from "@/modules/knowledge/components/SourceIcon";
import { fold, kindMeta } from "@/modules/knowledge/model";
import { knowledgeKeys, useKnowledgeModel, useMemberNames } from "@/modules/knowledge/queries";

import { canUnpublishRow, FLOW_GROUPS, FLOW_TIPS, flowKeys, flowOf, isRowFix, MANY, opsFor, rowOf, type DocRow, type FlowKey } from "../model";
import { useAllContributions, useClosedSubmissions, useCuratedItems, useReviewQueue, type Submission } from "../queries";
import { DocumentDrawer } from "./DocumentDrawer";
import { DemoChip, SourceName } from "./parts";
import { MenuFilter } from "./review/MenuFilter";
import { OP_META, useDocOps } from "./useDocOps";

const PER = 25;
const FACETS = ["kb", "src", "kind", "topic"] as const;
type Facet = (typeof FACETS)[number];

/**
 * Knowledge Studio → Documents (preview `documentsTab`): the one administrative registry of every document in
 * the collections the caller reviews, whatever its origin. The flow strip is the stage filter; Collection,
 * Origin, Type and Topic filter once they'd split the list; a row opens the document drawer.
 * URL: `?life= &kb= &src= &topic= &q= &sel=` (deep links from Overview, collections and notices).
 */
export function DocumentsSection() {
  const { can } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const items = useCuratedItems();
  const contributions = useAllContributions();
  // Open submissions with their candidates (a contributor's My files item the curated list doesn't include).
  const queue = useReviewQueue({ enabled: can("contributions.review") });
  const { ctx } = useKnowledgeModel();
  const ops = useDocOps();

  const known = useMemo(() => new Map((items.data ?? []).map((it) => [it.name ?? "", it])), [items.data]);
  const closed = useClosedSubmissions(contributions.data, known);

  const baseNames = ctx.collectionNames ?? new Map<string, string>();
  const rows = useMemo<DocRow[]>(() => {
    if (!items.data || !contributions.data) return [];
    // The latest contribution about each document (candidates keep their item name).
    const latest = new Map<string, (typeof contributions.data)[number]>();
    for (const c of contributions.data) if (c.item && !latest.has(c.item)) latest.set(c.item, c);
    const out = items.data.map((it) => rowOf(it, latest.get(it.name ?? "") ?? null, baseNames));
    const listed = new Set(items.data.map((it) => it.name));
    const candidates = new Map((queue.data ?? []).map((s) => [s.contribution.name ?? "", s.item]));
    // Open or sent-back submissions whose candidate lives in a contributor's My files.
    const extra: Submission[] = [
      ...contributions.data
        .filter((c) => (c.state === "IN_REVIEW" || c.state === "ANALYZING") && !listed.has(c.item))
        .map((c) => ({ contribution: c, item: candidates.get(c.name ?? "") ?? null })),
      ...(closed.data ?? []).filter((s) => !listed.has(s.contribution.item)),
    ];
    const seen = new Set<string>();
    for (const s of extra) {
      const key = s.contribution.item ?? s.contribution.name ?? "";
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(rowOf(s.item, s.contribution, baseNames));
    }
    return out;
  }, [items.data, contributions.data, closed.data, queue.data, baseNames]);

  const memberNames = useMemberNames(rows.flatMap((r) => [r.contributor, r.owner]));
  const sources = useMemo(() => [...new Set(rows.flatMap((r) => (r.source ? [r.source] : [])))], [rows]);
  const sourceNames = useSourceNames(sources);

  /* ── URL state ── */
  const life = flowOf(params.get("life"));
  const facet: Record<Facet, string> = { kb: params.get("kb") ?? "", src: params.get("src") ?? "", topic: params.get("topic") ?? "", kind: params.get("kind") ?? "" };
  const q = params.get("q") ?? "";
  const selId = params.get("sel") ?? "";
  const [sort, setSort] = useState<DataTableSort>({ column: "updated", direction: "descending" });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const setParam = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    next.set("tab", "documents");
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    setPage(1);
    if (!("sel" in patch)) setSelected(new Set());
  };

  const typeLabel = (k: string) => kindMeta(k, ctx.documentTypes).label;
  const contributorName = (r: DocRow) => (r.source ? "" : memberNames.get(r.contributor ?? "") || "—");
  const originName = (r: DocRow) => (r.source ? sourceNames.get(r.source) || "Source sync" : contributorName(r));
  const fq = fold(q.trim());
  /** Every filter but the stage: the flow strip counts within it (like a facet), the table narrows it further. */
  const facetMatch = (r: DocRow) =>
    (!facet.kb || resourceId(r.base) === resourceId(facet.kb)) &&
    (!facet.src || (r.source ? resourceId(r.source) === resourceId(facet.src) : r.origin === facet.src)) &&
    (!facet.kind || r.kind === facet.kind) &&
    (!facet.topic || r.topics.some((t) => resourceId(t) === resourceId(facet.topic))) &&
    (!fq || fold([r.title, contributorName(r), r.baseName].join(" ")).includes(fq));
  const pool = rows.filter(facetMatch);
  const filtered = life ? pool.filter((r) => flowKeys(life).includes(r.lifecycle)) : pool;
  const sorted = [...filtered].sort((a, b) => {
    const sign = sort.direction === "ascending" ? 1 : -1;
    return sort.column === "name" ? sign * a.title.localeCompare(b.title) : sign * (Date.parse(a.updated || "0") - Date.parse(b.updated || "0"));
  });
  const shown = paginate(sorted, page, PER);
  const open = rows.find((r) => r.id === selId) ?? null;

  const upload = can("contributions.create") ? (
    <Button variant="primary" onPress={() => openContribute(facet.kb ? { collection: facet.kb } : {})}>
      <Upload className="i" aria-hidden />
      Add documents
    </Button>
  ) : null;
  const header = <PageHeader title="Documents" chips={<DemoChip />} actions={upload} />;

  if (items.isPending || contributions.isPending) {
    return (
      <>
        {header}
        <SkeletonRows rows={8} />
      </>
    );
  }
  if (items.isError || contributions.isError) {
    return (
      <>
        {header}
        <ErrorState
          error={items.error ?? contributions.error}
          onRetry={() => {
            void items.refetch();
            void contributions.refetch();
          }}
        />
      </>
    );
  }
  if (!rows.length) {
    return (
      <>
        {header}
        <EmptyState icon={Files} boxed title="No documents yet" description="Documents added to the collections you look after show up here, whatever their origin." actions={upload} />
      </>
    );
  }

  /* ── Facets: only when they'd split the list (or one is in use) ── */
  const kbOpts = [...new Map(rows.filter((r) => r.base).map((r) => [resourceId(r.base), r.baseName || "Collection"])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const originOpts: [string, string][] = [
    ...(rows.some((r) => r.origin === "contrib") ? [["contrib", "Contributions"] as [string, string]] : []),
    ...(rows.some((r) => r.origin === "upload") ? [["upload", "Uploads"] as [string, string]] : []),
    ...sources.map((s) => [resourceId(s), sourceNames.get(s) || "Source sync"] as [string, string]).sort((a, b) => a[1].localeCompare(b[1])),
  ];
  const kindOpts = [...new Set(rows.map((r) => r.kind))].map((k) => [k, typeLabel(k)] as [string, string]).sort((a, b) => a[1].localeCompare(b[1]));
  const topicOpts = [...new Set(rows.flatMap((r) => r.topics))]
    .flatMap((t) => (ctx.topicNames?.get(t) ? [[resourceId(t), ctx.topicNames.get(t)!] as [string, string]] : []))
    .sort((a, b) => a[1].localeCompare(b[1]));
  const facets = (
    [
      ["kb", "Collection", kbOpts],
      ["src", "Origin", originOpts],
      ["kind", "Type", kindOpts],
      ["topic", "Topic", topicOpts],
    ] as const
  ).filter(([key, , opts]) => opts.length > 1 || facet[key]);
  const nSet = FACETS.filter((k) => facet[k]).length;
  const clearFacets = () => setParam({ kb: "", src: "", kind: "", topic: "" });
  const sortLabel = sort.column === "name" ? "Name" : "Recently updated";

  const columns: DataTableColumn<DocRow>[] = [
    {
      id: "name",
      header: "Name",
      primary: true,
      sortValue: (r) => r.title.toLowerCase(),
      cell: (r) => (
        <div className="row gap-12">
          <FileIcon name={r.fileName} mime={r.mime} />
          <div className="grow min-w-0">
            <div className="cell-title truncate" title={r.title} translate="no">
              {r.title}
            </div>
            <div className="cell-sub truncate" translate="no">
              {[r.baseName, ...r.topics.slice(0, 2).map((t) => ctx.topicNames?.get(t) ?? "")].filter(Boolean).join(" · ")}
            </div>
          </div>
        </div>
      ),
    },
    {
      id: "origin",
      header: "Origin",
      hideOnMobile: true,
      cell: (r) => (
        <span className="row gap-6 cur-origin">
          {r.source ? <SourceIcon source={r.source} size="sm" /> : <AppIcon app="upload" size="sm" />}
          <span className="truncate" title={originName(r)}>
            {r.source ? <SourceName source={r.source} /> : contributorName(r)}
          </span>
        </span>
      ),
    },
    {
      id: "owner",
      header: "Owner",
      hideOnMobile: true,
      className: "cur-owner",
      cell: (r) => (
        <span className="truncate" translate="no">
          {memberNames.get(r.owner ?? "") || "—"}
        </span>
      ),
    },
    { id: "life", header: "Lifecycle", cell: (r) => <LifecycleChip lifecycle={r.lifecycle} size="sm" /> },
    {
      id: "updated",
      header: "Updated",
      sortValue: (r) => r.updated,
      cell: (r) => (
        <Tip content={fmtDateTime(r.updated)}>
          <span className="muted cur-nowrap">{rel(r.updated)}</span>
        </Tip>
      ),
    },
  ];

  const selectedRows = () => rows.filter((r) => selected.has(r.id) && r.item);

  return (
    <>
      {header}
      <FlowStrip pool={pool} life={life} onPick={(k) => setParam({ life: life === k ? "" : k })} />
      {rows.length > MANY || q || nSet ? (
        <>
          <div className="toolbar cur-toolbar">
            <SearchInput value={q} onChange={(v) => setParam({ q: v })} placeholder="Search documents" />
            <div className="cur-filters--wide">
              {facets.map(([key, label, opts]) => (
                <FilterButton key={key} label={label} options={opts.map(([value, l]) => ({ value, label: l }))} value={resourceId(facet[key]) || facet[key]} onChange={(v) => setParam({ [key]: v })} />
              ))}
              <ClearFilters isActive={!!nSet} onClear={clearFacets} />
            </div>
            {facets.length ? (
              <div className="cur-filters--narrow">
                <MenuFilter
                  label={nSet ? `Filters · ${nSet}` : ""}
                  sections={facets.map(([key, label, opts]) => ({
                    title: label,
                    value: resourceId(facet[key]) || facet[key],
                    options: [{ value: "", label: "Any" }, ...opts.map(([value, l]) => ({ value, label: l }))],
                    onChange: (v: string) => setParam({ [key]: v }),
                  }))}
                  onClear={nSet ? clearFacets : undefined}
                />
              </div>
            ) : null}
            <div className="toolbar__end cur-sortmenu">
              <Dropdown>
                <Button variant="ghost" size="sm" aria-label={`Sort: ${sortLabel}`}>
                  <ArrowUpDown className="i" aria-hidden />
                  <span>{sortLabel}</span>
                </Button>
                <Dropdown.Popover placement="bottom end">
                  <Dropdown.Menu
                    aria-label="Sort by"
                    selectionMode="single"
                    selectedKeys={new Set([sort.column === "name" ? "name" : "updated"])}
                    onAction={(key) => {
                      setSort(key === "name" ? { column: "name", direction: "ascending" } : { column: "updated", direction: "descending" });
                      setPage(1);
                    }}
                  >
                    <Dropdown.Section>
                      <Dropdown.Item id="updated" textValue="Recently updated">
                        <Label>Recently updated</Label>
                        <Dropdown.ItemIndicator />
                      </Dropdown.Item>
                      <Dropdown.Item id="name" textValue="Name">
                        <Label>Name</Label>
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
                .filter(([key]) => facet[key])
                .map(([key, label, opts]) => (
                  <button key={key} type="button" className="chip chip--soft chip--accent cur-fchip" aria-label={`Remove filter: ${label}`} onClick={() => setParam({ [key]: "" })}>
                    {opts.find(([v]) => v === (resourceId(facet[key]) || facet[key]))?.[1] ?? facet[key]}
                    <X className="i i-xs" aria-hidden />
                  </button>
                ))}
            </div>
          ) : null}
        </>
      ) : null}
      {!filtered.length ? (
        <NoMatches what="documents" onClear={() => setParam({ life: "", kb: "", src: "", kind: "", topic: "", q: "" })} />
      ) : (
        <div className="cur-all">
          <DataTable
            label="Documents"
            rows={shown}
            columns={columns}
            getRowId={(r) => r.id}
            sort={sort}
            onSortChange={(s) => {
              setSort(s);
              setPage(1);
            }}
            selectedIds={selected}
            onSelectionChange={setSelected}
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
            bulkActions={(_, clearSel) => (
              <>
                <Button variant="ghost" size="sm" onPress={() => void ops.bulkPublish(selectedRows(), clearSel)}>
                  <Upload className="i" aria-hidden />
                  Publish
                </Button>
                <Button variant="ghost" size="sm" onPress={() => void ops.unpublish(selectedRows().filter(canUnpublishRow), clearSel)}>
                  <EyeOff className="i" aria-hidden />
                  Unpublish
                </Button>
                <Button variant="ghost" size="sm" onPress={() => void ops.archive(selectedRows(), clearSel)}>
                  <Archive className="i" aria-hidden />
                  Archive
                </Button>
              </>
            )}
            footer={<Pager page={page} pageSize={PER} total={sorted.length} onPageChange={setPage} />}
          />
        </div>
      )}
      <DocumentDrawer row={open} onClose={() => setParam({ sel: "" })} contributorName={open ? contributorName(open) : ""} />
    </>
  );
}

/**
 * The flow strip (preview `flowStrip`): where every document is, read left to right (In review › Publishing ›
 * Published), with the two off-ramps apart (Needs attention, Not published). Each step is a label and a count;
 * its tooltip explains it. Pressing a step filters to it, pressing again clears it.
 */
function FlowStrip({ pool, life, onPick }: { pool: readonly DocRow[]; life: FlowKey | ""; onPick: (k: FlowKey | "") => void }) {
  const count = (k: FlowKey) => pool.filter((r) => flowKeys(k).includes(r.lifecycle)).length;
  const step = (k: FlowKey | "", label: string, n: number, tone = "") => (
    <button
      key={k || "all"}
      type="button"
      className={`flow__step${tone && n ? ` flow__step--${tone}` : ""}`}
      aria-pressed={life === k}
      title={k ? FLOW_TIPS[k] : undefined}
      onClick={() => onPick(k)}
    >
      <span className="flow__label">{label}</span>
      <span className="flow__count num">{fmtNum(n)}</span>
    </button>
  );
  const [rv, pub, done, att, closed] = FLOW_GROUPS;
  return (
    <div className="flow" role="group" aria-label="Where documents are">
      {step("", "All", pool.length)}
      <span className="flow__div" aria-hidden="true" />
      <div className="flow__main">
        {[rv, pub, done].map(([k, label], i) => (
          <Fragment key={k}>
            {i ? (
              <span className="flow__sep" aria-hidden="true">
                <ChevronRight className="i i-sm" />
              </span>
            ) : null}
            {step(k, label, count(k), k === "review" ? "accent" : "")}
          </Fragment>
        ))}
      </div>
      <div className="flow__off">
        {step(att[0], att[1], count(att[0]), "danger")}
        {step(closed[0], closed[1], count(closed[0]))}
      </div>
    </div>
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
