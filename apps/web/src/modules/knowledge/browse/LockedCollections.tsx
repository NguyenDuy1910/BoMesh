"use client";

import { Button } from "@heroui/react";
import { ArrowRight, Lock } from "lucide-react";
import { useState } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { List, ListItem } from "@/components/ui/List";
import { relInline } from "@/lib/format";

import type { Item } from "../api";
import { BaseMark } from "../bases/components/BaseMark";
import { ownersLabel } from "../bases/components/parts";
import { RequestAccessCta } from "../bases/components/RequestAccessDialog";
import { useMyAccessRequest } from "../bases/queries";
import { KnowledgeModal } from "../components/KnowledgeModal";

/** Browse filtered to a collection the caller can't read (preview `X.kbLocked`): who owns it and how to ask. */
export function LockedCollection({ base }: { base: Item }) {
  const mine = useMyAccessRequest(base.name);
  const owners = ownersLabel(base);
  return (
    <EmptyState
      icon={Lock}
      boxed
      compact
      title={mine.data ? "Your request is with the owners" : `${base.displayName ?? ""} isn’t shared with you`}
      description={
        mine.data
          ? `You asked ${relInline(mine.data.createTime)}. Its documents appear here as soon as it’s approved.`
          : `${owners ? `${owners}. ` : ""}Ask for access to search and read its documents.`
      }
      actions={<RequestAccessCta base={base} variant="primary" size="md" />}
    />
  );
}

/** One quiet way in to the collections people can see but not open (preview `lockedNote` + `M['kb-locked']`). */
export function LockedNote({ bases }: { bases: readonly Item[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="cat-locked" onClick={() => setOpen(true)}>
        <Lock className="i i-sm" aria-hidden />
        <span>Some collections aren’t shared with you</span>
        <ArrowRight className="i i-sm" aria-hidden />
      </button>
      <KnowledgeModal
        isOpen={open}
        onClose={() => setOpen(false)}
        size="md"
        title="Restricted collections"
        icon={Lock}
        description="Their documents stay hidden until the owners share them with you."
        footer={
          <Button variant="ghost" onPress={() => setOpen(false)}>
            Close
          </Button>
        }
      >
        <List>
          {bases.map((b) => (
            <ListItem
              key={b.name}
              lead={<BaseMark base={b} size={32} locked />}
              title={b.displayName ?? ""}
              contentTitle
              description={b.collection?.description ? <span translate="no">{b.collection.description}</span> : ownersLabel(b) || undefined}
              actions={<RequestAccessCta base={b} />}
            />
          ))}
        </List>
      </KnowledgeModal>
    </>
  );
}
