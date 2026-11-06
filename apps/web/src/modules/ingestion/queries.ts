"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

import { useWorkspace } from "@/lib/workspace";

import {
  getSource,
  listConnections,
  listConnectors,
  listMyConnectorRequests,
  listSources,
  listSyncs,
  type Connection,
  type Source,
  type Sync,
} from "./api";

/**
 * Ingestion queries. Keys start `[workspace, "ingestion", …]`; mutations
 * invalidate `[workspace, "ingestion"]` (and the shell's badges). While a sync
 * runs, the lists poll so progress and results appear without a reload.
 */

export const ingestionKeys = {
  all: (ws: string) => [ws, "ingestion"] as const,
  connectors: (ws: string) => [ws, "ingestion", "connectors"] as const,
  connections: (ws: string) => [ws, "ingestion", "connections"] as const,
  sources: (ws: string) => [ws, "ingestion", "sources"] as const,
  source: (ws: string, id: string) => [ws, "ingestion", "sources", id] as const,
  syncs: (ws: string, source: string) => [ws, "ingestion", "syncs", source] as const,
  requests: (ws: string) => [ws, "ingestion", "connectorRequests"] as const,
};

const LIVE_MS = 3000;

/** Re-reads every ingestion query and the sidebar badges. */
export function useInvalidateIngestion() {
  const qc = useQueryClient();
  const { id } = useWorkspace();
  return () => {
    void qc.invalidateQueries({ queryKey: ingestionKeys.all(id) });
    void qc.invalidateQueries({ queryKey: [id, "shell-badge"] });
  };
}

export function useConnectors() {
  const { id } = useWorkspace();
  return useQuery({ queryKey: ingestionKeys.connectors(id), queryFn: listConnectors, staleTime: 5 * 60_000 });
}

export function useConnections({ enabled = true }: { enabled?: boolean } = {}) {
  const { id, can } = useWorkspace();
  const query = useQuery({
    queryKey: ingestionKeys.connections(id),
    queryFn: () => listConnections(id),
    enabled: enabled && can("connections.list"),
    refetchInterval: (q) => (q.state.data?.some((c) => c.state === "AUTHORIZING") ? LIVE_MS : false),
  });
  const byName = useMemo(() => new Map((query.data ?? []).map((c) => [c.name ?? "", c] as const)), [query.data]);
  return { ...query, byName };
}

/**
 * When a polled sync stops running, every ingestion view (history, recent
 * syncs, alerts) re-reads: they stop polling on their own data and would keep
 * a stale "running" or a previous error otherwise.
 */
function useRefreshWhenSettled(running: boolean) {
  const invalidate = useInvalidateIngestion();
  const was = useRef(running);
  useEffect(() => {
    if (was.current && !running) invalidate();
    was.current = running;
  }, [running, invalidate]);
}

export function useSources() {
  const { id, can } = useWorkspace();
  const query = useQuery({
    queryKey: ingestionKeys.sources(id),
    queryFn: () => listSources(id),
    enabled: can("sources.list"),
    refetchInterval: (q) => (q.state.data?.some((s) => s.lastSync?.state === "RUNNING") ? LIVE_MS : false),
  });
  useRefreshWhenSettled(!!query.data?.some((s) => s.lastSync?.state === "RUNNING"));
  return query;
}

export function useSource(source: string | null) {
  const { id } = useWorkspace();
  const query = useQuery({
    queryKey: ingestionKeys.source(id, source ?? ""),
    queryFn: () => getSource(id, source ?? ""),
    enabled: !!source,
    retry: false,
    refetchInterval: (q) => (q.state.data?.lastSync?.state === "RUNNING" ? LIVE_MS : false),
  });
  useRefreshWhenSettled(query.data?.lastSync?.state === "RUNNING");
  return query;
}

/** Sync history: every source (`source` omitted) or one source. */
export function useSyncs(source?: string, limit = 500) {
  const { id, can } = useWorkspace();
  return useQuery<Sync[]>({
    queryKey: [...ingestionKeys.syncs(id, source ?? "-"), limit],
    queryFn: () => listSyncs(id, { source }, limit),
    enabled: can("sources.list"),
    refetchInterval: (q) => (q.state.data?.some((s) => s.state === "RUNNING") ? LIVE_MS : false),
  });
}

/** Connector names the caller has an open request for. */
export function useMyConnectorRequests() {
  const { id, member } = useWorkspace();
  const query = useQuery({ queryKey: ingestionKeys.requests(id), queryFn: () => listMyConnectorRequests(id, member.name ?? ""), enabled: !!member.name, retry: false });
  const requested = useMemo(() => new Set((query.data ?? []).map((r) => r.target ?? "")), [query.data]);
  return { ...query, requested };
}

/** A mutation that refreshes ingestion data afterwards. */
export function useIngestionMutation<V, R>(fn: (vars: V) => Promise<R>) {
  const invalidate = useInvalidateIngestion();
  return useMutation({ mutationFn: fn, onSettled: invalidate });
}

/** Sources by the connection they read through. */
export function sourcesByConnection(sources: readonly Source[] | undefined): Map<string, Source[]> {
  const out = new Map<string, Source[]>();
  for (const s of sources ?? []) {
    const list = out.get(s.connection) ?? [];
    list.push(s);
    out.set(s.connection, list);
  }
  return out;
}

export type { Connection, Source, Sync };
