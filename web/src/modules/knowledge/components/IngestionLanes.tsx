"use client";

import { useEffect, useState } from "react";

import type { Ingestion } from "@/modules/knowledge/ingestions-api";
import {
  formatDuration,
  ingestionTitle,
  laneSegments,
  liveElapsed,
  liveWaiting,
  progressLabel,
} from "@/modules/knowledge/ingestion-state";

import { IngestionIcon } from "./IngestionIcon";

/** The current time, re-read every second while `enabled`. */
export function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

/**
 * Where one ingestion is in its pipeline.
 *
 * Finished steps are solid, the current one fills with counted progress when
 * the pipeline reports it, and the steps still ahead are a hairline — so the
 * shape of the whole job and the position within it read at once. Only the
 * current step is named under the track on a narrow screen.
 */
export function LaneTrack({ ingestion }: { ingestion: Ingestion }) {
  const segments = laneSegments(ingestion);
  const current = segments.findIndex((segment) => segment.state === "active");
  const step = current >= 0 ? segments[current] : null;
  const description = step
    ? `Step ${current + 1} of ${segments.length}: ${step.label}`
      + (step.ratio !== null ? `, ${Math.round(step.ratio * 100)}% done` : "")
    : `All ${segments.length} steps done`;

  return (
    <div aria-label={description} className="knowledge-lane__track" role="img">
      {segments.map((segment) => (
        <div className="knowledge-lane__step" data-state={segment.state} key={segment.label}>
          <span className="knowledge-lane__bar">
            {segment.state === "active" && (
              <span
                className="knowledge-lane__fill"
                data-counted={segment.ratio !== null ? "true" : undefined}
                style={segment.ratio !== null ? { width: `${Math.max(4, segment.ratio * 100)}%` } : undefined}
              />
            )}
          </span>
          <span className="knowledge-lane__label">{segment.label}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Everything in flight, one lane each.
 *
 * The lanes are the answer to "what is happening right now", so they are the
 * one part of the view that moves: elapsed time ticks, and the current step
 * fills as chunks, files or items are counted.
 */
export function IngestionLanes({
  items,
  receivedAt,
  collectionName,
  selectedId,
  onOpen,
}: {
  items: Ingestion[];
  receivedAt: number;
  collectionName: (ingestion: Ingestion) => string | undefined;
  selectedId: string;
  onOpen: (ingestion: Ingestion) => void;
}) {
  const now = useNow(items.length > 0);

  return (
    <ul className="knowledge-lanes">
      {items.map((ingestion) => {
        const title = ingestionTitle(ingestion);
        const collection = collectionName(ingestion);
        const waiting = ingestion.status === "pending";
        const elapsed = waiting
          ? liveWaiting(ingestion, receivedAt, now)
          : liveElapsed(ingestion, receivedAt, now);
        return (
          <li
            className="knowledge-lane"
            data-selected={ingestion.id === selectedId ? "true" : undefined}
            key={ingestion.id}
          >
            <div className="knowledge-lane__head">
              <IngestionIcon ingestion={ingestion} />
              <div className="knowledge-lane__identity">
                <button
                  aria-current={ingestion.id === selectedId ? "true" : undefined}
                  className="knowledge-lane__open"
                  onClick={() => onOpen(ingestion)}
                  title={title}
                  type="button"
                >
                  {title}
                </button>
                <span className="knowledge-lane__meta">
                  {[collection, progressLabel(ingestion)].filter(Boolean).join(" · ")}
                </span>
              </div>
              {ingestion.attempt > 1 && (
                <span className="knowledge-lane__attempt">Attempt {ingestion.attempt}</span>
              )}
              <span className="knowledge-lane__elapsed">
                {elapsed === null ? "" : waiting
                  ? `Waiting ${formatDuration(elapsed, { precise: false })}`
                  : formatDuration(elapsed, { precise: false })}
              </span>
            </div>
            <LaneTrack ingestion={ingestion} />
          </li>
        );
      })}
    </ul>
  );
}
