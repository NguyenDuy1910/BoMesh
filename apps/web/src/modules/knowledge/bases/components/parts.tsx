"use client";

import { StatusChip } from "@/components/ui/StatusChip";
import { useWorkspace } from "@/lib/workspace";

import { accessInfo, type AccessKey, type Item } from "../model";

/** Preview `accessChip(kb)`: Everyone / Restricted / Owners only / Only you. */
export function AccessChip({ access }: { access: AccessKey | null }) {
  const { workspace } = useWorkspace();
  if (!access) return null;
  const a = accessInfo(access, workspace);
  return <StatusChip label={a.label} icon={a.icon} size="sm" />;
}

/** Preview `ownersLabel(kb)` from what the API exposes to non-owners (`collection.ownerSummary`); "" when unknown. */
export const ownersLabel = (base: Item | null | undefined) => base?.collection?.ownerSummary?.trim() ?? "";
