"use client";

import { ProgressBar as HeroProgressBar } from "@heroui/react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Clock } from "lucide-react";
import { useCallback, useMemo } from "react";

import { AppIcon, StatusChip } from "@/components/ui";
import { plural } from "@/lib/format";
import { baseColor, collectionHref, isEditor, isPersonal } from "@/modules/knowledge/bases/model";
import { useKnowledgeBases } from "@/modules/knowledge/queries";

import type { Connection, Source, Sync } from "../api";
import { appKey, isFirstSync, POLICY, policyOf, sourceStatus, syncedWithIssues } from "../model";

/** Query-string state for the page (`?view=&q=&status=&open=…`): replace, never push. */
export function useParamState() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const set = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );
  return { params, set };
}

/** Root collections by name, for destination names and dots. */
export function useCollectionIndex() {
  const collections = useKnowledgeBases();
  const byName = useMemo(() => new Map((collections.data ?? []).map((b) => [b.name ?? "", b] as const)), [collections.data]);
  /** Collections the caller may sync into: not personal, editor or owner. */
  const targets = useMemo(() => (collections.data ?? []).filter((b) => !isPersonal(b) && isEditor(b)), [collections.data]);
  return { ...collections, byName, targets };
}

/** Collection link with its colour dot (preview `kbLink`): opens the collection's Sources tab. `label` = its display name. */
export function CollectionLink({ name, label }: { name: string; label: string | undefined }) {
  if (!name) return <span className="muted">Removed</span>;
  return (
    <Link className="src-kb" href={collectionHref(name, "sources")} onClick={(e) => e.stopPropagation()}>
      <span className="src-kb__dot" style={{ background: baseColor(name) }} aria-hidden />
      <span className="truncate" translate="no">
        {label ?? "Collection"}
      </span>
    </Link>
  );
}

/** Under the collection: the publishing policy, or — when files are waiting — that plainly (preview `policyNote`). */
export function PolicyNote({ source }: { source: Source }) {
  const waiting = source.pendingDocumentCount ?? 0;
  if (waiting && sourceStatus(source) !== "syncing")
    return (
      <span className="cell-sub src-policy src-policy--waiting">
        <Clock className="i i-xs" aria-hidden />
        <span className="truncate">{`${waiting} waiting to be processed`}</span>
      </span>
    );
  const policy = POLICY[policyOf(source)];
  const Icon = policy.icon;
  return (
    <span className={`cell-sub src-policy src-policy--${policy.css}`} title={policy.desc}>
      <Icon className="i i-xs" aria-hidden />
      <span className="truncate">{policy.short}</span>
    </span>
  );
}

/** App icon for a source, through its connection. */
export function SourceAppIcon({ source, connections, size }: { source: Source | undefined; connections: ReadonlyMap<string, Connection>; size?: "sm" | "md" | "lg" }) {
  return <AppIcon app={appKey(source ? connections.get(source.connection)?.connector : undefined)} size={size} />;
}

/** Source status chip (preview `statusChip`): First sync while the first one runs; "Synced with issues" after a sync that couldn't read some files. */
export function SourceStatusChip({ source, syncs, size }: { source: Source; syncs?: ReadonlyMap<string, Sync>; size?: "sm" | "md" }) {
  if (syncs && isFirstSync(source, syncs)) return <StatusChip label="First sync" tone="accent" live size={size} />;
  if (syncedWithIssues(source)) {
    const n = source.lastSync?.failedCount ?? 0;
    return <StatusChip label="Synced with issues" tone="warning" size={size} tooltip={`${plural(n, "file")} couldn’t be read in the last sync`} />;
  }
  return <StatusChip kind="source" value={sourceStatus(source)} size={size} />;
}

/** Syncing chip with a thin bar and the count so far (preview `syncingChip`). */
export function SyncingCell({ source, syncs }: { source: Source; syncs?: ReadonlyMap<string, Sync> }) {
  const n = (source.lastSync?.addedCount ?? 0) + (source.lastSync?.updatedCount ?? 0);
  return (
    <div className="src-syncing">
      <SourceStatusChip source={source} syncs={syncs} />
      <SyncProgress label={`${n} so far`} />
    </div>
  );
}

/** Thin progress line with a count (preview `.src-syncing__bar`). The API reports no total, so the bar runs indeterminate. */
export function SyncProgress({ label }: { label: string }) {
  return (
    <span className="src-syncing__bar">
      <HeroProgressBar aria-label="Sync progress" size="sm" isIndeterminate>
        <HeroProgressBar.Track>
          <HeroProgressBar.Fill />
        </HeroProgressBar.Track>
      </HeroProgressBar>
      <span className="num t-xs muted">{label}</span>
    </span>
  );
}

/** Syncs by name (for First sync detection on rows). */
export function useSyncIndex(syncs: readonly Sync[] | undefined): ReadonlyMap<string, Sync> {
  return useMemo(() => new Map((syncs ?? []).map((s) => [s.name ?? "", s] as const)), [syncs]);
}
