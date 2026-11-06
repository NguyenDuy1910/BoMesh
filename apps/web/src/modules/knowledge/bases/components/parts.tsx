"use client";

import NextLink from "next/link";

import { StatusChip } from "@/components/ui/StatusChip";
import { useWorkspace } from "@/lib/workspace";
import { spaceType, useSpaces, type Space } from "@/modules/spaces";

import { accessInfo, type AccessKey, type Item } from "../model";

/** Preview `accessChip(kb)`: Everyone / Restricted / Owners only / Only you. */
export function AccessChip({ access, spaceName }: { access: AccessKey | null; spaceName?: string }) {
  const { workspace } = useWorkspace();
  if (!access) return null;
  const a = accessInfo(access, workspace.displayName ?? "", spaceName);
  return <StatusChip label={a.label} icon={a.icon} size="sm" />;
}

/** The space that owns a base (Spaces module on, space visible to the caller). */
export function useBaseSpace(base: Item | null | undefined): Space | null {
  const { hasModule } = useWorkspace();
  const spaces = useSpaces();
  const name = base?.collection?.space;
  if (!hasModule("spaces") || !name) return null;
  return (spaces.data ?? []).find((s) => s.name === name) ?? null;
}

/** Preview `spaceChip(sp)`: type icon + name, tooltip "Type · Name"; a link on the base page. */
export function SpaceChip({ space, link }: { space: Space; link?: boolean }) {
  const { settings } = useWorkspace();
  const type = spaceType(space.spaceType, settings ?? undefined);
  const chip = <StatusChip label={space.displayName ?? ""} icon={type.icon} size="sm" tooltip={`${type.label} · ${space.displayName ?? ""}`} />;
  if (!link) return chip;
  return (
    <NextLink className="kb-space-link" href={`/space/${space.name?.slice(space.name.lastIndexOf("/") + 1) ?? ""}`}>
      {chip}
    </NextLink>
  );
}

/** Preview `ownersLabel(kb)` from what the API exposes to non-owners (`collection.ownerSummary`); "" when unknown. */
export const ownersLabel = (base: Item | null | undefined) => base?.collection?.ownerSummary?.trim() ?? "";
