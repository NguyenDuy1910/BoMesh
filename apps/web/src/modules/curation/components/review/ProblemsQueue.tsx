"use client";

import { Button } from "@heroui/react";
import { Upload } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { AppIcon, ClearFilters, DataTable, ErrorState, FileIcon, FilterButton, NoMatches, Pager, paginate, SearchInput, SkeletonRows, Tip, type DataTableSort } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { fmtDateTime, rel } from "@/lib/format";
import { LifecycleChip } from "@/modules/knowledge/components/LifecycleChip";
import { SourceIcon } from "@/modules/knowledge/components/SourceIcon";
import { LIFECYCLE } from "@/modules/knowledge/model";
import { useKnowledgeModel, useMemberNames } from "@/modules/knowledge/queries";

import { matches, QUEUE_HINT } from "../../governance";
import { isRowFix, MANY, opsFor, PROBLEM_OPTS, rowOf, type DocRow } from "../../model";
import { problemItems, useCuratedItems, useReviewQueue } from "../../queries";
import { DocumentDrawer } from "../DocumentDrawer";
import { SourceName } from "../parts";
import { sortRows, useLiveSelection } from "../shared";
import { OP_META, useDocOps } from "../useDocOps";

const PER = 25;

/**
 * Review → Publishing problems (preview `problemsQueue`): approved documents that didn't reach people — couldn't
 * publish, changed at the source, waiting to publish. Each row shows its fix; selected rows get one bulk Publish.
 */
export function ProblemsQueue({ kb: initialKb, done }: { kb: string; done: ReactNode }) {
  const items = useCuratedItems();
  const queue = useReviewQueue();
  const { ctx } = useKnowledgeModel();
  const ops = useDocOps();
  const [q, setQ] = useState("");
  const [kb, setKb] = useState(resourceId(initialKb));
  const [life, setLife] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<DataTableSort | null>({ column: "updated", direction: "descending" });
  const [open, setOpen] = useState("");
  useEffect(() => setKb(resourceId(initialKb)), [initialKb]);

  const baseNames = ctx.collectionNames ?? new Map<string, string>();
  const docs = useMemo<DocRow[]>(() => {
    if (!items.data || !queue.data) return [];
    const inReview = new Set(queue.data.flatMap((s) => (s.contribution.item ? [s.contribution.item] : [])));
    return problemItems(items.data, inReview).map((it) => rowOf(it, null, baseNames));
  }, [items.data, queue.data, baseNames]);
  const [selected, setSelected] = useLiveSelection(docs.map((r) => r.id));
  const memberNames = useMemberNames(docs.map((r) => r.contributor));

  if (items.isPending || queue.isPending) return <SkeletonRows rows={6} />;
  if (items.isError) return <ErrorState error={items.error} onRetry={() => void items.refetch()} />;
  if (!docs.length) return <>{done}</>;

  const reset = (set: (v: string) => void) => (v: string) => {
    set(v);
    setPage(1);
  };
  const kbOpts = [...new Map(docs.filter((r) => r.base).map((r) => [resourceId(r.base), r.baseName || "Collection"])).entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }));
  const lifeOpts = PROBLEM_OPTS.filter(([k]) => docs.some((r) => r.lifecycle === k)).map(([value, label]) => ({ value, label }));
  const filtering = !!(kb || life);
  const tools = docs.length > MANY || q || filtering;
  const originName = (r: DocRow) => (r.source ? "" : memberNames.get(r.contributor ?? "") || "—");
  const rows = sortRows(
    docs.filter((r) => (!kb || resourceId(r.base) === kb) && (!life || r.lifecycle === life) && matches(q, r.title, r.baseName, originName(r))),
    sort,
    { name: (r) => r.title.toLowerCase(), updated: (r) => Date.parse(r.updated) || 0 },
  );
  const clear = () => {
    setQ("");
    setKb("");
    setLife("");
    setPage(1);
  };
  const current = docs.find((r) => r.id === open) ?? null;

  return (
    <div className="kh gov">
      <p className="gov-summary">{QUEUE_HINT.problems}</p>
      {tools ? (
        <div className="toolbar">
          <SearchInput value={q} onChange={reset(setQ)} placeholder="Search documents" />
          {lifeOpts.length > 1 || life ? <FilterButton label="Problem" options={lifeOpts} value={life} onChange={reset(setLife)} /> : null}
          {kbOpts.length > 1 || kb ? <FilterButton label="Collection" options={kbOpts} value={kb} onChange={reset(setKb)} /> : null}
          <ClearFilters isActive={filtering} onClear={clear} />
        </div>
      ) : null}
      {rows.length ? (
        <div className="cur-prob">
          <DataTable
            label="Publishing problems"
            rows={paginate(rows, page, PER)}
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
            columns={[
              {
                id: "name",
                header: "Name",
                primary: true,
                sortValue: (r) => r.title,
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
              {
                id: "problem",
                header: "Problem",
                cell: (r) => {
                  const why = r.lifecycle === "failed" ? r.item?.document?.indexingError?.message || "Publishing stopped partway." : LIFECYCLE[r.lifecycle].desc;
                  return (
                    <div className="stack gap-2">
                      <LifecycleChip lifecycle={r.lifecycle} size="sm" />
                      <span className="cell-sub cur-prob__why" title={why}>
                        {why}
                      </span>
                    </div>
                  );
                },
              },
              {
                id: "origin",
                header: "Origin",
                hideOnMobile: true,
                cell: (r) => (
                  <span className="row gap-6 cur-origin">
                    {r.source ? <SourceIcon source={r.source} size="sm" /> : <AppIcon app="upload" size="sm" />}
                    <span className="truncate">{r.source ? <SourceName source={r.source} /> : originName(r)}</span>
                  </span>
                ),
              },
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
            ]}
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
            bulkActions={(ids, clearSel) => (
              <Button variant="ghost" size="sm" onPress={() => void ops.bulkPublish(docs.filter((r) => ids.includes(r.id)), clearSel)}>
                <Upload className="i" aria-hidden />
                Publish
              </Button>
            )}
            footer={<Pager page={page} pageSize={PER} total={rows.length} onPageChange={setPage} />}
          />
        </div>
      ) : (
        <NoMatches what="documents" onClear={clear} />
      )}
      <DocumentDrawer row={current} onClose={() => setOpen("")} contributorName={current ? originName(current) : ""} />
    </div>
  );
}
