"use client";

import { Clock, Lock } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { Button, ButtonLink } from "@/components/ui/Button";
import { ChoiceCard } from "@/components/ui/ChoiceCard";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormField } from "@/components/ui/FormField";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/Toast";
import { ApiError } from "@/lib/api/request";
import { isPendingFeatureEnabled } from "@/lib/api/pending";
import {
  requestCollectionAccess,
  useMyAccessRequests,
  type AccessRequest,
  type RequestableRole,
} from "@/modules/knowledge/access-requests";
import { forgetUnreadableCollection } from "@/modules/knowledge/api";
import { REQUEST_REASON_MIN } from "@/modules/knowledge/model";
import { formatRelative } from "@/lib/format";

/** The name to show for a knowledge base the caller cannot read. */
export const RESTRICTED_NAME = "Restricted knowledge base";

/**
 * Ask the owners for access to a knowledge base: which access, and why.
 * Sends a real `resource_access` approval request; approving it grants
 * exactly that role.
 */
export function RequestAccessDialog({
  open,
  onClose,
  collectionId,
  collectionName,
  onSent,
  onMissing,
}: {
  open: boolean;
  onClose: () => void;
  collectionId: string;
  collectionName?: string | null;
  onSent?: (request: AccessRequest) => void;
  /** The server says no such knowledge base exists (anymore). */
  onMissing?: () => void;
}) {
  const toast = useToast();
  const reasonId = useId();
  const [role, setRole] = useState<RequestableRole>("viewer");
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const name = collectionName || RESTRICTED_NAME;

  useEffect(() => {
    if (!open) return;
    setRole("viewer");
    setReason("");
    setTouched(false);
    setFailure(null);
  }, [open]);

  const reasonError = reason.trim().length < REQUEST_REASON_MIN
    ? `Tell the owners why you need access (at least ${REQUEST_REASON_MIN} characters).`
    : null;
  const shownError = touched ? reasonError : null;

  const send = async () => {
    setTouched(true);
    if (reasonError) {
      document.getElementById(reasonId)?.focus();
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const request = await requestCollectionAccess(collectionId, { role, reason });
      toast.show({ message: collectionName ? `Request sent to the owners of ${collectionName}` : "Request sent to the owners" });
      onSent?.(request);
      onClose();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) {
        if (isPendingFeatureEnabled("collection.discovery")) forgetUnreadableCollection(collectionId);
        toast.show({ tone: "err", message: "This knowledge base doesn’t exist anymore" });
        onMissing?.();
        onClose();
      } else if (cause instanceof ApiError && cause.status === 409) {
        setFailure("You already asked for access. The owners will see your request.");
      } else {
        setFailure(cause instanceof Error ? cause.message : "Your request couldn’t be sent. Try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      busy={busy}
      description={name}
      footer={(
        <>
          <Button disabled={busy} onClick={onClose} variant="secondary">Cancel</Button>
          <Button loading={busy} onClick={() => void send()} variant="primary">Send request</Button>
        </>
      )}
      onClose={onClose}
      open={open}
      size="sm"
      title="Request access"
    >
      <form
        className="grid gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-[length:var(--text-size-meta)] font-medium text-[var(--text-primary)]">Access you need</legend>
          <ChoiceCard
            checked={role === "viewer"}
            description="Search and read its documents."
            disabled={busy}
            name="request-role"
            onChange={() => setRole("viewer")}
            title="View"
            value="viewer"
          />
          <ChoiceCard
            checked={role === "editor"}
            description="Also add and organize documents."
            disabled={busy}
            name="request-role"
            onChange={() => setRole("editor")}
            title="Edit"
            value="editor"
          />
        </fieldset>
        <FormField
          error={shownError}
          help="The owners see this with your request."
          htmlFor={reasonId}
          label="Why do you need it?"
          required
        >
          <Textarea
            disabled={busy}
            error={Boolean(shownError)}
            id={reasonId}
            onBlur={() => reason.trim() && setTouched(true)}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. I need the renewal terms for a customer call"
            rows={3}
            value={reason}
          />
        </FormField>
        {failure && <p className="text-[length:var(--text-size-meta)] text-[var(--status-danger-text)]" role="alert">{failure}</p>}
      </form>
    </Dialog>
  );
}

/** "Access requested" with the pending status, where a Request access button would be. */
export function AccessRequestedMark({ size = "sm" }: { size?: "sm" | "md" }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button disabled icon={<Clock aria-hidden="true" size={16} />} size={size} variant="secondary">Access requested</Button>
      <StatusBadge kind="request" value="pending" />
    </span>
  );
}

/**
 * The whole "you can't open this" state for a knowledge base the caller
 * cannot read: request access, or see that the request is with the owners.
 * Also used by the document viewer's no-access state.
 */
export function AccessRequestState({
  collectionId,
  collectionName,
  onMissing,
}: {
  collectionId: string;
  collectionName?: string | null;
  onMissing?: () => void;
}) {
  const requests = useMyAccessRequests();
  const [asking, setAsking] = useState(false);
  const latest = requests.data?.get(collectionId);
  const pending = latest?.status === "pending" ? latest : null;
  const denied = latest?.status === "denied" ? latest : null;

  return (
    <>
      <EmptyState
        action={pending ? (
          <AccessRequestedMark size="md" />
        ) : (
          <>
            <Button
              disabled={requests.loading && !requests.data}
              icon={<Lock aria-hidden="true" size={16} />}
              onClick={() => setAsking(true)}
              variant="primary"
            >
              Request access
            </Button>
            <ButtonLink href="/knowledge" variant="ghost">Go to Knowledge</ButtonLink>
          </>
        )}
        boxed
        description={pending
          ? `You asked ${formatRelative(pending.created_at).toLowerCase()}. You’ll be able to open it as soon as it’s approved.`
          : denied
            ? "Your last request wasn’t approved. You can ask again with more detail."
            : "It isn’t shared with you, or it was archived. Ask the owners for access to search and read its documents."}
        icon={<Lock />}
        title={pending ? "Your request is with the owners" : "You don’t have access yet"}
      />
      <RequestAccessDialog
        collectionId={collectionId}
        collectionName={collectionName}
        onClose={() => setAsking(false)}
        onMissing={onMissing}
        open={asking}
      />
    </>
  );
}
