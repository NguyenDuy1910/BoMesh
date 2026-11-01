"use client";

import { BookOpen, ChevronRight, FileText, Folder, HardDrive, SearchX } from "lucide-react";
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";

import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { SearchInput } from "@/components/ui/SearchInput";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import {
  addChildren,
  addNodes,
  checkState,
  coveringAncestor,
  pathOf,
  ROOT,
  toggleSelection,
  type ContentNode,
  type ContentTree,
} from "@/modules/ingestion/content-tree";
import { connectionsApi, type ProviderResource } from "@/modules/ingestion/integrations-api";
import { errorMessage, pluralize } from "@/lib/format";

const toNode = (resource: ProviderResource): ContentNode => ({
  id: resource.external_id,
  name: resource.name,
  resourceType: resource.resource_type,
  parentId: resource.parent_id,
  hasChildren: resource.has_children,
});

/** "folders" for Drive, "spaces and pages" for Confluence. */
export function contentNoun(connectorKey: string): string {
  return connectorKey === "google_drive" ? "folders" : connectorKey === "confluence" ? "spaces and pages" : "items";
}

function NodeIcon({ node }: { node: ContentNode }) {
  const className = "size-4 shrink-0 text-text-tertiary";
  if (node.resourceType === "space") return <BookOpen aria-hidden="true" className={className} />;
  if (node.resourceType === "page") return <FileText aria-hidden="true" className={className} />;
  if (node.resourceType === "drive" || node.resourceType === "shared_drive") {
    return <HardDrive aria-hidden="true" className={className} />;
  }
  return <Folder aria-hidden="true" className={className} />;
}

/**
 * What to sync, from the account's own tree: expand to load a level, search
 * across the whole account, tick to choose. A ticked node covers its subtree;
 * a node with something ticked below it is mixed.
 */
export function ContentPicker({
  connectionId,
  connectorKey,
  tree,
  onTreeChange,
  selection,
  onSelectionChange,
  error,
}: {
  connectionId: string;
  connectorKey: string;
  tree: ContentTree;
  onTreeChange: Dispatch<SetStateAction<ContentTree>>;
  selection: readonly string[];
  onSelectionChange: (selection: string[]) => void;
  error: string;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState<ReadonlySet<string>>(() => new Set());
  const [loadErrors, setLoadErrors] = useState<Readonly<Record<string, string>>>({});
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ query: string; ids: string[] } | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const noun = contentNoun(connectorKey);

  const load = useCallback(
    async (parentId: string | null) => {
      const key = parentId ?? ROOT;
      setLoading((current) => new Set(current).add(key));
      setLoadErrors(({ [key]: _dropped, ...rest }) => rest);
      try {
        const page = await connectionsApi.resources(connectionId, { parent_id: parentId ?? undefined });
        onTreeChange((current) => addChildren(current, parentId, page.items.map(toNode)));
      } catch (cause) {
        setLoadErrors((current) => ({ ...current, [key]: errorMessage(cause, "This account’s contents") }));
      } finally {
        setLoading((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [connectionId, onTreeChange],
  );

  const rootLoaded = tree.children[ROOT] !== undefined;
  useEffect(() => {
    if (!rootLoaded) void load(null);
  }, [load, rootLoaded]);

  // Searching an organisation is the server's question, asked once typing pauses.
  const term = query.trim();
  const [searchAttempt, setSearchAttempt] = useState(0);
  useEffect(() => {
    if (!term) {
      setResults(null);
      setSearchError(null);
      return;
    }
    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        const page = await connectionsApi.resources(connectionId, { search: term });
        if (!active) return;
        const nodes = page.items.map(toNode);
        onTreeChange((current) => addNodes(current, nodes));
        setResults({ query: term, ids: nodes.map((node) => node.id) });
        setSearchError(null);
      } catch (cause) {
        if (active) setSearchError(errorMessage(cause, "The search"));
      }
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [connectionId, onTreeChange, term, searchAttempt]);

  const toggleOpen = (node: ContentNode) => {
    const opening = !expanded.has(node.id);
    setExpanded((current) => {
      const next = new Set(current);
      if (opening) next.add(node.id);
      else next.delete(node.id);
      return next;
    });
    if (opening && tree.children[node.id] === undefined) void load(node.id);
  };

  const row = (node: ContentNode, depth: number, showPath = false) => {
    const state = checkState(tree, selection, node.id);
    const covered = !selection.includes(node.id) && Boolean(coveringAncestor(tree, selection, node.id));
    const open = expanded.has(node.id);
    const inputId = `content-${connectionId}-${node.id}`;
    const path = showPath ? pathOf(tree, node.id) : "";
    return (
      <div
        className="flex min-h-[38px] items-center gap-2 border-b border-border-subtle pr-3.5 last:border-b-0 hover:bg-surface-subtle"
        key={node.id}
        style={{ paddingLeft: 8 + depth * 24 }}
      >
        {node.hasChildren && !showPath ? (
          <button
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${node.name}`}
            className="grid size-6 shrink-0 place-items-center rounded-sm text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus-visible:shadow-(--shadow-focus) focus-visible:outline-none"
            onClick={() => toggleOpen(node)}
            type="button"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn("size-4 transition-transform duration-(--duration-fast) motion-reduce:transition-none", open && "rotate-90")}
            />
          </button>
        ) : (
          <span aria-hidden="true" className="size-6 shrink-0" />
        )}
        <Checkbox
          checked={state === "checked"}
          disabled={covered}
          id={inputId}
          indeterminate={state === "mixed"}
          onCheckedChange={() => onSelectionChange(toggleSelection(tree, selection, node.id))}
        />
        <label className="flex min-h-[38px] min-w-0 flex-1 cursor-pointer items-center gap-2" htmlFor={inputId}>
          <NodeIcon node={node} />
          <span className="min-w-0">
            <span className="block truncate">{node.name}</span>
            {path && path !== node.name && <span className="block truncate text-caption text-text-tertiary">{path}</span>}
          </span>
        </label>
        {covered && <span className="shrink-0 text-caption text-text-tertiary">Included</span>}
      </div>
    );
  };

  const branch = (parentId: string | null, depth: number): React.ReactNode[] => {
    const key = parentId ?? ROOT;
    const ids = tree.children[key];
    const out: React.ReactNode[] = [];
    if (loading.has(key) && !ids) {
      out.push(
        <div aria-busy="true" className="grid gap-2 py-2 pr-3.5" key={`${key}-loading`} style={{ paddingLeft: 40 + depth * 24 }}>
          <span className="sr-only">Loading</span>
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
        </div>,
      );
    }
    if (loadErrors[key] && parentId) {
      out.push(
        <div className="flex items-center gap-2 py-2 pr-3.5 text-meta text-status-danger" key={`${key}-error`} style={{ paddingLeft: 40 + depth * 24 }}>
          <span className="min-w-0 flex-1">{loadErrors[key]}</span>
          <Button onClick={() => void load(parentId)} size="sm" variant="ghost">
            Try again
          </Button>
        </div>,
      );
    }
    for (const id of ids ?? []) {
      const node = tree.nodes[id];
      if (!node) continue;
      out.push(row(node, depth));
      if (expanded.has(id)) out.push(...branch(id, depth + 1));
    }
    if (parentId && ids && ids.length === 0 && expanded.has(parentId)) {
      out.push(
        <div className="py-2 pr-3.5 text-meta text-text-tertiary" key={`${key}-empty`} style={{ paddingLeft: 40 + depth * 24 }}>
          Nothing inside
        </div>,
      );
    }
    return out;
  };

  const selectedCount = selection.length;
  let body: React.ReactNode;
  if (term) {
    if (searchError) {
      body = (
        <ErrorState
          description={searchError}
          layout="inline"
          onAction={() => {
            setSearchError(null);
            setSearchAttempt((attempt) => attempt + 1);
          }}
        />
      );
    } else if (!results || results.query !== term) {
      body = (
        <div aria-busy="true" className="grid gap-2 p-3">
          <span className="sr-only">Searching</span>
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-4/5" />
        </div>
      );
    } else if (!results.ids.length) {
      body = <EmptyState description="Try a different name." icon={<SearchX />} size="sm" title="No matches" />;
    } else body = results.ids.map((id) => tree.nodes[id] && row(tree.nodes[id], 0, true));
  } else if (loadErrors[ROOT]) {
    body = <ErrorState description={loadErrors[ROOT]} layout="inline" onAction={() => void load(null)} title="This account’s contents didn’t load" />;
  } else if (rootLoaded && !tree.children[ROOT]?.length) {
    body = (
      <EmptyState
        description={`This account has no ${noun} BoMesh can read.`}
        icon={<Folder />}
        size="sm"
        title="Nothing to choose"
      />
    );
  } else body = branch(null, 0);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2.5">
      <p className="text-text-secondary">
        Choose the {noun} to keep in sync. New files inside them sync automatically.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          ariaLabel={`Search ${noun}`}
          className="min-w-[200px] flex-1"
          onChange={setQuery}
          placeholder={`Search ${noun}`}
          size="sm"
          value={query}
        />
        <span aria-live="polite" className="text-meta text-text-secondary">
          {selectedCount ? `${pluralize(selectedCount, "item")} selected` : "Nothing selected"}
        </span>
        {selectedCount > 0 && (
          <Button onClick={() => onSelectionChange([])} size="sm" variant="ghost">
            Clear
          </Button>
        )}
      </div>
      <div
        aria-label="Content to sync"
        className={cn(
          "max-h-[320px] overflow-auto rounded-lg border bg-surface-base",
          error ? "border-status-danger" : "border-border-subtle",
        )}
        role="group"
      >
        {body}
      </div>
      {error && (
        <p className="text-meta text-status-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
