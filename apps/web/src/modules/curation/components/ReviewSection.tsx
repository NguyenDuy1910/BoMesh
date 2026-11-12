"use client";

import { Button } from "@heroui/react";
import { ArrowRight, CircleCheck } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

import { EmptyState, PageHeader, SkeletonRows } from "@/components/ui";
import { fmtNum } from "@/lib/format";

import { QUEUE_GROUPS, QUEUE_IDS, QUEUES, resolveQueue, studioHref, type QueueCounts, type QueueId } from "../model";
import { useReviewQueueCounts } from "../queries";
import { DemoChip, LinkButton, PlainSelect } from "./parts";
import { DetailsQueue } from "./review/DetailsQueue";
import { DuplicatesQueue } from "./review/DuplicatesQueue";
import { ProblemsQueue } from "./review/ProblemsQueue";
import { ReverifyQueue } from "./review/ReverifyQueue";
import { SubmissionsQueue } from "./review/SubmissionsQueue";

/**
 * Knowledge Studio → Review (preview `reviewTab`): one workbench for everything that needs a person. A queue
 * chooser (To publish · To keep right) picks the open queue with `?queue=`; the default is the first queue with
 * items. No header action: the decision bar is the primary.
 */
export function ReviewSection() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const counts = useReviewQueueCounts();

  const query = { queue: params.get("queue"), seg: params.get("seg"), tab: params.get("tab"), sel: params.get("sel") };
  const id = counts.data ? resolveQueue(query, counts.data) : null;
  const legacy = !!query.seg || query.queue === "quality" || query.queue === "review";

  // `?queue=quality` / `?seg=` land on the queue they mean, so the chooser and Back agree.
  useEffect(() => {
    if (!legacy || !id) return;
    const next = new URLSearchParams(params.toString());
    next.set("queue", id);
    next.delete("seg");
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }, [legacy, id, params, pathname, router]);

  const header = <PageHeader title="Review" chips={<DemoChip />} />;

  if (!counts.data || !id) {
    return (
      <>
        {header}
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
      </>
    );
  }

  const c = counts.data;
  if (!QUEUE_IDS.some((k) => c[k]) && !query.queue) {
    return (
      <>
        {header}
        <EmptyState
          icon={CircleCheck}
          tone="success"
          boxed
          title="You’re all caught up"
          description="Submissions, publishing problems and quality checks show up here."
          actions={<LinkButton href={studioHref("documents")} variant="secondary">See all documents</LinkButton>}
        />
      </>
    );
  }

  const pick = (q: QueueId) => {
    const next = new URLSearchParams(params.toString());
    next.set("tab", "review");
    next.set("queue", q);
    next.delete("sel");
    next.delete("seg");
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };
  const kb = params.get("kb") ?? "";
  const done = <QueueDone id={id} counts={c} onNext={pick} />;

  return (
    <>
      {header}
      <QueueChooser current={id} counts={c} onPick={pick} />
      {id === "submissions" ? (
        <SubmissionsQueue kb={kb} done={done} />
      ) : id === "problems" ? (
        <ProblemsQueue kb={kb} done={done} />
      ) : id === "reverify" ? (
        <ReverifyQueue />
      ) : id === "details" ? (
        <DetailsQueue />
      ) : (
        <DuplicatesQueue />
      )}
    </>
  );
}

/**
 * The queue chooser (preview `chooser`): pills in two labelled groups with their counts (To publish counts are
 * decisions and stand out; To keep right counts are quiet). Empty queues hide unless open; one select on phones;
 * hidden with a single queue.
 */
function QueueChooser({ current, counts, onPick }: { current: QueueId; counts: QueueCounts; onPick: (q: QueueId) => void }) {
  const shown = QUEUES.filter((q) => counts[q.id] || q.id === current);
  if (shown.length < 2) return null;
  return (
    <div className="rq">
      <div className="rq__groups">
        {QUEUE_GROUPS.map(([g, label]) => {
          const items = shown.filter((q) => q.group === g);
          if (!items.length) return null;
          return (
            <div key={g} className="rq__group" role="group" aria-labelledby={`rq-${g}`}>
              <span className="rq__label" id={`rq-${g}`}>
                {label}
              </span>
              <div className="rq__pills">
                {items.map((q) => {
                  const n = counts[q.id];
                  return (
                    <button
                      key={q.id}
                      type="button"
                      className={`rq__pill${n && g === "publish" ? " rq__pill--due" : ""}`}
                      aria-pressed={q.id === current}
                      onClick={() => onPick(q.id)}
                    >
                      {q.label}
                      {n ? <span className="rq__n num">{fmtNum(n)}</span> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <PlainSelect
        label="Review queue"
        className="rq__select"
        value={current}
        options={shown.map((q) => [q.id, counts[q.id] ? `${q.label} · ${fmtNum(counts[q.id])}` : q.label] as const)}
        onChange={(v) => v && onPick(v as QueueId)}
      />
    </div>
  );
}

const DONE_COPY: Readonly<Partial<Record<QueueId, readonly [string, string]>>> = {
  submissions: ["You’re all caught up", "New submissions to your collections show up here."],
  problems: ["Everything approved is published", "Documents that couldn’t publish or changed at their source show up here with their fix."],
};

/** A queue that's done: say so, and point at the next queue with something in it (preview `queueDone`). */
function QueueDone({ id, counts, onNext }: { id: QueueId; counts: QueueCounts; onNext: (q: QueueId) => void }) {
  const next = QUEUES.find((q) => q.id !== id && counts[q.id]);
  const [title, desc] = DONE_COPY[id] ?? DONE_COPY.submissions!;
  return (
    <EmptyState
      icon={CircleCheck}
      tone="success"
      boxed
      title={title}
      description={desc}
      actions={
        next ? (
          <Button variant="secondary" onPress={() => onNext(next.id)}>
            <ArrowRight className="i" aria-hidden />
            {`Next: ${next.label}`}
          </Button>
        ) : (
          <LinkButton href={studioHref("documents")} variant="secondary">
            See all documents
          </LinkButton>
        )
      }
    />
  );
}
