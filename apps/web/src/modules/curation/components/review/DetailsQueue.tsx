"use client";

import { Button } from "@heroui/react";
import { CircleCheck, Pencil } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ClearFilters, DataTable, EmptyState, ErrorState, FilterButton, IconButton, NoMatches, Pager, SearchInput, SkeletonRows, StatusChip, type DataTableSort } from "@/components/ui";
import { SEARCH_PAUSE_MS, useDebounced } from "@/lib/debounce";
import { fmtDateTime, fmtNum, rel } from "@/lib/format";
import { openEditDetails } from "@/modules/knowledge/components/dialogs";
import { useKnowledgeModel } from "@/modules/knowledge/queries";

import { detailsFilter, nameSearch } from "../../docFilter";
import { detailEntries, GAP_KEYS, GAPS, QUEUE_HINT, requiredSchemeNames, type GapKey } from "../../governance";
import { useCounts, useDocScope, useItemPages } from "../../queries";
import { ConceptMenu, DocCell, orderByOf, useApplyConcept, useLiveSelection } from "../shared";
import { useDocDrawer } from "./useDocDrawer";

const PAGE = 20;

/**
 * Review → Missing details (preview `tabDetails`): documents without a classification, an owner or a summary; add the
 * detail (Thêm khái niệm files them under a concept of a scheme they miss; Sửa chi tiết covers the rest).
 * One server page at a time: search, Missing and Collection are the filter, Document and Updated the server's order.
 */
export function DetailsQueue() {
  const docScope = useDocScope();
  const { toResource, taxonomy } = useKnowledgeModel();
  const applyConcept = useApplyConcept();
  const drawer = useDocDrawer();
  const [q, setQ] = useState("");
  const [gap, setGap] = useState<GapKey | "">("");
  const [kb, setKb] = useState("");
  const [sort, setSort] = useState<DataTableSort | null>(null);
  const scope = docScope.scope;
  const sought = useDebounced(q, SEARCH_PAUSE_MS);
  const required = requiredSchemeNames(taxonomy);
  const filter = [detailsFilter(kb ? [kb] : scope, gap || undefined, required), nameSearch(sought)].filter(Boolean).join(" AND ");
  const list = useItemPages(filter, orderByOf(sort), { pageSize: PAGE, enabled: scope.length > 0 });
  // How many lack each detail (the Missing options), over every collection in scope.
  const gapCounts = useCounts(GAP_KEYS.map((g) => (scope.length ? { of: "items", filter: detailsFilter(scope, g, required) } : null))).data;
  const rows = detailEntries(
    list.items.map((it) => toResource(it)),
    taxonomy,
  );
  const [selected, setSelected] = useLiveSelection(rows.map((x) => x.r.id));

  if (docScope.isPending || (scope.length > 0 && list.isPending)) return <SkeletonRows rows={6} />;
  if (docScope.isError || list.isError) {
    return (
      <ErrorState
        error={docScope.error ?? list.error}
        onRetry={() => {
          void docScope.refetch();
          void list.refetch();
        }}
      />
    );
  }

  const wrap = (body: ReactNode) => (
    <div className="kh gov">
      <p className="gov-summary">{QUEUE_HINT.details}</p>
      {body}
      {drawer.node}
    </div>
  );
  if (!q && !gap && !kb && !rows.length && list.page === 1) {
    return wrap(<EmptyState icon={CircleCheck} tone="success" title="Mọi tài liệu đều có mô tả" description="Mọi tài liệu bạn phụ trách đều có phân loại, người phụ trách và tóm tắt." boxed />);
  }

  const gapOpts = GAP_KEYS.flatMap((g, i) => {
    const n = gapCounts[i] ?? 0;
    return n || g === gap ? [{ value: g, label: `${GAPS[g].label} · ${fmtNum(n)}` }] : [];
  });
  const kbOpts = docScope.bases.map((b) => ({ value: b.name ?? "", label: b.displayName || "Kho tài liệu" })).sort((a, b) => a.label.localeCompare(b.label));
  const clear = () => {
    setQ("");
    setGap("");
    setKb("");
  };

  const toolbar =
    (list.total ?? 0) > 6 || q || gap || kb ? (
      <div className="toolbar">
        <SearchInput value={q} onChange={setQ} placeholder="Tìm kiếm tài liệu" />
        {gapOpts.length > 1 || gap ? <FilterButton label="Thiếu" options={gapOpts} value={gap} onChange={(v) => setGap(v as GapKey | "")} /> : null}
        {kbOpts.length > 1 || kb ? <FilterButton label="Kho tài liệu" options={kbOpts} value={kb} onChange={setKb} /> : null}
        <ClearFilters isActive={!!(gap || kb)} onClear={clear} />
      </div>
    ) : null;

  if (!rows.length) {
    return wrap(
      <>
        {toolbar}
        {q || kb ? <NoMatches what="tài liệu" onClear={clear} /> : <EmptyState icon={CircleCheck} tone="success" title={`Mọi tài liệu đều có ${gap ? GAPS[gap].noun : "chi tiết"}`} boxed compact />}
      </>,
    );
  }

  return wrap(
    <>
      {toolbar}
      <DataTable
        label="Thiếu chi tiết"
        rows={rows}
        getRowId={(x) => x.r.id}
        sort={sort}
        onSortChange={setSort}
        selectedIds={selected}
        onSelectionChange={setSelected}
        rowLabel={(x) => x.r.title}
        onRowAction={(x) => drawer.open(x.r.item)}
        columns={[
          { id: "name", header: "Tài liệu", primary: true, sortValue: (x) => x.r.title, cell: (x) => <DocCell r={x.r} /> },
          {
            id: "gaps",
            header: "Thiếu",
            className: "kh-gaps",
            cell: (x) => (
              <div className="kh-chips">
                {x.gaps.map((g) => (
                  <StatusChip key={g} label={GAPS[g].label} icon={GAPS[g].icon} size="sm" tone={g === gap ? "warning" : "default"} dot={false} />
                ))}
              </div>
            ),
          },
          {
            id: "updated",
            header: "Đã cập nhật",
            hideOnMobile: true,
            className: "muted res-nowrap",
            sortValue: (x) => Date.parse(x.r.updated ?? "") || 0,
            cell: (x) => <span title={fmtDateTime(x.r.updated)}>{rel(x.r.updated)}</span>,
          },
        ]}
        rowActionLead={(x) =>
          x.gaps.includes("concept") ? (
            <>
              <ConceptMenu label="Thêm khái niệm" docs={[x.r]} variant="secondary" chevron onPick={(c) => void applyConcept([x.r], c)} />
              <IconButton icon={Pencil} tip="Sửa chi tiết" size="sm" onPress={() => openEditDetails(x.r.name)} />
            </>
          ) : (
            <Button size="sm" variant="secondary" onPress={() => openEditDetails(x.r.name)}>
              <Pencil className="i" aria-hidden />
              Sửa chi tiết
            </Button>
          )
        }
        bulkActions={(ids, done) => {
          const docs = rows.filter((x) => ids.includes(x.r.id)).map((x) => x.r);
          return rows.some((x) => x.gaps.includes("concept")) ? (
            <ConceptMenu label="Thêm khái niệm" docs={docs} variant="ghost" chevron onPick={(c) => void applyConcept(docs, c, done)} />
          ) : null;
        }}
        footer={<Pager page={list.page} pageSize={PAGE} total={list.total} pageCount={rows.length} hasNext={list.hasNext} onPageChange={list.setPage} />}
      />
    </>,
  );
}
