"use client";

import { MoreHorizontal, RefreshCw } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { Dropdown, DropdownItem, DropdownSeparator } from "@/components/ui/Dropdown";
import { StatusPill } from "@/components/ui/StatusPill";
import { sourceState, syncLine } from "@/modules/ingestion/connection-state";
import type { Source } from "@/modules/ingestion/integrations-api";

import { AppIcon } from "./AppIcon";

/** A source's name as people gave it, or the resource it points at. */
export function sourceName(source: Source): string {
  return source.display_name ?? source.external_resource_id ?? "Unnamed source";
}

/**
 * One source: what it is, where its documents land, when it last synced and
 * how much of it is waiting to be processed.
 *
 * Sync is the row's one action, because it is the only thing a source does.
 * Processing what a sync brought in is offered beside the pending count it
 * acts on, and the rest — pausing, removing — waits in the row's menu.
 */
export function SourceRow({
  source,
  connectorKey,
  collectionName,
  onSync,
  onProcess,
  onToggle,
  onRemove,
  onOpenAccount,
}: {
  source: Source;
  /** The connector behind it, for its mark. */
  connectorKey?: string;
  collectionName?: string;
  onSync: () => Promise<void>;
  onProcess: () => Promise<void>;
  onToggle: () => Promise<void>;
  onRemove: () => void;
  /** Absent on the account's own page. */
  onOpenAccount?: () => void;
}) {
  const [busy, setBusy] = useState<"sync" | "process" | null>(null);
  const state = sourceState(source);
  const syncing = source.sync?.status === "running";
  const failed = source.sync?.status === "failed";
  const paused = source.status === "paused";
  const name = sourceName(source);

  const run = async (kind: "sync" | "process", work: () => Promise<void>) => {
    setBusy(kind);
    try {
      await work();
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="ingestion-source">
      <span className="knowledge-source-list__static">
        {connectorKey && <AppIcon connector={connectorKey} size="sm" />}
        <span className="min-w-0 flex-1">
          <strong className="block truncate">{name}</strong>
          <small className="block truncate">
            {[collectionName, syncLine(source)].filter(Boolean).join(" · ")}
          </small>
          {failed && (
            <small className="ingestion-problem block">
              {source.sync?.error ?? "The last sync didn’t finish."} Sync again to retry.
            </small>
          )}
        </span>
        {/* A failed sync already says so, with its reason, on the line above. */}
        {state.attention && !(failed && source.status === "failed") && (
          <StatusPill tone={state.tone}>{state.label}</StatusPill>
        )}
      </span>
      <div className="ingestion-source__actions">
        {source.pending_documents > 0 && (
          <>
            <span className="ingestion-source__pending">
              {source.pending_documents.toLocaleString()} pending
            </span>
            <Button
              loading={busy === "process"}
              onClick={() => void run("process", onProcess)}
              size="sm"
              variant="ghost"
            >
              Process
            </Button>
          </>
        )}
        <Button
          aria-label={`Sync ${name}`}
          disabled={syncing || source.status !== "ready"}
          icon={<RefreshCw className={syncing ? "motion-safe:animate-spin" : undefined} size={14} />}
          loading={busy === "sync"}
          onClick={() => void run("sync", onSync)}
          size="sm"
          variant="secondary"
        >
          {syncing ? "Syncing…" : "Sync"}
        </Button>
        <Dropdown
          align="right"
          ariaLabel={`More actions for ${name}`}
          buttonClassName="knowledge-icon-button knowledge-icon-button--sm"
          label={<MoreHorizontal aria-hidden="true" size={16} />}
          showChevron={false}
          title="More"
        >
          {onOpenAccount && <DropdownItem onClick={onOpenAccount}>Open account</DropdownItem>}
          <DropdownItem disabled={source.status === "connection_required"} onClick={() => void onToggle()}>
            {paused ? "Resume syncing" : "Pause syncing"}
          </DropdownItem>
          <DropdownSeparator />
          <DropdownItem destructive onClick={onRemove}>Remove source</DropdownItem>
        </Dropdown>
      </div>
    </li>
  );
}
