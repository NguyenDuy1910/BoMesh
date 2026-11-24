"use client";

import { Button, Checkbox } from "@heroui/react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleX, Tag } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { BulkBar, ErrorState, FileIcon, NoMatches, Pager, SearchInput, SkeletonRows, StatusChip, toast } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { SEARCH_PAUSE_MS, useDebounced } from "@/lib/debounce";
import { fmtNum, plural, relInline } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { getContribution } from "@/modules/knowledge/api";
import { LifecycleChip } from "@/modules/knowledge/components/LifecycleChip";
import { SourceIcon } from "@/modules/knowledge/components/SourceIcon";
import { useMemberNames } from "@/modules/knowledge/queries";

import { approveContribution, listContributionsPage, rejectContribution, requestContributionChanges } from "../../api";
import { useCollectionLabels } from "../../collectionLabels";
import { flushDecisions, holdDecision, useHeldDecisions, type SendInit } from "../../decisions";
import { contributionsOf, REVIEW_READY, reviewFilter } from "../../docFilter";
import { readyToReview } from "../../lifecycle";
import { cleanName, FLAG_META, flagsOf, hasFlag, isAnalyzing, lastEvent, MANY, QUEUE_FILTER_FN, QUEUE_FILTERS, targetOf, type QueueFilter } from "../../model";
import { analyzingKey, heldContributions, useAllTopics, useCounts, useInvalidateCuration, useReviewableBases, withCandidates, type Submission } from "../../queries";
import { CompareDrawer } from "../CompareDrawer";
import { DecideDialog, type DecideRequest } from "../DecideDialog";
import { SourceName } from "../parts";
import { MenuFilter } from "./MenuFilter";
import { DocPane, Inspector } from "./Inspector";
import type { Draft, SubView } from "./types";

/** Where approving puts it: a new version stays where the document is; a new document goes to its target or the
 *  assistant's suggestion. */
const baseOf = (c: Submission["contribution"]) => (c.kind === "NEW_REVISION" ? (c.targetCollection ?? "") : targetOf(c));

/** Submissions per Review queue page (preview `REVIEW_PER`); the pager under the queue walks the server's pages. */
const REVIEW_PAGE = 25;

/**
 * One page of Review's list: the submissions ready to decide that match `filter`, oldest first, with their candidates
 * (`withCandidates`). The previous page stays on screen while the next one loads.
 */
function useReviewPage(filter: string, pageToken: string) {
  const { id: ws } = useWorkspace();
  return useQuery({
    queryKey: [ws, "contributions", "review-pages", filter, pageToken],
    queryFn: async () => {
      const page = await listContributionsPage(ws, { filter, orderBy: "createTime", view: "FULL", pageSize: REVIEW_PAGE, pageToken: pageToken || undefined });
      return { subs: await withCandidates(ws, page.contributions ?? []), next: page.nextPageToken ?? "", total: page.totalSize ?? 0 };
    },
    placeholderData: keepPreviousData,
  });
}

/** Analyzing submissions one poll watches: their `item = …` terms stay under the server's 4096-character filter limit. */
const WATCHED = 30;

/**
 * Analysis finishes in the background: while loaded submissions are still being analyzed, a small poll (every 4 s;
 * BASIC view, those submissions only) watches for a change, and only then are Review's pages and the counts read again.
 */
function useAnalyzingWatch(loaded: readonly Submission[], loadedAt: number) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const analyzing = loaded.flatMap((s) => (isAnalyzing(s.contribution) ? [s.contribution] : [])).slice(0, WATCHED);
  const known = analyzingKey(analyzing);
  useQuery({
    queryKey: [ws, "contributions", "analyzing", known],
    enabled: !!known,
    queryFn: async () => {
      const names = new Set(analyzing.map((c) => c.name));
      const items = [...new Set(analyzing.flatMap((c) => (c.item ? [c.item] : [])))];
      if (!items.length) return known;
      const page = await listContributionsPage(ws, { filter: `state = "ANALYZING" AND (${contributionsOf(items)})`, pageSize: WATCHED });
      const now = analyzingKey((page.contributions ?? []).filter((c) => names.has(c.name)));
      if (now !== known) {
        void qc.invalidateQueries({ queryKey: [ws, "contributions", "review-pages"] });
        void qc.invalidateQueries({ queryKey: [ws, "contributions", "count"] });
      }
      return now;
    },
    initialData: known,
    initialDataUpdatedAt: loadedAt,
    staleTime: 3000,
    refetchInterval: 4000,
  });
}

/**
 * Review → Submissions (preview `submissionsQueue`): submissions ready to decide — a new document once processed (the
 * assistant classified it for this review), a format that can't be processed, every new version. The workbench fills
 * the screen under the chooser in three panes that each scroll on their own — the queue · the document · the
 * inspector with the decision footer. Selecting several swaps the decision footer for the floating bulk bar. The
 * queue is read from the server a page at a time (its filters and search are the server's), more as it scrolls.
 */
export function SubmissionsQueue({ kb: initialKb, done }: { kb: string; done: ReactNode }) {
  const { id: ws, can } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const held = useHeldDecisions();
  const topics = useAllTopics();
  const bases = useReviewableBases();
  const invalidate = useInvalidateCuration();

  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [kb, setKb] = useState(initialKb);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [decide, setDecide] = useState<(DecideRequest & { names: string[] }) | null>(null);
  const [compare, setCompare] = useState<{ sub: Submission; related: string } | null>(null);

  // ?kb= (from a collection page or a notice) preselects the collection filter.
  useEffect(() => setKb(initialKb), [initialKb]);
  // Decisions still in their Undo window are sent when leaving the queue.
  useEffect(() => () => flushDecisions(), []);

  /* ── The server's page, and the open submission when it isn't on it ── */
  // The search reaches the server once typing pauses (the box shows every keystroke).
  const sought = useDebounced(q.trim(), SEARCH_PAUSE_MS);
  const listFilter = reviewFilter({ queue: filter, collection: kb, q: sought }, ws);
  // Pages walk the server's page tokens (`tokens[p - 1]` reads page p); a new filter or search starts over at page 1.
  const [page, setPage] = useState(1);
  const [tokens, setTokens] = useState<string[]>([""]);
  /** Where to land once a page J/K turned to arrives: its first row (Next) or its last (Previous). */
  const turn = useRef<"first" | "last" | null>(null);
  const [pagedFor, setPagedFor] = useState(listFilter);
  if (pagedFor !== listFilter) {
    setPagedFor(listFilter);
    setPage(1);
    setTokens([""]);
  }
  const pages = useReviewPage(listFilter, tokens[page - 1] ?? "");
  const loaded = useMemo(() => pages.data?.subs ?? [], [pages.data]);
  useAnalyzingWatch(loaded, pages.dataUpdatedAt);
  const sel = params.get("sel") ?? "";
  const selLoaded = loaded.some((s) => resourceId(s.contribution.name) === sel);
  const selRead = useQuery({
    queryKey: [ws, "contributions", "review-selected", sel],
    enabled: !!sel && !pages.isPending && !pages.isPlaceholderData && !turn.current && !selLoaded,
    queryFn: async () => (await withCandidates(ws, [await getContribution(ws, sel, "FULL")]))[0],
    retry: false,
  });
  // The open submission joins the queue's head while its page isn't loaded, when it's still ready and matches the filters.
  const extra = !selLoaded && selRead.data && readyToReview(selRead.data.contribution, selRead.data.item) && QUEUE_FILTER_FN[filter](selRead.data.contribution) && (!kb || resourceId(selRead.data.contribution.targetCollection) === resourceId(kb)) && !q.trim() ? selRead.data : null;
  const subs = useMemo(() => (extra ? [extra, ...loaded] : loaded), [extra, loaded]);

  /* ── Counts: the whole queue (search and filters appear once it's long), each queue filter's ── */
  const filtered = filter !== "all" || !!kb;
  const [readyTotal] = useCounts([{ of: "contributions", filter: REVIEW_READY }]).data;
  const queueTotal = Math.max(0, (readyTotal ?? 0) - heldContributions(held).length);
  const long = queueTotal > MANY;
  const chips = QUEUE_FILTERS.filter(([k]) => k !== "all");
  const chipCounts = useCounts(
    chips.map(([k]) => ({ of: "contributions", filter: reviewFilter({ queue: k, collection: "", q: "" }, ws) })),
    { enabled: long || filtered },
  ).data;
  const chipCount = (k: QueueFilter) => (k === "all" ? queueTotal : (chipCounts[chips.findIndex(([c]) => c === k)] ?? 0));

  const memberNames = useMemberNames(subs.flatMap((s) => [s.contribution.contributor, ...(s.contribution.events ?? []).map((e) => e.actor)]));
  // Targets are often folders: name them by their path ("Root › Folder").
  const baseNames = useCollectionLabels(subs.map((s) => baseOf(s.contribution)));

  const views = useMemo<SubView[]>(
    () =>
      subs
        .filter((s) => !held.has(s.contribution.name ?? ""))
        .map((s) => {
          const c = s.contribution;
          const fileName = s.item?.document?.fileName || s.item?.displayName || "";
          const base = baseOf(c);
          return {
            sub: s,
            name: c.name ?? "",
            id: resourceId(c.name),
            title: (s.item?.displayName || fileName || "Tài liệu chưa đặt tên").replace(/\.[a-z0-9]{1,5}$/i, ""),
            displayName: s.item?.displayName || fileName,
            fileName,
            mime: s.item?.document?.mimeType ?? "",
            contributor: c.origin === "SOURCE" ? "" : memberNames.get(c.contributor ?? "") || "—",
            via: c.origin === "SOURCE",
            base,
            baseName: baseNames.get(base) ?? "",
            resubmitted: lastEvent(c).kind === "RESUBMITTED",
            analyzing: isAnalyzing(c),
            flags: flagsOf(c),
          };
        }),
    [subs, held, memberNames, baseNames],
  );

  // The server filtered and searched them.
  const rows = views;
  const cur = rows.find((v) => v.id === sel) ?? rows[0];
  const pos = cur ? rows.indexOf(cur) : -1;
  const open = !!sel && cur?.id === sel;
  /** The filtered queue's size: the server's total, less what's held for Undo, plus the open submission it lacks. */
  const total = Math.max(rows.length, (pages.data?.total ?? 0) - (subs.length - views.length) + (extra ? 1 : 0));
  /** The open submission's place in the whole queue (the inspector's "n/total"): earlier pages come first. */
  const at = Math.max(0, (page - 1) * REVIEW_PAGE + pos - (extra ? 1 : 0));

  // Selection follows the rows that still exist.
  const live = new Set(views.map((v) => v.name));
  const picked = [...selected].filter((n) => live.has(n));

  /* ── Navigation ── */
  const setSel = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params.toString());
      next.set("tab", "documents");
      next.set("view", "review");
      if (id) next.set("sel", id);
      else next.delete("sel");
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );
  const listRef = useRef<HTMLDivElement>(null);
  const queueRef = useRef<HTMLDivElement>(null);
  const pick = useCallback(
    (id: string) => {
      setSel(id);
      requestAnimationFrame(() => listRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" }));
    },
    [setSel],
  );
  /* ── Pages: the pager under the queue, and J/K across a page's ends ── */
  const nextToken = pages.data?.next ?? "";
  const goPage = useCallback(
    (p: number, land: "first" | "last" | null = null) => {
      if (p < 1 || (p > page && !nextToken)) return;
      if (p === page + 1) setTokens((t) => [...t.slice(0, page), nextToken]);
      turn.current = land;
      setPage(p);
      // The pager opens the new page's first submission; J/K open the one next to where they were.
      if (!land) setSel("");
      listRef.current?.scrollTo({ top: 0 });
    },
    [page, nextToken, setSel],
  );
  const step = useCallback(
    (dir: 1 | -1) => {
      if (!rows.length) return;
      if (dir === 1 && pos >= rows.length - 1) return goPage(page + 1, "first");
      if (dir === -1 && pos <= 0) return goPage(page - 1, "last");
      const n = rows[pos + dir];
      if (n) pick(n.id);
    },
    [rows, pos, pick, page, goPage],
  );
  useEffect(() => {
    if (!turn.current || pages.isPlaceholderData) return;
    const n = turn.current === "first" ? rows[0] : rows[rows.length - 1];
    turn.current = null;
    if (n) pick(n.id);
  }, [rows, pages.isPlaceholderData, pick]);

  // Phones show the inspector in place of the queue, in the page's scroll: open it at its top, not at the list's
  // scroll position (which hid its header and name under the page header).
  useEffect(() => {
    if (!open || !queueRef.current || queueRef.current.offsetParent !== null) return;
    let el = document.getElementById("cur-detail")?.parentElement ?? null;
    while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement;
    el?.scrollTo({ top: 0 });
  }, [open, cur?.id]);

  /* Keyboard: J/K or ↓/↑ move through the queue; Enter opens the full preview. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input,textarea,select,[contenteditable="true"],[role="dialog"],[role="listbox"],[role="menu"]')) return;
      if (document.querySelector('[role="dialog"]')) return;
      const k = e.key;
      if (k === "j" || k === "J" || k === "ArrowDown") {
        e.preventDefault();
        step(1);
      } else if (k === "k" || k === "K" || k === "ArrowUp") {
        e.preventDefault();
        step(-1);
      } else if (k === "Enter" && !t?.closest?.("button,a,[role=button],label") && cur?.sub.item?.name) {
        e.preventDefault();
        router.push(`/doc/${resourceId(cur.sub.item.name)}`);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [step, cur, router]);

  /* ── Drafts: the reviewer's working copy of the assistant's suggestion ── */
  const draftOf = (v: SubView | undefined): Draft | null => {
    if (!v || v.analyzing) return null;
    const c = v.sub.contribution;
    const existing = drafts[v.name];
    if (existing && existing.etag === c.etag) return existing;
    return {
      etag: c.etag ?? "",
      topics: [...(c.suggestions?.topics ?? [])],
      kb: baseOf(c),
      summary: c.suggestions?.summary ?? "",
      title: c.suggestions?.title || v.displayName,
      teach: true,
    };
  };
  const setDraft = (v: SubView, patch: Partial<Draft>) => {
    const base = draftOf(v);
    if (base) setDrafts((d) => ({ ...d, [v.name]: { ...base, ...patch } }));
  };

  /* ── Decisions: held for Undo, then sent; the next item opens ── */
  const run = (subs: SubView[], send: (v: SubView, init: SendInit) => Promise<unknown>, message: string) => {
    const ids = new Set(subs.map((v) => v.name));
    const next = rows.slice(pos + 1).find((v) => !ids.has(v.name)) ?? rows.slice(0, Math.max(0, pos)).reverse().find((v) => !ids.has(v.name));
    setSelected((s) => new Set([...s].filter((n) => !ids.has(n))));
    // Stay in Submissions (its done state points at the next queue) instead of jumping to whichever queue has items.
    setSel(subs.some((v) => v.id === cur?.id) ? (next?.id ?? "") : sel);
    const first = subs[0];
    holdDecision({
      names: [...ids],
      message,
      undoneMessage: subs.length === 1 ? `“${first.title}” đã quay lại chờ duyệt` : `${plural(subs.length, "document")} đã quay lại chờ duyệt`,
      send: async (init) => {
        await Promise.all(subs.map((v) => send(v, init)));
      },
      onSent: invalidate,
      onUndo: () => setSel(first.id),
      onFailed: invalidate,
    });
  };

  /** The approved name: only a new document's, only when set and changed; a blank name is never sent. */
  const titleOf = (v: SubView, d: Draft) => {
    const t = v.sub.contribution.kind === "NEW_DOCUMENT" ? cleanName(d.title) : "";
    return t && t !== v.displayName ? t : undefined;
  };

  const approveOne = async (v: SubView, d: Draft, init: SendInit) => {
    const c = v.sub.contribution;
    await approveContribution(
      ws,
      v.name,
      {
        etag: c.etag ?? "",
        targetCollection: c.kind === "NEW_REVISION" ? undefined : d.kb || undefined,
        topics: d.topics,
        summary: d.summary.trim() || undefined,
        title: titleOf(v, d),
        // The server records a correction only when the topics differ from the assistant's.
        recordCorrection: d.teach,
      },
      init,
    );
  };

  /** Approval publishes only: a processed new document is searchable at once; a new version waits in Processing. */
  const approve = (v: SubView) => {
    const d = draftOf(v);
    if (!d || (v.sub.contribution.kind === "NEW_DOCUMENT" && !cleanName(d.title))) return;
    const msg =
      v.sub.contribution.kind === "NEW_REVISION"
        ? `Đã công bố “${v.title}” thành phiên bản mới. Hãy xử lý ở mục “Đang xử lý” để tìm kiếm dùng phiên bản mới.`
        : `Đã công bố “${titleOf(v, d) ?? v.title}” vào ${baseNames.get(d.kb) || "kho tài liệu chứa tài liệu"}`;
    run([v], (x, init) => approveOne(x, d, init), msg);
  };

  const bulkApprove = () => {
    const subs = views.filter((v) => picked.includes(v.name));
    const personal = subs.filter((v) => !v.analyzing && hasFlag(v.sub.contribution, "personal"));
    const busy = subs.filter((v) => v.analyzing);
    const noBase = subs.filter((v) => !busy.includes(v) && !personal.includes(v) && !draftOf(v)?.kb && v.sub.contribution.kind !== "NEW_REVISION");
    const ok = subs.filter((v) => !personal.includes(v) && !busy.includes(v) && !noBase.includes(v));
    const skipped = [personal.length && `${personal.length} có dữ liệu cá nhân`, busy.length && `${busy.length} vẫn đang được phân tích`, noBase.length && `${noBase.length} chưa có kho tài liệu`]
      .filter(Boolean)
      .join(" và ");
    if (!ok.length) {
      toast(`Chưa công bố gì: ${skipped || "hãy chọn tài liệu chờ duyệt trước"}. Hãy duyệt từng mục một.`, { tone: "danger" });
      return;
    }
    const decisions = new Map(ok.map((v) => [v.name, draftOf(v)!]));
    const versions = ok.filter((v) => v.sub.contribution.kind === "NEW_REVISION").length;
    const after = versions ? ` · ${versions} phiên bản mới cần xử lý ở mục Đang xử lý` : "";
    run(ok, (x, init) => approveOne(x, decisions.get(x.name)!, init), `Đã công bố ${plural(ok.length, "document")}${after}${skipped ? ` · đã bỏ qua ${skipped}` : ""}`);
    // Keep the skipped ones selected so they're easy to find.
    setSelected(new Set([...personal, ...busy, ...noBase].map((v) => v.name)));
  };

  const openDecide = (mode: "changes" | "decline", subs: SubView[]) => {
    if (!subs.length) return;
    setDecide({
      mode,
      names: subs.map((v) => v.name),
      titles: subs.map((v) => v.title),
      fileName: subs.length === 1 ? subs[0].fileName : undefined,
      mime: subs.length === 1 ? subs[0].mime : undefined,
      contributor: subs.length === 1 ? subs[0].contributor || undefined : undefined,
    });
  };
  const submitDecide = (message: string) => {
    if (!decide) return;
    const subs = views.filter((v) => decide.names.includes(v.name));
    setDecide(null);
    if (!subs.length) return;
    const one = subs.length === 1;
    if (decide.mode === "changes") {
      run(subs, (x, init) => requestContributionChanges(ws, x.name, message, x.sub.contribution.etag, init), one && subs[0].contributor ? `Đã yêu cầu ${subs[0].contributor} chỉnh sửa` : "Cần chỉnh sửa");
    } else {
      run(subs, (x, init) => rejectContribution(ws, x.name, message, x.sub.contribution.etag, init), one ? `Đã từ chối “${subs[0].title}”` : `Đã từ chối ${plural(subs.length, "submission")}`);
    }
  };

  /* ── Render ── */
  if (pages.isPending) {
    return (
      <div className="cur-split cur-wb">
        <div className="cur-queue">
          <SkeletonRows rows={6} />
        </div>
        <div className="cur-pane">
          <SkeletonRows rows={3} />
        </div>
        <div className="cur-detail cur-insp">
          <SkeletonRows rows={3} />
        </div>
      </div>
    );
  }
  if (pages.isError) return <ErrorState error={pages.error} onRetry={() => void pages.refetch()} />;
  // Done: nothing left to decide (a filtered or searched queue that's empty is No matches).
  const morePages = !!nextToken || page > 1;
  if (!views.length && !morePages && ((readyTotal !== undefined && queueTotal === 0) || (!filtered && !q.trim()))) return <>{done}</>;

  // Collection: the target collections of the loaded submissions (`targetCollection`), and a preset one.
  const kbOptions = [
    ...new Map([
      ...views.flatMap((v) => (v.sub.contribution.targetCollection ? [[resourceId(v.sub.contribution.targetCollection), baseNames.get(v.sub.contribution.targetCollection) || "Kho tài liệu"] as const] : [])),
      ...(kb && !views.some((v) => resourceId(v.sub.contribution.targetCollection) === resourceId(kb)) ? [[resourceId(kb), baseNames.get(`workspaces/${ws}/items/${resourceId(kb)}`) || "Kho tài liệu"] as const] : []),
    ]).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1]));
  const canFilter = filtered || kbOptions.length > 1 || chips.some(([k]) => chipCount(k) > 0);
  const ids = rows.map((v) => v.name);
  const n = ids.filter((id) => picked.includes(id)).length;
  const toggleAll = (on: boolean) => setSelected(on ? new Set([...picked, ...ids]) : new Set(picked.filter((id) => !ids.includes(id))));
  const curDraft = draftOf(cur);
  const clearFilters = () => {
    setQ("");
    setFilter("all");
    setKb("");
  };

  return (
    <>
      <div className={`cur-split cur-wb${open ? " has-sel" : ""}`}>
        <div className={`cur-queue${n ? " has-sel" : ""}`} ref={queueRef}>
          {long || q || ((long || filtered) && canFilter) ? (
            <div className="cur-queue__tools">
              {long || q ? <SearchInput value={q} onChange={setQ} placeholder="Tìm theo tên" fullWidth /> : null}
              {(long || filtered) && canFilter ? (
                <div className="cur-queue__filters">
                  <MenuFilter
                    label={[filter !== "all" && QUEUE_FILTERS.find(([k]) => k === filter)?.[1], kb && kbOptions.find(([k]) => k === resourceId(kb))?.[1]].filter(Boolean).join(" · ")}
                    sections={[
                      {
                        title: "Hiển thị",
                        value: filter,
                        options: QUEUE_FILTERS.filter(([k]) => k === "all" || k === filter || chipCount(k) > 0).map(([k, label]) => ({
                          value: k,
                          label,
                          meta: fmtNum(chipCount(k)),
                        })),
                        onChange: (v) => setFilter(v as QueueFilter),
                      },
                      ...(kbOptions.length > 1 || kb
                        ? [{ title: "Kho tài liệu", value: resourceId(kb), options: [{ value: "", label: "Tất cả kho tài liệu" }, ...kbOptions.map(([value, label]) => ({ value, label, data: true }))], onChange: setKb }]
                        : []),
                    ]}
                    onClear={filtered ? () => {
                      setFilter("all");
                      setKb("");
                    } : undefined}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
          {n ? (
            <div className="cur-queue__sel">
              <Checkbox isSelected={n === ids.length} isIndeterminate={n < ids.length} onChange={toggleAll} aria-label="Chọn tất cả">
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <span className="checkbox__label">{n === ids.length ? "Đã chọn tất cả" : "Chọn tất cả"}</span>
                </Checkbox.Content>
              </Checkbox>
            </div>
          ) : null}
          {rows.length ? (
            <div className="cur-queue__list" role="list" ref={listRef}>
              {rows.map((v) => (
                <QueueItem
                  key={v.name}
                  view={v}
                  active={v.id === cur?.id}
                  checked={picked.includes(v.name)}
                  onCheck={(on) => setSelected((s) => (on ? new Set([...s, v.name]) : new Set([...s].filter((x) => x !== v.name))))}
                  onPick={() => (v.id === cur?.id && open && v.sub.item?.name ? router.push(`/doc/${resourceId(v.sub.item.name)}`) : pick(v.id))}
                />
              ))}
            </div>
          ) : morePages ? (
            // Every row of this page is in its Undo window: the page refills once the decisions are sent.
            <div className="cur-queue__list">
              <SkeletonRows rows={3} />
            </div>
          ) : (
            <div className="cur-queue__none">
              <NoMatches what="bài gửi" onClear={clearFilters} />
            </div>
          )}
          {total > REVIEW_PAGE || page > 1 ? (
            <div className="cur-queue__foot">
              <Pager page={page} pageSize={REVIEW_PAGE} total={total} hasNext={!!nextToken} onPageChange={(p) => goPage(p)} />
            </div>
          ) : null}
        </div>
        {cur ? (
          <>
            <DocPane key={`pane-${cur.name}`} view={cur} />
            <Inspector
              key={cur.name}
              view={cur}
              pos={at}
              total={total}
              selecting={n > 0}
              draft={curDraft}
              setDraft={(patch) => setDraft(cur, patch)}
              topics={topics.data ?? []}
              bases={bases.data.filter((b) => b.collection?.acceptsContributions !== false || b.name === curDraft?.kb).map((b) => ({ name: b.name ?? "", displayName: b.displayName ?? "" }))}
              baseNames={baseNames}
              memberNames={memberNames}
              canManageTopics={can("topics.update")}
              onStep={step}
              onBack={() => setSel("")}
              onApprove={() => approve(cur)}
              onChanges={() => openDecide("changes", [cur])}
              onDecline={() => openDecide("decline", [cur])}
              onCompare={(related) => setCompare({ sub: cur.sub, related })}
            />
          </>
        ) : (
          <>
            <div className="cur-pane" />
            <div className="cur-detail cur-insp" />
          </>
        )}
      </div>
      <BulkBar count={n} onClear={() => setSelected(new Set())}>
        <Button variant="ghost" size="sm" onPress={() => openDecide("decline", views.filter((v) => picked.includes(v.name)))}>
          <CircleX className="i" aria-hidden />
          Từ chối…
        </Button>
        <Button variant="secondary" size="sm" onPress={bulkApprove}>
          <Check className="i" aria-hidden />
          Duyệt và công bố
        </Button>
      </BulkBar>
      <DecideDialog request={decide} onClose={() => setDecide(null)} onSubmit={submitDecide} />
      <CompareDrawer
        submission={compare?.sub ?? null}
        related={compare?.related ?? ""}
        contributor={compare ? (memberNames.get(compare.sub.contribution.contributor ?? "") ?? "") : ""}
        baseName={compare ? (baseNames.get(baseOf(compare.sub.contribution)) ?? "") : ""}
        onClose={() => setCompare(null)}
      />
    </>
  );
}

function QueueItem({ view: v, active, checked, onCheck, onPick }: { view: SubView; active: boolean; checked: boolean; onCheck: (on: boolean) => void; onPick: () => void }) {
  const c = v.sub.contribution;
  const shown = v.flags.filter((f, i, all) => all.findIndex((x) => x.type === f.type) === i);
  const proposes = (c.suggestions?.proposedTopics ?? []).length > 0;
  return (
    <div
      className={`cur-item${active ? " is-active" : ""}`}
      role="button"
      tabIndex={0}
      aria-current={active ? "true" : undefined}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest(".cur-item__check")) return;
        onPick();
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick();
        }
      }}
    >
      <span className="cur-item__check">
        <Checkbox isSelected={checked} onChange={onCheck} aria-label={`Chọn ${v.title}`}>
          <Checkbox.Content>
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
          </Checkbox.Content>
        </Checkbox>
      </span>
      <FileIcon name={v.fileName} mime={v.mime} />
      <span className="cur-item__body">
        <span className="cur-item__title truncate" title={v.title} translate="no">
          {v.title}
        </span>
        <span className="cur-item__meta">
          {v.via ? <SourceIcon source={c.source} size="sm" /> : null}
          <span className="truncate">
            {v.via ? <SourceName source={c.source} /> : v.contributor} · {relInline(lastEvent(c).at)}
          </span>
        </span>
        <span className="cur-item__meta">
          {/* The folder it goes to; its full path ("Root › … › Folder") in the tooltip. */}
          <span className="truncate" translate="no" title={v.baseName || undefined}>
            {v.baseName.split(" › ").pop()}
          </span>
          <span className="cur-item__flags">
            {v.analyzing ? (
              <LifecycleChip lifecycle="analyzing" size="sm" />
            ) : (
              <>
                {shown
                  .filter((f) => FLAG_META[f.type].chip)
                  .map((f) => (
                    <StatusChip key={f.type} label={FLAG_META[f.type].label} icon={FLAG_META[f.type].icon} tone={FLAG_META[f.type].tone} size="sm" dot={false} />
                  ))}
                {shown.filter((f) => !FLAG_META[f.type].chip).map((f) => {
                  const meta = FLAG_META[f.type];
                  const Icon = meta.icon;
                  return (
                    <span key={f.type} className={`cur-flag cur-flag--${meta.tone}`} title={meta.label} role="img" aria-label={meta.label}>
                      <Icon className="i i-xs" aria-hidden />
                    </span>
                  );
                })}
                {proposes ? (
                  <span className="cur-flag cur-flag--accent" title="Đề xuất chủ đề mới" role="img" aria-label="Đề xuất chủ đề mới">
                    <Tag className="i i-xs" aria-hidden />
                  </span>
                ) : null}
              </>
            )}
          </span>
        </span>
      </span>
    </div>
  );
}
