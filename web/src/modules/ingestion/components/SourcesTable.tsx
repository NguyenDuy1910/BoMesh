"use client";

import { AlertTriangle, BookOpen, CircleCheck, CircleX, Clock, History, MoreHorizontal, Pause, Play, Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";

import { Button } from "@/components/ui/Button";
import { CellTitle, DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { ClearFilters, FilterChip } from "@/components/ui/FilterChip";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { Progress } from "@/components/ui/Progress";
import { SearchInput } from "@/components/ui/SearchInput";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Toolbar } from "@/components/ui/Toolbar";
import { cn } from "@/lib/cn";
import { accountLine, lastSyncResult, sourceName, type SyncResult } from "@/modules/ingestion/connection-state";
import type { Source } from "@/modules/ingestion/integrations-api";
import { runProgress } from "@/modules/ingestion/run-state";
import { describeSchedule } from "@/modules/ingestion/schedule";
import { formatDateTime, formatRelative } from "@/lib/format";

import { AppIcon } from "./AppIcon";
import type { SourcesModel } from "./SourcesScreen";

export interface SourceFilters {
  q: string;
  app: string;
  /** `healthy` | `syncing` | `attention` | `paused`. */
  status: string;
}

const STATUS_FILTERS = [
  { value: "healthy", label: "Up to date" },
  { value: "syncing", label: "Syncing" },
  { value: "attention", label: "Needs attention" },
  { value: "paused", label: "Paused" },
];

const RESULT_ICON: Record<SyncResult, { icon: React.ReactNode; label: string; className: string }> = {
  completed: { icon: <CircleCheck />, label: "Completed", className: "text-status-success" },
  partial: { icon: <AlertTriangle />, label: "Completed with issues", className: "text-status-warning" },
  failed: { icon: <CircleX />, label: "Failed", className: "text-status-danger" },
};

/** The Sources tab: every connected source, what it fills, how it stands and when it syncs. */
export function SourcesTable({
  model,
  filters,
  onFiltersChange,
  highlightId,
}: {
  model: SourcesModel;
  filters: SourceFilters;
  onFiltersChange: (filters: SourceFilters) => void;
  /** The source whose drawer is open, or one just connected. */
  highlightId: string | null;
}) {
  const sources = useMemo(() => model.data?.sources ?? [], [model.data]);
  const appOptions = useMemo(() => {
    const keys = new Set(sources.map((source) => model.connection(source.connection_id)?.connector_key).filter(Boolean) as string[]);
    return [...keys].map((key) => ({ value: key, label: model.connectorName(key) }));
  }, [model, sources]);

  const query = filters.q.trim().toLowerCase();
  const rows = sources.filter((source) => {
    const connection = model.connection(source.connection_id);
    if (filters.app && connection?.connector_key !== filters.app) return false;
    if (filters.status) {
      const key = model.status(source);
      if (filters.status === "attention" ? key !== "failed" && key !== "reconnect" : key !== filters.status) return false;
    }
    if (!query) return true;
    return [sourceName(source), model.knowledgeBase(source.collection_id)?.title, connection && accountLine(connection)]
      .some((value) => value?.toLowerCase().includes(query));
  });
  const filtered = Boolean(query || filters.app || filters.status);
  const clear = () => onFiltersChange({ q: "", app: "", status: "" });

  const columns: DataTableColumn<Source>[] = [
    {
      id: "name",
      header: "Source",
      sortable: true,
      sortValue: (source) => sourceName(source).toLowerCase(),
      minWidth: 220,
      cell: (source) => {
        const connection = model.connection(source.connection_id);
        return (
          <CellTitle
            icon={<AppIcon connector={connection?.connector_key ?? "unknown"} />}
            subtitle={connection ? accountLine(connection) : "Account removed"}
            title={sourceName(source)}
          />
        );
      },
    },
    {
      id: "kb",
      header: "Knowledge base",
      cell: (source) => {
        const kb = model.knowledgeBase(source.collection_id);
        return kb ? (
          <Link
            className="inline-flex max-w-[220px] items-center gap-2 rounded-xs text-text-primary hover:text-text-accent focus-visible:shadow-(--shadow-focus) focus-visible:outline-none"
            href={`/knowledge/${kb.id}`}
          >
            <BookOpen aria-hidden="true" className="size-4 shrink-0 text-text-tertiary" />
            <span className="truncate">{kb.title}</span>
          </Link>
        ) : (
          <span className="text-text-tertiary">Not available</span>
        );
      },
    },
    {
      id: "status",
      header: "Status",
      minWidth: 150,
      cell: (source) => <SourceStatusCell model={model} source={source} />,
    },
    {
      id: "schedule",
      header: "Schedule",
      hideBelow: 900,
      cell: (source) => {
        const off = model.status(source) === "paused" || (source.schedule && !source.schedule.enabled);
        return (
          <span className={off ? "text-text-tertiary" : "text-text-secondary"}>{describeSchedule(source.schedule)}</span>
        );
      },
    },
    {
      id: "last",
      header: "Last sync",
      sortable: true,
      hideBelow: 1080,
      sortValue: (source) => Date.parse(source.sync?.last_synced_at ?? "") || 0,
      cell: (source) => <LastSync source={source} />,
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      width: 1,
      cell: (source) => <SourceRowActions model={model} source={source} />,
    },
  ];

  return (
    <>
      {sources.length > 0 && (
        <Toolbar
          filters={
            <>
              <FilterChip label="App" onChange={(app) => onFiltersChange({ ...filters, app })} options={appOptions} value={filters.app} />
              <FilterChip label="Status" onChange={(status) => onFiltersChange({ ...filters, status })} options={STATUS_FILTERS} value={filters.status} />
              <ClearFilters active={filtered} onClear={clear} />
            </>
          }
          search={
            <SearchInput
              ariaLabel="Search sources"
              onChange={(q) => onFiltersChange({ ...filters, q })}
              placeholder="Search sources"
              value={filters.q}
            />
          }
        />
      )}
      <DataTable
        activeRowId={highlightId}
        ariaLabel="Sources"
        columns={columns}
        data={rows}
        emptyState={
          <EmptyState
            action={
              model.canManage && (
                <Button icon={<Plus />} onClick={model.open.connect}>
                  Connect source
                </Button>
              )
            }
            boxed
            description={
              model.canManage
                ? "Bring in documents from Google Drive or Confluence and keep them in sync."
                : "Sources a workspace admin connects appear here."
            }
            icon={<Plug />}
            title={model.canManage ? "Connect your first source" : "No sources yet"}
          />
        }
        error={model.data ? null : model.error}
        filtered={filtered}
        loading={!model.data && model.loading}
        onClearFilters={clear}
        onRetry={model.reload}
        onRowClick={(source) => model.open.source(source.id)}
      />
    </>
  );
}

/** Status, plus how far a sync has got while it runs. */
export function SourceStatusCell({ model, source }: { model: SourcesModel; source: Source }) {
  const key = model.status(source);
  const run = key === "syncing" ? model.activeRun(source) : null;
  const progress = run ? runProgress(run) : null;
  return (
    <div className="grid justify-items-start gap-1.5">
      <StatusBadge kind="source" value={key} />
      {key === "syncing" && (
        <div className="flex items-center gap-2 text-caption text-text-tertiary">
          <Progress
            className="w-[72px]"
            label={`${sourceName(source)} sync progress`}
            value={progress && progress.total ? progress.percent : undefined}
          />
          <span className="whitespace-nowrap tabular-nums">
            {progress && progress.total
              ? `${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`
              : "Finding changes"}
          </span>
        </div>
      )}
    </div>
  );
}

function LastSync({ source }: { source: Source }) {
  const at = source.sync?.last_synced_at;
  if (!at) return <span className="text-text-tertiary">Never</span>;
  const result = lastSyncResult(source.sync);
  const mark = result ? RESULT_ICON[result] : null;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-text-secondary" title={formatDateTime(at)}>
      {mark && (
        <span className={cn("inline-flex [&_svg]:size-4", mark.className)}>
          {mark.icon}
          <span className="sr-only">{mark.label}</span>
        </span>
      )}
      {formatRelative(at)}
    </span>
  );
}

/** Reconnect when the account stopped it; otherwise the row menu. */
function SourceRowActions({ model, source }: { model: SourcesModel; source: Source }) {
  if (!model.canManageSource(source)) return null;
  const key = model.status(source);
  if (key === "reconnect") {
    return (
      <Button onClick={() => model.open.reconnect(source.connection_id)} size="sm" variant="secondary">
        Reconnect
      </Button>
    );
  }
  return <SourceMenu model={model} source={source} />;
}

/** The row's actions. In the drawer, the footer already offers Sync now and Pause. */
export function SourceMenu({ model, source, inDrawer = false }: { model: SourcesModel; source: Source; inDrawer?: boolean }) {
  const key = model.status(source);
  const syncing = key === "syncing";
  const paused = key === "paused";
  return (
    <Menu
      align="end"
      ariaLabel={`More actions for ${sourceName(source)}`}
      label={<MoreHorizontal className="size-4" />}
      showChevron={false}
      tooltip="More actions"
      triggerClassName="h-[var(--control-sm)] w-[var(--control-sm)] bg-transparent px-0 shadow-none hover:bg-surface-hover"
    >
      {!inDrawer && (
        <>
          <MenuItem disabled={syncing || paused} icon={<RefreshCw />} onSelect={() => void model.act.sync(source)}>
            Sync now
          </MenuItem>
          <MenuItem icon={<Clock />} onSelect={() => model.open.source(source.id, { editSchedule: true })}>
            Edit schedule
          </MenuItem>
          <MenuItem
            disabled={syncing}
            icon={paused ? <Play /> : <Pause />}
            onSelect={() => void model.act.setPaused(source, !paused)}
          >
            {paused ? "Resume" : "Pause"}
          </MenuItem>
        </>
      )}
      <MenuItem icon={<History />} onSelect={() => model.open.history(source.id)}>
        View sync history
      </MenuItem>
      <MenuSeparator />
      <MenuItem danger icon={<Trash2 />} onSelect={() => model.act.disconnect(source)}>
        Disconnect
      </MenuItem>
    </Menu>
  );
}
