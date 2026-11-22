"use client";

import { Button, InputGroup, Label, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { AlertCircle, Building2, Copy, Lock, MessageSquare, Share, Users, X } from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";

import { ChoiceGroup, IconButton, ItemIcon, toast, UserAvatar } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";

import { createShare, deleteShare, shareKeys, type Share as ShareResource } from "@/modules/shares/api";
import { shareUrl } from "@/modules/shares/model";

import { copyText } from "../download";
import { useMembers, useMyConversationShare, useShareSummary } from "../queries";

type Audience = Exclude<ShareResource["audience"], "ANYONE" | undefined>;

/** The URL people open: this site's origin + the share's `uri` (`/s/{share}`). */
const linkOf = (share: ShareResource) => shareUrl(window.location.origin, share.uri) ?? "";
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

export interface ShareConversationDialogProps {
  conversation: string;
  title: string;
  /** Questions asked so far and the last activity, for the context row. */
  questions: number;
  updated?: string;
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Share a conversation (preview `M['chat-share']`, "Resource shares"): one live SHARE of the conversation, to anyone in
 * the workspace or only people you choose; they read it as it grows at `/chat/[id]`, read-only. The dialog edits a
 * draft (Cancel discards it); Share saves it and copies the link; Update sharing revokes the old share and makes a new
 * one (new link); Stop sharing revokes it (final).
 */
export function ShareConversationDialog({ conversation, title, questions, updated, isOpen, onClose }: ShareConversationDialogProps) {
  const { id: ws, workspace, memberId } = useWorkspace();
  const queryClient = useQueryClient();
  const mine = useMyConversationShare(conversation, { enabled: isOpen });
  const summary = useShareSummary(conversation, { enabled: isOpen });
  const current = mine.share;
  const members = useMembers({ enabled: isOpen });
  const [who, setWho] = useState<Audience>("WORKSPACE");
  const [people, setPeople] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const wsName = workspace.displayName ?? "the workspace";

  useEffect(() => {
    if (!isOpen) return;
    setTouched(false);
    setQ("");
    setWho(current?.audience === "PEOPLE" ? "PEOPLE" : "WORKSPACE");
    setPeople(current?.recipients ?? []);
  }, [isOpen, current]);

  const nameOf = (member: string) => members.data?.find((m) => m.name === member)?.displayName || "Someone";
  const names = (list: readonly string[]) => {
    const n = list.map(nameOf);
    return n.length <= 2 ? n.join(" and ") : `${n[0]}, ${n[1]} and ${n.length - 2} more`;
  };
  const needle = q.trim().toLowerCase();
  const matches = needle
    ? (members.data ?? [])
        .filter((m) => m.name && resourceId(m.name) !== memberId && m.state !== "SUSPENDED" && !people.includes(m.name))
        .filter((m) => (m.displayName ?? "").toLowerCase().includes(needle) || (m.email ?? "").toLowerCase().includes(needle))
        .slice(0, 5)
    : [];
  const error = who === "PEOPLE" && touched && !people.length ? "Add at least one person." : "";
  const shared = !!current;
  const changed = !current || current.audience !== who || (who === "PEOPLE" && !sameSet(current.recipients ?? [], people));

  const add = (member: string) => {
    setPeople((list) => (list.includes(member) ? list : [...list, member]));
    setQ("");
    requestAnimationFrame(() => document.getElementById("chat-share-q")?.focus());
  };

  const save = async () => {
    if (who === "PEOPLE" && !people.length) {
      setTouched(true);
      document.getElementById("chat-share-q")?.focus();
      return;
    }
    if (current && !changed) {
      if (await copyText(linkOf(current), "Link copied")) onClose();
      return;
    }
    setBusy(true);
    try {
      if (current?.name) await deleteShare(current.name);
      const share = await createShare(ws, {
        kind: "SHARE",
        target: `workspaces/${ws}/conversations/${conversation}`,
        audience: who,
        ...(who === "PEOPLE" ? { recipients: people } : {}),
      });
      void queryClient.invalidateQueries({ queryKey: shareKeys.all(ws) });
      onClose();
      const message = current ? "Sharing updated. The new link is copied; the old one no longer opens." : who === "PEOPLE" ? `Shared with ${names(people)}. Link copied.` : `Shared with everyone in ${wsName}. Link copied.`;
      await copyText(linkOf(share), message);
    } catch (e) {
      if (current) void queryClient.invalidateQueries({ queryKey: shareKeys.all(ws) });
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!current?.name) return;
    setBusy(true);
    try {
      await deleteShare(current.name);
      void queryClient.invalidateQueries({ queryKey: shareKeys.all(ws) });
      onClose();
      toast("Stopped sharing. The link no longer opens.");
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (matches[0]?.name) add(matches[0].name);
      else void save();
    } else if (e.key === "Backspace" && !q && people.length) setPeople(people.slice(0, -1));
  };

  return (
    <KnowledgeModal
      isOpen={isOpen}
      onClose={onClose}
      icon={Share}
      title="Share conversation"
      description="They read it as it grows, without replying. Answers and sources they can’t open stay hidden."
      guard={busy}
      footerStart={
        shared ? (
          <Button variant="danger-soft" isDisabled={busy} onPress={() => void stop()}>
            Stop sharing
          </Button>
        ) : null
      }
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" isPending={busy} isDisabled={mine.isPending} onPress={() => void save()}>
            {!shared || changed ? <Share className="i" aria-hidden /> : <Copy className="i" aria-hidden />}
            {!shared ? "Share" : changed ? "Update sharing" : "Copy link"}
          </Button>
        </>
      }
    >
      <div className="chat-ctx">
        <ItemIcon icon={MessageSquare} size="sm" />
        <div className="grow">
          <div className="chat-ctx__title truncate" translate="no">
            {title}
          </div>
          <div className="t-xs muted truncate">{`${plural(questions, "question")}${updated ? ` · Updated ${rel(updated).toLowerCase()}` : ""}`}</div>
        </div>
      </div>
      {current && summary ? (
        <div className="chat-share__status">
          {current.audience === "PEOPLE" ? <Users className="i i-sm" aria-hidden /> : <Building2 className="i i-sm" aria-hidden />}
          <span className="grow">{summary}</span>
          <span className="t-xs muted none">{rel(current.createTime)}</span>
        </div>
      ) : null}
      <div className="field">
        <span className="label">Who can open it</span>
        <ChoiceGroup<Audience>
          label="Who can open it"
          value={who}
          onChange={(v) => {
            setWho(v);
            setTouched(false);
            if (v === "PEOPLE") requestAnimationFrame(() => document.getElementById("chat-share-q")?.focus());
          }}
          options={[
            { value: "WORKSPACE", title: `Anyone in ${wsName}`, description: "Everyone who can sign in to this workspace.", icon: Building2 },
            { value: "PEOPLE", title: "Only people you choose", description: "Only the people you add below.", icon: Lock },
          ]}
        />
      </div>
      {who === "PEOPLE" ? (
        <div className="field">
          <label className="label" htmlFor="chat-share-q">
            People
          </label>
          <div className={clsx("chat-share__box", error && "is-invalid")}>
            {people.map((p) => (
              <span key={p} className="chat-share__chip">
                <UserAvatar name={nameOf(p)} size="xs" />
                <span className="truncate" translate="no">
                  {nameOf(p)}
                </span>
                <button type="button" className="chat-share__x" aria-label={`Remove ${nameOf(p)}`} onClick={() => setPeople(people.filter((x) => x !== p))}>
                  <X className="i i-xs" aria-hidden />
                </button>
              </span>
            ))}
            <input
              id="chat-share-q"
              className="chat-share__input"
              type="text"
              value={q}
              placeholder={people.length ? "Add another person" : "Search people by name or email"}
              autoComplete="off"
              role="combobox"
              aria-expanded={matches.length > 0}
              aria-controls="chat-share-opts"
              aria-invalid={!!error || undefined}
              aria-describedby={error ? "chat-share-q-err" : undefined}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKey}
            />
          </div>
          {matches.length ? (
            <div className="chat-share__opts" id="chat-share-opts" role="listbox" aria-label="People">
              {matches.map((m) => (
                <button key={m.name} type="button" className="chat-share__opt" role="option" aria-selected={false} onClick={() => add(m.name!)}>
                  <UserAvatar name={m.displayName || m.email || ""} size="sm" />
                  <span className="grow" translate="no">
                    <span className="chat-share__name">{m.displayName || m.email}</span>
                    {m.email && m.displayName ? <span className="t-xs muted truncate">{m.email}</span> : null}
                  </span>
                </button>
              ))}
            </div>
          ) : needle && !members.isPending ? (
            <div className="description">{`No one in ${wsName} matches “${q.trim()}”.`}</div>
          ) : null}
          {error ? (
            <div className="field-error" id="chat-share-q-err" role="alert">
              <AlertCircle className="i" aria-hidden />
              <span>{error}</span>
            </div>
          ) : null}
        </div>
      ) : null}
      {current ? (
        <TextField fullWidth value={linkOf(current)} isReadOnly>
          <Label>Link</Label>
          <InputGroup fullWidth>
            <InputGroup.Input className="mono" />
            <InputGroup.Suffix>
              <IconButton icon={Copy} tip="Copy link" size="sm" onPress={() => void copyText(linkOf(current), "Link copied")} />
            </InputGroup.Suffix>
          </InputGroup>
          {changed ? <div className="description">Saving makes a new link. This one stops opening.</div> : null}
        </TextField>
      ) : null}
    </KnowledgeModal>
  );
}
