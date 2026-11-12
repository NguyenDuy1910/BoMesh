"use client";

import { Button, Description, Label, TextArea, TextField } from "@heroui/react";
import { Send, UserPlus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";

import { decideRequest, requestToJoin } from "../api";
import { invalidateSpaces } from "../queries";
import { isStaffRole, spaceType, type Space } from "../types";

export interface JoinSpaceDialogProps {
  space: Space | null;
  onClose: () => void;
}

/** Ask to join (preview `M['sp-join']`): a SPACE_MEMBERSHIP request with an optional note. */
export function JoinSpaceDialog({ space, onClose }: JoinSpaceDialogProps) {
  const { id: ws, settings } = useWorkspace();
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // Who reviews it (preview `reviewers`): the space's staff roles ("The lead"); member names aren't readable from outside.
  const type = spaceType(space?.spaceType, settings);
  const reviewers = `The ${type.roles
    .filter(([key]) => isStaffRole(key))
    .map(([, label]) => label.toLowerCase())
    .join(" or ")}`;

  async function send() {
    if (!space) return;
    setBusy(true);
    try {
      const req = await requestToJoin(ws, resourceId(space.name), note.trim());
      void invalidateSpaces(qc, ws);
      setNote("");
      onClose();
      toast(`Request sent to ${reviewers.toLowerCase()}`, {
        undo: () =>
          void decideRequest(req.name ?? "", "withdraw")
            .then(() => invalidateSpaces(qc, ws))
            .catch((e) => toast(errorMessage(e), { tone: "danger" })),
      });
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <KnowledgeModal
      isOpen={!!space}
      onClose={onClose}
      guard={busy}
      icon={UserPlus}
      title={
        <>
          Ask to join <span translate="no">{space?.displayName}</span>
        </>
      }
      description={`${reviewers} will review it. You’ll get in as soon as it’s approved.`}
      footerStart={<span>You can withdraw it any time.</span>}
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void send()} isPending={busy}>
            <Send aria-hidden />
            Send request
          </Button>
        </>
      }
    >
      <TextField value={note} onChange={setNote} maxLength={300} autoFocus>
        <Label>
          Note <span className="label__opt">(optional)</span>
        </Label>
        <Description>Say who you are and what you’d like to work on.</Description>
        <TextArea rows={3} />
      </TextField>
    </KnowledgeModal>
  );
}
