"use client";

import { Button, Checkbox } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { toast } from "@/components/ui/Toast";
import { errorMessage } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { createMaterial, deleteMaterial } from "../api";
import { useItem, useItemSpaces } from "../queries";
import { KnowledgeModal } from "./KnowledgeModal";

export interface LinkToSpacesDialogProps {
  item: string;
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Link to spaces (preview `M['res-link']`): pin a document as a material of spaces the caller curates.
 * It stays in its knowledge base and access doesn't change. The base's own space is fixed.
 */
export function LinkToSpacesDialog({ item, isOpen, onClose }: LinkToSpacesDialogProps) {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const doc = useItem(item);
  const baseName = doc.data?.ancestors?.[0]?.name ?? doc.data?.parentItem;
  const base = useItem(baseName);
  const spaces = useItemSpaces(item, { baseSpace: base.data?.collection?.space, enabled: isOpen && !!doc.data });
  const options = (spaces.data ?? []).filter((s) => s.manageable || s.viaBase);
  const [pickedState, setPicked] = useState<string[] | null>(null);
  const picked = pickedState ?? options.filter((s) => s.material).map((s) => s.space.name ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const changes = options.filter((s) => s.manageable && !s.viaBase);
      await Promise.all(
        changes.map((s) => {
          const want = picked.includes(s.space.name ?? "");
          if (want && !s.material) return createMaterial(ws, s.space.name ?? "", item);
          if (!want && s.material) return deleteMaterial(ws, s.material);
          return null;
        }),
      );
      void qc.invalidateQueries({ queryKey: [ws, "spaces"] });
      onClose();
      const linked = options.filter((s) => s.viaBase || picked.includes(s.space.name ?? "")).length;
      toast(linked ? `Linked to ${plural(linked, "space")}` : "Removed from spaces");
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
      title="Link to spaces"
      description={<span translate="no">{doc.data?.displayName}</span>}
      footer={
        <>
          <Button variant="tertiary" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void save()} isPending={busy} isDisabled={!spaces.data || !options.length}>
            Save
          </Button>
        </>
      }
    >
      {spaces.isPending ? (
        <SkeletonRows rows={3} />
      ) : options.length ? (
        <div className="res-picks">
          {options.map((s) => (
            <div key={s.space.name} className="res-pick">
              <Checkbox
                isSelected={s.viaBase || picked.includes(s.space.name ?? "")}
                isDisabled={s.viaBase}
                onChange={(on) => setPicked(on ? [...picked, s.space.name ?? ""] : picked.filter((x) => x !== s.space.name))}
              >
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <span className="stack">
                    <span className="medium">{s.space.displayName}</span>
                    <span className="t-xs muted">{s.viaBase ? "Its knowledge base belongs to this space" : (s.space.spaceType ?? "Space")}</span>
                  </span>
                </Checkbox.Content>
              </Checkbox>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState compact title="No spaces you can curate" description="Space leads and staff can link documents to their spaces." />
      )}
      <p className="t-xs muted mt-12">
        It appears in each space’s materials. It stays in {base.data?.displayName ?? "its knowledge base"}, and access doesn’t change.
      </p>
    </KnowledgeModal>
  );
}
