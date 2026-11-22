"use client";

import { Button } from "@heroui/react";
import { Play, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { ClearFilters, DataTable, ErrorState, FileIcon, FilterButton, NoMatches, Pager, paginate, SearchInput, SectionTabs, SkeletonRows, Tip, toast, type DataTableSort } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { fmtDateTime, plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { useKnowledgeModel, useMemberNames } from "@/modules/knowledge/queries";

import { rejectContribution, requestContributionChanges, type IngestionRun } from "../../api";
import { useHeldDecisions } from "../../decisions";
import { matches } from "../../governance";
import { canProcess, isCandidate, PROCESSING, TO_PROCESS, type ProcessingKey } from "../../lifecycle";
import { isRowFix, opsFor, rowOf, type DocRow } from "../../model";
import { processingQueue, useActiveTasks, useCuratedItems, useInvalidateCuration, useReviewQueue } from "../../queries";
import { DecideDialog, type DecideRequest } from "../DecideDialog";
import { DocumentDrawer } from "../DocumentDrawer";
import { SourceName } from "../parts";
import { ProcessingState } from "../ProcessingSteps";
import { ProcessDialog, type ProcessRequest } from "../ProcessDialog";
import { sortRows, useLiveSelection } from "../shared";
import { OP_META, useDocOps } from "../useDocOps";

const PER = 25;

/**
 * Documents → Processing (preview `processingView`): what isn't processed yet — new documents' submissions first (the
 * assistant classifies them for their reviewer; once processed they move to Review), then documents nobody processed,
 * that failed or changed at their source. Select rows → Process (the Process dialog: topics and context for the run).
 * While a run is in flight each of its documents shows its run task: waiting, the step it's at (the track opens each
 * step), the step it failed at, or processed; no row fix while it waits or runs. A submission's ⋯ also answers it
 * (Request changes, Decline) when it can't wait. `?state=` and `?kb=` preset the filters.
 */
export function ProcessingQueue({ kb: initialKb, state: initialState, done }: { kb: string; state: string; done: ReactNode }) {
  const { id: ws } = useWorkspace();
  const items = useCuratedItems();
  const queue = useReviewQueue();
  const held = useHeldDecisions();
  const { ctx } = useKnowledgeModel();
  const invalidate = useInvalidateCuration();
  const tasks = useActiveTasks();
  const [q, setQ] = useState("");
  const [kb, setKb] = useState(resourceId(initialKb));
  const [state, setState] = useState(initialState);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<DataTableSort | null>({ column: "updated", direction: "descending" });
  const [open, setOpen] = useState("");
  const [processing, setProcessing] = useState<ProcessRequest | null>(null);
  const [decide, setDecide] = useState<(DecideRequest & { row: DocRow }) | null>(null);
  useEffect(() => setKb(resourceId(initialKb)), [initialKb]);
  useEffect(() => setState(initialState), [initialState]);

  const baseNames = ctx.collectionNames ?? new Map<string, string>();
  const docs = useMemo<DocRow[]>(() => {
    if (!items.data || !queue.data) return [];
    return processingQueue(items.data, queue.data, held).map((e) => rowOf(e.item, e.contribution, baseNames));
  }, [items.data, queue.data, held, baseNames]);
  const [selected, setSelected] = useLiveSelection(docs.map((r) => r.id));
  const memberNames = useMemberNames(docs.map((r) => r.contributor));
  const contributorName = useCallback((r: DocRow) => memberNames.get(r.contributor ?? "") || "—", [memberNames]);

  const onDecide = useCallback(
    (mode: "changes" | "decline", row: DocRow) =>
      setDecide({ mode, row, titles: [row.title], fileName: row.fileName, mime: row.mime, contributor: row.source ? undefined : contributorName(row) }),
    [contributorName],
  );
  const ops = useDocOps(onDecide);

  if (items.isPending || queue.isPending) return <SkeletonRows rows={6} />;
  if (items.isError || queue.isError) {
    return (
      <ErrorState
        error={items.error ?? queue.error}
        onRetry={() => {
          void items.refetch();
          void queue.refetch();
        }}
      />
    );
  }
  if (!docs.length) return <>{done}</>;

  const reset = (set: (v: string) => void) => (v: string) => {
    set(v);
    setPage(1);
  };
  const kbOpts = [...new Map(docs.filter((r) => r.base).map((r) => [resourceId(r.base), r.baseName || "Collection"])).entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }));
  const states = TO_PROCESS.filter((k) => k === state || docs.some((r) => r.processing === k));
  const pills = [{ id: "all", label: "All" }, ...states.map((k) => ({ id: k, label: PROCESSING[k].label }))];
  const filtered = sortRows(
    docs.filter(
      (r) => (!kb || resourceId(r.base) === kb) && (!state || r.processing === state) && matches(q, r.title, r.baseName, isCandidate(r.contribution) && !r.source ? contributorName(r) : ""),
    ),
    sort,
    { name: (r) => r.title.toLowerCase(), updated: (r) => Date.parse(r.updated) || 0 },
  );
  // Submissions first: their contributors wait on a review that needs them processed.
  const rows = [...filtered.filter((r) => isCandidate(r.contribution)), ...filtered.filter((r) => !isCandidate(r.contribution))];
  const clear = () => {
    setQ("");
    setKb("");
    setState("");
    setPage(1);
  };
  const current = docs.find((r) => r.id === open) ?? null;

  /** In the run in flight, waiting or running (its item still reads Not processed while it waits). */
  const inFlight = (r: DocRow) => {
    const t = tasks?.get(r.id)?.state;
    return t === "QUEUED" || t === "RUNNING";
  };
  const process = (picked: DocRow[]) => {
    const todo = picked.filter((r) => canProcess(r) && !inFlight(r));
    if (!todo.length) {
      toast(picked.some((r) => r.processing === "processing" || inFlight(r)) ? "These are being processed already" : "None of these can be processed", { tone: "danger" });
      return;
    }
    setProcessing({ rows: todo, collections: [...new Set(todo.map((r) => r.base).filter(Boolean))] });
  };
  /** The state's fix as a small row button (Process, Process again, Replace file…), or null. */
  const fixButton = (r: DocRow) => {
    const { main } = opsFor(r);
    if (!isRowFix(main)) return null;
    const meta = OP_META[main];
    const Icon = meta.icon;
    return (
      <Button variant="secondary" size="sm" onPress={() => (main === "process" || main === "retry" ? process([r]) : ops.run(main, r))}>
        <Icon className="i" aria-hidden />
        {meta.label}
      </Button>
    );
  };
  const started = (run: IngestionRun, n: number | null) => {
    setProcessing(null);
    setSelected(new Set());
    const count = run.counts?.totalCount ?? n ?? 0;
    const subs = processing?.rows.filter((r) => isCandidate(r.contribution)).length ?? 0;
    toast(`Processing ${plural(count, "document")}${subs ? ` · ${plural(subs, "submission")} go${subs === 1 ? "es" : ""} to Review once processed` : ""}`, { tone: "accent" });
  };
  const submitDecide = async (message: string) => {
    if (!decide) return;
    const { mode, row } = decide;
    setDecide(null);
    const c = row.contribution;
    if (!c?.name) return;
    try {
      if (mode === "changes") await requestContributionChanges(ws, c.name, message, c.etag);
      else await rejectContribution(ws, c.name, message, c.etag);
      toast(mode === "changes" ? (decide.contributor ? `Asked ${decide.contributor} for changes` : "Changes requested") : `Declined “${row.title}”`);
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      invalidate();
    }
  };

  return (
    <div className="kh gov">
      <p className="gov-summary">Select what to process: the assistant reads, classifies and indexes it. Submissions go to Review once they’re processed.</p>
      <div className="toolbar">
        <SearchInput value={q} onChange={reset(setQ)} placeholder="Search documents" />
        {kbOpts.length > 1 || kb ? <FilterButton label="Collection" options={kbOpts} value={kb} onChange={reset(setKb)} /> : null}
        <ClearFilters isActive={!!kb} onClear={() => reset(setKb)("")} />
      </div>
      {pills.length > 2 || state ? (
        <div className="cur-pills">
          <SectionTabs items={pills} active={state || "all"} variant="primary" label="Processing state" onChange={(id) => reset(setState)(id === "all" ? "" : (id as ProcessingKey))} />
        </div>
      ) : null}
      {rows.length ? (
        <div className="cur-proc">
          <DataTable
            label="Not processed yet"
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
                      <div className="cell-sub truncate">
                        {isCandidate(r.contribution) ? (
                          <>
                            <span className="cur-subm">
                              <Upload className="i i-xs" aria-hidden />
                              <span>Submission</span>
                            </span>
                            <span aria-hidden="true"> · </span>
                            <span translate="no">{r.source ? <SourceName source={r.source} /> : contributorName(r)}</span> <span aria-hidden="true">→</span>
                            <span className="sr-only">to</span> <span translate="no">{r.baseName}</span>
                          </>
                        ) : (
                          <>
                            <span translate="no">{(r.item?.ancestors?.map((a) => a.displayName ?? "").filter(Boolean) ?? [r.baseName]).join(" › ")}</span>
                            {r.source ? (
                              <>
                                <span aria-hidden="true"> · </span>
                                <span translate="no">
                                  <SourceName source={r.source} />
                                </span>
                              </>
                            ) : null}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ),
              },
              {
                id: "state",
                header: "State",
                cell: (r) => <ProcessingState row={r} live={tasks?.get(r.id)} fix={fixButton(r)} />,
              },
              {
                id: "updated",
                header: "Updated",
                hideOnMobile: true,
                sortValue: (r) => r.updated,
                cell: (r) => (
                  <Tip content={fmtDateTime(r.updated)}>
                    <span className="muted cur-nowrap">{rel(r.updated)}</span>
                  </Tip>
                ),
              },
            ]}
            // In flight (waiting or running), the row has nothing to do yet: its steps are the news.
            rowActionLead={(r) => (inFlight(r) ? null : fixButton(r))}
            rowActions={(r) => ops.menu(r, "row")}
            bulkActions={(ids) => (
              <Button variant="primary" size="sm" onPress={() => process(docs.filter((r) => ids.includes(r.id)))}>
                <Play className="i" aria-hidden />
                Process
              </Button>
            )}
            footer={<Pager page={page} pageSize={PER} total={rows.length} onPageChange={setPage} />}
          />
        </div>
      ) : (
        <NoMatches what="documents" onClear={clear} />
      )}
      <ProcessDialog request={processing} onClose={() => setProcessing(null)} onStarted={started} />
      <DecideDialog request={decide} onClose={() => setDecide(null)} onSubmit={(m) => void submitDecide(m)} />
      <DocumentDrawer row={current} onClose={() => setOpen("")} contributorName={current && !current.source ? contributorName(current) : ""} />
    </div>
  );
}
