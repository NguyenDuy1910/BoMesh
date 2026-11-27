"use client";

import { useQuery } from "@tanstack/react-query";

import { api, call } from "@/lib/api/client";
import { studioLanding, studioSections, type NavBadge, type Section, type StudioAccess } from "@/lib/navigation";
import { useWorkspace } from "@/lib/workspace";
import { useKnowledgeBases } from "@/modules/knowledge/queries";
import { useRequestsBadge } from "@/modules/requests";
import { countRequests } from "@/modules/requests/api";

/**
 * Attention counts on sidebar rows and sub-rows (preview `navItem` counts): only what waits on the caller. Each is
 * one `pageSize=1` list call with a server filter, read from `totalSize`, and only when the caller may make it.
 * Mutations invalidate `[workspace, "shell-badge"]`, so the counts stay cached across navigation (and, via
 * `sessionStorage`, across reloads inside the stale window).
 */
const STALE = 5 * 60_000;
const FAILING = 'state = "FAILED" OR state = "REAUTHORIZATION_REQUIRED"';

/** A count and what it means: accent = needs you, danger = something is broken. */
export interface Count {
  n: number;
  tone: "accent" | "danger";
}

export interface NavCounts {
  /** Row badges by `NavItem.badge`. */
  rows: Partial<Record<NavBadge, Count>>;
  /** Sub-row counts by section id, per sections list. */
  sections: { studio: Partial<Record<string, Count>>; people: Partial<Record<string, Count>> };
  /** My contributions shows to contributors and to anyone with submissions to follow. */
  hasContributions: boolean;
}

const count = (n: number | undefined, tone: Count["tone"] = "accent"): Count | undefined => (n ? { n, tone } : undefined);

/**
 * What decides Knowledge Studio's sections: workspace permissions plus collection ownership. Owning or editing one
 * shared collection is a per-collection grant, not a workspace permission, so without `items.create` the root
 * collections list decides (personal collections don't count).
 */
export function useStudioAccess(): StudioAccess & { pending: boolean } {
  const { can } = useWorkspace();
  const creator = can("items.create");
  const bases = useKnowledgeBases({ enabled: !creator });
  const managesCollections =
    creator || (bases.data ?? []).some((b) => b.itemType !== "PERSONAL" && (b.access === "OWNER" || b.access === "EDITOR"));
  return { can, managesCollections, pending: !creator && bases.isPending };
}

/** Knowledge Studio's sections for the caller (`studioSections` with collection ownership resolved). */
export function useStudioSections(): Section[] {
  return studioSections(useStudioAccess());
}

/** A badge count kept in `sessionStorage` too, so a reload inside the {@link STALE} window doesn't recount. */
function useCount(key: string, enabled: boolean, fn: () => Promise<number>): number | undefined {
  const { id, memberId } = useWorkspace();
  // Per member: another account signing in on this tab never sees the previous one's counts.
  const storageKey = `bomesh.badge.${id}.${memberId}.${key}`;
  return useQuery({
    queryKey: [id, "shell-badge", key],
    enabled,
    staleTime: STALE,
    queryFn: async () => {
      const n = await fn();
      try {
        sessionStorage.setItem(storageKey, JSON.stringify({ n, at: Date.now() }));
      } catch {
        // Storage full or unavailable: the count only lives in memory.
      }
      return n;
    },
    initialData: () => stored(storageKey)?.n,
    initialDataUpdatedAt: () => stored(storageKey)?.at,
  }).data;
}

function stored(storageKey: string): { n: number; at: number } | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as { n?: unknown; at?: unknown } | null;
    return typeof value?.n === "number" && typeof value.at === "number" ? { n: value.n, at: value.at } : undefined;
  } catch {
    return undefined;
  }
}

export function useNavBadges(): NavCounts {
  const { id, can, hasModule, member } = useWorkspace();
  const path = { workspace: id };
  const me = member.name ?? "";
  const admin = can("members.create");
  const sections = useStudioSections();
  const has = (s: string) => sections.some((x) => x.id === s);

  const requests = useRequestsBadge();
  const review = useCount("review", has("documents"), async () =>
    (await call(api.GET("/api/v1/workspaces/{workspace}/contributions", { params: { path, query: { pageSize: 1, filter: 'state = "IN_REVIEW"' } } })))
      .totalSize ?? 0,
  );
  const sources = useCount("sources", has("sources"), async () =>
    (await call(api.GET("/api/v1/workspaces/{workspace}/sources", { params: { path, query: { pageSize: 1, filter: FAILING } } }))).totalSize ?? 0,
  );
  const accounts = useCount("connections", has("sources") && can("connections.list"), async () =>
    (await call(api.GET("/api/v1/workspaces/{workspace}/connections", { params: { path, query: { pageSize: 1, filter: FAILING } } }))).totalSize ?? 0,
  );
  // Access requests: workspace admins decide them in People › Access requests; a collection owner in Studio › Collections.
  const access = useCount("access", hasModule("requests") && (admin || has("collections")), () =>
    countRequests(id, `kind = "COLLECTION_ACCESS" AND state = "OPEN" AND requester != "${me}"`),
  );
  // Changes requested waits on contributors; anyone else sees My contributions only once they have some, so they
  // count those first and ask about changes only when there are any.
  const contributionFilter = `contributor = "workspaces/${id}/members/me"`;
  const contributor = can("contributions.create");
  const mine = useCount("my-contributions", !contributor, async () =>
    (await call(api.GET("/api/v1/workspaces/{workspace}/contributions", { params: { path, query: { pageSize: 1, filter: contributionFilter } } }))).totalSize ?? 0,
  );
  const changes = useCount("contributions", contributor || Boolean(mine), async () =>
    (
      await call(
        api.GET("/api/v1/workspaces/{workspace}/contributions", {
          params: { path, query: { pageSize: 1, filter: `${contributionFilter} AND state = "CHANGES_REQUESTED"` } },
        }),
      )
    ).totalSize ?? 0,
  );

  const sourceProblems = (sources ?? 0) + (accounts ?? 0);
  const ownerRequests = admin ? 0 : (access ?? 0);
  const studio = {
    documents: count(review),
    collections: count(ownerRequests),
    sources: count(sourceProblems, "danger"),
  };
  // The Studio row carries the landing section's count: decisions in Documents, else broken sources, else access requests.
  const landing = studioLanding(sections, { documents: review, sources: sourceProblems });
  const studioRow = landing === "documents" ? studio.documents : landing === "sources" ? studio.sources : studio.collections;

  return {
    rows: {
      requests: count(requests),
      contributions: count(changes),
      studio: studioRow,
      people: count(admin ? access : 0),
    },
    sections: { studio, people: { requests: count(admin ? access : 0) } },
    hasContributions: contributor || Boolean(mine),
  };
}
