"use client";

import { ArrowUpDown, Check, FolderPlus, ListFilter, LoaderCircle, Plug, Plus, Upload } from "lucide-react";
import { Fragment, useMemo, useRef, useState } from "react";

import { SplitView } from "@/components/layout/SplitView";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dropdown, DropdownItem, DropdownLabel, DropdownSeparator } from "@/components/ui/Dropdown";
import { ErrorState } from "@/components/ui/ErrorState";
import { useToast } from "@/components/ui/Toast";
import { useAuthSession } from "@/lib/hooks/useAuthSession";
import { hasSessionPermission } from "@/lib/auth/session";
import { useRouteState } from "@/lib/hooks/useRouteState";
import { SectionHeader } from "@/modules/workspace-control/components/SectionHeader";
import { pluralize } from "@/modules/workspace-control/format";
import { authorizeConnection, AuthorizationCancelled, PopupBlocked } from "@/modules/knowledge/authorize";
import { describeConnector, type KnowledgeConnector } from "@/modules/knowledge/connectors";
import {
  connectionsApi,
  sourcesApi,
  type Connection,
} from "@/modules/knowledge/integrations-api";
import { canRetryIndexing } from "@/modules/knowledge/document-facts";
import { knowledgeActions, useConnections, useConnectorCatalogue, useKnowledge } from "@/modules/knowledge/queries";
import type { WorkspaceKnowledgeDocument } from "@/modules/knowledge/workspace-repository";

import { ConnectSourceFlow } from "./ConnectSourceFlow";
import { ConnectionDetailView } from "./ConnectionDetailView";
import { ConnectorDetail } from "./ConnectorDetail";
import { CreateCollectionDialog } from "./CreateCollectionDialog";
import { DocumentViewer } from "./DocumentViewer";
import { DocumentsView } from "./DocumentsView";
import { KnowledgeScopeSelect, KnowledgeToolbar, knowledgeTabs, type KnowledgeTab } from "./KnowledgeToolbar";
import { SourcesView } from "./SourcesView";
import { SyncActivityView } from "./SyncActivityView";

interface Choice {
  value: string;
  label: string;
}

interface FilterGroup {
  /** The state this group narrows. One group per independent dimension. */
  key: "status" | "type";
  label: string;
  options: readonly Choice[];
}

/**
 * What the two quiet menus offer, per subview.
 *
 * Every subview has both, because the toolbar has to keep its shape: an icon
 * group that changes width between tabs makes the search field slide, and a
 * strip that moves on every click reads as a page reloading. They are not
 * filler — each list narrows or orders the thing that subview actually shows.
 */
const FILTERS: Record<KnowledgeTab, readonly FilterGroup[]> = {
  documents: [
    {
      key: "status",
      label: "Status",
      options: [
        { value: "indexed", label: "Indexed" },
        { value: "indexing", label: "Indexing" },
        { value: "failed", label: "Not indexed" },
        { value: "restricted", label: "Restricted" },
      ],
    },
    {
      key: "type",
      label: "Format",
      options: [
        { value: "pdf", label: "PDF" },
        { value: "document", label: "Documents" },
        { value: "spreadsheet", label: "Spreadsheets" },
        { value: "unsupported", label: "Other formats" },
      ],
    },
  ],
  sources: [
    {
      key: "status",
      label: "Account",
      options: [
        { value: "connected", label: "Healthy" },
        { value: "reauth_required", label: "Reconnect needed" },
        { value: "expired", label: "Access expired" },
        { value: "disconnected", label: "Disconnected" },
      ],
    },
  ],
  activity: [
    {
      key: "status",
      label: "Outcome",
      options: [
        { value: "complete", label: "Completed" },
        { value: "running", label: "In progress" },
        { value: "failed", label: "Failed" },
      ],
    },
    {
      key: "type",
      label: "Kind",
      options: [
        { value: "", label: "All" },
        { value: "document", label: "Documents" },
        { value: "source", label: "Sources" },
      ],
    },
  ],
};

const SORTS: Record<KnowledgeTab, readonly Choice[]> = {
  documents: [
    { value: "recent", label: "Recently updated" },
    { value: "name", label: "Name" },
  ],
  sources: [
    { value: "name", label: "Name" },
    { value: "attention", label: "Needs attention first" },
  ],
  activity: [
    { value: "newest", label: "Newest first" },
    { value: "oldest", label: "Oldest first" },
  ],
};

const DEFAULT_SORT: Record<KnowledgeTab, string> = {
  documents: "recent",
  sources: "name",
  activity: "newest",
};

const SEARCH_COPY: Record<KnowledgeTab, { placeholder: string; label: string }> = {
  documents: { placeholder: "Search documents…", label: "Search documents" },
  sources: { placeholder: "Search accounts…", label: "Search connected accounts" },
  activity: { placeholder: "Search activity…", label: "Search sync activity" },
};

/** What the filter and sort menus name, for assistive technology. */
const SUBJECT: Record<KnowledgeTab, string> = {
  documents: "documents",
  sources: "connected accounts",
  activity: "sync activity",
};

/**
 * Knowledge.
 *
 * One shell, three subviews, and a selection that lives in the address. The
 * header, the tab bar and the scope stay put whichever subview is showing —
 * only the surface below the tab bar is replaced, which is what makes moving
 * between documents, sources and activity feel like staying in one place.
 */
export function KnowledgeScreen() {
  const query = useKnowledge();
  const catalogue = useConnectorCatalogue();
  // Connections load apart from documents: connecting an account must refresh
  // the accounts list without re-reading every document in the workspace.
  const integrations = useConnections();
  const session = useAuthSession();
  // Shared accounts are administered; a personal one is the member's own. The
  // API enforces this — the interface only avoids offering what it will refuse.
  const canManageWorkspace = hasSessionPermission(session, "source.manage");
  const canCreateCollection = hasSessionPermission(session, "item.manage");
  const { toast } = useToast();

  const [tabParam, setTab] = useRouteState("tab", "documents");
  const [selectedId, setSelectedId] = useRouteState("document");
  const [scope, setScope] = useRouteState("scope");
  const [connectionId, setConnectionId] = useRouteState("connection");
  const [connectorKey, setConnectorKey] = useRouteState("connector");

  const [search, setSearch] = useState("");
  const [statusByTab, setStatusByTab] = useState<Record<string, string>>({});
  const [typeByTab, setTypeByTab] = useState<Record<string, string>>({});
  const [sortByTab, setSortByTab] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [connecting, setConnecting] = useState<KnowledgeConnector | null>(null);
  const [creatingCollection, setCreatingCollection] = useState(false);
  /** Set when adding knowledge to an account that is already authorized. */
  const [addingTo, setAddingTo] = useState<Connection | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removalIds, setRemovalIds] = useState<string[] | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  const tab = (knowledgeTabs.some((item) => item.id === tabParam) ? tabParam : "documents") as KnowledgeTab;
  const status = statusByTab[tab] ?? "";
  const type = typeByTab[tab] ?? "";
  const sort = sortByTab[tab] ?? DEFAULT_SORT[tab];
  const setStatus = (value: string) => setStatusByTab((current) => ({ ...current, [tab]: value }));
  const setType = (value: string) => setTypeByTab((current) => ({ ...current, [tab]: value }));
  const setSort = (value: string) => setSortByTab((current) => ({ ...current, [tab]: value }));
  const snapshot = query.data;
  const documents = useMemo(() => snapshot?.documents ?? [], [snapshot]);
  const collections = useMemo(() => snapshot?.collections ?? [], [snapshot]);
  // Uploading needs the Collection's identity, not the label in the scope filter.
  const scopeCollectionId = useMemo(
    () => collections.find((collection) => collection.name === scope)?.id ?? null,
    [collections, scope],
  );
  const requestUpload = () => {
    if (scopeCollectionId ?? snapshot?.personalCollectionId) {
      uploadRef.current?.click();
      return;
    }
    setCreatingCollection(true);
  };
  const connections = useMemo(() => integrations.data?.connections ?? [], [integrations.data]);
  const sources = useMemo(() => integrations.data?.sources ?? [], [integrations.data]);
  const runs = useMemo(() => integrations.data?.runs ?? [], [integrations.data]);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return documents
      .filter((item) =>
        (!scope || item.collection === scope)
        && (!status || item.state === status)
        && (!type || item.kind === type)
        && item.title.toLowerCase().includes(needle))
      .sort((left, right) => (sort === "name" ? left.title.localeCompare(right.title) : 0));
  }, [documents, scope, search, sort, status, type]);

  const selected = documents.find((item) => item.id === selectedId);
  const selectedConnection = connections.find((item) => item.id === connectionId);
  // Reading about a connector is a state of this subview, not a route of its
  // own: one component introduces every connector, so adding one never adds a
  // page. The key lives in the address so the page can be linked to.
  const selectedEntry = connectorKey
    ? (catalogue.data?.find((entry) => entry.connector.key === connectorKey)
      ?? { connector: describeConnector(connectorKey) })
    : undefined;
  const filtered = Boolean(status || type);

  /**
   * Opening a document is a move from acting on many to reading one, and
   * changing scope is a move to a different set. Both end a selection rather
   * than carrying it into a list where the selected rows are not even visible.
   */
  const openDocument = (document: WorkspaceKnowledgeDocument) => {
    setSelectedId(document.id);
    setSelection([]);
    setExpanded(false);
  };

  /** Opening a document from Activity is a move to the list it lives in. */
  const openDocumentById = (documentId: string) => {
    const document = documents.find((item) => item.id === documentId);
    if (!document) return;
    setTab("documents");
    openDocument(document);
  };

  const browseCollection = (name: string) => {
    setScope(name);
    setSelection([]);
    setExpanded(false);
  };

  const clearFilters = () => {
    setStatus("");
    setType("");
    setSearch("");
  };


  const act = async (work: () => Promise<void>, failure: string) => {
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : failure);
    }
  };

  /**
   * Retry the failed ones among `targets`. A selection mixes states, so the
   * rest are left alone and the toast says how many were actually retried.
   */
  const retryIndexing = (targets: WorkspaceKnowledgeDocument[]) =>
    act(async () => {
      const retried = await knowledgeActions.retryIndexing(targets);
      const skipped = targets.length - retried;
      if (!retried) {
        toast({ title: "Nothing to retry", description: "None of these documents failed to index." });
        return;
      }
      toast({
        title: retried === 1 ? "Retrying indexing" : `Retrying ${retried} documents`,
        description: skipped
          ? `${pluralize(skipped, "other document")} in the selection didn’t fail, so ${skipped === 1 ? "it was" : "they were"} left as ${skipped === 1 ? "it is" : "they are"}.`
          : retried === 1
            ? "It shows as Indexing until it can be searched."
            : "They show as Indexing until they can be searched.",
        variant: "success",
      });
    }, "Indexing could not be retried. Try again in a moment.");

  /**
   * Index the selected documents again, whatever their last indexing did.
   * The backend decides which can be; the toast says how many started and
   * repeats its reasons for the rest, counted.
   */
  const reindexSelection = () =>
    act(async () => {
      const targets = documents.filter((document) => selection.includes(document.id));
      const { started, refused } = await knowledgeActions.reindex(targets);
      const reasons = [...refused].map(([reason, count]) => `${count.toLocaleString()} not started: ${reason}.`).join(" ");
      if (started) setSelection([]);
      toast({
        title: started
          ? `Re-indexing ${pluralize(started, "document")}`
          : "Nothing re-indexed",
        description: reasons || "They show as Indexing until they can be searched again.",
        variant: started && !refused.size ? "success" : undefined,
      });
    }, "The documents couldn’t be re-indexed. Try again in a moment.");

  const removeDocuments = async () => {
    const ids = removalIds ?? [];
    if (!ids.length) return;
    await act(async () => {
      await Promise.all(ids.map((id) => knowledgeActions.remove(id)));
      setSelection((current) => current.filter((id) => !ids.includes(id)));
      if (selectedId && ids.includes(selectedId)) setSelectedId("");
      toast({
        title: ids.length === 1 ? "Removed from knowledge" : `${ids.length} documents removed`,
        description: ids.length === 1
          ? "It stops appearing in answers within a minute."
          : "They stop appearing in answers within a minute.",
        variant: "success",
      });
    }, "The document could not be removed.");
    setRemovalIds(null);
  };

  /** Everything that changes connections reloads them, and only them. */
  const connectionAction = (work: () => Promise<void>) =>
    act(async () => {
      await work();
      integrations.reload();
    }, "The connected account could not be changed.");

  const reconnect = (connection: Connection) =>
    connectionAction(async () => {
      try {
        await authorizeConnection({
          connectorKey: connection.connector_key,
          ownerType: connection.owner_type === "workspace" ? "tenant" : "user",
          connectionId: connection.id,
        });
        toast({
          title: `${connection.display_name} reconnected`,
          description: "Its sources start updating again from the next sync.",
          variant: "success",
        });
      } catch (cause) {
        // Closing the provider window is a decision, not a failure.
        if (cause instanceof AuthorizationCancelled) return;
        if (cause instanceof PopupBlocked) throw new Error(cause.message);
        throw cause;
      }
    });

  const syncConnection = (id: string) => {
    const owned = sources.filter((source) => source.connection_id === id);
    setSyncingId(id);
    return act(async () => {
      await Promise.all(owned.map((source) => sourcesApi.syncNow(source.id)));
      toast({
        title: owned.length === 1 ? "Sync started" : `${owned.length} syncs started`,
        variant: "success",
      });
      integrations.reload();
    }, "The sync could not be started.").finally(() => setSyncingId(null));
  };

  const scopeOptions = [
    { value: "", label: "All knowledge", detail: snapshot ? snapshot.documentCount.toLocaleString() : undefined },
    ...collections.map((collection) => ({
      value: collection.name,
      label: collection.name,
      detail: collection.documentCount.toLocaleString(),
      disabled: collection.restricted,
    })),
  ];

  const pick = (key: FilterGroup["key"], value: string) => {
    if (key === "type") setType(type === value ? "" : value);
    else setStatus(status === value ? "" : value);
  };
  const isPicked = (key: FilterGroup["key"], value: string) =>
    (key === "type" ? type : status) === value;

  const connectSource = () => { setTab("sources"); setConnectionId(""); setConnectorKey(""); };

  /* Filter and sort on every subview, so the tab bar keeps its shape. */
  const toolbarActions = (
    <>
      <Dropdown
        align="right"
        ariaLabel={`Filter ${SUBJECT[tab]}`}
        buttonClassName="knowledge-icon-button"
        label={<ListFilter aria-hidden="true" size={18} />}
        showChevron={false}
        title="Filter"
      >
        {FILTERS[tab].map((group) => (
          <Fragment key={group.key}>
            <DropdownLabel>{group.label}</DropdownLabel>
            {group.options.map((option) => (
              <DropdownItem
                key={option.value}
                onClick={() => pick(group.key, option.value)}
                selected={isPicked(group.key, option.value)}
              >
                <Check
                  aria-hidden="true"
                  className={isPicked(group.key, option.value) ? "h-3.5 w-3.5" : "h-3.5 w-3.5 opacity-0"}
                />
                {option.label}
              </DropdownItem>
            ))}
          </Fragment>
        ))}
        {filtered && (
          <>
            <DropdownSeparator />
            <DropdownItem onClick={clearFilters}>Clear filters</DropdownItem>
          </>
        )}
      </Dropdown>

      <Dropdown
        align="right"
        ariaLabel={`Sort ${SUBJECT[tab]}`}
        buttonClassName="knowledge-icon-button"
        label={<ArrowUpDown aria-hidden="true" size={18} />}
        showChevron={false}
        title="Sort"
      >
        {SORTS[tab].map((option) => (
          <DropdownItem key={option.value} onClick={() => setSort(option.value)} selected={sort === option.value}>
            {option.label}
          </DropdownItem>
        ))}
      </Dropdown>
    </>
  );

  /* The page's one primary action. Uploading, organizing and connecting all
     add to the workspace rather than to the open subview, so they share one
     labelled menu in the header instead of three icons in the tab bar. */
  const addMenu = (
    <Dropdown
      align="right"
      buttonClassName="knowledge-add-trigger"
      disabled={busy}
      label={busy ? (
        <>
          <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" size={16} />
          Uploading…
        </>
      ) : (
        <>
          <Plus aria-hidden="true" size={16} />
          Add
        </>
      )}
      showChevron={!busy}
    >
      <DropdownItem onClick={requestUpload}>
        <Upload aria-hidden="true" size={16} />
        Upload files
      </DropdownItem>
      {canCreateCollection && (
        <DropdownItem onClick={() => setCreatingCollection(true)}>
          <FolderPlus aria-hidden="true" size={16} />
          New collection
        </DropdownItem>
      )}
      <DropdownItem onClick={connectSource}>
        <Plug aria-hidden="true" size={16} />
        Connect a source
      </DropdownItem>
    </Dropdown>
  );

  const health = snapshot && integrations.data
    ? [
      pluralize(snapshot.documentCount, "document"),
      pluralize(connections.length, "connected account"),
      pluralize(sources.length, "source"),
    ].join(" · ")
    : undefined;

  const documentsSurface = (
    <SplitView
      detail={selected ? (
        <DocumentViewer
          document={selected}
          expanded={expanded}
          onClose={() => setSelectedId("")}
          onExpand={() => setExpanded((value) => !value)}
          onRetryIndexing={canRetryIndexing(selected) ? () => void retryIndexing([selected]) : undefined}
          onRequestRemove={() => setRemovalIds([selected.id])}
        />
      ) : null}
      list={(
        <DocumentsView
          collections={collections}
          compact={Boolean(selected)}
          documents={rows}
          filtered={filtered}
          loading={!snapshot && !query.error}
          onClearFilters={clearFilters}
          onClearSelection={() => setSelection([])}
          onConnectSource={connectSource}
          onOpenCollection={browseCollection}
          onOpenDocument={openDocument}
          onReindexSelection={() => void reindexSelection()}
          onRemoveSelection={() => setRemovalIds(selection)}
          onToggleDocument={(id, checked) =>
            setSelection((current) => checked ? [...new Set([...current, id])] : current.filter((item) => item !== id))}
          onSelectDocuments={setSelection}
          onCreateCollection={canCreateCollection ? () => setCreatingCollection(true) : undefined}
          onUpload={requestUpload}
          onWidenScope={() => setScope("")}
          scope={scope}
          search={search}
          selectedId={selectedId}
          selection={selection}
          totalDocumentCount={snapshot?.documentCount ?? documents.length}
        />
      )}
      mode={selected ? (expanded ? "detail" : "split") : "list"}
    />
  );

  return (
    <section aria-label="Workspace knowledge" className="document-workspace">
      <SectionHeader actions={addMenu} className="document-workspace__head" description={health} section="knowledge" />

      <KnowledgeToolbar
        actions={toolbarActions}
        onTabChange={(next) => { setTab(next); setSelection([]); }}
        scope={tab === "documents"
          ? <KnowledgeScopeSelect onChange={(value) => { setScope(value); setSelection([]); }} options={scopeOptions} value={scope} />
          : undefined}
        search={{ value: search, onChange: setSearch, ...SEARCH_COPY[tab] }}
        tab={tab}
      />

      {/* A failed load and a failed action are different problems: reloading
          fixes the first, but would not repeat the second — so the action
          failure is dismissed rather than offered a "Retry" that does nothing. */}
      {(query.error || integrations.error || error) && (
        <div className="mx-[var(--page-gutter)] mt-[var(--space-5)] grid gap-[var(--space-2)]">
          {(query.error || integrations.error) && (
            <ErrorState
              actionLabel="Retry"
              description={query.error ?? integrations.error ?? ""}
              layout="inline"
              onAction={() => { query.reload(); integrations.reload(); }}
              title="Knowledge couldn’t be loaded"
            />
          )}
          {error && (
            <ErrorState
              actionLabel="Dismiss"
              description={error}
              layout="inline"
              onAction={() => setError(null)}
            />
          )}
        </div>
      )}

      {tab === "documents" && documentsSurface}

      {tab === "sources" && (selectedConnection ? (
        <ConnectionDetailView
          capability={catalogue.data?.find(
            (entry) => entry.connector.key === selectedConnection.connector_key,
          )?.capability}
          connection={selectedConnection}
          onAddKnowledge={() => {
            setAddingTo(selectedConnection);
            setConnecting(describeConnector(selectedConnection.connector_key));
          }}
          onBack={() => setConnectionId("")}
          onDisconnect={() => connectionAction(async () => {
            await connectionsApi.disconnect(selectedConnection.id);
            toast({ title: `${selectedConnection.display_name} disconnected`, variant: "success" });
          })}
          onReconnect={() => reconnect(selectedConnection)}
          onRemove={() => connectionAction(async () => {
            await connectionsApi.remove(selectedConnection.id);
            setConnectionId("");
            toast({ title: "Connected account removed", variant: "success" });
          })}
          onRemoveSource={(source) => connectionAction(async () => {
            await sourcesApi.remove(source.id);
            toast({ title: "Source removed", variant: "success" });
          })}
          onSyncSource={(id) => connectionAction(async () => {
            await sourcesApi.syncNow(id);
            toast({ title: "Sync started", variant: "success" });
          })}
          onToggleSource={(source) => connectionAction(async () => {
            await sourcesApi.update(source.id, {
              status: source.status === "paused" ? "ready" : "paused",
            });
          })}
          runs={runs.filter((run) => run.connection_id === selectedConnection.id)}
          sources={sources.filter(
            (source) => source.connection_id === selectedConnection.id,
          )}
        />
      ) : selectedEntry ? (
        <ConnectorDetail
          available={Boolean(
            catalogue.data?.some((entry) => entry.connector.key === selectedEntry.connector.key),
          )}
          capability={selectedEntry.capability}
          connections={connections.filter(
            (connection) => connection.connector_key === selectedEntry.connector.key,
          )}
          connector={selectedEntry.connector}
          onBack={() => setConnectorKey("")}
          onConnect={() => setConnecting(selectedEntry.connector)}
          onOpenConnection={(id) => { setConnectorKey(""); setConnectionId(id); }}
        />
      ) : (
        <SourcesView
          catalogue={catalogue}
          connections={connections}
          live={integrations.data?.live ?? false}
          onAddKnowledge={(connection) => {
            setAddingTo(connection);
            setConnecting(describeConnector(connection.connector_key));
          }}
          onConnect={setConnecting}
          onOpenConnection={setConnectionId}
          onOpenConnector={(connector) => setConnectorKey(connector.key)}
          onReconnect={(connection) => void reconnect(connection)}
          onSync={(id) => void syncConnection(id)}
          search={search}
          sort={sort}
          sources={sources}
          status={status}
          syncingId={syncingId}
        />
      ))}

      {tab === "activity" && (
        <SyncActivityView
          collections={collections}
          documents={documents}
          kind={type}
          onOpenDocument={openDocumentById}
          search={search}
          sort={sort}
          status={status}
        />
      )}

      <input
        aria-label="Upload knowledge file"
        className="hidden"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          setBusy(true);
          await act(async () => {
            const target = scopeCollectionId ?? snapshot?.personalCollectionId;
            if (!target) {
              throw new Error("Choose a collection before uploading.");
            }
            await knowledgeActions.upload(file, target);
            toast(file.name.toLowerCase().endsWith(".zip")
              ? {
                  title: `${file.name} uploaded`,
                  description: "Its files are extracted and indexed one by one. Each appears here as its own document.",
                  variant: "success",
                }
              : { title: "Document uploaded", variant: "success" });
          }, "Upload failed.");
          setBusy(false);
          event.target.value = "";
        }}
        ref={uploadRef}
        // Knowledge formats and archives of them; images are not knowledge yet.
        accept=".csv,.docx,.htm,.html,.json,.jsonl,.log,.markdown,.md,.pdf,.pptx,.rst,.sql,.tsv,.txt,.xlsx,.xml,.yaml,.yml,.zip"
        type="file"
      />

      <ConnectSourceFlow
        canManageWorkspace={canManageWorkspace}
        capability={catalogue.data?.find((entry) => entry.connector.key === connecting?.key)?.capability}
        connector={connecting}
        existingConnection={addingTo}
        onClose={() => { setConnecting(null); setAddingTo(null); }}
        onConnected={() => { integrations.reload(); query.reload(); }}
        open={Boolean(connecting)}
      />

      <CreateCollectionDialog
        onClose={() => setCreatingCollection(false)}
        onCreate={async ({ title, description }) => {
          const collection = await knowledgeActions.createCollection(title, description);
          setScope(collection.title);
          toast({
            action: { label: "View collection", onClick: () => setScope(collection.title) },
            description: "Upload files or connect a source to fill it.",
            title: `${collection.title} created`,
            variant: "success",
          });
        }}
        open={creatingCollection}
      />

      <ConfirmDialog
        confirmLabel={removalIds?.length === 1 ? "Remove document" : "Remove documents"}
        description={
          removalIds?.length === 1
            ? "It stops appearing in answers. The original file stays in its source."
            : `${removalIds?.length ?? 0} documents stop appearing in answers. The original files stay in their sources.`
        }
        onClose={() => setRemovalIds(null)}
        onConfirm={removeDocuments}
        open={Boolean(removalIds?.length)}
        title={removalIds?.length === 1 ? "Remove from knowledge?" : "Remove these documents?"}
      />
    </section>
  );
}
