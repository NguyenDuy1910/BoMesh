"use client";

import { Archive, ChevronDown, FileText, FolderInput, Info, MoreHorizontal, Plug, Plus, RotateCw, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { BulkActionButton, DataTable, type DataTableColumn, type SortState } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { ClearFilters, FilterChip } from "@/components/ui/FilterChip";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/Menu";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import { Toolbar } from "@/components/ui/Toolbar";
import { usePendingFeature } from "@/lib/api/pending";
import { invalidateApiData } from "@/lib/api/revision";
import { useRouteState } from "@/lib/hooks/useRouteState";
import { STATUS } from "@/lib/status";
import { moveDocuments } from "@/modules/knowledge/api";
import { archiveDocuments } from "@/modules/knowledge/archive-queue";
import { FileTypeIcon, fileTypeOf } from "@/modules/knowledge/components/FileTypeIcon";
import type { Collection, ContractDocument } from "@/modules/knowledge/knowledge-api";
import {
  TYPE_FILTERS,
  canReprocess,
  matchesSearch,
  typeGroup,
  type AccessSummary,
  type ListedDocument,
} from "@/modules/knowledge/model";
import { formatBytes, formatDate, formatRelative, pluralize } from "@/lib/format";

import { DocumentDetailsDrawer } from "./DocumentDetailsDrawer";
import { KnowledgeBaseMark } from "./KnowledgeBaseMark";

const PAGE_SIZE = 15;
/** How long Undo stays offered before an archive is sent. */
const UNDO_MS = 8000;

const STATUS_FILTERS = Object.entries(STATUS.doc).map(([value, spec]) => ({ value, label: spec.label }));

type Row = ListedDocument & { id: string };

export interface DocumentPermissions {
  canEdit: boolean;
  canRun: boolean;
  canShare: boolean;
  canConnect: boolean;
}

/**
 * The documents of one knowledge base: find, filter and sort them, open one,
 * and — for editors — reprocess, move or archive several at once.
 */
export function DocumentsTab({
  collection,
  collectionTitle,
  personal,
  documents,
  documentsError,
  onRetryLoad,
  permissions,
  access,
  localAccess,
  moveTargets,
  onUpload,
  onConnect,
  onProcess,
}: {
  collection: Collection;
  collectionTitle: string;
  personal: boolean;
  /** `null` while loading. */
  documents: ListedDocument[] | null;
  documentsError: string | null;
  onRetryLoad: () => void;
  permissions: DocumentPermissions;
  access: AccessSummary;
  localAccess: boolean;
  /** Other knowledge bases the caller can add to. */
  moveTargets: readonly Pick<Collection, "id" | "title">[];
  onUpload: () => void;
  onConnect: () => void;
  onProcess: (documents: ContractDocument[], kind: "reprocess" | "retry") => Promise<boolean>;
}) {
  const router = useRouter();
  const toast = useToast();
  const moveEnabled = usePendingFeature("document.move");
  const restoreEnabled = usePendingFeature("document.restore");
  const { canEdit, canRun, canShare, canConnect } = permissions;

  const [search, setSearch] = useState("");
  const [status, setStatus] = useRouteState("status");
  const [type, setType] = useState("");
  const [sort, setSort] = useState<SortState | null>({ columnId: "updated", direction: "desc" });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<ContractDocument[] | null>(null);

  const all = useMemo<Row[]>(() => (documents ?? []).map((entry) => ({ ...entry, id: entry.document.id })), [documents]);
  const failed = all.filter((row) => row.document.processing.state === "failed");
  const filtering = Boolean(search.trim() || status || type);

  const rows = useMemo(() => {
    const visible = all.filter(({ document }) =>
      matchesSearch(search, document.name)
      && (!status || document.processing.state === status)
      && (!type || typeGroup(fileTypeOf(document.content_type, document.name).kind) === type));
    if (!sort) return visible;
    const direction = sort.direction === "asc" ? 1 : -1;
    const value = (row: Row): string | number =>
      sort.columnId === "name" ? row.document.name.toLowerCase()
        : sort.columnId === "size" ? row.document.size_bytes
          : row.document.updated_at;
    return [...visible].sort((left, right) => {
      const a = value(left);
      const b = value(right);
      return direction * (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b)));
    });
  }, [all, search, sort, status, type]);

  const details = all.find((row) => row.id === detailsId) ?? null;
  const pick = (ids: readonly string[]) => all.filter((row) => ids.includes(row.id)).map((row) => row.document);
  const clearFilters = () => {
    setSearch("");
    setStatus("");
    setType("");
    setPage(1);
  };

  const reprocess = async (picked: ContractDocument[], kind: "reprocess" | "retry") => {
    const runnable = picked.filter(canReprocess);
    if (!runnable.length) {
      toast.show({ tone: "info", message: "These files can’t be searched, so there’s nothing to reprocess" });
      return;
    }
    if (await onProcess(runnable, kind)) setSelected([]);
  };

  const confirmArchive = async () => {
    const picked = archiving ?? [];
    if (!picked.length) return;
    const one = picked.length === 1;
    const subject = one ? `“${picked[0].name}”` : pluralize(picked.length, "document");
    const ids = picked.map((document) => document.id);
    const handle = archiveDocuments(ids, {
      holdMs: restoreEnabled ? UNDO_MS : 0,
      onFailed: (refused) => toast.show({
        tone: "err",
        message: refused.length === 1 ? "A document couldn’t be archived" : `${pluralize(refused.length, "document")} couldn’t be archived`,
        description: "It’s back in the list. Try again.",
      }),
    });
    setSelected((current) => current.filter((id) => !ids.includes(id)));
    if (detailsId && ids.includes(detailsId)) setDetailsId(null);
    toast.show({
      message: `Archived ${subject}`,
      duration: restoreEnabled ? UNDO_MS : undefined,
      action: restoreEnabled
        ? {
            label: "Undo",
            onClick: () => {
              handle.undo().then(
                () => toast.show({ message: `Restored ${subject}` }),
                (cause: unknown) => toast.show({ tone: "err", message: `${subject} couldn’t be restored`, description: cause instanceof Error ? cause.message : undefined }),
              );
            },
          }
        : undefined,
    });
  };

  const move = async (ids: string[], target: Pick<Collection, "id" | "title">) => {
    try {
      const result = await moveDocuments({ document_ids: ids, collection_id: target.id });
      setSelected([]);
      invalidateApiData();
      if (result.moved.length) {
        const what = pluralize(result.moved.length, "document");
        toast.show({
          message: `Moved ${what} to ${target.title}`,
          action: {
            label: "Undo",
            onClick: () => {
              void moveDocuments({ document_ids: result.moved, collection_id: collection.id }).then(
                () => {
                  invalidateApiData();
                  toast.show({ message: `Moved ${what} back` });
                },
                (cause: unknown) => toast.show({ tone: "err", message: "The move couldn’t be undone", description: cause instanceof Error ? cause.message : undefined }),
              );
            },
          },
        });
      }
      if (result.failed.length) {
        toast.show({
          tone: "err",
          message: `${pluralize(result.failed.length, "document")} couldn’t be moved`,
          description: result.failed.some((failure) => failure.reason === "forbidden")
            ? "You can’t change some of them."
            : "They may have been removed or are already there.",
        });
      }
    } catch (cause) {
      toast.show({ tone: "err", message: "The documents couldn’t be moved", description: cause instanceof Error ? cause.message : undefined });
    }
  };

  const rowMenu = (row: Row) => {
    const { document } = row;
    const state = document.processing.state;
    return (
      <Menu
        align="end"
        trigger={(props) => (
          <Button {...props} aria-label={`More actions for ${document.name}`} icon={<MoreHorizontal size={16} />} iconOnly size="sm" variant="ghost" />
        )}
      >
        <MenuItem href={`/documents/${encodeURIComponent(document.id)}`} icon={<FileText />}>Open</MenuItem>
        <MenuItem icon={<Info />} onSelect={() => setDetailsId(document.id)}>Details</MenuItem>
        {canRun && (state === "failed" || state === "outdated" || state === "pending") && (
          <MenuItem icon={<RotateCw />} onSelect={() => void reprocess([document], state === "failed" ? "retry" : "reprocess")}>
            {state === "failed" ? "Retry" : state === "pending" ? "Process now" : "Reprocess"}
          </MenuItem>
        )}
        {canEdit && (
          <>
            <MenuSeparator />
            <MenuItem danger icon={<Archive />} onSelect={() => setArchiving([document])}>Archive</MenuItem>
          </>
        )}
      </Menu>
    );
  };

  const columns: DataTableColumn<Row>[] = [
    {
      id: "name",
      header: "Name",
      sortable: true,
      cell: ({ document, movedHere }) => {
        const fileType = fileTypeOf(document.content_type, document.name);
        return (
          <div className="flex min-w-0 items-center gap-3">
            <FileTypeIcon decorative kind={fileType.kind} label={fileType.label} />
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium text-[var(--text-primary)]" title={document.name}>{document.name}</span>
                {movedHere && <PreviewTag />}
              </div>
              <div className="truncate text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">
                {document.created_at ? `Added ${formatDate(document.created_at)}` : fileType.label}
              </div>
            </div>
          </div>
        );
      },
    },
    { id: "status", header: "Status", cell: ({ document }) => <StatusBadge kind="doc" value={document.processing.state} /> },
    {
      id: "updated",
      header: "Updated",
      sortable: true,
      cell: ({ document }) => (
        <span className="whitespace-nowrap text-[var(--text-secondary)]" title={document.updated_at}>{formatRelative(document.updated_at)}</span>
      ),
    },
    {
      id: "size",
      header: "Size",
      sortable: true,
      align: "right",
      hideBelow: 1080,
      cell: ({ document }) => <span className="text-[var(--text-secondary)]">{formatBytes(document.size_bytes)}</span>,
    },
  ];

  if (documentsError && !documents) {
    return <ErrorState description={documentsError} onAction={onRetryLoad} title="Documents didn’t load" />;
  }
  if (!documents) return <SkeletonRows columns={4} label="Loading documents" rows={8} />;

  if (!all.length) {
    return canEdit ? (
      <EmptyState
        action={(
          <>
            <Button icon={<Upload aria-hidden="true" size={16} />} onClick={onUpload} variant="primary">Upload files</Button>
            {canConnect && <Button icon={<Plug aria-hidden="true" size={16} />} onClick={onConnect} variant="secondary">Connect a source</Button>}
          </>
        )}
        boxed
        description={personal
          ? "Upload files to ask about them. Only you can see them."
          : "Upload files or connect a source. They become searchable in a few minutes."}
        icon={<Upload />}
        title="Add your first documents"
      />
    ) : (
      <EmptyState boxed description="The owners haven’t added anything here yet." icon={<FileText />} title="No documents yet" />
    );
  }

  const moveMenu = (ids: string[]) => (
    <Menu
      trigger={(props) => <BulkActionButton {...props} icon={<FolderInput />}>Move to…</BulkActionButton>}
    >
      <MenuLabel className="flex items-center gap-2">Move to <PreviewTag /></MenuLabel>
      {moveTargets.length ? moveTargets.map((target) => (
        <MenuItem
          icon={<KnowledgeBaseMark id={target.id} size="sm" title={target.title} />}
          key={target.id}
          onSelect={() => void move(ids, target)}
          textValue={target.title}
        >
          {target.title}
        </MenuItem>
      )) : <MenuItem disabled>No other knowledge bases you can edit</MenuItem>}
    </Menu>
  );

  return (
    <>
      <Toolbar
        end={<span className="text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">{pluralize(rows.length, "document")}</span>}
        filters={(
          <>
            <FilterChip label="Status" onChange={(value) => { setStatus(value); setPage(1); }} options={STATUS_FILTERS} value={status} />
            <FilterChip label="Type" onChange={(value) => { setType(value); setPage(1); }} options={TYPE_FILTERS} value={type} />
            <ClearFilters active={Boolean(status || type)} onClear={() => { setStatus(""); setType(""); setPage(1); }} />
          </>
        )}
        search={<SearchInput ariaLabel="Search documents" onChange={(value) => { setSearch(value); setPage(1); }} placeholder="Search documents" value={search} />}
      />
      {canRun && failed.length > 0 && (
        <Callout
          actions={(
            <>
              <Button icon={<RotateCw aria-hidden="true" size={15} />} onClick={() => void reprocess(failed.map((row) => row.document), "retry")} size="sm" variant="secondary">
                Retry all
              </Button>
              {status !== "failed" && (
                <Button onClick={() => { setStatus("failed"); setPage(1); }} size="sm" variant="ghost">Show</Button>
              )}
            </>
          )}
          className="mb-3"
          title={`${pluralize(failed.length, "document")} couldn’t be processed.`}
          tone="warn"
        />
      )}
      <DataTable
        activeRowId={detailsId}
        ariaLabel="Documents"
        bulkActions={canEdit ? (ids) => (
          <>
            {canRun && (
              <BulkActionButton icon={<RotateCw />} onClick={() => void reprocess(pick(ids), "reprocess")}>Reprocess</BulkActionButton>
            )}
            {moveEnabled && moveMenu(ids)}
            <BulkActionButton icon={<Archive />} onClick={() => setArchiving(pick(ids))}>Archive</BulkActionButton>
          </>
        ) : undefined}
        columns={columns}
        data={rows}
        filtered={filtering}
        onClearFilters={clearFilters}
        onRowClick={(row) => router.push(`/documents/${encodeURIComponent(row.id)}`)}
        onSelectionChange={setSelected}
        onSortChange={(next) => {
          setSort(next);
          setPage(1);
        }}
        pagination={{ page, pageSize: PAGE_SIZE, total: rows.length, onPageChange: setPage }}
        rowActions={rowMenu}
        rowLabel={(row) => row.document.name}
        selectable={canEdit}
        selectedIds={selected}
        sort={sort}
      />

      <DocumentDetailsDrawer
        access={access}
        canEdit={canEdit}
        canRun={canRun}
        canShare={canShare}
        collection={collection}
        collectionTitle={collectionTitle}
        document={details?.document ?? null}
        localAccess={localAccess}
        movedHere={details?.movedHere ?? false}
        onArchive={(document) => setArchiving([document])}
        onClose={() => setDetailsId(null)}
        onReprocess={(document) => void reprocess([document], document.processing.state === "failed" ? "retry" : "reprocess")}
      />

      <ConfirmDialog
        confirmLabel="Archive"
        description={(
          <span className="grid gap-2">
            <span>
              {archiving?.length === 1
                ? "It’ll be removed from answers and from this knowledge base."
                : "They’ll be removed from answers and from this knowledge base."}
            </span>
            {restoreEnabled && (
              <span className="flex items-center gap-2 text-[var(--text-tertiary)]">
                You can undo this for a few seconds. <PreviewTag />
              </span>
            )}
          </span>
        )}
        onClose={() => setArchiving(null)}
        onConfirm={confirmArchive}
        open={Boolean(archiving?.length)}
        title={archiving?.length === 1 ? `Archive “${archiving[0].name}”?` : `Archive ${pluralize(archiving?.length ?? 0, "document")}?`}
      />
    </>
  );
}

/** The add-content call to action in the header, for editors. */
export function AddContentAction({
  canConnect,
  variant,
  onUpload,
  connectHref,
}: {
  canConnect: boolean;
  variant: "primary" | "secondary";
  onUpload: () => void;
  connectHref: string;
}) {
  if (!canConnect) {
    return <Button icon={<Upload aria-hidden="true" size={16} />} onClick={onUpload} variant={variant}>Upload files</Button>;
  }
  return (
    <Menu
      align="end"
      trigger={(props, open) => (
        <Button
          {...props}
          icon={<Plus aria-hidden="true" size={16} />}
          iconAfter={<ChevronDown aria-hidden="true" size={15} />}
          selected={open}
          variant={variant}
        >
          Add content
        </Button>
      )}
    >
      <MenuItem icon={<Upload />} onSelect={onUpload}>Upload files</MenuItem>
      <MenuItem href={connectHref} icon={<Plug />}>Connect a source</MenuItem>
    </Menu>
  );
}

