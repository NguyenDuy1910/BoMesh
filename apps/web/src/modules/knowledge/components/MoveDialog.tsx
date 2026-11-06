"use client";

import { Button, Description, Label, ListBox, Select } from "@heroui/react";
import { useState } from "react";

import { plural } from "@/lib/format";

import { useDocumentOperations } from "../operations";
import { useItem, useKnowledgeBases } from "../queries";
import { KnowledgeModal } from "./KnowledgeModal";

export interface MoveDialogProps {
  /** Item names to move. */
  items: string[];
  /** Current parent collection (for the description and Undo). */
  from?: string;
  isOpen: boolean;
  onClose: () => void;
}

/** Move documents to another knowledge base the caller can edit (preview `M['doc-move']`). */
export function MoveDialog({ items, from, isOpen, onClose }: MoveDialogProps) {
  const ops = useDocumentOperations();
  const bases = useKnowledgeBases();
  const first = useItem(items.length === 1 ? items[0] : null);
  const source = from ?? first.data?.parentItem;
  const sourceItem = useItem(source);
  const targets = (bases.data ?? []).filter((b) => b.name !== source && b.collection?.kind !== "PERSONAL" && (b.access === "EDITOR" || b.access === "OWNER"));
  const [to, setTo] = useState<string>("");
  const target = targets.find((t) => t.name === (to || targets[0]?.name));
  const [busy, setBusy] = useState(false);

  async function move() {
    if (!target?.name) return;
    setBusy(true);
    const ok = await ops.move(
      items.map((name) => ({ name, title: name })),
      { name: target.name, displayName: target.displayName ?? "" },
      source,
    );
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <KnowledgeModal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      title={items.length === 1 ? `Move “${first.data?.displayName ?? ""}”` : `Move ${plural(items.length, "document")}`}
      description={sourceItem.data?.displayName ? `From ${sourceItem.data.displayName}` : undefined}
      footer={
        <>
          <Button variant="tertiary" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          {targets.length ? (
            <Button variant="primary" onPress={() => void move()} isPending={busy}>
              Move
            </Button>
          ) : null}
        </>
      }
    >
      {targets.length ? (
        <Select value={target?.name ?? ""} onChange={(v) => setTo(String(v))}>
          <Label>Move to</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Description>People with access to that knowledge base will see these documents.</Description>
          <Select.Popover>
            <ListBox>
              {targets.map((b) => (
                <ListBox.Item key={b.name} id={b.name ?? ""} textValue={b.displayName ?? ""}>
                  {b.displayName}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      ) : (
        <p className="muted">There’s no other knowledge base you can edit.</p>
      )}
    </KnowledgeModal>
  );
}
