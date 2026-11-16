"use client";

import { Button, Description, FieldError, Input, Label, TextField } from "@heroui/react";
import { FolderPlus, Plus, Tag } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";

import { toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";

import { createTopic, deleteTopic, type Topic } from "../../api";
import { activeDomains, cleanName, nameTaken } from "../../governance";
import { useInvalidateCuration, useRememberTopic } from "../../queries";
import { PlainSelect } from "../parts";
import { addTerms, ChipField } from "./TopicSignals";

/** What the dialog makes: a domain, or a topic in `parent` (a domain's resource name). */
export interface NewNodeRequest {
  kind: "domain" | "topic";
  parent: string;
}

interface NewNodeDialogProps {
  request: NewNodeRequest | null;
  topics: readonly Topic[];
  onClose: () => void;
  /** Selects a node (`?node=`): the new one once it's made, or where Undo leaves you. */
  onSelect: (id: string) => void;
}

/**
 * New domain / New topic (preview `M['tx-new']`): a small dialog with just what a node needs to exist — a name, and
 * for a topic its domain and a few keywords. Everything else is edited in the detail, which opens on the new node.
 */
export function NewNodeDialog({ request, ...rest }: NewNodeDialogProps) {
  return request ? <NewNodeForm key={`${request.kind}:${request.parent}`} request={request} {...rest} /> : null;
}

function NewNodeForm({ request, topics, onClose, onSelect }: Omit<NewNodeDialogProps, "request"> & { request: NewNodeRequest }) {
  const { id: ws } = useWorkspace();
  const invalidate = useInvalidateCuration();
  const remember = useRememberTopic();
  const domains = activeDomains(topics);
  const isDomain = request.kind === "domain";
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [parent, setParent] = useState(request.parent || domains[0]?.name || "");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const clean = cleanName(name);
  const parentName = domains.find((d) => d.name === parent)?.displayName ?? "";
  const err: { name?: string; parent?: string } = {};
  if (!clean) err.name = "Enter a name.";
  else if (nameTaken(topics, clean, isDomain ? null : parent)) err.name = isDomain ? `A domain called “${clean}” already exists.` : `${parentName} already has “${clean}”.`;
  if (!isDomain && !parentName) err.parent = "Choose a domain.";
  const shown = tried ? err : {};

  const addTyped = (text: string) => addTerms({ keywords, synonyms: [] }, "keywords", text);

  const create = async () => {
    if (busy) return;
    // Words still typed in the keyword field count: nobody expects Create to drop them.
    const kw = isDomain ? [] : addTyped(typed);
    if (!isDomain) {
      setKeywords(kw);
      setTyped("");
    }
    setTried(true);
    if (Object.keys(err).length) {
      if (err.name) nameRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const created = await createTopic(
        ws,
        isDomain
          ? { displayName: clean, kind: "DOMAIN", description: desc.trim() || undefined }
          : { displayName: clean, kind: "TOPIC", parentTopic: parent, keywords: kw.length ? kw : undefined },
      );
      remember(created);
      invalidate();
      onClose();
      onSelect(resourceId(created.name));
      const fail = (error: unknown) => {
        invalidate();
        toast(errorMessage(error), { tone: "danger" });
      };
      toast(`Created ${clean}`, {
        undo: () =>
          void deleteTopic(ws, created.name ?? "").then(() => {
            invalidate();
            onSelect(isDomain ? "" : resourceId(parent));
          }, fail),
      });
    } catch (error) {
      setBusy(false);
      toast(errorMessage(error), { tone: "danger" });
    }
  };
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    void create();
  };

  const nameField = (
    <TextField className="field" value={name} onChange={setName} isRequired isInvalid={!!shown.name} isDisabled={busy} maxLength={60} autoFocus>
      <Label>Name</Label>
      <Input ref={nameRef} placeholder={isDomain ? "e.g. Human resources" : "e.g. Leave policy"} onKeyDown={onEnter} />
      <FieldError>{shown.name}</FieldError>
    </TextField>
  );

  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      guard={busy}
      size="sm"
      icon={isDomain ? FolderPlus : Tag}
      title={isDomain ? "New domain" : "New topic"}
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void create()} isPending={busy}>
            {busy ? null : <Plus className="i" aria-hidden />}
            {isDomain ? "Create domain" : "Create topic"}
          </Button>
        </>
      }
    >
      {nameField}
      {isDomain ? (
        <TextField className="field" value={desc} onChange={setDesc} isDisabled={busy} maxLength={300}>
          <Label>
            Description <span className="label__opt">(optional)</span>
          </Label>
          <Input onKeyDown={onEnter} />
          <Description>Shown on Home’s topic cards</Description>
        </TextField>
      ) : (
        <>
          <div className="field">
            <span className="label">Domain</span>
            <PlainSelect label="Domain" value={parent} options={domains.map((d) => [d.name ?? "", d.displayName ?? ""] as const)} onChange={setParent} />
            {shown.parent ? <div className="field-error">{shown.parent}</div> : null}
          </div>
          <ChipField
            form
            optional
            label="Keywords"
            placeholder="Add a keyword, then Enter"
            description="Words in a title that mean a document belongs here. You can add more later."
            chips={keywords}
            typed={typed}
            onType={(v) => {
              if (/[,;]/.test(v)) {
                setKeywords(addTyped(v));
                setTyped("");
              } else setTyped(v);
            }}
            // Enter adds what's typed; on an empty field it creates the topic.
            onCommit={() => {
              if (!typed.trim()) {
                void create();
                return;
              }
              setKeywords(addTyped(typed));
              setTyped("");
            }}
            onRemove={(i) => setKeywords((k) => k.filter((_, j) => j !== i))}
          />
        </>
      )}
    </KnowledgeModal>
  );
}
