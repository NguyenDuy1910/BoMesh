"use client";

import { Button, Description, FieldError, Label, TextArea, TextField } from "@heroui/react";
import { useRef, useState } from "react";

import { plural } from "@/lib/format";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";

import { QUICK_REPLIES } from "../model";

export interface DecideRequest {
  mode: "changes" | "decline";
  /** Submissions the decision covers. */
  titles: string[];
  /** Contributor names (empty for synced files). */
  contributor?: string;
}

/**
 * Request changes / Decline (preview `M['cur-decide']`): a required message the contributor sees,
 * with quick replies.
 */
export function DecideDialog({ request, onClose, onSubmit }: { request: DecideRequest | null; onClose: () => void; onSubmit: (message: string) => void }) {
  return request ? <DecideForm key={`${request.mode}:${request.titles.join("|")}`} request={request} onClose={onClose} onSubmit={onSubmit} /> : null;
}

function DecideForm({ request, onClose, onSubmit }: { request: DecideRequest; onClose: () => void; onSubmit: (message: string) => void }) {
  const [text, setText] = useState("");
  const [tried, setTried] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const changes = request.mode === "changes";
  const n = request.titles.length;
  const error = tried && !text.trim() ? (changes ? "Tell the contributor what to change." : "Give a reason. The contributor sees it.") : "";
  const who = n > 1 ? "Each contributor sees this message." : request.contributor ? `${request.contributor} sees this message.` : "It’s kept with the document’s history.";

  const submit = () => {
    setTried(true);
    if (!text.trim()) {
      ref.current?.focus();
      return;
    }
    onSubmit(text.trim());
  };
  const quick = (q: string) => {
    setText(q);
    requestAnimationFrame(() => {
      const t = ref.current;
      if (!t) return;
      t.focus();
      t.setSelectionRange(q.length, q.length);
    });
  };

  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      size="md"
      title={changes ? "Request changes" : n > 1 ? `Decline ${plural(n, "submission")}` : "Decline submission"}
      description={n === 1 ? <span translate="no">{request.titles[0]}</span> : undefined}
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button variant={changes ? "primary" : "danger"} onPress={submit}>
            {changes ? "Send request" : n > 1 ? `Decline ${n}` : "Decline"}
          </Button>
        </>
      }
    >
      <TextField value={text} onChange={setText} isRequired isInvalid={!!error} maxLength={600}>
        <Label>{changes ? "What should change?" : "Reason"}</Label>
        <TextArea ref={ref} rows={4} autoFocus />
        {error ? <FieldError>{error}</FieldError> : <Description>{who}</Description>}
      </TextField>
      <div className="mt-16">
        <div className="t-label mb-8">Quick replies</div>
        <div className="cur-quick">
          {QUICK_REPLIES[request.mode].map((q) => (
            <Button key={q} variant="outline" size="sm" onPress={() => quick(q)}>
              {q}
            </Button>
          ))}
        </div>
      </div>
    </KnowledgeModal>
  );
}
