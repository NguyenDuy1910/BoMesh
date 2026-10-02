"use client";

import { SectionHeader } from "@/modules/workspace-control/components/SectionHeader";
import { ActivityTable } from "@/modules/workspace-control/pages/AuditPage";

export function PlatformAuditPage() {
  return <>
    <SectionHeader section="platform-audit" />
    <ActivityTable platform />
  </>;
}
