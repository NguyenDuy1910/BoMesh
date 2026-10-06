/**
 * Overview data the API does not serve yet.
 *
 * Knowledge gaps are questions people asked that knowledge could not answer
 * well. The proposed contract is `GET /workspaces/{workspace_id}/knowledge-gaps`
 * and `PATCH /workspaces/{workspace_id}/knowledge-gaps/{gap_id}`
 * (`api_contract.md#proposed-analytics-knowledge-gaps`); until it exists the
 * pending layer answers, so swapping in the real request changes only the
 * bodies below.
 */

import { invalidateApiData } from "@/lib/api/revision";
import { pendingApi } from "@/lib/api/pending";
import { pendingKnowledgeGaps } from "@/lib/api/pending/knowledge-gaps";

export type KnowledgeGapWindow = "7d" | "30d";

/** Why the question counts as a gap. The screen words it; the API never sends prose. */
export type KnowledgeGapReason = "not_covered" | "outdated" | "rated_unhelpful";

/** One unanswered question (proposed `KnowledgeGap`). */
export interface KnowledgeGap {
  id: string;
  question: string;
  /** Times it was asked inside the requested window. */
  times_asked: number;
  last_asked_at: string;
  reason: KnowledgeGapReason;
  /** Best collection to add documents to, when one is known; never invented. */
  suggested_collection_id: string | null;
  suggested_collection_title: string | null;
  dismissed: boolean;
  dismissed_at: string | null;
}

export interface KnowledgeGapList {
  window: KnowledgeGapWindow;
  generated_at: string;
  items: KnowledgeGap[];
}

export interface KnowledgeGapQuery {
  window: KnowledgeGapWindow;
  /** Dismissed gaps are left out unless asked for. */
  include_dismissed?: boolean;
}

/** Questions knowledge could not answer well, most asked first. Needs `tenant.manage`. */
export function listKnowledgeGaps(workspaceId: string, query: KnowledgeGapQuery): Promise<KnowledgeGapList> {
  return pendingApi("analytics.knowledge_gaps", () => pendingKnowledgeGaps.list(workspaceId, query));
}

/** Dismiss a gap, or bring it back (Undo). Needs `tenant.manage`. */
export async function updateKnowledgeGap(
  workspaceId: string,
  gapId: string,
  body: { dismissed: boolean },
): Promise<KnowledgeGap> {
  const gap = await pendingApi("analytics.knowledge_gaps", () => pendingKnowledgeGaps.update(workspaceId, gapId, body));
  invalidateApiData();
  return gap;
}
