"use client";

import { Button } from "@heroui/react";
import { Plus, Upload } from "lucide-react";
import { useSearchParams } from "next/navigation";

import { PageChrome } from "@/components/shell/page-chrome";
import { Page } from "@/components/ui/Page";
import { SectionTabs, type SectionTab } from "@/components/ui/SectionTabs";
import { useWorkspace } from "@/lib/workspace";

import { openContribute } from "../../components/Contribute";
import { openReadingListEditor } from "../../components/dialogs";
import { KnowledgeHeader } from "../../components/KnowledgeHeader";
import { useMyContributions, useReadingLists, useRecentItems, useSavedItems, useSavedSearches } from "../../queries";
import { useMyFiles } from "../queries";
import { CollectionsTab } from "./CollectionsTab";
import { ContributionsTab } from "./ContributionsTab";
import { FilesTab } from "./FilesTab";
import { RecentTab } from "./RecentTab";
import { SavedTab } from "./SavedTab";
import { ViewsTab } from "./ViewsTab";

type LibraryTab = "saved" | "recent" | "contributions" | "files" | "collections" | "views";

const TABS: ReadonlyArray<readonly [LibraryTab, string]> = [
  ["saved", "Saved"],
  ["recent", "Recent"],
  ["contributions", "Contributions"],
  ["files", "My files"],
  ["collections", "Collections"],
  ["views", "Saved views"],
];

/**
 * My library (`/knowledge/library?tab=saved|recent|contributions|files|collections|views`):
 * the personal side of Knowledge (preview `P.library`).
 */
export function LibraryPage() {
  const params = useSearchParams();
  const { can, member } = useWorkspace();
  const saved = useSavedItems();
  const recent = useRecentItems();
  const contributions = useMyContributions({ view: "FULL" });
  const files = useMyFiles();
  const lists = useReadingLists();
  const views = useSavedSearches();

  const canContribute = can("contributions.create");
  const mine = (contributions.data ?? []).filter((c) => c.state !== "WITHDRAWN");
  const counts: Record<LibraryTab, number | undefined> = {
    saved: saved.data?.length,
    recent: recent.data?.length,
    contributions: contributions.data ? mine.length : undefined,
    files: files.data?.length,
    collections: lists.data?.filter((l) => l.type !== "FEATURED").length,
    views: views.data?.length,
  };
  const shown: Partial<Record<LibraryTab, boolean>> = { files: !!member.personalCollection, contributions: canContribute || mine.length > 0 };
  const items: SectionTab[] = TABS.filter(([id]) => shown[id] ?? true).map(([id, label]) => ({
    id,
    label,
    count: counts[id],
    alert: id === "contributions" && mine.some((c) => c.state === "CHANGES_REQUESTED"),
  }));
  const requested = params.get("tab") ?? "";
  const tab = (items.some((t) => t.id === requested) ? requested : "saved") as LibraryTab;

  return (
    <Page className="lib">
      <PageChrome crumbs={[{ label: "Knowledge", href: "/knowledge" }, { label: "My library" }]} />
      <KnowledgeHeader
        active="library"
        actions={
          <>
            {canContribute ? (
              <Button variant="secondary" onPress={() => openContribute()}>
                <Upload className="i" aria-hidden />
                Contribute
              </Button>
            ) : null}
            <Button variant="primary" onPress={() => openReadingListEditor()}>
              <Plus className="i" aria-hidden />
              New collection
            </Button>
          </>
        }
      />
      <div className="page-tabs">
        <SectionTabs items={items} active={tab} base="/knowledge/library" />
      </div>
      {tab === "saved" ? <SavedTab /> : null}
      {tab === "recent" ? <RecentTab /> : null}
      {tab === "contributions" ? <ContributionsTab /> : null}
      {tab === "files" ? <FilesTab /> : null}
      {tab === "collections" ? <CollectionsTab /> : null}
      {tab === "views" ? <ViewsTab /> : null}
    </Page>
  );
}
