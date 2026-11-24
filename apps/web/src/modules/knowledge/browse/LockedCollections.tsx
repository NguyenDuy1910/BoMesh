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
      title={mine.data ? "Yêu cầu của bạn đã được gửi đến chủ sở hữu" : `${base.displayName ?? ""} chưa được chia sẻ với bạn`}
      description={
        mine.data
          ? `Bạn đã gửi yêu cầu ${relInline(mine.data.createTime)}. Tài liệu sẽ xuất hiện ở đây ngay khi được duyệt.`
          : `${owners ? `${owners}. ` : ""}Hãy yêu cầu quyền truy cập để tìm và đọc tài liệu trong đó.`
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
        <span>Một số kho tài liệu chưa được chia sẻ với bạn</span>
        <ArrowRight className="i i-sm" aria-hidden />
      </button>
      <KnowledgeModal
        isOpen={open}
        onClose={() => setOpen(false)}
        size="md"
        title="Kho tài liệu bị hạn chế"
        icon={Lock}
        description="Tài liệu trong các kho tài liệu này bị ẩn cho đến khi chủ sở hữu chia sẻ với bạn."
        footer={
          <Button variant="ghost" onPress={() => setOpen(false)}>
            Đóng
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
