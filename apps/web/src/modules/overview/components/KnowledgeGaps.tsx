"use client";

import { Button, Description, FieldError, Label, TextArea, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Pencil, Upload, X } from "lucide-react";
import { useRef, useState } from "react";

import { EmptyState, ErrorState, IconButton, List, ListItem, SkeletonRows, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { deleteItem, uploadDocument } from "@/modules/knowledge/api";
import { openContribute } from "@/modules/knowledge/components/Contribute";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";
import { useItemPermissions, useKnowledgeModel } from "@/modules/knowledge/queries";
import { createIngestionRun } from "@/modules/curation/api";
import { PanelCard } from "@/modules/curation/components/parts";
import { useInvalidateCuration } from "@/modules/curation/queries";

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

/** Knowledge gaps (preview `gapsCard`): the most asked questions knowledge couldn't answer well. */
export function KnowledgeGaps() {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const gaps = useGaps();
  const [answering, setAnswering] = useState<KnowledgeGap | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: overviewKeys.gaps(ws) });

  const dismiss = async (g: KnowledgeGap) => {
    try {
      await dismissGap(ws, g.name ?? "");
      refresh();
      toast("Gap dismissed", {
        undo: () =>
          void reopenGap(ws, g.name ?? "").then(refresh, (error: unknown) => toast(errorMessage(error), { tone: "danger" })),
      });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    }
  };

  const top = [...(gaps.data ?? [])].sort((a, b) => (b.askCount ?? 0) - (a.askCount ?? 0)).slice(0, 4);
  return (
    <PanelCard title="Knowledge gaps" description="Frequent questions knowledge couldn’t answer well.">
      {gaps.isPending ? (
        <SkeletonRows rows={3} />
      ) : gaps.isError ? (
        <ErrorState error={gaps.error} onRetry={() => void gaps.refetch()} boxed={false} />
      ) : top.length ? (
        <List plain className="ov-gaps">
          {top.map((g) => (
            <GapRow key={g.name} gap={g} onDismiss={() => void dismiss(g)} onAnswer={() => setAnswering(g)} />
          ))}
        </List>
      ) : (
        <EmptyState icon={CircleCheck} tone="success" compact title="No gaps this week" description="Frequent questions found good answers." />
      )}
      <AnswerGapDialog gap={answering} onClose={() => setAnswering(null)} />
    </PanelCard>
  );
}

function GapRow({ gap: g, onDismiss, onAnswer }: { gap: KnowledgeGap; onDismiss: () => void; onAnswer: () => void }) {
  const { ctx } = useKnowledgeModel();
  const kb = g.suggestedCollection ? (ctx.collectionNames?.get(g.suggestedCollection) ?? "") : "";
  const perms = useItemPermissions(g.suggestedCollection);
  const edit = !!g.suggestedCollection && perms.can("items.create");
  const why = WHY[g.reason ?? ""] ?? "";
  return (
    <ListItem
      lead={
        <span className="ov-gap-n" title="Times asked">
          {g.askCount ?? 0}×
        </span>
      }
      title={<span translate="no">“{g.question}”</span>}
      description={
        <>
          <span className="ov-line">{[kb, why].filter(Boolean).join(" · ")}</span>
          <span className="ov-gap-actions">
            {edit ? (
              <Button variant="secondary" size="sm" onPress={onAnswer}>
                <Pencil className="i" aria-hidden />
                Answer it
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onPress={() => openContribute(g.suggestedCollection ? { collection: g.suggestedCollection } : {})}>
              <Upload className="i" aria-hidden />
              Add documents
            </Button>
          </span>
        </>
      }
      actions={<IconButton icon={X} tip="Dismiss" size="sm" onPress={onDismiss} />}
    />
  );
}

/**
 * Answer a gap (preview `M['ov-gap-answer']`): the answer becomes a FAQ document in the suggested
 * knowledge base and is published for the assistant to cite; the gap leaves the list.
 */
function AnswerGapDialog({ gap, onClose }: { gap: KnowledgeGap | null; onClose: () => void }) {
  return gap ? <AnswerForm key={gap.name} gap={gap} onClose={onClose} /> : null;
}

function AnswerForm({ gap: g, onClose }: { gap: KnowledgeGap; onClose: () => void }) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const invalidate = useInvalidateCuration();
  const { ctx } = useKnowledgeModel();
  const [text, setText] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const kb = ctx.collectionNames?.get(g.suggestedCollection ?? "") ?? "the knowledge base";
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
      const body = `# ${(g.question ?? "").trim()}\n\n${answer}\n`;
      const doc = await uploadDocument(ws, {
        parentItem: g.suggestedCollection ?? "",
        file: new File([body], name, { type: "text/markdown" }),
        displayName: name.replace(/\.md$/, ""),
        document: { documentType: "faq" },
      });
      await createIngestionRun(ws, [doc.name ?? ""]).catch(() => undefined);
      await dismissGap(ws, g.name ?? "");
      void qc.invalidateQueries({ queryKey: overviewKeys.gaps(ws) });
      invalidate();
      onClose();
      toast(`Saved to ${kb}. People get this answer now.`, {
        undo: () =>
          void Promise.all([deleteItem(ws, doc.name ?? ""), reopenGap(ws, g.name ?? "")]).then(
            () => {
              void qc.invalidateQueries({ queryKey: overviewKeys.gaps(ws) });
              invalidate();
              toast("Answer removed", { tone: "accent" });
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
    <KnowledgeModal
      isOpen
      onClose={onClose}
      guard={busy}
      size="md"
      title="Answer a frequent question"
      footer={
        <>
          <Button variant="tertiary" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void save()} isPending={busy}>
            Save answer
          </Button>
        </>
      }
    >
      <div className="ov-gap-q">
        <span className="ov-gap-n">{g.askCount ?? 0}×</span>
        <span translate="no">“{g.question}”</span>
      </div>
      <TextField value={text} onChange={setText} isRequired isInvalid={!!error} isDisabled={busy}>
        <Label>Answer</Label>
        <TextArea ref={ref} rows={6} autoFocus placeholder="A short, direct answer. Name the rule or office it comes from." />
        {error ? (
          <FieldError>{error}</FieldError>
        ) : (
          <Description>
            Saved to {kb} as <span className="medium">{name}</span>. The assistant cites it from now on.
          </Description>
        )}
      </TextField>
    </KnowledgeModal>
  );
}
