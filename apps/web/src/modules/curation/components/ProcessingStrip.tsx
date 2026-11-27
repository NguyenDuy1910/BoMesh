"use client";

import { Button, Spinner } from "@heroui/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { ProgressBar, Tip, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { fmtNum, plural } from "@/lib/format";
import { useKnowledgeModel } from "@/modules/knowledge/queries";
import { conceptLabel } from "@/modules/knowledge/taxonomy";

import { cancelIngestionRun, getIngestionRun, type IngestionRun } from "../api";
import { docsHref } from "../model";
import { useActiveRuns, useInvalidateCuration } from "../queries";

/**
 * A processing run in flight (preview `processStrip`, Documents → All and Processing): where its documents are (processed,
 * in progress, waiting, failed — the run's own counts), the classification it works with, Show them (All only: on
 * Processing the documents are the rows below) and Stop. It is just the workspace's active run, so a reload picks it up
 * again; when a run ends, a toast reports it (failures: Open Processing).
 */
export function ProcessingStrip({ showThem = true }: { showThem?: boolean }) {
  const router = useRouter();
  const runs = useActiveRuns();
  const invalidate = useInvalidateCuration();
  const { taxonomy } = useKnowledgeModel();
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
      toast(failed ? `Đã xử lý ${plural(ok, "document")} · ${fmtNum(failed)} không xử lý được` : `Đã xử lý ${plural(ok, "document")}`, {
        tone: failed ? "accent" : "success",
        action: failed ? { label: "Mở mục “Đang xử lý”", onPress: () => router.push(docsHref("processing", { state: "failed" })) } : undefined,
      });
    }
  }, [runs.data, invalidate, router]);

  const run = runs.data?.[0];
  if (!run?.name) return null;
  const c = run.counts ?? {};
  const total = c.totalCount ?? 0;
  const done = c.succeededCount ?? 0;
  const failed = c.failedCount ?? 0;
  const where = [`${fmtNum(done)} đã xử lý`, c.runningCount ? `${fmtNum(c.runningCount)} đang xử lý` : "", c.queuedCount ? `${fmtNum(c.queuedCount)} đang chờ` : "", failed ? `${fmtNum(failed)} lỗi` : ""].filter(Boolean);
  const pct = Math.round(((done + failed) / Math.max(1, total)) * 100);
  const concepts = run.classification?.concepts ?? [];
  const note = run.classification?.note ?? "";
  const context = concepts.length ? `Đang phân loại theo ${plural(concepts.length, "concept")} bạn đã chọn${note ? ", kèm ngữ cảnh của bạn" : ""}` : note ? "Đang phân loại kèm ngữ cảnh của bạn" : "";
  const contextTip = concepts.length ? concepts.map((c) => conceptLabel(taxonomy, c)).join(", ") : note;

  const stop = async () => {
    const name = run.name ?? "";
    setStopping(true);
    try {
      await cancelIngestionRun(name);
      stopped.current.add(name);
      invalidate();
      toast("Đã dừng xử lý. Phần đã xong vẫn giữ trạng thái Đã xử lý; phần còn lại trở về Chưa xử lý.", { tone: "accent" });
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
          <span className="medium">{`Đang xử lý ${plural(total, "document")}`}</span>
          <span className="muted">{[...where, `${pct}%`].join(" · ")}</span>
          {context ? (
            <Tip content={contextTip}>
              <span className="muted">{context}</span>
            </Tip>
          ) : null}
        </div>
        <ProgressBar value={pct} label="Tiến độ xử lý" />
      </div>
      {showThem ? (
        <Button variant="ghost" size="sm" onPress={() => router.push(docsHref("all", { processing: "processing" }))}>
          Xem các tài liệu này
        </Button>
      ) : null}
      <Button variant="ghost" size="sm" isDisabled={stopping} onPress={() => void stop()}>
        Dừng
      </Button>
    </div>
  );
}
