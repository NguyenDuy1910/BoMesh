"use client";

import { Button, Checkbox, Kbd } from "@heroui/react";
import { Check, CircleCheck } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EmptyState, ErrorState, FileIcon, FilterButton, NoMatches, SearchInput, SkeletonRows, toast } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { LifecycleChip } from "@/modules/knowledge/components/LifecycleChip";
import { SourceIcon } from "@/modules/knowledge/components/SourceIcon";
import { fold } from "@/modules/knowledge/model";
import { useKnowledgeModel, useMemberNames } from "@/modules/knowledge/queries";

import { approveContribution, createIngestionRun, rejectContribution, requestContributionChanges } from "../api";
import { flushDecisions, holdDecision, useHeldDecisions } from "../decisions";
import { DOCS_BASE, FLAG_META, flagsOf, hasFlag, isAnalyzing, lastEvent, QUEUE_FILTER_FN, QUEUE_FILTERS, suggestedKind, targetOf, type QueueFilter } from "../model";
import { useAllTopics, useInvalidateCuration, useReviewableBases, useReviewQueue, type Submission } from "../queries";
import { CompareDrawer } from "./CompareDrawer";
import { SourceName } from "./parts";
import { DecideDialog, type DecideRequest } from "./DecideDialog";
import { ReviewDetail } from "./ReviewDetail";
import type { Draft, SubView } from "./review-types";

const relLow = (at: string) => rel(at).replace(/^(Just now|Yesterday)$/, (m) => m.toLowerCase());


/** Review (preview `reviewTab`): the queue and the decision on the open submission. */
export function ReviewTab() {
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
  const [kb, setKb] = useState(params.get("kb") ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [decide, setDecide] = useState<(DecideRequest & { names: string[] }) | null>(null);
  const [compare, setCompare] = useState<{ sub: Submission; related: string } | null>(null);

  // Decisions still in their Undo window are sent when leaving the tab.
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
      next.set("tab", "review");
      if (id) next.set("sel", id);
      else next.delete("sel");
      router.replace(`${pathname}?${next}`, { scroll: false });
    },
    [params, pathname, router],
  );
  const listRef = useRef<HTMLDivElement>(null);
  const pick = useCallback(
    (id: string) => {
      setSel(id);
      requestAnimationFrame(() => {
        listRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
        const detail = document.getElementById("cur-detail");
        if (detail && detail.getBoundingClientRect().top < 0) detail.scrollIntoView({ block: "start" });
      });
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

  /* ── Drafts ── */
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
      kb: c.kind === "NEW_REVISION" ? c.targetCollection ?? "" : targetOf(c),
      summary: c.suggestions?.summary ?? "",
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
    if (subs.some((v) => v.id === cur?.id)) setSel(next?.id ?? "");
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

  const approveOne = async (v: SubView, d: Draft) => {
    const c = v.sub.contribution;
    const revision = c.kind === "NEW_REVISION";
    await approveContribution(ws, v.name, {
      etag: c.etag ?? "",
      targetCollection: revision ? undefined : d.kb || undefined,
      documentType: d.kind,
      topics: d.topics,
      summary: d.summary.trim() || undefined,
    });
    // Approval never processes; publishing is an explicit run on the published document.
    const target = revision ? c.replacesItem : v.sub.item?.name;
    if (target) {
      await createIngestionRun(ws, [target]).catch(() => toast(`Approved “${v.title}”, but publishing didn’t start. Use Publish now in All documents.`, { tone: "warning" }));
    }
  };

  const approve = (v: SubView) => {
    const d = draftOf(v);
    if (!d) return;
    const c = v.sub.contribution;
    const msg = c.kind === "NEW_REVISION" ? `Approved. “${v.title}” is publishing as a new version.` : `Approved “${v.title}”. Publishing to ${baseNames.get(d.kb) || "its knowledge base"}.`;
    run([v], (x) => approveOne(x, d), msg);
  };

  const bulkApprove = () => {
    const subs = views.filter((v) => picked.includes(v.name));
    const personal = subs.filter((v) => !v.analyzing && hasFlag(v.sub.contribution, "personal"));
    const busy = subs.filter((v) => v.analyzing);
    const noBase = subs.filter((v) => !busy.includes(v) && !personal.includes(v) && !draftOf(v)?.kb && v.sub.contribution.kind !== "NEW_REVISION");
    const ok = subs.filter((v) => !personal.includes(v) && !busy.includes(v) && !noBase.includes(v));
    const skipped = [
      personal.length && `${personal.length} with personal data`,
      busy.length && `${busy.length} still being analyzed`,
      noBase.length && `${noBase.length} without a knowledge base`,
    ]
      .filter(Boolean)
      .join(" and ");
    if (!ok.length) {
      toast(`Nothing published: ${skipped || "select submissions first"}. Review ${personal.length + busy.length + noBase.length === 1 ? "it" : "them"} one by one.`, { tone: "danger" });
      return;
    }
    const decisions = new Map(ok.map((v) => [v.name, draftOf(v)!]));
    run(ok, (x) => approveOne(x, decisions.get(x.name)!), `Approved ${plural(ok.length, "document")}${skipped ? ` · skipped ${skipped}` : ""}`);
    // Keep the skipped ones selected so they're easy to find.
    setSelected(new Set([...personal, ...busy, ...noBase].map((v) => v.name)));
  };

  const openDecide = (mode: "changes" | "decline", subs: SubView[]) => {
    if (!subs.length) return;
    setDecide({ mode, names: subs.map((v) => v.name), titles: subs.map((v) => v.title), contributor: subs.length === 1 ? subs[0].contributor || undefined : undefined });
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
      <div className="cur-split">
        <div className="cur-queue">
          <SkeletonRows rows={6} />
        </div>
        <div className="cur-detail">
          <SkeletonRows rows={3} />
        </div>
      </div>
    );
  }
  if (queue.isError) return <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />;
  if (!views.length) {
    return (
      <EmptyState
        icon={CircleCheck}
        tone="success"
        boxed
        title="You’re all caught up"
        description="New submissions to your knowledge bases show up here."
        actions={
          <Button variant="secondary" onPress={() => router.push(`${DOCS_BASE}?tab=all`)}>
            See all documents
          </Button>
        }
      />
    );
  }

  const kbOptions = [...new Set(views.map((v) => v.base).filter(Boolean))].map((b) => ({ value: resourceId(b), label: baseNames.get(b) || "Knowledge base" }));
  const ids = rows.map((v) => v.name);
  const n = ids.filter((id) => picked.includes(id)).length;
  const toggleAll = (on: boolean) => setSelected(on ? new Set([...picked, ...ids]) : new Set(picked.filter((id) => !ids.includes(id))));
  const curDraft = draftOf(cur);

  return (
    <div className={`cur-split${open ? " has-sel" : ""}`}>
      <div className="cur-queue">
        <div className="cur-queue__tools">
          <SearchInput value={q} onChange={setQ} placeholder="Search submissions" fullWidth />
          <div className="cur-fchips" role="group" aria-label="Show">
            {QUEUE_FILTERS.map(([k, label]) => (
              <button key={k} type="button" className="cur-fchip" aria-pressed={filter === k} onClick={() => setFilter(k)}>
                {label}
                <span className="cur-fchip__n num">{views.filter((v) => QUEUE_FILTER_FN[k](v.sub.contribution)).length}</span>
              </button>
            ))}
          </div>
          {kbOptions.length > 1 ? (
            <div className="row gap-6">
              <FilterButton label="Knowledge base" options={kbOptions} value={resourceId(kb)} onChange={setKb} />
            </div>
          ) : null}
        </div>
        <div className="cur-queue__sel">
          <Checkbox isSelected={!!n && n === ids.length} isIndeterminate={!!n && n < ids.length} onChange={toggleAll} aria-label="Select all">
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              <span className="checkbox__label">{n ? <span className="medium">{n} selected</span> : <span className="muted">{plural(rows.length, "submission")}</span>}</span>
            </Checkbox.Content>
          </Checkbox>
          <span className="grow" />
          {n ? (
            <>
              <Button variant="ghost" size="sm" onPress={() => openDecide("decline", views.filter((v) => picked.includes(v.name)))}>
                Decline…
              </Button>
              <Button variant="secondary" size="sm" onPress={bulkApprove}>
                <Check className="i" aria-hidden />
                Approve & publish
              </Button>
            </>
          ) : (
            <span className="t-xs muted cur-keys">
              <Kbd>J</Kbd>
              <Kbd>K</Kbd> to move
            </span>
          )}
        </div>
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
            <NoMatches
              what="submissions"
              onClear={() => {
                setQ("");
                setFilter("all");
                setKb("");
              }}
            />
          </div>
        )}
      </div>
      {cur ? (
        <ReviewDetail
          key={cur.name}
          view={cur}
          pos={pos}
          total={rows.length}
          draft={curDraft}
          setDraft={(patch) => setDraft(cur, patch)}
          topics={topics.data ?? []}
          bases={bases.data.filter((b) => b.collection?.acceptsContributions !== false || b.name === curDraft?.kb).map((b) => ({ name: b.name ?? "", displayName: b.displayName ?? "" }))}
          baseNames={baseNames}
          memberNames={memberNames}
          canManageTaxonomy={can("topics.create")}
          onStep={step}
          onBack={() => setSel("")}
          onApprove={() => approve(cur)}
          onChanges={() => openDecide("changes", [cur])}
          onDecline={() => openDecide("decline", [cur])}
          onCompare={(related) => setCompare({ sub: cur.sub, related })}
        />
      ) : (
        <div className="cur-detail" />
      )}
      <DecideDialog request={decide} onClose={() => setDecide(null)} onSubmit={submitDecide} />
      <CompareDrawer
        submission={compare?.sub ?? null}
        related={compare?.related ?? ""}
        contributor={compare ? (memberNames.get(compare.sub.contribution.contributor ?? "") ?? "") : ""}
        baseName={compare ? (baseNames.get(targetOf(compare.sub.contribution)) ?? "") : ""}
        onClose={() => setCompare(null)}
      />
    </div>
  );
}

function QueueItem({ view: v, active, checked, onCheck, onPick }: { view: SubView; active: boolean; checked: boolean; onCheck: (on: boolean) => void; onPick: () => void }) {
  const c = v.sub.contribution;
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
              v.flags.filter((f, i, all) => all.findIndex((x) => x.type === f.type) === i).map((f, i) => {
                const meta = FLAG_META[f.type];
                const Icon = meta.icon;
                return (
                  <span key={i} className={`cur-flag cur-flag--${meta.tone}`} title={meta.tip} role="img" aria-label={meta.tip}>
                    <Icon className="i i-xs" aria-hidden />
                  </span>
                );
              })
            )}
          </span>
        </span>
      </span>
    </div>
  );
}
