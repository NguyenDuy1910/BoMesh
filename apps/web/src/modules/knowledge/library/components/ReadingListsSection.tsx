"use client";

import { Button } from "@heroui/react";
import { List as ListIcon, Plus } from "lucide-react";

import { EmptyState } from "@/components/ui/EmptyState";
import { Gate } from "@/components/ui/Gate";
import { ItemIcon } from "@/components/ui/ItemIcon";
import { List, ListItem } from "@/components/ui/List";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { openReadingListEditor } from "../../components/dialogs";
import { ResDot, updatedLabel } from "../../components/ResourceRow";
import { useShareLabel } from "../../components/share-label";
import { useReadingLists } from "../../queries";

/**
 * My reading lists (preview `collectionsTab`): the reading lists the member made. Ones shared with them are in
 * Browse ("Shared with you"). The section's one action, New reading list, ends its toolbar.
 */
export function ReadingListsSection() {
  const { member } = useWorkspace();
  const lists = useReadingLists();
  const shareLabel = useShareLabel();
  const yours = (lists.data ?? []).filter((l) => l.type !== "FEATURED" && l.state !== "DELETED" && l.owner === member.name);

  const create = (size?: "sm") => (
    <Button variant="primary" size={size} onPress={() => openReadingListEditor()}>
      <Plus className="i" aria-hidden />
      New reading list
    </Button>
  );

  return (
    <Gate
      query={lists}
      skeleton={<SkeletonRows rows={4} />}
      isEmpty={!yours.length}
      empty={
        <EmptyState
          icon={ListIcon}
          title="No reading lists yet"
          description="Group resources into a reading list, put them in order and share it with your team."
          actions={create()}
          boxed
        />
      }
    >
      <div className="toolbar lib-bar">
        <div className="toolbar__end">{create("sm")}</div>
      </div>
      <List className="lib-list">
        {yours.map((l) => {
          const share = shareLabel(l);
          return (
            <ListItem
              key={l.name}
              lead={<ItemIcon icon={ListIcon} size="sm" />}
              title={l.displayName ?? ""}
              contentTitle
              description={
                <span className="row gap-4 lib-col__meta">
                  <span className="row gap-4">
                    <share.icon className="i i-xs" aria-hidden />
                    <span translate={l.audience === "SPACE" ? "no" : undefined}>{share.label}</span>
                  </span>
                  <ResDot />
                  {plural((l.itemCount ?? 0) + (l.hiddenItemCount ?? 0), "item")}
                </span>
              }
              meta={updatedLabel(l.updateTime)}
              href={`/knowledge/lists/${resourceId(l.name)}`}
            />
          );
        })}
      </List>
    </Gate>
  );
}
