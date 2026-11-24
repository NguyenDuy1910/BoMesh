"use client";

import { Button, Description, FieldError, Input, Label, TextField } from "@heroui/react";
import { FolderPlus, Plus, Tag } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";

import { toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { freeDomainColor } from "@/lib/tones";
import { useWorkspace } from "@/lib/workspace";
import { DOMAIN_ICON } from "@/modules/home/domainIcon";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";

import { createTopic, deleteTopic, type Topic } from "../../api";
import { activeDomains, cleanName, nameTaken } from "../../governance";
import { useInvalidateCuration, useRememberTopic } from "../../queries";
import { PlainSelect } from "../parts";
import { DomainColorPicker, IconPicker } from "./TopicLookPicker";
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
 * for a topic its domain and a few keywords; a domain also gets an icon and a color, pre-picked (the default icon and the
 * first palette color no other domain uses). Everything else is edited in the detail, which opens on the new node.
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
  const [icon, setIcon] = useState(DOMAIN_ICON);
  const [color, setColor] = useState(() => freeDomainColor(domains.map((d) => d.color)));
  const [keywords, setKeywords] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const clean = cleanName(name);
  const parentName = domains.find((d) => d.name === parent)?.displayName ?? "";
  const err: { name?: string; parent?: string } = {};
  if (!clean) err.name = "Nhập tên.";
  else if (nameTaken(topics, clean, isDomain ? null : parent)) err.name = isDomain ? `Lĩnh vực “${clean}” đã tồn tại.` : `${parentName} đã có “${clean}”.`;
  if (!isDomain && !parentName) err.parent = "Hãy chọn một lĩnh vực.";
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
          ? { displayName: clean, kind: "DOMAIN", description: desc.trim() || undefined, icon, color }
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
      toast(`Đã tạo ${clean}`, {
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
      <Label>Tên</Label>
      <Input ref={nameRef} placeholder={isDomain ? "VD: Nhân sự" : "VD: Chính sách nghỉ phép"} onKeyDown={onEnter} />
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
      title={isDomain ? "Lĩnh vực mới" : "Chủ đề mới"}
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Hủy
          </Button>
          <Button variant="primary" onPress={() => void create()} isPending={busy}>
            {busy ? null : <Plus className="i" aria-hidden />}
            {isDomain ? "Tạo lĩnh vực" : "Tạo chủ đề"}
          </Button>
        </>
      }
    >
      {nameField}
      {isDomain ? (
        <>
          <TextField className="field" value={desc} onChange={setDesc} isDisabled={busy} maxLength={300}>
            <Label>
              Mô tả <span className="label__opt">(không bắt buộc)</span>
            </Label>
            <Input onKeyDown={onEnter} />
            <Description>Hiển thị trên thẻ chủ đề ở Trang chủ</Description>
          </TextField>
          <div className="field">
            <span className="label">Biểu tượng và màu</span>
            <div className="tx-look">
              <IconPicker shown={icon} color={color} value={icon} onPick={setIcon} />
              <DomainColorPicker value={color} onChange={setColor} size="sm" label="Màu" />
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="field">
            <span className="label">Lĩnh vực</span>
            <PlainSelect label="Lĩnh vực" value={parent} options={domains.map((d) => [d.name ?? "", d.displayName ?? ""] as const)} onChange={setParent} />
            {shown.parent ? <div className="field-error">{shown.parent}</div> : null}
          </div>
          <ChipField
            form
            optional
            label="Từ khóa"
            placeholder="Thêm từ khóa rồi nhấn Enter"
            description="Những từ trong tiêu đề cho biết tài liệu thuộc về đây. Bạn có thể thêm sau."
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
