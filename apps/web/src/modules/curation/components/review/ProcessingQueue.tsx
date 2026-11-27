"use client";

import { Button } from "@heroui/react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ClearFilters, DataTable, ErrorState, FileIcon, FilterButton, NoMatches, Pager, SearchInput, SectionTabs, SkeletonRows, Tip, toast, type DataTableSort } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { SEARCH_PAUSE_MS, useDebounced } from "@/lib/debounce";
import { fmtDateTime, plural, rel } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";
import { listItems } from "@/modules/knowledge/api";
import { useKnowledgeModel, useMemberNames } from "@/modules/knowledge/queries";

import { listContributionsPage, pageContributionsOf, rejectContribution, requestContributionChanges, type Contribution, type IngestionRun, type IngestionTask, type Item } from "../../api";
import { useCollectionLabels } from "../../collectionLabels";
import { useHeldDecisions } from "../../decisions";
import { PROCESSING_PILL_STATE, processingDocuments, processingSubmissions, type ProcessingPill, type ProcessingQuery } from "../../docFilter";
import { matches } from "../../governance";
import { canProcess, isCandidate } from "../../lifecycle";
import { isRowFix, opsFor, rowOf, type DocRow } from "../../model";
import { FIRST_PAGE, shownProcessing, taskKey, walkPage, type ProcCursor, type ShownProcessing } from "../../processingSteps";
import { readCandidates, useActiveRuns, useActiveTasks, useCounts, useDocScope, useInvalidateCuration, useRunTaskPages, withCandidates, type CountRead } from "../../queries";
import { DecideDialog, type DecideRequest } from "../DecideDialog";
import { DocumentDrawer } from "../DocumentDrawer";
import { SourceName } from "../parts";
import { ProcessingState } from "../ProcessingSteps";
import { ProcessDialog, type ProcessRequest } from "../ProcessDialog";
import { OP_META, useDocOps } from "../useDocOps";

const PER = 25;

/**
 * The state pills (preview `PROC_PILLS`): what rows show, each pill only while a row shows it (or it's the filter) —
 * Waiting and Processed exist only while a run is in flight.
 */
const PROC_PILLS: readonly (readonly [ShownProcessing, string])[] = [
  ["pending", "Chưa xử lý"],
  ["waiting", "Đang chờ"],
  ["processing", "Đang xử lý"],
  ["ready", "Đã xử lý"],
  ["failed", "Lỗi"],
  ["outdated", "Nguồn đã thay đổi"],
];
/** `?state=` presets a pill; anything else shows all. */
const pillOf = (state: string) => (PROC_PILLS.some(([k]) => k === state) ? state : "");
/** The pills the server filters (the processing state); the others are the run's tasks. */
const isServerPill = (state: string): state is ProcessingPill => state in PROCESSING_PILL_STATE;
const SERVER_PILLS = Object.keys(PROCESSING_PILL_STATE) as ProcessingPill[];

/** A Processing row's data: a document, or a new document's submission (its open contribution) with its candidate. */
interface Entry {
  item: Item;
  contribution: Contribution | null;
}

/** Filters and orders of one Processing page (null: nothing to read in that list). */
interface PageQuery {
  submissions: string | null;
  documents: string | null;
  submissionsOrder: string;
  documentsOrder: string;
}

/**
 * One Processing page (`walkPage`): submissions with their candidates, then documents with their open contribution
 * (a source's candidate) from one ListContributions read for the page.
 */
async function readPage(ws: string, cursor: ProcCursor, q: PageQuery): Promise<{ entries: Entry[]; next: ProcCursor | null }> {
  const { submissions: subsFilter, documents: docsFilter } = q;
  const page = await walkPage(cursor, PER, {
    submissions:
      subsFilter === null
        ? null
        : async (token, size) => {
            const r = await listContributionsPage(ws, { filter: subsFilter, orderBy: q.submissionsOrder, view: "FULL", pageSize: size, pageToken: token });
            return { rows: await withCandidates(ws, r.contributions ?? []), next: r.nextPageToken ?? "" };
          },
    documents:
      docsFilter === null
        ? null
        : async (token, size) => {
            const r = await listItems(ws, { filter: docsFilter, orderBy: q.documentsOrder, view: "FULL", pageSize: size, pageToken: token || undefined });
            return { rows: r.items ?? [], next: r.nextPageToken ?? "" };
          },
  });
  const open = await pageContributionsOf(
    ws,
    page.documents.map((it) => it.name ?? ""),
  );
  return {
    entries: [
      ...page.submissions.flatMap((s) => (s.item ? [{ item: s.item, contribution: s.contribution }] : [])),
      ...page.documents.map((item) => ({ item, contribution: openOf(open.get(item.name ?? "")) })),
    ],
    next: page.next,
  };
}

const openOf = (c: Contribution | undefined) => (c && isCandidate(c) ? c : null);

/** A page of the run's Waiting or Processed documents (task ID = item ID), with their open contributions. */
async function readRunPage(ws: string, ids: readonly string[]): Promise<Entry[]> {
  const names = ids.map((id) => `workspaces/${ws}/items/${id}`);
  const [items, open] = await Promise.all([readCandidates(ws, names), pageContributionsOf(ws, names)]);
  return names.flatMap((n) => {
    const item = items.get(n);
    return item ? [{ item, contribution: openOf(open.get(n)) }] : [];
  });
}

/**
 * Documents → Processing (preview `processingView`): what isn't processed yet — new documents' submissions first (the
 * assistant classifies them for their reviewer; once processed they move to Review), then documents nobody processed,
 * that failed or changed at their source. One table paged on the server: the submissions' pages, then the documents'
 * (the page that ends the submissions fills up with documents). Select rows → Process (the Process dialog: concepts
 * and context for the run). While a run is in flight each of its documents shows its run task: waiting, the step it's
 * at (the track opens each step), the step it failed at, or processed (kept until the run ends: the pages aren't read
 * again meanwhile); no row fix while it waits or runs. The state pills filter on the server's processing state; Waiting
 * and Processed page over the run's tasks. A submission's ⋯ also answers it (Request changes, Decline) when it can't
 * wait. `?state=` and `?kb=` preset the filters.
 */
export function ProcessingQueue({ kb: initialKb, state: initialState, done }: { kb: string; state: string; done: ReactNode }) {
  const { id: ws } = useWorkspace();
  const m = useMessages();
  const qc = useQueryClient();
  const held = useHeldDecisions();
  const { ctx } = useKnowledgeModel();
  const invalidate = useInvalidateCuration();
  const docScope = useDocScope();
  const { scope } = docScope;
  const runs = useActiveRuns();
  const [q, setQ] = useState("");
  const [kb, setKb] = useState(resourceId(initialKb));
  const [state, setState] = useState(pillOf(initialState));
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<ProcCursor[]>([FIRST_PAGE]);
  const [sort, setSort] = useState<DataTableSort>({ column: "updated", direction: "descending" });
  /** Checked rows by ID, on any page. */
  const [selected, setSelected] = useState<ReadonlyMap<string, DocRow>>(new Map());
  const [open, setOpen] = useState("");
  const [processing, setProcessing] = useState<ProcessRequest | null>(null);
  const [decide, setDecide] = useState<(DecideRequest & { row: DocRow }) | null>(null);
  useEffect(() => setKb(resourceId(initialKb)), [initialKb]);
  useEffect(() => setState(pillOf(initialState)), [initialState]);

  /* ── The filters → the server lists ── */
  // The search reaches the server once typing pauses (the box shows every keystroke).
  const sought = useDebounced(q.trim(), SEARCH_PAUSE_MS);
  const query: ProcessingQuery = { state: isServerPill(state) ? state : "", kb, q: sought };
  const runPill = state === "waiting" || state === "ready" ? state : null;
  const scopeKnown = !docScope.isPending;
  const pageQuery: PageQuery = {
    submissions: processingSubmissions(query, ws),
    documents: scopeKnown ? processingDocuments(scope, query, ws) : null,
    // Submissions have no name order: they keep the newest first.
    submissionsOrder: sort.column === "updated" && sort.direction === "ascending" ? "updateTime" : "updateTime desc",
    documentsOrder: sort.column === "name" ? `displayName${sort.direction === "descending" ? " desc" : ""}` : `updateTime${sort.direction === "ascending" ? "" : " desc"}`,
  };
  // A new filter or order starts over: page 1.
  const listKey = JSON.stringify([state, kb, sought, pageQuery.submissionsOrder, pageQuery.documentsOrder]);
  const [at, setAt] = useState(listKey);
  if (at !== listKey) {
    setAt(listKey);
    setPage(1);
    setCursors([FIRST_PAGE]);
  }
  const cursor = cursors[page - 1] ?? FIRST_PAGE;

  /* ── Counts: the totals behind the pager, the pills, and whether anything is left ── */
  const docCount = (filter: string | null): CountRead | undefined => (!scopeKnown ? undefined : filter === null ? null : { of: "items", filter });
  const subCount = (filter: string | null): CountRead => (filter === null ? null : { of: "contributions", filter });
  const none: ProcessingQuery = { state: "", kb: "", q: "" };
  const counts = useCounts([
    subCount(pageQuery.submissions),
    docCount(pageQuery.documents),
    subCount(processingSubmissions(none, ws)),
    docCount(processingDocuments(scope, none, ws)),
    ...SERVER_PILLS.flatMap((p) => [subCount(processingSubmissions({ ...none, state: p }, ws)), docCount(processingDocuments(scope, { ...none, state: p }, ws))]),
  ]);
  const [subsTotal = 0, docsTotal = 0, allSubs = 0, allDocs = 0, ...pillTotals] = counts.data;
  const pillCount = (p: ProcessingPill) => {
    const i = SERVER_PILLS.indexOf(p) * 2;
    return (pillTotals[i] ?? 0) + (pillTotals[i + 1] ?? 0);
  };

  /* ── The page: server lists, or the runs' tasks for Waiting and Processed ── */
  // While a run is in flight a page already read isn't read again (rows keep their place; the tasks show progress).
  // The run's end refreshes it.
  const pageKey = [ws, "items", "processing-page", pageQuery, cursor] as const;
  const inFlightRuns = runs.data ?? [];
  const frozen = inFlightRuns.length > 0 && qc.getQueryData(pageKey) !== undefined;
  const list = useQuery({
    queryKey: pageKey,
    queryFn: () => readPage(ws, cursor, pageQuery),
    enabled: !runPill && scopeKnown && !frozen,
    placeholderData: keepPreviousData,
  });
  const runTasks = useRunTaskPages(runPill === "waiting" ? "QUEUED" : runPill === "ready" ? "SUCCEEDED" : null, PER);
  const runPage = useMemo(() => (runPill ? (runTasks.data?.tasks ?? []).map(taskKey) : []), [runPill, runTasks.data]);
  const runList = useQuery({
    queryKey: [ws, "items", "processing-run-page", ...runPage],
    queryFn: () => readRunPage(ws, runPage),
    enabled: !!runPill && runPage.length > 0,
    placeholderData: keepPreviousData,
  });

  const baseNames = useMemo(() => ctx.collectionNames ?? new Map<string, string>(), [ctx.collectionNames]);
  const entries = runPill ? (runPage.length ? runList.data : []) : list.data?.entries;
  const docs = useMemo<DocRow[]>(
    () => (entries ?? []).filter((e) => !e.contribution || !held.has(e.contribution.name ?? "")).map((e) => rowOf(e.item, e.contribution, baseNames)),
    [entries, held, baseNames],
  );
  const live = useActiveTasks(docs.map((r) => r.id));
  // When the last run ends its tasks stay on the rows until the documents are read again (the run's end refreshes
  // them), so rows don't flash back to their state from before the run.
  const lastRun = useRef<{ tasks?: ReadonlyMap<string, IngestionTask>; read: number }>({ read: 0 });
  const read = list.dataUpdatedAt + runList.dataUpdatedAt;
  if (live) lastRun.current = { tasks: live, read };
  const tasks = live ?? (lastRun.current.read === read ? lastRun.current.tasks : undefined);
  const memberNames = useMemberNames(docs.map((r) => r.contributor));
  const contributorName = useCallback((r: DocRow) => memberNames.get(r.contributor ?? "") || "—", [memberNames]);
  // Submissions go to folders as often as to collections: name each by its path.
  const kbName = kb ? `workspaces/${ws}/items/${kb}` : "";
  const labels = useCollectionLabels([...docs.map((r) => r.base), kbName]);
  const baseLabel = (r: DocRow) => labels.get(r.base) || r.baseName;
  const onDecide = useCallback(
    (mode: "changes" | "decline", row: DocRow) =>
      setDecide({ mode, row, titles: [row.title], fileName: row.fileName, mime: row.mime, contributor: row.source ? undefined : contributorName(row) }),
    [contributorName],
  );
  const ops = useDocOps(onDecide);

  const pagePending = runPill ? runTasks.isLoading || (runPage.length > 0 && runList.isPending) : list.isPending;
  if (docScope.isPending || counts.isPending || pagePending) return <SkeletonRows rows={6} />;
  const failed = docScope.isError ? docScope : runPill ? (runTasks.isError ? runTasks : runList) : list;
  if (failed.isError) return <ErrorState error={failed.error} onRetry={() => void failed.refetch()} />;
  // Done: nothing left to process and no run in flight showing its documents.
  if (!allSubs && !allDocs && !inFlightRuns.length) return <>{done}</>;

  const reset = (set: (v: string) => void) => (v: string) => {
    set(v);
    setPage(1);
    setCursors([FIRST_PAGE]);
  };
  // Collection: the collections the caller looks after (and a preset one).
  const kbOpts = [...new Map([...docScope.bases.map((b) => [resourceId(b.name), b.displayName || "Kho tài liệu"] as const), ...(kb && !docScope.bases.some((b) => resourceId(b.name) === kb) ? [[kb, labels.get(kbName) || "Kho tài liệu"] as const] : [])]).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([value, label]) => ({ value, label }));
  const shown = (r: DocRow) => shownProcessing(r.processing, tasks?.get(r.id));
  // The runs' counts: what Waiting and Processed hold across the runs in flight.
  const runCount = (k: "waiting" | "ready") => inFlightRuns.reduce((a, r) => a + Number((k === "waiting" ? r.counts?.queuedCount : r.counts?.succeededCount) ?? 0), 0);
  const states = PROC_PILLS.filter(([k]) => k === state || (k === "waiting" || k === "ready" ? runCount(k) > 0 : pillCount(k as ProcessingPill) > 0));
  const pills = [{ id: "all", label: m.common.all }, ...states.map(([id, label]) => ({ id, label }))];
  // The run's pages are filtered here (by collection and name); the server's are filtered already.
  const rows = runPill
    ? docs.filter((r) => shown(r) === runPill && (!kb || resourceId(r.base) === kb || (r.item?.ancestors ?? []).some((a) => resourceId(a.name) === kb)) && matches(q, r.title, baseLabel(r)))
    : docs;
  const total = runPill ? runCount(runPill) : subsTotal + docsTotal;
  const clear = () => {
    setQ("");
    setKb("");
    setState("");
    setPage(1);
    setCursors([FIRST_PAGE]);
  };
  const current = rows.find((r) => r.id === open) ?? selected.get(open) ?? null;
  const toPage = (p: number) => {
    if (runPill) {
      runTasks.setPage(p);
      return;
    }
    const next = list.data?.next;
    if (p > page) {
      // The shown page must be this page's (not the previous one kept while it loads) for its next token.
      if (!next || list.isPlaceholderData) return;
      setCursors((c) => [...c.slice(0, page), next]);
    }
    setPage(p);
  };

  /** In the run in flight, waiting or running (its item still reads Not processed while it waits). */
  const inFlight = (r: DocRow) => {
    const t = tasks?.get(r.id)?.state;
    return t === "QUEUED" || t === "RUNNING";
  };
  const process = (picked: DocRow[]) => {
    const todo = picked.filter((r) => canProcess(r) && !inFlight(r));
    if (!todo.length) {
      toast(picked.some((r) => r.processing === "processing" || inFlight(r)) ? "Các tài liệu này đang được xử lý" : "Không tài liệu nào xử lý được", { tone: "danger" });
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
    setSelected(new Map());
    const count = run.counts?.totalCount ?? n ?? 0;
    const subs = processing?.rows.filter((r) => isCandidate(r.contribution)).length ?? 0;
    toast(`Đang xử lý ${plural(count, "document")}${subs ? ` · ${plural(subs, "submission")} sẽ chuyển sang mục Duyệt sau khi xử lý` : ""}`, { tone: "accent" });
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
      toast(mode === "changes" ? (decide.contributor ? `Đã yêu cầu ${decide.contributor} chỉnh sửa` : "Cần chỉnh sửa") : `Đã từ chối “${row.title}”`);
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      invalidate();
    }
  };

  return (
    <div className="kh gov">
      <p className="gov-summary">Chọn những gì cần xử lý: trợ lý sẽ đọc, phân loại và lập chỉ mục. Sau khi xử lý xong, tài liệu chờ duyệt chuyển sang mục Chờ duyệt.</p>
      <div className="toolbar">
        <SearchInput value={q} onChange={reset(setQ)} placeholder="Tìm kiếm tài liệu" />
        {kbOpts.length > 1 || kb ? <FilterButton label="Kho tài liệu" options={kbOpts} value={kb} onChange={reset(setKb)} /> : null}
        <ClearFilters isActive={!!kb} onClear={() => reset(setKb)("")} />
      </div>
      {pills.length > 2 || state ? (
        <div className="cur-pills">
          <SectionTabs items={pills} active={state || "all"} variant="primary" label="Trạng thái xử lý" onChange={(id) => reset(setState)(id === "all" ? "" : id)} />
        </div>
      ) : null}
      {rows.length ? (
        <div className="cur-proc">
          <DataTable
            label="Chưa xử lý"
            rows={rows}
            getRowId={(r) => r.id}
            sort={sort}
            onSortChange={setSort}
            selectedIds={new Set(selected.keys())}
            onSelectionChange={(ids) => {
              // The page's checkboxes change only this page; rows checked on other pages stay.
              const next = new Map([...selected].filter(([id]) => !rows.some((r) => r.id === id)));
              for (const r of rows) if (ids.has(r.id)) next.set(r.id, r);
              setSelected(next);
            }}
            rowLabel={(r) => r.title}
            onRowAction={(r) => setOpen(r.id)}
            columns={[
              {
                id: "name",
                header: "Tên",
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
                              <span>Tài liệu chờ duyệt</span>
                            </span>
                            <span aria-hidden="true"> · </span>
                            <span translate="no">{r.source ? <SourceName source={r.source} /> : contributorName(r)}</span> <span aria-hidden="true">→</span>
                            <span className="sr-only">vào</span> <span translate="no">{baseLabel(r)}</span>
                          </>
                        ) : (
                          <>
                            <span translate="no">{(r.item?.ancestors?.map((a) => a.displayName ?? "").filter(Boolean) ?? [baseLabel(r)]).join(" › ")}</span>
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
                header: "Trạng thái",
                cell: (r) => <ProcessingState row={r} live={tasks?.get(r.id)} fix={fixButton(r)} />,
              },
              {
                id: "updated",
                header: "Đã cập nhật",
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
            bulkActions={() => (
              <Button variant="primary" size="sm" onPress={() => process([...selected.values()])}>
                <Play className="i" aria-hidden />
                Xử lý
              </Button>
            )}
            footer={runPill ? <Pager page={runTasks.page} pageSize={PER} total={total} pageCount={rows.length} hasNext={runTasks.hasNext} onPageChange={toPage} /> : <Pager page={page} pageSize={PER} total={total} onPageChange={toPage} />}
          />
        </div>
      ) : (
        <NoMatches what="tài liệu" onClear={clear} />
      )}
      <ProcessDialog request={processing} onClose={() => setProcessing(null)} onStarted={started} />
      <DecideDialog request={decide} onClose={() => setDecide(null)} onSubmit={(m) => void submitDecide(m)} />
      <DocumentDrawer row={current} onClose={() => setOpen("")} contributorName={current && !current.source ? contributorName(current) : ""} />
    </div>
  );
}
