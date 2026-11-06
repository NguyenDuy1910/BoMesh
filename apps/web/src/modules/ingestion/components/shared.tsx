"use client";

import { ProgressBar } from "@heroui/react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";

import { AppIcon, StatusChip } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { baseColor, isEditor, isPersonal, type Item } from "@/modules/knowledge/bases/model";
import { useKnowledgeBases } from "@/modules/knowledge/queries";

import type { Connection, Source } from "../api";
import { appKey, POLICY, policyOf, sourceStatus } from "../model";

/** Query-string state for the page (`?tab=&q=&status=&open=…`): replace, never push. */
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
export function useBaseIndex() {
  const bases = useKnowledgeBases();
  const byName = useMemo(() => new Map((bases.data ?? []).map((b) => [b.name ?? "", b] as const)), [bases.data]);
  /** Bases the caller may sync into: not personal, editor or owner. */
  const targets = useMemo(() => (bases.data ?? []).filter((b) => !isPersonal(b) && isEditor(b)), [bases.data]);
  return { ...bases, byName, targets };
}

/** Knowledge base link with its colour dot (preview `kbLink`). */
export function KbLink({ base, name }: { base: Item | undefined; name: string }) {
  if (!name) return <span className="muted">Removed</span>;
  return (
    <Link className="src-kb" href={`/knowledge/${resourceId(name)}`} onClick={(e) => e.stopPropagation()}>
      <span className="src-kb__dot" style={{ background: baseColor(name) }} aria-hidden />
      <span className="truncate" translate="no">
        {base?.displayName ?? "Knowledge base"}
      </span>
    </Link>
  );
}

/** Quiet publishing-policy note under the knowledge base. */
export function PolicyNote({ source }: { source: Source }) {
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

/** Source status chip (preview `status('source', …)`). */
export function SourceStatusChip({ source }: { source: Source }) {
  return <StatusChip kind="source" value={sourceStatus(source)} />;
}

/** Thin progress bar with a count (preview `progress()` in `.src-syncing__bar`). */
export function SyncProgress({ value, label }: { value: number | null; label: string }) {
  return (
    <span className="src-syncing__bar">
      <ProgressBar aria-label="Sync progress" size="sm" isIndeterminate={value === null} value={value ?? undefined}>
        <ProgressBar.Track>
          <ProgressBar.Fill />
        </ProgressBar.Track>
      </ProgressBar>
      <span className="num t-xs muted">{label}</span>
    </span>
  );
}
