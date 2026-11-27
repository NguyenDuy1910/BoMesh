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
  toast,
  type DataTableColumn,
  type DataTableSort,
} from "@/components/ui";
import { LOCALE } from "@/i18n/messages";
import { errorMessage, resourceId } from "@/lib/api/client";
import { SEARCH_PAUSE_MS, useDebounced } from "@/lib/debounce";
import { plural, rel } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { activitySections, sectionTitle, useSection } from "@/lib/navigation";
import { useTokenPages } from "@/lib/paging";
import { useWorkspace } from "@/lib/workspace";
import { taxonomyHref } from "@/modules/curation/model";
import { useItemsByName, useKnowledgeBases, useMemberNames, useTaxonomy } from "@/modules/knowledge/queries";
import { conceptLabel, schemeByName } from "@/modules/knowledge/taxonomy";
import { useConnections, useSources } from "@/modules/overview/queries";
import { listMemberPage } from "@/modules/people/api";
import { MoreMenu } from "@/modules/people/components/MoreMenu";
import { SideDrawer } from "@/modules/people/components/SideDrawer";
import { memberSearch, needsTools } from "@/modules/people/model";
import { useGroupsQuery, useRolesQuery } from "@/modules/people/queries";
import { useSpaces } from "@/modules/spaces";

import { exportAuditEvents, getAuditEvent, listAuditEventPage, summarizeAuditEvents, type AuditEvent } from "../api";
import { AREAS, WINDOWS, areaLabel, auditFilter, describeAction, quote, signInMethod, targetOf, type Window } from "../model";

const PAGE = 15;
const SYSTEM = "system";
/** People a search matches by name or email (their events join the action matches). */
const SEARCH_PEOPLE = 20;
/** The Person filter offers the members active most recently. */
const PERSON_OPTIONS = 50;

const full = (ts: string | undefined) =>
  ts ? new Date(ts).toLocaleString(LOCALE, { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

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
  /** The event's sentence; an item that is a collection reads "kho tài liệu". */
  what: (ev: AuditEvent) => string;
  /** Whether the user (bare ID) is a member now. */
  isMember: (userId: string) => boolean;
}

/** Fallback labels (product words, not names): these translate; real names stay `translate="no"`. */
const GENERIC_NAMES = new Set([
  "Ai đó",
  "Thành viên cũ",
  "Một người",
  "Một nhóm",
  "Một vai trò",
  "Một cộng đồng",
  "Một tài liệu hoặc thư mục",
  "Thiết lập không gian làm việc",
  "Trợ lý",
  "Đăng nhập",
  "Một nguồn dữ liệu",
  "Một tài khoản đã kết nối",
  "Một yêu cầu",
  "Một trục phân loại",
  "Một khái niệm",
  "Một đề xuất phân loại",
  "Một quy tắc phân loại",
  "Một tài liệu đã gửi",
  "Một mục công việc",
]);
const noTranslate = (label: string) => (GENERIC_NAMES.has(label) ? undefined : "no");

/** The person a resource name points at (actor `users/{id}`, member or user target), as a bare ID. */
const personOf = (name: string | undefined) => {
  const { kind, id } = targetOf(name);
  return kind === "user" || kind === "member" ? id : "";
};

/**
 * Names for the actors and targets of `events` (the page on screen): people in one batch read, the rest from the
 * workspace's bounded directories (groups, roles, spaces, collections, sources, the taxonomy).
 */
function useNames(events: readonly AuditEvent[]): Names {
  const { id: ws, workspace } = useWorkspace();
  const people = useMemberNames(events.flatMap((e) => [personOf(e.actor), personOf(e.target)]).map((id) => (id ? `workspaces/${ws}/members/${id}` : null)));
  const groups = useGroupsQuery();
  const roles = useRolesQuery();
  const spaces = useSpaces();
  const bases = useKnowledgeBases({ showLocked: true });
  const sources = useSources();
  const connections = useConnections();
  const taxonomy = useTaxonomy().data;
  return useMemo(() => {
    const person = (id: string) => people.get(`workspaces/${ws}/members/${id}`);
    const actor = (a: string | undefined) => (a === SYSTEM ? "BoMesh" : person(resourceId(a)) || "Thành viên cũ");
    const target = (name: string | undefined): string => {
      const { kind, id } = targetOf(name);
      switch (kind) {
        case "member":
        case "user":
          return person(id) || "Một người";
        case "group":
          return groups.data?.find((g) => resourceId(g.name) === id)?.displayName ?? "Một nhóm";
        case "role":
          return roles.data?.find((r) => resourceId(r.name) === id)?.label ?? "Một vai trò";
        case "space":
          return spaces.data?.find((s) => resourceId(s.name) === id)?.displayName ?? "Một cộng đồng";
        case "item":
          return bases.data?.find((b) => resourceId(b.name) === id)?.displayName ?? "Một tài liệu hoặc thư mục";
        case "settings":
          return "Thiết lập không gian làm việc";
        case "assistant":
          return "Trợ lý";
        case "workspace":
          return workspace.displayName;
        case "session":
          return "Đăng nhập";
        case "source":
          return sources.data?.find((s) => resourceId(s.name) === id)?.displayName ?? "Một nguồn dữ liệu";
        case "connection":
          return connections.data?.find((c) => resourceId(c.name) === id)?.displayName ?? "Một tài khoản đã kết nối";
        case "request":
          return "Một yêu cầu";
        case "scheme":
          return schemeByName(taxonomy, id)?.displayName ?? "Một trục phân loại";
        case "concept": {
          const concept = String(name).split("/").slice(0, 6).join("/");
          return taxonomy.byName.has(concept) ? conceptLabel(taxonomy, concept) : "Một khái niệm";
        }
        case "proposal":
          return "Một đề xuất phân loại";
        case "rule":
          return "Một quy tắc phân loại";
        case "contribution":
          return "Một tài liệu đã gửi";
        case "artifact":
          return "Một mục công việc";
        default:
          return "—";
      }
    };
    const isBase = (id: string) => Boolean(bases.data?.some((b) => resourceId(b.name) === id));
    const what = (ev: AuditEvent) => {
      const { kind, id } = targetOf(ev.target);
      return describeAction(ev.action, kind === "item" && isBase(id) ? "kho tài liệu" : undefined);
    };
    return { actor, target, isBase, what, isMember: (id: string) => person(id) !== undefined };
  }, [people, ws, groups.data, roles.data, spaces.data, bases.data, sources.data, connections.data, taxonomy, workspace.displayName]);
}

/** Where an event's target can be opened now (preview `related`); Classification's targets only for who can open it. */
function related(ev: AuditEvent, names: Names, can: { people: boolean; classify: boolean }, hasModule: (m: "requests") => boolean): { label: string; href: string } | null {
  const { kind, id } = targetOf(ev.target);
  const label = names.target(ev.target);
  const canPeople = can.people;
  switch (kind) {
    case "member":
    case "user":
      return canPeople && names.isMember(id) ? { label: `Xem ${label}`, href: `/people?tab=members&open=${id}` } : null;
    case "group":
      return canPeople ? { label: `Mở ${label}`, href: `/people?tab=groups&open=${id}` } : null;
    case "role":
      return canPeople ? { label: `Mở ${label}`, href: `/people?tab=roles&role=${id}` } : null;
    case "item":
      return names.isBase(id) ? { label: `Mở ${label}`, href: `/studio/collections/${id}` } : { label: "Mở tài liệu", href: `/doc/${id}` };
    case "space":
      return { label: `Mở ${label}`, href: `/space/${id}` };
    case "source":
      return { label: `Mở ${label}`, href: `/studio?tab=sources&open=${id}` };
    case "connection":
      return { label: "Mở tài khoản", href: "/studio?tab=sources&view=accounts" };
    case "settings":
      return { label: "Mở cài đặt", href: "/settings?tab=setup" };
    case "workspace":
      return { label: "Mở cài đặt", href: "/settings" };
    case "assistant":
      return { label: "Mở trợ lý", href: "/assistant" };
    case "request":
      if (ev.category === "PEOPLE" || ev.category === "KNOWLEDGE") return canPeople ? { label: "Mở các yêu cầu truy cập", href: "/people?tab=requests" } : null;
      return hasModule("requests") ? { label: "Mở yêu cầu", href: `/requests/${id}` } : null;
    case "scheme":
      return can.classify ? { label: `Mở ${label}`, href: taxonomyHref(id) } : null;
    case "concept":
      return can.classify ? { label: `Mở ${label}`, href: taxonomyHref(String(ev.target).split("/")[3], { node: id }) } : null;
    case "proposal":
      return can.classify ? { label: "Mở Gợi ý phân loại", href: taxonomyHref("suggestions") } : null;
    case "rule":
      return can.classify ? { label: "Mở Phân loại", href: taxonomyHref() } : null;
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

/**
 * Activity (preview `P.activity`): sections Changes · Sign-ins are sidebar sub-rows (`?tab=`), each titled by its
 * name, with Export CSV in the header. `&open=<eventId>` opens the event drawer.
 */
export function ActivityPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { id: ws, can, hasModule } = useWorkspace();
  const tab = useSection(activitySections);
  const m = useMessages();
  const signins = tab === "signins";
  const [changesF, setChangesF] = useState<Filters>(NO_FILTERS);
  const [signinsF, setSigninsF] = useState<Filters>(NO_FILTERS);
  const [exporting, setExporting] = useState(false);
  const f = signins ? signinsF : changesF;
  const setF = (patch: Partial<Filters>) => (signins ? setSigninsF : setChangesF)({ ...f, ...patch });
  const windowDef = WINDOWS.find((w) => w.value === f.win)!;
  // Round to the minute so the filter (and query key) stays stable between renders.
  const since = useMemo(() => new Date(Math.floor((Date.now() - windowDef.ms) / 60_000) * 60_000), [windowDef.ms]);
  // A search matches action codes ("member" finds CreateMember) and the events of people whose name or email matches.
  const q = useDebounced(f.q.trim(), SEARCH_PAUSE_MS);
  const matched = useQuery({
    queryKey: [ws, "members", "search", memberSearch(q), SEARCH_PEOPLE],
    queryFn: async () => (await listMemberPage(ws, { filter: memberSearch(q), orderBy: "displayName", pageSize: SEARCH_PEOPLE })).members ?? [],
    enabled: Boolean(q),
  });
  const search = q
    ? `(${[
        `action = ${quote(`*${q.replace(/\s+/g, "")}*`)}`,
        ...("bomesh".includes(q.toLowerCase()) ? [`actor = ${quote(SYSTEM)}`] : []),
        ...(matched.data ?? []).map((p) => `actor = ${quote(p.user ?? "")}`),
      ].join(" OR ")})`
    : "";
  const base = signins
    ? auditFilter({ since, category: "SIGN_IN", actor: f.actor, outcome: f.outcome })
    : auditFilter({ since, category: f.area, exclude: "SIGN_IN", actor: f.actor, outcome: f.outcome });
  const filter = [base, search].filter(Boolean).join(" AND ");
  // The log reads in time order: When sorts it on the server, newest first by default.
  const [sort, setSort] = useState<DataTableSort | null>(null);
  const orderBy = sort?.column === "at" && sort.direction === "ascending" ? "createTime" : "createTime desc";
  const events = useTokenPages([ws, "activity", "events", filter, orderBy], (pageToken) => listAuditEventPage(ws, filter, orderBy, PAGE, pageToken), {
    enabled: !q || matched.isSuccess,
  });
  const summary = useQuery({
    queryKey: [ws, "activity", "summary", windowDef.summary],
    queryFn: () => summarizeAuditEvents(ws, windowDef.summary!),
    enabled: !signins && Boolean(windowDef.summary),
  });
  const rows = events.data?.auditEvents ?? [];
  const open = params.get("open");
  // The drawer's event (same cache entry as the drawer's read) is named with the page.
  const opened = useQuery({ queryKey: [ws, "activity", "event", open], queryFn: () => getAuditEvent(ws, open!), enabled: !signins && Boolean(open), retry: false });
  const named = opened.data ? [...rows, opened.data] : rows;
  const names = useNames(named);

  // Audit events carry no titles: documents and folders on the page on screen are named by one batch read (what the
  // caller can't read, or what was deleted, keeps the generic label).
  const docTargets = signins
    ? []
    : named
        .map((e) => targetOf(e.target))
        .filter((t) => t.kind === "item" && !names.isBase(t.id))
        .map((t) => t.id);
  const docs = useItemsByName(docTargets, { view: "BASIC", keepPrevious: true });
  const shown = useMemo<Names>(() => {
    const byId = new Map([...docs.items.values()].map((i) => [resourceId(i.name), i.displayName ?? ""]));
    return {
      ...names,
      target: (t) => {
        const { kind, id } = targetOf(t);
        return (kind === "item" && byId.get(id)) || names.target(t);
      },
    };
  }, [names, docs.items]);

  const filtered = Boolean(f.q || f.area || f.actor || f.outcome);
  const known = events.total ?? (events.page - 1) * PAGE + rows.length + (events.hasNext ? 1 : 0);
  const tools = needsTools(known, filtered) || f.win !== "30d";
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
      toast(signins ? `Đã xuất ${plural(known, "sign-in")}` : `Đã xuất ${plural(known, "event")}`);
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    } finally {
      setExporting(false);
    }
  }

  // The Person filter: BoMesh and the members active most recently (plus whoever is picked).
  const recent = useQuery({
    queryKey: [ws, "members", "recentlyActive", PERSON_OPTIONS],
    queryFn: async () => (await listMemberPage(ws, { orderBy: "lastActiveTime desc", pageSize: PERSON_OPTIONS })).members ?? [],
    enabled: tools && !signins,
    staleTime: 5 * 60_000,
  });
  const recentPeople = (recent.data ?? []).map((p) => ({ value: p.user ?? "", label: p.displayName || p.email || "Ai đó" }));
  const picked = f.actor && f.actor !== SYSTEM && !recentPeople.some((p) => p.value === f.actor) ? [{ value: f.actor, label: names.actor(f.actor) }] : [];
  const people = [{ value: SYSTEM, label: "BoMesh" }, ...[...recentPeople, ...picked].sort((a, b) => a.label.localeCompare(b.label))];
  // Areas come from the log: with a summary for the window, only areas that have events.
  const areas = AREAS.filter((a) => a.value !== "SIGN_IN" && (!a.module || hasModule(a.module)) && (!summary.data || summary.data.get(a.value) || f.area === a.value)).map((a) => ({
    value: a.value,
    label: a.label,
    count: summary.data?.get(a.value),
  }));
  const canPeople = can("members.create");
  const facets: Facet[] = signins
    ? [
        {
          label: "Trạng thái",
          field: "outcome",
          options: [
            { value: "SUCCEEDED", label: "Đã đăng nhập" },
            { value: "FAILED", label: "Bị chặn" },
          ],
        },
      ]
    : [
        { label: "Người", field: "actor", options: people },
        { label: "Khu vực", field: "area", options: areas },
        {
          label: "Kết quả",
          field: "outcome",
          options: [
            { value: "SUCCEEDED", label: "Thành công" },
            { value: "FAILED", label: "Lỗi" },
          ],
        },
      ];

  const when: DataTableColumn<AuditEvent> = {
    id: "at",
    header: signins ? "Đã đăng nhập" : "Thời điểm",
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
      header: "Điều đã xảy ra",
      primary: true,
      cell: (e) => {
        const target = shown.target(e.target);
        return (
          <span className="stack act-what">
            <span className="row gap-6">
              <span className="cell-title truncate">{names.what(e)}</span>
              {e.outcome === "FAILED" ? <StatusChip kind="outcome" value="failure" size="sm" /> : null}
            </span>
            {target === "—" ? null : (
              <span className="cell-sub truncate" translate={noTranslate(target)}>
                {target}
              </span>
            )}
          </span>
        );
      },
    },
    {
      id: "actor",
      header: "Người",
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
      header: "Người",
      primary: true,
      cell: (e) => (
        <span className="row gap-8">
          <UserAvatar name={names.actor(e.actor)} size="sm" />
          <span className="cell-title truncate" translate={noTranslate(names.actor(e.actor))}>
            {names.actor(e.actor)}
          </span>
          {e.outcome === "FAILED" ? <StatusChip label="Bị chặn" tone="danger" size="sm" /> : null}
        </span>
      ),
    },
    {
      id: "method",
      header: "Phương thức",
      cell: (e) => {
        const method = signInMethod(e.description);
        return (
          <span className="act-how">
            {method !== "—" || !e.ipAddress ? <span className="truncate">{method}</span> : null}
            {e.ipAddress ? <span className="cell-sub truncate mono">{e.ipAddress}</span> : null}
          </span>
        );
      },
    },
    when,
  ];

  const exportAction = can("auditEvents.export") ? (
    <>
      <Button variant="secondary" className="act-export-wide" isDisabled={!events.data} isPending={exporting} onPress={() => void exportCsv()}>
        <Download className="i" aria-hidden />
        Xuất CSV
      </Button>
      <span className="act-export-menu">
        <MoreMenu size="md" actions={[{ id: "export", label: "Xuất CSV", icon: Download, onAction: () => void exportCsv() }]} />
      </span>
    </>
  ) : null;

  return (
    <Page width="wide">
      <PageHeader title={sectionTitle(activitySections, tab, m)} actions={exportAction} />
      {tools ? (
        <div className="toolbar act-toolbar">
          <SearchInput value={f.q} onChange={(q) => setF({ q })} placeholder={signins ? "Tìm kiếm lượt đăng nhập" : "Tìm kiếm hoạt động"} label={signins ? "Tìm kiếm lượt đăng nhập" : "Tìm kiếm hoạt động"} />
          <Segmented label="Khoảng thời gian" value={f.win} onChange={(win) => setF({ win })} options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))} />
          <span className="act-filters">
            {facets.map((facet) => (
              <FilterButton key={facet.field} label={facet.label} value={f[facet.field]} onChange={(value) => setF({ [facet.field]: value } as Partial<Filters>)} options={facet.options} />
            ))}
          </span>
          <FiltersSheet facets={facets} filters={f} onChange={setF} />
          <ClearFilters isActive={Boolean(f.area || f.actor || f.outcome)} onClear={() => setF({ area: "", actor: "", outcome: "" })} />
          {events.total !== undefined ? <span className="toolbar__end t-sm muted num">{signins ? plural(events.total, "sign-in") : plural(events.total, "event")}</span> : null}
        </div>
      ) : null}
      <Gate
        query={events}
        skeleton={<SkeletonRows rows={8} />}
        isEmpty={(d) => !d.auditEvents?.length && events.page === 1 && !filtered && f.win === "30d"}
        empty={
          signins ? (
            <EmptyState icon={KeyRound} boxed title="Chưa có lượt đăng nhập" description="Mỗi lần đăng nhập vào không gian làm việc này sẽ hiển thị ở đây." />
          ) : (
            <EmptyState icon={Activity} boxed title="Chưa có hoạt động" description="Các thay đổi về tài liệu, nguồn dữ liệu, thành viên và cài đặt sẽ hiển thị ở đây." />
          )
        }
      >
        {() =>
          !rows.length && events.page === 1 ? (
            <EmptyState
              icon={Search}
              boxed
              compact
              title={signins ? "Không có lượt đăng nhập nào khớp" : "Không có sự kiện nào khớp"}
              description="Hãy thử khoảng thời gian dài hơn hoặc xóa bộ lọc."
              actions={
                <Button variant="secondary" onPress={() => setF(NO_FILTERS)}>
                  Đặt lại bộ lọc
                </Button>
              }
            />
          ) : (
            <DataTable
              key={tab}
              label={signins ? "Lượt đăng nhập" : "Thay đổi không gian làm việc"}
              rows={rows}
              columns={signins ? signinColumns : changeColumns}
              getRowId={(e) => resourceId(e.name)}
              sort={sort}
              onSortChange={setSort}
              rowClassName={signins ? () => "act-signin" : () => "act-change"}
              onRowAction={
                signins
                  ? canPeople
                    ? (e) => {
                        const id = resourceId(e.actor);
                        if (names.isMember(id)) router.push(`/people?tab=members&open=${id}`);
                      }
                    : undefined
                  : (e) => setOpen(resourceId(e.name))
              }
              footer={<Pager page={events.page} pageSize={PAGE} total={events.total} pageCount={rows.length} hasNext={events.hasNext} onPageChange={events.setPage} />}
            />
          )
        }
      </Gate>
      <EventDrawer eventId={signins ? null : open} names={shown} canPeople={canPeople} onClose={() => setOpen(null)} />
    </Page>
  );
}

interface Facet {
  label: string;
  field: "actor" | "area" | "outcome";
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
      title="Bộ lọc"
      placement="bottom end"
      bodyClassName="act-sheet"
      trigger={
        <Pressable>
          <button type="button" className={clsx("filter-button act-filters-btn", set && "is-set")}>
            <Filter className="i" aria-hidden />
            {set ? `Bộ lọc · ${set}` : "Bộ lọc"}
            <ChevronDown className="i" aria-hidden />
          </button>
        </Pressable>
      }
      footer={
        <Button variant="ghost" size="sm" onPress={() => onChange({ win: "30d", actor: "", area: "", outcome: "" })}>
          Đặt lại
        </Button>
      }
    >
      {group("Khoảng thời gian", WINDOWS, filters.win, (win) => onChange({ win: win as Window }))}
      {facets.map((facet) => group(facet.label, [{ value: "", label: "Bất kỳ" }, ...facet.options], filters[facet.field], (value) => onChange({ [facet.field]: value } as Partial<Filters>)))}
    </PopoverSheet>
  );
}

/** Event drawer (preview `drawer()`): the person and action are its title line; Technical details stay folded. */
function EventDrawer({ eventId, names, canPeople, onClose }: { eventId: string | null; names: Names; canPeople: boolean; onClose: () => void }) {
  const router = useRouter();
  const { id: ws, hasModule, can } = useWorkspace();
  const event = useQuery({ queryKey: [ws, "activity", "event", eventId], queryFn: () => getAuditEvent(ws, eventId!), enabled: Boolean(eventId), retry: false });
  const ev = event.data;
  const to = ev ? related(ev, names, { people: canPeople, classify: can("conceptSchemes.update") || can("conceptProposals.decide") }, hasModule) : null;
  const actor = ev ? names.actor(ev.actor) : "";
  const id = ev ? resourceId(ev.name) : "";
  return (
    <SideDrawer
      isOpen={Boolean(eventId)}
      onClose={onClose}
      title={ev ? names.what(ev) : event.isError ? "Không tìm thấy sự kiện" : "…"}
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
                ["Đối tượng", <span key="t" translate={noTranslate(names.target(ev.target))}>{names.target(ev.target)}</span>],
                ["Khu vực", areaLabel(ev.category)],
                ["Kết quả", <StatusChip key="o" kind="outcome" value={ev.outcome === "FAILED" ? "failure" : "success"} />],
                ["Thời gian", full(ev.createTime)],
              ]}
            />
          </section>
          <section className="drawer__section">
            <Disclosure icon={Info} title="Chi tiết kỹ thuật">
              <KeyValue
                pairs={[
                  [
                    "Mã sự kiện",
                    <span key="id" className="row gap-4">
                      <span className="mono t-sm">{id}</span>
                      <span className="act-copy">
                        <IconButton
                          icon={Copy}
                          tip="Sao chép mã sự kiện"
                          size="sm"
                          onPress={() =>
                            void navigator.clipboard.writeText(id).then(
                              () => toast("Đã sao chép mã sự kiện"),
                              () => toast("Không sao chép được. Hãy chọn ID rồi tự sao chép.", { tone: "danger" }),
                            )
                          }
                        />
                      </span>
                    </span>,
                  ],
                  ["Địa chỉ IP", <span key="ip" className="mono t-sm">{ev.ipAddress || "—"}</span>],
                ]}
              />
            </Disclosure>
          </section>
        </>
      ) : event.isError ? (
        <EmptyState icon={Activity} compact title="Sự kiện này không còn trong nhật ký" />
      ) : (
        <SkeletonRows rows={4} />
      )}
    </SideDrawer>
  );
}
