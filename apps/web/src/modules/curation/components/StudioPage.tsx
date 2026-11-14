"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

import { useStudioAccess } from "@/components/shell/badges";
import { NoAccess } from "@/components/shell/NoAccess";
import { Page, PageHeader, SkeletonRows } from "@/components/ui";
import { STUDIO_ALIASES, studioLanding, studioSections } from "@/lib/navigation";
import { CollectionsSection } from "@/modules/knowledge/bases";
import { SourcesSection, useSourcesNeedAttention } from "@/modules/ingestion";

import { decisionCount } from "../model";
import { useReviewQueueCounts } from "../queries";
import { DocumentsSection } from "./DocumentsSection";
import { ReviewSection } from "./ReviewSection";
import { TaxonomySection } from "./TaxonomySection";

/** Knowledge health's old tabs are Review queues now. */
const QUEUE_TABS = ["details", "duplicates"];

/**
 * Knowledge Studio (`/studio`, preview `P.studio`): the one place knowledge is run. Its sections are sidebar
 * sub-rows (no tab bar); `?tab=` picks one and each section draws its own header (title = section name and its
 * one action). Without a `?tab=` the page opens on what needs the caller: Review when decisions wait, else
 * Sources when something is broken, else the first section they may use. Old section ids land on the new ones.
 */
export function StudioPage() {
  const access = useStudioAccess();
  const sections = studioSections(access);
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const counts = useReviewQueueCounts();
  const broken = useSourcesNeedAttention();

  const raw = params.get("tab") ?? "";
  const alias = STUDIO_ALIASES[raw] ?? (QUEUE_TABS.includes(raw) ? "review" : undefined);
  const wanted = alias ?? raw;
  const explicit = sections.some((s) => s.id === wanted);
  const has = (id: string) => sections.some((s) => s.id === id);
  const landingPending = access.pending || (has("review") && counts.isPending);
  const tab = explicit ? wanted : studioLanding(sections, { review: counts.data ? decisionCount(counts.data) : 0, sources: broken ? 1 : 0 });

  // Old addresses the redirects didn't rewrite (?tab=all|master|details|duplicates|quality, ?seg=) land on the canonical one.
  useEffect(() => {
    if (!alias || !explicit) return;
    const next = new URLSearchParams(params.toString());
    next.set("tab", alias);
    if (QUEUE_TABS.includes(raw) && !next.get("queue")) next.set("queue", raw);
    if (raw === "quality" && !next.get("queue")) next.set("queue", next.get("seg") || "quality");
    next.delete("seg");
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }, [raw, alias, explicit, params, pathname, router]);

  if (!sections.length) return access.pending ? <SkeletonRows rows={6} /> : <NoAccess />;

  return (
    <Page width="wide" className="page--studio cur">
      {!explicit && landingPending ? (
        <>
          <PageHeader title="Knowledge Studio" />
          <SkeletonRows rows={6} />
        </>
      ) : tab === "review" ? (
        <ReviewSection />
      ) : tab === "documents" ? (
        <DocumentsSection />
      ) : tab === "collections" ? (
        <CollectionsSection />
      ) : tab === "taxonomy" ? (
        <TaxonomySection />
      ) : (
        <SourcesSection />
      )}
    </Page>
  );
}
