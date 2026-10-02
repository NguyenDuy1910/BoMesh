"use client";

import { Building2 } from "lucide-react";
import { useState } from "react";

import { CommandBar, FilterTrigger } from "@/components/layout/CommandBar";
import { Button } from "@/components/ui/Button";
import { CellTitle, DataTable, type Column } from "@/components/ui/DataTable";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { SectionHeader } from "@/modules/workspace-control/components/SectionHeader";
import { formatDateTime, pluralize } from "@/modules/workspace-control/format";
import { workspaceDirectoryApi, type WorkspaceHealth } from "@/modules/workspace-control/directory";
import { useControlPlaneData } from "@/modules/workspace-control/queries";

/**
 * Every tenant on the platform, with the administrator behind it.
 *
 * Creating and suspending a tenant are not exposed by the API yet, so this
 * screen reports rather than acts: a button that could not complete would be
 * worse than none.
 */
export function PlatformTenantsPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const query = useControlPlaneData(() => workspaceDirectoryApi.platform.workspaces(search), search);
  const [selected, setSelected] = useState<WorkspaceHealth | null>(null);
  const rows = (query.data?.items ?? []).filter((row) => !status || row.status === status);
  const filtered = Boolean(search || status);

  const columns: Column<WorkspaceHealth>[] = [
    {
      key: "name",
      label: "Tenant",
      primary: true,
      sortable: true,
      render: (row) => <CellTitle subtitle={row.code} title={row.name} />,
    },
    {
      key: "owner",
      label: "Administrator",
      priority: "medium",
      render: (row) => row.owner ? row.owner.display_name ?? row.owner.email : "None assigned",
    },
    { key: "member_count", label: "Members", width: 100, align: "right" },
    { key: "connection_count", label: "Connected accounts", width: 160, align: "right", priority: "low" },
    { key: "status", label: "Status", width: 110, render: (row) => <StatusBadge status={row.status} /> },
  ];

  return <>
    <SectionHeader section="platform-tenants" />
    {query.error ? (
      <ErrorState description={query.error} onAction={query.reload} />
    ) : !query.data ? (
      <PageLoadingSkeleton controls label="Loading tenants" />
    ) : <>
      <CommandBar
        count={pluralize(rows.length, "tenant")}
        filters={
          <FilterTrigger
            label="Filter by status"
            onChange={setStatus}
            options={[
              { value: "", label: "All statuses" },
              { value: "active", label: "Active" },
              { value: "suspended", label: "Suspended" },
            ]}
            value={status}
          />
        }
        search={{ value: search, onChange: setSearch, placeholder: "Search tenants…", label: "Search tenants", debounceMs: 250 }}
      />
      <DataTable
        ariaLabel="Platform tenants"
        columns={columns}
        data={rows}
        emptyState={
          <EmptyState
            description={filtered ? "Try a different search or status." : "Tenants appear here once they are created."}
            icon={<Building2 size={20} />}
            size="sm"
            title={filtered ? "No matching tenants" : "No tenants yet"}
          />
        }
        onRowClick={setSelected}
      />
    </>}
    <Dialog
      footer={<Button onClick={() => setSelected(null)} variant="secondary">Close</Button>}
      onClose={() => setSelected(null)}
      open={Boolean(selected)}
      title={selected?.name ?? ""}
    >
      {selected && (
        <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-3 text-sm">
          <dt className="text-[var(--text-tertiary)]">Code</dt><dd>{selected.code}</dd>
          <dt className="text-[var(--text-tertiary)]">Administrator</dt>
          <dd>{selected.owner ? `${selected.owner.display_name ?? "—"} · ${selected.owner.email}` : "None assigned"}</dd>
          <dt className="text-[var(--text-tertiary)]">Members</dt><dd>{selected.member_count}</dd>
          <dt className="text-[var(--text-tertiary)]">Connected accounts</dt><dd>{selected.connection_count}</dd>
          <dt className="text-[var(--text-tertiary)]">Status</dt><dd><StatusBadge status={selected.status} /></dd>
          <dt className="text-[var(--text-tertiary)]">Created</dt><dd>{formatDateTime(selected.created_at)}</dd>
          <dt className="text-[var(--text-tertiary)]">Tenant ID</dt>
          <dd className="font-mono text-xs">{selected.id}</dd>
        </dl>
      )}
    </Dialog>
  </>;
}
