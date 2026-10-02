"use client";

import { NotBackedYet } from "@/components/ui/NotBackedYet";
import { SectionHeader } from "@/modules/workspace-control/components/SectionHeader";

export function PlatformPublicWorkspacesPage() {
  return (
    <>
      <SectionHeader section="platform-public-workspaces" />
      <NotBackedYet
        description="Guests land in the public workspace this deployment is configured with. Choosing and changing public workspaces will be managed here."
        title="Public workspace settings aren't available yet"
      />
    </>
  );
}
