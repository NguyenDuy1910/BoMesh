"use client";

import { Button } from "@heroui/react";
import {
  Archive,
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  EyeOff,
  File as FileGlyph,
  History,
  LoaderCircle,
  Minus,
  Pencil,
  RefreshCw,
  Upload,
  type LucideIcon,
} from "lucide-react";
import NextLink from "next/link";
import type { ReactNode } from "react";

import { Callout, Disclosure, EmptyState, FileIcon, ItemIcon, KeyValue, type Tone } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { fmtDateTime, fmtSize, plural, rel } from "@/lib/format";
import { ConceptsByScheme, DocumentFacts } from "@/modules/knowledge/components/ConceptsByScheme";
import { LifecycleChip } from "@/modules/knowledge/components/LifecycleChip";
import { ResourceDetails } from "@/modules/knowledge/components/ResourceDetails";
import { DOC_TYPES } from "@/modules/knowledge/model";
import { useKnowledgeModel, useMemberNames, useSource } from "@/modules/knowledge/queries";
import { acceptedConcepts, conceptLabel, docAssignments } from "@/modules/knowledge/taxonomy";

import { useCollectionLabels } from "../collectionLabels";
import { changedAtSource, inSearch, isCandidate } from "../lifecycle";
import { isLocked, opsFor, processOp, versionOf, type DocOp, type DocRow } from "../model";
import { procStepAt, procSteps, PROC_STEPS } from "../processingSteps";
import { useActiveTasks, useCollectionAudience, useRunTask } from "../queries";
import { TaskSteps } from "./ProcessingSteps";
import { serverText } from "@/lib/i18n";
import { CurationDrawer } from "./CurationDrawer";
import { ActionsMenu } from "./shared";
import { OP_META, useDocOps } from "./useDocOps";

const EVENTS: Readonly<Record<string, [LucideIcon, string, Tone | undefined]>> = {
  SUBMITTED: [Upload, "Đã gửi", undefined],
  RESUBMITTED: [Upload, "Đã gửi lại", undefined],
  CHANGES_REQUESTED: [Pencil, "Cần chỉnh sửa", "warning"],
  REJECTED: [CircleX, "Đã từ chối", "danger"],
  APPROVED: [CircleCheck, "Đã duyệt", "success"],
  WITHDRAWN: [Archive, "Đã rút lại", undefined],
};

/**
 * One document (preview `DR['cur-doc']`): the lifecycle chip and its one note, its progress (Received → Processed →
 * Reviewed → Published → Searchable: a submission is processed before review; otherwise publication and processing are
 * independent, Searchable needs both; while its run task is in flight, Processed shows its five steps), History,
 * Details; the state's fix in the footer.
 */
export function DocumentDrawer({ row, onClose, contributorName }: { row: DocRow | null; onClose: () => void; contributorName: string }) {
  const ops = useDocOps();
  // A submission's target is often a folder: name it by its path.
  const labels = useCollectionLabels([row?.base]);
  if (!row) {
    return (
      <CurationDrawer isOpen={false} onClose={onClose} title="">
        {null}
      </CurationDrawer>
    );
  }
  const { main } = opsFor(row);
  const where = labels.get(row.base) || row.baseName;
  const meta = OP_META[main];
  const MainIcon = meta.icon;
  return (
    <CurationDrawer
      isOpen
      onClose={onClose}
      size="lg"
      lead={<FileIcon name={row.fileName} mime={row.mime} size="lg" />}
      title={<span translate="no">{row.title}</span>}
      description={<span translate="no">{where}</span>}
      headActions={<ActionsMenu actions={ops.menu(row, "drawer", onClose)} />}
      footer={
        <Button variant="primary" onPress={() => ops.run(main, row, onClose)}>
          <MainIcon className="i" aria-hidden />
          {meta.label}
        </Button>
      }
    >
      <DrawerBody row={row} where={where} contributorName={contributorName} onRun={(op) => ops.run(op, row, onClose)} />
    </CurationDrawer>
  );
}

interface Step {
  label: string;
  state: "done" | "current" | "issue" | "skipped" | "todo";
  busy?: boolean;
  text: string;
  at?: string;
  action?: ReactNode;
}

const STEP_ICON: Readonly<Record<Step["state"], [LucideIcon, string]>> = {
  done: [Check, "success"],
  current: [Clock, "accent"],
  issue: [CircleAlert, "warning"],
  skipped: [Minus, ""],
  todo: [CircleDashed, ""],
};
const STEP_SR: Readonly<Record<Step["state"], string>> = { done: "Xong", current: "Đang xử lý", issue: "Cần chú ý", skipped: "Đã bỏ qua", todo: "Chưa" };

function DrawerBody({ row, where, contributorName, onRun }: { row: DocRow; where: string; contributorName: string; onRun: (op: DocOp) => void }) {
  const { toResource, taxonomy } = useKnowledgeModel();
  const c = row.contribution;
  const events = (c?.events ?? []).filter((e) => e.kind !== "ANALYZED");
  const memberNames = useMemberNames([...events.map((e) => e.actor), c?.decision?.reviewer, row.item?.creator]);
  const source = useSource(row.source);
  const audience = useCollectionAudience(row.base);
  // Its run task: from the runs in flight, else (a failure) from its latest run.
  const live = useActiveTasks([row.id])?.get(row.id);
  const lastFailed = useRunTask(row.item?.document?.lastIngestionRun, row.id, { enabled: row.processing === "failed" && !live });
  const k = row.lifecycle;
  const ev = (kind: string) => [...events].reverse().find((e) => e.kind === kind);
  const by = (e: { actor?: string } | undefined) => (e?.actor && memberNames.get(e.actor) ? `do ${memberNames.get(e.actor)}` : "");
  const sourceName = source.data?.displayName || "một nguồn dữ liệu";
  const lastNote = [...events].reverse().find((e) => e.kind === "CHANGES_REQUESTED" || e.kind === "REJECTED");
  const rawIndexError = row.item?.document?.indexingError?.message;
  const indexError = rawIndexError ? serverText(rawIndexError) : undefined;
  const synced = !!row.source;
  const locked = isLocked(row.item);
  const resource = row.item ? toResource(row.item) : null;
  const published = !!row.item && row.publication === "published";

  // The chip names the state; one note says why and what fixes it (never a second title repeating the chip).
  const fixHint = locked ? (synced ? "Gỡ mật khẩu tại nguồn rồi đồng bộ lại." : "Thay tệp bằng bản sao không có mật khẩu.") : "";
  const note =
    row.processing === "failed" ? (
      <Callout tone="danger" description={(indexError || "Quá trình xử lý dừng giữa chừng. Hãy thử lại.") + (rawIndexError && /remove the password|copy without|sync again|try again/i.test(rawIndexError) ? "" : fixHint)} />
    ) : (k === "changes" || k === "rejected") && lastNote?.message ? (
      <blockquote className="cur-tl__text">
        “<span translate="no">{lastNote.message}</span>” — {memberNames.get(lastNote.actor ?? "") || "Một người duyệt"}
      </blockquote>
    ) : null;

  /* ── Progress: Received → Processed → Reviewed → Published → Searchable (a submission is processed before review) ── */
  const open = row.publication === "review" || row.publication === "changes";
  const kind = DOC_TYPES[row.type].label;
  // What the pipeline chose: a submission's candidate carries the assistant's classification for its reviewer; any other
  // document, what it's filed under.
  const candidate = isCandidate(c);
  const chosen = candidate ? docAssignments(taxonomy, row.assignments).map((a) => a.concept ?? "") : acceptedConcepts(docAssignments(taxonomy, row.assignments));
  const who = audience?.label ?? "Người đọc của kho tài liệu";
  const opButton = (op: DocOp | undefined) => {
    if (!op) return undefined;
    const { label, icon: Icon } = OP_META[op];
    return (
      <Button size="sm" variant="secondary" onPress={() => onRun(op)}>
        <Icon className="i" aria-hidden />
        {label}
      </Button>
    );
  };
  const received: Step = {
    label: "Đã nhận",
    state: "done",
    at: c?.createTime || row.item?.createTime,
    text: c?.origin === "MEMBER" ? `Do ${contributorName || "một thành viên"} gửi` : synced ? `Đồng bộ từ ${sourceName}` : `Do ${memberNames.get(row.item?.creator ?? "") || "một người chỉnh sửa"} tải lên`,
  };
  const approved = ev("APPROVED");
  const reviewed: Step =
    k === "analyzing" || k === "review"
      ? { label: "Đã duyệt", state: "current", text: "Đang chờ người duyệt" }
      : k === "changes"
        ? { label: "Đã duyệt", state: "issue", text: `Cần chỉnh sửa${by(ev("CHANGES_REQUESTED"))}`, at: ev("CHANGES_REQUESTED")?.createTime }
        : k === "rejected"
          ? { label: "Đã duyệt", state: "issue", text: `Đã từ chối${by(ev("REJECTED"))}`, at: ev("REJECTED")?.createTime }
          : approved
            ? { label: "Đã duyệt", state: "done", text: `Đã phê duyệt${by(approved)}`, at: approved.createTime }
            : { label: "Đã duyệt", state: "skipped", text: synced ? `Không cần: ${sourceName} tự động công bố` : "Không cần: do người chỉnh sửa của kho tài liệu thêm vào" };
  const publishedStep: Step =
    k === "merged"
      ? { label: "Đã công bố", state: "done", text: "Đã công bố thành phiên bản mới của tài liệu khác" }
      : row.publication === "published"
        ? { label: "Đã công bố", state: "done", text: who }
        : row.publication === "unpublished"
          ? { label: "Đã công bố", state: "issue", text: "Đã ngừng công bố · người đọc không thấy", action: resource?.editable ? opButton("republish") : undefined }
          : row.publication === "rejected"
            ? { label: "Đã công bố", state: "skipped", text: "Sẽ không được công bố" }
            : { label: "Đã công bố", state: "todo", text: `Sau khi duyệt · ${who} sẽ thấy tài liệu này` };
  // Processed: read → classified → indexed, in one line, with what the pipeline chose; while its run task is in flight
  // (or where it stopped), its five steps.
  const indexed = versionOf(row.item?.document?.indexedRevision) ?? versionOf(row.item?.document?.revision) ?? 1;
  const fix = processOp(row);
  const procBtn = opButton(fix === "process" || fix === "retry" || fix === "update" ? fix : undefined);
  const what = `${candidate ? "Đã phân loại để duyệt" : `v${indexed}`} · ${chosen.length ? `${kind} · ${chosen.map((n) => conceptLabel(taxonomy, n)).join(", ")}` : "không tìm thấy khái niệm"}`;
  const inFlight = live?.state === "QUEUED" || live?.state === "RUNNING";
  const task = live ?? lastFailed.data;
  const at = task ? procStepAt(procSteps(task)) : null;
  const taskSteps = task ? (
    <div className="proc-drawer-steps">
      <TaskSteps task={task} />
    </div>
  ) : undefined;
  const PROCESSED: Readonly<Record<DocRow["processing"], Omit<Step, "label">>> = {
    pending: { state: "todo", text: candidate ? "Chưa xử lý: hãy xử lý để trợ lý phân loại trước khi duyệt" : "Chưa xử lý: tìm kiếm và trợ lý chưa dùng được", action: procBtn },
    processing: { state: "current", busy: true, text: live?.state === "QUEUED" ? "Đang chờ bộ xử lý có chỗ trống" : at ? `Bước ${at.n}/${PROC_STEPS.length}` : "Đang đọc, phân loại và cho phép tra cứu…", action: taskSteps },
    ready: { state: "done", text: what },
    failed: {
      state: "issue",
      text: at ? `Lỗi ở bước ${at.label}: ${indexError || "dừng tại bước này"}` : indexError || "Quá trình xử lý dừng giữa chừng",
      action: (
        <>
          {taskSteps}
          {procBtn ? <div className="mt-8">{procBtn}</div> : null}
        </>
      ),
    },
    outdated: {
      state: "issue",
      text: `${changedAtSource(row.item) ? "Nguồn đã thay đổi" : "Đã xử lý với thiết lập cũ"} · v${indexed} vẫn được dùng để trả lời cho đến khi xử lý lại`,
      action: procBtn,
    },
    unsupported: { state: "skipped", text: "Không xử lý được loại tệp này" },
  };
  const processedStep: Step = {
    label: "Đã xử lý",
    // A new document's submission is processed before review; a new version's after it's published.
    ...((open && !isCandidate(c)) || row.publication === "rejected" || k === "merged"
      ? { state: "todo", text: open ? "Sau khi công bố: phiên bản mới được xử lý ở mục “Đang xử lý”" : "Chưa xử lý" }
      : PROCESSED[inFlight ? "processing" : row.processing]),
  };
  const searchable: Step = {
    label: "Tra cứu được",
    ...(inSearch(row)
      ? { state: "done", text: `Có trong tìm kiếm và câu trả lời · ${who}` }
      : row.publication === "published" && row.processing === "outdated"
        ? { state: "done", text: `Câu trả lời dùng v${indexed} cho đến khi xử lý lại` }
        : {
            state: "todo",
            text: row.publication === "published" ? "Khi tài liệu được xử lý" : row.publication === "unpublished" && row.processing === "ready" ? "Khi tài liệu được công bố" : "Khi tài liệu được công bố và xử lý",
          }),
  };
  const steps = [received, processedStep, reviewed, publishedStep, searchable];

  /* ── History ── */
  const timeline: { icon: LucideIcon; tone?: Tone; label: string; by?: string; text?: string; at: string }[] = events.length
    ? events.map((e) => {
        const [icon, label, tone] = EVENTS[e.kind ?? ""] ?? [Clock, e.kind ?? "", undefined];
        const actor = e.actor ? memberNames.get(e.actor) : e.kind === "SUBMITTED" ? contributorName : "";
        return { icon, tone, label, by: actor, text: e.message, at: e.createTime ?? "" };
      })
    : [synced ? { icon: RefreshCw, label: `Đồng bộ từ ${sourceName}`, at: row.item?.createTime ?? row.updated } : { icon: Upload, label: "Đã thêm", by: memberNames.get(row.item?.creator ?? "") ?? "", at: row.item?.createTime ?? row.updated }];
  if (row.publication === "unpublished") timeline.push({ icon: EyeOff, label: "Đã ngừng công bố", at: row.item?.updateTime ?? "" });
  if (published && k !== "merged" && events.length) timeline.push({ icon: CircleCheck, tone: "success", label: "Đã công bố", at: row.item?.updateTime ?? row.updated });

  return (
    <>
      <div className="drawer__section">
        <div className="row gap-8 wrap">
          <LifecycleChip lifecycle={row.lifecycle} size="md" />
        </div>
        {note ? <div className="mt-12">{note}</div> : null}
      </div>
      <div className="drawer__section">
        <h3 className="drawer__section-title">Tiến độ</h3>
        <ol className="flow-steps">
          {steps.map((s) => {
            const [Icon, tone] = s.busy ? [LoaderCircle, "accent"] : STEP_ICON[s.state];
            return (
              <li key={s.label} className={`flow-steps__item is-${s.state}${s.busy ? " is-busy" : ""}`}>
                <span className={`flow-steps__dot${tone ? ` flow-steps__dot--${tone}` : ""}`} aria-hidden="true">
                  <Icon className="i i-xs" />
                </span>
                <div className="grow">
                  <div className="t-sm">
                    <span className="medium">{s.label}</span>
                    <span className="sr-only">{STEP_SR[s.state]}</span>
                  </div>
                  <div className="flow-steps__text">
                    {s.text}
                    {s.at ? <span className="muted"> · {rel(s.at)}</span> : null}
                  </div>
                  {s.action ? <div className="mt-8">{s.action}</div> : null}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      <div className="drawer__section">
        <Disclosure title="Lịch sử" icon={History} summary={events.length ? plural(events.length, "event") : undefined}>
          <ol className="cur-tl">
            {timeline.map((x, i) => (
              <li key={i} className="cur-tl__item">
                <ItemIcon icon={x.icon} tone={x.tone} size="sm" />
                <div className="grow">
                  <div className="t-sm">
                    <span className="medium">{x.label}</span>
                    {x.by ? ` · ${x.by}` : ""}
                  </div>
                  {x.text ? (
                    <div className="cur-tl__text">
                      “<span translate="no">{x.text}</span>”
                    </div>
                  ) : null}
                  <div className="t-xs muted">{fmtDateTime(x.at)}</div>
                </div>
              </li>
            ))}
          </ol>
        </Disclosure>
      </div>
      <div className="drawer__section">
        <h3 className="drawer__section-title">Chi tiết</h3>
        {resource && published ? (
          <ResourceDetails resource={resource} />
        ) : row.item ? (
          <>
            <KeyValue
              pairs={[
                [
                  "Kho tài liệu",
                  row.base ? (
                    <NextLink className="link" href={`/studio/collections/${resourceId(row.base)}`} translate="no">
                      {where || "Kho tài liệu"}
                    </NextLink>
                  ) : (
                    "—"
                  ),
                ],
                ["Người gửi", contributorName || "—"],
                ["Loại", kind],
                ["Kích thước", fmtSize(row.item.document?.sizeBytes)],
                ["Phiên bản", `v${versionOf(row.item.document?.revision) ?? 1}`],
                [
                  "Ai có thể xem",
                  <span key="who" className="row gap-6">
                    {audience ? <audience.icon className="i i-sm muted" aria-hidden /> : null}
                    {who}
                  </span>,
                ],
              ]}
            />
            {/* Its concepts once it's outside review (a submission's are the assistant's, in Review), then its document facts. */}
            {row.publication === "unpublished" ? <ConceptsByScheme assignments={row.assignments} /> : null}
            <DocumentFacts item={row.item} />
          </>
        ) : (
          <EmptyState icon={FileGlyph} compact title="Tệp không khả dụng" description="Tệp đã được trả lại cho người gửi." />
        )}
      </div>
    </>
  );
}
