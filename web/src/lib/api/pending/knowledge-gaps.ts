/**
 * Local implementation of `analytics.knowledge_gaps`. Imported only by
 * `modules/manage/overview/api.ts`.
 *
 * The questions are a fixed seed — no backend records unanswered questions
 * yet. Only dismissals are stored, per account and workspace. A suggested
 * collection is chosen among the caller's REAL collections by topic words in
 * its title; when none matches (or collections cannot be read) the suggestion
 * stays empty rather than pointing at something that does not exist.
 */

import { ApiError } from "@/lib/api/request";
import { pendingCaller, pendingStore, requirePendingPermission } from "@/lib/api/pending";
import { collectionsApi } from "@/modules/ingestion/integrations-api";
import type {
  KnowledgeGap,
  KnowledgeGapList,
  KnowledgeGapQuery,
  KnowledgeGapReason,
} from "@/modules/manage/overview/api";

interface SeedGap {
  id: string;
  question: string;
  asked: { "7d": number; "30d": number };
  /** Hours before now it was last asked. */
  lastAskedHoursAgo: number;
  reason: KnowledgeGapReason;
  /** Words that, found in a collection title, make it the place to add the answer. */
  topics: readonly string[];
}

const SEED: readonly SeedGap[] = [
  {
    id: "gap-contractor-notice",
    question: "What is the notice period for contractors?",
    asked: { "7d": 23, "30d": 71 },
    lastAskedHoursAgo: 3,
    reason: "not_covered",
    topics: ["hr", "people", "policy", "policies", "handbook"],
  },
  {
    id: "gap-scim-provisioning",
    question: "Do we support SCIM user provisioning?",
    asked: { "7d": 17, "30d": 52 },
    lastAskedHoursAgo: 7,
    reason: "outdated",
    topics: ["product", "release", "engineering", "security", "docs"],
  },
  {
    id: "gap-renewal-discount",
    question: "What discount can I offer on renewals over $100k?",
    asked: { "7d": 11, "30d": 34 },
    lastAskedHoursAgo: 26,
    reason: "rated_unhelpful",
    topics: ["sales", "pricing", "commercial", "playbook", "playbooks"],
  },
  {
    id: "gap-travel-approval",
    question: "Who approves travel to high-risk countries?",
    asked: { "7d": 6, "30d": 19 },
    lastAskedHoursAgo: 50,
    reason: "not_covered",
    topics: ["travel", "hr", "policy", "policies", "finance"],
  },
  {
    id: "gap-laptop-replacement",
    question: "How do I request a replacement laptop?",
    asked: { "7d": 0, "30d": 9 },
    lastAskedHoursAgo: 14 * 24,
    reason: "not_covered",
    topics: ["it", "equipment", "operations", "helpdesk"],
  },
];

/** Gap id → when it was dismissed. */
interface GapState {
  dismissed: Record<string, string>;
}

const HOUR = 3_600_000;

/** The caller's dismissals, once the proposed contract's checks pass. */
function authorizedStore(workspaceId: string) {
  const caller = pendingCaller(workspaceId);
  requirePendingPermission(caller, "tenant.manage", "You need permission to manage this workspace to see knowledge gaps.");
  // Like `/workspaces/{id}/overview`, only the active workspace answers.
  if (caller.session?.active_workspace_id !== workspaceId) {
    throw new ApiError("This workspace no longer exists, or was moved.", 404);
  }
  return pendingStore<GapState>("analytics.knowledge_gaps", caller.accountId, caller.workspaceId, () => ({ dismissed: {} }));
}

type CollectionRef = { id: string; title: string };

async function readableCollections(): Promise<CollectionRef[]> {
  try {
    const page = await collectionsApi.list();
    return page.items
      .filter((item) => item.item_type === "collection")
      .map((item) => ({ id: item.id, title: item.title }))
      .sort((left, right) => left.title.localeCompare(right.title));
  } catch {
    return [];
  }
}

function suggestionFor(seed: SeedGap, collections: readonly CollectionRef[]): CollectionRef | null {
  return collections.find((collection) => {
    const words = new Set(collection.title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    return seed.topics.some((topic) => words.has(topic));
  }) ?? null;
}

function toGap(seed: SeedGap, window: KnowledgeGapQuery["window"], state: GapState, collections: readonly CollectionRef[], now: number): KnowledgeGap {
  const suggestion = suggestionFor(seed, collections);
  // Whole hours, so an untouched list reads the same on every reload within the hour.
  const lastAsked = Math.floor(now / HOUR) * HOUR - seed.lastAskedHoursAgo * HOUR;
  const dismissedAt = state.dismissed[seed.id] ?? null;
  return {
    id: seed.id,
    question: seed.question,
    times_asked: seed.asked[window],
    last_asked_at: new Date(lastAsked).toISOString(),
    reason: seed.reason,
    suggested_collection_id: suggestion?.id ?? null,
    suggested_collection_title: suggestion?.title ?? null,
    dismissed: dismissedAt !== null,
    dismissed_at: dismissedAt,
  };
}

export const pendingKnowledgeGaps = {
  async list(workspaceId: string, query: KnowledgeGapQuery): Promise<KnowledgeGapList> {
    const store = authorizedStore(workspaceId);
    if (query.window !== "7d" && query.window !== "30d") {
      throw new ApiError("Choose a window of 7 or 30 days.", 422);
    }
    const state = store.read();
    const collections = await readableCollections();
    const now = Date.now();
    const items = SEED
      .filter((seed) => seed.asked[query.window] > 0)
      .map((seed) => toGap(seed, query.window, state, collections, now))
      .filter((gap) => query.include_dismissed || !gap.dismissed)
      .sort((left, right) => right.times_asked - left.times_asked);
    return { window: query.window, generated_at: new Date(now).toISOString(), items };
  },

  async update(workspaceId: string, gapId: string, body: { dismissed: boolean }): Promise<KnowledgeGap> {
    const store = authorizedStore(workspaceId);
    if (typeof body?.dismissed !== "boolean") {
      throw new ApiError("Say whether the gap is dismissed.", 422);
    }
    const seed = SEED.find((candidate) => candidate.id === gapId);
    if (!seed) throw new ApiError("This knowledge gap no longer exists.", 404);
    const state = store.update((current) => {
      const dismissed = { ...current.dismissed };
      if (body.dismissed) dismissed[gapId] = dismissed[gapId] ?? new Date().toISOString();
      else delete dismissed[gapId];
      return { dismissed };
    });
    return toGap(seed, "30d", state, await readableCollections(), Date.now());
  },
};
