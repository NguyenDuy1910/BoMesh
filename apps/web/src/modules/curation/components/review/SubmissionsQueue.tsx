"use client";

import { Button, Checkbox } from "@heroui/react";
import { Check, CircleX, Tag } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { BulkBar, ErrorState, FileIcon, NoMatches, SearchInput, SkeletonRows, StatusChip, toast } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { fmtNum, plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { LifecycleChip } from "@/modules/knowledge/components/LifecycleChip";
import { SourceIcon } from "@/modules/knowledge/components/SourceIcon";
import { fold } from "@/modules/knowledge/model";
import { useKnowledgeModel, useMemberNames } from "@/modules/knowledge/queries";

import { approveContribution, createIngestionRun, rejectContribution, requestContributionChanges } from "../../api";
import { flushDecisions, holdDecision, useHeldDecisions } from "../../decisions";
import { isUnprocessable } from "../../lifecycle";
import { docsHref, FLAG_META, flagsOf, hasFlag, isAnalyzing, lastEvent, MANY, QUEUE_FILTER_FN, QUEUE_FILTERS, suggestedKind, targetOf, type QueueFilter } from "../../model";
import { useAllTopics, useInvalidateCuration, useReviewableBases, useReviewQueue, type Submission } from "../../queries";
import { CompareDrawer } from "../CompareDrawer";
import { DecideDialog, type DecideRequest } from "../DecideDialog";
import { SourceName } from "../parts";
import { MenuFilter } from "./MenuFilter";
import { DocPane, Inspector } from "./Inspector";
import type { Draft, SubView } from "./types";

const relLow = (at: string) => rel(at).replace(/^(Just now|Yesterday)$/, (m) => m.toLowerCase());

/**
 * Review → Submissions (preview `submissionsQueue`): the workbench fills the screen under the chooser in three
 * panes that each scroll on their own — the queue · the document · the inspector with the decision footer.
 * Selecting several swaps the decision footer for the floating bulk bar.
 */
export function SubmissionsQueue({ kb: initialKb, done }: { kb: string; done: ReactNode }) {
  const { id: ws, can } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const queue = useReviewQueue();
  const held = useHeldDecisions();
  const topics = useAllTopics();
  const bases = useReviewableBases();
  const { ctx } = useKnowledgeModel();
  const invalidate = useInvalidateCuration();
  const memberNames = useMemberNames((queue.data ?? []).flatMap((s) => [s.contribution.contributor, ...(s.contribution.events ?? []).map((e) => e.actor)]));

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

  const baseNames = ctx.collectionNames ?? new Map<string, string>();
  const views = useMemo<SubView[]>(
    () =>
      (queue.data ?? [])
        .filter((s) => !held.has(s.contribution.name ?? ""))
        .map((s) => {
          const c = s.contribution;
          const fileName = s.item?.document?.fileName || s.item?.displayName || "";
          const base = c.kind === "NEW_REVISION" ? c.targetCollection || "" : targetOf(c);
          return {
            sub: s,
            name: c.name ?? "",
            id: resourceId(c.name),
            title: (s.item?.displayName || fileName || "Untitled document").replace(/\.[a-z0-9]{1,5}$/i, ""),
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
    [queue.data, held, memberNames, baseNames],
  );

  const fq = fold(q.trim());
  const rows = views.filter(
    (v) =>
      QUEUE_FILTER_FN[filter](v.sub.contribution) &&
      (!kb || resourceId(v.base) === resourceId(kb)) &&
      (!fq || fold([v.title, v.contributor, v.baseName, v.sub.contribution.note ?? ""].join(" ")).includes(fq)),
  );
  const sel = params.get("sel") ?? "";
  const cur = rows.find((v) => v.id === sel) ?? rows[0];
  const pos = cur ? rows.indexOf(cur) : -1;
  const open = !!sel && cur?.id === sel;

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
  const pick = useCallback(
    (id: string) => {
      setSel(id);
      requestAnimationFrame(() => listRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" }));
    },
    [setSel],
  );
  const step = useCallback(
    (dir: 1 | -1) => {
      if (!rows.length) return;
      const n = rows[Math.min(rows.length - 1, Math.max(0, pos + dir))];
      if (n && n.id !== cur?.id) pick(n.id);
    },
    [rows, pos, cur, pick],
  );

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
    const kind = suggestedKind(c, v.sub.item);
    return {
      etag: c.etag ?? "",
      kind,
      topics: [...(c.suggestions?.topics ?? [])],
      kb: c.kind === "NEW_REVISION" ? (c.targetCollection ?? "") : targetOf(c),
      summary: c.suggestions?.summary ?? "",
      process: true,
      teach: true,
      initial: { kind },
    };
  };
  const setDraft = (v: SubView, patch: Partial<Draft>) => {
    const base = draftOf(v);
    if (base) setDrafts((d) => ({ ...d, [v.name]: { ...base, ...patch } }));
  };

  /* ── Decisions: held for Undo, then sent; the next item opens ── */
  const run = (subs: SubView[], send: (v: SubView) => Promise<void>, message: string) => {
    const ids = new Set(subs.map((v) => v.name));
    const next = rows.slice(pos + 1).find((v) => !ids.has(v.name)) ?? rows.slice(0, Math.max(0, pos)).reverse().find((v) => !ids.has(v.name));
    setSelected((s) => new Set([...s].filter((n) => !ids.has(n))));
    // Stay in Submissions (its done state points at the next queue) instead of jumping to whichever queue has items.
    setSel(subs.some((v) => v.id === cur?.id) ? (next?.id ?? "") : sel);
    const first = subs[0];
    holdDecision({
      names: [...ids],
      message,
      undoneMessage: subs.length === 1 ? `“${first.title}” is back in review` : `${plural(subs.length, "document")} are back in review`,
      send: async () => {
        await Promise.all(subs.map(send));
      },
      onSent: invalidate,
      onUndo: () => setSel(first.id),
      onFailed: invalidate,
    });
  };

  /** Processed now unless the reviewer unticked Process it now (images and archives never are); then it waits as Not processed in All. */
  const processes = (v: SubView, d: Draft) => d.process && !isUnprocessable(v.fileName, v.mime);

  const approveOne = async (v: SubView, d: Draft) => {
    const c = v.sub.contribution;
    const revision = c.kind === "NEW_REVISION";
    await approveContribution(ws, v.name, {
      etag: c.etag ?? "",
      targetCollection: revision ? undefined : d.kb || undefined,
      documentType: d.kind,
      topics: d.topics,
      summary: d.summary.trim() || undefined,
      // The server records a correction only when the topics differ from the assistant's.
      recordCorrection: d.teach,
    });
    // Approval publishes; processing is its own run on the published document.
    const target = revision ? c.replacesItem : v.sub.item?.name;
    if (target && processes(v, d)) {
      await createIngestionRun(ws, { selector: { items: [target] } }).catch(() =>
        toast(`Published “${v.title}”, but processing didn’t start. Process it from All when you’re ready.`, {
          tone: "warning",
          action: { label: "Open Documents", onPress: () => router.push(docsHref("all", { processing: "pending" })) },
        }),
      );
    }
  };

  const approve = (v: SubView) => {
    const d = draftOf(v);
    if (!d) return;
    const c = v.sub.contribution;
    const after = processes(v, d) ? "Processing it now." : "Not processed yet: process it from All when you’re ready.";
    const msg = c.kind === "NEW_REVISION" ? `Published “${v.title}” as a new version. ${after}` : `Published “${v.title}” to ${baseNames.get(d.kb) || "its collection"}. ${after}`;
    run([v], (x) => approveOne(x, d), msg);
  };

  const bulkApprove = () => {
    const subs = views.filter((v) => picked.includes(v.name));
    const personal = subs.filter((v) => !v.analyzing && hasFlag(v.sub.contribution, "personal"));
    const busy = subs.filter((v) => v.analyzing);
    const noBase = subs.filter((v) => !busy.includes(v) && !personal.includes(v) && !draftOf(v)?.kb && v.sub.contribution.kind !== "NEW_REVISION");
    const ok = subs.filter((v) => !personal.includes(v) && !busy.includes(v) && !noBase.includes(v));
    const skipped = [personal.length && `${personal.length} with personal data`, busy.length && `${busy.length} still being analyzed`, noBase.length && `${noBase.length} without a collection`]
      .filter(Boolean)
      .join(" and ");
    if (!ok.length) {
      toast(`Nothing published: ${skipped || "select submissions first"}. Review ${personal.length + busy.length + noBase.length === 1 ? "it" : "them"} one by one.`, { tone: "danger" });
      return;
    }
    const decisions = new Map(ok.map((v) => [v.name, draftOf(v)!]));
    const processing = ok.filter((v) => processes(v, decisions.get(v.name)!)).length;
    const after = processing === ok.length ? " and started processing them" : processing ? ` · processing ${processing} of them` : " · not processed yet: process them from All when you’re ready";
    run(ok, (x) => approveOne(x, decisions.get(x.name)!), `Published ${plural(ok.length, "document")}${after}${skipped ? ` · skipped ${skipped}` : ""}`);
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
      run(subs, (x) => requestContributionChanges(ws, x.name, message, x.sub.contribution.etag).then(() => undefined), one && subs[0].contributor ? `Asked ${subs[0].contributor} for changes` : "Changes requested");
    } else {
      run(subs, (x) => rejectContribution(ws, x.name, message, x.sub.contribution.etag).then(() => undefined), one ? `Declined “${subs[0].title}”` : `Declined ${plural(subs.length, "submission")}`);
    }
  };

  /* ── Render ── */
  if (queue.isPending) {
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
  if (queue.isError) return <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />;
  if (!views.length) return <>{done}</>;

  const kbOptions = [...new Map(views.filter((v) => v.base).map((v) => [resourceId(v.base), baseNames.get(v.base) || "Collection"])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const filtered = filter !== "all" || !!kb;
  const long = views.length > MANY;
  const canFilter = filtered || kbOptions.length > 1 || QUEUE_FILTERS.some(([k]) => k !== "all" && views.some((v) => QUEUE_FILTER_FN[k](v.sub.contribution)));
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
        <div className={`cur-queue${n ? " has-sel" : ""}`}>
          {long || q || ((long || filtered) && canFilter) ? (
            <div className="cur-queue__tools">
              {long || q ? <SearchInput value={q} onChange={setQ} placeholder="Search submissions" fullWidth /> : null}
              {(long || filtered) && canFilter ? (
                <div className="cur-queue__filters">
                  <MenuFilter
                    label={[filter !== "all" && QUEUE_FILTERS.find(([k]) => k === filter)?.[1], kb && kbOptions.find(([k]) => k === resourceId(kb))?.[1]].filter(Boolean).join(" · ")}
                    sections={[
                      {
                        title: "Show",
                        value: filter,
                        options: QUEUE_FILTERS.filter(([k]) => k === "all" || k === filter || views.some((v) => QUEUE_FILTER_FN[k](v.sub.contribution))).map(([k, label]) => ({
                          value: k,
                          label,
                          meta: fmtNum(views.filter((v) => QUEUE_FILTER_FN[k](v.sub.contribution)).length),
                        })),
                        onChange: (v) => setFilter(v as QueueFilter),
                      },
                      ...(kbOptions.length > 1 || kb
                        ? [{ title: "Collection", value: resourceId(kb), options: [{ value: "", label: "All collections" }, ...kbOptions.map(([value, label]) => ({ value, label }))], onChange: setKb }]
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
              <Checkbox isSelected={n === ids.length} isIndeterminate={n < ids.length} onChange={toggleAll} aria-label="Select all">
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <span className="checkbox__label">{n === ids.length ? "All selected" : "Select all"}</span>
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
          ) : (
            <div className="cur-queue__none">
              <NoMatches what="submissions" onClear={clearFilters} />
            </div>
          )}
        </div>
        {cur ? (
          <>
            <DocPane key={`pane-${cur.name}`} view={cur} />
            <Inspector
              key={cur.name}
              view={cur}
              pos={pos}
              total={rows.length}
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
          Decline…
        </Button>
        <Button variant="secondary" size="sm" onPress={bulkApprove}>
          <Check className="i" aria-hidden />
          Approve & publish
        </Button>
      </BulkBar>
      <DecideDialog request={decide} onClose={() => setDecide(null)} onSubmit={submitDecide} />
      <CompareDrawer
        submission={compare?.sub ?? null}
        related={compare?.related ?? ""}
        contributor={compare ? (memberNames.get(compare.sub.contribution.contributor ?? "") ?? "") : ""}
        baseName={compare ? (baseNames.get(targetOf(compare.sub.contribution)) ?? "") : ""}
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
        <Checkbox isSelected={checked} onChange={onCheck} aria-label={`Select ${v.title}`}>
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
            {v.via ? <SourceName source={c.source} /> : v.contributor} · {relLow(lastEvent(c).at)}
          </span>
        </span>
        <span className="cur-item__meta">
          <span className="truncate" translate="no">
            {v.baseName}
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
                  <span className="cur-flag cur-flag--accent" title="Suggests a new topic" role="img" aria-label="Suggests a new topic">
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
