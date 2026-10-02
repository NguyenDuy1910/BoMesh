"use client";

import { NotBackedYet } from "@/components/ui/NotBackedYet";
import { SectionHeader } from "@/modules/workspace-control/components/SectionHeader";

export function PlatformUsagePage() {
  return (
    <>
      <SectionHeader section="platform-usage" />
      <NotBackedYet
        description="Conversation volume, indexed documents and model spend per tenant will be reported here."
        title="Usage reporting isn't available yet"
      />
    </>
  );
}
