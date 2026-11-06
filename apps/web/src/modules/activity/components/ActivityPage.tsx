"use client";

import { Button } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowRight, Download, KeyRound, Search, Zap } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { PageChrome } from "@/components/shell/page-chrome";
import {
  ClearFilters,
  DataTable,
  EmptyState,
  FilterButton,
  Gate,
  KeyValue,
  Page,
  PageHeader,
  Pager,
  SearchInput,
  SectionTabs,
  Segmented,
  SkeletonRows,
  StatusChip,
  UserAvatar,
  paginate,
  toast,
  type DataTableColumn,
} from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural, rel } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { useKnowledgeBases } from "@/modules/knowledge/queries";
import { SideDrawer } from "@/modules/people/components/SideDrawer";
import { useGroupsQuery, useMembersQuery, useRolesQuery } from "@/modules/people/queries";
import { useSpaces } from "@/modules/spaces";
import type { Member } from "@/modules/people/api";

import { exportAuditEvents, getAuditEvent, listAuditEvents, summarizeAuditEvents, type AuditEvent } from "../api";
import { AREAS, WINDOWS, areaLabel, auditFilter, describeAction, targetOf, type Window } from "../model";

const PAGE = 15;
const SYSTEM = "system";

const full = (ts: string | undefined) =>
  ts ? new Date(ts).toLocaleString(document.documentElement.lang || "en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

function ActorAvatar({ actor, name, size = "sm" }: { actor?: string; name: string; size?: "xs" | "sm" | "lg" }) {
  if (actor === SYSTEM)
    return (
      <span className={`user-avatar user-avatar--${size} act-sys`} style={{ display: "inline-grid", placeItems: "center", borderRadius: 9999, background: "var(--default)" }} aria-hidden>
        <Zap className="i i-xs" />
      </span>
    );
  return <UserAvatar name={name} size={size} />;
}

interface Names {
  /** Display name of `users/{id}` or `system`. */
  actor: (actor: string | undefined) => string;
  /** Product words for a target resource name. */
  target: (name: string | undefined) => string;
  isBase: (itemId: string) => boolean;
  members: Member[];
}

/** Names for actors and targets from the workspace directory (members, groups, roles, spaces, knowledge bases). */
function useNames(): Names {
  const { workspace } = useWorkspace();
  const members = useMembersQuery();
  const groups = useGroupsQuery();
  const roles = useRolesQuery();
  const spaces = useSpaces();
  const bases = useKnowledgeBases({ showLocked: true });
  return useMemo(() => {
    const people = new Map((members.data ?? []).map((m) => [resourceId(m.user), m.displayName || m.email || "Someone"]));
    const actor = (a: string | undefined) => (a === SYSTEM ? "BoMesh" : (people.get(resourceId(a)) ?? "Former member"));
    const target = (name: string | undefined): string => {
      const { kind, id } = targetOf(name);
      switch (kind) {
        case "member":
        case "user":
          return people.get(id) ?? "A person";
        case "group":
          return groups.data?.find((g) => resourceId(g.name) === id)?.displayName ?? "A group";
        case "role":
          return roles.data?.find((r) => resourceId(r.name) === id)?.label ?? "A role";
        case "space":
          return spaces.data?.find((s) => resourceId(s.name) === id)?.displayName ?? "A space";
        case "item":
          return bases.data?.find((b) => resourceId(b.name) === id)?.displayName ?? "A document or folder";
        case "settings":
          return "Workspace setup";
        case "assistant":
          return "Assistant setup";
        case "workspace":
          return workspace.displayName;
        case "session":
          return "Sign-in";
        case "source":
          return "A source";
        case "connection":
          return "A connected account";
        case "request":
          return "A request";
        case "topic":
          return "A topic";
        case "contribution":
          return "A contribution";
        case "readingList":
          return "A collection";
        default:
          return "—";
      }
    };
    const isBase = (id: string) => Boolean(bases.data?.some((b) => resourceId(b.name) === id));
    return { actor, target, isBase, members: members.data ?? [] };
  }, [members.data, groups.data, roles.data, spaces.data, bases.data, workspace.displayName]);
}

/** Where an event's target can be opened now (preview `related`). */
function related(ev: AuditEvent, names: Names, canPeople: boolean): { label: string; href: string } | null {
  const { kind, id } = targetOf(ev.target);
  const label = names.target(ev.target);
  if (ev.category === "SIGN_IN") return { label: "View sign-ins", href: "/activity?tab=signins" };
  switch (kind) {
    case "member":
    case "user":
      return canPeople && names.members.some((m) => resourceId(m.user) === id) ? { label: `View ${label}`, href: `/people?tab=members&open=${id}` } : null;
    case "group":
      return canPeople ? { label: `Open ${label}`, href: `/people?tab=groups&open=${id}` } : null;
    case "role":
      return canPeople ? { label: `Open ${label}`, href: `/people?tab=roles&role=${id}` } : null;
    case "item":
      return names.isBase(id) ? { label: `Open ${label}`, href: `/knowledge/${id}` } : { label: "Open document", href: `/doc/${id}` };
    case "space":
      return { label: `Open ${label}`, href: `/space/${id}` };
    case "source":
      return { label: "Open sources", href: `/sources?open=${id}` };
    case "connection":
      return { label: "Open connections", href: "/connections" };
    case "settings":
      return { label: "Open settings", href: "/settings?tab=setup" };
    case "workspace":
      return { label: "Open settings", href: "/settings" };
    case "assistant":
      return { label: "Open assistant", href: "/assistant" };
    case "request":
      return ev.category === "PEOPLE" || ev.category === "KNOWLEDGE" ? { label: "Open access requests", href: "/people?tab=requests" } : { label: "Open request", href: `/requests/${id}` };
    default:
      return null;
  }
}

interface Filters {
  q: string;
  win: Window;
  area: string;
  actor: string;
  outcome: string;
}
const NO_FILTERS: Filters = { q: "", win: "30d", area: "", actor: "", outcome: "" };

/** Activity (preview `P.activity`, `/activity?tab=changes|signins`, `&open=<eventId>` opens the event drawer). */
export function ActivityPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { id: ws, can, hasModule } = useWorkspace();
  const names = useNames();
  const tab = params.get("tab") === "signins" ? "signins" : "changes";
  const [changes, setChanges] = useState<Filters>(NO_FILTERS);
  const [signins, setSignins] = useState<Filters>(NO_FILTERS);
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const f = tab === "signins" ? signins : changes;
  const setF = (patch: Partial<Filters>) => {
    (tab === "signins" ? setSignins : setChanges)({ ...f, ...patch });
    setPage(1);
  };
  const windowDef = WINDOWS.find((w) => w.value === f.win)!;
  // Round to the minute so the filter (and query key) stays stable between renders.
  const since = useMemo(() => new Date(Math.floor((Date.now() - windowDef.ms) / 60_000) * 60_000), [windowDef.ms]);
  const filter =
    tab === "signins"
      ? auditFilter({ since, category: "SIGN_IN", actor: f.actor, outcome: f.outcome })
      : auditFilter({ since, category: f.area, actor: f.actor, outcome: f.outcome });
  const events = useQuery({ queryKey: [ws, "activity", "events", filter], queryFn: () => listAuditEvents(ws, filter) });
  const summary = useQuery({ queryKey: [ws, "activity", "summary", windowDef.summary], queryFn: () => summarizeAuditEvents(ws, windowDef.summary), enabled: tab === "changes" });

  const rows = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    const list = events.data ?? [];
    if (!q) return list;
    return list.filter((e) => [names.actor(e.actor), describeAction(e.action), names.target(e.target), e.ipAddress ?? ""].some((s) => s.toLowerCase().includes(q)));
  }, [events.data, f.q, names]);

  const filtered = Boolean(f.q || f.area || f.actor || f.outcome || f.win !== "30d");
  const open = params.get("open");
  const setOpen = (id: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set("open", id);
    else next.delete("open");
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  async function exportCsv() {
    setExporting(true);
    try {
      const uri = await exportAuditEvents(ws, filter);
      const a = document.createElement("a");
      a.href = uri;
      a.download = tab === "signins" ? "workspace-sign-ins.csv" : "workspace-activity.csv";
      a.rel = "noopener";
      a.target = "_blank";
      a.click();
      toast(tab === "signins" ? `Exported ${plural(events.data?.length ?? 0, "sign-in")}` : `Exported ${plural(events.data?.length ?? 0, "event")}`);
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setExporting(false);
    }
  }

  const people = [
    { value: SYSTEM, label: "BoMesh" },
    ...names.members.map((m) => ({ value: m.user, label: m.displayName || m.email || "Someone" })).sort((a, b) => a.label.localeCompare(b.label)),
  ];
  const areas = AREAS.filter((a) => !a.module || hasModule(a.module)).map((a) => ({ value: a.value, label: a.label, count: summary.data?.get(a.value) }));
  const canPeople = can("members.create");

  const changeColumns: DataTableColumn<AuditEvent>[] = [
    { id: "at", header: "When", sortValue: (e) => Date.parse(e.createTime ?? "") || 0, cell: (e) => <span className="act-when muted" title={full(e.createTime)}>{rel(e.createTime)}</span> },
    {
      id: "actor",
      header: "Person",
      sortValue: (e) => names.actor(e.actor),
      cell: (e) => (
        <span className="row gap-8">
          <ActorAvatar actor={e.actor} name={names.actor(e.actor)} />
          <span className="truncate" translate="no">
            {names.actor(e.actor)}
          </span>
        </span>
      ),
    },
    {
      id: "action",
      header: "Action",
      primary: true,
      cell: (e) => (
        <>
          <span className="cell-title">{describeAction(e.action)}</span>
          <span className="cell-sub only-sm"> · {names.target(e.target)}</span>
        </>
      ),
    },
    {
      id: "target",
      header: "Target",
      hideOnMobile: true,
      className: "hide-md",
      cell: (e) => (
        <span className="act-target truncate muted" translate="no">
          {names.target(e.target)}
        </span>
      ),
    },
    { id: "outcome", header: "Outcome", cell: (e) => <StatusChip kind="outcome" value={e.outcome === "FAILED" ? "failure" : "success"} /> },
  ];
  const signinColumns: DataTableColumn<AuditEvent>[] = [
    {
      id: "actor",
      header: "Person",
      primary: true,
      sortValue: (e) => names.actor(e.actor),
      cell: (e) => (
        <span className="row gap-8">
          <UserAvatar name={names.actor(e.actor)} size="sm" />
          <span className="cell-title truncate" translate="no">
            {names.actor(e.actor)}
          </span>
        </span>
      ),
    },
    { id: "ip", header: "IP address", className: "hide-md", hideOnMobile: true, cell: (e) => <span className="mono t-sm muted">{e.ipAddress || "—"}</span> },
    { id: "at", header: "Signed in", sortValue: (e) => Date.parse(e.createTime ?? "") || 0, cell: (e) => <span className="act-when muted" title={full(e.createTime)}>{rel(e.createTime)}</span> },
    {
      id: "status",
      header: "Status",
      cell: (e) => (e.outcome === "FAILED" ? <StatusChip label="Blocked" tone="danger" /> : <StatusChip label="Signed in" tone="success" variant="tertiary" />),
    },
  ];

  const noMatch = (
    <EmptyState
      icon={Search}
      boxed
      compact
      title={tab === "signins" ? "No sign-ins match" : "No events match"}
      description="Try a longer time window or clear the filters."
      actions={
        <Button variant="secondary" onPress={() => setF(NO_FILTERS)}>
          Reset filters
        </Button>
      }
    />
  );

  return (
    <Page>
      <PageChrome crumbs={[{ label: "Activity" }]} />
      <PageHeader
        title="Activity"
        actions={
          can("auditEvents.export") ? (
            <Button variant="secondary" isDisabled={!events.data} isPending={exporting} onPress={() => void exportCsv()}>
              <Download className="i" aria-hidden />
              Export CSV
            </Button>
          ) : null
        }
      >
        <SectionTabs
          base="/activity"
          active={tab}
          items={[
            { id: "changes", label: "Changes" },
            { id: "signins", label: "Sign-ins" },
          ]}
        />
      </PageHeader>
      <div className="toolbar act-toolbar">
        <SearchInput value={f.q} onChange={(q) => setF({ q })} placeholder={tab === "signins" ? "Search sign-ins" : "Search activity"} label={tab === "signins" ? "Search sign-ins" : "Search activity"} />
        <Segmented label="Time window" value={f.win} onChange={(win) => setF({ win })} options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))} />
        {tab === "changes" ? <FilterButton label="Area" value={f.area} onChange={(area) => setF({ area })} options={areas} /> : null}
        <FilterButton label="Person" value={f.actor} onChange={(actor) => setF({ actor })} options={tab === "signins" ? people.slice(1) : people} />
        {tab === "changes" ? (
          <FilterButton
            label="Outcome"
            value={f.outcome}
            onChange={(outcome) => setF({ outcome })}
            options={[
              { value: "SUCCEEDED", label: "Succeeded" },
              { value: "FAILED", label: "Failed" },
            ]}
          />
        ) : (
          <FilterButton
            label="Status"
            value={f.outcome}
            onChange={(outcome) => setF({ outcome })}
            options={[
              { value: "SUCCEEDED", label: "Signed in" },
              { value: "FAILED", label: "Blocked" },
            ]}
          />
        )}
        <ClearFilters isActive={Boolean(f.area || f.actor || f.outcome)} onClear={() => setF({ area: "", actor: "", outcome: "" })} />
        {events.data ? <span className="toolbar__end t-sm muted num">{tab === "signins" ? plural(rows.length, "sign-in") : plural(rows.length, "event")}</span> : null}
      </div>
      <Gate
        query={events}
        skeleton={<SkeletonRows rows={8} />}
        isEmpty={(d) => d.length === 0 && !filtered}
        empty={
          tab === "signins" ? (
            <EmptyState icon={KeyRound} boxed title="No sign-ins yet" description="Each sign-in to this workspace shows up here." />
          ) : (
            <EmptyState icon={Activity} boxed title="No activity yet" description="Changes to knowledge, sources, people and settings show up here." />
          )
        }
      >
        {() =>
          !rows.length ? (
            noMatch
          ) : (
            <DataTable
              key={tab}
              label={tab === "signins" ? "Sign-ins" : "Workspace changes"}
              rows={paginate(rows, page, PAGE)}
              columns={tab === "signins" ? signinColumns : changeColumns}
              getRowId={(e) => resourceId(e.name)}
              onRowAction={
                tab === "signins"
                  ? canPeople
                    ? (e) => {
                        const id = resourceId(e.actor);
                        if (names.members.some((m) => resourceId(m.user) === id)) router.push(`/people?tab=members&open=${id}`);
                      }
                    : undefined
                  : (e) => setOpen(resourceId(e.name))
              }
              footer={<Pager page={page} pageSize={PAGE} total={rows.length} onPageChange={setPage} />}
            />
          )
        }
      </Gate>
      <EventDrawer eventId={tab === "changes" ? open : null} names={names} canPeople={canPeople} onClose={() => setOpen(null)} />
    </Page>
  );
}

function EventDrawer({ eventId, names, canPeople, onClose }: { eventId: string | null; names: Names; canPeople: boolean; onClose: () => void }) {
  const router = useRouter();
  const { id: ws } = useWorkspace();
  const event = useQuery({ queryKey: [ws, "activity", "event", eventId], queryFn: () => getAuditEvent(ws, eventId!), enabled: Boolean(eventId), retry: false });
  const ev = event.data;
  const to = ev ? related(ev, names, canPeople) : null;
  const actor = ev ? names.actor(ev.actor) : "";
  return (
    <SideDrawer
      isOpen={Boolean(eventId)}
      onClose={onClose}
      title={ev ? describeAction(ev.action) : event.isError ? "Event not found" : "…"}
      description={ev ? `${actor} · ${rel(ev.createTime)}` : undefined}
      lead={ev ? <ActorAvatar actor={ev.actor} name={actor} size="lg" /> : undefined}
      foot={
        to ? (
          <Button variant="primary" onPress={() => router.push(to.href)}>
            <span translate="no">{to.label}</span>
            <ArrowRight className="i" aria-hidden />
          </Button>
        ) : null
      }
    >
      {ev ? (
        <KeyValue
          pairs={[
            ["Event ID", <span key="id" className="mono t-sm">{resourceId(ev.name)}</span>],
            [
              "Person",
              <span key="p" className="row gap-8">
                <ActorAvatar actor={ev.actor} name={actor} size="xs" />
                <span translate="no">{actor}</span>
              </span>,
            ],
            ["Action", describeAction(ev.action)],
            ["Target", <span key="t" translate="no">{names.target(ev.target)}</span>],
            ["Area", areaLabel(ev.category)],
            ["Outcome", <StatusChip key="o" kind="outcome" value={ev.outcome === "FAILED" ? "failure" : "success"} />],
            ["IP address", <span key="ip" className="mono t-sm">{ev.ipAddress || "—"}</span>],
            ["Time", full(ev.createTime)],
          ]}
        />
      ) : event.isError ? (
        <EmptyState icon={Activity} compact title="This event is no longer in the log" />
      ) : (
        <SkeletonRows rows={4} />
      )}
    </SideDrawer>
  );
}
