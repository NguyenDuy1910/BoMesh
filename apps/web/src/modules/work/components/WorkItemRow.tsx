"use client";

import { ListItem } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { rel } from "@/lib/format";

import { workSummary, type Artifact } from "../model";
import { WorkStatusChip, WorkTile } from "./parts";

export interface WorkItemRowProps {
  artifact: Artifact;
  /** Opened from a space: the work page crumbs back to the space's Work tab. */
  from?: "space";
  /** Name of the artifact's space, shown after the summary. */
  spaceName?: string;
}

/** One piece of work in a list (preview `X.workItem`). Render inside a Kit `<List>`. */
export function WorkItemRow({ artifact, from, spaceName }: WorkItemRowProps) {
  const id = resourceId(artifact.name);
  return (
    <ListItem
      lead={<WorkTile kind={artifact.kind} />}
      title={<span translate="no">{artifact.displayName}</span>}
      titleExtra={<WorkStatusChip artifact={artifact} />}
      description={[workSummary(artifact), spaceName].filter(Boolean).join(" · ")}
      meta={rel(artifact.updateTime)}
      href={`/work/${id}${from ? `?from=${from}` : ""}`}
    />
  );
}
