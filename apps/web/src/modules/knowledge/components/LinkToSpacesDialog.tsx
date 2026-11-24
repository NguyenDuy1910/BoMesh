"use client";

import { Button, Checkbox } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Link2 } from "lucide-react";
import { useState } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { toast } from "@/components/ui/Toast";
import { errorMessage } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { SpaceMark, spaceType } from "@/modules/spaces";

import { createMaterial, deleteMaterial } from "../api";
import { readableTitle } from "../model";
import { useItem, useItemSpaces } from "../queries";
import { KnowledgeModal } from "./KnowledgeModal";

export interface LinkToSpacesDialogProps {
  item: string;
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Link to spaces (preview `M['res-link']`): show a document in the materials of spaces the caller curates.
 * It stays in its collection and access doesn't change.
 */
export function LinkToSpacesDialog({ item, isOpen, onClose }: LinkToSpacesDialogProps) {
  const { id: ws, settings } = useWorkspace();
  const qc = useQueryClient();
  const doc = useItem(item);
  const spaces = useItemSpaces(item, { enabled: isOpen && !!doc.data });
  const options = (spaces.data ?? []).filter((s) => s.manageable);
  const [pickedState, setPicked] = useState<string[] | null>(null);
  const picked = pickedState ?? options.filter((s) => s.material).map((s) => s.space.name ?? "");
  const [busy, setBusy] = useState(false);
  const shown = picked.length;
  const title = readableTitle((doc.data?.displayName ?? "").replace(/\.[a-z0-9]{1,5}$/i, ""));

  async function save() {
    const changes = options.filter((s) => picked.includes(s.space.name ?? "") !== !!s.material);
    if (!changes.length) return onClose();
    setBusy(true);
    const refresh = () => void qc.invalidateQueries({ queryKey: [ws, "spaces"] });
    try {
      const added = await Promise.all(changes.filter((s) => !s.material).map((s) => createMaterial(ws, s.space.name ?? "", item)));
      const dropped = changes.filter((s) => s.material);
      await Promise.all(dropped.map((s) => deleteMaterial(ws, s.material ?? "")));
      refresh();
      onClose();
      toast(shown ? `Đã liên kết với ${plural(shown, "space")}` : "Đã gỡ khỏi cộng đồng", {
        undo: () =>
          void Promise.all([
            ...added.map((m) => deleteMaterial(ws, m.name ?? "")),
            ...dropped.map((s) => createMaterial(ws, s.space.name ?? "", item)),
          ]).then(refresh, (e: unknown) => toast(errorMessage(e), { tone: "danger" })),
      });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <KnowledgeModal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      guard={busy}
      title="Liên kết với cộng đồng"
      icon={Link2}
      description={`Hiển thị “${title}” trong tài liệu của từng cộng đồng. Quyền truy cập không đổi.`}
      footerStart={spaces.data ? (shown ? `Hiển thị trong ${plural(shown, "space")}` : "Chưa có trong cộng đồng nào") : null}
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Hủy
          </Button>
          <Button variant="primary" onPress={() => void save()} isPending={busy} isDisabled={!spaces.data || !options.length}>
            <Check className="i" aria-hidden />
            Lưu liên kết
          </Button>
        </>
      }
    >
      {spaces.isPending ? (
        <SkeletonRows rows={3} />
      ) : options.length ? (
        <div className="option-list" role="group" aria-label="Cộng đồng">
          {options.map((s) => (
            <Checkbox
              key={s.space.name}
              isSelected={picked.includes(s.space.name ?? "")}
              isDisabled={busy}
              onChange={(on) => setPicked(on ? [...picked, s.space.name ?? ""] : picked.filter((x) => x !== s.space.name))}
            >
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <span className="res-opt res-opt--mark">
                  <SpaceMark space={s.space} size={28} />
                  <span className="res-opt__text">
                    <span className="res-opt__name">{s.space.displayName}</span>
                    <span className="res-opt__meta">{spaceType(s.space.spaceType, settings).label}</span>
                  </span>
                </span>
              </Checkbox.Content>
            </Checkbox>
          ))}
        </div>
      ) : (
        <EmptyState compact title="Không có cộng đồng nào để bạn quản trị tài liệu" description="Trưởng nhóm và nhân sự của cộng đồng có thể liên kết tài liệu với cộng đồng của họ." />
      )}
    </KnowledgeModal>
  );
}
