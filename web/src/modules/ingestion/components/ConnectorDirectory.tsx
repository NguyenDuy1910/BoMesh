"use client";

import { ArrowUpRight } from "lucide-react";

import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import type { ConnectorEntry } from "@/modules/ingestion/queries";
import type { KnowledgeConnector } from "@/modules/ingestion/connectors";

import { AppIcon } from "./AppIcon";

/** One connector type per tile; an existing account never prevents adding another. */
export function ConnectorDirectory({
  /** What the deployment's connector registry supports, already described. */
  catalogue,
  loading,
  error,
  onRetry,
  /** Keys with at least one connected account. */
  connectedKeys,
  search,
  onConnect,
}: {
  catalogue: readonly ConnectorEntry[];
  loading: boolean;
  /** The registry could not be read. Not the same thing as an empty registry. */
  error: string | null;
  onRetry: () => void;
  connectedKeys: readonly string[];
  search: string;
  /** Start connecting this connector, including when another account exists. */
  onConnect: (connector: KnowledgeConnector) => void;
}) {
  const needle = search.trim().toLowerCase();
  // A provider can expose one connector through multiple capability records;
  // the directory is one row per connector, so collapse those records before
  // React assigns list identity.
  const available = Array.from(
    new Map(catalogue.map((entry) => [entry.connector.key, entry])).values(),
  ).filter(({ connector }) =>
    `${connector.name} ${connector.description}`.toLowerCase().includes(needle));
  const isConnected = (key: string) => connectedKeys.includes(key);

  return (
    <section aria-labelledby="available-connectors-heading">
      <div className="knowledge-connectors__heading">
        <h2 id="available-connectors-heading">Connect a service</h2>
        <p>Choose where to bring documents from.</p>
      </div>
      {error ? (
        <ErrorState
          actionLabel="Try again"
          description={error}
          layout="inline"
          onAction={onRetry}
          title="Connectors could not be loaded"
        />
      ) : loading ? (
        <PageLoadingSkeleton label="Loading connectors" />
      ) : available.length ? (
        <div className="knowledge-connectors">
          {available.map(({ connector, capability }) => {
            // An unconfigured provider is visible, but never starts a flow
            // that the deployment cannot complete.
            const connectable = capability?.available ?? true;
            const connected = isConnected(connector.key);
            const content = (
              <>
                <AppIcon className="knowledge-connectors__mark" connector={connector.key} />
                <span className="knowledge-connectors__content">
                  <strong>{connector.name}</strong>
                  <small>{connectable ? connector.description : "Not available on this deployment"}</small>
                  {connectable && connected && <span className="knowledge-connectors__connected">Connected</span>}
                </span>
                {connectable && (
                  <span aria-hidden="true" className="knowledge-connectors__action">
                    {connected ? "Add account" : "Connect"}
                    <ArrowUpRight size={16} />
                  </span>
                )}
              </>
            );
            return connectable ? (
              <button
                aria-label={connected ? `Connect another ${connector.name} account` : `Connect ${connector.name}`}
                className="knowledge-connectors__tile"
                key={connector.key}
                onClick={() => onConnect(connector)}
                type="button"
              >
                {content}
              </button>
            ) : (
              <div
                className="knowledge-connectors__tile knowledge-connectors__tile--unavailable"
                key={connector.key}
              >
                {content}
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState
          description={
            search
              ? "Try a different search."
              : "Connectors appear here once they are set up for this deployment."
          }
          size="sm"
          title={search ? "No matching connectors" : "No connectors yet"}
        />
      )}
    </section>
  );
}
