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
  /** Name of the artifact's space, shown after the summary (omit inside a space). */
  spaceName?: string;
  /** Work shared with you: the owner's name ("by …"). */
  ownerName?: string;
  /** The viewer runs the artifact's space (a quiz shows Draft / Published). */
  staffQuiz?: boolean;
}

/** One piece of work in a list (preview `X.workItem`). Render inside a Kit `<List>`. */
export function WorkItemRow({ artifact, from, spaceName, ownerName, staffQuiz }: WorkItemRowProps) {
  const id = resourceId(artifact.name);
  return (
    <ListItem
      lead={<WorkTile kind={artifact.kind} />}
      title={<span translate="no">{artifact.displayName}</span>}
      titleExtra={<WorkStatusChip artifact={artifact} staffQuiz={staffQuiz} />}
      description={[workSummary(artifact), spaceName, ownerName ? `by ${ownerName}` : ""].filter(Boolean).join(" · ")}
      meta={rel(artifact.updateTime)}
      href={`/work/${id}${from ? `?from=${from}` : ""}`}
    />
  );
}
