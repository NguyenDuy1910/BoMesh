"use client";

import { Button, Description, FieldError, Label, TextArea, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Clock, Lock } from "lucide-react";
import { useRef, useState } from "react";

import { ChoiceGroup } from "@/components/ui/ChoiceGroup";
import { StatusChip } from "@/components/ui/StatusChip";
import { Tip } from "@/components/ui/Tip";
import { toast } from "@/components/ui/Toast";
import { errorMessage } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { KnowledgeModal } from "../../components/KnowledgeModal";
import { createAccessRequest } from "../api";
import type { Item } from "../model";
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
  const error = touched && !note.trim() ? "Tell the owners why you need access." : "";
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
      toast(`Request sent to the owners of ${base.displayName ?? ""}`);
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
      size="sm"
      title="Request access"
      description={
        <>
          <span translate="no">{base.displayName}</span>
          {owners ? ` · ${owners}` : null}
        </>
      }
      footer={
        <>
          <Button variant="tertiary" onPress={close} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void send()} isPending={busy}>
            Send request
          </Button>
        </>
      }
    >
      <div className="field">
        <span className="label">Access you need</span>
        <ChoiceGroup
          label="Access you need"
          value={role}
          onChange={setRole}
          isDisabled={busy}
          options={[
            { value: "viewer", title: "View", description: "Search and read its documents." },
            { value: "editor", title: "Edit", description: "Also add and organize documents." },
          ]}
        />
      </div>
      <TextField className="mt-16" value={note} onChange={setNote} isRequired isInvalid={!!error} isDisabled={busy}>
        <Label>Reason</Label>
        <TextArea ref={noteRef} rows={3} placeholder="e.g. I need the renewal terms for a customer call" />
        {error ? <FieldError>{error}</FieldError> : <Description>The owners see this with your request.</Description>}
      </TextField>
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
  if (mine.data) return <StatusChip label="Pending" tone="warning" icon={Clock} size={size === "sm" ? "sm" : "md"} />;
  if (!hasModule("requests")) {
    return (
      <Tip content="Access requests are turned off in this workspace. Ask an owner directly.">
        <Button size={size} variant={variant} isDisabled>
          <Lock className="i" aria-hidden />
          Request access
        </Button>
      </Tip>
    );
  }
  return (
    <>
      <Button size={size} variant={variant} onPress={() => setOpen(true)} isDisabled={mine.isPending}>
        <Lock className="i" aria-hidden />
        Request access
      </Button>
      <RequestAccessDialog base={base} isOpen={open} onOpenChange={setOpen} />
    </>
  );
}
