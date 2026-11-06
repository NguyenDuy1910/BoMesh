"use client";

import { Button } from "@heroui/react";
import { Upload } from "lucide-react";
import { useSearchParams } from "next/navigation";

import { Page, PageHeader, PreviewChip, SectionTabs } from "@/components/ui";
import { PageChrome } from "@/components/shell/page-chrome";
import { useWorkspace } from "@/lib/workspace";
import { openContribute } from "@/modules/knowledge/components/Contribute";

import { DOCS_BASE, TABS, type CurationTab } from "../model";
import { useAllTopics, useReviewQueue } from "../queries";
import { useHeldDecisions } from "../decisions";
import { AllDocumentsTab } from "./AllDocumentsTab";
import { QualityTab } from "./QualityTab";
import { ReviewTab } from "./ReviewTab";
import { TopicsTab } from "./TopicsTab";

/** Old Knowledge health tabs land on Quality segments. */
const LEGACY_SEG: Readonly<Record<string, string>> = { details: "details", duplicates: "duplicates" };

/**
 * Manage → Documents (preview `P.documentsAdmin`): the reviewer's home for curation and
 * publication. Review (queue + decision), All documents, Quality, Topics.
 */
export function DocumentsPage() {
  const params = useSearchParams();
  const { workspace, can } = useWorkspace();
  const queue = useReviewQueue();
  const topics = useAllTopics();
  const held = useHeldDecisions();
  const waiting = (queue.data ?? []).filter((s) => !held.has(s.contribution.name ?? "")).length;
  const proposals = (topics.data ?? []).filter((t) => t.state === "PROPOSED").length;

  const raw = params.get("tab") ?? "";
  const tab: CurationTab = LEGACY_SEG[raw] ? "quality" : (TABS as readonly string[]).includes(raw) ? (raw as CurationTab) : queue.data && !waiting ? "all" : "review";
  const kb = params.get("kb") ?? "";

  return (
    <Page className="cur">
      <PageChrome crumbs={[{ label: "Documents" }]} />
      <PageHeader
        title="Documents"
        chips={workspace.demo ? <PreviewChip label="Demo data" /> : null}
        description="Every document in the bases you look after, from submission to publication."
        actions={
          can("contributions.create") ? (
            <Button variant="primary" onPress={() => openContribute(kb ? { collection: kb } : {})}>
              <Upload className="i" aria-hidden />
              Upload
            </Button>
          ) : null
        }
      >
        <SectionTabs
          base={DOCS_BASE}
          active={tab}
          label="Documents"
          items={[
            { id: "review", label: "Review", count: waiting || null, alert: true },
            { id: "all", label: "All documents" },
            { id: "quality", label: "Quality" },
            { id: "topics", label: "Topics", count: proposals || null },
          ]}
        />
      </PageHeader>
      {tab === "review" ? <ReviewTab /> : tab === "all" ? <AllDocumentsTab /> : tab === "quality" ? <QualityTab /> : <TopicsTab />}
    </Page>
  );
}
