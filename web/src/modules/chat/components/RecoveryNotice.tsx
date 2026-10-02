"use client";

import { AlertTriangle, RotateCcw, SquarePen, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/Button";

import type { RecoveryVariant, TurnRecovery } from "../recovery";

export type ChatNoticeTone = "warning" | "info" | "danger" | "neutral";

/**
 * The one notice the conversation shows: a failure or a limit, stated where it
 * happened so the surrounding conversation stays intact. `neutral` is for a
 * standing condition rather than an error, so it never borrows alarm colours.
 */
export function ChatNotice({
  actions,
  detail,
  icon: Icon = AlertTriangle,
  role = "alert",
  title,
  tone,
}: {
  actions?: React.ReactNode;
  detail?: React.ReactNode;
  icon?: LucideIcon;
  role?: "alert" | "status";
  title: string;
  tone: ChatNoticeTone;
}) {
  return (
    <section className={`recovery-notice recovery-notice--${tone}`} role={role}>
      <Icon aria-hidden="true" className="recovery-notice__icon" size={16} />
      <div className="recovery-notice__body">
        <h3>{title}</h3>
        {detail && <p>{detail}</p>}
        {actions && <div className="recovery-notice__actions">{actions}</div>}
      </div>
    </section>
  );
}

const RECOVERY_TONE: Record<RecoveryVariant, ChatNoticeTone> = {
  model_unavailable: "warning",
  knowledge_unavailable: "info",
  tool_failed: "danger",
  stream_interrupted: "neutral",
};

/** A failed turn's local recovery: retry it, or revise the request. */
export function RecoveryNotice({
  recovery,
  onEditRequest,
  onRetry,
}: {
  recovery: TurnRecovery;
  onEditRequest?: () => void;
  onRetry: () => void;
}) {
  return (
    <ChatNotice
      actions={(
        <>
          <Button icon={<RotateCcw aria-hidden="true" size={14} />} onClick={onRetry} size="sm" variant="primary">
            {recovery.retryLabel}
          </Button>
          {onEditRequest && (
            <Button icon={<SquarePen aria-hidden="true" size={14} />} onClick={onEditRequest} size="sm" variant="ghost">
              Edit request
            </Button>
          )}
        </>
      )}
      detail={recovery.detail}
      title={recovery.title}
      tone={RECOVERY_TONE[recovery.variant]}
    />
  );
}
