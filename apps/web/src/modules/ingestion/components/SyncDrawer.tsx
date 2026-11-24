"use client";

import { Button, Card, Spinner } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { CircleCheck, CircleX, Clock, History, RotateCcw, Square, TriangleAlert, type LucideIcon } from "lucide-react";
import clsx from "clsx";

import { Callout, EmptyState, FileIcon, List, ListItem, SkeletonRows, StatusChip, toast } from "@/components/ui";
import { fmtDateTime, fmtDuration, fmtNum, plural } from "@/lib/format";
import { serverText } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";

import type { SourceActions } from "../actions";
import { getSync, type Connection, type Source, type Sync } from "../api";
import { appName, isReviewFirst, sourceName, syncDuration, syncStatus, syncTotals, TRIGGER_LABEL } from "../model";
import { openReconnect } from "../overlays";
import { ingestionKeys, useSource } from "../queries";
import { Sheet, SheetSection } from "./Sheet";
import { SourceAppIcon, useParamState } from "./shared";

type StepState = "done" | "warn" | "failed" | "pending" | "active" | "stopped";
interface Step {
  label: string;
  state: StepState;
  note: string;
  ms?: number;
}

const STEP_ICON: Record<Exclude<StepState, "active">, LucideIcon> = { done: CircleCheck, warn: TriangleAlert, failed: CircleX, pending: Clock, stopped: Square };

/**
 * The steps of a sync, from what the API reports: a sync finds and registers
 * changes; making them searchable is a separate processing run, so the last
 * step reflects what the source still has waiting or in review.
 */
function syncSteps(sync: Sync, source: Source | undefined, app: string): Step[] {
  const t = syncTotals(sync);
  const changed = t.added + t.updated + t.removed;
  const elapsed = syncDuration(sync);
  if (sync.state === "FAILED" && !changed && !t.failed) {
    return [
      { label: "Tìm thay đổi", state: "failed", note: `Không mở được ${app}`, ms: elapsed },
      { label: "Đọc tài liệu", state: "pending", note: "Chưa bắt đầu" },
      { label: "Cho phép tra cứu", state: "pending", note: "Chưa bắt đầu" },
    ];
  }
  if (sync.state === "RUNNING") {
    return [
      { label: "Tìm thay đổi", state: "active", note: `Đã tìm thấy ${plural(changed + t.failed, "tài liệu đã thay đổi")} cho đến nay` },
      { label: "Đọc tài liệu", state: changed ? "active" : "pending", note: `Đã đọc ${t.added + t.updated}` },
      { label: "Cho phép tra cứu", state: "pending", note: "Đang chờ" },
    ];
  }
  const waiting = source?.pendingDocumentCount ?? 0;
  const review = source?.inReviewCount ?? 0;
  const last = !source
    ? "Đã ngắt kết nối nguồn dữ liệu"
    : review && isReviewFirst(source)
      ? `${plural(review, "document")} đang chờ duyệt`
      : waiting
        ? `${plural(waiting, "document")} đang chờ xử lý`
        : `${fmtNum(t.added + t.updated)} sẵn sàng cho câu hỏi`;
  return [
    { label: "Tìm thay đổi", state: "done", note: `Đã tìm thấy ${plural(changed + t.failed, "tài liệu đã thay đổi")}` },
    { label: "Đọc tài liệu", state: t.failed ? "warn" : "done", note: `Đã đọc ${t.added + t.updated}${t.failed ? ` · Không đọc được ${t.failed}` : ""}`, ms: elapsed },
    { label: "Cho phép tra cứu", state: waiting || (review && source && isReviewFirst(source)) ? "pending" : "done", note: last },
  ];
}

/** The sync drawer (preview `DR['src-run']`), opened by `?sync=<source id>.<sync id>`. */
export function SyncDrawer({ param, connections, actions }: { param: string | null; connections: ReadonlyMap<string, Connection>; actions: SourceActions }) {
  const { id, name: workspace, can } = useWorkspace();
  const { set } = useParamState();
  const [sourceId = "", syncId = ""] = (param ?? "").split(".");
  const syncName = param ? `${workspace}/sources/${sourceId}/syncs/${syncId}` : "";
  const query = useQuery({
    queryKey: [...ingestionKeys.syncs(id, sourceId), "one", syncId],
    queryFn: () => getSync(id, syncName),
    enabled: !!param,
    retry: false,
    refetchInterval: (q) => (q.state.data?.state === "RUNNING" ? 3000 : false),
  });
  const sourceQuery = useSource(param ? `${workspace}/sources/${sourceId}` : null);
  const close = () => set({ sync: null });

  if (!param) return <Sheet isOpen={false} onClose={close} title="">{null}</Sheet>;
  const sync = query.data;
  if (!sync) {
    return (
      <Sheet isOpen onClose={close} title={query.isError ? "Không tìm thấy lần đồng bộ" : "Đồng bộ"}>
        {query.isError ? <EmptyState icon={History} title="Lần đồng bộ này không còn khả dụng" /> : <SkeletonRows rows={5} />}
      </Sheet>
    );
  }

  const source = sourceQuery.data;
  const connection = source ? connections.get(source.connection) : undefined;
  const app = appName(connection?.connector);
  const manage = can("sources.create");
  const t = syncTotals(sync);
  const elapsed = syncDuration(sync);
  const status = syncStatus(sync);
  const who = sync.trigger ? TRIGGER_LABEL[sync.trigger] : "";

  let top = null;
  if (sync.state === "FAILED")
    top = (
      <Callout
        tone="danger"
        title={`Không kết nối được tới ${app}`}
        description={sync.error?.message ? serverText(sync.error.message) : "Lần đồng bộ đã dừng trước khi hoàn tất."}
        actions={
          connection && connection.state !== "ACTIVE" && manage ? (
            <Button size="sm" variant="primary" onPress={() => openReconnect(connection.name ?? "")}>
              Kết nối lại
            </Button>
          ) : null
        }
      />
    );
  if (sync.state === "RUNNING")
    top = (
      <Card variant="secondary" className="src-live">
        <span className="medium">{plural(t.added + t.updated, "document")} cho đến nay</span>
      </Card>
    );

  const tiles: ["added" | "updated" | "failed" | "removed", string, number][] = [
    ["added", "Đã thêm", t.added],
    ["updated", "Đã cập nhật", t.updated],
    ["failed", "Lỗi", t.failed],
  ];
  if (t.removed) tiles.push(["removed", "Đã gỡ", t.removed]);

  const failures = sync.failures ?? [];
  const syncing = source?.lastSync?.state === "RUNNING";
  const retry = async () => {
    if (!source) return;
    const next = await actions.syncNow(source);
    if (!next) return;
    toast(`Đang thử lại ${plural(failures.length, "document")}…`, { tone: "accent" });
    set({ sync: `${sourceId}.${next.name?.split("/").pop() ?? ""}` });
  };

  return (
    <Sheet
      isOpen
      onClose={close}
      lead={<SourceAppIcon source={source} connections={connections} size="lg" />}
      title={source ? sourceName(source) : "Đã gỡ nguồn dữ liệu"}
      description={`${fmtDateTime(sync.startTime)}${who ? ` · ${who}` : ""}`}
      footer={
        source ? (
          <>
            <Button variant="secondary" onPress={() => set({ sync: null, open: sourceId })}>
              Mở bản gốc
            </Button>
            {manage && failures.length ? (
              <Button variant="primary" isDisabled={syncing} onPress={() => void retry()}>
                <RotateCcw className="i" aria-hidden />
                Thử lại mục lỗi
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      <section className="drawer__section">
        <div className="row gap-8 wrap mb-16">
          <StatusChip kind="run" value={status} />
          {sync.state !== "RUNNING" && elapsed ? <span className="t-sm muted">Mất {fmtDuration(elapsed)}</span> : null}
        </div>
        {top ? <div className="mb-16">{top}</div> : null}
        {sync.state === "RUNNING" ? null : (
          <div className="src-counts">
            {tiles.map(([key, label, n]) => (
              <div key={key} className="src-counts__tile">
                <div className={clsx("src-counts__n num", key === "failed" && n && "text-danger")}>{fmtNum(n)}</div>
                <div className="t-xs muted">{label}</div>
              </div>
            ))}
          </div>
        )}
      </section>
      <SheetSection title="Các bước">
        <ol className="src-timeline">
          {syncSteps(sync, source, app).map((step) => {
            const Icon = step.state === "active" ? null : STEP_ICON[step.state];
            return (
              <li key={step.label} className={`src-timeline__step src-timeline__step--${step.state}`}>
                <span className="src-timeline__icon">{Icon ? <Icon className="i i-sm" aria-hidden /> : <Spinner size="sm" />}</span>
                <div className="grow">
                  <div className="medium">{step.label}</div>
                  <div className="description">{step.note}</div>
                </div>
                {step.ms && step.ms >= 1000 ? <span className="t-xs muted num">{fmtDuration(step.ms)}</span> : null}
              </li>
            );
          })}
        </ol>
      </SheetSection>
      {failures.length ? (
        <SheetSection title="Không đọc được">
          <List>
            {failures.map((f, i) => (
              <ListItem key={`${f.resourceId}-${i}`} lead={<FileIcon name={f.displayName} size="sm" />} title={f.displayName || f.resourceId || "Tệp"} contentTitle description={f.message ? serverText(f.message) : "Không đọc được tệp này."} />
            ))}
          </List>
        </SheetSection>
      ) : null}
    </Sheet>
  );
}
