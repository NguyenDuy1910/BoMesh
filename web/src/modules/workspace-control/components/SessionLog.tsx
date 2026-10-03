"use client";

import { KeyRound } from "lucide-react";
import { useState } from "react";

import { CommandBar, FilterTrigger } from "@/components/layout/CommandBar";
import { Avatar } from "@/components/ui/Avatar";
import { CellTitle, DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import { StatusBadge, type StatusVocabulary } from "@/components/ui/StatusBadge";
import { workspaceDirectoryApi, type AccessSessionRecord } from "@/modules/workspace-control/directory";
import {
  describeSignInMethod,
  formatDateTime,
  formatRelative,
  formatSpan,
} from "@/modules/workspace-control/format";
import { useControlPlaneData } from "@/modules/workspace-control/queries";

/** What each session state means to the person reading the log. */
const SESSION_STATUS: StatusVocabulary = {
  active: { label: "Signed in", tone: "success" },
  expired: { label: "Expired", tone: "neutral" },
  revoked: { label: "Signed out", tone: "neutral" },
  superseded: { label: "Replaced", tone: "neutral" },
};

const personOf = (row: AccessSessionRecord) => row.user.display_name ?? row.user.email ?? "Unknown person";

/**
 * Every time someone entered this workspace, newest first: how they signed
 * in, how long they stayed, and whether they are still here. Switching in
 * from another workspace is an entry too, and says so.
 */
export function SessionLog() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"" | "active" | "ended">("");
  const sessions = useControlPlaneData(
    () => workspaceDirectoryApi.accessSessions({ search, status }),
    `${search}:${status}`,
  );

  const columns: Column<AccessSessionRecord>[] = [
    {
      key: "person",
      label: "Person",
      primary: true,
      render: (row) => (
        <CellTitle
          icon={<Avatar name={personOf(row)} size="sm" />}
          subtitle={row.current ? "This session — you" : row.user.display_name ? row.user.email : undefined}
          title={personOf(row)}
        />
      ),
    },
    {
      key: "method",
      label: "Signed in with",
      width: 190,
      priority: "medium",
      render: (row) => (
        <span>
          {describeSignInMethod(row.authentication_method)}
          {row.entry === "workspace_switch" && (
            <span className="block text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">Switched from another workspace</span>
          )}
        </span>
      ),
    },
    {
      key: "started_at",
      label: "Started",
      width: 130,
      render: (row) => <span title={formatDateTime(row.started_at)}>{formatRelative(row.started_at)}</span>,
    },
    {
      key: "last_seen_at",
      label: "Last seen",
      width: 130,
      priority: "medium",
      render: (row) => (
        <span title={formatDateTime(row.last_seen_at ?? row.started_at)}>
          {formatRelative(row.ended_at ?? row.last_seen_at ?? row.started_at)}
        </span>
      ),
    },
    {
      key: "duration",
      label: "Duration",
      width: 120,
      align: "right",
      priority: "low",
      render: (row) => {
        const end = row.ended_at ?? (row.status === "active" ? new Date().toISOString() : row.last_seen_at ?? row.started_at);
        return <span className="ctl-num">{formatSpan(Date.parse(end) - Date.parse(row.started_at))}</span>;
      },
    },
    {
      key: "status",
      label: "Status",
      width: 120,
      render: (row) => <StatusBadge status={row.status} vocabulary={SESSION_STATUS} />,
    },
  ];

  if (sessions.error) return <ErrorState description={sessions.error} onAction={sessions.reload} />;
  if (!sessions.data) return <PageLoadingSkeleton controls label="Loading sign-ins" />;

  const { items, total } = sessions.data;
  const filtered = Boolean(search || status);
  return <>
    <CommandBar
      count={items.length < total ? `Latest ${items.length.toLocaleString()} of ${total.toLocaleString()}` : `${total.toLocaleString()} sign-ins`}
      filters={
        <FilterTrigger
          label="Filter by status"
          onChange={(value) => setStatus(value as typeof status)}
          options={[
            { value: "", label: "All sessions" },
            { value: "active", label: "Signed in now" },
            { value: "ended", label: "Ended" },
          ]}
          value={status}
        />
      }
      search={{ value: search, onChange: setSearch, placeholder: "Search people…", label: "Search sign-ins by person", debounceMs: 250 }}
    />
    <DataTable
      ariaLabel="Sign-ins"
      columns={columns}
      data={items}
      emptyState={
        <EmptyState
          description={filtered ? "Try a different search or filter." : "Each time someone signs in to this workspace it is listed here."}
          icon={<KeyRound size={20} />}
          size="sm"
          title={filtered ? "No matching sign-ins" : "No sign-ins yet"}
        />
      }
    />
  </>;
}
