"use client";

import { Button, Description, Label, ListBox, Select, TextArea, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { toast } from "@/components/ui/Toast";
import { errorMessage, resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { createContribution } from "../../api";
import { KnowledgeModal } from "../../components/KnowledgeModal";
import type { Resource } from "../../model";
import { invalidateKnowledge, useContributionTargets } from "../../queries";

const SUGGEST = "suggest";

/** Share a private file as knowledge: a review request for the same document, no copy (preview `M['ctb-share']`). */
export function ShareFileDialog({ resource, onClose }: { resource: Resource; onClose: () => void }) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const router = useRouter();
  const targets = useContributionTargets();
  const [kb, setKb] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const target = targets.data.find((t) => t.name === kb);

  async function send() {
    setBusy(true);
    try {
      const c = await createContribution(ws, { kind: "NEW_DOCUMENT", item: resource.name, targetCollection: kb || undefined, note: note.trim() || undefined });
      invalidateKnowledge(qc, ws);
      onClose();
      toast("Sent for review", { action: { label: "Track", onPress: () => router.push(`/knowledge/library?tab=contributions&open=${resourceId(c.name)}`) } });
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      size="sm"
      guard={busy}
      title="Share as knowledge"
      description={<span translate="no">{resource.title}</span>}
      footer={
        <>
          <Button variant="tertiary" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void send()} isPending={busy}>
            <Send className="i" aria-hidden />
            Send for review
          </Button>
        </>
      }
    >
      <div className="stack gap-16">
        <Select value={kb || SUGGEST} onChange={(v) => setKb(v === SUGGEST ? "" : String(v))}>
          <Label>Knowledge base</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Description>{target ? `Reviewed by the owners of ${target.displayName}.` : "The assistant picks the best fit. A reviewer confirms it."}</Description>
          <Select.Popover>
            <ListBox>
              <ListBox.Item id={SUGGEST} textValue="Let the assistant suggest">
                Let the assistant suggest
                <ListBox.ItemIndicator />
              </ListBox.Item>
              {targets.data.map((t) => (
                <ListBox.Item key={t.name} id={t.name ?? ""} textValue={t.displayName ?? ""}>
                  <span translate="no">{t.displayName}</span>
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        <TextField value={note} onChange={setNote} maxLength={400}>
          <Label>
            Note for reviewers<span className="label__opt">(optional)</span>
          </Label>
          <TextArea rows={2} />
        </TextField>
        <p className="t-xs muted">It moves out of My files. Until it’s published, only you and the reviewers can see it.</p>
      </div>
    </KnowledgeModal>
  );
}
