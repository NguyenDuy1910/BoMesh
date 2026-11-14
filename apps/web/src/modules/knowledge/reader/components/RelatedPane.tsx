"use client";

import { ListPlus, List as ListIcon } from "lucide-react";

import { ErrorState } from "@/components/ui/ErrorState";
import { IconButton } from "@/components/ui/IconButton";
import { ItemIcon } from "@/components/ui/ItemIcon";
import { List, ListItem } from "@/components/ui/List";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { resourceId } from "@/lib/api/client";

import type { Resource } from "../../model";
import { useKnowledgeModel } from "../../queries";
import { useShareLabel } from "../../components/share-label";
import { openAddToReadingList } from "../../components/dialogs";
import { ResourceList, ResourceRow } from "../../components/ResourceRow";
import { useReadingListsIncluding, useRelated } from "../queries";
import { RailSection } from "./AboutPane";

/**
 * Related tab (preview `relatedPane`): similar resources and the reading lists that include it.
 * "Cited in your conversations" is omitted: the API has no query for conversations citing an item.
 */
export function RelatedPane({ resource: r }: { resource: Resource }) {
  const { toResource } = useKnowledgeModel();
  const related = useRelated(r.id, { enabled: r.readable });
  const lists = useReadingListsIncluding(r.id);
  const share = useShareLabel();
  const rows = (related.data?.results ?? []).flatMap((x) => (x.item && resourceId(x.item.name) !== r.id ? [toResource(x.item)] : []));

  return (
    <>
      <RailSection title="Related resources">
        {!r.readable ? (
          <p className="rdr-none">Nothing related yet.</p>
        ) : related.isPending ? (
          <SkeletonRows rows={3} />
        ) : related.isError ? (
          <ErrorState error={related.error} onRetry={() => void related.refetch()} boxed={false} compact />
        ) : rows.length ? (
          <ResourceList>
            {rows.map((x) => (
              <ResourceRow key={x.id} resource={x} compact />
            ))}
          </ResourceList>
        ) : (
          <p className="rdr-none">Nothing related yet.</p>
        )}
      </RailSection>
      <RailSection
        title="Reading lists that include it"
        extra={<IconButton icon={ListPlus} tip="Add to reading list" size="sm" onPress={() => openAddToReadingList(r.name)} />}
      >
        {lists.isPending ? (
          <SkeletonRows rows={2} />
        ) : lists.isError ? (
          <ErrorState error={lists.error} onRetry={lists.refetch} boxed={false} compact />
        ) : lists.data.length ? (
          <List plain className="rdr-list">
            {lists.data.map((c) => {
              const s = share(c);
              return (
                <ListItem
                  key={c.name}
                  lead={<ItemIcon icon={ListIcon} size="sm" />}
                  title={<span translate="no">{c.displayName}</span>}
                  description={
                    <span className="row gap-4">
                      <s.icon className="i i-xs" aria-hidden />
                      {s.label}
                    </span>
                  }
                  href={`/knowledge/lists/${resourceId(c.name)}`}
                />
              );
            })}
          </List>
        ) : (
          <p className="rdr-none">Not in any reading list you can see.</p>
        )}
      </RailSection>
    </>
  );
}
