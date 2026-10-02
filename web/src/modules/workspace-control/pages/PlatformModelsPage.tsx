"use client";

import { NotBackedYet } from "@/components/ui/NotBackedYet";
import { SectionHeader } from "@/modules/workspace-control/components/SectionHeader";

export function PlatformModelsPage() {
  return (
    <>
      <SectionHeader section="platform-models" />
      <NotBackedYet
        description="Every tenant uses the models this deployment is configured with. Per-tenant model and capability policy will be managed here."
        title="Model policy isn't available yet"
      />
    </>
  );
}
