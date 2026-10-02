"use client";

import {
  ArrowLeft,
  MoreHorizontal,
  PauseCircle,
  PlayCircle,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";

import { StatusPill } from "@/components/ui/StatusPill";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dropdown, DropdownItem, DropdownSeparator } from "@/components/ui/Dropdown";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  connectionState,
  needsReconnect,
  relativeTime,
  sourceState,
} from "@/modules/knowledge/connection-state";
import {
  scheduleLabel,
  type Connection,
  type ConnectorCapability,
  type Source,
} from "@/modules/knowledge/integrations-api";
import type { Ingestion } from "@/modules/knowledge/ingestions-api";
import { pluralize } from "@/modules/workspace-control/format";

import { AppIcon } from "./AppIcon";
import { SyncRunRow } from "./SyncRunRow";

/**
 * One connected account.
 *
 * The page answers four questions in order: whose access this is, what it is
 * being used for, whether it is working, and what to do if it is not. Nothing
 * about how the grant is stored appears anywhere — no token, no scopes list,
 * no connector key — because none of it is actionable to the person reading.
 *
 * A broken connection promotes itself to the top and states three things: what
 * stopped, what that costs, and the one action that fixes it.
 */
export function ConnectionDetailView({
  connection,
  sources,
  runs,
  capability,
  onBack,
  onReconnect,
  onDisconnect,
  onRemove,
  onAddKnowledge,
  onSyncSource,
  onToggleSource,
  onRemoveSource,
}: {
  connection: Connection;
  sources: Source[];
  runs: Ingestion[];
  /** The registry's record for this connector, for what the account can feed. */
  capability?: ConnectorCapability;
  onBack: () => void;
  onReconnect: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onRemove: () => Promise<void>;
  onAddKnowledge: () => void;
  onSyncSource: (sourceId: string) => Promise<void>;
  onToggleSource: (source: Source) => Promise<void>;
  onRemoveSource: (source: Source) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"disconnect" | "remove" | null>(null);
  const state = connectionState(connection);
  const broken = needsReconnect(connection);
  const documentsAtRisk = sources.length;

  const act = async (work: () => Promise<void>, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label={connection.display_name}
      className="knowledge-source-detail"
    >
      <div className="knowledge-detail-intro">
        <Button
          className="-ml-2.5 self-start"
          icon={<ArrowLeft size={16} />}
          onClick={onBack}
          size="sm"
          variant="ghost"
        >
          Sources
        </Button>

        <header className="knowledge-source-detail__header">
          <AppIcon connector={connection.connector_key} size="sm" />
          <h2>{connection.display_name}</h2>
          {state.attention && <StatusPill tone={state.tone}>{state.label}</StatusPill>}
          <Button
            className="ml-auto"
            icon={<Plus size={16} />}
            onClick={onAddKnowledge}
            size="md"
            variant="secondary"
          >
            Add source
          </Button>
          <Dropdown
            align="right"
            ariaLabel="Account actions"
            buttonClassName="knowledge-icon-button"
            label={<MoreHorizontal aria-hidden="true" size={18} />}
            showChevron={false}
            title="More"
          >
            <DropdownItem onClick={() => void act(onReconnect, "The account could not be reconnected.")}>
              Reconnect
            </DropdownItem>
            <DropdownSeparator />
            <DropdownItem onClick={() => setConfirming("disconnect")}>Disconnect</DropdownItem>
            <DropdownItem onClick={() => setConfirming("remove")}>Remove account</DropdownItem>
          </Dropdown>
        </header>
      </div>

      {broken && (
        <div className="knowledge-notice knowledge-notice--danger" role="alert">
          <TriangleAlert aria-hidden="true" size={16} />
          <div>
            <strong>{connection.display_name} needs to be connected again</strong>
            <p>
              {connection.status_detail ?? "The account no longer authorizes BoThesis."}{" "}
              {documentsAtRisk
                ? `${pluralize(documentsAtRisk, "source has", "sources have")} stopped updating. Indexed documents still answer questions, but anything changed since then is missing.`
                : "Nothing is indexed from it yet."}
            </p>
          </div>
          <Button
            loading={busy}
            onClick={() => void act(onReconnect, "The account could not be reconnected.")}
            variant="secondary"
          >
            Reconnect
          </Button>
        </div>
      )}
      {error && <ErrorState description={error} layout="inline" />}

      <div className="knowledge-source-detail__columns">
        <section aria-labelledby="connection-account-heading">
          <div className="knowledge-section-rule">
            <h3 id="connection-account-heading">Account</h3>
          </div>
          <dl className="knowledge-kv">
            {connection.account.label && (
              <div>
                <dt>Connected account</dt>
                <dd>{connection.account.label}</dd>
              </div>
            )}
            {connection.account.resource_label && (
              <div>
                <dt>Site</dt>
                <dd>{connection.account.resource_label}</dd>
              </div>
            )}
            <div>
              <dt>Available to</dt>
              <dd>
                {connection.owner_type === "workspace"
                  ? "Everyone in this workspace"
                  : "Only you"}
              </dd>
            </div>
            <div>
              <dt>Connected</dt>
              <dd>{relativeTime(connection.connected_at)}</dd>
            </div>
            {(capability?.provider_capabilities?.length ?? 0) > 0 && (
              <div>
                <dt>Covers</dt>
                <dd>
                  {capability!.provider_capabilities
                    .map((item) => item.display_name)
                    .join(", ")}
                </dd>
              </div>
            )}
          </dl>
        </section>

        <section aria-labelledby="connection-health-heading">
          <div className="knowledge-section-rule">
            <h3 id="connection-health-heading">Status</h3>
          </div>
          <dl className="knowledge-kv">
            <div>
              <dt>State</dt>
              <dd className={state.attention ? "knowledge-kv__value--bad" : "knowledge-kv__value--ok"}>
                {state.label}
              </dd>
            </div>
            <div>
              <dt>Last checked</dt>
              <dd>{relativeTime(connection.last_checked_at)}</dd>
            </div>
            <div>
              <dt>Sources</dt>
              <dd>{documentsAtRisk ? pluralize(documentsAtRisk, "source") : "None yet"}</dd>
            </div>
          </dl>
        </section>
      </div>

      <section aria-labelledby="connection-sources-heading">
        <div className="knowledge-section-rule">
          <h3 id="connection-sources-heading">Sources</h3>
        </div>
        {sources.length ? (
          <ul className="knowledge-source-list">
            {sources.map((source) => {
              const sourceStatus = sourceState(source);
              const paused = source.status === "paused";
              return (
                <li key={source.id}>
                  <span className="knowledge-source-list__static">
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate">
                        {source.display_name ?? source.external_resource_id ?? "Source"}
                      </strong>
                      <small className="block truncate">
                        {[
                          scheduleLabel(source.schedule),
                          `synced ${relativeTime(source.last_ingested_at ?? null)}`,
                        ].join(" · ")}
                      </small>
                    </span>
                    {sourceStatus.attention && (
                      <StatusPill tone={sourceStatus.tone}>{sourceStatus.label}</StatusPill>
                    )}
                  </span>
                  <Tooltip label="Sync now" side="top">
                    <Button
                      aria-label={`Sync ${source.display_name ?? "source"}`}
                      disabled={source.status !== "ready"}
                      icon={<RefreshCw size={16} />}
                      iconOnly
                      onClick={() =>
                        void act(() => onSyncSource(source.id), "The sync could not be started.")}
                      size="sm"
                      variant="ghost"
                    />
                  </Tooltip>
                  <Tooltip label={paused ? "Resume" : "Pause"} side="top">
                    <Button
                      aria-label={paused ? "Resume syncing" : "Pause syncing"}
                      disabled={source.status === "connection_required"}
                      icon={paused ? <PlayCircle size={16} /> : <PauseCircle size={16} />}
                      iconOnly
                      onClick={() =>
                        void act(() => onToggleSource(source), "The source could not be changed.")}
                      size="sm"
                      variant="ghost"
                    />
                  </Tooltip>
                  <Tooltip label="Remove" side="top">
                    <Button
                      aria-label={`Remove ${source.display_name ?? "source"}`}
                      icon={<Trash2 size={16} />}
                      iconOnly
                      onClick={() =>
                        void act(() => onRemoveSource(source), "The source could not be removed.")}
                      size="sm"
                      variant="ghost"
                    />
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState
            description="Add a source to choose what this account brings in."
            size="sm"
            title="No sources yet"
          />
        )}
      </section>

      <section aria-labelledby="connection-activity-heading">
        <div className="knowledge-section-rule">
          <h3 id="connection-activity-heading">Sync activity</h3>
        </div>
        {runs.length ? (
          <ul className="knowledge-run-list">
            {runs.map((run) => (
              <SyncRunRow
                ingestion={run}
                key={run.id}
                label={sources.find((item) => item.id === run.source_id)?.display_name ?? undefined}
              />
            ))}
          </ul>
        ) : (
          <EmptyState size="sm" title="No activity yet" />
        )}
      </section>

      <ConfirmDialog
        confirmLabel={confirming === "remove" ? "Remove account" : "Disconnect"}
        description={
          confirming === "remove"
            ? `Removes ${connection.display_name} and its ${pluralize(documentsAtRisk, "source")}. Indexed documents stay searchable.`
            : `Stops syncing ${connection.display_name} and signs it out. Its ${pluralize(documentsAtRisk, "source")} resume when you reconnect.`
        }
        onClose={() => setConfirming(null)}
        onConfirm={async () => {
          const action = confirming;
          setConfirming(null);
          await act(
            action === "remove" ? onRemove : onDisconnect,
            "The connected account could not be changed.",
          );
        }}
        open={confirming !== null}
        title={confirming === "remove" ? "Remove this connected account?" : "Disconnect this account?"}
      />
    </section>
  );
}
