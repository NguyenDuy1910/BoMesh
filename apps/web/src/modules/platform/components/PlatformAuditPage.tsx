"use client";

import { Activity, ArrowRight, Download } from "lucide-react";
import { useState } from "react";

import { Page } from "@/components/shell/Page";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { Drawer } from "@/components/ui/Drawer";
import { EmptyState } from "@/components/ui/EmptyState";
import { ClearFilters, FilterChip } from "@/components/ui/FilterChip";
import { PageHeader } from "@/components/ui/PageHeader";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { SearchInput } from "@/components/ui/SearchInput";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import { Toolbar } from "@/components/ui/Toolbar";
import { usePendingFeature } from "@/lib/api/pending";
import { hasPlatformPermission } from "@/lib/auth/session";
import { useAuthSession } from "@/lib/hooks/useAuthSession";
import { outcomeStatusKey } from "@/lib/status";
import type { AuditEvent } from "@/modules/manage/access/directory";
import { ActorAvatar } from "@/modules/manage/activity/Actor";
import { AUDIT_AREAS, auditActionArea, auditActorName, describeAuditAction, describeAuditTarget } from "@/modules/manage/activity/audit-actions";
import { exportPlatformAuditLogs, listPlatformAuditEvents } from "@/modules/platform/api";
import { PLATFORM_SCOPE, platformAuditMatches, type PlatformAuditFilter, type PlatformAuditWindow } from "@/modules/platform/audit-filter";
import { Facts } from "@/modules/platform/components/Facts";
import { PlatformMark, WorkspaceMark } from "@/modules/platform/components/WorkspaceMark";
import { formatDateTime, formatRelative } from "@/lib/format";
import { useApiData } from "@/lib/hooks/useApiData";

const WINDOWS: { value: PlatformAuditWindow; label: string }[] = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

const PAGE_SIZE = 25;

const AREA_LABEL: Record<string, string> = Object.fromEntries([...AUDIT_AREAS, { value: "other", label: "Other" }].map((area) => [area.value, area.label]));

function WorkspaceCell({ workspace }: { workspace: AuditEvent["workspace"] }) {
  if (!workspace) {
    return (
      <span className="flex min-w-0 items-center gap-2">
        <PlatformMark />
        <span className="text-text-secondary">Platform</span>
      </span>
    );
  }
  const name = workspace.name?.trim() || "Deleted workspace";
  return (
    <span className="flex min-w-0 items-center gap-2">
      <WorkspaceMark name={name} size="xs" />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** An IP address when the event's details record one; audit rows carry none of their own. */
function ipOf(event: AuditEvent): string | null {
  for (const key of ["ip_address", "ip"]) {
    const value = event.details?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Platform → Audit log: every recorded change across workspaces and the
 * platform itself, from the real `/platform/audit-logs`. The endpoint only
 * searches, so the window is read page by page and workspace, area and result
 * filter what was read.
 */
export function PlatformAuditPage() {
  const session = useAuthSession();
  const canOpenWorkspaces = hasPlatformPermission(session, "platform.tenant.read");
  const canExport = usePendingFeature("platform.audit_export");
  const toast = useToast();
  const [exporting, setExporting] = useState(false);
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState<PlatformAuditWindow>("30d");
  const [workspace, setWorkspace] = useState("");
  const [area, setArea] = useState("");
  const [result, setResult] = useState("");
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const query = useApiData(() => listPlatformAuditEvents({ search, window: period }), `${period}:${search}`);
  const events = query.data?.items ?? [];

  const filter: PlatformAuditFilter = {
    workspace_id: workspace || undefined,
    area: area || undefined,
    outcome: result === "success" || result === "failure" ? result : undefined,
  };
  const rows = events.filter((event) => platformAuditMatches(event, filter));

  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const blob = await exportPlatformAuditLogs({ format: "csv", window: period, search, ...filter });
      // Records end with CRLF outside quotes (a quoted cell may hold line breaks); the first is the header.
      let records = 0;
      let quoted = false;
      const text = await blob.text();
      for (let index = 0; index < text.length; index += 1) {
        if (text[index] === "\"") quoted = !quoted;
        else if (!quoted && text[index] === "\n") records += 1;
      }
      const count = Math.max(0, records - 1);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      // The reader's own date: en-CA formats it as YYYY-MM-DD.
      link.download = `platform-audit-${new Date().toLocaleDateString("en-CA")}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      toast.show({ message: `Exported ${count.toLocaleString()} ${count === 1 ? "event" : "events"}` });
    } catch (cause) {
      toast.show({ tone: "err", message: "Couldn’t export the audit log", description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setExporting(false);
    }
  };
  const filtersActive = Boolean(workspace || area || result);
  const clearFilters = () => {
    setWorkspace("");
    setArea("");
    setResult("");
    setPage(1);
  };

  const workspaceOptions = [
    { value: PLATFORM_SCOPE, label: "Platform" },
    ...[...new Map(events.flatMap((event) => (event.workspace ? [[event.workspace.id, event.workspace.name?.trim() || "Deleted workspace"] as const] : []))).entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([value, label]) => ({ value, label })),
  ];
  const presentAreas = new Set(events.map((event) => auditActionArea(event.action)));
  const areaOptions = Object.entries(AREA_LABEL)
    .filter(([value]) => presentAreas.has(value as never) || value === area)
    .map(([value, label]) => ({ value, label }));

  const selected = openId ? events.find((event) => event.id === openId) ?? null : null;
  const filterBy = (set: (value: string) => void) => (value: string) => {
    set(value);
    setPage(1);
  };

  const columns: DataTableColumn<AuditEvent>[] = [
    {
      id: "when",
      header: "When",
      width: 130,
      cell: (event) => (
        <span className="whitespace-nowrap text-text-secondary" title={formatDateTime(event.created_at, "")}>
          {formatRelative(event.created_at, "—")}
        </span>
      ),
    },
    {
      id: "person",
      header: "Person",
      width: 200,
      hideBelow: 900,
      cell: (event) => (
        <span className="flex min-w-0 items-center gap-2">
          <ActorAvatar actor={event.actor} size="xs" />
          <span className="truncate">{auditActorName(event.actor)}</span>
        </span>
      ),
    },
    {
      id: "action",
      header: "Action",
      cell: (event) => (
        <span className="block min-w-0">
          <span className="block font-medium text-text-primary">{describeAuditAction(event.action, event.details)}</span>
          <span className="block max-w-[320px] truncate text-meta text-text-tertiary">{describeAuditTarget(event)}</span>
        </span>
      ),
    },
    {
      id: "workspace",
      header: "Workspace",
      width: 220,
      cell: (event) => <WorkspaceCell workspace={event.workspace ?? null} />,
    },
    {
      id: "result",
      header: "Result",
      width: 120,
      cell: (event) => <StatusBadge kind="outcome" value={outcomeStatusKey(event.outcome)} />,
    },
  ];

  return (
    <Page>
      <PageHeader
        actions={canExport && (
          <span className="inline-flex items-center gap-2">
            <PreviewTag />
            <Button icon={<Download aria-hidden="true" />} loading={exporting} onClick={() => void exportCsv()} variant="secondary">
              Export CSV
            </Button>
          </span>
        )}
        sub="Every recorded change across workspaces."
        title="Audit log"
      />
      <Toolbar
        end={(
          <SegmentedControl
            ariaLabel="Time window"
            onChange={(value) => {
              setPeriod(value);
              setPage(1);
            }}
            options={WINDOWS}
            value={period}
          />
        )}
        filters={(
          <>
            <FilterChip label="Workspace" onChange={filterBy(setWorkspace)} options={workspaceOptions} value={workspace} />
            <FilterChip label="Area" onChange={filterBy(setArea)} options={areaOptions} value={area} />
            <FilterChip
              label="Result"
              onChange={filterBy(setResult)}
              options={[{ value: "success", label: "Succeeded" }, { value: "failure", label: "Failed" }]}
              value={result}
            />
            <ClearFilters active={filtersActive} onClear={clearFilters} />
          </>
        )}
        search={(
          <SearchInput
            ariaLabel="Search events"
            onChange={(value) => {
              setSearch(value);
              setPage(1);
            }}
            placeholder="Search events"
            value={search}
          />
        )}
      />
      {query.data?.truncated && (
        <Callout className="mb-3" tone="neutral">
          Showing the latest {events.length.toLocaleString()} events in this window. Search or pick a shorter window to see older ones.
        </Callout>
      )}
      <DataTable
        activeRowId={selected?.id ?? null}
        ariaLabel="Audit events"
        columns={columns}
        data={rows}
        emptyState={(
          <EmptyState
            description="Changes to workspaces, people and connectors appear here."
            icon={<Activity aria-hidden="true" />}
            title={search ? "No events match" : "No events recorded in this window"}
          />
        )}
        error={query.error}
        filtered={filtersActive}
        loading={!query.data && !query.error}
        onClearFilters={clearFilters}
        onRetry={query.reload}
        onRowClick={(event) => setOpenId(event.id)}
        pagination={rows.length > PAGE_SIZE ? { page, pageSize: PAGE_SIZE, total: rows.length, onPageChange: setPage } : undefined}
      />

      <Drawer
        description={selected ? formatDateTime(selected.created_at) : undefined}
        footer={selected?.workspace && canOpenWorkspaces ? (
          <ButtonLink href={`/platform/workspaces?workspace=${encodeURIComponent(selected.workspace.id)}`} iconAfter={<ArrowRight aria-hidden="true" />}>
            View workspace
          </ButtonLink>
        ) : undefined}
        onClose={() => setOpenId(null)}
        open={Boolean(selected)}
        title={selected ? describeAuditAction(selected.action, selected.details) : ""}
      >
        {selected && (
          <Facts
            items={[
              ["When", <span key="when">{formatDateTime(selected.created_at)} <span className="text-text-tertiary">· {formatRelative(selected.created_at)}</span></span>],
              ["Workspace", <WorkspaceCell key="workspace" workspace={selected.workspace ?? null} />],
              ["Person", (
                <span className="flex min-w-0 items-center gap-2" key="person">
                  <ActorAvatar actor={selected.actor} size="xs" />
                  <span className="min-w-0">
                    {auditActorName(selected.actor)}
                    {selected.actor.display_name && selected.actor.email && (
                      <span className="block truncate text-meta text-text-tertiary">{selected.actor.email}</span>
                    )}
                  </span>
                </span>
              )],
              ["Action", describeAuditAction(selected.action, selected.details)],
              ["Area", AREA_LABEL[auditActionArea(selected.action)]],
              ["Target", describeAuditTarget(selected)],
              ["Result", <StatusBadge key="result" kind="outcome" value={outcomeStatusKey(selected.outcome)} />],
              ["IP address", ipOf(selected) && <span className="font-mono text-meta" key="ip">{ipOf(selected)}</span>],
            ]}
          />
        )}
      </Drawer>
    </Page>
  );
}
