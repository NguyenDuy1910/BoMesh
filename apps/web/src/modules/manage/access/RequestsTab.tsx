"use client";

import { ChevronDown, ChevronRight, Inbox, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { FormField } from "@/components/ui/FormField";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/Toast";
import { invalidateApiData } from "@/lib/api/revision";
import { cn } from "@/lib/cn";
import { accessErrorMessage, requestedVerb, type Loadable } from "@/modules/manage/access/access-model";
import {
  approvalRequestsApi,
  memberName,
  type ApprovalRequest,
  type CollectionSummary,
  type Member,
} from "@/modules/manage/access/directory";
import { connectorByKey } from "@/modules/ingestion/connectors";
import { formatDateTime, formatRelative } from "@/lib/format";

/**
 * How long Approve waits before it is sent. A decision is final on the
 * server (there is no way back to pending), so Undo is honest only before the
 * request goes out: the approval is held for this long, then committed.
 */
const UNDO_WINDOW_MS = 6000;
const NOTE_LIMIT = 4000;

interface Held {
  timer: number;
  toastId: string;
}

/** Who asked, and for what, in words — with a link to the thing asked for. */
function describeRequest(request: ApprovalRequest, collections: CollectionSummary[] | null) {
  const who = memberName(request.requester);
  if (request.request_type === "plugin_installation") {
    const connector = connectorByKey(request.target_id)?.name ?? "a new";
    return { who, verb: "wants to connect", target: `${connector} connector`, href: null, summary: `connect ${connector}` };
  }
  const title = collections?.find((collection) => collection.id === request.target_id)?.title ?? "a knowledge base";
  const verb = requestedVerb(request);
  return { who, verb: `wants to ${verb}`, target: title, href: `/knowledge/${request.target_id}`, summary: `${verb} ${title}` };
}

export function RequestsTab({
  requests,
  collections,
  members,
  callerId,
  focusRequestId,
}: {
  requests: Loadable<ApprovalRequest[]>;
  collections: CollectionSummary[] | null;
  members: Member[] | null;
  callerId: string | null;
  focusRequestId: string | null;
}) {
  const toast = useToast();
  const all = requests.data ?? [];
  const pending = all.filter((request) => request.status === "pending").sort((left, right) => right.created_at.localeCompare(left.created_at));
  const decided = all
    .filter((request) => request.status !== "pending")
    .sort((left, right) => (right.decided_at ?? right.created_at).localeCompare(left.decided_at ?? left.created_at));
  const focused = focusRequestId ? all.find((request) => request.id === focusRequestId) ?? null : null;
  const [showDecided, setShowDecided] = useState(Boolean(focused && focused.status !== "pending"));
  const [denying, setDenying] = useState<ApprovalRequest | null>(null);

  /* ── Approve, held for the Undo window ── */
  const held = useRef<Record<string, Held>>({});
  const [holding, setHolding] = useState<string[]>([]);
  const [committing, setCommitting] = useState<string[]>([]);

  const commit = useCallback(
    (request: ApprovalRequest) => {
      const entry = held.current[request.id];
      if (!entry) return;
      window.clearTimeout(entry.timer);
      toast.dismiss(entry.toastId);
      delete held.current[request.id];
      setHolding((current) => current.filter((id) => id !== request.id));
      setCommitting((current) => [...current, request.id]);
      approvalRequestsApi
        .decide(request.id, { status: "approved" })
        .catch((cause: unknown) => {
          toast.show({
            tone: "err",
            message: `Couldn’t approve ${memberName(request.requester)}’s request`,
            description: accessErrorMessage(cause, "Try again."),
          });
          invalidateApiData();
        })
        .finally(() => setCommitting((current) => current.filter((id) => id !== request.id)));
    },
    [toast],
  );

  const approve = (request: ApprovalRequest) => {
    if (held.current[request.id]) return;
    const { who, summary } = describeRequest(request, collections);
    const toastId = toast.show({
      message: `${who} can now ${summary}`,
      duration: UNDO_WINDOW_MS,
      action: {
        label: "Undo",
        onClick: () => undo(request),
      },
    });
    held.current[request.id] = { toastId, timer: window.setTimeout(() => commit(request), UNDO_WINDOW_MS) };
    setHolding((current) => [...current, request.id]);
  };

  const undo = (request: ApprovalRequest) => {
    const entry = held.current[request.id];
    if (!entry) return;
    window.clearTimeout(entry.timer);
    toast.dismiss(entry.toastId);
    delete held.current[request.id];
    setHolding((current) => current.filter((id) => id !== request.id));
    toast.show({ tone: "info", message: "Approval undone" });
  };

  // Leaving the tab, the page or the browser sends what is still held: the reviewer did approve.
  const latestRequests = useRef(all);
  latestRequests.current = all;
  useEffect(() => {
    const flush = () => {
      for (const id of Object.keys(held.current)) {
        const request = latestRequests.current.find((item) => item.id === id);
        if (request) commit(request);
      }
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [commit]);

  /* ── Bring a linked request into view once ── */
  const focusRef = useRef<HTMLLIElement | null>(null);
  const focusedOnce = useRef<string | null>(null);
  useEffect(() => {
    if (!focused || focusedOnce.current === focused.id) return;
    if (focused.status !== "pending") setShowDecided(true);
    const node = focusRef.current;
    if (!node) return;
    focusedOnce.current = focused.id;
    node.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    node.focus({ preventScroll: true });
  }, [focused, showDecided]);

  if (requests.error && !requests.data) {
    return <ErrorState description={requests.error} onAction={requests.reload} title="Requests didn’t load" />;
  }
  if (!requests.data) return <SkeletonRows columns={2} label="Loading requests" rows={3} />;

  const deciderName = (request: ApprovalRequest) => {
    if (!request.decided_by_user_id) return "an admin";
    if (request.decided_by_user_id === callerId) return "you";
    const member = members?.find((item) => item.id === request.decided_by_user_id);
    return member ? memberName(member) : "an admin";
  };

  return (
    <>
      {focusRequestId && requests.data && !focused && (
        <Callout className="mb-4" tone="neutral" title="That request isn’t here">
          It may have been withdrawn, or it’s for something you don’t review.
        </Callout>
      )}

      {pending.length ? (
        <ul className="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-base)]">
          {pending.map((request) => {
            const { who, verb, target, href } = describeRequest(request, collections);
            const isHeld = holding.includes(request.id);
            const isCommitting = committing.includes(request.id);
            const isFocused = focused?.id === request.id;
            return (
              <li
                aria-label={`${who} ${verb} ${target}`}
                className={cn(
                  "flex items-start gap-3 px-4 py-3.5 outline-none transition-colors duration-[var(--duration-base)]",
                  isFocused && "bg-[var(--accent-soft)] shadow-[inset_3px_0_0_var(--accent-primary)]",
                  "focus-visible:shadow-[inset_0_0_0_2px_var(--focus-ring)]",
                  (isHeld || isCommitting) && "bg-[var(--surface-subtle)]",
                )}
                key={request.id}
                ref={isFocused ? focusRef : undefined}
                tabIndex={isFocused ? -1 : undefined}
              >
                <Avatar className="mt-0.5 h-9 w-9 text-[length:var(--text-size-meta)]" name={who} />
                <div className="min-w-0 flex-1">
                  <div className={cn("text-[var(--text-primary)]", (isHeld || isCommitting) && "text-[var(--text-secondary)]")}>
                    <strong className="font-semibold">{who}</strong> {verb}{" "}
                    {href ? (
                      <Link className="font-medium text-[var(--text-accent)] hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]" href={href}>
                        {target}
                      </Link>
                    ) : (
                      <span className="font-medium">{target}</span>
                    )}
                  </div>
                  {request.reason && <p className="mt-1 text-[13.5px] italic text-[var(--text-secondary)]">“{request.reason}”</p>}
                  <p className="mt-1 text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]" title={formatDateTime(request.created_at)}>
                    {formatRelative(request.created_at)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2 self-center">
                  {isCommitting ? (
                    <span className="inline-flex items-center gap-1.5 text-[length:var(--text-size-meta)] text-[var(--text-secondary)]">
                      <LoaderCircle aria-hidden="true" className="animate-spin" size={14} /> Approving…
                    </span>
                  ) : isHeld ? (
                    <>
                      <span className="text-[length:var(--text-size-meta)] text-[var(--text-secondary)]">Approved</span>
                      <Button onClick={() => undo(request)} size="sm" variant="secondary">Undo</Button>
                    </>
                  ) : (
                    <>
                      <Button onClick={() => setDenying(request)} size="sm" variant="ghost">Deny</Button>
                      <Button onClick={() => approve(request)} size="sm" variant="secondary">Approve</Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState
          boxed
          description="When someone asks for access to a restricted knowledge base, it appears here."
          icon={<Inbox />}
          title="No pending requests"
        />
      )}

      {decided.length > 0 && (
        <section className="mt-6">
          <button
            aria-controls="access-recently-decided"
            aria-expanded={showDecided}
            className="-ml-1.5 inline-flex items-center gap-2 rounded-[var(--radius-sm)] px-1.5 py-1 font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            onClick={() => setShowDecided((open) => !open)}
            type="button"
          >
            {showDecided ? <ChevronDown aria-hidden="true" size={16} /> : <ChevronRight aria-hidden="true" size={16} />}
            Recently decided
            <span className="rounded-[var(--radius-full)] bg-[var(--surface-inset)] px-[7px] py-px text-[length:var(--text-size-caption)] text-[var(--text-tertiary)]">
              {decided.length}
            </span>
          </button>
          {showDecided && (
            <ul
              className="mt-2.5 divide-y divide-[var(--border-subtle)] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-base)]"
              id="access-recently-decided"
            >
              {decided.map((request) => {
                const { who, summary } = describeRequest(request, collections);
                const isFocused = focused?.id === request.id;
                const verdict = request.status === "approved" ? "Approved" : request.status === "denied" ? "Denied" : "Withdrawn";
                return (
                  <li
                    className={cn(
                      "flex min-w-0 items-center gap-2.5 px-3.5 py-2.5 outline-none",
                      isFocused && "bg-[var(--accent-soft)] shadow-[inset_3px_0_0_var(--accent-primary)]",
                    )}
                    key={request.id}
                    ref={isFocused ? focusRef : undefined}
                    tabIndex={isFocused ? -1 : undefined}
                  >
                    <Avatar name={who} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate">
                        <strong className="font-medium text-[var(--text-primary)]">{who}</strong>{" "}
                        <span className="text-[var(--text-secondary)]">· {summary}</span>
                      </div>
                      <div className="truncate text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]" title={request.decided_at ? formatDateTime(request.decided_at) : undefined}>
                        {request.status === "cancelled" ? `${verdict} by ${who}` : `${verdict} by ${deciderName(request)}`}
                        {request.decided_at && ` · ${formatRelative(request.decided_at)}`}
                        {request.decision_note && ` · “${request.decision_note}”`}
                      </div>
                    </div>
                    <StatusBadge kind="request" value={request.status} />
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {denying && (
        <DenyDialog
          onClose={() => setDenying(null)}
          request={denying}
          summary={describeRequest(denying, collections).summary}
        />
      )}
    </>
  );
}

/** Deny with an optional reason; the requester sees the reason with the decision. */
function DenyDialog({ request, summary, onClose }: { request: ApprovalRequest; summary: string; onClose: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const who = memberName(request.requester);
  const first = who.split(/\s+/)[0];

  const deny = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await approvalRequestsApi.decide(request.id, { status: "denied", decision_note: note.trim() || null });
      toast.show({ message: "Request denied" });
      onClose();
    } catch (cause) {
      setFailure(accessErrorMessage(cause, "The request wasn’t denied. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      busy={busy}
      description={`${first} asked to ${summary}.`}
      footer={
        <>
          <Button onClick={onClose} variant="secondary">Cancel</Button>
          <Button loading={busy} onClick={() => void deny()}>Deny request</Button>
        </>
      }
      onClose={onClose}
      open
      size="sm"
      title={`Deny ${who}’s request?`}
    >
      <FormField help={`Shared with ${first} so they know where to look instead.`} htmlFor="deny-reason" label="Reason">
        <Textarea
          id="deny-reason"
          maxLength={NOTE_LIMIT}
          onChange={(event) => setNote(event.target.value)}
          placeholder="e.g. This knowledge base is limited to the Legal team."
          rows={3}
          value={note}
        />
      </FormField>
      {failure && <p className="mt-3 text-[length:var(--text-size-meta)] text-[var(--status-danger-text)]" role="alert">{failure}</p>}
    </Dialog>
  );
}

