"use client";

import { Button, Description, FieldError, Input, Label, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { ChoiceGroup } from "@/components/ui/ChoiceGroup";
import { toast } from "@/components/ui/Toast";
import { errorMessage } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { openContribute } from "../../components/contribute-store";
import { KnowledgeModal } from "../../components/KnowledgeModal";
import { invalidateKnowledge, useKnowledgeBases } from "../../queries";
import { createBase, getItemIamPolicy, setItemIamPolicy } from "../api";
import { accessInfo, collectionHref, DESC_MAX, GENERAL_ACCESS, NAME_MAX, nameError, withGeneralAccess, type GeneralAccess } from "../model";

/** Preview `M['kb-create']`: name (unique), description, who can see it. Opens the new collection. */
export function CreateCollectionDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { id, workspace } = useWorkspace();
  const qc = useQueryClient();
  const router = useRouter();
  const collections = useKnowledgeBases({ showLocked: true });
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [access, setAccess] = useState<GeneralAccess>("workspace");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const err = nameError(name, collections.data ?? []);
  const shown = touched || (name.trim() && err.includes("exists")) ? err : "";

  function close() {
    onClose();
    setName("");
    setDesc("");
    setAccess("workspace");
    setTouched(false);
  }

  async function create() {
    if (busy) return;
    setTouched(true);
    if (err) {
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const item = await createBase(id, { displayName: name.trim(), description: desc.trim(), discoverable: access !== "private" });
      if (access === "workspace" && item.name) {
        const policy = await getItemIamPolicy(id, item.name);
        await setItemIamPolicy(id, item.name, withGeneralAccess(policy, "workspace"));
      }
      invalidateKnowledge(qc, id);
      close();
      router.push(collectionHref(item.name));
      toast(`Đã tạo “${item.displayName ?? name.trim()}”`, { action: { label: "Gửi tài liệu", onPress: () => openContribute({ collection: item.name }) } });
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
      size="lg"
      icon={BookOpen}
      title="Tạo kho tài liệu"
      description="Nơi chứa tài liệu của một nhóm hoặc một chủ đề. Tiếp theo, hãy thêm tệp hoặc kết nối nguồn dữ liệu."
      footerStart={<span className="t-xs muted">Bạn sẽ là chủ sở hữu. Bạn có thể đổi quyền truy cập bất cứ lúc nào.</span>}
      footer={
        <>
          <Button variant="ghost" onPress={close} isDisabled={busy}>
            Hủy
          </Button>
          <Button variant="primary" onPress={() => void create()} isPending={busy}>
            <Plus className="i" aria-hidden />
            Tạo kho tài liệu
          </Button>
        </>
      }
    >
      <div className="kn-form">
        <TextField className="field" value={name} onChange={setName} isRequired isInvalid={!!shown} isDisabled={busy} maxLength={NAME_MAX} autoFocus>
          <Label>Tên</Label>
          <Input
            ref={nameRef}
            placeholder="VD: Runbook thanh toán"
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
          />
          {shown ? (
            <FieldError>{shown}</FieldError>
          ) : (
            <div className="row between gap-12">
              <span />
              <span className="counter">
                {name.length}/{NAME_MAX}
              </span>
            </div>
          )}
        </TextField>
        <TextField className="field" value={desc} onChange={setDesc} isDisabled={busy} maxLength={DESC_MAX}>
          <Label>
            Mô tả <span className="label__opt">(không bắt buộc)</span>
          </Label>
          <Input
            placeholder="VD: Runbook cho các kênh thanh toán"
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
          />
          <Description>Cho mọi người biết họ có thể hỏi về điều gì.</Description>
        </TextField>
        <div className="field">
          <span className="label">Ai có thể xem</span>
          <ChoiceGroup
            label="Ai có thể xem"
            columns={3}
            value={access}
            onChange={setAccess}
            isDisabled={busy}
            options={GENERAL_ACCESS.map((key) => {
              const info = accessInfo(key, workspace);
              return { value: key, title: info.label, description: info.long, icon: info.icon };
            })}
          />
        </div>
      </div>
    </KnowledgeModal>
  );
}
