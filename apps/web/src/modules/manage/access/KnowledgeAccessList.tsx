"use client";

import { BookOpen } from "lucide-react";
import Link from "next/link";

import { SkeletonRows } from "@/components/ui/Skeleton";
import type { CollectionRole, KnowledgeGrants } from "@/modules/manage/access/directory";

const CAN: Record<CollectionRole, string> = { owner: "Can manage", editor: "Can edit", viewer: "Can view" };

export interface KnowledgeAccessRow {
  collectionId: string;
  title: string;
  /** How the access arrives: "Direct", "Group: Sales"; empty when it is obvious. */
  via: string;
  role: CollectionRole;
}

/**
 * Knowledge bases shared with one person (directly or through their groups)
 * or with one group, read from each collection's real access list.
 */
export function knowledgeAccessRows(
  grants: KnowledgeGrants,
  principals: { type: "user" | "group"; id: string; via: string }[],
): KnowledgeAccessRow[] {
  const titles = Object.fromEntries(grants.collections.map((collection) => [collection.id, collection.title]));
  const rows: KnowledgeAccessRow[] = [];
  for (const principal of principals) {
    for (const grant of grants.grants) {
      if (grant.principal_type !== principal.type || grant.principal_id !== principal.id || !(grant.collection_id in titles)) continue;
      rows.push({ collectionId: grant.collection_id, title: titles[grant.collection_id], via: principal.via, role: grant.role });
    }
  }
  return rows.sort((left, right) => left.title.localeCompare(right.title));
}

export function KnowledgeAccessList({
  grants,
  rows,
  empty,
}: {
  /** Null while loading or when the read failed. */
  grants: KnowledgeGrants | null | undefined;
  rows: KnowledgeAccessRow[];
  empty: string;
}) {
  if (grants === undefined) return <SkeletonRows columns={2} label="Loading knowledge access" rows={2} />;
  if (grants === null) {
    return <p className="text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">Knowledge access couldn’t be loaded.</p>;
  }
  return (
    <>
      {rows.length ? (
        <ul className="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-base)]">
          {rows.map((row) => (
            <li className="flex min-w-0 items-center gap-2.5 px-3.5 py-2.5" key={`${row.collectionId}:${row.via}`}>
              <BookOpen aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" size={16} />
              <Link
                className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)] hover:text-[var(--text-accent)] hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                href={`/knowledge/${row.collectionId}?tab=access`}
              >
                {row.title}
              </Link>
              <span className="shrink-0 whitespace-nowrap text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">
                {row.via ? `${row.via} · ${CAN[row.role]}` : CAN[row.role]}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">{empty}</p>
      )}
      {grants.unreadable > 0 && (
        <p className="mt-2 text-[length:var(--text-size-caption)] text-[var(--text-tertiary)]">
          Only knowledge bases you can share are listed.
        </p>
      )}
    </>
  );
}
