"use client";

import { ChevronRight, Plus, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusPill } from "@/components/ui/StatusPill";
import {
  accountLine,
  byAttention,
  connectionState,
  needsReconnect,
} from "@/modules/ingestion/connection-state";
import type { Connection, Source } from "@/modules/ingestion/integrations-api";
import { pluralize } from "@/modules/workspace-control/format";

import { AppIcon } from "./AppIcon";
import { sourceName } from "./SourceRow";

/**
 * Sources first, then the accounts that feed them.
 *
 * A source is what someone acts on — sync it, process what it brought in — so
 * it leads. Accounts follow because they are what breaks: a lapsed grant stops
 * every source behind it, and its row carries the one action that fixes it.
 * A healthy account carries no badge; being listed is the statement that it
 * works.
 */
export function SourcesView({
  connections,
  sources,
  search,
  live,
  renderSource,
  onOpenConnection,
  onReconnect,
  onAddSource,
}: {
  connections: Connection[];
  sources: Source[];
  search: string;
  /** False in the design preview, which has no deployment to connect against. */
  live: boolean;
  renderSource: (source: Source) => React.ReactNode;
  onOpenConnection: (id: string) => void;
  /** The one action that fixes an account nobody can read from any more. */
  onReconnect: (connection: Connection) => void;
  onAddSource: (connection: Connection) => void;
}) {
  const needle = search.trim().toLowerCase();
  const matchedSources = sources
    .filter((source) => sourceName(source).toLowerCase().includes(needle))
    .sort((left, right) => sourceName(left).localeCompare(sourceName(right)));
  const matchedConnections = connections
    .filter((connection) =>
      `${connection.display_name} ${connection.connector_key} ${accountLine(connection)}`
        .toLowerCase()
        .includes(needle))
    .sort(byAttention);
  const broken = connections.filter(needsReconnect);
  const sourceCount = (connection: Connection) =>
    sources.filter((source) => source.connection_id === connection.id).length;

  return (
    <div className="ingestion-sources">
      {broken.length > 0 && (
        // Stale knowledge is the expensive part of a lapsed grant, and it is
        // invisible: answers keep working, quietly out of date. So the cost is
        // stated before the list, not discovered inside one row of it.
        <div className="knowledge-notice knowledge-notice--danger" role="alert">
          <TriangleAlert aria-hidden="true" size={16} />
          <div>
            <strong>
              {broken.length === 1
                ? `${broken[0].display_name} has stopped syncing`
                : `${broken.length} connected accounts have stopped syncing`}
            </strong>
            <p>
              Ready documents still answer questions, but anything changed since
              then is missing until you reconnect.
            </p>
          </div>
        </div>
      )}

      {!live && (
        // Saying this outright is better than an empty list that looks broken.
        <p className="knowledge-muted">
          Design preview: sources appear only on a running deployment.
        </p>
      )}

      {sources.length > 0 && (
        <section aria-labelledby="sources-heading">
          <div className="knowledge-list-heading">
            <h2 className="knowledge-eyebrow" id="sources-heading">Sources</h2>
            <span>
              {matchedSources.length === sources.length
                ? pluralize(sources.length, "source")
                : `${matchedSources.length} of ${sources.length}`}
            </span>
          </div>
          {matchedSources.length ? (
            <ul className="knowledge-source-list">{matchedSources.map(renderSource)}</ul>
          ) : (
            <EmptyState description="Try a different search." size="sm" title="No matching sources" />
          )}
        </section>
      )}
      {connections.length > 0 && (
        <section aria-labelledby="connected-accounts-heading">
          <div className="knowledge-list-heading">
            <h2 className="knowledge-eyebrow" id="connected-accounts-heading">Connected accounts</h2>
            <span>
              {matchedConnections.length === connections.length
                ? `${connections.length} connected`
                : `${matchedConnections.length} of ${connections.length}`}
            </span>
          </div>
          {matchedConnections.length ? (
            <ul className="knowledge-source-list">
              {matchedConnections.map((connection) => {
                const state = connectionState(connection);
                const count = sourceCount(connection);
                return (
                  <li className="ingestion-account" key={connection.id}>
                    <button onClick={() => onOpenConnection(connection.id)} type="button">
                      <AppIcon connector={connection.connector_key} size="sm" />
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate">{connection.display_name}</strong>
                        <small className="block truncate">
                          {[
                            accountLine(connection) || null,
                            connection.owner_type === "user" ? "Personal" : null,
                            count ? pluralize(count, "source") : "No sources yet",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </small>
                      </span>
                      {state.attention && <StatusPill tone={state.tone}>{state.label}</StatusPill>}
                      <ChevronRight aria-hidden="true" size={18} />
                    </button>
                    {/* A lapsed account has exactly one useful action. */}
                    <div className="ingestion-source__actions">
                      {needsReconnect(connection) ? (
                        <Button
                          aria-label={`Reconnect ${connection.display_name}`}
                          onClick={() => onReconnect(connection)}
                          size="sm"
                          variant="secondary"
                        >
                          Reconnect
                        </Button>
                      ) : (
                        <Button
                          aria-label={`Add a source from ${connection.display_name}`}
                          icon={<Plus size={14} />}
                          onClick={() => onAddSource(connection)}
                          size="sm"
                          variant="ghost"
                        >
                          Add source
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState description="Try a different search." size="sm" title="No matching accounts" />
          )}
        </section>
      )}
    </div>
  );
}
