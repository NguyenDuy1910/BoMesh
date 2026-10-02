"use client";

import { useMemo, useState } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageLoadingSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { useRouteState } from "@/lib/hooks/useRouteState";
import type { Ingestion, IngestionWindow } from "@/modules/knowledge/ingestions-api";
import {
  ingestionStatus,
  ingestionTitle,
  isActive,
  STATUS_FILTER,
  WINDOW_LABEL,
} from "@/modules/knowledge/ingestion-state";
import { useLiveIngestions } from "@/modules/knowledge/queries";
import type {
  WorkspaceKnowledgeCollection,
  WorkspaceKnowledgeDocument,
} from "@/modules/knowledge/workspace-repository";
import { pluralize } from "@/modules/workspace-control/format";

import { DurationRange, Instrument, OutcomesRing, ThroughputChart } from "./IngestionCharts";
import { IngestionDetailPanel } from "./IngestionDetailPanel";
import { IngestionLanes } from "./IngestionLanes";
import { SyncRunRow } from "./SyncRunRow";

const WINDOWS: readonly { value: IngestionWindow; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
];

/**
 * The knowledge pipeline, as it runs.
 *
 * One job: show what is being processed right now, where each piece is, and
 * what failed and why. Read top to bottom it narrows from the whole window
 * (three instruments), to what is moving this second (a lane per ingestion in
 * flight), to the record of everything that finished (the log). Uploads and
 * source syncs share every part of it, because to the person watching they are
 * the same thing — knowledge on its way in.
 */
export function SyncActivityView({
  collections,
  documents,
  search,
  status,
  kind,
  sort,
  onOpenDocument,
}: {
  collections: WorkspaceKnowledgeCollection[];
  documents: WorkspaceKnowledgeDocument[];
  search: string;
  /** `complete`, `running` or `failed`; empty shows every outcome. */
  status: string;
  /** `document` or `source`; empty shows both. */
  kind: string;
  sort: string;
  onOpenDocument: (documentId: string) => void;
}) {
  const [range, setRange] = useState<IngestionWindow>("24h");
  const [selectedId, setSelectedId] = useRouteState("ingestion");
  /** A retry answers with an ingestion the feed may not list yet. */
  const [pinned, setPinned] = useState<Ingestion | null>(null);
  const live = useLiveIngestions(range);

  const collectionName = useMemo(() => {
    const names = Object.fromEntries(collections.map((collection) => [collection.id, collection.name]));
    return (ingestion: Ingestion) => (ingestion.collection_id ? names[ingestion.collection_id] : undefined);
  }, [collections]);
  const documentIds = useMemo(() => new Set(documents.map((document) => document.id)), [documents]);

  const needle = search.trim().toLowerCase();
  const matches = (ingestion: Ingestion) =>
    (!kind || ingestion.kind === kind)
    && `${ingestionTitle(ingestion)} ${collectionName(ingestion) ?? ""} ${ingestionStatus(ingestion).label}`
      .toLowerCase()
      .includes(needle);

  // Oldest first, so the lane that has waited longest is at the top.
  const inFlight = live.items.filter((item) => isActive(item) && matches(item)).reverse();
  const matched = live.items.filter(
    (item) => matches(item) && (!status || (STATUS_FILTER[status] ?? []).includes(item.status)),
  );
  // The feed arrives newest first; oldest is that order reversed.
  const history = sort === "oldest" ? [...matched].reverse() : matched;
  const narrowed = Boolean(search || status || kind);

  const loaded = live.receivedAt > 0;
  const summary = live.summary?.window === range ? live.summary : null;
  const busy = live.items.some(isActive) || (summary?.active ?? 0) > 0;
  const selected = selectedId
    ? live.items.find((item) => item.id === selectedId) ?? (pinned?.id === selectedId ? pinned : undefined)
    : undefined;

  if (!loaded && live.error) {
    return (
      <div className="knowledge-activity">
        <ErrorState
          actionLabel="Try again"
          description={live.error}
          layout="inline"
          onAction={live.refresh}
          title="Activity couldn’t be loaded"
        />
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="knowledge-activity">
        <PageLoadingSkeleton label="Loading activity" />
      </div>
    );
  }

  const windowEmpty = summary !== null
    && Object.values(summary.totals).every((value) => value === 0)
    && summary.active === 0;

  return (
    <div className="knowledge-activity-frame">
      <section aria-label="Sync activity" className="knowledge-activity knowledge-monitor">
        <header className="knowledge-monitor__head">
          <p
            className="knowledge-live"
            data-live={busy && !live.error ? "true" : undefined}
            data-stale={live.error ? "true" : undefined}
          >
            <span aria-hidden="true" className="knowledge-live__dot" />
            {live.error ? "Not updating" : busy ? "Live" : "Up to date"}
          </p>
          <div aria-label="Time window" className="ctl-seg" role="group">
            {WINDOWS.map((option) => (
              <button
                aria-label={`Show the ${WINDOW_LABEL[option.value]}`}
                aria-pressed={range === option.value}
                className="ctl-seg__item"
                key={option.value}
                onClick={() => setRange(option.value)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        </header>

        {live.error && (
          <ErrorState
            actionLabel="Try again"
            description={`${live.error} What is shown may be out of date.`}
            layout="inline"
            onAction={live.refresh}
            title="Activity couldn’t be refreshed"
          />
        )}

        {!summary ? (
          <div aria-hidden="true" className="knowledge-instruments">
            <Skeleton className="knowledge-instrument knowledge-instrument--placeholder knowledge-instrument--wide" />
            <Skeleton className="knowledge-instrument knowledge-instrument--placeholder" />
            <Skeleton className="knowledge-instrument knowledge-instrument--placeholder" />
          </div>
        ) : windowEmpty ? (
          <EmptyState
            className="knowledge-instruments-empty"
            description="Syncs and uploads appear here as they run."
            size="sm"
            title={`Nothing ran in the ${WINDOW_LABEL[range]}`}
          />
        ) : (
          <div className="knowledge-instruments">
            <Instrument
              className="knowledge-instrument--wide"
              title="Throughput"
              total={[
                summary.by_kind.document ? pluralize(summary.by_kind.document, "document") : null,
                summary.by_kind.source ? pluralize(summary.by_kind.source, "sync") : null,
              ].filter(Boolean).join(" · ")}
            >
              <ThroughputChart summary={summary} />
            </Instrument>
            <Instrument title="Outcomes">
              <OutcomesRing summary={summary} />
            </Instrument>
            <Instrument title="Duration">
              <DurationRange summary={summary} />
            </Instrument>
          </div>
        )}

        <section aria-labelledby="knowledge-inflight-heading" className="knowledge-monitor__section">
          <div className="knowledge-list-heading">
            <h2 className="knowledge-eyebrow" id="knowledge-inflight-heading">In progress</h2>
            {inFlight.length > 0 && <span>{inFlight.length.toLocaleString()}</span>}
          </div>
          {inFlight.length ? (
            <IngestionLanes
              collectionName={collectionName}
              items={inFlight}
              onOpen={(ingestion) => setSelectedId(ingestion.id)}
              receivedAt={live.receivedAt}
              selectedId={selectedId}
            />
          ) : (
            <p className="knowledge-monitor__quiet">
              <strong>Nothing is processing right now</strong>
              <span>Syncs and uploads appear here as they run.</span>
            </p>
          )}
        </section>

        <section aria-labelledby="knowledge-history-heading" className="knowledge-monitor__section">
          <div className="knowledge-list-heading">
            <h2 className="knowledge-eyebrow" id="knowledge-history-heading">History</h2>
            <span>
              {narrowed
                ? pluralize(history.length, "match", "matches")
                : live.total > live.items.length
                  ? `Latest ${live.items.length.toLocaleString()} of ${live.total.toLocaleString()}`
                  : pluralize(live.items.length, "ingestion")}
            </span>
          </div>
          {history.length ? (
            <ul className="knowledge-run-list">
              {history.map((ingestion) => (
                <SyncRunRow
                  collection={collectionName(ingestion)}
                  ingestion={ingestion}
                  key={ingestion.id}
                  onOpen={() => setSelectedId(ingestion.id)}
                  selected={ingestion.id === selectedId}
                />
              ))}
            </ul>
          ) : (
            <EmptyState
              description={narrowed ? "Try a different search or clear the filters." : "Syncs and uploads appear here as they run."}
              size="sm"
              title={narrowed ? "No matching activity" : "No activity yet"}
            />
          )}
        </section>
      </section>

      {selectedId && (
        <IngestionDetailPanel
          collectionName={collectionName}
          hasDocument={(id) => documentIds.has(id)}
          ingestionId={selectedId}
          initial={selected}
          key={selectedId}
          onChanged={live.refresh}
          onClose={() => setSelectedId("")}
          onOpenDocument={onOpenDocument}
          onReplace={(next) => {
            setPinned(next);
            setSelectedId(next.id);
          }}
        />
      )}
    </div>
  );
}
