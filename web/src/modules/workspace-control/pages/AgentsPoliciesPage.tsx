"use client";

import { NotBackedYet } from "@/components/ui/NotBackedYet";
import { SectionHeader } from "@/modules/workspace-control/components/SectionHeader";

export function AgentsPoliciesPage() {
  return (
    <>
      <SectionHeader section="agent" />
      <NotBackedYet
        description="The assistant uses this deployment's default name, instructions and model. Workspace-specific assistant settings will be managed here."
        title="Assistant settings aren't available yet"
      />
    </>
  );
}
