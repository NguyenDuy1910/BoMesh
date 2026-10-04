"use client";

import { useMemo, useState } from "react";

import { CommandBar } from "@/components/layout/CommandBar";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorState } from "@/components/ui/ErrorState";
import { useToast } from "@/components/ui/Toast";
import { invalidateApiData } from "@/lib/api/revision";
import { AuthorizationCancelled, authorizeConnection, PopupBlocked } from "@/modules/ingestion/authorize";
import { describeConnector, type KnowledgeConnector } from "@/modules/ingestion/connectors";
import {
  connectionsApi,
  sourcesApi,
  type Connection,
  type Source,
} from "@/modules/ingestion/integrations-api";
import { ingestionActions, type ConnectorEntry, type SourceInventory } from "@/modules/ingestion/queries";
import type { IngestionRun } from "@/modules/ingestion/runs-api";

import { ConnectionDetailView } from "./ConnectionDetailView";
import { ConnectorDirectory } from "./ConnectorDirectory";
import { ConnectSourceFlow } from "./ConnectSourceFlow";
import { sourceName, SourceRow } from "./SourceRow";
import { SourcesView } from "./SourcesView";

/** The Sources tab's address identifies an account or a destination collection. */
export interface SourcesRoute {
  connection: string;
  /** A collection to land a new source in, when opened from Knowledge. */
  collection: string;
}

/**
 * The connector directory stays visible beside the sources it creates.
 * Account detail is addressable; source and account changes invalidate the
 * shared inventory so Schedules and Knowledge refresh too.
 */
export function SourcesPanel({
  inventory,
  catalogue,
  canManageWorkspace,
  route,
  navigate,
  onRunCreated,
}: {
  inventory: SourceInventory;
  catalogue: { data: ConnectorEntry[] | null; error: string | null; reload: () => void };
  /** Whether this person may connect an account on the workspace's behalf. */
  canManageWorkspace: boolean;
  route: SourcesRoute;
  navigate: (patch: Partial<Record<keyof SourcesRoute, string>>) => void;
  onRunCreated: (run: IngestionRun) => void;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [connecting, setConnecting] = useState<KnowledgeConnector | null>(null);
  /** Set when adding a source to an account that is already authorized. */
  const [addingTo, setAddingTo] = useState<Connection | null>(null);
  const [removing, setRemoving] = useState<Source | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { connections, sources, collections } = inventory;
  const collectionName = useMemo(() => {
    const names = new Map(collections.map((collection) => [collection.id, collection.title]));
    return (id: string) => names.get(id);
  }, [collections]);
  const connectionFor = useMemo(() => {
    const byId = new Map(connections.map((connection) => [connection.id, connection]));
    return (id: string) => byId.get(id);
  }, [connections]);

  const selectedConnection = route.connection ? connectionFor(route.connection) : undefined;

  const act = async (work: () => Promise<void>, failure: string) => {
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : failure);
    }
  };

  const startConnecting = (connector: KnowledgeConnector, connection: Connection | null = null) => {
    setAddingTo(connection);
    setConnecting(connector);
  };

  const reconnect = (connection: Connection) =>
    act(async () => {
      try {
        await authorizeConnection({
          connectorKey: connection.connector_key,
          ownerType: connection.owner_type === "workspace" ? "tenant" : "user",
          connectionId: connection.id,
        });
        invalidateApiData();
        toast({
          title: `${connection.display_name} reconnected`,
          description: "Its sources sync again from the next run.",
          variant: "success",
        });
      } catch (cause) {
        // Closing the provider window is a decision, not a failure.
        if (cause instanceof AuthorizationCancelled) return;
        if (cause instanceof PopupBlocked) throw new Error(cause.message);
        throw cause;
      }
    }, "The account couldn’t be reconnected.");

  const renderSource = (source: Source) => (
    <SourceRow
      collectionName={collectionName(source.collection_id)}
      connectorKey={connectionFor(source.connection_id)?.connector_key}
      key={source.id}
      onOpenAccount={selectedConnection ? undefined : () => navigate({ connection: source.connection_id })}
      onProcess={() => act(async () => {
        onRunCreated(await ingestionActions.processSource(source.id));
      }, "Processing couldn’t be started.")}
      onRemove={() => setRemoving(source)}
      onSync={() => act(async () => {
        await ingestionActions.syncSource(source.id);
        toast({
          title: `Syncing ${sourceName(source)}`,
          description: "New and changed documents arrive as Pending, ready to process.",
          variant: "success",
        });
      }, "The sync couldn’t be started.")}
      onToggle={() => act(async () => {
        await sourcesApi.update(source.id, { status: source.status === "paused" ? "ready" : "paused" });
        invalidateApiData();
      }, "The source couldn’t be changed.")}
      source={source}
    />
  );

  const errorNotice = error && (
    <ErrorState
      actionLabel="Dismiss"
      className="mb-[var(--space-3)]"
      description={error}
      layout="inline"
      onAction={() => setError(null)}
    />
  );

  return (
    <>
      {selectedConnection ? (
        <>
          {errorNotice}
          <ConnectionDetailView
            capability={catalogue.data?.find(
              (entry) => entry.connector.key === selectedConnection.connector_key,
            )?.capability}
            connection={selectedConnection}
            onAddSource={() => startConnecting(describeConnector(selectedConnection.connector_key), selectedConnection)}
            onBack={() => navigate({ connection: "" })}
            onDisconnect={async () => {
              await connectionsApi.disconnect(selectedConnection.id);
              invalidateApiData();
              toast({ title: `${selectedConnection.display_name} disconnected`, variant: "success" });
            }}
            onReconnect={() => reconnect(selectedConnection)}
            onRemove={async () => {
              await connectionsApi.remove(selectedConnection.id);
              navigate({ connection: "" });
              invalidateApiData();
              toast({ title: "Connected account removed", variant: "success" });
            }}
            renderSource={renderSource}
            sources={sources.filter((source) => source.connection_id === selectedConnection.id)}
          />
        </>
      ) : (
        <>
          <CommandBar
            search={{
              value: search,
              onChange: setSearch,
              placeholder: "Search sources or connectors…",
              label: "Search sources or connectors",
            }}
          />
          {errorNotice}
          <ConnectorDirectory
            catalogue={catalogue.data ?? []}
            connectedKeys={connections.map((connection) => connection.connector_key)}
            error={catalogue.error}
            loading={!catalogue.data && !catalogue.error}
            onConnect={(connector) => startConnecting(connector)}
            onRetry={catalogue.reload}
            search={search}
          />
          <SourcesView
            connections={connections}
            live={inventory.live}
            onAddSource={(connection) => startConnecting(describeConnector(connection.connector_key), connection)}
            onOpenConnection={(id) => navigate({ connection: id })}
            onReconnect={(connection) => void reconnect(connection)}
            renderSource={renderSource}
            search={search}
            sources={sources}
          />
        </>
      )}

      <ConnectSourceFlow
        canManageWorkspace={canManageWorkspace}
        capability={catalogue.data?.find((entry) => entry.connector.key === connecting?.key)?.capability}
        connector={connecting}
        existingConnection={addingTo}
        initialCollectionId={route.collection || undefined}
        onClose={() => {
          setConnecting(null);
          setAddingTo(null);
          if (route.collection) navigate({ collection: "" });
        }}
        onConnected={invalidateApiData}
        open={Boolean(connecting)}
      />

      <ConfirmDialog
        confirmLabel="Remove source"
        description={removing
          ? `${sourceName(removing)} stops syncing${collectionName(removing.collection_id) ? ` into ${collectionName(removing.collection_id)}` : ""}. Documents it already added stay where they are.`
          : ""}
        destructive
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await sourcesApi.remove(removing.id);
          invalidateApiData();
          toast({ title: `${sourceName(removing)} removed`, variant: "success" });
          setRemoving(null);
        }}
        open={Boolean(removing)}
        title="Remove this source?"
      />
    </>
  );
}

