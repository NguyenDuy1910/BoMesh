"use client";

import { Button, Card, FieldError, Input, Label, TextArea, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Archive } from "lucide-react";
import { useRef, useState } from "react";

import { FormSection } from "@/components/ui/FormSection";
import { SaveBar } from "@/components/ui/SaveBar";
import { toast } from "@/components/ui/Toast";
import { errorMessage } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { updateItem } from "../../api";
import { invalidateKnowledge, useKnowledgeBases } from "../../queries";
import { DESC_MAX, NAME_MAX, nameError, type Item } from "../model";
import { useCollectionOperations } from "../operations";

/** Settings tab (preview `settingsTab(kb)`): name and description, archive. Owners only. */
export function SettingsTab({ base }: { base: Item }) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const bases = useKnowledgeBases({ showLocked: true });
  const ops = useCollectionOperations();
  const savedName = base.displayName ?? "";
  const savedDesc = base.collection?.description ?? "";
  const [name, setName] = useState(savedName);
  const [desc, setDesc] = useState(savedDesc);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const err = nameError(name, bases.data ?? [], base.name);
  const shown = touched || (name.trim() && err.includes("exists")) ? err : "";
  const dirty = name.trim() !== savedName || desc.trim() !== savedDesc;
  const n = base.collection?.documentCount ?? 0;

  function discard() {
    setName(savedName);
    setDesc(savedDesc);
    setTouched(false);
  }

  async function save() {
    if (busy) return;
    setTouched(true);
    if (err) {
      nameRef.current?.focus();
      return;
    }
    if (!dirty) return;
    setBusy(true);
    try {
      const mask = [name.trim() !== savedName && "displayName", desc.trim() !== savedDesc && "collection.description"].filter((m): m is string => !!m);
      const item = await updateItem(ws, base.name ?? "", { displayName: name.trim(), collection: { description: desc.trim() }, etag: base.etag }, mask);
      setName(item.displayName ?? "");
      setDesc(item.collection?.description ?? "");
      setTouched(false);
      invalidateKnowledge(qc, ws);
      toast("Đã lưu thay đổi");
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="kb-narrow stack gap-16">
      <Card className="card--lg">
        <FormSection title="Chi tiết" description="Hiển thị trong bộ lọc Tra cứu và khi mọi người chọn phạm vi để hỏi.">
          <TextField value={name} onChange={setName} isRequired isInvalid={!!shown} isDisabled={busy} maxLength={NAME_MAX}>
            <Label>Tên</Label>
            <Input
              ref={nameRef}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
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
            <TextArea rows={3} />
            <div className="row between gap-12">
              <span />
              <span className="counter">
                {desc.length}/{DESC_MAX}
              </span>
            </div>
          </TextField>
        </FormSection>
      </Card>
      <Card className="card--lg">
        <FormSection
          title="Lưu trữ kho tài liệu"
          description={`${n ? `Gỡ kho tài liệu này và ${plural(n, "document")} khỏi câu trả lời và tìm kiếm cho mọi người.` : "Gỡ với mọi người."} Bạn có thể hoàn tác ngay sau đó.`}
        >
          <div>
            <Button variant="danger-soft" onPress={() => void ops.archive(base)}>
              <Archive className="i" aria-hidden />
              Lưu trữ kho tài liệu
            </Button>
          </div>
        </FormSection>
      </Card>
      <SaveBar isDirty={dirty} onSave={() => void save()} onDiscard={discard} isSaving={busy} />
    </div>
  );
}
