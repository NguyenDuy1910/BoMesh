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
 * It stays in its collection and access doesn't change. The space its collection belongs to is fixed.
 */
export function LinkToSpacesDialog({ item, isOpen, onClose }: LinkToSpacesDialogProps) {
  const { id: ws, settings } = useWorkspace();
  const qc = useQueryClient();
  const doc = useItem(item);
  const baseName = doc.data?.ancestors?.[0]?.name ?? doc.data?.parentItem;
  const base = useItem(baseName);
  const spaces = useItemSpaces(item, { baseSpace: base.data?.collection?.space, enabled: isOpen && !!doc.data });
  const options = (spaces.data ?? []).filter((s) => s.manageable || s.viaBase);
  const [pickedState, setPicked] = useState<string[] | null>(null);
  const picked = pickedState ?? options.filter((s) => s.material).map((s) => s.space.name ?? "");
  const [busy, setBusy] = useState(false);
  const shown = options.filter((s) => s.viaBase || picked.includes(s.space.name ?? "")).length;
  const title = readableTitle((doc.data?.displayName ?? "").replace(/\.[a-z0-9]{1,5}$/i, ""));

  async function save() {
    const changes = options.filter((s) => s.manageable && !s.viaBase && picked.includes(s.space.name ?? "") !== !!s.material);
    if (!changes.length) return onClose();
    setBusy(true);
    const refresh = () => void qc.invalidateQueries({ queryKey: [ws, "spaces"] });
    try {
      const added = await Promise.all(changes.filter((s) => !s.material).map((s) => createMaterial(ws, s.space.name ?? "", item)));
      const dropped = changes.filter((s) => s.material);
      await Promise.all(dropped.map((s) => deleteMaterial(ws, s.material ?? "")));
      refresh();
      onClose();
      toast(shown ? `Linked to ${plural(shown, "space")}` : "Removed from spaces", {
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
      title="Link to spaces"
      icon={Link2}
      description={`Show “${title}” in each space’s materials. Access doesn’t change.`}
      footerStart={spaces.data ? (shown ? `Shown in ${plural(shown, "space")}` : "Not in any space yet") : null}
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void save()} isPending={busy} isDisabled={!spaces.data || !options.length}>
            <Check className="i" aria-hidden />
            Save links
          </Button>
        </>
      }
    >
      {spaces.isPending ? (
        <SkeletonRows rows={3} />
      ) : options.length ? (
        <div className="option-list" role="group" aria-label="Spaces">
          {options.map((s) => (
            <Checkbox
              key={s.space.name}
              isSelected={s.viaBase || picked.includes(s.space.name ?? "")}
              isDisabled={s.viaBase || busy}
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
                    <span className="res-opt__meta">{s.viaBase ? "Always: its collection belongs here" : spaceType(s.space.spaceType, settings).label}</span>
                  </span>
                </span>
              </Checkbox.Content>
            </Checkbox>
          ))}
        </div>
      ) : (
        <EmptyState compact title="No spaces you can curate" description="Space leads and staff can link documents to their spaces." />
      )}
    </KnowledgeModal>
  );
}
