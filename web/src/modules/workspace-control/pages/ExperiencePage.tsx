"use client";

import { NotBackedYet } from "@/components/ui/NotBackedYet";
import { SectionHeader } from "@/modules/workspace-control/components/SectionHeader";

export function ExperiencePage() {
  return (
    <>
      <SectionHeader section="experience" />
      <NotBackedYet
        description="Members currently see the default welcome screen and starter prompts. Custom welcome copy, prompts and appearance will be managed here."
        title="Workspace experience settings aren't available yet"
      />
    </>
  );
}
