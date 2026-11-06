"use client";

import { Button } from "@heroui/react";
import { List as ListIcon, Plus } from "lucide-react";

import { EmptyState } from "@/components/ui/EmptyState";
import { Gate } from "@/components/ui/Gate";
import { ItemIcon } from "@/components/ui/ItemIcon";
import { List, ListItem } from "@/components/ui/List";
import { Section } from "@/components/ui/Section";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { resourceId } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import type { ReadingList } from "../../api";
import { useShareLabel } from "../../components/AddToCollectionDialog";
import { openReadingListEditor } from "../../components/dialogs";
import { ResDot } from "../../components/ResourceRow";
import { useMemberNames, useReadingLists } from "../../queries";

/** "Updated just now" / "Updated yesterday" / "Updated 3 days ago". */
export const updatedLow = (at?: string) => `Updated ${rel(at).replace(/^(Just now|Yesterday)$/, (m) => m.toLowerCase())}`;

/** Visible entries plus the ones the caller can't open (preview counts every item). */
export const listSize = (l: ReadingList) => (l.itemCount ?? 0) + (l.hiddenItemCount ?? 0);

/** Collections: yours, and shared with you (preview `collectionsTab`). */
export function CollectionsTab() {
  const { member } = useWorkspace();
  const lists = useReadingLists();
  const all = (lists.data ?? []).filter((l) => l.type !== "FEATURED" && l.state !== "DELETED");
  const owners = useMemberNames(all.map((l) => l.owner));
  const shareLabel = useShareLabel();

  const row = (l: ReadingList, showOwner: boolean) => {
    const share = shareLabel(l);
    const owner = showOwner ? owners.get(l.owner ?? "") : undefined;
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
              <span translate="no">{share.label}</span>
            </span>
            <ResDot />
            {plural(listSize(l), "item")}
            {owner ? (
              <>
                <ResDot />
                <span translate="no">{owner}</span>
              </>
            ) : null}
          </span>
        }
        meta={updatedLow(l.updateTime)}
        href={`/knowledge/collections/${resourceId(l.name)}`}
      />
    );
  };

  const create = (variant: "primary" | "tertiary") => (
    <Button variant={variant} onPress={() => openReadingListEditor()}>
      <Plus className="i" aria-hidden />
      New collection
    </Button>
  );

  return (
    <Gate
      query={lists}
      skeleton={<SkeletonRows rows={4} />}
      isEmpty={!all.length}
      empty={<EmptyState icon={ListIcon} title="No collections yet" description="Group resources into a reading list and share it with a course or team." actions={create("primary")} boxed />}
    >
      {() => {
        const yours = all.filter((l) => l.owner === member.name);
        const shared = all.filter((l) => l.owner !== member.name);
        return (
          <>
            <Section title="Yours">
              {yours.length ? (
                <List className="lib-list">{yours.map((l) => row(l, false))}</List>
              ) : (
                <EmptyState icon={ListIcon} title="You haven’t made a collection yet" actions={create("tertiary")} compact boxed />
              )}
            </Section>
            {shared.length ? (
              <Section title="Shared with you">
                <List className="lib-list">{shared.map((l) => row(l, true))}</List>
              </Section>
            ) : null}
          </>
        );
      }}
    </Gate>
  );
}
