"use client";

import { Button, Spinner } from "@heroui/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { ProgressBar, Tip, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { fmtNum, plural } from "@/lib/format";
import { useKnowledgeModel } from "@/modules/knowledge/queries";

import { cancelIngestionRun, getIngestionRun, type IngestionRun } from "../api";
import { docsHref } from "../model";
import { useActiveRuns, useInvalidateCuration } from "../queries";

/**
 * A processing run in flight (preview `processStrip`, Documents → All and Issues): how far it is from the run's own
 * counts, the classification it works with, Show them (All filtered to Processing) and Stop. It is just the
 * workspace's active run, so a reload picks it up again; when a run ends, a toast reports it (failures: See issues).
 */
export function ProcessingStrip() {
  const router = useRouter();
  const runs = useActiveRuns();
  const invalidate = useInvalidateCuration();
  const { ctx } = useKnowledgeModel();
  const [stopping, setStopping] = useState(false);
  const seen = useRef<readonly string[] | null>(null);
  const stopped = useRef(new Set<string>());

  // A run that left the active list has ended: refresh the documents, then say how it went.
  useEffect(() => {
    if (!runs.data) return;
    const now = runs.data.map((r) => r.name ?? "");
    const ended = (seen.current ?? []).filter((n) => !now.includes(n) && !stopped.current.has(n));
    seen.current = now;
    if (!ended.length) return;
    invalidate();
    for (const name of ended) void getIngestionRun(name).then(reportEnd, () => undefined);
    function reportEnd(r: IngestionRun) {
      if (r.state === "CANCELLED") return;
      const ok = r.counts?.succeededCount ?? 0;
      const failed = r.counts?.failedCount ?? 0;
      toast(failed ? `Processed ${plural(ok, "document")} · ${fmtNum(failed)} failed` : `Processed ${plural(ok, "document")}`, {
        tone: failed ? "accent" : "success",
        action: failed ? { label: "See issues", onPress: () => router.push(docsHref("issues")) } : undefined,
      });
    }
  }, [runs.data, invalidate, router]);

  const run = runs.data?.[0];
  if (!run?.name) return null;
  const c = run.counts ?? {};
  const total = c.totalCount ?? 0;
  const done = c.succeededCount ?? 0;
  const failed = c.failedCount ?? 0;
  const pct = Math.round(((done + failed) / Math.max(1, total)) * 100);
  const topics = run.classification?.topics ?? [];
  const note = run.classification?.note ?? "";
  const context = topics.length ? `Classifying against ${plural(topics.length, "topic")} you chose${note ? ", with your context" : ""}` : note ? "Classifying with your context" : "";
  const contextTip = topics.length ? topics.map((t) => ctx.topicNames?.get(t) ?? "Untitled topic").join(", ") : note;

  const stop = async () => {
    const name = run.name ?? "";
    setStopping(true);
    try {
      await cancelIngestionRun(name);
      stopped.current.add(name);
      invalidate();
      toast("Stopped processing. What’s done stays processed; the rest is Not processed again.", { tone: "accent" });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="proc-strip" role="status">
      <Spinner size="sm" />
      <div className="proc-strip__main">
        <div className="proc-strip__text">
          <span className="medium">{`Processing ${plural(total, "document")}`}</span>
          <span className="muted">{`${fmtNum(done)} processed${failed ? ` · ${fmtNum(failed)} failed` : ""} · ${pct}%`}</span>
          {context ? (
            <Tip content={contextTip}>
              <span className="muted">{context}</span>
            </Tip>
          ) : null}
        </div>
        <ProgressBar value={pct} label="Processing progress" />
      </div>
      <Button variant="ghost" size="sm" onPress={() => router.push(docsHref("all", { processing: "processing" }))}>
        Show them
      </Button>
      <Button variant="ghost" size="sm" isDisabled={stopping} onPress={() => void stop()}>
        Stop
      </Button>
    </div>
  );
}
