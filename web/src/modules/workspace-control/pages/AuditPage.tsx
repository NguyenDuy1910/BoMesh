"use client";

import { ScrollText } from "lucide-react";
import { useMemo, useState } from "react";

import { CommandBar, FilterTrigger } from "@/components/layout/CommandBar";
import { Avatar } from "@/components/ui/Avatar";
import { CellTitle, DataTable, type Column } from "@/components/ui/DataTable";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Tabs } from "@/components/ui/Tabs";
import {
  BarList,
  changeLabel,
  Metric,
  MetricLedger,
  Panel,
  PanelRow,
  TrendChart,
} from "@/modules/workspace-control/components/dashboard";
import { SectionHeader } from "@/modules/workspace-control/components/SectionHeader";
import { SessionLog } from "@/modules/workspace-control/components/SessionLog";
import {
  describeAuditAction,
  describeSignInMethod,
  formatDateTime,
  formatRelative,
  pluralize,
} from "@/modules/workspace-control/format";
import {
  workspaceDirectoryApi,
  type ActivityPerson,
  type ActivityWindow,
  type AuditEvent,
  type WorkspaceActivity,
} from "@/modules/workspace-control/directory";
import { useControlPlaneData } from "@/modules/workspace-control/queries";

const WINDOWS: { id: ActivityWindow; label: string }[] = [
  { id: "24h", label: "24 hours" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
];

const LOGS = [
  { id: "sign-ins", label: "Sign-ins" },
  { id: "changes", label: "Audit log" },
];

/**
 * Activity: is the workspace being used, who is in it, and what changed.
 *
 * The figures and charts answer the first two at a glance for the chosen
 * period; the two logs underneath are the records they are counted from, for
 * when a figure needs explaining.
 */
export function AuditPage() {
  const [period, setPeriod] = useState<ActivityWindow>("7d");
  const [log, setLog] = useState("sign-ins");
  const activity = useControlPlaneData(() => workspaceDirectoryApi.activity(period), period);

  return <>
    <SectionHeader
      actions={
        <Tabs
          activeTab={period}
          ariaLabel="Period"
          density="compact"
          onChange={(next) => setPeriod(next as ActivityWindow)}
          tabs={WINDOWS}
        />
      }
      section="activity"
    />
    {activity.error ? (
      <ErrorState description={activity.error} onAction={activity.reload} />
    ) : activity.data ? (
      <ActivityDashboard activity={activity.data} />
    ) : (
      <PageLoadingSkeleton label="Loading activity" />
    )}
    <section aria-label="Activity records" className="mt-[var(--section-gap)]">
      <Tabs activeTab={log} ariaLabel="Records" className="mb-[var(--space-3)]" onChange={setLog} tabs={LOGS} variant="underline" />
      {log === "sign-ins" ? <SessionLog /> : <ActivityTable platform={false} />}
    </section>
  </>;
}

function ActivityDashboard({ activity }: { activity: WorkspaceActivity }) {
  const { totals, previous, buckets } = activity;
  const span = WINDOWS.find((item) => item.id === activity.window)?.label ?? activity.window;
  const series = (key: keyof WorkspaceActivity["buckets"][number]) => buckets.map((bucket) => Number(bucket[key]));

  return (
    <div className="ctl-dashboard">
      <MetricLedger label={`Activity over the last ${span}`}>
        <Metric
          change={changeLabel(totals.active_users, previous.active_users, span)}
          label="Active people"
          trend={series("active_users")}
          value={totals.active_users}
        />
        <Metric
          change={changeLabel(totals.sign_ins, previous.sign_ins, span)}
          label="Sign-ins"
          trend={series("sign_ins")}
          value={totals.sign_ins}
        />
        <Metric
          change={changeLabel(totals.questions, previous.questions, span)}
          label="Questions asked"
          note={`in ${pluralize(totals.conversations, "new conversation")}`}
          trend={series("questions")}
          value={totals.questions}
        />
        <Metric
          change={changeLabel(totals.changes, previous.changes, span)}
          label="Admin changes"
          note={totals.failed_changes ? `${pluralize(totals.failed_changes, "change")} failed` : "None failed"}
          trend={series("changes")}
          value={totals.changes}
        />
      </MetricLedger>

      <PanelRow>
        <Panel aside={`Times in ${activity.timezone}`} title="Usage">
          <TrendChart
            bucket={activity.bucket}
            buckets={buckets}
            label={`Usage over the last ${span}`}
            series={[
              { key: "questions", label: "Questions", kind: "bar", tone: "muted" },
              { key: "sign_ins", label: "Sign-ins", kind: "line", tone: "ink" },
              { key: "active_users", label: "Active people", kind: "detail", tone: "ink" },
              { key: "changes", label: "Admin changes", kind: "detail", tone: "muted" },
            ]}
            timezone={activity.timezone}
          />
        </Panel>
        <Panel title="Signed in now">
          <div className="ctl-live">
            <span className="ctl-live__dot" data-idle={activity.live_sessions ? undefined : ""} />
            <span className="ctl-live__value">{activity.live_sessions.toLocaleString()}</span>
            <span className="ctl-muted">{activity.live_sessions === 1 ? "open session" : "open sessions"}</span>
          </div>
          <div>
            <h3 className="configuration-heading">How people signed in · {span}</h3>
            <BarList
              empty={`No sign-ins in the last ${span}.`}
              rows={activity.sign_in_methods.map((item) => ({
                key: item.method,
                label: describeSignInMethod(item.method),
                value: item.count,
              }))}
            />
          </div>
        </Panel>
      </PanelRow>

      <PanelRow layout="halves">
        <Panel aside={span} className="ctl-panel--flush" title="Most active people">
          <PeopleTable people={activity.people} span={span} />
        </Panel>
        <Panel aside={span} title="What changed">
          <BarList
            empty={`No administrative changes in the last ${span}.`}
            rows={activity.top_changes.map((item) => ({
              key: item.action,
              label: describeAuditAction(item.action),
              value: item.count,
              detail: item.failed ? `${pluralize(item.failed, "attempt")} failed` : undefined,
              tone: item.failed === item.count ? "danger" : "ink",
            }))}
          />
        </Panel>
      </PanelRow>
    </div>
  );
}

function PeopleTable({ people, span }: { people: ActivityPerson[]; span: string }) {
  const count = (value: number) => <span className="ctl-num" data-zero={value ? undefined : ""}>{value.toLocaleString()}</span>;
  const columns: Column<ActivityPerson>[] = [
    {
      key: "person",
      label: "Person",
      primary: true,
      render: (row) => {
        const name = row.display_name ?? row.email ?? "Unknown person";
        return <CellTitle icon={<Avatar name={name} size="sm" />} subtitle={row.display_name ? row.email : undefined} title={name} />;
      },
    },
    { key: "questions", label: "Questions", width: 96, align: "right", render: (row) => count(row.questions) },
    { key: "sign_ins", label: "Sign-ins", width: 88, align: "right", priority: "medium", render: (row) => count(row.sign_ins) },
    { key: "changes", label: "Changes", width: 88, align: "right", priority: "medium", render: (row) => count(row.changes) },
    {
      key: "last_active_at",
      label: "Last active",
      width: 110,
      priority: "low",
      render: (row) => <span title={formatDateTime(row.last_active_at)}>{formatRelative(row.last_active_at)}</span>,
    },
  ];
  return (
    <DataTable
      ariaLabel="Most active people"
      columns={columns}
      data={people}
      emptyState={<p className="ctl-muted py-[var(--space-4)]">Nobody signed in, asked or changed anything in the last {span}.</p>}
      getRowId={(row) => row.user_id}
    />
  );
}

/** Who did what, where, and how it went — from the durable audit trail. */
export function ActivityTable({ platform }: { platform: boolean }) {
  const [search, setSearch] = useState("");
  const events = useControlPlaneData(
    async () => (platform ? workspaceDirectoryApi.platform.audit(search) : workspaceDirectoryApi.auditLogs(search)),
    search,
  );
  const [outcome, setOutcome] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const items = useMemo(() => events.data?.items ?? [], [events.data]);
  const rows = useMemo(
    () => items.filter((row) =>
      (!outcome || row.outcome === outcome)
      && (!workspace || row.workspace?.id === workspace),
    ),
    [items, outcome, workspace],
  );
  const workspaces = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of items) {
      if (row.workspace) seen.set(row.workspace.id, row.workspace.name ?? row.workspace.id);
    }
    return [...seen.entries()];
  }, [items]);

  const actorOf = (row: AuditEvent) =>
    row.actor.display_name ?? row.actor.email ?? "System";

  const columns: Column<AuditEvent>[] = [
    {
      key: "actor",
      label: "Actor",
      primary: true,
      sortable: true,
      render: (row) => (
        <CellTitle
          icon={<Avatar name={actorOf(row)} size="sm" />}
          subtitle={row.actor.display_name ? row.actor.email : undefined}
          title={actorOf(row)}
        />
      ),
    },
    ...(platform
      ? [{
          key: "workspace",
          label: "Tenant",
          priority: "medium" as const,
          width: 160,
          render: (row: AuditEvent) => row.workspace?.name ?? "Platform",
        }]
      : []),
    { key: "action", label: "Activity", minWidth: 220, render: (row) => describeAuditAction(row.action) },
    {
      key: "outcome",
      label: "Outcome",
      width: 110,
      render: (row) => <StatusBadge status={row.outcome === "success" ? "success" : "failed"} />,
    },
    {
      key: "created_at",
      label: "When",
      width: 140,
      priority: "medium",
      render: (row) => <span title={formatDateTime(row.created_at)}>{formatRelative(row.created_at)}</span>,
    },
  ];

  if (events.error) return <ErrorState description={events.error} onAction={events.reload} />;
  if (!events.data) return <PageLoadingSkeleton controls label="Loading activity" />;

  const filtered = Boolean(search || outcome || workspace);

  return <>
    <CommandBar
      count={pluralize(rows.length, "event")}
      filters={<>
        {platform && (
          <FilterTrigger
            label="Filter by tenant"
            onChange={setWorkspace}
            options={[{ value: "", label: "All tenants" }, ...workspaces.map(([value, label]) => ({ value, label }))]}
            value={workspace}
          />
        )}
        <FilterTrigger
          label="Filter by outcome"
          onChange={setOutcome}
          options={[
            { value: "", label: "All outcomes" },
            { value: "success", label: "Success" },
            { value: "failure", label: "Failed" },
          ]}
          value={outcome}
        />
      </>}
      search={{ value: search, onChange: setSearch, placeholder: "Search activity…", label: "Search activity", debounceMs: 250 }}
    />
    <DataTable
      ariaLabel={platform ? "Platform activity" : "Workspace activity"}
      columns={columns}
      data={rows}
      emptyState={
        <EmptyState
          description={filtered ? "Try a different search or filter." : "Administrative changes and sync events appear here."}
          icon={<ScrollText size={20} />}
          size="sm"
          title={filtered ? "No matching activity" : "No activity yet"}
        />
      }
      onRowClick={setSelected}
    />
    <Dialog onClose={() => setSelected(null)} open={Boolean(selected)} title="Activity details">
      {selected && (
        <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-3 text-sm">
          <dt className="text-[var(--text-tertiary)]">Actor</dt><dd>{actorOf(selected)}</dd>
          <dt className="text-[var(--text-tertiary)]">Action</dt><dd className="font-mono text-xs">{selected.action}</dd>
          <dt className="text-[var(--text-tertiary)]">Resource</dt>
          <dd>{selected.resource_type}{selected.resource_id ? ` · ${selected.resource_id}` : ""}</dd>
          {platform && <>
            <dt className="text-[var(--text-tertiary)]">Tenant</dt>
            <dd>{selected.workspace ? selected.workspace.name ?? selected.workspace.id : "Platform"}</dd>
          </>}
          <dt className="text-[var(--text-tertiary)]">Outcome</dt>
          <dd><StatusBadge status={selected.outcome === "success" ? "success" : "failed"} /></dd>
          <dt className="text-[var(--text-tertiary)]">Recorded</dt><dd>{formatDateTime(selected.created_at)}</dd>
          <dt className="text-[var(--text-tertiary)]">Event ID</dt><dd className="font-mono text-xs">{selected.id}</dd>
        </dl>
      )}
    </Dialog>
  </>;
}
