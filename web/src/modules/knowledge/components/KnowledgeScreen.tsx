"use client";

import { ArrowLeft, ChevronRight, FolderPlus, LoaderCircle, Plug, Plus, Upload, UsersRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { SplitView } from "@/components/layout/SplitView";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { SearchInput } from "@/components/ui/SearchInput";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { hasSessionPermission } from "@/lib/auth/session";
import { useAuthSession } from "@/lib/hooks/useAuthSession";
import { useRouteState } from "@/lib/hooks/useRouteState";
import { canProcess, runHref } from "@/modules/knowledge/document-facts";
import { knowledgeActions, useActiveRuns, useKnowledge } from "@/modules/knowledge/queries";
import { useProcessing } from "@/modules/knowledge/use-processing";
import type {
  WorkspaceKnowledgeCollection,
  WorkspaceKnowledgeDocument,
} from "@/modules/knowledge/workspace-repository";
import { SectionHeader } from "@/modules/workspace-control/components/SectionHeader";
import { pluralize } from "@/modules/workspace-control/format";

import { CollectionShareDialog } from "./CollectionAccess";
import { CollectionCards, CollectionFacts, CollectionTile } from "./CollectionCards";
import { CreateCollectionDialog } from "./CreateCollectionDialog";
import { DocumentViewer } from "./DocumentViewer";
import { DocumentsView } from "./DocumentsView";

/** The most documents one run may name; the API refuses more. */
const MAX_RUN_DOCUMENTS = 1000;

const KNOWLEDGE_PATH = "/workspace-control/knowledge";

/** Case- and accent-insensitive text, so "tot nghiep" finds "tốt nghiệp". */
const fold = (text: string) =>
  text.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

/**
 * Knowledge: what the workspace knows, organized into collections.
 *
 * A library with two kinds of page. The home page is the shelf of top-level
 * collections, with one search across everything. A collection's page is a
 * folder: where it sits, what it is for, who it is shared with, the
 * collections inside it and its items. Moving between them is real
 * navigation, so the browser's Back works and the breadcrumb leads home.
 * How content is processed belongs to Ingestion: here an item only says,
 * quietly, that it is not searchable yet.
 */
export function KnowledgeScreen() {
  const runs = useActiveRuns();
  // Runs still refresh the list while they work; they are just not shown here.
  const query = useKnowledge(runs.length > 0);
  const session = useAuthSession();
  const canCreateCollection = hasSessionPermission(session, "knowledge.manage");
  const router = useRouter();
  const { toast } = useToast();
  const { startRun, announceUpload } = useProcessing();

  const [selectedId, setSelectedId] = useRouteState("document");
  const [scope] = useRouteState("scope");

  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [creatingCollection, setCreatingCollection] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removalIds, setRemovalIds] = useState<string[] | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  const snapshot = query.data;
  const documents = useMemo(() => snapshot?.documents ?? [], [snapshot]);
  const collections = useMemo(() => snapshot?.collections ?? [], [snapshot]);
  const byId = useMemo(() => new Map(collections.map((collection) => [collection.id, collection])), [collections]);
  const current = scope ? collections.find((collection) => collection.name === scope) : undefined;

  /** A collection's parent, when the reader may see it. */
  const parentOf = (collection: WorkspaceKnowledgeCollection) =>
    collection.parentId ? byId.get(collection.parentId) : undefined;

  const childrenOf = useMemo(() => {
    const map = new Map<string | null, WorkspaceKnowledgeCollection[]>();
    for (const collection of collections) {
      const parent = collection.parentId && byId.has(collection.parentId) ? collection.parentId : null;
      map.set(parent, [...(map.get(parent) ?? []), collection]);
    }
    return map;
  }, [byId, collections]);

  const nested = useMemo(
    () => new Map([...childrenOf].filter(([id]) => id).map(([id, children]) => [id as string, children.length])),
    [childrenOf],
  );

  // The open collection and everything nested in it.
  const subtree = useMemo(() => {
    if (!current) return null;
    const ids = new Set<string>();
    const walk = (id: string) => {
      ids.add(id);
      for (const child of childrenOf.get(id) ?? []) walk(child.id);
    };
    walk(current.id);
    return ids;
  }, [childrenOf, current]);

  // Every page starts unsearched and unselected.
  useEffect(() => {
    setSearch("");
    setSelection([]);
    setExpanded(false);
  }, [scope]);

  const needle = fold(search.trim());
  const searching = Boolean(needle);

  // Browsing a collection shows its own items; a search reaches its whole
  // subtree, or the whole workspace from the home page.
  const rows = useMemo(() => {
    if (!searching && !current) return [];
    return documents
      .filter((document) => (current
        ? searching
          ? Boolean(document.collectionId && subtree?.has(document.collectionId))
          : document.collectionId === current.id
        : true))
      .filter((document) => !needle
        || fold(document.title).includes(needle)
        || fold(document.collection).includes(needle))
      .sort((left, right) => (right.modifiedAt ?? "").localeCompare(left.modifiedAt ?? ""));
  }, [current, documents, needle, searching, subtree]);

  const shelfCollections = useMemo(() => {
    if (!searching) return childrenOf.get(current?.id ?? null) ?? [];
    return collections.filter((collection) =>
      (!subtree || (subtree.has(collection.id) && collection.id !== current?.id))
      && (fold(collection.name).includes(needle)
        || fold(collection.description ?? "").includes(needle)));
  }, [childrenOf, collections, current, needle, searching, subtree]);

  const selected = documents.find((item) => item.id === selectedId);
  const canRunAny = collections.some((collection) => collection.canProcess);

  /* Going into a collection is navigation the browser remembers. */
  const open = (collection: WorkspaceKnowledgeCollection | null) => {
    router.push(collection ? `${KNOWLEDGE_PATH}?scope=${encodeURIComponent(collection.name)}` : KNOWLEDGE_PATH, { scroll: false });
  };

  const openDocument = (document: WorkspaceKnowledgeDocument) => {
    setSelectedId(document.id);
    setSelection([]);
    setExpanded(false);
  };

  const connectSource = () => router.push(
    `/workspace-control/ingestion${current ? `?collection=${encodeURIComponent(current.id)}` : ""}`,
  );

  const requestUpload = () => {
    if (current ?? snapshot?.personalCollectionId) {
      uploadRef.current?.click();
      return;
    }
    setCreatingCollection(true);
  };

  const processSelection = async () => {
    if (selection.length > MAX_RUN_DOCUMENTS) {
      setError(`Up to ${MAX_RUN_DOCUMENTS.toLocaleString()} items can be made searchable at once. Select fewer.`);
      return;
    }
    setStarting(true);
    if (await startRun({ document_ids: selection, trigger: "manual" })) setSelection([]);
    setStarting(false);
  };

  const removeDocuments = async () => {
    const ids = removalIds ?? [];
    if (!ids.length) return;
    setError(null);
    try {
      await Promise.all(ids.map((id) => knowledgeActions.remove(id)));
      setSelection((existing) => existing.filter((id) => !ids.includes(id)));
      if (selectedId && ids.includes(selectedId)) setSelectedId("");
      toast({
        title: ids.length === 1 ? "Item deleted" : `${ids.length.toLocaleString()} items deleted`,
        description: ids.length === 1
          ? "It stops appearing in answers within a minute."
          : "They stop appearing in answers within a minute.",
        variant: "success",
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The items couldn’t be deleted. Try again.");
    }
    setRemovalIds(null);
  };

  /* The page's one primary action. Uploading, organizing and connecting all
     add to the workspace, so they share one labelled menu. */
  const addMenu = (
    <Dropdown
      align="right"
      buttonClassName="knowledge-add-trigger"
      disabled={uploading}
      label={uploading ? (
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
      showChevron={!uploading}
    >
      <DropdownItem onClick={requestUpload}>
        <Upload aria-hidden="true" size={16} />
        {current ? `Upload to ${current.name}` : "Upload files"}
      </DropdownItem>
      {canCreateCollection && (
        <DropdownItem onClick={() => setCreatingCollection(true)}>
          <FolderPlus aria-hidden="true" size={16} />
          New collection
        </DropdownItem>
      )}
      <DropdownItem onClick={connectSource}>
        <Plug aria-hidden="true" size={16} />
        Connect source
      </DropdownItem>
    </Dropdown>
  );

  const header = current ? (
    <header className="knowledge-folder">
      <nav aria-label="Breadcrumb" className="knowledge-crumbs">
        <button
          aria-label={`Back to ${parentOf(current)?.name ?? "Knowledge"}`}
          className="knowledge-crumbs__back"
          onClick={() => open(parentOf(current) ?? null)}
          type="button"
        >
          <ArrowLeft aria-hidden="true" size={16} />
        </button>
        <ol>
          <li><button onClick={() => open(null)} type="button">Knowledge</button></li>
          {(() => {
            const trail: WorkspaceKnowledgeCollection[] = [];
            for (let at = parentOf(current); at && trail.length < 8; at = parentOf(at)) trail.unshift(at);
            return trail.map((collection) => (
              <li key={collection.id}>
                <ChevronRight aria-hidden="true" size={14} />
                <button onClick={() => open(collection)} type="button">{collection.name}</button>
              </li>
            ));
          })()}
          <li aria-current="page">
            <ChevronRight aria-hidden="true" size={14} />
            <span>{current.name}</span>
          </li>
        </ol>
      </nav>
      <div className="knowledge-folder__main">
        <CollectionTile collection={current} size="lg" />
        <div className="knowledge-folder__text">
          <h1>{current.name}</h1>
          {current.description && <p>{current.description}</p>}
          <CollectionFacts collection={current} inside={nested.get(current.id) ?? 0} />
        </div>
        <div className="knowledge-folder__actions">
          {current.canShare && (
            <Button icon={<UsersRound size={16} />} onClick={() => setSharing(true)} variant="secondary">
              Share
            </Button>
          )}
          {addMenu}
        </div>
      </div>
    </header>
  ) : (
    <SectionHeader
      actions={addMenu}
      className="document-workspace__head"
      description="What your workspace knows, organized into collections."
      section="knowledge"
    />
  );

  const itemList = (heading: string) => (
    <DocumentsView
      compact={Boolean(selected)}
      documents={rows}
      heading={heading}
      loading={!snapshot && !query.error}
      onClearSearch={() => setSearch("")}
      onClearSelection={() => setSelection([])}
      onOpenDocument={openDocument}
      onProcessSelection={canRunAny ? () => void processSelection() : undefined}
      onRemoveSelection={() => setRemovalIds(selection)}
      onSearchEverywhere={current ? () => open(null) : undefined}
      onToggleDocument={(id, checked) =>
        setSelection((existing) => checked ? [...new Set([...existing, id])] : existing.filter((item) => item !== id))}
      // An empty collection invites adding, unless it only holds collections.
      onUpload={current && !searching && !childrenOf.get(current.id)?.length ? requestUpload : undefined}
      processingSelection={starting}
      scope={current?.name ?? ""}
      search={search}
      selectedId={selectedId}
      selection={selection}
    />
  );

  const shelf = (title: string) => shelfCollections.length > 0 && (
    <section aria-label={title} className="knowledge-section">
      <div className="knowledge-list-heading">
        <h2 className="knowledge-eyebrow">{title}</h2>
        <span>{pluralize(shelfCollections.length, "collection")}</span>
      </div>
      <CollectionCards collections={shelfCollections} nested={nested} onOpen={open} />
    </section>
  );

  const body = (() => {
    if (!snapshot) {
      return query.error ? null : (
        <div className="knowledge-page knowledge-page--scroll"><PageLoadingSkeleton label="Loading knowledge" /></div>
      );
    }
    if (scope && !current) {
      return (
        <div className="knowledge-page knowledge-page--scroll">
          <EmptyState
            action={<Button onClick={() => open(null)} variant="secondary">Back to Knowledge</Button>}
            description="It may have been renamed or deleted, or it isn’t shared with you."
            size="sm"
            title={`“${scope}” isn’t available`}
          />
        </div>
      );
    }
    if (searching) {
      return (
        <div className="knowledge-page">
          {shelf("Collections")}
          {itemList("Items")}
        </div>
      );
    }
    if (current) {
      return (
        <div className="knowledge-page">
          {shelf("Collections inside")}
          {itemList("Items")}
        </div>
      );
    }
    if (!collections.length) {
      return (
        <div className="knowledge-page knowledge-page--scroll">
          <EmptyState
            action={(
              <>
                {canCreateCollection && <Button onClick={() => setCreatingCollection(true)} variant="secondary">New collection</Button>}
                <Button onClick={requestUpload} variant="ghost">Upload files</Button>
              </>
            )}
            description="Collections group what your workspace knows, so the assistant can answer from it."
            size="sm"
            title="No knowledge yet"
          />
        </div>
      );
    }
    return <div className="knowledge-page">{shelf("Collections")}</div>;
  })();

  const selectedCollection = selected?.collectionId ? byId.get(selected.collectionId) : undefined;
  const processSelected = selected && canProcess(selected) && (selectedCollection?.canProcess ?? false)
    ? () => void startRun({ document_ids: [selected.id], trigger: "manual" })
    : undefined;

  return (
    <section aria-label="Workspace knowledge" className="document-workspace">
      {header}

      <div className="knowledge-searchbar">
        <SearchInput
          ariaLabel={current ? `Search ${current.name}` : "Search knowledge"}
          className="knowledge-searchbar__field"
          debounceMs={120}
          onChange={setSearch}
          placeholder={current ? `Search ${current.name}…` : "Search knowledge…"}
          value={search}
        />
      </div>

      {/* A failed load and a failed action are different problems: reloading
          fixes the first, but would not repeat the second — so the action
          failure is dismissed rather than offered a "Retry" that does nothing. */}
      {(query.error || error) && (
        <div className="mx-[var(--page-gutter)] mt-[var(--space-5)] grid gap-[var(--space-2)]">
          {query.error && (
            <ErrorState
              actionLabel="Retry"
              description={query.error}
              layout="inline"
              onAction={query.reload}
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

      {selected ? (
        <SplitView
          detail={(
            <DocumentViewer
              document={selected}
              expanded={expanded}
              onClose={() => setSelectedId("")}
              onExpand={() => setExpanded((value) => !value)}
              onProcess={processSelected}
              onRequestRemove={() => setRemovalIds([selected.id])}
              onViewRun={(runId) => router.push(runHref(runId))}
            />
          )}
          list={itemList(current?.name ?? "Items")}
          mode={expanded || !rows.length ? "detail" : "split"}
        />
      ) : body}

      <input
        aria-label="Upload files"
        className="hidden"
        multiple
        onChange={async (event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          const target = current?.id ?? snapshot?.personalCollectionId;
          if (!files.length || !target) return;
          setUploading(true);
          setError(null);
          const outcome = await knowledgeActions.upload(files, target);
          setUploading(false);
          announceUpload(outcome, { canProcess: byId.get(target)?.canProcess ?? true });
        }}
        ref={uploadRef}
        // Knowledge formats and archives of them; images are not knowledge yet.
        accept=".csv,.docx,.htm,.html,.json,.jsonl,.log,.markdown,.md,.pdf,.pptx,.rst,.sql,.tsv,.txt,.xlsx,.xml,.yaml,.yml,.zip"
        type="file"
      />

      {current?.canShare && (
        <CollectionShareDialog collection={current} onClose={() => setSharing(false)} open={sharing} />
      )}

      <CreateCollectionDialog
        onClose={() => setCreatingCollection(false)}
        onCreate={async ({ title, description }) => {
          const collection = await knowledgeActions.createCollection(title, description);
          router.push(`${KNOWLEDGE_PATH}?scope=${encodeURIComponent(collection.title)}`, { scroll: false });
          toast({
            description: "Upload files or connect a source to fill it.",
            title: `${collection.title} created`,
            variant: "success",
          });
        }}
        open={creatingCollection}
      />

      <ConfirmDialog
        confirmLabel={removalIds?.length === 1 ? "Delete item" : "Delete items"}
        description={
          removalIds?.length === 1
            ? "It is removed from knowledge and stops appearing in answers."
            : `${removalIds?.length ?? 0} items are removed from knowledge and stop appearing in answers.`
        }
        onClose={() => setRemovalIds(null)}
        onConfirm={removeDocuments}
        open={Boolean(removalIds?.length)}
        title={removalIds?.length === 1 ? "Delete this item?" : "Delete these items?"}
      />
    </section>
  );
}
