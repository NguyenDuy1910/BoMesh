"use client";

import { Button, Description, FieldError, Label, TextArea, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Clock, Eye, Lock, Pencil, Send, Users } from "lucide-react";
import { useRef, useState } from "react";

import { ChoiceGroup } from "@/components/ui/ChoiceGroup";
import { StatusChip } from "@/components/ui/StatusChip";
import { Tip } from "@/components/ui/Tip";
import { toast } from "@/components/ui/Toast";
import { errorMessage } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { KnowledgeModal } from "../../components/KnowledgeModal";
import { createAccessRequest } from "../api";
import { ROLE_DESC, ROLE_LABEL, type Item } from "../model";
import { basesKeys, useMyAccessRequest } from "../queries";
import { ownersLabel } from "./parts";

export interface RequestAccessDialogProps {
  /** The base (a LOCKED projection is enough). */
  base: Item;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Preview `M['kb-request']`: access you need (View / Edit) and a required reason for the owners. */
export function RequestAccessDialog({ base, isOpen, onOpenChange }: RequestAccessDialogProps) {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const error = touched && !note.trim() ? "Cho chủ sở hữu biết lý do bạn cần quyền truy cập." : "";
  const owners = ownersLabel(base);

  function close() {
    onOpenChange(false);
    setRole("viewer");
    setNote("");
    setTouched(false);
  }

  async function send() {
    if (busy) return;
    setTouched(true);
    if (!note.trim()) {
      noteRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      await createAccessRequest(id, { base, role, reason: note.trim() });
      await qc.invalidateQueries({ queryKey: basesKeys.requests(id) });
      close();
      toast(`Đã gửi yêu cầu đến chủ sở hữu của ${base.displayName ?? ""}`);
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <KnowledgeModal
      isOpen={isOpen}
      onClose={close}
      guard={busy}
      size="md"
      icon={Lock}
      title="Yêu cầu quyền truy cập"
      description={`Hãy đề nghị chủ sở hữu ${base.displayName ?? ""} chia sẻ với bạn.`}
      footerStart={
        owners ? (
          <span className="row gap-6 t-xs muted">
            <Users className="i i-sm" aria-hidden />
            <span>{owners}</span>
          </span>
        ) : undefined
      }
      footer={
        <>
          <Button variant="ghost" onPress={close} isDisabled={busy}>
            Hủy
          </Button>
          <Button variant="primary" onPress={() => void send()} isPending={busy}>
            {busy ? null : <Send className="i" aria-hidden />}
            Gửi yêu cầu
          </Button>
        </>
      }
    >
      <div className="kn-form">
        <div className="field kb-req-access">
          <span className="label">Quyền truy cập bạn cần</span>
          <ChoiceGroup
            label="Quyền truy cập bạn cần"
            columns={2}
            value={role}
            onChange={setRole}
            isDisabled={busy}
            options={[
              { value: "viewer", title: ROLE_LABEL.viewer, description: ROLE_DESC.viewer, icon: Eye },
              { value: "editor", title: ROLE_LABEL.editor, description: ROLE_DESC.editor, icon: Pencil },
            ]}
          />
        </div>
        <TextField className="field" value={note} onChange={setNote} isRequired isInvalid={!!error} isDisabled={busy}>
          <Label>Lý do</Label>
          <TextArea ref={noteRef} rows={3} maxLength={300} placeholder="VD: Tôi cần giờ chốt quyết toán để rà soát sự cố" />
          {error ? <FieldError>{error}</FieldError> : <Description>Chủ sở hữu sẽ thấy nội dung này cùng yêu cầu của bạn.</Description>}
        </TextField>
      </div>
    </KnowledgeModal>
  );
}

/**
 * Locked base call to action (preview list card / locked page): "Request access", or the
 * "Pending" chip once the caller asked. Unavailable while the Requests module is off.
 */
export function RequestAccessCta({ base, variant = "secondary", size = "sm" }: { base: Item; variant?: "primary" | "secondary"; size?: "sm" | "md" }) {
  const { hasModule } = useWorkspace();
  const mine = useMyAccessRequest(base.name);
  const [open, setOpen] = useState(false);
  if (mine.data) return <StatusChip label="Đang chờ" tone="warning" icon={Clock} size={size === "sm" ? "sm" : "md"} />;
  if (!hasModule("requests")) {
    return (
      <Tip content="Yêu cầu quyền truy cập đang tắt trong không gian làm việc này. Hãy hỏi trực tiếp chủ sở hữu.">
        <Button size={size} variant={variant} isDisabled>
          <Lock className="i" aria-hidden />
          Yêu cầu quyền truy cập
        </Button>
      </Tip>
    );
  }
  return (
    <>
      <Button size={size} variant={variant} onPress={() => setOpen(true)} isDisabled={mine.isPending}>
        <Lock className="i" aria-hidden />
        Yêu cầu quyền truy cập
      </Button>
      <RequestAccessDialog base={base} isOpen={open} onOpenChange={setOpen} />
    </>
  );
}
