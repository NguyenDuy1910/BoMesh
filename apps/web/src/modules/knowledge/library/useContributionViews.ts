"use client";

import { useCallback } from "react";

import { useWorkspace } from "@/lib/workspace";

import type { Contribution, Item } from "../api";
import type { LifecycleKey } from "../model";
import { useItemsByName, useKnowledgeModel, useMemberNames } from "../queries";
import { contributionLife, type TimelineContext } from "./contributions";

/** What the contributions list and panel show about one contribution. */
export interface ContributionView {
  contribution: Contribution;
  /** Bare contribution ID (`?open=`). */
  id: string;
  title: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  /** The candidate document (in My files while open; the published document once approved). */
  candidate?: Item;
  /** NEW_REVISION: the published document it revises. */
  revised?: Item;
  /** The document people read once approved (candidate, or the revised one for a new version). */
  published?: Item | null;
  /** Collection display name ("" when not chosen yet). */
  base: string;
  /** Collection item name (target, or the assistant's suggestion). */
  baseName: string;
  life: LifecycleKey;
  mine: boolean;
  ctx: TimelineContext;
}

/**
 * Resolves the items, people and knowledge-base names a set of contributions needs, and returns
 * `view(contribution)`. `isPending` until the candidates have loaded.
 */
export function useContributionViews(contributions: readonly Contribution[]) {
  const { member } = useWorkspace();
  const { ctx: model } = useKnowledgeModel();
  const items = useItemsByName(
    contributions.flatMap((c) => [c.item, c.replacesItem]),
    { reviewerReads: true },
  );
  const names = useMemberNames(
    contributions.flatMap((c) => [c.contributor, c.decision?.reviewer, ...(c.events ?? []).map((e) => e.actor)]),
  );
  const me = member.name ?? "";

  const view = useCallback(
    (c: Contribution): ContributionView => {
      const candidate = c.item ? items.items.get(c.item) : undefined;
      const revised = c.replacesItem ? items.items.get(c.replacesItem) : undefined;
      const published = c.state === "APPROVED" ? (c.kind === "NEW_REVISION" ? (revised ?? null) : (candidate ?? null)) : null;
      const baseName = c.targetCollection || c.suggestions?.collection || "";
      const base = (baseName && model.collectionNames?.get(baseName)) || published?.ancestors?.[0]?.displayName || "";
      const doc = (candidate ?? revised)?.document;
      const mine = !!c.contributor && c.contributor === me;
      // Contribute writes what the contributor confirmed (topics) onto the candidate before submitting.
      const confirmed = c.kind !== "NEW_REVISION" && !!candidate?.document?.topics?.length;
      const ctx: TimelineContext = { me, names, base, audience: c.audienceSummary, published, mine, revisedName: revised?.displayName, confirmed };
      return {
        contribution: c,
        id: (c.name ?? "").slice((c.name ?? "").lastIndexOf("/") + 1),
        title: (candidate ?? revised)?.displayName || doc?.fileName || "Tài liệu chưa đặt tên",
        fileName: doc?.fileName ?? "",
        mime: doc?.mimeType ?? "",
        sizeBytes: Number(doc?.sizeBytes ?? 0),
        candidate,
        revised,
        published,
        base,
        baseName,
        life: contributionLife(c, published),
        mine,
        ctx,
      };
    },
    [items.items, names, model.collectionNames, me],
  );

  return { view, isPending: items.isPending, isError: items.isError, error: items.error, refetch: items.refetch };
}
