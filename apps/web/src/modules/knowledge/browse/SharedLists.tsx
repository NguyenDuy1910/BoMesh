"use client";

import { List as ListIcon } from "lucide-react";
import NextLink from "next/link";
import { useState } from "react";

import { ItemIcon } from "@/components/ui/ItemIcon";
import { LinkButton } from "@/components/ui/LinkButton";
import { resourceId } from "@/lib/api/client";
import { fmtNum, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { useShareLabel } from "../components/share-label";
import { useReadingLists } from "../queries";

const SHOWN = 3;

/**
 * Landing only (preview `collectionsRow`): reading lists curated for you — shared with the workspace or your
 * spaces, not your own (those are in My reading lists) — featured first, then the most recently updated.
 */
export function SharedLists() {
  const { member, memberId } = useWorkspace();
  const lists = useReadingLists();
  const shareLabel = useShareLabel();
  const [open, setOpen] = useState(false);
  const all = (lists.data ?? [])
    .filter((l) => l.owner !== member.name && resourceId(l.owner) !== memberId && (l.itemCount ?? 0) > 0)
    .sort((a, b) => (b.type === "FEATURED" ? 1 : 0) - (a.type === "FEATURED" ? 1 : 0) || (Date.parse(b.updateTime ?? "") || 0) - (Date.parse(a.updateTime ?? "") || 0));
  if (!all.length) return null;
  const shown = open ? all : all.slice(0, SHOWN);
  return (
    <section className="cat-cols" aria-labelledby="cat-cols-h">
      <div className="cat-cols__head">
        <h2 className="cat-cols__title" id="cat-cols-h">
          Shared with you
        </h2>
        <span className="grow" />
        {all.length > SHOWN ? <LinkButton onPress={() => setOpen(!open)}>{open ? "Show less" : `Show all ${fmtNum(all.length)}`}</LinkButton> : null}
      </div>
      <div className="cat-cols__list">
        {shown.map((l) => (
          <NextLink key={l.name} className="cat-col" href={`/knowledge/lists/${resourceId(l.name)}`}>
            <ItemIcon icon={ListIcon} tone={l.type === "FEATURED" ? "accent" : undefined} size="sm" />
            <span className="cat-col__body">
              <span className="cat-col__title truncate" translate="no">
                {l.displayName}
              </span>
              <span className="cat-col__sub truncate">
                {plural(l.itemCount ?? 0, "item")} · <span translate={l.description ? "no" : undefined}>{l.description || shareLabel(l).label}</span>
              </span>
            </span>
          </NextLink>
        ))}
      </div>
    </section>
  );
}
