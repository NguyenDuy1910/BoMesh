"use client";

import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useCurrentWorkspace } from "@/components/shell/useCurrentWorkspace";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PageHeader } from "@/components/ui/PageHeader";
import { TabPanel, Tabs, useTabParam } from "@/components/ui/Tabs";
import { useToast } from "@/components/ui/Toast";
import { hasSessionPermission } from "@/lib/auth/session";
import { describeConnector } from "@/modules/ingestion/connectors";
import {
  activeRunFor,
  needsReconnect,
  sourceAttention,
  sourceName,
  sourceStatus,
} from "@/modules/ingestion/connection-state";
import type { Connection, Source } from "@/modules/ingestion/integrations-api";
import {
  ingestionActions,
  useConnectorCatalogue,
  useSourceInventory,
  type ConnectorEntry,
  type KnowledgeBaseOption,
  type SourceInventory,
} from "@/modules/ingestion/queries";
import type { IngestionRun } from "@/modules/ingestion/runs-api";
import { errorMessage, pluralize } from "@/lib/format";

import { AccountsList } from "./AccountsList";
import { ConnectWizard } from "./ConnectWizard";
import { ReconnectDialog } from "./ReconnectDialog";
import { SourceDrawer } from "./SourceDrawer";
import { SourcesTable, type SourceFilters } from "./SourcesTable";
import { SyncDetailDrawer } from "./SyncDetailDrawer";
import { SyncHistory } from "./SyncHistory";
import { useSourcesUrl } from "./useSourcesUrl";

const TABS = ["sources", "history", "accounts"] as const;
type SourcesTab = (typeof TABS)[number];

const NO_FILTERS: SourceFilters = { q: "", app: "", status: "" };

/** How long a just-connected source stays highlighted in the table. */
const HIGHLIGHT_MS = 4000;

/** Everything the tabs, drawers and dialogs read about the inventory, and what they can do to it. */
export interface SourcesModel {
  data: SourceInventory | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  catalogue: readonly ConnectorEntry[];
  /** Holds `source.manage`: connects sources and manages workspace accounts. */
  canManage: boolean;
  /** Can change this source: `source.manage`, or the owner of its personal account. */
  canManageSource: (source: Source) => boolean;
  canManageConnection: (connection: Connection) => boolean;
  /** May cancel this run: its creator, or `ingestion.manage`. */
  canCancelRun: (run: IngestionRun) => boolean;
  /** May retry: `ingestion.run` (checked again per document by the API). */
  canRetry: boolean;
  viewerId: string | null;
  connection: (id: string) => Connection | undefined;
  knowledgeBase: (id: string) => KnowledgeBaseOption | undefined;
  connectorName: (key: string) => string;
  activeRun: (source: Source) => IngestionRun | null;
  status: (source: Source) => string;
  open: {
    source: (id: string, options?: { editSchedule?: boolean }) => void;
    run: (id: string) => void;
    history: (sourceId: string | null) => void;
    reconnect: (connectionId: string) => void;
    connect: () => void;
    sources: (filters: SourceFilters) => void;
  };
  act: {
    sync: (source: Source) => Promise<void>;
    process: (source: Source) => Promise<void>;
    setPaused: (source: Source, paused: boolean) => Promise<void>;
    disconnect: (source: Source) => void;
    cancelRun: (run: IngestionRun, name: string) => void;
    disconnectAccount: (connection: Connection) => void;
  };
}

type Confirmation =
  | { kind: "source"; source: Source }
  | { kind: "run"; run: IngestionRun; name: string }
  | { kind: "account"; connection: Connection }
  | { kind: "account-in-use"; connection: Connection; users: Source[] };

/** `/manage/sources`: Sources, Sync history and Accounts, with every overlay addressable by URL. */
export function SourcesScreen() {
  const { session } = useCurrentWorkspace();
  const toast = useToast();
  const url = useSourcesUrl();
  const [tab, setTab] = useTabParam<SourcesTab>(TABS, "sources");
  const inventory = useSourceInventory();
  const catalogue = useConnectorCatalogue();
  const [filters, setFilters] = useState<SourceFilters>(NO_FILTERS);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  const data = inventory.data;
  const canManage = hasSessionPermission(session, "source.manage");
  const viewerId = session?.user_id ?? null;

  const connections = useMemo(() => new Map((data?.connections ?? []).map((item) => [item.id, item])), [data]);
  const knowledgeBases = useMemo(() => new Map((data?.knowledgeBases ?? []).map((item) => [item.id, item])), [data]);
  const attention = useMemo(
    () => (data ? sourceAttention(data.sources, data.connections) : { reconnect: [], failed: [] }),
    [data],
  );

  const connectorName = useCallback(
    (key: string) =>
      catalogue.data?.find((entry) => entry.connector.key === key)?.connector.name ?? describeConnector(key).name,
    [catalogue.data],
  );

  // Deep links from people who may not act on them are answered, then dropped.
  const { connect: connectRequested, update } = url;
  useEffect(() => {
    if (!connectRequested || !session || canManage) return;
    toast.show({ tone: "info", message: "Ask a workspace admin to connect sources" });
    update({ connect: null, collection: null });
  }, [canManage, connectRequested, session, toast, update]);

  const model: SourcesModel = useMemo(() => {
    const canManageConnection = (connection: Connection) =>
      canManage || (connection.owner_type === "user" && connection.owner_user_id === viewerId);
    const canManageSource = (source: Source) => {
      const connection = connections.get(source.connection_id);
      return connection ? canManageConnection(connection) : canManage;
    };
    const activeRun = (source: Source) => activeRunFor(source, data?.runs ?? []);
    const status = (source: Source) => sourceStatus(source, connections.get(source.connection_id), activeRun(source));
    const fail = (cause: unknown, subject: string) =>
      toast.show({ tone: "err", message: errorMessage(cause, subject) });

    return {
      data,
      loading: inventory.loading,
      error: inventory.error,
      reload: inventory.reload,
      catalogue: catalogue.data ?? [],
      canManage,
      canManageSource,
      canManageConnection,
      canCancelRun: (run) => hasSessionPermission(session, "ingestion.manage") || run.created_by?.id === viewerId,
      canRetry: hasSessionPermission(session, "ingestion.run"),
      viewerId,
      connection: (id) => connections.get(id),
      knowledgeBase: (id) => knowledgeBases.get(id),
      connectorName,
      activeRun,
      status,
      open: {
        source: (id, options) => url.update({ source: id, run: null, edit: options?.editSchedule ? "schedule" : null }),
        run: (id) => url.update({ run: id, source: null }),
        history: (sourceId) => url.update({ tab: "history", history_source: sourceId, source: null, run: null }),
        reconnect: (connectionId) => url.update({ reconnect: connectionId }),
        connect: () => url.update({ connect: "1" }),
        sources: (next) => {
          setFilters(next);
          url.update({ tab: null, source: null, run: null, connection: null });
        },
      },
      act: {
        sync: async (source) => {
          const key = status(source);
          if (key === "reconnect") {
            url.update({ reconnect: source.connection_id });
            return;
          }
          if (key === "syncing") {
            toast.show({ tone: "info", message: `${sourceName(source)} is already syncing` });
            return;
          }
          try {
            await ingestionActions.syncSource(source.id);
            toast.show({ tone: "info", message: `Syncing ${sourceName(source)}…` });
          } catch (cause) {
            fail(cause, "The sync");
          }
        },
        process: async (source) => {
          try {
            await ingestionActions.processSource(source.id);
            toast.show({
              tone: "info",
              message: `Making ${pluralize(source.pending_documents, "document")} from ${sourceName(source)} searchable…`,
            });
          } catch (cause) {
            fail(cause, "Processing");
          }
        },
        setPaused: async (source, paused) => {
          try {
            await ingestionActions.setPaused(source, paused);
            const connection = connections.get(source.connection_id);
            toast.show(
              !paused && needsReconnect(connection)
                ? {
                    tone: "info",
                    message: `Resumed ${sourceName(source)}. Reconnect ${connectorName(connection!.connector_key)} to sync again.`,
                  }
                : { message: `${paused ? "Paused" : "Resumed"} ${sourceName(source)}` },
            );
          } catch (cause) {
            fail(cause, paused ? "Pausing" : "Resuming");
          }
        },
        disconnect: (source) => setConfirmation({ kind: "source", source }),
        cancelRun: (run, name) => setConfirmation({ kind: "run", run, name }),
        disconnectAccount: (connection) => {
          const users = (data?.sources ?? []).filter((source) => source.connection_id === connection.id);
          setConfirmation(users.length ? { kind: "account-in-use", connection, users } : { kind: "account", connection });
        },
      },
    };
  }, [
    canManage,
    catalogue.data,
    connections,
    connectorName,
    data,
    inventory.error,
    inventory.loading,
    inventory.reload,
    knowledgeBases,
    session,
    toast,
    url,
    viewerId,
  ]);

  const firstReconnect = attention.reconnect[0];
  const showConnect = canManage && !(tab === "sources" && data && data.sources.length === 0);

  const connected = (created: Source[]) => {
    url.update({ connect: null, collection: null, tab: null, source: null, run: null });
    setFilters(NO_FILTERS);
    toast.show({ message: created.length > 1 ? `Connected ${created.length} sources. First syncs started.` : "Connected. First sync started." });
    const first = created[0]?.id ?? null;
    setHighlight(first);
    if (first) window.setTimeout(() => setHighlight((current) => (current === first ? null : current)), HIGHLIGHT_MS);
  };

  return (
    <>
      <PageHeader
        actions={
          showConnect && (
            <Button icon={<Plus />} onClick={model.open.connect} variant={firstReconnect || attention.failed.length ? "secondary" : "primary"}>
              Connect source
            </Button>
          )
        }
        sub="Apps that keep your knowledge bases up to date."
        title="Sources"
      />

      <AttentionCallouts attention={attention} model={model} />

      <Tabs<SourcesTab>
        activeTab={tab}
        ariaLabel="Sources sections"
        className="mb-5"
        idBase="sources"
        onChange={setTab}
        tabs={[
          { id: "sources", label: "Sources", count: data?.sources.length },
          { id: "history", label: "Sync history" },
          { id: "accounts", label: "Accounts", count: data?.connections.length },
        ]}
      />
      <TabPanel idBase="sources" tab={tab}>
        {tab === "sources" && (
          <SourcesTable
            filters={filters}
            highlightId={url.source ?? highlight}
            model={model}
            onFiltersChange={setFilters}
          />
        )}
        {tab === "history" && (
          <SyncHistory
            activeRunId={url.run}
            model={model}
            onSourceChange={(sourceId) => url.update({ history_source: sourceId })}
            sourceId={url.historySource}
          />
        )}
        {tab === "accounts" && <AccountsList highlightId={url.connection} model={model} />}
      </TabPanel>

      <SourceDrawer
        editSchedule={url.editSchedule}
        model={model}
        onClose={() => url.update({ source: null, edit: null })}
        onScheduleEditDone={() => url.update({ edit: null })}
        sourceId={url.source}
      />
      <SyncDetailDrawer model={model} onClose={() => url.update({ run: null })} runId={url.run} />
      {canManage && url.connect && (
        <ConnectWizard
          initialCollectionId={url.collection}
          model={model}
          onClose={() => url.update({ connect: null, collection: null })}
          onConnected={connected}
        />
      )}
      <ReconnectDialog
        connectionId={url.reconnect}
        model={model}
        onClose={() => url.update({ reconnect: null })}
      />

      <ConfirmDialogs confirmation={confirmation} model={model} onClose={() => setConfirmation(null)} />
    </>
  );
}

/**
 * What stopped, said once above the tabs. Sources waiting on the same account
 * are one call-out with one Reconnect — the page's primary action.
 */
function AttentionCallouts({
  attention,
  model,
}: {
  attention: { reconnect: Source[]; failed: Source[] };
  model: SourcesModel;
}) {
  if (!attention.reconnect.length && !attention.failed.length) return null;

  const byConnection = new Map<string, Source[]>();
  for (const source of attention.reconnect) {
    byConnection.set(source.connection_id, [...(byConnection.get(source.connection_id) ?? []), source]);
  }
  let primaryUsed = false;
  const primary = () => {
    const variant = primaryUsed ? "secondary" : "primary";
    primaryUsed = true;
    return variant;
  };

  return (
    <div className="mb-5 grid gap-2">
      {[...byConnection].map(([connectionId, sources]) => {
        const connection = model.connection(connectionId);
        const app = connection ? model.connectorName(connection.connector_key) : "The app";
        const who = sources.length === 1 ? sourceName(sources[0]) : `${sourceName(sources[0])} and ${sources.length - 1} more`;
        const canFix = connection ? model.canManageConnection(connection) : false;
        return (
          <Callout
            actions={
              canFix && (
                <Button onClick={() => model.open.reconnect(connectionId)} size="sm" variant={primary()}>
                  Reconnect
                </Button>
              )
            }
            key={connectionId}
            title={`${who} stopped syncing — ${app} access expired.`}
            tone="err"
          >
            {canFix
              ? `Reconnect ${connection?.account.label || connection?.display_name || "the account"} to resume. Documents already synced stay searchable.`
              : "Ask a workspace admin to reconnect the account. Documents already synced stay searchable."}
          </Callout>
        );
      })}
      {attention.failed.length > 0 && (
        <Callout
          actions={
            model.canManageSource(attention.failed[0]) && (
              <Button onClick={() => void model.act.sync(attention.failed[0])} size="sm" variant={primary()}>
                Sync now
              </Button>
            )
          }
          title={`${attention.failed.length === 1 ? sourceName(attention.failed[0]) : pluralize(attention.failed.length, "source")} couldn’t sync.`}
          tone="err"
        >
          {attention.failed[0].sync?.error || "Try syncing again."}
        </Callout>
      )}
    </div>
  );
}

function ConfirmDialogs({
  confirmation,
  model,
  onClose,
}: {
  confirmation: Confirmation | null;
  model: SourcesModel;
  onClose: () => void;
}) {
  const toast = useToast();
  const kind = confirmation?.kind;

  if (confirmation?.kind === "account-in-use") {
    const { connection, users } = confirmation;
    const label = connection.account.label || connection.display_name;
    return (
      <ConfirmDialog
        confirmLabel="Show sources"
        description={`${users.map(sourceName).join(", ")} ${users.length === 1 ? "syncs" : "sync"} with this account. Disconnect ${users.length === 1 ? "that source" : "those sources"} first; documents they synced stay.`}
        destructive={false}
        onClose={onClose}
        onConfirm={() => model.open.sources({ q: label, app: "", status: "" })}
        open
        title={`${label} is still in use`}
      />
    );
  }

  const title =
    confirmation?.kind === "source"
      ? `Disconnect ${sourceName(confirmation.source)}?`
      : confirmation?.kind === "run"
        ? "Stop this sync?"
        : confirmation?.kind === "account"
          ? `Disconnect ${confirmation.connection.account.label || confirmation.connection.display_name}?`
          : "";
  const description =
    confirmation?.kind === "source"
      ? `Documents already in ${model.knowledgeBase(confirmation.source.collection_id)?.title ?? "its knowledge base"} stay. New changes stop syncing.`
      : confirmation?.kind === "run"
        ? `${confirmation.name} keeps the ${pluralize(confirmation.run.counts.succeeded, "document")} already processed. The rest sync next time.`
        : "BoMesh will stop using this sign-in. You can connect it again anytime.";

  return (
    <ConfirmDialog
      confirmLabel={kind === "run" ? "Stop sync" : "Disconnect"}
      description={description}
      onClose={onClose}
      onConfirm={async () => {
        if (confirmation?.kind === "source") {
          await ingestionActions.removeSource(confirmation.source.id);
          toast.show({ message: `Disconnected ${sourceName(confirmation.source)}` });
        } else if (confirmation?.kind === "run") {
          await ingestionActions.cancelRun(confirmation.run.id);
          toast.show({ message: "Sync stopped" });
        } else if (confirmation?.kind === "account") {
          await ingestionActions.removeConnection(confirmation.connection.id);
          toast.show({ message: `Disconnected ${confirmation.connection.account.label || confirmation.connection.display_name}` });
        }
      }}
      open={confirmation !== null}
      title={title}
    />
  );
}
