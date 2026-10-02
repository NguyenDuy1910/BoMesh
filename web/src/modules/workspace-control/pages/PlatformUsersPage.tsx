"use client";

import { Users } from "lucide-react";
import { useState } from "react";

import { CommandBar, FilterTrigger } from "@/components/layout/CommandBar";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { CellTitle, DataTable, type Column } from "@/components/ui/DataTable";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { SectionHeader } from "@/modules/workspace-control/components/SectionHeader";
import { workspaceDirectoryApi, memberName, memberStatus, roleNames, type Member } from "@/modules/workspace-control/directory";
import { pluralize } from "@/modules/workspace-control/format";
import { useControlPlaneData } from "@/modules/workspace-control/queries";

/**
 * Identities across every workspace.
 *
 * Suspending someone is a workspace-scoped action, so it stays in that
 * workspace's Access screen rather than being offered here where it would
 * silently apply to only one of their memberships.
 */
export function PlatformUsersPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const users = useControlPlaneData(() => workspaceDirectoryApi.platform.users(search), search);
  const [selected, setSelected] = useState<Member | null>(null);
  const rows = (users.data?.items ?? []).filter(
    (row) => !status || memberStatus(row) === status,
  );
  const filtered = Boolean(search || status);

  /* Columns show only what `GET /platform/users` (OpenAPI `UserPage`) returns:
     identity, roles, groups and status. Workspace memberships are not part of
     that record, so they are not guessed at here. */
  const columns: Column<Member>[] = [
    {
      key: "email",
      label: "User",
      primary: true,
      sortable: true,
      render: (row) => (
        <CellTitle icon={<Avatar name={memberName(row)} size="md" />} subtitle={row.email} title={memberName(row)} />
      ),
    },
    { key: "roles", label: "Roles", priority: "medium", render: (row) => roleNames(row) || "—" },
    {
      key: "groups",
      label: "Groups",
      priority: "low",
      render: (row) => row.groups.map((group) => group.display_name).join(", ") || "—",
    },
    {
      key: "status",
      label: "Status",
      width: 110,
      render: (row) => <StatusBadge status={memberStatus(row)} />,
    },
  ];

  return <>
    <SectionHeader section="platform-users" />
    {users.error ? (
      <ErrorState description={users.error} onAction={users.reload} />
    ) : !users.data ? (
      <PageLoadingSkeleton controls label="Loading users" />
    ) : <>
      <CommandBar
        count={pluralize(rows.length, "user")}
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
        search={{ value: search, onChange: setSearch, placeholder: "Search users…", label: "Search platform users", debounceMs: 250 }}
      />
      <DataTable
        ariaLabel="Platform users"
        columns={columns}
        data={rows}
        emptyState={
          <EmptyState
            description={filtered ? "Try a different search or status." : "People appear here once they have an account."}
            icon={<Users size={20} />}
            size="sm"
            title={filtered ? "No matching users" : "No users yet"}
          />
        }
        onRowClick={setSelected}
      />
    </>}
    <Dialog
      footer={<Button onClick={() => setSelected(null)} variant="secondary">Close</Button>}
      onClose={() => setSelected(null)}
      open={Boolean(selected)}
      title={selected ? memberName(selected) : ""}
    >
      {selected && <>
        <div className="flex items-center gap-3">
          <Avatar name={memberName(selected)} size="lg" />
          <div>
            <p className="font-medium">{memberName(selected)}</p>
            <p className="text-sm text-[var(--text-secondary)]">{selected.email}</p>
          </div>
        </div>
        <dl className="mt-5 grid grid-cols-[8rem_1fr] gap-x-4 gap-y-3 text-sm">
          <dt className="text-[var(--text-tertiary)]">Roles</dt>
          <dd>{roleNames(selected) || "None"}</dd>
          <dt className="text-[var(--text-tertiary)]">Groups</dt>
          <dd>{selected.groups.map((group) => group.display_name).join(", ") || "None"}</dd>
          <dt className="text-[var(--text-tertiary)]">Status</dt>
          <dd><StatusBadge status={memberStatus(selected)} /></dd>
          <dt className="text-[var(--text-tertiary)]">User ID</dt>
          <dd className="font-mono text-xs">{selected.id}</dd>
        </dl>
      </>}
    </Dialog>
  </>;
}
