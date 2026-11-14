"use client";

import { Button, Radio, RadioGroup } from "@heroui/react";
import { CircleAlert, Folder } from "lucide-react";
import { useState } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { plural } from "@/lib/format";
import { resourceId } from "@/lib/api/client";

import type { Item } from "../api";
import { BaseMark } from "../bases/components/BaseMark";
import { useDocumentOperations } from "../operations";
import { useItem, useKnowledgeBases } from "../queries";
import { KnowledgeModal } from "./KnowledgeModal";
import { useWhoCanSeeCollection } from "./ResourceDetails";

export interface MoveDialogProps {
  /** Item names to move. */
  items: string[];
  /** Current parent collection (for the description and Undo). */
  from?: string;
  isOpen: boolean;
  onClose: () => void;
}

/** One destination: its mark, name and who will see what moves there. */
function MoveOption({ collection }: { collection: Item }) {
  const who = useWhoCanSeeCollection({ id: resourceId(collection.name), displayName: collection.displayName });
  const WhoIcon = who.icon;
  return (
    <Radio value={collection.name ?? ""} className="mv-opt">
      <Radio.Content className="row gap-12 grow">
        <Radio.Control>
          <Radio.Indicator />
        </Radio.Control>
        <BaseMark base={collection} size={24} />
        <span className="grow">
          <span className="mv-opt__name" translate="no">
            {collection.displayName}
          </span>
          <span className="mv-opt__who t-xs muted">
            <WhoIcon className="i i-xs" aria-hidden />
            <span className="truncate">{who.label}</span>
          </span>
        </span>
      </Radio.Content>
    </Radio>
  );
}

/** Move documents to another collection the caller can edit (preview `M['doc-move']`). Who can see them follows the new collection. */
export function MoveDialog({ items, from, isOpen, onClose }: MoveDialogProps) {
  const ops = useDocumentOperations();
  const bases = useKnowledgeBases();
  const first = useItem(items.length === 1 ? items[0] : null);
  const source = from ?? first.data?.parentItem;
  const sourceItem = useItem(source);
  const targets = (bases.data ?? []).filter((b) => b.name !== source && b.collection?.kind !== "PERSONAL" && (b.access === "EDITOR" || b.access === "OWNER"));
  // One possible destination is the obvious choice; with several, the caller picks on purpose.
  const [picked, setPicked] = useState("");
  const to = picked || (targets.length === 1 ? (targets[0].name ?? "") : "");
  const target = targets.find((t) => t.name === to);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const n = items.length;
  const title = n === 1 ? "Move document" : `Move ${plural(n, "document")}`;
  const error = tried && !target ? "Choose a collection." : "";

  async function move() {
    if (!target?.name) return setTried(true);
    setBusy(true);
    const ok = await ops.move(
      items.map((name) => ({ name, title: name })),
      { name: target.name, displayName: target.displayName ?? "" },
      source,
    );
    setBusy(false);
    if (ok) onClose();
  }

  if (!bases.isPending && !targets.length) {
    return (
      <KnowledgeModal isOpen={isOpen} onClose={onClose} size="sm" title={title} icon={Folder} footer={<Button variant="primary" onPress={onClose}>Close</Button>}>
        <EmptyState compact icon={Folder} title="Nowhere to move it" description="There’s no other collection you can edit." />
      </KnowledgeModal>
    );
  }

  const fromName = sourceItem.data?.displayName ?? "";
  return (
    <KnowledgeModal
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      guard={busy}
      title={title}
      icon={Folder}
      description={n === 1 ? `“${first.data?.displayName ?? ""}” · from ${fromName}` : `From ${fromName}`}
      footerStart="You can undo right after."
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onPress={() => void move()} isPending={busy}>
            <Folder className="i" aria-hidden />
            Move
          </Button>
        </>
      }
    >
      <div className="field">
        <span className="label" id="doc-move-label">
          Move to
        </span>
        <RadioGroup
          aria-labelledby="doc-move-label"
          className="option-list mv-list"
          value={to}
          onChange={(v) => {
            setPicked(v);
            setTried(false);
          }}
          isDisabled={busy}
          isInvalid={!!error}
        >
          {targets.map((b) => (
            <MoveOption key={b.name} collection={b} />
          ))}
        </RadioGroup>
        {error ? (
          <div className="field-error" role="alert">
            <CircleAlert className="i" aria-hidden />
            <span>{error}</span>
          </div>
        ) : (
          <div className="description">Who can see {n === 1 ? "it" : "them"} follows the new collection.</div>
        )}
      </div>
    </KnowledgeModal>
  );
}
