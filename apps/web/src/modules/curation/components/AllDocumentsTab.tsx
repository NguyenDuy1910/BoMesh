"use client";

import { Button, Dropdown, Label } from "@heroui/react";
import { Archive, ArrowUpDown, EyeOff, Files, RotateCcw, Upload } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { Callout, ClearFilters, DataTable, EmptyState, ErrorState, FileIcon, FilterButton, NoMatches, Pager, paginate, SearchInput, SkeletonRows, Tip, type DataTableColumn, type DataTableSort } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { fmtDateTime, plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { openContribute } from "@/modules/knowledge/components/Contribute";
import { LifecycleChip } from "@/modules/knowledge/components/LifecycleChip";
import { SourceIcon } from "@/modules/knowledge/components/SourceIcon";
import { fold, kindMeta } from "@/modules/knowledge/model";
import { getSource } from "@/modules/knowledge/api";
import { knowledgeKeys, useKnowledgeModel, useMemberNames } from "@/modules/knowledge/queries";
import { AppIcon } from "@/components/ui";
import { useQueries } from "@tanstack/react-query";

import { canUnpublishRow, isLocked, LIFE_FILTERS, lifeGroupKeys, rowOf, type DocRow } from "../model";
import { useAllContributions, useClosedSubmissions, useCuratedItems, type Submission } from "../queries";
import { DocumentDrawer } from "./DocumentDrawer";
import { SourceName } from "./parts";
import { useDocOps } from "./useDocOps";

const PER = 25;

/** All documents (preview `allTab`): every curated document's lifecycle, filters, bulk actions and the document drawer. */
export function AllDocumentsTab() {
  const { can } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const items = useCuratedItems();
  const contributions = useAllContributions();
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
    // Open or sent-back submissions whose candidate lives in a contributor's My files.
    const extra: Submission[] = [
      ...(contributions.data.filter((c) => (c.state === "IN_REVIEW" || c.state === "ANALYZING") && !listed.has(c.item)).map((c) => ({ contribution: c, item: null }))),
      ...((closed.data ?? []).filter((s) => !listed.has(s.contribution.item))),
    ];
    const seen = new Set<string>();
    for (const s of extra) {
      const key = s.contribution.item ?? s.contribution.name ?? "";
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(rowOf(s.item, s.contribution, baseNames));
    }
    return out;
  }, [items.data, contributions.data, closed.data, baseNames]);

  // Open submissions' candidates: titles come from the review queue's candidate reads.
  const memberNames = useMemberNames(rows.map((r) => r.contributor));

  /* ── URL state: ?life= &kb= &src= &q= (deep links from Overview and knowledge bases) ── */
  const life = params.get("life") ?? "";
  const kb = params.get("kb") ?? "";
  const src = params.get("src") ?? "";
  const q = params.get("q") ?? "";
  const selId = params.get("sel") ?? "";
  const [kind, setKind] = useState("");
  const [sort, setSort] = useState<DataTableSort>({ column: "updated", direction: "descending" });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const setParam = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    next.set("tab", "all");
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    router.replace(`${pathname}?${next}`, { scroll: false });
    setPage(1);
  };

  const fq = fold(q.trim());
  const typeLabel = (k: string) => kindMeta(k, ctx.documentTypes).label;
  const contributorName = (r: DocRow) => (r.source ? "" : memberNames.get(r.contributor ?? "") || "—");
  const filtered = rows.filter(
    (r) =>
      (!life || lifeGroupKeys(life).includes(r.lifecycle)) &&
      (!kb || resourceId(r.base) === resourceId(kb)) &&
      (!src || (src === "upload" ? !r.source : resourceId(r.source) === resourceId(src))) &&
      (!kind || r.kind === kind) &&
      (!fq || fold([r.title, contributorName(r), r.baseName].join(" ")).includes(fq)),
  );
  const sorted = [...filtered].sort((a, b) => {
    const sign = sort.direction === "ascending" ? 1 : -1;
    return sort.column === "name" ? sign * a.title.localeCompare(b.title) : sign * (Date.parse(a.updated || "0") - Date.parse(b.updated || "0"));
  });
  const shown = paginate(sorted, page, PER);
  const open = rows.find((r) => r.id === selId) ?? null;
  const setOpen = (id: string) => setParam({ sel: id });

  if (items.isPending || contributions.isPending) return <SkeletonRows rows={8} />;
  if (items.isError || contributions.isError) {
    return (
      <ErrorState
        error={items.error ?? contributions.error}
        onRetry={() => {
          void items.refetch();
          void contributions.refetch();
        }}
      />
    );
  }
  const upload = can("contributions.create") ? (
    <Button variant="primary" onPress={() => openContribute(kb ? { collection: kb } : {})}>
      <Upload className="i" aria-hidden />
      Upload
    </Button>
  ) : null;
  if (!rows.length) {
    return <EmptyState icon={Files} boxed title="No documents yet" description="Documents added to the knowledge bases you look after show up here." actions={upload} />;
  }

  const kbOpts = [...new Map(rows.filter((r) => r.base).map((r) => [resourceId(r.base), r.baseName || "Knowledge base"])).entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }));
  const srcOpts = [...new Set(rows.map((r) => r.source).filter(Boolean))] as string[];
  const kindOpts = [...new Set(rows.map((r) => r.kind))].map((k) => ({ value: k, label: typeLabel(k) })).sort((a, b) => a.label.localeCompare(b.label));
  const active = !!(life || kb || src || kind);
  const clear = () => {
    setKind("");
    setParam({ life: "", kb: "", src: "" });
  };

  const failed = rows.filter((r) => r.lifecycle === "failed");
  const locked = failed.filter((r) => isLocked(r.item));
  const retry = failed.length - locked.length;
  const failDesc = locked.length
    ? `${locked.length === failed.length ? (failed.length === 1 ? "The file is" : "The files are") : `${locked.length} ${locked.length === 1 ? "file is" : "files are"}`} password-protected and ${locked.length === 1 ? "needs" : "need"} a copy without a password.`
    : "Publishing stopped partway. Try again.";

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
              {r.baseName}
            </div>
          </div>
        </div>
      ),
    },
    { id: "life", header: "Lifecycle", cell: (r) => <LifecycleChip lifecycle={r.lifecycle} size="sm" /> },
    {
      id: "who",
      header: "Contributor / source",
      hideOnMobile: true,
      cell: (r) => (
        <span className="row gap-6">
          {r.source ? <SourceIcon source={r.source} size="sm" /> : <AppIcon app="upload" size="sm" />}
          <span className="truncate">{r.source ? <SourceName source={r.source} /> : contributorName(r)}</span>
        </span>
      ),
    },
    { id: "type", header: "Type", hideOnMobile: true, cell: (r) => <span className="muted">{typeLabel(r.kind)}</span> },
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
  const sortLabel = sort.column === "name" ? "Name" : "Recently updated";

  return (
    <>
      <div className="toolbar">
        <SearchInput value={q} onChange={(v) => setParam({ q: v })} placeholder="Search documents" />
        <FilterButton label="Lifecycle" options={LIFE_FILTERS.map((l) => ({ value: l.key, label: l.label, count: rows.filter((r) => l.keys.includes(r.lifecycle)).length }))} value={life} onChange={(v) => setParam({ life: v })} />
        {kbOpts.length > 1 ? <FilterButton label="Knowledge base" options={kbOpts} value={resourceId(kb)} onChange={(v) => setParam({ kb: v })} /> : null}
        {srcOpts.length ? <SourceFilter sources={srcOpts} value={src} onChange={(v) => setParam({ src: v })} /> : null}
        <FilterButton label="Type" options={kindOpts} value={kind} onChange={(v) => { setKind(v); setPage(1); }} />
        <ClearFilters isActive={active} onClear={clear} />
        <div className="toolbar__end">
          <Dropdown>
            <Button variant="ghost" size="sm" aria-label={`Sort: ${sortLabel}`}>
              <ArrowUpDown className="i" aria-hidden />
              {sortLabel}
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
      {failed.length ? (
        <div className="mb-12">
          <Callout
            tone="danger"
            title={`${plural(failed.length, "document")} couldn’t be published`}
            description={failDesc}
            actions={
              <>
                {life !== "attention" ? (
                  <Button variant="ghost" size="sm" onPress={() => setParam({ life: "attention" })}>
                    Show
                  </Button>
                ) : null}
                {retry ? (
                  <Button variant="secondary" size="sm" onPress={() => void ops.process(failed.filter((r) => !isLocked(r.item)), "again")}>
                    <RotateCcw className="i" aria-hidden />
                    Retry all
                  </Button>
                ) : locked.length === 1 ? (
                  <Button variant="secondary" size="sm" onPress={() => openContribute({ item: locked[0].item?.name })}>
                    <Upload className="i" aria-hidden />
                    Replace file
                  </Button>
                ) : null}
              </>
            }
          />
        </div>
      ) : null}
      {!filtered.length ? (
        <NoMatches what="documents" onClear={() => { clear(); setParam({ q: "" }); }} />
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
            onRowAction={(r) => setOpen(r.id)}
            rowActions={(r) => ops.menu(r, () => setOpen(r.id))}
            bulkActions={(_, clearSel) => (
              <>
                <Button variant="ghost" size="sm" onPress={() => void ops.bulkPublish(selectedRows().filter((r) => r.item), clearSel)}>
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

/** Source filter: names come from the sources themselves (readable to source managers; else "Source sync"). */
function SourceFilter({ sources, value, onChange }: { sources: string[]; value: string; onChange: (v: string) => void }) {
  const { id: ws } = useWorkspace();
  const named = useQueries({
    queries: sources.map((s) => ({ queryKey: knowledgeKeys.source(ws, resourceId(s)), queryFn: () => getSource(ws, s), staleTime: 10 * 60_000, retry: false })),
  });
  return (
    <FilterButton
      label="Source"
      options={[{ value: "upload", label: "Uploads" }, ...sources.map((s, i) => ({ value: resourceId(s), label: named[i]?.data?.displayName || "Source sync" }))]}
      value={value}
      onChange={onChange}
    />
  );
}
