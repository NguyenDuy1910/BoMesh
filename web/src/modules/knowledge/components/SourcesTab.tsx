"use client";

import { ChevronRight, Plug, RefreshCw, RotateCw } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import { invalidateApiData } from "@/lib/api/revision";
import { useApiQuery } from "@/lib/hooks/useApiQuery";
import { AppIcon } from "@/modules/ingestion/components/AppIcon";
import { sourceName, sourceStatus } from "@/modules/ingestion/connection-state";
import { connectionsApi, sourcesApi, type Connection, type Source } from "@/modules/ingestion/integrations-api";
import { describeSchedule } from "@/modules/ingestion/schedule";
import { formatRelative } from "@/lib/format";

function syncLine(source: Source): string {
  const last = source.sync?.last_synced_at ? `Last synced ${formatRelative(source.sync.last_synced_at)}` : "Not synced yet";
  const cadence = source.status === "paused" || !source.schedule?.enabled ? "Syncs manually" : describeSchedule(source.schedule);
  return `${last} · ${cadence}`;
}

/**
 * The connected sources that keep this knowledge base up to date. Changing
 * one happens in Sources; here they are listed with the one fix that matters.
 */
export function SourcesTab({
  collectionId,
  sources,
  loading,
  error,
  onRetry,
  canManage,
}: {
  collectionId: string;
  sources: Source[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** `source.manage`: may connect, sync and reconnect. */
  canManage: boolean;
}) {
  const toast = useToast();
  const [syncing, setSyncing] = useState<string | null>(null);
  const connections = useApiQuery<Connection[]>(
    async () => (sources?.length ? (await connectionsApi.list()).items : []),
    sources?.map((source) => source.id).join(",") ?? "",
  );
  const connectionOf = (source: Source) => connections.data?.find((connection) => connection.id === source.connection_id);
  const connectHref = `/manage/sources?connect=1&collection=${encodeURIComponent(collectionId)}`;

  const syncNow = async (source: Source) => {
    setSyncing(source.id);
    try {
      await sourcesApi.sync(source.id);
      invalidateApiData();
      toast.show({ tone: "info", message: `Started syncing ${sourceName(source)}` });
    } catch (cause) {
      toast.show({ tone: "err", message: `${sourceName(source)} couldn’t sync`, description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setSyncing(null);
    }
  };

  if (error && !sources) return <ErrorState description={error} onAction={onRetry} title="Sources didn’t load" />;
  if (loading && !sources) return <SkeletonRows columns={3} label="Loading sources" rows={3} />;
  if (!sources?.length) {
    return (
      <EmptyState
        action={canManage ? <ButtonLink href={connectHref} icon={<Plug aria-hidden="true" size={16} />} variant="primary">Connect a source</ButtonLink> : undefined}
        boxed
        description={canManage
          ? "Connect Google Drive or Confluence to keep this knowledge base up to date automatically."
          : "Documents here are uploaded by hand. Ask an admin to connect a source."}
        icon={<Plug />}
        title="No sources connected"
      />
    );
  }

  return (
    <ul aria-label="Sources" className="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-base)]">
      {sources.map((source) => {
        const connection = connectionOf(source);
        const status = sourceStatus(source, connection);
        const href = `/manage/sources?source=${encodeURIComponent(source.id)}`;
        return (
          <li className="relative flex items-center gap-3 px-4 py-3 hover:bg-[var(--surface-subtle)]" key={source.id}>
            <AppIcon connector={connection?.connector_key ?? ""} size="lg" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  className="font-medium text-[var(--text-primary)] focus-visible:outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:shadow-[inset_0_0_0_2px_var(--focus-ring)]"
                  href={href}
                >
                  {sourceName(source)}
                </Link>
                <StatusBadge kind="source" value={status} />
              </div>
              <div className="truncate text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">{syncLine(source)}</div>
            </div>
            {canManage && (
              <div className="relative z-[1]">
                {status === "reconnect" ? (
                  <ButtonLink href={href} icon={<RefreshCw aria-hidden="true" size={15} />} size="sm">Reconnect</ButtonLink>
                ) : (
                  <Button
                    disabled={status === "syncing" || status === "paused"}
                    icon={<RotateCw aria-hidden="true" size={15} />}
                    loading={syncing === source.id}
                    onClick={() => void syncNow(source)}
                    size="sm"
                    variant="secondary"
                  >
                    Sync now
                  </Button>
                )}
              </div>
            )}
            <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-[var(--text-tertiary)]" />
          </li>
        );
      })}
    </ul>
  );
}
