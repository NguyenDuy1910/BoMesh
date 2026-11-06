"use client";

import { Button, Description, FieldError, Label, TextArea, TextField } from "@heroui/react";
import { Send, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { toast, UserAvatar } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";
import { useSpaceMembers } from "@/modules/spaces/queries";

import { clip, STAFF_ROLES, teamWord, type Space } from "../model";
import { useCreateRequest } from "../queries";

export interface AskSpaceDialogProps {
  space: Space;
  isOpen: boolean;
  onClose: () => void;
  /** Prefilled question (e.g. "Ask the office instead" from a failed rule check). */
  initialQuestion?: string;
  /** Muted line after the space name ("About Annual leave"). */
  about?: string;
  /** Conversation message (`…/conversations/{c}/messages/{m}`) the caller owns; the server attaches its answer and citations. */
  sourceMessage?: string;
  /** What the assistant answered, shown as "Sent along" (display only). */
  assistantAnswer?: string;
}

/**
 * Ask a space's staff a question (preview `M['rq-ask']`): files a QUESTION request.
 * Used by "Ask the office instead" on /requests/new, the space header and chat escalation.
 */
export function AskSpaceDialog(props: AskSpaceDialogProps) {
  return props.isOpen ? <AskSpaceForm {...props} /> : null;
}

function AskSpaceForm({ space, onClose, initialQuestion, about, sourceMessage, assistantAnswer }: AskSpaceDialogProps) {
  const router = useRouter();
  const [text, setText] = useState(initialQuestion ?? "");
  const [error, setError] = useState("");
  const create = useCreateRequest();
  const members = useSpaceMembers(resourceId(space.name));
  const team = (members.data ?? []).filter((m) => (m.roles ?? []).some((r) => STAFF_ROLES.includes(r)));
  const course = space.spaceType === "course";
  const note = course ? "The teaching team answers here; you’ll get it in your Inbox." : `${space.displayName} answers here; you’ll get it in your Inbox.`;

  const send = () => {
    const question = text.trim();
    if (!question) {
      setError("Write your question.");
      return;
    }
    setError("");
    create.mutate(
      { kind: "QUESTION", space: space.name, question, title: clip(question, 120), sourceMessage },
      {
        onSuccess: (r) => {
          onClose();
          toast(`Question sent to ${teamWord(space)}`, { action: { label: "View", onPress: () => router.push(`/requests/${resourceId(r.name)}`) } });
        },
        onError: (e) => toast(errorMessage(e), { tone: "danger" }),
      },
    );
  };

  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      guard={create.isPending}
      size="md"
      title={course ? "Ask the teaching team" : `Ask ${space.displayName}`}
      description={[space.displayName, about].filter(Boolean).join(" · ")}
      footer={
        <>
          <Button variant="tertiary" onPress={onClose} isDisabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onPress={send} isPending={create.isPending}>
            <Send className="i" aria-hidden />
            Send question
          </Button>
        </>
      }
    >
      <TextField className="field" value={text} onChange={(v) => (setText(v), error && setError(""))} isRequired isInvalid={!!error}>
        <Label>Your question</Label>
        <TextArea rows={5} placeholder="What do you want to know?" autoFocus translate="no" />
        {error ? <FieldError>{error}</FieldError> : <Description>{note}</Description>}
      </TextField>
      {assistantAnswer ? (
        <div className="rq-ai mt-16">
          <Sparkles className="i i-sm" aria-hidden />
          <div className="grow">
            <div className="rq-ai__label">Sent along: what the assistant found</div>
            <p translate="no">{clip(assistantAnswer, 280)}</p>
          </div>
        </div>
      ) : null}
      {team.length ? (
        <div className="row gap-8 mt-16 t-sm muted">
          <span className="rq-avatars">
            {team.slice(0, 3).map((m) => (
              <UserAvatar key={m.name} name={m.displayName ?? ""} size="xs" />
            ))}
          </span>
          <span className="truncate" translate="no">
            {team.map((m) => m.displayName).join(", ")}
          </span>
        </div>
      ) : null}
    </KnowledgeModal>
  );
}
