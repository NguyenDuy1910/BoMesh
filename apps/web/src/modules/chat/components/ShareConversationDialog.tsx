"use client";

import { Button, Description, FieldError, Input, Label, ListBox, Modal, Select, TextField, type Key } from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Lock } from "lucide-react";
import { useEffect, useState } from "react";

import { Callout } from "@/components/ui/Callout";
import { toast } from "@/components/ui/Toast";
import { errorMessage } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { listMembers } from "@/modules/search/api";

import { chatKeys, createShare, deleteShare, shareHref, type Share } from "../api";
import { copyText } from "../download";
import { useShares } from "../queries";

type Audience = Share["audience"];

const linkOf = (share: Share) => `${window.location.origin}${shareHref(share)}`;
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Share a conversation (preview `M['chat-share']`, conversation_loop.md "Sharing"):
 * one live link per conversation, for everyone in the workspace or chosen
 * people. Changing who can open it makes a new link (the old one stops
 * working). The API refuses an audience that can't read every cited source;
 * its message is shown as is.
 */
export function ShareConversationDialog({ conversation, title, isOpen, onClose }: { conversation: string; title: string; isOpen: boolean; onClose: () => void }) {
  const { id: ws, workspace, memberId } = useWorkspace();
  const queryClient = useQueryClient();
  const shares = useShares(conversation, { enabled: isOpen });
  const current = shares.data?.[0] ?? null;
  const members = useQuery({ queryKey: [ws, "members", "all"], queryFn: () => listMembers(ws), enabled: isOpen, staleTime: 60_000 });
  const [who, setWho] = useState<Audience>("WORKSPACE");
  const [people, setPeople] = useState<string[]>([]);
  const [fieldError, setFieldError] = useState("");
  const [refusal, setRefusal] = useState("");
  const [busy, setBusy] = useState<"copy" | "stop" | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setFieldError("");
    setRefusal("");
  }, [isOpen]);
  useEffect(() => {
    if (!current) return;
    setWho(current.audience);
    setPeople(current.recipients ?? []);
  }, [current]);

  const changed = !current || current.audience !== who || (who === "PEOPLE" && !sameSet(current.recipients ?? [], people));
  const link = current && !changed ? linkOf(current) : "";
  const others = (members.data ?? []).filter((m) => m.name && !m.name.endsWith(`/members/${memberId}`));

  const copy = async () => {
    if (who === "PEOPLE" && !people.length) {
      setFieldError("Add at least one person.");
      return;
    }
    setFieldError("");
    setRefusal("");
    setBusy("copy");
    try {
      let share = current;
      if (changed) {
        share = await createShare(ws, conversation, { audience: who, ...(who === "PEOPLE" ? { recipients: people } : {}) });
        queryClient.setQueryData(chatKeys.shares(ws, conversation), [share]);
      }
      const ok = share ? await copyText(linkOf(share), who === "PEOPLE" ? "Link copied. Only the people you chose can open it." : "Link copied") : false;
      if (ok) onClose();
    } catch (error) {
      setRefusal(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    if (!current?.name) return;
    setBusy("stop");
    try {
      await deleteShare(ws, conversation, current.name.slice(current.name.lastIndexOf("/") + 1));
      queryClient.setQueryData(chatKeys.shares(ws, conversation), []);
      toast("Link turned off. People who had it can no longer open it.");
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Modal.Container>
        <Modal.Dialog>
          <Modal.CloseTrigger aria-label="Close" />
          <Modal.Header>
            <Modal.Heading>Share conversation</Modal.Heading>
            <p className="modal__description truncate" translate="no">
              {title}
            </p>
          </Modal.Header>
          <Modal.Body>
            <div className="stack gap-16">
              <Select
                fullWidth
                value={who}
                onChange={(key: Key | null) => {
                  if (!key) return;
                  setWho(key as Audience);
                  setFieldError("");
                  setRefusal("");
                }}
              >
                <Label>Who can open the link</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id="WORKSPACE" textValue={`Anyone in ${workspace.displayName ?? "the workspace"}`}>
                      Anyone in {workspace.displayName ?? "the workspace"}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                    <ListBox.Item id="PEOPLE" textValue="Only people I choose">
                      Only people I choose
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  </ListBox>
                </Select.Popover>
              </Select>
              {who === "PEOPLE" ? (
                <Select
                  fullWidth
                  selectionMode="multiple"
                  value={people}
                  onChange={(keys: Key[]) => {
                    setPeople(keys.map(String));
                    setFieldError("");
                  }}
                  isInvalid={!!fieldError}
                  placeholder={members.isPending ? "Loading people…" : "Choose people"}
                >
                  <Label>People</Label>
                  <Select.Trigger>
                    <Select.Value>{({ isPlaceholder, selectedText, defaultChildren }) => (isPlaceholder ? defaultChildren : <span className="truncate" translate="no">{selectedText}</span>)}</Select.Value>
                    <Select.Indicator />
                  </Select.Trigger>
                  <FieldError>{fieldError || (members.isError ? errorMessage(members.error) : "")}</FieldError>
                  <Select.Popover>
                    <ListBox>
                      {others.map((m) => (
                        <ListBox.Item key={m.name} id={m.name!} textValue={m.displayName || m.email || ""}>
                          <span className="grow stack" translate="no">
                            <span className="truncate">{m.displayName || m.email}</span>
                            {m.email && m.displayName ? <span className="t-xs muted truncate">{m.email}</span> : null}
                          </span>
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              ) : null}
              <TextField fullWidth value={link} isReadOnly>
                <Label>Link</Label>
                <Input className="mono" placeholder={current && changed ? "Copy link to make a new one" : "Copy link to create it"} />
                {current && changed ? <Description>The current link stops working when you copy the new one.</Description> : null}
              </TextField>
              {refusal ? <Callout tone="danger" title="This conversation can’t be shared with them" description={refusal} /> : null}
            </div>
            <p className="chat-hint mt-16">
              <Lock className="i i-xs" aria-hidden />
              <span>People see the answers, but only open sources they already have access to.</span>
            </p>
          </Modal.Body>
          <Modal.Footer>
            {current ? (
              <Button variant="danger-soft" className="mr-auto" isPending={busy === "stop"} onPress={() => void stop()}>
                Stop sharing
              </Button>
            ) : null}
            <Button variant="secondary" onPress={onClose}>
              Done
            </Button>
            <Button variant="primary" isPending={busy === "copy"} isDisabled={shares.isPending} onPress={() => void copy()}>
              <Copy className="i" aria-hidden />
              Copy link
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
