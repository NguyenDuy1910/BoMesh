"use client";

import clsx from "clsx";
import { Clock } from "lucide-react";

import { StatusChip, Tip } from "@/components/ui";

import { isQuestion, REQUEST_STATUS, requestStatus, slaOf, type Request, type RequestStatus, type Space } from "../model";

/**
 * Status chip as the viewer should read it (preview `requestStatus`): staff see
 * "Waiting for reply" where the requester sees "Needs your reply"; answered questions read "Answered".
 */
export function RequestStatusChip({ request, mine, space, size }: { request: Request; mine: boolean; space?: Space | null; size?: "sm" | "md" }) {
  const st = requestStatus(request);
  if (st === "needs_info" && !mine) return <StatusChip label={space?.spaceType === "course" ? "Đang chờ sinh viên" : "Đang chờ phản hồi"} tone="warning" dot size={size} />;
  if (st === "completed" && isQuestion(request)) return <StatusChip label="Đã trả lời" tone="success" variant="tertiary" dot size={size} />;
  const [tone, label, variant] = REQUEST_STATUS[st];
  return <StatusChip label={label} tone={tone} variant={variant} dot size={size} />;
}

const STEP_LABEL: Record<RequestStatus, string> = {
  submitted: "Đã gửi",
  in_review: "Chờ duyệt",
  needs_info: "Đã yêu cầu thông tin",
  approved: "Đã phê duyệt",
  declined: "Đã từ chối",
  completed: "Đã hoàn thành",
  withdrawn: "Đã rút lại",
};

/** A status change inside the thread, in past tense (preview `stepChip`). */
export function StepChip({ request, status }: { request: Request; status: RequestStatus }) {
  const label = status === "completed" && isQuestion(request) ? "Đã trả lời" : STEP_LABEL[status];
  return <StatusChip label={label} tone={REQUEST_STATUS[status][0]} size="sm" dot={false} />;
}

/** SLA for staff: due in / overdue / paused (preview `slaHtml`). */
export function SlaText({ request }: { request: Request }) {
  const s = slaOf(request);
  const el = (
    <span className={clsx("rq-sla", s.tone && `rq-sla--${s.tone}`)}>
      {s.tone === "danger" ? <Clock className="i i-sm" aria-hidden /> : null}
      {s.text}
    </span>
  );
  return s.tip ? <Tip content={s.tip}>{el}</Tip> : el;
}
