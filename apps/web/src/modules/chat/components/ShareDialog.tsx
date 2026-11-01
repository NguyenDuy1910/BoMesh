"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Dialog } from "@/components/ui/Dialog";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import {
  createConversationShare,
  listConversationShares,
  revokeConversationShare,
  type ConversationShare,
  type ConversationShareAudience,
} from "../api";
import { getMessageText } from "../conversations";
import { answerSources } from "../sources";
import type { ChatMessage } from "../types";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Share this chat as a read-only link (`chat.share`, API pending). The link
 * carries a snapshot of the chat; people who open it only see the sources
 * they can already open.
 */
export function ShareDialog({
  open,
  onClose,
  conversationId,
  title,
  messages,
  workspaceName,
}: {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  title: string;
  messages: ChatMessage[];
  workspaceName: string;
}) {
  const toast = useToast();
  const [audience, setAudience] = useState<ConversationShareAudience>("workspace");
  const [people, setPeople] = useState("");
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const [share, setShare] = useState<ConversationShare | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus("loading");
    setCopied(false);
    setPeopleError(null);
    listConversationShares(conversationId)
      .then((shares) => {
        if (cancelled) return;
        const latest = shares.at(-1) ?? null;
        setShare(latest);
        setAudience(latest?.audience ?? "workspace");
        setPeople(latest?.emails.join(", ") ?? "");
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, open]);

  const emails = people.split(/[,;\s]+/).map((value) => value.trim()).filter(Boolean);
  const matchesShare = share !== null
    && share.audience === audience
    && (audience === "workspace" || [...emails].map((email) => email.toLowerCase()).sort().join(",") === [...share.emails].sort().join(","));
  const link = share ? `${typeof window === "undefined" ? "" : window.location.origin}${share.url}` : "";

  const copyLink = async (value: string, peopleOnly: boolean) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.show({ message: peopleOnly ? "Link copied. Only the people you chose can open it." : "Link copied" });
    } catch {
      toast.show({ tone: "err", message: "Copying isn’t allowed in this browser. Select the link and copy it." });
    }
  };

  const createAndCopy = async () => {
    if (audience === "people") {
      if (!emails.length) {
        setPeopleError("Add at least one person, or share with everyone in the workspace.");
        return;
      }
      const invalid = emails.filter((email) => !EMAIL_PATTERN.test(email));
      if (invalid.length) {
        setPeopleError(`Use email addresses: ${invalid.join(", ")}`);
        return;
      }
    }
    setPeopleError(null);
    setBusy(true);
    try {
      const created = await createConversationShare(conversationId, {
        audience,
        ...(audience === "people" ? { emails } : {}),
        snapshot: {
          title,
          messages: messages.flatMap((message) => {
            const content = getMessageText(message).trim();
            if (!content) return [];
            return [{
              role: message.role,
              content,
              ...(message.role === "assistant"
                ? {
                    sources: answerSources(message.turn).flatMap((source) => {
                      // Every number a document answers to, so each [n] resolves.
                      const numbers = new Set([source.index, ...source.passages.map((passage) => passage.number)]);
                      return [...numbers].map((number) => ({
                        number,
                        document_id: source.itemId,
                        chunk_id: source.passages.find((passage) => passage.number === number)?.chunkId ?? source.chunkId,
                        title: source.title,
                      }));
                    }),
                  }
                : {}),
            }];
          }),
        },
      });
      // A new link replaces the old one, so only one link is live at a time.
      if (share && !share.revoked_at) await revokeConversationShare(conversationId, share.id).catch(() => undefined);
      setShare(created);
      await copyLink(`${window.location.origin}${created.url}`, audience === "people");
    } catch (cause) {
      toast.show({ tone: "err", message: "The link couldn’t be created", description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!share) return;
    setBusy(true);
    try {
      await revokeConversationShare(conversationId, share.id);
      setShare(null);
      setCopied(false);
      toast.show({ message: "Link turned off" });
    } catch (cause) {
      toast.show({ tone: "err", message: "The link couldn’t be turned off", description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      busy={busy}
      description={title}
      footer={(
        <>
          <Button disabled={busy} onClick={onClose} variant="secondary">Done</Button>
          {matchesShare ? (
            <Button icon={copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />} onClick={() => void copyLink(link, audience === "people")} variant="primary">
              {copied ? "Copied" : "Copy link"}
            </Button>
          ) : (
            <Button disabled={status !== "ready"} icon={<Copy aria-hidden="true" />} loading={busy} onClick={() => void createAndCopy()} variant="primary">
              {share ? "Update and copy link" : "Create and copy link"}
            </Button>
          )}
        </>
      )}
      footerStart={share && matchesShare ? (
        <Button disabled={busy} onClick={() => void revoke()} size="sm" variant="danger-ghost">Turn off link</Button>
      ) : undefined}
      onClose={onClose}
      open={open}
      size="md"
      title={<span className="inline-flex items-center gap-2">Share this chat <PreviewTag /></span>}
    >
      <div className="flex flex-col gap-4">
        <Callout tone="neutral">People only see sources they can open. They see the answers, not the documents behind them.</Callout>
        {status === "loading" ? (
          <div className="flex flex-col gap-3"><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /></div>
        ) : status === "error" ? (
          <Callout tone="err" title="Sharing isn’t available right now">Close this and try again in a moment.</Callout>
        ) : (
          <>
            <FormField htmlFor="share-audience" label="Who can open the link">
              <Select
                onChange={(event) => {
                  setAudience(event.target.value as ConversationShareAudience);
                  setCopied(false);
                  setPeopleError(null);
                }}
                options={[
                  { value: "workspace", label: `Anyone in ${workspaceName}` },
                  { value: "people", label: "Only people I choose" },
                ]}
                value={audience}
              />
            </FormField>
            {audience === "people" && (
              <FormField error={peopleError ?? undefined} help="Separate email addresses with commas." htmlFor="share-people" label="People" required>
                <Input
                  autoComplete="off"
                  data-autofocus
                  onChange={(event) => {
                    setPeople(event.target.value);
                    setCopied(false);
                  }}
                  placeholder="an.nguyen@company.com, ben.walker@company.com"
                  value={people}
                />
              </FormField>
            )}
            {share && matchesShare && (
              <FormField help="Anyone who opens it signs in first." htmlFor="share-link" label="Link">
                <Input className="font-mono" onFocus={(event) => event.target.select()} readOnly value={link} />
              </FormField>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
