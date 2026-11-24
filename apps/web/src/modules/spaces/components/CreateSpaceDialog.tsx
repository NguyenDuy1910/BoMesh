"use client";

import { Button, FieldError, Input, Label, TextField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Link as LinkIcon, Plus, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ChoiceGroup, Disclosure, SkeletonRows, SwitchRow, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { createMaterial } from "@/modules/knowledge/api";
import { createBase } from "@/modules/knowledge/bases/api";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";

import { createSpace } from "../api";
import { invalidateSpaces, useLinkableBases, useSpaces } from "../queries";
import { inSentence, MAX_NAME, spaceType, spaceTypesOf, type Space } from "../types";

/** Name rule shared by Create and Settings (preview `nameError`). */
export function spaceNameError(name: string, spaces: readonly Space[], self?: string): string {
  const n = name.trim();
  if (!n) return "Nhập tên.";
  if (n.length > MAX_NAME) return `Dùng tối đa ${MAX_NAME} ký tự.`;
  const dup = spaces.find((s) => s.name !== self && (s.displayName ?? "").trim().toLowerCase() === n.toLowerCase());
  return dup ? `“${dup.displayName}” đã tồn tại. Hãy chọn tên khác.` : "";
}

export interface CreateSpaceDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Preselected type key (the open tab). */
  type?: string;
}

/** Create space (preview `M['sp-create']`): type, name, description, a new collection and existing ones to add to its materials. */
export function CreateSpaceDialog({ isOpen, onClose, type }: CreateSpaceDialogProps) {
  return isOpen ? <CreateSpaceForm onClose={onClose} type={type} /> : null;
}

function CreateSpaceForm({ onClose, type }: Omit<CreateSpaceDialogProps, "isOpen">) {
  const { id: ws, settings, can } = useWorkspace();
  const router = useRouter();
  const qc = useQueryClient();
  const types = spaceTypesOf(settings);
  const spaces = useSpaces();
  const bases = useLinkableBases();
  const canCreateBase = can("items.create");
  const [kind, setKind] = useState(types.some((t) => t.key === type) ? type! : (types[0]?.key ?? ""));
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [newBase, setNewBase] = useState(canCreateBase);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const error = touched ? spaceNameError(name, spaces.data ?? []) : "";
  const linkable = (bases.data ?? []).filter((b) => b.editable);
  const linked = linkable.filter((b) => picked.includes(b.base.name ?? ""));
  const def = spaceType(kind, settings);
  const lead = inSentence(def.roles[0][1]);

  async function submit() {
    setTouched(true);
    if (spaceNameError(name, spaces.data ?? [])) return;
    setBusy(true);
    try {
      const space = await createSpace(ws, {
        displayName: name.trim(),
        description: desc.trim() || undefined,
        spaceType: kind || undefined,
        joinPolicy: def.defaultPolicy,
      });
      const links: Promise<unknown>[] = picked.map((item) => createMaterial(ws, space.name ?? "", item));
      if (newBase) {
        links.push(
          createBase(ws, {
            displayName: name.trim(),
            description: desc.trim() || `Tài liệu học tập cho ${name.trim()}.`,
            discoverable: true,
          }).then((base) => createMaterial(ws, space.name ?? "", base.name ?? "")),
        );
      }
      const results = await Promise.allSettled(links);
      void invalidateSpaces(qc, ws);
      void qc.invalidateQueries({ queryKey: [ws, "items"] });
      onClose();
      router.push(`/space/${resourceId(space.name)}`);
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed) toast(`Đã tạo “${name.trim()}”, nhưng không liên kết được ${failed === 1 ? "một kho tài liệu" : `${failed} kho tài liệu`}`, { tone: "warning" });
      else toast(`Đã tạo “${name.trim()}”`);
    } catch (e) {
      toast(errorMessage(e), { tone: "danger" });
      setBusy(false);
    }
  }

  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      guard={busy}
      size="lg"
      icon={Users}
      title="Tạo cộng đồng"
      description="Nơi chung cho con người, tài liệu và công việc. Bạn có thể thay đổi mọi thứ sau."
      footerStart={<span>{`Bạn sẽ là ${lead} của cộng đồng.`}</span>}
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Hủy
          </Button>
          <Button variant="primary" onPress={() => void submit()} isPending={busy}>
            <Plus aria-hidden />
            Tạo cộng đồng
          </Button>
        </>
      }
    >
      <form
        className="stack gap-16"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {types.length ? (
          <div className="field sp-types">
            <span className="label">Loại cộng đồng nào?</span>
            <ChoiceGroup
              label="Loại cộng đồng nào?"
              value={kind}
              onChange={setKind}
              isDisabled={busy}
              columns={Math.min(types.length, 3)}
              options={types.map((t) => ({ value: t.key, title: t.label, description: t.desc, icon: t.icon }))}
            />
          </div>
        ) : null}
        <TextField value={name} onChange={setName} isRequired isInvalid={!!error} maxLength={MAX_NAME} isDisabled={busy} autoFocus>
          <Label>Tên</Label>
          <Input placeholder={def.key === "course" ? "VD: Thị giác máy tính" : "VD: Robot thực địa"} />
          <FieldError>{error}</FieldError>
        </TextField>
        <TextField value={desc} onChange={setDesc} maxLength={140} isDisabled={busy}>
          <Label>
            Mô tả ngắn <span className="label__opt">(không bắt buộc)</span>
          </Label>
          <Input placeholder="Mô tả hoạt động ở đây trong một dòng" />
        </TextField>
        {canCreateBase || linkable.length || bases.isPending ? (
          <div className="field">
            <span className="label">Tài liệu</span>
            <div className="stack gap-8 mt-8">
              {canCreateBase ? (
                <SwitchRow
                  title="Tạo kho tài liệu mới cho cộng đồng này"
                  description="Mang tên cộng đồng, do bạn sở hữu. Thành viên gửi tài liệu vào đó."
                  isSelected={newBase}
                  onChange={setNewBase}
                  isDisabled={busy}
                />
              ) : null}
              {bases.isPending ? <SkeletonRows rows={2} /> : null}
              {linkable.length ? (
                <Disclosure
                  title="Liên kết kho tài liệu có sẵn"
                  icon={LinkIcon}
                  summary={linked.length ? (linked.length === 1 ? <span translate="no">{linked[0].base.displayName}</span> : plural(linked.length, "collection")) : "Chưa có"}
                >
                  <div className="stack gap-4">
                    {linkable.map(({ base }) => (
                      <SwitchRow
                        key={base.name}
                        title={<span translate="no">{base.displayName}</span>}
                        label={base.displayName}
                        description={plural(base.collection?.documentCount ?? 0, "document")}
                        isDisabled={busy}
                        isSelected={picked.includes(base.name ?? "")}
                        onChange={(on) => setPicked(on ? [...picked, base.name ?? ""] : picked.filter((x) => x !== base.name))}
                      />
                    ))}
                  </div>
                </Disclosure>
              ) : null}
            </div>
          </div>
        ) : null}
      </form>
    </KnowledgeModal>
  );
}
