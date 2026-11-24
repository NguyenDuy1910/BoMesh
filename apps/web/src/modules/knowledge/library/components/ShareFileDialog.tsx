"use client";

import { Button, Description, Label, ListBox, Select, TextArea, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Send, Share } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { toast } from "@/components/ui/Toast";
import { errorMessage } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { createContribution } from "../../api";
import { KnowledgeModal } from "../../components/KnowledgeModal";
import type { Resource } from "../../model";
import { invalidateKnowledge, useContributionTargets } from "../../queries";
import { contributionHref } from "../contributions";

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
      toast(`Đã gửi duyệt “${resource.title}”`, { action: { label: "Mở", onPress: () => router.push(contributionHref(c.name)) } });
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
      title="Chia sẻ vào kho tài liệu"
      icon={Share}
      description={<span translate="no">{resource.title}</span>}
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Hủy
          </Button>
          <Button variant="primary" onPress={() => void send()} isPending={busy}>
            <Send className="i" aria-hidden />
            Gửi duyệt
          </Button>
        </>
      }
    >
      <div className="stack gap-16">
        <Select value={kb || SUGGEST} onChange={(v) => setKb(v === SUGGEST ? "" : String(v))}>
          <Label>Kho tài liệu</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Description>{target ? `Do chủ sở hữu ${target.displayName} duyệt.` : "Trợ lý chọn mục phù hợp nhất. Người duyệt sẽ xác nhận."}</Description>
          <Select.Popover>
            <ListBox>
              <ListBox.Item id={SUGGEST} textValue="Để trợ lý đề xuất">
                Để trợ lý đề xuất
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
            Ghi chú cho người duyệt<span className="label__opt">(không bắt buộc)</span>
          </Label>
          <TextArea rows={2} />
        </TextField>
        <p className="t-xs muted">Tệp sẽ rời khỏi Tệp của tôi. Cho đến khi được công bố, chỉ bạn và người duyệt xem được.</p>
      </div>
    </KnowledgeModal>
  );
}
