"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

import { useStudioAccess } from "@/components/shell/badges";
import { NoAccess } from "@/components/shell/NoAccess";
import { Page, PageHeader, SkeletonRows } from "@/components/ui";
import { useMessages } from "@/lib/i18n";
import { studioAddress, studioLanding, studioSections } from "@/lib/navigation";
import { CollectionsSection } from "@/modules/knowledge/bases";
import { SourcesSection, useSourcesNeedAttention } from "@/modules/ingestion";

import { decisionCount } from "../model";
import { useDocCounts } from "../queries";
import { DocumentsSection } from "./DocumentsSection";
import { TopicsSection } from "./TopicsSection";

/**
 * Knowledge Studio (`/studio`, preview `P.studio`): the one place knowledge is run, in four sections — Documents ·
 * Collections · Topics · Sources. They are sidebar sub-rows (no tab bar); `?tab=` picks one and each section draws its
 * own header (title = section name and its one action). Without a `?tab=` the page opens on what needs the caller:
 * Documents when decisions wait, else Sources when something is broken, else the first section they may use. Old
 * addresses (`studioAddress`) are replaced with the current one.
 */
export function StudioPage() {
  const access = useStudioAccess();
  const m = useMessages();
  const sections = studioSections(access);
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const counts = useDocCounts();
  const broken = useSourcesNeedAttention();

  const legacy = studioAddress(Object.fromEntries(params));
  const next = legacy ? new URLSearchParams(legacy).toString() : "";
  useEffect(() => {
    if (next) router.replace(`${pathname}?${next}`, { scroll: false });
  }, [next, pathname, router]);

  const raw = params.get("tab") ?? "";
  const explicit = sections.some((s) => s.id === raw);
  const has = (id: string) => sections.some((s) => s.id === id);
  const landingPending = access.pending || (has("documents") && counts.isPending);
  const tab = explicit ? raw : studioLanding(sections, { documents: counts.data ? decisionCount(counts.data) : 0, sources: broken ? 1 : 0 });

  if (!sections.length) return access.pending ? <SkeletonRows rows={6} /> : <NoAccess />;

  return (
    <Page width="wide" className="page--studio cur">
      {next || (!explicit && landingPending) ? (
        <>
          <PageHeader title={m.nav.studio} />
          <SkeletonRows rows={6} />
        </>
      ) : tab === "documents" ? (
        <DocumentsSection />
      ) : tab === "collections" ? (
        <CollectionsSection />
      ) : tab === "topics" ? (
        <TopicsSection />
      ) : (
        <SourcesSection />
      )}
    </Page>
  );
}
