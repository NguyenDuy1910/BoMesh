"use client";

import { Activity, Download, KeyRound } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { Page } from "@/components/shell/Page";
import { RequirePermission } from "@/components/shell/RequirePermission";
import { useCurrentWorkspace } from "@/components/shell/useCurrentWorkspace";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { ClearFilters, FilterChip } from "@/components/ui/FilterChip";
import { PageHeader } from "@/components/ui/PageHeader";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { SearchInput } from "@/components/ui/SearchInput";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Tabs } from "@/components/ui/Tabs";
import { useToast } from "@/components/ui/Toast";
import { Toolbar } from "@/components/ui/Toolbar";
import { describeRequestFailure } from "@/lib/api/errors";
import { usePendingFeature } from "@/lib/api/pending";
import { hasSessionPermission } from "@/lib/auth/session";
import { outcomeStatusKey, sessionStatusKey } from "@/lib/status";
import type { AccessSessionRecord, ActivityWindow, AuditEvent } from "@/modules/manage/access/directory";
import { ActorAvatar } from "@/modules/manage/activity/Actor";
import { ACTIVITY_WINDOW_MS, auditEventsSince, signInsSince } from "@/modules/manage/activity/activity-log";
import { exportAuditLogs } from "@/modules/manage/activity/api";
import {
  AUDIT_AREAS,
  auditActorName,
  auditEventMatches,
  describeAuditAction,
  describeAuditTarget,
  describeSignInMethod,
  type AuditArea,
} from "@/modules/manage/activity/audit-actions";
import { EventDrawer } from "@/modules/manage/activity/EventDrawer";
import { formatDateTime, formatRelative, pluralize } from "@/lib/format";
import { useApiData } from "@/lib/hooks/useApiData";

const TABS = [
  { id: "changes", label: "Changes" },
  { id: "signins", label: "Sign-ins" },
] as const;
type ActivityTab = (typeof TABS)[number]["id"];

const WINDOWS: readonly { value: ActivityWindow; label: string }[] = [
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

/** Every filter lives in the query string, so a filtered view can be linked to. */
const FILTER_KEYS = ["q", "person", "area", "outcome", "method", "status"] as const;

const PAGE_SIZE = 12;

/** Everything is loaded for the longest window once; shorter windows filter it. */
const LOADED_SPAN = ACTIVITY_WINDOW_MS["30d"];

function useQuery() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const set = (patch: Record<string, string | null>) => {
    // The live address, not this render's snapshot: two quick changes must not undo each other.
    const next = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    router.replace(next.size ? `${pathname}?${next}` : pathname, { scroll: false });
  };
  return { get: (key: string) => params.get(key) ?? "", set };
}

export function ActivityPage() {
  return (
    <RequirePermission anyOf={["audit.read"]}>
      <ActivityScreen />
    </RequirePermission>
  );
}

function ActivityScreen() {
  const { workspace, session } = useCurrentWorkspace();
  const query = useQuery();
  const toast = useToast();
  const exportEnabled = usePendingFeature("audit.export");
  const [exporting, setExporting] = useState(false);
  const tab: ActivityTab = query.get("tab") === "signins" ? "signins" : "changes";
  const windowValue = query.get("window");
  const activityWindow: ActivityWindow = WINDOWS.some((option) => option.value === windowValue) ? (windowValue as ActivityWindow) : "30d";
  const since = useMemo(() => Date.now() - ACTIVITY_WINDOW_MS[activityWindow], [activityWindow]);

  const filters = {
    actor: query.get("person"),
    area: query.get("area") as AuditArea | "",
    outcome: query.get("outcome") as "success" | "failure" | "",
    search: query.get("q"),
  };

  async function exportChanges() {
    if (!workspace) return;
    setExporting(true);
    try {
      const blob = await exportAuditLogs({ format: "csv", window: activityWindow, ...filters });
      const rows = Math.max(0, (await blob.text()).trimEnd().split("\r\n").length - 1);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      // The reader's own calendar day; `en-CA` writes it as YYYY-MM-DD.
      link.download = `activity-${workspace.code}-${new Date().toLocaleDateString("en-CA")}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      toast.show({ message: `Exported ${pluralize(rows, "event")}` });
    } catch (cause) {
      toast.show({ tone: "err", message: describeRequestFailure(cause, "Exporting the activity") });
    } finally {
      setExporting(false);
    }
  }

  return (
    <Page>
      <PageHeader
        actions={tab === "changes" && exportEnabled ? (
          <span className="flex items-center gap-2">
            <PreviewTag />
            <Button icon={<Download aria-hidden="true" />} loading={exporting} onClick={() => void exportChanges()} variant="secondary">
              Export CSV
            </Button>
          </span>
        ) : undefined}
        sub="Who changed what in this workspace, and who signed in."
        title="Activity"
      />
      <Tabs
        activeTab={tab}
        ariaLabel="Activity records"
        className="mb-5"
        onChange={(next) =>
          // Filters belong to one record type; the window and the person carry over.
          query.set({ tab: next === "changes" ? null : next, ...Object.fromEntries(FILTER_KEYS.filter((key) => key !== "person").map((key) => [key, null])), event: null })
        }
        tabs={TABS}
      />
      {tab === "changes" ? (
        <ChangesTab
          activityWindow={activityWindow}
          filters={filters}
          onFilter={(patch) => query.set(patch)}
          onOpen={(eventId) => query.set({ event: eventId })}
          openEventId={query.get("event")}
          since={since}
          workspaceId={workspace?.id ?? ""}
        />
      ) : (
        <SignInsTab
          activityWindow={activityWindow}
          canOpenMembers={hasSessionPermission(session, "user.manage")}
          method={query.get("method")}
          onFilter={(patch) => query.set(patch)}
          person={query.get("person")}
          search={query.get("q")}
          since={since}
          status={query.get("status")}
          workspaceId={workspace?.id ?? ""}
        />
      )}
    </Page>
  );
}

function WindowControl({ value, onChange }: { value: ActivityWindow; onChange: (value: ActivityWindow) => void }) {
  return <SegmentedControl ariaLabel="Time window" onChange={onChange} options={WINDOWS} size="sm" value={value} />;
}

function ChangesTab({
  workspaceId,
  activityWindow,
  since,
  filters,
  onFilter,
  openEventId,
  onOpen,
}: {
  workspaceId: string;
  activityWindow: ActivityWindow;
  since: number;
  filters: { actor: string; area: AuditArea | ""; outcome: "success" | "failure" | ""; search: string };
  onFilter: (patch: Record<string, string | null>) => void;
  openEventId: string;
  onOpen: (eventId: string | null) => void;
}) {
  const events = useApiData(() => auditEventsSince(Date.now() - LOADED_SPAN), workspaceId);
  const [page, setPage] = useState(1);
  const all = events.data?.rows ?? [];
  const inWindow = all.filter((event) => Date.parse(event.created_at ?? "") >= since);
  const rows = inWindow.filter((event) => auditEventMatches(event, filters));
  const filtered = Boolean(filters.actor || filters.area || filters.outcome || filters.search.trim());
  // Capped reads stop early; say so when the window reaches past what was read.
  const oldestRead = all.length ? Date.parse(all[all.length - 1].created_at ?? "") : Infinity;
  const partial = Boolean(events.data?.truncated) && oldestRead > since;

  const peopleById = new Map<string, string>();
  for (const event of all) peopleById.set(event.actor.id ?? "system", auditActorName(event.actor));
  const people = [...peopleById].map(([value, label]) => ({ value, label })).sort((left, right) => left.label.localeCompare(right.label));

  const filter = (patch: Record<string, string | null>) => {
    setPage(1);
    onFilter(patch);
  };
  const clear = () => filter({ person: null, area: null, outcome: null, q: null, window: null });

  const columns: DataTableColumn<AuditEvent>[] = [
    {
      id: "when",
      header: "When",
      width: 120,
      sortable: true,
      sortValue: (event) => event.created_at ?? "",
      cell: (event) => (
        <time className="whitespace-nowrap text-text-secondary" dateTime={event.created_at ?? undefined} title={formatDateTime(event.created_at)}>
          {formatRelative(event.created_at)}
        </time>
      ),
    },
    {
      id: "person",
      header: "Person",
      sortable: true,
      sortValue: (event) => auditActorName(event.actor).toLowerCase(),
      minWidth: 160,
      cell: (event) => (
        <span className="flex min-w-0 items-center gap-2">
          <ActorAvatar actor={event.actor} size="sm" />
          <span className="truncate">{auditActorName(event.actor)}</span>
        </span>
      ),
    },
    { id: "action", header: "Action", minWidth: 220, cell: (event) => describeAuditAction(event.action, event.details) },
    {
      id: "target",
      header: "Target",
      hideBelow: 900,
      cell: (event) => <span className="block max-w-[260px] truncate text-text-secondary">{describeAuditTarget(event)}</span>,
    },
    {
      id: "result",
      header: <span className="sr-only">Result</span>,
      align: "right",
      width: 110,
      cell: (event) => (event.outcome === "success" ? null : <StatusBadge kind="outcome" value={outcomeStatusKey(event.outcome)} />),
    },
  ];

  const openEvent = openEventId ? all.find((event) => event.id === openEventId) ?? null : null;

  return (
    <>
      <Toolbar
        end={events.data && <span className="text-meta tabular-nums text-text-tertiary">{pluralize(rows.length, "event")}</span>}
        filters={
          <>
            <FilterChip
              label="Area"
              onChange={(area) => filter({ area })}
              options={AUDIT_AREAS}
              value={filters.area}
            />
            <FilterChip label="Person" onChange={(person) => filter({ person })} options={people} value={filters.actor} />
            <FilterChip
              label="Result"
              onChange={(outcome) => filter({ outcome })}
              options={[{ value: "success", label: "Succeeded" }, { value: "failure", label: "Failed" }]}
              value={filters.outcome}
            />
            <ClearFilters active={filtered} onClear={clear} />
          </>
        }
        search={
          <span className="flex flex-wrap items-center gap-2 min-[861px]:flex-nowrap">
            <WindowControl onChange={(value) => filter({ window: value === "30d" ? null : value })} value={activityWindow} />
            <SearchInput
              ariaLabel="Search activity"
              className="min-w-[200px] flex-1"
              debounceMs={200}
              onChange={(q) => filter({ q })}
              placeholder="Search activity"
              size="sm"
              value={filters.search}
            />
          </span>
        }
        searchClassName="min-[861px]:w-auto"
      />
      {partial && (
        <Callout className="mb-3" tone="info">
          Showing the latest {pluralize(all.length, "change")}. Export CSV to get every change in this window.
        </Callout>
      )}
      <DataTable
        activeRowId={openEvent?.id ?? null}
        ariaLabel="Workspace changes"
        columns={columns}
        compact
        data={rows}
        emptyState={(
          <EmptyState
            boxed
            description="Changes to knowledge, sources, people and settings will appear here."
            icon={<Activity aria-hidden="true" />}
            title={activityWindow === "30d" ? "No activity yet" : "No activity in this window"}
          />
        )}
        error={events.error}
        filtered={filtered}
        loading={!events.data && !events.error}
        onClearFilters={clear}
        onRetry={events.reload}
        onRowClick={(event) => onOpen(event.id)}
        pagination={{ page, pageSize: PAGE_SIZE, total: rows.length, onPageChange: setPage }}
      />
      {(openEvent || (openEventId && events.data)) && (
        <EventDrawer event={openEvent} missing={Boolean(openEventId)} onClose={() => onOpen(null)} />
      )}
    </>
  );
}

function SignInsTab({
  workspaceId,
  activityWindow,
  since,
  person,
  method,
  status,
  search,
  onFilter,
  canOpenMembers,
}: {
  workspaceId: string;
  activityWindow: ActivityWindow;
  since: number;
  person: string;
  method: string;
  status: string;
  search: string;
  onFilter: (patch: Record<string, string | null>) => void;
  canOpenMembers: boolean;
}) {
  const router = useRouter();
  const sessions = useApiData(() => signInsSince(Date.now() - LOADED_SPAN), workspaceId);
  const [page, setPage] = useState(1);
  const all = sessions.data?.rows ?? [];
  const name = (session: AccessSessionRecord) => session.user.display_name?.trim() || session.user.email || "Someone";
  const term = search.trim().toLowerCase();
  const rows = all.filter((session) => {
    if (Date.parse(session.started_at) < since) return false;
    if (person && session.user.id !== person) return false;
    if (method && describeSignInMethod(session.authentication_method) !== method) return false;
    if (status && sessionStatusKey(session.status) !== status) return false;
    if (!term) return true;
    return [name(session), session.user.email ?? "", describeSignInMethod(session.authentication_method)]
      .some((text) => text.toLowerCase().includes(term));
  });
  const filtered = Boolean(person || method || status || term);
  const oldestRead = all.length ? Date.parse(all[all.length - 1].started_at) : Infinity;
  const partial = Boolean(sessions.data?.truncated) && oldestRead > since;

  const peopleById = new Map<string, string>();
  for (const session of all) peopleById.set(session.user.id, name(session));
  const people = [...peopleById].map(([value, label]) => ({ value, label })).sort((left, right) => left.label.localeCompare(right.label));
  const methods = [...new Set(all.map((session) => describeSignInMethod(session.authentication_method)))]
    .sort()
    .map((label) => ({ value: label, label }));

  const filter = (patch: Record<string, string | null>) => {
    setPage(1);
    onFilter(patch);
  };
  const clear = () => filter({ person: null, method: null, status: null, q: null, window: null });

  const columns: DataTableColumn<AccessSessionRecord>[] = [
    {
      id: "person",
      header: "Person",
      sortable: true,
      sortValue: (session) => name(session).toLowerCase(),
      minWidth: 180,
      cell: (session) => (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar name={name(session)} size="sm" />
          <span className="truncate font-medium">{name(session)}</span>
          {session.current && <span className="shrink-0 text-caption text-text-tertiary">(you, now)</span>}
        </span>
      ),
    },
    {
      id: "method",
      header: "Method",
      cell: (session) => (
        <span className="text-text-secondary">
          {describeSignInMethod(session.authentication_method)}
          {session.entry === "workspace_switch" && (
            <span className="block text-caption text-text-tertiary">Switched from another workspace</span>
          )}
        </span>
      ),
    },
    {
      id: "signed-in",
      header: "Signed in",
      sortable: true,
      sortValue: (session) => session.started_at,
      cell: (session) => (
        <time className="whitespace-nowrap text-text-secondary" dateTime={session.started_at} title={formatDateTime(session.started_at)}>
          {formatRelative(session.started_at)}
        </time>
      ),
    },
    {
      id: "last-seen",
      header: "Last seen",
      hideBelow: 1080,
      cell: (session) => (
        <span className="whitespace-nowrap text-text-secondary" title={formatDateTime(session.last_seen_at ?? session.ended_at)}>
          {formatRelative(session.last_seen_at ?? session.ended_at, "—")}
        </span>
      ),
    },
    { id: "status", header: "Status", width: 130, cell: (session) => <StatusBadge kind="session" value={sessionStatusKey(session.status)} /> },
  ];

  return (
    <>
      <Toolbar
        end={sessions.data && <span className="text-meta tabular-nums text-text-tertiary">{pluralize(rows.length, "sign-in")}</span>}
        filters={
          <>
            <FilterChip label="Person" onChange={(value) => filter({ person: value })} options={people} value={person} />
            <FilterChip label="Method" onChange={(value) => filter({ method: value })} options={methods} value={method} />
            <FilterChip
              label="Status"
              onChange={(value) => filter({ status: value })}
              options={[{ value: "active", label: "Active now" }, { value: "ended", label: "Ended" }]}
              value={status}
            />
            <ClearFilters active={filtered} onClear={clear} />
          </>
        }
        search={
          <span className="flex flex-wrap items-center gap-2 min-[861px]:flex-nowrap">
            <WindowControl onChange={(value) => filter({ window: value === "30d" ? null : value })} value={activityWindow} />
            <SearchInput
              ariaLabel="Search sign-ins"
              className="min-w-[200px] flex-1"
              debounceMs={200}
              onChange={(q) => filter({ q })}
              placeholder="Search sign-ins"
              size="sm"
              value={search}
            />
          </span>
        }
        searchClassName="min-[861px]:w-auto"
      />
      {partial && (
        <Callout className="mb-3" tone="info">Showing the latest {pluralize(all.length, "sign-in")}.</Callout>
      )}
      <DataTable
        ariaLabel="Sign-ins"
        columns={columns}
        compact
        data={rows}
        emptyState={(
          <EmptyState
            boxed
            description="Each time someone signs in to this workspace, it appears here."
            icon={<KeyRound aria-hidden="true" />}
            title={activityWindow === "30d" ? "No sign-ins yet" : "No sign-ins in this window"}
          />
        )}
        error={sessions.error}
        filtered={filtered}
        loading={!sessions.data && !sessions.error}
        onClearFilters={clear}
        onRetry={sessions.reload}
        onRowClick={canOpenMembers
          ? (session) => router.push(`/manage/access?tab=members&member=${encodeURIComponent(session.user.id)}`)
          : undefined}
        pagination={{ page, pageSize: PAGE_SIZE, total: rows.length, onPageChange: setPage }}
      />
    </>
  );
}
