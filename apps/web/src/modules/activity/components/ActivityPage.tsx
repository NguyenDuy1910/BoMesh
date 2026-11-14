"use client";

import { Button, Pressable } from "@heroui/react";
import clsx from "clsx";
import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowRight, ChevronDown, Copy, Download, Filter, Info, KeyRound, Search, Zap } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import {
  ClearFilters,
  DataTable,
  Disclosure,
  EmptyState,
  FilterButton,
  Gate,
  IconButton,
  KeyValue,
  Page,
  PageHeader,
  Pager,
  PopoverSheet,
  SearchInput,
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
import { activitySections, sectionTitle, useSection } from "@/lib/navigation";
import { useWorkspace } from "@/lib/workspace";
import { useKnowledgeBases } from "@/modules/knowledge/queries";
import { useConnections, useSources } from "@/modules/overview/queries";
import { MoreMenu } from "@/modules/people/components/MoreMenu";
import { SideDrawer } from "@/modules/people/components/SideDrawer";
import { needsTools } from "@/modules/people/model";
import { useGroupsQuery, useMembersQuery, useRolesQuery } from "@/modules/people/queries";
import { useSpaces } from "@/modules/spaces";
import type { Member } from "@/modules/people/api";

import { exportAuditEvents, getAuditEvent, listAuditEvents, summarizeAuditEvents, type AuditEvent } from "../api";
import { AREAS, WINDOWS, areaLabel, auditFilter, describeAction, signInMethod, targetOf, type Window } from "../model";

const PAGE = 15;
const SYSTEM = "system";

const full = (ts: string | undefined) =>
  ts ? new Date(ts).toLocaleString(document.documentElement.lang || "en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

/** Actor avatar: `system` is the product itself (preview `whoAv`). */
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
  /** The event's sentence; an item that is a collection reads "collection". */
  what: (ev: AuditEvent) => string;
  members: Member[];
}

/** Fallback labels (product words, not names): these translate; real names stay `translate="no"`. */
const GENERIC_NAMES = new Set([
  "Someone",
  "Former member",
  "A person",
  "A group",
  "A role",
  "A space",
  "A document or folder",
  "Workspace setup",
  "Assistant",
  "Sign-in",
  "A source",
  "A connected account",
  "A request",
  "A topic",
  "A contribution",
  "A reading list",
  "A work item",
]);
const noTranslate = (label: string) => (GENERIC_NAMES.has(label) ? undefined : "no");

/** Names for actors and targets from the workspace directory (members, groups, roles, spaces, collections, sources). */
function useNames(): Names {
  const { workspace } = useWorkspace();
  const members = useMembersQuery();
  const groups = useGroupsQuery();
  const roles = useRolesQuery();
  const spaces = useSpaces();
  const bases = useKnowledgeBases({ showLocked: true });
  const sources = useSources();
  const connections = useConnections();
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
          return "Assistant";
        case "workspace":
          return workspace.displayName;
        case "session":
          return "Sign-in";
        case "source":
          return sources.data?.find((s) => resourceId(s.name) === id)?.displayName ?? "A source";
        case "connection":
          return connections.data?.find((c) => resourceId(c.name) === id)?.displayName ?? "A connected account";
        case "request":
          return "A request";
        case "topic":
          return "A topic";
        case "contribution":
          return "A contribution";
        case "readingList":
          return "A reading list";
        case "artifact":
          return "A work item";
        default:
          return "—";
      }
    };
    const isBase = (id: string) => Boolean(bases.data?.some((b) => resourceId(b.name) === id));
    const what = (ev: AuditEvent) => {
      const { kind, id } = targetOf(ev.target);
      return describeAction(ev.action, kind === "item" && isBase(id) ? "collection" : undefined);
    };
    return { actor, target, isBase, what, members: members.data ?? [] };
  }, [members.data, groups.data, roles.data, spaces.data, bases.data, sources.data, connections.data, workspace.displayName]);
}

/** Where an event's target can be opened now (preview `related`). */
function related(ev: AuditEvent, names: Names, canPeople: boolean, hasModule: (m: "requests") => boolean): { label: string; href: string } | null {
  const { kind, id } = targetOf(ev.target);
  const label = names.target(ev.target);
  switch (kind) {
    case "member":
    case "user":
      return canPeople && names.members.some((m) => resourceId(m.user) === id) ? { label: `View ${label}`, href: `/people?tab=members&open=${id}` } : null;
    case "group":
      return canPeople ? { label: `Open ${label}`, href: `/people?tab=groups&open=${id}` } : null;
    case "role":
      return canPeople ? { label: `Open ${label}`, href: `/people?tab=roles&role=${id}` } : null;
    case "item":
      return names.isBase(id) ? { label: `Open ${label}`, href: `/studio/collections/${id}` } : { label: "Open document", href: `/doc/${id}` };
    case "readingList":
      return { label: "Open reading list", href: `/knowledge/lists/${id}` };
    case "space":
      return { label: `Open ${label}`, href: `/space/${id}` };
    case "source":
      return { label: `Open ${label}`, href: `/studio?tab=sources&open=${id}` };
    case "connection":
      return { label: "Open accounts", href: "/studio?tab=sources&view=accounts" };
    case "settings":
      return { label: "Open settings", href: "/settings?tab=setup" };
    case "workspace":
      return { label: "Open settings", href: "/settings" };
    case "assistant":
      return { label: "Open assistant", href: "/assistant" };
    case "request":
      if (ev.category === "PEOPLE" || ev.category === "KNOWLEDGE") return canPeople ? { label: "Open access requests", href: "/people?tab=requests" } : null;
      return hasModule("requests") ? { label: "Open request", href: `/requests/${id}` } : null;
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
  method: string;
}
const NO_FILTERS: Filters = { q: "", win: "30d", area: "", actor: "", outcome: "", method: "" };

/**
 * Activity (preview `P.activity`): sections Changes · Sign-ins are sidebar sub-rows (`?tab=`), each titled by its
 * name, with Export CSV in the header. `&open=<eventId>` opens the event drawer.
 */
export function ActivityPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { id: ws, can, hasModule } = useWorkspace();
  const names = useNames();
  const tab = useSection(activitySections);
  const signins = tab === "signins";
  const [changesF, setChangesF] = useState<Filters>(NO_FILTERS);
  const [signinsF, setSigninsF] = useState<Filters>(NO_FILTERS);
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const f = signins ? signinsF : changesF;
  const setF = (patch: Partial<Filters>) => {
    (signins ? setSigninsF : setChangesF)({ ...f, ...patch });
    setPage(1);
  };
  const windowDef = WINDOWS.find((w) => w.value === f.win)!;
  // Round to the minute so the filter (and query key) stays stable between renders.
  const since = useMemo(() => new Date(Math.floor((Date.now() - windowDef.ms) / 60_000) * 60_000), [windowDef.ms]);
  const filter = signins
    ? auditFilter({ since, category: "SIGN_IN", actor: f.actor, outcome: f.outcome })
    : auditFilter({ since, category: f.area, exclude: "SIGN_IN", actor: f.actor, outcome: f.outcome });
  const events = useQuery({ queryKey: [ws, "activity", "events", filter], queryFn: () => listAuditEvents(ws, filter) });
  const summary = useQuery({
    queryKey: [ws, "activity", "summary", windowDef.summary],
    queryFn: () => summarizeAuditEvents(ws, windowDef.summary!),
    enabled: !signins && Boolean(windowDef.summary),
  });

  const rows = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    return (events.data ?? []).filter(
      (e) =>
        (!signins || !f.method || signInMethod(e.description) === f.method) &&
        (!q || [names.actor(e.actor), names.what(e), names.target(e.target), signInMethod(e.description)].some((s) => s.toLowerCase().includes(q))),
    );
  }, [events.data, f.q, f.method, signins, names]);

  const filtered = Boolean(f.q || f.area || f.actor || f.outcome || f.method);
  const tools = needsTools(events.data?.length ?? 0, filtered) || f.win !== "30d";
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
      a.download = signins ? "workspace-sign-ins.csv" : "workspace-activity.csv";
      a.rel = "noopener";
      a.target = "_blank";
      a.click();
      toast(signins ? `Exported ${plural(events.data?.length ?? 0, "sign-in")}` : `Exported ${plural(events.data?.length ?? 0, "event")}`);
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
  // Areas come from the log: with a summary for the window, only areas that have events.
  const areas = AREAS.filter((a) => a.value !== "SIGN_IN" && (!a.module || hasModule(a.module)) && (!summary.data || summary.data.get(a.value) || f.area === a.value)).map((a) => ({
    value: a.value,
    label: a.label,
    count: summary.data?.get(a.value),
  }));
  const methods = [...new Set((events.data ?? []).map((e) => signInMethod(e.description)).filter((m) => m !== "—"))].sort().map((m) => ({ value: m, label: m }));
  const canPeople = can("members.create");
  const facets: Facet[] = signins
    ? [
        ...(methods.length ? [{ label: "Method", field: "method" as const, options: methods }] : []),
        {
          label: "Status",
          field: "outcome",
          options: [
            { value: "SUCCEEDED", label: "Signed in" },
            { value: "FAILED", label: "Blocked" },
          ],
        },
      ]
    : [
        { label: "Person", field: "actor", options: people },
        { label: "Area", field: "area", options: areas },
        {
          label: "Outcome",
          field: "outcome",
          options: [
            { value: "SUCCEEDED", label: "Succeeded" },
            { value: "FAILED", label: "Failed" },
          ],
        },
      ];

  const when: DataTableColumn<AuditEvent> = {
    id: "at",
    header: signins ? "Signed in" : "When",
    sortValue: (e) => Date.parse(e.createTime ?? "") || 0,
    cell: (e) => (
      <span className="act-when muted" title={full(e.createTime)}>
        {rel(e.createTime)}
      </span>
    ),
  };
  const changeColumns: DataTableColumn<AuditEvent>[] = [
    {
      id: "what",
      header: "What happened",
      primary: true,
      cell: (e) => (
        <span className="stack act-what">
          <span className="row gap-6">
            <span className="cell-title truncate">{names.what(e)}</span>
            {e.outcome === "FAILED" ? <StatusChip kind="outcome" value="failure" size="sm" /> : null}
          </span>
          <span className="cell-sub truncate" translate={noTranslate(names.target(e.target))}>
            {names.target(e.target)}
          </span>
        </span>
      ),
    },
    {
      id: "actor",
      header: "Person",
      sortValue: (e) => names.actor(e.actor),
      cell: (e) => (
        <span className="row gap-8">
          <ActorAvatar actor={e.actor} name={names.actor(e.actor)} />
          <span className="truncate" translate={noTranslate(names.actor(e.actor))}>
            {names.actor(e.actor)}
          </span>
        </span>
      ),
    },
    when,
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
          <span className="cell-title truncate" translate={noTranslate(names.actor(e.actor))}>
            {names.actor(e.actor)}
          </span>
          {e.outcome === "FAILED" ? <StatusChip label="Blocked" tone="danger" size="sm" /> : null}
        </span>
      ),
    },
    {
      id: "method",
      header: "Method",
      cell: (e) => (
        <span className="act-how">
          <span className="truncate">{signInMethod(e.description)}</span>
          {e.ipAddress ? <span className="cell-sub truncate mono">{e.ipAddress}</span> : null}
        </span>
      ),
    },
    when,
  ];

  const exportAction = can("auditEvents.export") ? (
    <>
      <Button variant="secondary" className="act-export-wide" isDisabled={!events.data} isPending={exporting} onPress={() => void exportCsv()}>
        <Download className="i" aria-hidden />
        Export CSV
      </Button>
      <span className="act-export-menu">
        <MoreMenu size="md" actions={[{ id: "export", label: "Export CSV", icon: Download, onAction: () => void exportCsv() }]} />
      </span>
    </>
  ) : null;

  return (
    <Page width="wide">
      <PageHeader title={sectionTitle(activitySections, tab)} actions={exportAction} />
      {tools ? (
        <div className="toolbar act-toolbar">
          <SearchInput value={f.q} onChange={(q) => setF({ q })} placeholder={signins ? "Search sign-ins" : "Search activity"} label={signins ? "Search sign-ins" : "Search activity"} />
          <Segmented label="Time window" value={f.win} onChange={(win) => setF({ win })} options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))} />
          <span className="act-filters">
            {facets.map((facet) => (
              <FilterButton key={facet.field} label={facet.label} value={f[facet.field]} onChange={(value) => setF({ [facet.field]: value } as Partial<Filters>)} options={facet.options} />
            ))}
          </span>
          <FiltersSheet facets={facets} filters={f} onChange={setF} />
          <ClearFilters isActive={Boolean(f.area || f.actor || f.outcome || f.method)} onClear={() => setF({ area: "", actor: "", outcome: "", method: "" })} />
          {events.data ? <span className="toolbar__end t-sm muted num">{signins ? plural(rows.length, "sign-in") : plural(rows.length, "event")}</span> : null}
        </div>
      ) : null}
      <Gate
        query={events}
        skeleton={<SkeletonRows rows={8} />}
        isEmpty={(d) => d.length === 0 && !filtered && f.win === "30d"}
        empty={
          signins ? (
            <EmptyState icon={KeyRound} boxed title="No sign-ins yet" description="Each sign-in to this workspace shows up here." />
          ) : (
            <EmptyState icon={Activity} boxed title="No activity yet" description="Changes to knowledge, sources, people and settings show up here." />
          )
        }
      >
        {() =>
          !rows.length ? (
            <EmptyState
              icon={Search}
              boxed
              compact
              title={signins ? "No sign-ins match" : "No events match"}
              description="Try a longer time window or clear the filters."
              actions={
                <Button variant="secondary" onPress={() => setF(NO_FILTERS)}>
                  Reset filters
                </Button>
              }
            />
          ) : (
            <DataTable
              key={tab}
              label={signins ? "Sign-ins" : "Workspace changes"}
              rows={paginate(rows, page, PAGE)}
              columns={signins ? signinColumns : changeColumns}
              getRowId={(e) => resourceId(e.name)}
              rowClassName={signins ? () => "act-signin" : undefined}
              onRowAction={
                signins
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
      <EventDrawer eventId={signins ? null : open} names={names} canPeople={canPeople} onClose={() => setOpen(null)} />
    </Page>
  );
}

interface Facet {
  label: string;
  field: "actor" | "area" | "outcome" | "method";
  options: readonly { value: string; label: string }[];
}

/** Phones: the window and filters as one sheet behind a Filters button (preview `PO['audit-filters']`). */
function FiltersSheet({ facets, filters, onChange }: { facets: readonly Facet[]; filters: Filters; onChange: (patch: Partial<Filters>) => void }) {
  const set = facets.filter((facet) => filters[facet.field]).length + (filters.win !== "30d" ? 1 : 0);
  const group = (label: string, options: readonly { value: string; label: string }[], value: string, pick: (value: string) => void) => (
    <fieldset key={label} className="act-sheet__group">
      <legend className="act-sheet__label">{label}</legend>
      <div className="act-sheet__opts">
        {options.map((o) => (
          <button key={o.value} type="button" className="act-sheet__opt" aria-pressed={value === o.value} onClick={() => pick(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
  return (
    <PopoverSheet
      title="Filters"
      placement="bottom end"
      bodyClassName="act-sheet"
      trigger={
        <Pressable>
          <button type="button" className={clsx("filter-button act-filters-btn", set && "is-set")}>
            <Filter className="i" aria-hidden />
            {set ? `Filters · ${set}` : "Filters"}
            <ChevronDown className="i" aria-hidden />
          </button>
        </Pressable>
      }
      footer={
        <Button variant="ghost" size="sm" onPress={() => onChange({ win: "30d", actor: "", area: "", outcome: "", method: "" })}>
          Reset
        </Button>
      }
    >
      {group("Time window", WINDOWS, filters.win, (win) => onChange({ win: win as Window }))}
      {facets.map((facet) => group(facet.label, [{ value: "", label: "Any" }, ...facet.options], filters[facet.field], (value) => onChange({ [facet.field]: value } as Partial<Filters>)))}
    </PopoverSheet>
  );
}

/** Event drawer (preview `drawer()`): the person and action are its title line; Technical details stay folded. */
function EventDrawer({ eventId, names, canPeople, onClose }: { eventId: string | null; names: Names; canPeople: boolean; onClose: () => void }) {
  const router = useRouter();
  const { id: ws, hasModule } = useWorkspace();
  const event = useQuery({ queryKey: [ws, "activity", "event", eventId], queryFn: () => getAuditEvent(ws, eventId!), enabled: Boolean(eventId), retry: false });
  const ev = event.data;
  const to = ev ? related(ev, names, canPeople, hasModule) : null;
  const actor = ev ? names.actor(ev.actor) : "";
  const id = ev ? resourceId(ev.name) : "";
  return (
    <SideDrawer
      isOpen={Boolean(eventId)}
      onClose={onClose}
      title={ev ? names.what(ev) : event.isError ? "Event not found" : "…"}
      description={ev ? `${actor} · ${rel(ev.createTime)}` : undefined}
      lead={ev ? <ActorAvatar actor={ev.actor} name={actor} size="lg" /> : undefined}
      foot={
        to ? (
          <Button
            variant="primary"
            onPress={() => {
              onClose();
              router.push(to.href);
            }}
          >
            <span translate="no">{to.label}</span>
            <ArrowRight className="i" aria-hidden />
          </Button>
        ) : null
      }
    >
      {ev ? (
        <>
          <section className="drawer__section">
            <KeyValue
              pairs={[
                ["Target", <span key="t" translate={noTranslate(names.target(ev.target))}>{names.target(ev.target)}</span>],
                ["Area", areaLabel(ev.category)],
                ["Outcome", <StatusChip key="o" kind="outcome" value={ev.outcome === "FAILED" ? "failure" : "success"} />],
                ["Time", full(ev.createTime)],
              ]}
            />
          </section>
          <section className="drawer__section">
            <Disclosure icon={Info} title="Technical details">
              <KeyValue
                pairs={[
                  [
                    "Event ID",
                    <span key="id" className="row gap-4">
                      <span className="mono t-sm">{id}</span>
                      <span className="act-copy">
                        <IconButton
                          icon={Copy}
                          tip="Copy event ID"
                          size="sm"
                          onPress={() =>
                            void navigator.clipboard.writeText(id).then(
                              () => toast("Event ID copied"),
                              () => toast("Couldn’t copy. Select the ID and copy it.", { tone: "danger" }),
                            )
                          }
                        />
                      </span>
                    </span>,
                  ],
                  ["IP address", <span key="ip" className="mono t-sm">{ev.ipAddress || "—"}</span>],
                ]}
              />
            </Disclosure>
          </section>
        </>
      ) : event.isError ? (
        <EmptyState icon={Activity} compact title="This event is no longer in the log" />
      ) : (
        <SkeletonRows rows={4} />
      )}
    </SideDrawer>
  );
}
