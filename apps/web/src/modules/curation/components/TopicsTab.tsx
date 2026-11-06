"use client";

import { Info } from "lucide-react";
import { useMemo } from "react";

import { ErrorState, SkeletonRows } from "@/components/ui";
import { useWorkspace } from "@/lib/workspace";
import { useKnowledgeModel } from "@/modules/knowledge/queries";

import { topicCounts } from "../governance";
import { useAllTopics, useCuratedItems, useReviewQueue } from "../queries";
import { Proposals, type EvidenceIndex } from "./topics/Proposals";
import { Taxonomy } from "./topics/Taxonomy";

/**
 * Manage → Documents › Topics (preview `X.gov.topics`): the assistant's proposed topics
 * (decided by workspace admins) and the domain → topic taxonomy.
 */
export function TopicsTab() {
  const { can } = useWorkspace();
  const admin = can("topics.create");
  const topics = useAllTopics();
  const items = useCuratedItems();
  const queue = useReviewQueue();
  const { toResource } = useKnowledgeModel();

  const counts = useMemo(() => {
    const published = (items.data ?? []).filter((it) => it.document?.publicationState === "PUBLISHED");
    const inReview = (queue.data ?? []).map((s) => [...(s.contribution.suggestions?.topics ?? []), ...(s.contribution.suggestions?.proposedTopics ?? [])]);
    return topicCounts(topics.data ?? [], published, inReview);
  }, [topics.data, items.data, queue.data]);

  const evidence = useMemo<EvidenceIndex>(
    () => new Map((queue.data ?? []).flatMap((s) => (s.item && s.contribution.name ? [[s.contribution.name, toResource(s.item)] as const] : []))),
    [queue.data, toResource],
  );

  if (!topics.data) {
    if (topics.isError) return <ErrorState title="Topics didn’t load" error={topics.error} onRetry={topics.refetch} />;
    return <SkeletonRows rows={6} />;
  }

  const all = topics.data;
  const proposals = all.filter((t) => t.state === "PROPOSED");

  return (
    <div className="kh gov">
      <p className="gov-summary gov-summary--quiet">
        <Info className="i i-sm" aria-hidden />
        <span>Topics describe what documents are about. Types (Policy, Syllabus…) describe what they are.</span>
      </p>
      <Proposals proposals={proposals} topics={all} evidence={evidence} admin={admin} />
      <Taxonomy topics={all} counts={counts} admin={admin} />
    </div>
  );
}
