"use client";

import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonRows } from "@/components/ui/SkeletonRows";
import { resourceId } from "@/lib/api/client";

import type { Resource } from "../../model";
import { useKnowledgeModel } from "../../queries";
import { ResourceList, ResourceRow } from "../../components/ResourceRow";
import { useRelated } from "../queries";
import { RailSection } from "./AboutPane";

/**
 * Related tab (preview `relatedPane`): similar resources.
 * "Cited in your conversations" is omitted: the API has no query for conversations citing an item.
 */
export function RelatedPane({ resource: r }: { resource: Resource }) {
  const { toResource } = useKnowledgeModel();
  const related = useRelated(r.id, { enabled: r.readable });
  const rows = (related.data?.results ?? []).flatMap((x) => (x.item && resourceId(x.item.name) !== r.id ? [toResource(x.item)] : []));

  return (
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
  );
}
