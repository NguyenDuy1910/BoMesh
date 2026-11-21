"use client";

import { Page } from "@/components/ui/Page";
import { useSection } from "@/lib/navigation";

import { KnowledgeHeader, useLibrarySections, type LibrarySection } from "../../components/KnowledgeHeader";
import { FilesSection } from "./FilesSection";
import { SavedSection } from "./SavedSection";

/**
 * Knowledge's personal sections (`/knowledge/library?tab=saved|files`, preview `P.library`): Saved and My files,
 * each a sidebar sub-row titled by its name. No tab bar and no header action: each section
 * carries its own one action in its toolbar.
 */
export function LibraryPage() {
  const tab = useSection(useLibrarySections(), "saved") as LibrarySection;
  return (
    <Page width="wide" className="lib">
      <KnowledgeHeader section={tab} actions={null} />
      {tab === "files" ? <FilesSection /> : <SavedSection />}
    </Page>
  );
}
