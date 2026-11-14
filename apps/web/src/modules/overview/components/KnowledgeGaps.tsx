"use client";

import { Button, Description, FieldError, Label, TextArea, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, MessageSquarePlus, Pencil, Upload, X } from "lucide-react";
import { useRef, useState } from "react";

import { IconButton, List, ListItem, Section, Tip, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { deleteItem, uploadDocument } from "@/modules/knowledge/api";
import { openContribute } from "@/modules/knowledge/components/contribute-store";
import { useItemPermissions, useKnowledgeBases } from "@/modules/knowledge/queries";
import { createIngestionRun } from "@/modules/curation/api";
import { useInvalidateCuration } from "@/modules/curation/queries";
import { Dialog } from "@/modules/people/components/Dialog";
import { MoreMenu } from "@/modules/people/components/MoreMenu";

import { dismissGap, reopenGap, type KnowledgeGap } from "../api";
import { overviewKeys, useGaps } from "../queries";

/** Why a question counts as a gap, in words (the API sends a reason code). */
const WHY: Readonly<Record<string, string>> = {
  NOT_COVERED: "No document covers it",
  OUTDATED: "Only outdated documents cover it",
  RATED_UNHELPFUL: "Answers were rated unhelpful",
};

/** The FAQ document an answer becomes. */
const faqName = (q: string) => `FAQ — ${q.trim().replace(/[?？.\s]+$/, "").slice(0, 70)}.md`;

/**
 * Knowledge gaps (preview `gapsSection`): frequent questions knowledge couldn't answer well, one fix each
 * (Answer it), the rest in ⋯. Hidden when there are none.
 */
export function KnowledgeGaps() {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const gaps = useGaps();
  const bases = useKnowledgeBases({ showLocked: true });
  const [answering, setAnswering] = useState<KnowledgeGap | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: overviewKeys.gaps(ws) });
  const baseName = new Map((bases.data ?? []).map((b) => [b.name ?? "", b.displayName ?? ""]));

  const dismiss = async (g: KnowledgeGap) => {
    try {
      await dismissGap(ws, g.name ?? "");
      refresh();
      toast("Gap dismissed", {
        undo: () => void reopenGap(ws, g.name ?? "").then(refresh, (error: unknown) => toast(errorMessage(error), { tone: "danger" })),
      });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    }
  };

  const top = [...(gaps.data ?? [])].sort((a, b) => (b.askCount ?? 0) - (a.askCount ?? 0)).slice(0, 4);
  if (!top.length) return null;
  return (
    <Section title="Knowledge gaps">
      <List className="ov-attn ov-gaps">
        {top.map((g) => (
          <GapRow key={g.name} gap={g} base={baseName.get(g.suggestedCollection ?? "") ?? ""} onDismiss={() => void dismiss(g)} onAnswer={() => setAnswering(g)} />
        ))}
      </List>
      {answering ? <AnswerForm key={answering.name} gap={answering} base={baseName.get(answering.suggestedCollection ?? "") || "the collection"} onClose={() => setAnswering(null)} /> : null}
    </Section>
  );
}

function GapRow({ gap: g, base, onDismiss, onAnswer }: { gap: KnowledgeGap; base: string; onDismiss: () => void; onAnswer: () => void }) {
  const perms = useItemPermissions(g.suggestedCollection);
  const edit = Boolean(g.suggestedCollection) && perms.can("items.create");
  return (
    <ListItem
      lead={
        <Tip content="Times asked">
          <span className="ov-gap-n">{g.askCount ?? 0}×</span>
        </Tip>
      }
      title={<span translate="no">“{g.question}”</span>}
      description={
        <span className="ov-line">
          {base ? <span translate="no">{base}</span> : null}
          {base && WHY[g.reason ?? ""] ? " · " : null}
          {WHY[g.reason ?? ""]}
        </span>
      }
      actions={
        edit ? (
          <>
            <Button variant="secondary" size="sm" onPress={onAnswer}>
              <Pencil className="i" aria-hidden />
              Answer it
            </Button>
            <MoreMenu
              actions={[
                { id: "contribute", label: "Contribute", icon: Upload, onAction: () => openContribute({ collection: g.suggestedCollection }) },
                { id: "dismiss", label: "Dismiss", icon: X, sep: true, onAction: onDismiss },
              ]}
            />
          </>
        ) : (
          <IconButton icon={X} tip="Dismiss" size="sm" onPress={onDismiss} />
        )
      }
    />
  );
}

/**
 * Answer a gap (preview `M['ov-gap-answer']`): the answer becomes a FAQ document in the suggested collection and is
 * published for the assistant to cite; the gap leaves the list. Undo removes the document and reopens the gap.
 */
function AnswerForm({ gap: g, base, onClose }: { gap: KnowledgeGap; base: string; onClose: () => void }) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const invalidate = useInvalidateCuration();
  const [text, setText] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const name = faqName(g.question ?? "");
  const error = tried && !text.trim() ? "Write the answer people should get." : "";

  const save = async () => {
    setTried(true);
    const answer = text.trim();
    if (!answer) {
      ref.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const doc = await uploadDocument(ws, {
        parentItem: g.suggestedCollection ?? "",
        file: new File([`# ${(g.question ?? "").trim()}\n\n${answer}\n`], name, { type: "text/markdown" }),
        displayName: name.replace(/\.md$/, ""),
        document: { documentType: "faq" },
      });
      await createIngestionRun(ws, [doc.name ?? ""]).catch(() => undefined);
      await dismissGap(ws, g.name ?? "");
      void qc.invalidateQueries({ queryKey: overviewKeys.gaps(ws) });
      invalidate();
      onClose();
      toast(`Saved to ${base}. People get this answer now.`, {
        undo: () =>
          void Promise.all([deleteItem(ws, doc.name ?? ""), reopenGap(ws, g.name ?? "")]).then(
            () => {
              void qc.invalidateQueries({ queryKey: overviewKeys.gaps(ws) });
              invalidate();
            },
            (e: unknown) => toast(errorMessage(e), { tone: "danger" }),
          ),
      });
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      isOpen
      onClose={onClose}
      guard={busy}
      size="md"
      icon={MessageSquarePlus}
      title="Answer a frequent question"
      description="Your answer becomes a short FAQ the assistant cites from now on."
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void save()} isPending={busy}>
            <Check className="i" aria-hidden />
            Save answer
          </Button>
        </>
      }
    >
      <div className="ov-gap-q">
        <span className="ov-gap-n">{g.askCount ?? 0}×</span>
        <span className="stack gap-2">
          <span translate="no">“{g.question}”</span>
          {WHY[g.reason ?? ""] ? (
            <span className="t-sm muted" style={{ fontWeight: 400 }}>
              {WHY[g.reason ?? ""]}
            </span>
          ) : null}
        </span>
      </div>
      <TextField value={text} onChange={setText} isRequired isInvalid={Boolean(error)} isDisabled={busy}>
        <Label>Answer</Label>
        <TextArea ref={ref} rows={6} autoFocus placeholder="A short, direct answer. Name the rule or office it comes from." />
        {error ? <FieldError>{error}</FieldError> : <Description>Saved to {base} as an FAQ document.</Description>}
      </TextField>
    </Dialog>
  );
}
